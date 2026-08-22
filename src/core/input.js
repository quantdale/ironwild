// IRONWILD - keyboard + mouse input.
// Frame-scoped: main.js calls Input.beginFrame() once per frame BEFORE systems read it.
//
// Wave J action layer (additive - the raw down/pressed/consume* API below is
// unchanged and remains the source of truth for existing call sites):
//   ACTIONS map gameplay intents to KeyboardEvent.code lists ('Mouse0'..'Mouse4'
//   pseudo-codes track mouse buttons). Input.isAction / wasActionPressed evaluate
//   keyboard + mouse + gamepad state merged; bindings persist to localStorage
//   'ironwild-bindings' via ui/settings.js rebind rows. Hold-vs-toggle for aim /
//   crouch follows G.settings.aimMode / crouchMode ('hold'|'toggle').

import { G } from "./state.js";
import {
  pollGamepads,
  getGamepadState,
  RT_AIM_THRESHOLD,
  LT_FIRE_THRESHOLD,
  PAD_BUTTONS,
} from "../input/gamepad.js";

const BINDINGS_KEY = "ironwild-bindings";

// Defaults derived from the raw codes actually polled across src/ today:
// player.js WASD/Space/ControlLeft/ShiftLeft/KeyC/KeyH, props.js + machines/ai.js
// KeyE, focus.js KeyQ, spear.js KeyF, bow.js KeyX, systems/save.js KeyP. Mouse:
// camera.js RMB = aim, bow.js LMB = fire. uinav is the minimal menu-nav set.
const DEFAULT_BINDINGS = {
  forward: ["KeyW"],
  back: ["KeyS"],
  left: ["KeyA"],
  right: ["KeyD"],
  jump: ["Space"],
  dodge: ["ControlLeft"],
  sprint: ["ShiftLeft"],
  crouch: ["KeyC"],
  interact: ["KeyE"],
  focus: ["KeyQ"],
  heal: ["KeyH"],
  quicksave: ["KeyP"],
  melee: ["KeyF"],
  arrowToggle: ["KeyX"],
  aim: ["Mouse2"], // right mouse button (camera.js owns the real listener)
  fire: ["Mouse0"], // left mouse button (bow.js owns the real listener)
  uinavUp: ["ArrowUp"],
  uinavDown: ["ArrowDown"],
  uinavConfirm: ["Enter"],
  uinavCancel: ["Escape"],
};

// Gamepad sources per action (standard mapping); pad state comes from
// src/input/gamepad.js and may be disconnected - every fn guards on that.
const PAD_ACTIONS = {
  forward: (p) => p.move.y < -0.5,
  back: (p) => p.move.y > 0.5,
  left: (p) => p.move.x < -0.5,
  right: (p) => p.move.x > 0.5,
  jump: (p) => !!p.held[PAD_BUTTONS.A],
  dodge: (p) => !!p.held[PAD_BUTTONS.B],
  interact: (p) => !!p.held[PAD_BUTTONS.X],
  crouch: (p) => !!p.held[PAD_BUTTONS.Y],
  sprint: (p) => !!p.held[PAD_BUTTONS.RB],
  focus: (p) => !!p.held[PAD_BUTTONS.LB],
  aim: (p) => p.values[PAD_BUTTONS.RT] > RT_AIM_THRESHOLD,
  fire: (p) => p.values[PAD_BUTTONS.LT] > LT_FIRE_THRESHOLD,
  uinavUp: (p) => !!p.nav.up,
  uinavDown: (p) => !!p.nav.down,
  uinavConfirm: (p) => !!p.held[PAD_BUTTONS.A],
  uinavCancel: (p) => !!p.held[PAD_BUTTONS.B],
};

class InputManager {
  /**
   * How long a requestPointerLock promise may stay unsettled (ms) before the
   * environment is declared lock-incapable and the free-cursor fallback
   * trips. Must sit BELOW the menus layer's ~1.5s relock grace so a
   * lock-incapable environment never reaches the grace auto-pause, and far
   * ABOVE real-browser settlement (milliseconds).
   */
  static LOCK_WATCHDOG_MS = 1000;

  /**
   * How long a held lock must survive (ms) before this session counts as
   * "environment can sustain locks" - see the drop-classification comment in
   * the pointerlockchange handler.
   */
  static LOCK_SUSTAINED_MS = 5000;

  constructor() {
    this.keys = new Set(); // currently held KeyboardEvent.code values
    this.pressedSet = new Set(); // keys pressed since the last endFrame()
    this.mouseDX = 0; // accumulated mouse movement since last consumeMouse()
    this.mouseDY = 0;
    this.wheelDelta = 0;
    this.locked = false; // pointer lock active
    this.lockBroken = false; // browser denied lock repeatedly -> fallback look
    this._element = null;
    this._onLockChange = null;

    // Wave J action-layer state.
    this.mouseButtons = new Set(); // 'Mouse0'..'Mouse4' currently held
    this._userBindings = this._loadBindings(); // { action: code } overrides
    this._effCache = null; // merged defaults+overrides, rebuilt lazily
    this._actionDown = {}; // action -> held this frame (merged sources)
    this._actionPrev = {}; // last frame's _actionDown (edge detection)
    // Actions whose bound key/button went DOWN since the last beginFrame.
    // Event-time edge capture: a tap shorter than one frame gap would
    // otherwise be invisible to the held-state poll below (keys.has is false
    // again by the time the next frame samples it) - quick interacts/jumps/
    // dodges were droppable on loaded or slow machines. Mirrors pressedSet:
    // marked at event time, consumed by exactly one frame, cleared in endFrame.
    this._edgePending = new Set();
    // Outstanding requestPointerLock attempt: { element, at } or null. Evaluated
    // by the frame watchdog in beginFrame - see lockPointer().
    this._lockAttempt = null;
    // performance.now() of the last successful lock ENGAGEMENT - used to tell
    // involuntary drops (environment killed the lock almost immediately)
    // apart from user-initiated exits in the pointerlockchange handler.
    this._lockEngagedAt = null;
    // True once any lock has survived LOCK_SUSTAINED_MS: after that point the
    // environment has proven it CAN hold locks, so later drops are user exits.
    this._lockEverSustained = false;
    this._crouchLatch = false; // toggle-mode state (crouchMode === 'toggle')
    this._aimLatch = false; // toggle-mode state (aimMode === 'toggle')

    // Defensive defaults for the hold/toggle modes owned by this module.
    // ui/settings.js only fills keys that are still undefined
    // (applyA11yDefaults), so whoever evaluates first owns the fresh-boot
    // default - and that is always this constructor (ES static imports finish
    // before main() calls loadSettings, which then lets an explicit user
    // choice from the save win over these fallbacks).
    if (!G.settings) G.settings = {};
    if (G.settings.aimMode !== "toggle") G.settings.aimMode = "hold";
    // Crouch defaults to 'toggle': pre-wave-J player.js flipped a persistent
    // KeyC toggle on every press, and the 3C migration (player.js now consumes
    // isAction('crouch') as a LEVEL with this latch as the single owner) must
    // keep default keyboard behaviour identical. 'hold' remains available as
    // an explicit user setting.
    if (G.settings.crouchMode !== "hold") G.settings.crouchMode = "toggle";

    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      // Don't swallow browser shortcuts for dev tools etc. - but let the
      // modifier keys themselves through: a Control keydown reports its own
      // ctrlKey=true, and ControlLeft is the dodge binding.
      const selfMod = /^(Control|Meta|Alt)(Left|Right)$/.test(e.code);
      if ((e.ctrlKey || e.metaKey || e.altKey) && !selfMod) return;
      this.keys.add(e.code);
      this.pressedSet.add(e.code);
      this._markActionEdges(e.code);
      if (["Space", "Tab"].includes(e.code)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.mouseButtons.clear();
      this._actionDown = {};
      this._actionPrev = {}; // no phantom rising edges across a focus loss
      this._edgePending.clear();
    });

    // Mouse-button tracking feeds the 'MouseN' pseudo-bindings only; the real
    // listeners in camera.js / bow.js stay untouched and authoritative.
    window.addEventListener("mousedown", (e) => {
      const code = `Mouse${e.button}`;
      this.mouseButtons.add(code);
      this._markActionEdges(code);
    });
    window.addEventListener("mouseup", (e) => {
      this.mouseButtons.delete(`Mouse${e.button}`);
    });

    // Track pointer-lock failures: after 2 rejections we stop demanding lock
    // and fall back to free-cursor look (kiosks / denied-permission browsers).
    let lockFails = 0;
    document.addEventListener("pointerlockerror", () => {
      if (++lockFails >= 2) this.lockBroken = true;
    });

    window.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    });
    window.addEventListener(
      "wheel",
      (e) => {
        this.wheelDelta += e.deltaY;
      },
      { passive: true },
    );
    document.addEventListener("pointerlockchange", () => {
      const nowLocked = document.pointerLockElement === this._element;
      this.locked = nowLocked;
      if (nowLocked) {
        lockFails = 0; // a real lock clears the failure streak...
        this.lockBroken = false; // ...so transient errors can't degrade the session
        this._lockAttempt = null; // watchdog satisfied - stop evaluating
        this._lockEngagedAt = performance.now();
      } else {
        this.keys.clear();
        this._lockAttempt = null;
        // Drop classification. A duration threshold CANNOT tell "environment
        // killed the lock" from "user pressed Esc": under a starved compositor
        // locks die at arbitrary ages without any user input. The reliable
        // discriminator is whether THIS SESSION has ever held a lock long
        // enough to prove the environment can sustain one. Until then, every
        // drop is treated as involuntary -> free-cursor fallback (instead of
        // the menus grace auto-pause, which would deadlock a game the player
        // cannot steer). After the first sustained lock, normal semantics
        // return: drops are user exits and trigger the usual auto-pause.
        if (this._lockEngagedAt != null && !this._lockEverSustained) {
          this.lockBroken = true;
        }
        this._lockEngagedAt = null;
      }
      if (this._onLockChange) this._onLockChange(this.locked);
    });
  }

  /** True while the key is held. */
  down(code) {
    return this.keys.has(code);
  }

  /** True only on the frame the key went down (consumed at endFrame). */
  pressed(code) {
    return this.pressedSet.has(code);
  }

  // v5 fix: these five members are the pre-wave-J public API consumed by
  // camera.js (consumeMouse, lockPointer, unlockPointer, onLockChange) and
  // bow.js (consumeWheel). The action-layer rewrite dropped the methods while
  // keeping every listener/field they rely on, which crashed the frame loop
  // on first update. Restored verbatim from the original implementation.

  /** Read and clear accumulated mouse movement. Returns {dx, dy}. */
  consumeMouse() {
    const out = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return out;
  }

  /** Read and clear accumulated wheel motion. Returns deltaY. */
  consumeWheel() {
    const d = this.wheelDelta;
    this.wheelDelta = 0;
    return d;
  }

  lockPointer(element) {
    this._element = element;
    if (document.pointerLockElement !== element) {
      // Modern engines return a promise. Rejections fire pointerlockerror
      // (counted by the listener above), but headless/remote environments can
      // also RESOLVE the promise and then silently never hold the lock -
      // pointerLockElement stays null and no error event ever fires, leaving
      // the game in limbo (no lock, no fallback). Per spec the element is
      // locked synchronously at resolution, so a resolved promise without the
      // lock is proof the environment won't do pointer lock: trip the
      // free-cursor fallback immediately instead of waiting forever.
      //
      // A second pathology: some environments return a promise that NEVER
      // SETTLES - no resolution, no rejection, no pointerlockerror, no lock.
      // A third: under a starved event loop the attempt REJECTS (compositor
      // cannot service the lock) as the FIRST failure of the session - one
      // pointerlockerror only increments the retry counter, so neither
      // locked nor lockBroken would ever be set and the menus-layer grace
      // auto-pause would pause a game the player can see but not steer.
      // Both are closed by tracking the attempt and evaluating it on EVERY
      // FRAME in beginFrame (frame-driven, immune to timer throttling): if
      // LOCK_WATCHDOG_MS passes without a real lock, this environment has
      // proven itself lock-incapable and gets the free-cursor fallback. A
      // real browser settles within milliseconds, so this is inert there;
      // a slow-but-real later lock self-heals via pointerlockchange.
      this._lockAttempt = { element, at: performance.now() };
      try {
        const p = element.requestPointerLock?.();
        if (p && typeof p.then === "function") {
          // The attempt record is deliberately NOT cleared on rejection:
          // a rejected lock is a failure, not a success - let the frame
          // watchdog decide once the window has elapsed.
          p.then(() => {
            if (document.pointerLockElement === element) {
              this._lockAttempt = null;
              // Per spec the element is locked SYNCHRONOUSLY at resolution -
              // reflect it immediately instead of waiting for the
              // pointerlockchange event. Under a starved event loop that
              // event can lag seconds behind; reporting unlocked in the gap
              // would let the menus grace auto-pause fire even though the
              // session does hold the lock.
              this.locked = true;
              // Stamp the engagement HERE as well: a starved environment can
              // lose the lock again before the pointerlockchange event is
              // observed, collapsing engage+drop into one unlock event -
              // without this stamp that drop looks like "never engaged" and
              // evades involuntary-drop detection.
              this._lockEngagedAt = performance.now();
            } else {
              this.lockBroken = true; // resolved WITHOUT holding the lock
              this._lockAttempt = null;
            }
          }).catch(() => {
            /* keep the attempt running - see above */
          });
        }
      } catch {
        /* older engines report via pointerlockerror */
      }
    }
  }

  unlockPointer() {
    if (document.pointerLockElement) document.exitPointerLock?.();
  }

  onLockChange(fn) {
    this._onLockChange = fn;
  }

  // ------------------------------------------------------------- actions --

  /**
   * True while `action` is held under its current bindings, merged across
   * keyboard/mouse/gamepad. For crouch/aim with mode 'toggle' this reports the
   * internal latch instead of the live hold.
   */
  isAction(action) {
    if (
      G.settings &&
      G.settings.crouchMode === "toggle" &&
      action === "crouch"
    ) {
      return this._crouchLatch;
    }
    if (G.settings && G.settings.aimMode === "toggle" && action === "aim") {
      return this._aimLatch;
    }
    return !!this._actionDown[action];
  }

  /** True only on the frame `action` transitioned from released to held. */
  wasActionPressed(action) {
    return !!this._actionDown[action] && !this._actionPrev[action];
  }

  /** Right-stick axes for camera look, radial-deadzoned. Sign convention
   *  matches mouse movementX/Y: stick right = +x, stick up = -y; invertY is
   *  applied by the consumer exactly like it is for consumeMouse(). */
  getLookAxes() {
    const p = getGamepadState();
    return { x: p.look.x, y: p.look.y };
  }

  /** Effective action -> codes[] map (fresh copy; safe for UI display). */
  getBindings() {
    const eff = this._effective();
    const out = {};
    for (const action of Object.keys(eff)) out[action] = eff[action].slice();
    return out;
  }

  /**
   * Replace `action`'s bindings with the single `code`. Accepts KeyboardEvent
   * codes or 'MouseN'. Unknown actions are rejected; persistence is best-effort.
   * Returns true when the binding changed.
   */
  setBinding(action, code) {
    if (!DEFAULT_BINDINGS[action]) return false;
    const c = String(code || "");
    if (!c) return false;
    this._userBindings[action] = c;
    this._effCache = null;
    try {
      localStorage.setItem(BINDINGS_KEY, JSON.stringify(this._userBindings));
    } catch (err) {
      /* storage unavailable - binding stays session-only */
    }
    return true;
  }

  /** Restore one action to its default binding(s). */
  resetBinding(action) {
    delete this._userBindings[action];
    this._effCache = null;
    try {
      localStorage.setItem(BINDINGS_KEY, JSON.stringify(this._userBindings));
    } catch (err) {
      /* storage unavailable - binding stays session-only */
    }
  }

  /** Clear every override (and the persisted override map). */
  resetBindings() {
    this._userBindings = {};
    this._effCache = null;
    try {
      localStorage.removeItem(BINDINGS_KEY);
    } catch (err) {
      /* storage unavailable */
    }
  }

  _loadBindings() {
    const out = {};
    try {
      const saved = JSON.parse(localStorage.getItem(BINDINGS_KEY));
      if (saved && typeof saved === "object") {
        for (const [action, code] of Object.entries(saved)) {
          if (DEFAULT_BINDINGS[action] && typeof code === "string" && code) {
            out[action] = code; // unknown actions / bad shapes dropped silently
          }
        }
      }
    } catch (err) {
      /* corrupt JSON or storage unavailable - keep defaults */
    }
    return out;
  }

  _effective() {
    if (this._effCache) return this._effCache;
    const merged = {};
    for (const [action, codes] of Object.entries(DEFAULT_BINDINGS)) {
      merged[action] = codes.slice();
    }
    for (const [action, code] of Object.entries(this._userBindings)) {
      if (DEFAULT_BINDINGS[action]) merged[action] = [code];
    }
    this._effCache = merged;
    return merged;
  }

  /**
   * Mark every action currently bound to `code` as edge-pending. Called from
   * the keydown/mousedown listeners so rising edges survive sub-frame taps.
   * Bindings are read at EVENT time (what the user physically pressed under).
   */
  _markActionEdges(code) {
    for (const [action, codes] of Object.entries(this._effective())) {
      if (codes.includes(code)) this._edgePending.add(action);
    }
  }

  /** Merged keyboard/mouse/gamepad hold state for one action (no mode logic). */
  _rawAction(action) {
    const codes = this._effective()[action];
    if (codes) {
      for (const code of codes) {
        if (this.keys.has(code) || this.mouseButtons.has(code)) return true;
      }
    }
    const padFn = PAD_ACTIONS[action];
    if (padFn) {
      const p = getGamepadState();
      if (p.connected && padFn(p)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ framing --

  /**
   * Called at the START of each frame. Keydown events arrive between frames,
   * so pressedSet must NOT be cleared here — systems read it after this point.
   * Wave J: poll gamepads first, then refresh the merged action states.
   */
  beginFrame() {
    pollGamepads();

    // Start/Options = pause-equivalent: pulse Escape through the same
    // pressedSet pipeline menus.js already polls, so pause/resume/close-panel
    // behave exactly like a physical Esc tap. Settings-modal Esc handling is
    // DOM-level and intentionally not reachable from here.
    if (getGamepadState().startEdge) this.pressedSet.add("Escape");

    // Lock-attempt watchdog (frame-driven; see lockPointer): once
    // LOCK_WATCHDOG_MS has elapsed since the request without the element
    // actually becoming locked, the environment has proven it cannot hold
    // pointer lock - trip the free-cursor fallback. Checked here rather than
    // in a setTimeout so heavy timer throttling cannot delay the fallback
    // past the menus layer's relock grace.
    const la = this._lockAttempt;
    if (
      la &&
      document.pointerLockElement !== la.element &&
      performance.now() - la.at >= InputManager.LOCK_WATCHDOG_MS
    ) {
      this.lockBroken = true;
      this._lockAttempt = null;
    }

    // Sustained-lock proof: one lock surviving LOCK_SUSTAINED_MS upgrades the
    // session to "environment can hold locks" (see drop classification in
    // pointerlockchange). Checked per frame - immune to timer throttling.
    if (
      !this._lockEverSustained &&
      this.locked &&
      this._lockEngagedAt != null &&
      performance.now() - this._lockEngagedAt >= InputManager.LOCK_SUSTAINED_MS
    ) {
      this._lockEverSustained = true;
    }

    for (const action of Object.keys(DEFAULT_BINDINGS)) {
      // OR the pending event-time edge into the held-state poll: a tap that
      // started AND ended between frames still reads "down" for exactly this
      // one frame, producing the rising edge consumers expect.
      this._actionDown[action] =
        this._rawAction(action) || this._edgePending.has(action);
    }
    // Rising edge flips the latch once per press; while mode is 'toggle' the
    // latch (not the live hold) is what isAction reports.
    if (
      G.settings.crouchMode === "toggle" &&
      this._actionDown.crouch &&
      !this._actionPrev.crouch
    ) {
      this._crouchLatch = !this._crouchLatch;
    }
    if (
      G.settings.aimMode === "toggle" &&
      this._actionDown.aim &&
      !this._actionPrev.aim
    ) {
      this._aimLatch = !this._aimLatch;
    }
  }

  /** Called at the END of each frame, after all systems have polled pressed(). */
  endFrame() {
    this.pressedSet.clear();
    this.wheelDelta = 0;
    this._edgePending.clear(); // edges live for exactly one frame, like pressedSet
    // Action edges: this frame's state becomes next frame's "previous".
    this._actionPrev = { ...this._actionDown };
  }
}

export const Input = new InputManager();
