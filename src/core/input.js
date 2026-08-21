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

import { G } from './state.js';
import {
  pollGamepads,
  getGamepadState,
  RT_AIM_THRESHOLD,
  LT_FIRE_THRESHOLD,
  PAD_BUTTONS,
} from '../input/gamepad.js';

const BINDINGS_KEY = 'ironwild-bindings';

// Defaults derived from the raw codes actually polled across src/ today:
// player.js WASD/Space/ControlLeft/ShiftLeft/KeyC/KeyH, props.js + machines/ai.js
// KeyE, focus.js KeyQ, spear.js KeyF, bow.js KeyX, systems/save.js KeyP. Mouse:
// camera.js RMB = aim, bow.js LMB = fire. uinav is the minimal menu-nav set.
const DEFAULT_BINDINGS = {
  forward: ['KeyW'],
  back: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  jump: ['Space'],
  dodge: ['ControlLeft'],
  sprint: ['ShiftLeft'],
  crouch: ['KeyC'],
  interact: ['KeyE'],
  focus: ['KeyQ'],
  heal: ['KeyH'],
  quicksave: ['KeyP'],
  melee: ['KeyF'],
  arrowToggle: ['KeyX'],
  aim: ['Mouse2'],       // right mouse button (camera.js owns the real listener)
  fire: ['Mouse0'],      // left mouse button (bow.js owns the real listener)
  uinavUp: ['ArrowUp'],
  uinavDown: ['ArrowDown'],
  uinavConfirm: ['Enter'],
  uinavCancel: ['Escape'],
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
  constructor() {
    this.keys = new Set();        // currently held KeyboardEvent.code values
    this.pressedSet = new Set();  // keys pressed since the last endFrame()
    this.mouseDX = 0;             // accumulated mouse movement since last consumeMouse()
    this.mouseDY = 0;
    this.wheelDelta = 0;
    this.locked = false;          // pointer lock active
    this.lockBroken = false;      // browser denied lock repeatedly -> fallback look
    this._element = null;
    this._onLockChange = null;

    // Wave J action-layer state.
    this.mouseButtons = new Set();      // 'Mouse0'..'Mouse4' currently held
    this._userBindings = this._loadBindings(); // { action: code } overrides
    this._effCache = null;              // merged defaults+overrides, rebuilt lazily
    this._actionDown = {};              // action -> held this frame (merged sources)
    this._actionPrev = {};              // last frame's _actionDown (edge detection)
    this._crouchLatch = false;          // toggle-mode state (crouchMode === 'toggle')
    this._aimLatch = false;             // toggle-mode state (aimMode === 'toggle')

    // Defensive defaults for the hold/toggle modes owned by this module
    // (ui/settings.js merges the same keys - both are idempotent).
    if (!G.settings) G.settings = {};
    if (G.settings.aimMode !== 'toggle') G.settings.aimMode = 'hold';
    if (G.settings.crouchMode !== 'toggle') G.settings.crouchMode = 'hold';

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      // Don't swallow browser shortcuts for dev tools etc. - but let the
      // modifier keys themselves through: a Control keydown reports its own
      // ctrlKey=true, and ControlLeft is the dodge binding.
      const selfMod = /^(Control|Meta|Alt)(Left|Right)$/.test(e.code);
      if ((e.ctrlKey || e.metaKey || e.altKey) && !selfMod) return;
      this.keys.add(e.code);
      this.pressedSet.add(e.code);
      if (['Space', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseButtons.clear();
      this._actionDown = {};
      this._actionPrev = {}; // no phantom rising edges across a focus loss
    });

    // Mouse-button tracking feeds the 'MouseN' pseudo-bindings only; the real
    // listeners in camera.js / bow.js stay untouched and authoritative.
    window.addEventListener('mousedown', (e) => { this.mouseButtons.add(`Mouse${e.button}`); });
    window.addEventListener('mouseup', (e) => { this.mouseButtons.delete(`Mouse${e.button}`); });

    // Track pointer-lock failures: after 2 rejections we stop demanding lock
    // and fall back to free-cursor look (kiosks / denied-permission browsers).
    let lockFails = 0;
    document.addEventListener('pointerlockerror', () => {
      if (++lockFails >= 2) this.lockBroken = true;
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    });
    window.addEventListener('wheel', (e) => { this.wheelDelta += e.deltaY; }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this._element;
      if (this.locked) {
        lockFails = 0;           // a real lock clears the failure streak...
        this.lockBroken = false; // ...so transient errors can't degrade the session
      } else {
        this.keys.clear();
      }
      if (this._onLockChange) this._onLockChange(this.locked);
    });
  }

  /** True while the key is held. */
  down(code) { return this.keys.has(code); }

  /** True only on the frame the key went down (consumed at endFrame). */
  pressed(code) { return this.pressedSet.has(code); }

  // ------------------------------------------------------------- actions --

  /**
   * True while `action` is held under its current bindings, merged across
   * keyboard/mouse/gamepad. For crouch/aim with mode 'toggle' this reports the
   * internal latch instead of the live hold.
   */
  isAction(action) {
    if (G.settings && G.settings.crouchMode === 'toggle' && action === 'crouch') {
      return this._crouchLatch;
    }
    if (G.settings && G.settings.aimMode === 'toggle' && action === 'aim') {
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
    const c = String(code || '');
    if (!c) return false;
    this._userBindings[action] = c;
    this._effCache = null;
    try {
      localStorage.setItem(BINDINGS_KEY, JSON.stringify(this._userBindings));
    } catch (err) { /* storage unavailable - binding stays session-only */ }
    return true;
  }

  /** Restore one action to its default binding(s). */
  resetBinding(action) {
    delete this._userBindings[action];
    this._effCache = null;
    try {
      localStorage.setItem(BINDINGS_KEY, JSON.stringify(this._userBindings));
    } catch (err) { /* storage unavailable - binding stays session-only */ }
  }

  /** Clear every override (and the persisted override map). */
  resetBindings() {
    this._userBindings = {};
    this._effCache = null;
    try {
      localStorage.removeItem(BINDINGS_KEY);
    } catch (err) { /* storage unavailable */ }
  }

  _loadBindings() {
    const out = {};
    try {
      const saved = JSON.parse(localStorage.getItem(BINDINGS_KEY));
      if (saved && typeof saved === 'object') {
        for (const [action, code] of Object.entries(saved)) {
          if (DEFAULT_BINDINGS[action] && typeof code === 'string' && code) {
            out[action] = code; // unknown actions / bad shapes dropped silently
          }
        }
      }
    } catch (err) { /* corrupt JSON or storage unavailable - keep defaults */ }
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
    if (getGamepadState().startEdge) this.pressedSet.add('Escape');

    for (const action of Object.keys(DEFAULT_BINDINGS)) {
      this._actionDown[action] = this._rawAction(action);
    }
    // Rising edge flips the latch once per press; while mode is 'toggle' the
    // latch (not the live hold) is what isAction reports.
    if (G.settings.crouchMode === 'toggle' &&
        this._actionDown.crouch && !this._actionPrev.crouch) {
      this._crouchLatch = !this._crouchLatch;
    }
    if (G.settings.aimMode === 'toggle' &&
        this._actionDown.aim && !this._actionPrev.aim) {
      this._aimLatch = !this._aimLatch;
    }
  }

  /** Called at the END of each frame, after all systems have polled pressed(). */
  endFrame() {
    this.pressedSet.clear();
    this.wheelDelta = 0;
    // Action edges: this frame's state becomes next frame's "previous".
    this._actionPrev = { ...this._actionDown };
  }
}

export const Input = new InputManager();
