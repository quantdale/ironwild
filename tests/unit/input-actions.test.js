// IRONWILD - unit tests for the Wave J action layer (src/core/input.js) and
// the 3C consumer migration (player.js now reads Input.isAction/wasActionPressed
// instead of raw Input.down/pressed polls).
//
// Strategy: the setup.dom.js window stub records listeners but cannot dispatch,
// so these tests capture the handlers input.js registers at construction and
// invoke them directly with plain event-shaped objects - the exact same code
// path a real keydown/keyup/mousedown takes, minus the DOM Event wrapper.
// Every test builds a fresh Input singleton via vi.resetModules() + dynamic
// import (module state is otherwise shared across tests), mirroring the
// established pattern in status-burn.test.js.

import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Window-listener capture. Installed once per test file: vitest gives each file
// its own worker environment, so replacing the setup stub's addEventListener is
// safe here. The registry is cleared in beforeEach so stale handlers from a
// previous test's Input instance can never fire.
const handlers = new Map(); // type -> [fn]

// The pointer-lock lifecycle lives on DOCUMENT events (pointerlockchange),
// so capture document listeners too (setup.dom.js discards them by default).
const docHandlers = new Map();
globalThis.document.addEventListener = (type, fn) => {
  if (!docHandlers.has(type)) docHandlers.set(type, []);
  docHandlers.get(type).push(fn);
};

function fireDoc(type) {
  const list = docHandlers.get(type) || [];
  for (const fn of list) fn({});
}

globalThis.window.addEventListener = (type, fn) => {
  if (!handlers.has(type)) handlers.set(type, []);
  handlers.get(type).push(fn);
};

/** Invoke every captured listener for `type` synchronously, in registration order. */
function fire(type, evt = {}) {
  const list = handlers.get(type) || [];
  for (const fn of list) fn(evt);
}

function keyDown(code, opts = {}) {
  // Shape mirrors KeyboardEvent fields input.js actually reads; modifiers must
  // default false or the shortcut guard would swallow gameplay keys.
  fire("keydown", {
    code,
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault() {},
    ...opts,
  });
}
function keyUp(code) {
  fire("keyup", { code });
}
function mouseDown(button) {
  fire("mousedown", { button });
}
function mouseUp(button) {
  fire("mouseup", { button });
}

/** Fresh module graph -> brand-new Input singleton + its own G/settings. */
async function fresh() {
  vi.resetModules();
  const [stateMod, inputMod] = await Promise.all([
    import("../../src/core/state.js"),
    import("../../src/core/input.js"),
  ]);
  return { G: stateMod.G, Input: inputMod.Input };
}

beforeEach(() => {
  handlers.clear();
  globalThis.localStorage.clear(); // persisted overrides must not leak between tests
  vi.resetModules();
});

describe("default bindings", () => {
  it("map every gameplay action to the legacy physical keys", async () => {
    const { Input } = await fresh();
    const b = Input.getBindings();
    expect(b.forward).toContain("KeyW");
    expect(b.back).toContain("KeyS");
    expect(b.left).toContain("KeyA");
    expect(b.right).toContain("KeyD");
    expect(b.jump).toContain("Space");
    expect(b.dodge).toContain("ControlLeft");
    expect(b.sprint).toContain("ShiftLeft");
    expect(b.crouch).toContain("KeyC");
    expect(b.interact).toContain("KeyE");
    expect(b.focus).toContain("KeyQ");
    expect(b.heal).toContain("KeyH");
    expect(b.quicksave).toContain("KeyP");
    expect(b.melee).toContain("KeyF");
    expect(b.arrowToggle).toContain("KeyX");
    expect(b.aim).toContain("Mouse2"); // RMB pseudo-code
    expect(b.fire).toContain("Mouse0"); // LMB pseudo-code
  });

  it("fresh boot defaults crouch to toggle mode (legacy KeyC feel preserved)", async () => {
    const { G } = await fresh();
    expect(G.settings.crouchMode).toBe("toggle");
    expect(G.settings.aimMode).toBe("hold"); // legacy hold-RMB-to-aim feel
  });
});

describe("legacy raw API is unchanged", () => {
  it("down()/pressed() keep their immediate / endFrame-scoped semantics", async () => {
    const { Input } = await fresh();
    expect(Input.down("KeyW")).toBe(false);

    keyDown("KeyW");
    expect(Input.down("KeyW")).toBe(true); // visible immediately, no beginFrame needed
    expect(Input.pressed("KeyW")).toBe(true); // pressed since last endFrame

    Input.endFrame();
    expect(Input.pressed("KeyW")).toBe(false); // cleared at endFrame...
    expect(Input.down("KeyW")).toBe(true); // ...but "held" survives

    keyUp("KeyW");
    expect(Input.down("KeyW")).toBe(false);
  });

  it("raw pressed() still catches a tap that starts and ends between frames", async () => {
    const { Input } = await fresh();
    keyDown("Space");
    keyUp("Space");
    Input.beginFrame(); // pressedSet is NOT cleared here by design
    expect(Input.pressed("Space")).toBe(true);
    Input.endFrame();
    expect(Input.pressed("Space")).toBe(false);
  });
});

describe("action frame semantics", () => {
  it("isAction only reports after beginFrame samples the held keys", async () => {
    const { Input } = await fresh();
    keyDown("KeyW");
    expect(Input.isAction("forward")).toBe(false); // not sampled yet
    Input.beginFrame();
    expect(Input.isAction("forward")).toBe(true);
    Input.endFrame();
  });

  it("held action stays true across frames until release", async () => {
    const { Input } = await fresh();
    keyDown("KeyS");
    Input.beginFrame();
    expect(Input.isAction("back")).toBe(true);
    Input.endFrame();
    Input.beginFrame(); // still holding S
    expect(Input.isAction("back")).toBe(true);
    Input.endFrame();
    keyUp("KeyS");
    Input.beginFrame();
    expect(Input.isAction("back")).toBe(false);
    Input.endFrame();
  });

  it("a tap that starts AND ends between frames still yields one rising edge", async () => {
    // Regression: edges were derived purely from held-state polling, so a tap
    // shorter than one frame gap (loaded machine / low fps) was invisible -
    // keydown added the code to keys, keyup removed it, and no beginFrame ever
    // sampled it as down. Event-time edge capture now mirrors pressedSet.
    const { Input } = await fresh();

    keyDown("KeyE");
    keyUp("KeyE"); // entire press happens with NO beginFrame in between
    expect(Input.keys.has("KeyE")).toBe(false); // hold state is already gone...

    Input.beginFrame(); // ...but the next frame must still see the edge
    expect(Input.wasActionPressed("interact")).toBe(true);
    expect(Input.isAction("interact")).toBe(true); // one-frame virtual hold
    Input.endFrame();

    Input.beginFrame(); // edge is single-shot: gone the frame after
    expect(Input.wasActionPressed("interact")).toBe(false);
    expect(Input.isAction("interact")).toBe(false);
    Input.endFrame();
  });

  it("sub-frame mouse taps produce fire/aim edges exactly once", async () => {
    const { Input } = await fresh();
    mouseDown(0);
    mouseUp(0); // full LMB tap inside one frame gap
    Input.beginFrame();
    expect(Input.wasActionPressed("fire")).toBe(true);
    Input.endFrame();
    Input.beginFrame();
    expect(Input.wasActionPressed("fire")).toBe(false);
    Input.endFrame();
  });

  it("wasActionPressed fires on the rising edge exactly once per press", async () => {
    const { Input } = await fresh();

    keyDown("Space");
    Input.beginFrame();
    expect(Input.wasActionPressed("jump")).toBe(true);
    expect(Input.wasActionPressed("jump")).toBe(true); // reads never consume the edge
    Input.endFrame();

    Input.beginFrame(); // still held: no second edge
    expect(Input.wasActionPressed("jump")).toBe(false);
    Input.endFrame();

    keyUp("Space");
    Input.beginFrame();
    expect(Input.wasActionPressed("jump")).toBe(false); // release is not an edge
    Input.endFrame();

    keyDown("Space"); // re-press edges again
    Input.beginFrame();
    expect(Input.wasActionPressed("jump")).toBe(true);
    Input.endFrame();
  });

  it("sub-frame tap-and-release: edge API now catches it like raw pressed()", async () => {
    // FIXED semantic (was documented as a known gap): edges are captured at
    // EVENT time and survive until the next frame, so a press+release entirely
    // between frames yields one action edge exactly like pressedSet does for
    // raw keys. Human taps on loaded/low-fps machines no longer drop inputs.
    const { Input } = await fresh();
    keyDown("Space");
    keyUp("Space");
    Input.beginFrame();
    expect(Input.pressed("Space")).toBe(true);
    expect(Input.wasActionPressed("jump")).toBe(true);
    Input.endFrame();
    Input.beginFrame();
    expect(Input.wasActionPressed("jump")).toBe(false); // single-shot
    Input.endFrame();
  });

  it("blur clears held keyboard+mouse state without phantom rising edges", async () => {
    const { Input } = await fresh();
    keyDown("KeyW");
    mouseDown(2);
    Input.beginFrame();
    expect(Input.isAction("forward")).toBe(true);
    Input.endFrame();

    fire("blur"); // alt-tab away mid-hold
    Input.beginFrame();
    expect(Input.isAction("forward")).toBe(false);
    expect(Input.isAction("aim")).toBe(false);
    Input.endFrame();
    Input.beginFrame();
    // No phantom edge afterwards even though _actionDown went true->false->...
    expect(Input.wasActionPressed("forward")).toBe(false);
    Input.endFrame();
  });

  it("beginFrame/endFrame survive node with no gamepad connected", async () => {
    const { Input } = await fresh();
    expect(() => Input.beginFrame()).not.toThrow();
    expect(Input.isAction("jump")).toBe(false); // pad merge contributes nothing
    Input.endFrame();
  });
});

describe("setBinding / resetBinding / persistence", () => {
  const BINDINGS_KEY = "ironwild-bindings";

  it("rebind takes effect on the next frame and unbinds the old key", async () => {
    const { Input } = await fresh();
    expect(Input.setBinding("jump", "KeyM")).toBe(true);

    keyDown("KeyM");
    Input.beginFrame();
    expect(Input.isAction("jump")).toBe(true);
    expect(Input.wasActionPressed("jump")).toBe(true);
    Input.endFrame();
    keyUp("KeyM");

    keyDown("Space"); // old binding must be dead after an override
    Input.beginFrame();
    expect(Input.isAction("jump")).toBe(false);
    Input.endFrame();
  });

  it("persists the override map shape to localStorage", async () => {
    const { Input } = await fresh();
    Input.setBinding("jump", "KeyM");
    expect(JSON.parse(globalThis.localStorage.getItem(BINDINGS_KEY))).toEqual({
      jump: "KeyM",
    });
  });

  it("resetBinding restores the default immediately (and unpersists)", async () => {
    const { Input } = await fresh();
    Input.setBinding("jump", "KeyM");
    Input.resetBinding("jump");
    expect(Input.getBindings().jump).toEqual(["Space"]);
    expect(JSON.parse(globalThis.localStorage.getItem(BINDINGS_KEY))).toEqual(
      {},
    ); // override removed from storage too

    keyDown("Space");
    Input.beginFrame();
    expect(Input.isAction("jump")).toBe(true);
    Input.endFrame();
  });

  it("rejects unknown actions and empty codes without touching storage", async () => {
    const { Input } = await fresh();
    expect(Input.setBinding("fly", "KeyZ")).toBe(false);
    expect(Input.setBinding("jump", "")).toBe(false);
    expect(Input.setBinding("jump", null)).toBe(false);
    expect(globalThis.localStorage.getItem(BINDINGS_KEY)).toBeNull();
  });

  it("duplicate codes across two actions both trigger (no conflict policy - documented behaviour)", async () => {
    // Actual policy: overrides are per-action with no conflict detection, so
    // sharing a code makes both actions fire. Recorded here deliberately so a
    // future conflict policy change shows up as an intentional contract edit.
    const { Input } = await fresh();
    Input.setBinding("jump", "KeyM");
    Input.setBinding("sprint", "KeyM");
    keyDown("KeyM");
    Input.beginFrame();
    expect(Input.isAction("jump")).toBe(true);
    expect(Input.isAction("sprint")).toBe(true);
    Input.endFrame();
  });

  it("persisted overrides merge BEFORE the first frame (constructor load)", async () => {
    globalThis.localStorage.setItem(
      BINDINGS_KEY,
      JSON.stringify({ jump: "KeyM" }),
    );
    const { Input } = await fresh(); // no setBinding call this session
    keyDown("KeyM");
    Input.beginFrame(); // very first frame already honours the saved binding
    expect(Input.isAction("jump")).toBe(true);
    Input.endFrame();
  });

  it("corrupt persisted JSON falls back to defaults instead of crashing boot", async () => {
    globalThis.localStorage.setItem(BINDINGS_KEY, "{not json");
    const { Input } = await fresh();
    keyDown("KeyW");
    Input.beginFrame();
    expect(Input.isAction("forward")).toBe(true); // defaults intact
    Input.endFrame();
  });

  it("drops unknown actions and malformed entries from storage safely", async () => {
    globalThis.localStorage.setItem(
      BINDINGS_KEY,
      JSON.stringify({ jump: "KeyM", fly: "KeyZ", heal: 42, crouch: "" }),
    );
    const { Input } = await fresh();

    // Valid override kept.
    keyDown("KeyM");
    Input.beginFrame();
    expect(Input.isAction("jump")).toBe(true);
    Input.endFrame();
    keyUp("KeyM");

    // Unknown action name, non-string code, empty string: all dropped.
    expect(Input.getBindings().fly).toBeUndefined();
    keyDown("KeyH");
    Input.beginFrame();
    expect(Input.isAction("heal")).toBe(true); // still default KeyH
    Input.endFrame();
  });
});

describe("hold/toggle modes (aim + crouch latches)", () => {
  it("crouch 'toggle': each tap flips the latch once; level persists between taps", async () => {
    const { Input } = await fresh();

    keyDown("KeyC");
    Input.beginFrame(); // rising edge flips latch ON
    expect(Input.isAction("crouch")).toBe(true);
    expect(Input.wasActionPressed("crouch")).toBe(true);
    Input.endFrame();
    keyUp("KeyC");

    Input.beginFrame(); // released, but the toggle stays engaged
    expect(Input.isAction("crouch")).toBe(true);
    Input.endFrame();
    Input.beginFrame();
    expect(Input.isAction("crouch")).toBe(true);
    Input.endFrame();

    keyDown("KeyC"); // second tap disengages
    Input.beginFrame();
    expect(Input.isAction("crouch")).toBe(false);
    expect(Input.wasActionPressed("crouch")).toBe(true);
    Input.endFrame();
    keyUp("KeyC");
  });

  it("crouch 'hold': level tracks the key with no latch carryover", async () => {
    const { G, Input } = await fresh();
    G.settings.crouchMode = "hold";

    keyDown("KeyC");
    Input.beginFrame();
    expect(Input.isAction("crouch")).toBe(true);
    Input.endFrame();
    keyUp("KeyC");

    Input.beginFrame();
    expect(Input.isAction("crouch")).toBe(false); // released -> immediately off
    Input.endFrame();
  });

  it("aim 'toggle': Mouse2 tap latches aim on and a second tap releases", async () => {
    const { G, Input } = await fresh();
    G.settings.aimMode = "toggle";

    mouseDown(2);
    Input.beginFrame();
    expect(Input.isAction("aim")).toBe(true);
    Input.endFrame();
    mouseUp(2);

    Input.beginFrame(); // button long released, aim stays latched
    expect(Input.isAction("aim")).toBe(true);
    Input.endFrame();

    mouseDown(2); // second tap unlatches
    Input.beginFrame();
    expect(Input.isAction("aim")).toBe(false);
    Input.endFrame();
    mouseUp(2);
  });

  it("aim 'hold' (default): Mouse2 acts as a plain level via the pseudo-binding", async () => {
    const { Input } = await fresh();
    mouseDown(2);
    Input.beginFrame();
    expect(Input.isAction("aim")).toBe(true);
    Input.endFrame();
    mouseUp(2);
    Input.beginFrame();
    expect(Input.isAction("aim")).toBe(false);
    Input.endFrame();
  });

  it("Mouse0 feeds the fire action in hold mode alongside keyboard codes", async () => {
    const { Input } = await fresh();
    mouseDown(0);
    keyDown("KeyX"); // unrelated key must not leak into other actions
    Input.beginFrame();
    expect(Input.isAction("fire")).toBe(true);
    expect(Input.isAction("arrowToggle")).toBe(true);
    Input.endFrame();
    mouseUp(0);
    keyUp("KeyX");
  });
});

describe("pointer-lock fallback watchdog", () => {
  let nowValue;
  let InputRef; // describe-scoped binding used by the beginFrameAt helper

  function lockElement(promiseBehavior) {
    return {
      requestPointerLock() {
        return promiseBehavior();
      },
    };
  }

  function beginFrameAt(t) {
    nowValue = t;
    InputRef.beginFrame();
    InputRef.endFrame();
  }

  beforeEach(async () => {
    handlers.clear();
    globalThis.localStorage.clear();
    vi.resetModules();
    nowValue = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => nowValue);
    ({ Input: InputRef } = await fresh());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.document.pointerLockElement;
  });

  it("a never-settling lock promise trips the fallback one frame past the window", async () => {
    const el = lockElement(() => new Promise(() => {})); // pending forever
    document.pointerLockElement = null;

    InputRef.lockPointer(el);
    expect(InputRef.lockBroken).toBe(false);

    beginFrameAt(nowValue + 400); // inside the window: still deciding
    expect(InputRef.lockBroken).toBe(false);

    beginFrameAt(nowValue + 1500); // past LOCK_WATCHDOG_MS: environment proven
    expect(InputRef.lockBroken).toBe(true);
  });

  it("a REJECTED lock attempt is a failure, not a success - watchdog still trips", async () => {
    const el = lockElement(() =>
      Promise.reject(new DOMException("x", "NotSupportedError")),
    );
    document.pointerLockElement = null;

    InputRef.lockPointer(el);
    // let the rejection microtask run
    await Promise.resolve();
    await Promise.resolve();
    expect(InputRef.lockBroken).toBe(false); // not immediate: retry counting owns transients

    beginFrameAt(nowValue + 1500);
    expect(InputRef.lockBroken).toBe(true);
  });

  it("resolution WITH the lock clears the attempt; broken stays false", async () => {
    let resolveLock;
    const el = lockElement(
      () =>
        new Promise((res) => {
          resolveLock = res;
        }),
    );
    document.pointerLockElement = null;

    // Per spec the element becomes locked synchronously AT resolution, so:
    // request first (guard sees no lock), then hold the lock, then settle.
    InputRef.lockPointer(el);
    document.pointerLockElement = el;
    expect(resolveLock).toBeTypeOf("function");
    resolveLock();
    await Promise.resolve();
    await Promise.resolve();

    beginFrameAt(nowValue + 5000); // far past the window
    expect(InputRef.lockBroken).toBe(false);
  });

  it("a lock dropped within the watchdog window is INVOLUNTARY: fallback trips", async () => {
    const el = lockElement(() => new Promise(() => {}));
    InputRef.lockPointer(el); // establish _element + a pending attempt
    // engage...
    document.pointerLockElement = el;
    fireDoc("pointerlockchange");
    expect(InputRef.locked).toBe(true);
    expect(InputRef.lockBroken).toBe(false);

    // ...and lose it again almost immediately (starved compositor / headless
    // GPU process). No user Esc happens this early in a lock's life.
    beginFrameAt(nowValue + 200); // advance the (mocked) clock 200ms
    document.pointerLockElement = null;
    fireDoc("pointerlockchange");
    expect(InputRef.locked).toBe(false);
    expect(InputRef.lockBroken).toBe(true); // single strike: nothing else would ever retry
  });

  it("a LATE unlock (user Esc during play) does NOT mark the environment broken", async () => {
    const el = lockElement(() => new Promise(() => {}));
    InputRef.lockPointer(el);
    document.pointerLockElement = el;
    fireDoc("pointerlockchange");
    expect(InputRef.locked).toBe(true);

    beginFrameAt(nowValue + 60_000); // a minute of gameplay, then the user exits
    document.pointerLockElement = null;
    fireDoc("pointerlockchange");
    expect(InputRef.lockBroken).toBe(false);
  });

  it("a later SUSTAINED relock self-heals a previously broken session", async () => {
    const el = lockElement(() => new Promise(() => {}));
    InputRef.lockPointer(el);
    document.pointerLockElement = el;
    fireDoc("pointerlockchange");
    beginFrameAt(nowValue + 200);
    document.pointerLockElement = null;
    fireDoc("pointerlockchange");
    expect(InputRef.lockBroken).toBe(true);

    // The environment manages a real lock afterwards (e.g. load subsided).
    document.pointerLockElement = el;
    fireDoc("pointerlockchange");
    expect(InputRef.lockBroken).toBe(false);
    expect(InputRef.locked).toBe(true);
  });
});
