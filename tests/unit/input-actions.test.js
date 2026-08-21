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

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Window-listener capture. Installed once per test file: vitest gives each file
// its own worker environment, so replacing the setup stub's addEventListener is
// safe here. The registry is cleared in beforeEach so stale handlers from a
// previous test's Input instance can never fire.
const handlers = new Map(); // type -> [fn]

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
  fire('keydown', {
    code, repeat: false, ctrlKey: false, metaKey: false, altKey: false,
    preventDefault() {}, ...opts,
  });
}
function keyUp(code) { fire('keyup', { code }); }
function mouseDown(button) { fire('mousedown', { button }); }
function mouseUp(button) { fire('mouseup', { button }); }

/** Fresh module graph -> brand-new Input singleton + its own G/settings. */
async function fresh() {
  vi.resetModules();
  const [stateMod, inputMod] = await Promise.all([
    import('../../src/core/state.js'),
    import('../../src/core/input.js'),
  ]);
  return { G: stateMod.G, Input: inputMod.Input };
}

beforeEach(() => {
  handlers.clear();
  globalThis.localStorage.clear(); // persisted overrides must not leak between tests
  vi.resetModules();
});

describe('default bindings', () => {
  it('map every gameplay action to the legacy physical keys', async () => {
    const { Input } = await fresh();
    const b = Input.getBindings();
    expect(b.forward).toContain('KeyW');
    expect(b.back).toContain('KeyS');
    expect(b.left).toContain('KeyA');
    expect(b.right).toContain('KeyD');
    expect(b.jump).toContain('Space');
    expect(b.dodge).toContain('ControlLeft');
    expect(b.sprint).toContain('ShiftLeft');
    expect(b.crouch).toContain('KeyC');
    expect(b.interact).toContain('KeyE');
    expect(b.focus).toContain('KeyQ');
    expect(b.heal).toContain('KeyH');
    expect(b.quicksave).toContain('KeyP');
    expect(b.melee).toContain('KeyF');
    expect(b.arrowToggle).toContain('KeyX');
    expect(b.aim).toContain('Mouse2'); // RMB pseudo-code
    expect(b.fire).toContain('Mouse0'); // LMB pseudo-code
  });

  it('fresh boot defaults crouch to toggle mode (legacy KeyC feel preserved)', async () => {
    const { G } = await fresh();
    expect(G.settings.crouchMode).toBe('toggle');
    expect(G.settings.aimMode).toBe('hold'); // legacy hold-RMB-to-aim feel
  });
});

describe('legacy raw API is unchanged', () => {
  it('down()/pressed() keep their immediate / endFrame-scoped semantics', async () => {
    const { Input } = await fresh();
    expect(Input.down('KeyW')).toBe(false);

    keyDown('KeyW');
    expect(Input.down('KeyW')).toBe(true);   // visible immediately, no beginFrame needed
    expect(Input.pressed('KeyW')).toBe(true); // pressed since last endFrame

    Input.endFrame();
    expect(Input.pressed('KeyW')).toBe(false); // cleared at endFrame...
    expect(Input.down('KeyW')).toBe(true);     // ...but "held" survives

    keyUp('KeyW');
    expect(Input.down('KeyW')).toBe(false);
  });

  it('raw pressed() still catches a tap that starts and ends between frames', async () => {
    const { Input } = await fresh();
    keyDown('Space');
    keyUp('Space');
    Input.beginFrame(); // pressedSet is NOT cleared here by design
    expect(Input.pressed('Space')).toBe(true);
    Input.endFrame();
    expect(Input.pressed('Space')).toBe(false);
  });
});

describe('action frame semantics', () => {
  it('isAction only reports after beginFrame samples the held keys', async () => {
    const { Input } = await fresh();
    keyDown('KeyW');
    expect(Input.isAction('forward')).toBe(false); // not sampled yet
    Input.beginFrame();
    expect(Input.isAction('forward')).toBe(true);
    Input.endFrame();
  });

  it('held action stays true across frames until release', async () => {
    const { Input } = await fresh();
    keyDown('KeyS');
    Input.beginFrame();
    expect(Input.isAction('back')).toBe(true);
    Input.endFrame();
    Input.beginFrame(); // still holding S
    expect(Input.isAction('back')).toBe(true);
    Input.endFrame();
    keyUp('KeyS');
    Input.beginFrame();
    expect(Input.isAction('back')).toBe(false);
    Input.endFrame();
  });

  it('wasActionPressed fires on the rising edge exactly once per press', async () => {
    const { Input } = await fresh();

    keyDown('Space');
    Input.beginFrame();
    expect(Input.wasActionPressed('jump')).toBe(true);
    expect(Input.wasActionPressed('jump')).toBe(true); // reads never consume the edge
    Input.endFrame();

    Input.beginFrame(); // still held: no second edge
    expect(Input.wasActionPressed('jump')).toBe(false);
    Input.endFrame();

    keyUp('Space');
    Input.beginFrame();
    expect(Input.wasActionPressed('jump')).toBe(false); // release is not an edge
    Input.endFrame();

    keyDown('Space'); // re-press edges again
    Input.beginFrame();
    expect(Input.wasActionPressed('jump')).toBe(true);
    Input.endFrame();
  });

  it('sub-frame tap-and-release: edge API misses it while raw pressed() catches it', async () => {
    // Documented semantic (not a bug): wasActionPressed samples the keys SET at
    // beginFrame, so a press+release entirely between frames is invisible to
    // actions. Human taps always span frames, and gamepad edges always worked
    // this way; one-shot consumers migrated in 3C accept this equivalence.
    const { Input } = await fresh();
    keyDown('Space');
    keyUp('Space');
    Input.beginFrame();
    expect(Input.pressed('Space')).toBe(true);
    expect(Input.wasActionPressed('jump')).toBe(false);
    Input.endFrame();
  });

  it('blur clears held keyboard+mouse state without phantom rising edges', async () => {
    const { Input } = await fresh();
    keyDown('KeyW');
    mouseDown(2);
    Input.beginFrame();
    expect(Input.isAction('forward')).toBe(true);
    Input.endFrame();

    fire('blur'); // alt-tab away mid-hold
    Input.beginFrame();
    expect(Input.isAction('forward')).toBe(false);
    expect(Input.isAction('aim')).toBe(false);
    Input.endFrame();
    Input.beginFrame();
    // No phantom edge afterwards even though _actionDown went true->false->...
    expect(Input.wasActionPressed('forward')).toBe(false);
    Input.endFrame();
  });

  it('beginFrame/endFrame survive node with no gamepad connected', async () => {
    const { Input } = await fresh();
    expect(() => Input.beginFrame()).not.toThrow();
    expect(Input.isAction('jump')).toBe(false); // pad merge contributes nothing
    Input.endFrame();
  });
});

describe('setBinding / resetBinding / persistence', () => {
  const BINDINGS_KEY = 'ironwild-bindings';

  it('rebind takes effect on the next frame and unbinds the old key', async () => {
    const { Input } = await fresh();
    expect(Input.setBinding('jump', 'KeyM')).toBe(true);

    keyDown('KeyM');
    Input.beginFrame();
    expect(Input.isAction('jump')).toBe(true);
    expect(Input.wasActionPressed('jump')).toBe(true);
    Input.endFrame();
    keyUp('KeyM');

    keyDown('Space'); // old binding must be dead after an override
    Input.beginFrame();
    expect(Input.isAction('jump')).toBe(false);
    Input.endFrame();
  });

  it('persists the override map shape to localStorage', async () => {
    const { Input } = await fresh();
    Input.setBinding('jump', 'KeyM');
    expect(JSON.parse(globalThis.localStorage.getItem(BINDINGS_KEY)))
      .toEqual({ jump: 'KeyM' });
  });

  it('resetBinding restores the default immediately (and unpersists)', async () => {
    const { Input } = await fresh();
    Input.setBinding('jump', 'KeyM');
    Input.resetBinding('jump');
    expect(Input.getBindings().jump).toEqual(['Space']);
    expect(JSON.parse(globalThis.localStorage.getItem(BINDINGS_KEY)))
      .toEqual({}); // override removed from storage too

    keyDown('Space');
    Input.beginFrame();
    expect(Input.isAction('jump')).toBe(true);
    Input.endFrame();
  });

  it('rejects unknown actions and empty codes without touching storage', async () => {
    const { Input } = await fresh();
    expect(Input.setBinding('fly', 'KeyZ')).toBe(false);
    expect(Input.setBinding('jump', '')).toBe(false);
    expect(Input.setBinding('jump', null)).toBe(false);
    expect(globalThis.localStorage.getItem(BINDINGS_KEY)).toBeNull();
  });

  it('duplicate codes across two actions both trigger (no conflict policy - documented behaviour)', async () => {
    // Actual policy: overrides are per-action with no conflict detection, so
    // sharing a code makes both actions fire. Recorded here deliberately so a
    // future conflict policy change shows up as an intentional contract edit.
    const { Input } = await fresh();
    Input.setBinding('jump', 'KeyM');
    Input.setBinding('sprint', 'KeyM');
    keyDown('KeyM');
    Input.beginFrame();
    expect(Input.isAction('jump')).toBe(true);
    expect(Input.isAction('sprint')).toBe(true);
    Input.endFrame();
  });

  it('persisted overrides merge BEFORE the first frame (constructor load)', async () => {
    globalThis.localStorage.setItem(BINDINGS_KEY, JSON.stringify({ jump: 'KeyM' }));
    const { Input } = await fresh(); // no setBinding call this session
    keyDown('KeyM');
    Input.beginFrame(); // very first frame already honours the saved binding
    expect(Input.isAction('jump')).toBe(true);
    Input.endFrame();
  });

  it('corrupt persisted JSON falls back to defaults instead of crashing boot', async () => {
    globalThis.localStorage.setItem(BINDINGS_KEY, '{not json');
    const { Input } = await fresh();
    keyDown('KeyW');
    Input.beginFrame();
    expect(Input.isAction('forward')).toBe(true); // defaults intact
    Input.endFrame();
  });

  it('drops unknown actions and malformed entries from storage safely', async () => {
    globalThis.localStorage.setItem(
      BINDINGS_KEY,
      JSON.stringify({ jump: 'KeyM', fly: 'KeyZ', heal: 42, crouch: '' }),
    );
    const { Input } = await fresh();

    // Valid override kept.
    keyDown('KeyM');
    Input.beginFrame();
    expect(Input.isAction('jump')).toBe(true);
    Input.endFrame();
    keyUp('KeyM');

    // Unknown action name, non-string code, empty string: all dropped.
    expect(Input.getBindings().fly).toBeUndefined();
    keyDown('KeyH');
    Input.beginFrame();
    expect(Input.isAction('heal')).toBe(true); // still default KeyH
    Input.endFrame();
  });
});

describe('hold/toggle modes (aim + crouch latches)', () => {
  it("crouch 'toggle': each tap flips the latch once; level persists between taps", async () => {
    const { Input } = await fresh();

    keyDown('KeyC');
    Input.beginFrame(); // rising edge flips latch ON
    expect(Input.isAction('crouch')).toBe(true);
    expect(Input.wasActionPressed('crouch')).toBe(true);
    Input.endFrame();
    keyUp('KeyC');

    Input.beginFrame(); // released, but the toggle stays engaged
    expect(Input.isAction('crouch')).toBe(true);
    Input.endFrame();
    Input.beginFrame();
    expect(Input.isAction('crouch')).toBe(true);
    Input.endFrame();

    keyDown('KeyC'); // second tap disengages
    Input.beginFrame();
    expect(Input.isAction('crouch')).toBe(false);
    expect(Input.wasActionPressed('crouch')).toBe(true);
    Input.endFrame();
    keyUp('KeyC');
  });

  it("crouch 'hold': level tracks the key with no latch carryover", async () => {
    const { G, Input } = await fresh();
    G.settings.crouchMode = 'hold';

    keyDown('KeyC');
    Input.beginFrame();
    expect(Input.isAction('crouch')).toBe(true);
    Input.endFrame();
    keyUp('KeyC');

    Input.beginFrame();
    expect(Input.isAction('crouch')).toBe(false); // released -> immediately off
    Input.endFrame();
  });

  it("aim 'toggle': Mouse2 tap latches aim on and a second tap releases", async () => {
    const { G, Input } = await fresh();
    G.settings.aimMode = 'toggle';

    mouseDown(2);
    Input.beginFrame();
    expect(Input.isAction('aim')).toBe(true);
    Input.endFrame();
    mouseUp(2);

    Input.beginFrame(); // button long released, aim stays latched
    expect(Input.isAction('aim')).toBe(true);
    Input.endFrame();

    mouseDown(2); // second tap unlatches
    Input.beginFrame();
    expect(Input.isAction('aim')).toBe(false);
    Input.endFrame();
    mouseUp(2);
  });

  it("aim 'hold' (default): Mouse2 acts as a plain level via the pseudo-binding", async () => {
    const { Input } = await fresh();
    mouseDown(2);
    Input.beginFrame();
    expect(Input.isAction('aim')).toBe(true);
    Input.endFrame();
    mouseUp(2);
    Input.beginFrame();
    expect(Input.isAction('aim')).toBe(false);
    Input.endFrame();
  });

  it('Mouse0 feeds the fire action in hold mode alongside keyboard codes', async () => {
    const { Input } = await fresh();
    mouseDown(0);
    keyDown('KeyX'); // unrelated key must not leak into other actions
    Input.beginFrame();
    expect(Input.isAction('fire')).toBe(true);
    expect(Input.isAction('arrowToggle')).toBe(true);
    Input.endFrame();
    mouseUp(0);
    keyUp('KeyX');
  });
});
