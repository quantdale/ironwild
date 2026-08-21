// IRONWILD - verification-campaign regression tests: combat wave contracts.
// Covers ACTUAL implemented behavior (modules read before writing these):
//   - player/spear.js three-phase swing FSM (anticipation -> active ->
//     recovery), one-resolution-per-strike, hitstop emission + weak-point
//     shatter upgrade, cancel rule table (recovery->dodge only).
//   - combat/projectiles.js one-hit-per-arrow guarantee incl. deflection,
//     exactly-one-'impact' emission, and gap-3D terrain classification
//     (soil/water/highland-stone) against the REAL seeded terrain functions.
//   - combat/damage.js hp-tier crossings (once per tier, corpse-suppressed)
//     and componentRule class selection (inequality assertions only).
//
// NOTE: core/input.js is MOCKED here for isolation (headless node has no
// window listeners); the real InputManager regained consumeMouse/consumeWheel
// during this campaign, so bow/camera no longer crash - but the mock keeps
// these tests deterministic without DOM event plumbing.
// Pattern (matches status-burn.test.js): vi.resetModules() + dynamic imports
// per test so every module-level singleton (G, pools, FSM state, bus) is
// fresh; machine doubles satisfy the contract consumed by projectiles/spear
// ({group, hp, maxHp, alive, weakPoints[], bodySpheres[], hit()}) using real
// THREE objects because the collision code calls group.localToWorld() and
// mesh.getWorldPosition().

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

// gamepad.js reads navigator.getGamepads(); node may lack the navigator
// global entirely - provide the empty-pad shape pollGamepads() expects.
if (typeof globalThis.navigator === 'undefined') {
  globalThis.navigator = { getGamepads: () => [] };
}

// Action-layer input stub (isolation, not absence: see NOTE above).
const mockInputState = { pressed: new Set(), held: new Set() };
vi.mock('../../src/core/input.js', () => ({
  Input: {
    wasActionPressed: (a) => mockInputState.pressed.has(a),
    isAction: (a) => mockInputState.held.has(a),
    down: () => false,
    pressed: () => false,
    consumeWheel: () => 0,
    consumeMouse: () => ({ dx: 0, dy: 0 }),
    getLookAxes: () => ({ x: 0, y: 0 }),
    beginFrame() {},
    endFrame() {},
  },
}));

/** Fresh module graph per test: new G, new bus, new FSM/pool state. */
async function loadFresh() {
  vi.resetModules();
  const [state, terrain, proj, dmg, spearM, bowM] = await Promise.all([
    import('../../src/core/state.js'),
    import('../../src/world/terrain.js'),
    import('../../src/combat/projectiles.js'),
    import('../../src/combat/damage.js'),
    import('../../src/player/spear.js'),
    import('../../src/player/bow.js'),
  ]);
  return {
    G: state.G,
    CONFIG: state.CONFIG,
    heightAt: terrain.heightAt,
    biomeAt: terrain.biomeAt,
    spawnArrow: proj.spawnArrow,
    updateProjectiles: proj.updateProjectiles,
    COMPONENT_RULES: dmg.COMPONENT_RULES,
    componentRule: dmg.componentRule,
    checkDamageTiers: dmg.checkDamageTiers,
    createSpear: spearM.createSpear,
    updateSpear: spearM.updateSpear,
    createBow: bowM.createBow,
    updateBow: bowM.updateBow,
    computeAssistAdjust: bowM.computeAssistAdjust,
    getBowFeedback: bowM.getBowFeedback,
  };
}

/** Subscribe a recording array per event type; returns { type: payloads[] }. */
function record(bus, types) {
  const events = {};
  for (const t of types) {
    events[t] = [];
    bus.on(t, (p) => events[t].push(p));
  }
  return events;
}

/**
 * Machine double matching what projectiles.js / spear.js actually consume:
 * group must be a real Object3D (localToWorld), weak-point meshes real
 * Object3Ds (getWorldPosition). hit() records every attempt, applies damage
 * unless hitImpl says otherwise ('false' return = deflect), and dies at 0.
 */
function makeMachine({
  hp = 100,
  maxHp = 100,
  type = 'grazer',
  pos = [0, 0, 0],
  hitImpl = null,
  onHit = null,
  weakPoints = [],
  bodySpheres = [],
} = {}) {
  const group = new THREE.Group();
  group.position.set(pos[0], pos[1], pos[2]);
  const m = {
    type,
    name: `test-${type}`,
    hp,
    maxHp,
    alive: true,
    radius: 2,
    group,
    weakPoints,
    bodySpheres,
    hitCalls: [],
    hit(damage, point, weakPoint) {
      m.hitCalls.push({ damage, point, weakPoint });
      if (onHit) onHit(damage, weakPoint);
      if (hitImpl) return hitImpl(damage, point, weakPoint);
      m.hp -= damage;
      if (m.hp <= 0) m.alive = false;
      return 'hit'; // anything but false counts as landed
    },
  };
  return m;
}

/** Weak point whose mesh sits at a world-space position (child of m.group). */
function makeWeakPoint(group, name, x, y, z, radius = 0.35, multiplier = 2.0) {
  const mesh = new THREE.Object3D();
  mesh.position.set(x, y, z);
  group.add(mesh); // detached scene graph is fine: matrices update lazily
  return { name, mesh, radius, multiplier, broken: false };
}

/** Player double with the fields spear.js/bow.js read or drive. */
function makePlayer(groundY) {
  const group = new THREE.Group();
  const handR = new THREE.Group();
  handR.name = 'handR';
  group.add(handR);
  return {
    group,
    pos: new THREE.Vector3(0, groundY, 0),
    vel: new THREE.Vector3(),
    dead: false,
    swimming: false,
    drawing: false,
    dodging: false,
    dodging_prev: undefined,
    meleeT: 0,
    drawT: 0,
    hp: 100,
    maxHp: 100,
  };
}

/** Step `update(dt)` until `seconds` of simulated time have elapsed. */
function frames(update, dt, seconds) {
  const n = Math.max(1, Math.round(seconds / dt));
  for (let i = 0; i < n; i++) update(dt);
  return n;
}

// ---------------------------------------------------------------------------
// player/spear.js - three-phase swing FSM
// ---------------------------------------------------------------------------
describe('spear phases (createSpear + updateSpear)', () => {
  beforeEach(() => {
    mockInputState.pressed.clear();
    mockInputState.held.clear();
  });

  /** Shared rig: player at meadow centre, one body-only target in range. */
  async function rig({ machine } = {}) {
    const mods = await loadFresh();
    const { G } = mods;
    const gy = mods.heightAt(0, 0);
    G.scene = new THREE.Scene();
    G.started = true;
    G.paused = false;
    G.gameOver = false;
    G.cam.forward.set(0, 0, -1);
    G.player = makePlayer(gy);
    const m = machine || makeMachine({
      pos: [0, gy, 0],
      bodySpheres: [{ localPos: new THREE.Vector3(0, 0.9, -1.8), radius: 0.5 }],
    });
    G.machines = [m];
    mods.createSpear();
    return { ...mods, m, gy };
  }

  /** Press melee for exactly one frame, then release. */
  function tapMelee(updateSpear, dt) {
    mockInputState.pressed.add('melee');
    updateSpear(dt);
    mockInputState.pressed.delete('melee');
  }

  it('anticipation deals no damage; active resolves exactly once; recovery adds none', async () => {
    const { G, updateSpear, m } = await rig();
    const ev = record(G.bus ?? (await import('../../src/core/events.js')).bus, []);
    void ev;

    tapMelee(updateSpear, 0.02); // trigger frame -> anticipation
    expect(G.player.meleeT).toBeGreaterThan(0);
    expect(m.hitCalls).toHaveLength(0); // windup commits, never damages

    // Advance frame-by-frame until the active boundary marker appears.
    const busMod = await import('../../src/core/events.js');
    const anim = record(busMod.bus, ['animEvent', 'meleeSwing', 'hitstop']);
    for (let i = 0; i < 20 && anim.animEvent.length === 0; i++) updateSpear(0.02);
    expect(anim.animEvent).toHaveLength(1);
    expect(anim.animEvent[0].name).toBe('spear_active_begin');
    expect(m.hitCalls).toHaveLength(1); // resolved exactly at the boundary

    // Ride out active + recovery (0.32s): the strikeId guard forbids a second
    // resolution and no further markers appear.
    frames(updateSpear, 0.02, 0.32);
    expect(m.hitCalls).toHaveLength(1);
    expect(anim.meleeSwing).toHaveLength(1);
    expect(anim.meleeSwing[0]).toEqual({ hit: true });
    expect(anim.animEvent).toHaveLength(2);
    expect(anim.animEvent[1].name).toBe('spear_active_end');
    // Recovery drives the pose channel toward 1 without resetting it early.
    expect(G.player.meleeT).toBeGreaterThan(0.62);

    // Swing fully decays back to idle and cleans the channel.
    frames(updateSpear, 0.02, 0.3);
    expect(G.player.meleeT).toBe(0);
    expect(m.hitCalls).toHaveLength(1);
  });

  it('holding the trigger through the whole swing cannot resolve twice', async () => {
    const { updateSpear, m } = await rig();
    const busMod = await import('../../src/core/events.js');
    const anim = record(busMod.bus, ['animEvent']);
    mockInputState.pressed.add('melee');
    frames(updateSpear, 0.02, 0.26); // held across anticipation + active
    mockInputState.pressed.delete('melee');
    frames(updateSpear, 0.02, 0.2);
    expect(m.hitCalls).toHaveLength(1); // cooldown gate + strikeId guard
    expect(anim.animEvent.filter((e) => e.name === 'spear_active_begin')).toHaveLength(1);

    // Cooldown expiry restores one-shot availability (guard is per-strike).
    frames(updateSpear, 0.02, 0.5);
    tapMelee(updateSpear, 0.02);
    frames(updateSpear, 0.02, 0.15);
    expect(m.hitCalls).toHaveLength(2);
  });

  it('emits exactly one numeric hitstop on connect (body hit)', async () => {
    const { updateSpear } = await rig();
    const busMod = await import('../../src/core/events.js');
    const ev = record(busMod.bus, ['hitstop']);
    tapMelee(updateSpear, 0.02);
    frames(updateSpear, 0.02, 0.15);
    expect(ev.hitstop).toHaveLength(1);
    const p = ev.hitstop[0];
    expect(Number.isFinite(p.duration)).toBe(true);
    expect(p.duration).toBeGreaterThan(0);
    expect(Number.isFinite(p.scale)).toBe(true);
    expect(p.scale).toBeGreaterThan(0);
    expect(p.scale).toBeLessThanOrEqual(1);
  });

  it('weak-point shatter upgrades hitstop: longer duration, deeper scale', async () => {
    // Swing 1 connects on plain body -> base payload; swing 2 shatters a weak
    // point (hit() flips broken during resolution) -> upgraded payload. Pure
    // inequalities: the tuning constants stay private to spear.js.
    const mods = await rig();
    const { G, updateSpear } = mods;
    const busMod = await import('../../src/core/events.js');
    const ev = record(busMod.bus, ['hitstop']);

    tapMelee(updateSpear, 0.02);
    frames(updateSpear, 0.02, 0.2);
    expect(ev.hitstop).toHaveLength(1);
    const base = ev.hitstop[0];

    frames(updateSpear, 0.02, 0.7); // ride out cooldown, back to idle
    expect(G.player.meleeT).toBe(0);

    // Second target: same staging spot as swing 1 (inside the reach cone) but
    // with ONLY a weak point in range (no body spheres), and its hit() marks
    // the part shattered under THIS strike. The weak-point mesh must live in
    // the target's group for getWorldPosition().
    const gy = mods.gy;
    const grp = new THREE.Group();
    grp.position.set(0, gy, 0);
    const m2 = makeMachine({
      pos: [0, gy, 0],
      weakPoints: [makeWeakPoint(grp, 'core', 0, 0.9, -1.7)],
      onHit: (dmg, wp) => { if (wp) wp.broken = true; },
    });
    G.machines = [m2];

    tapMelee(updateSpear, 0.02);
    frames(updateSpear, 0.02, 0.2);
    expect(ev.hitstop).toHaveLength(2);
    const up = ev.hitstop[1];
    expect(up.duration).toBeGreaterThan(base.duration);
    expect(up.scale).toBeLessThan(base.scale);
  });

  it('recovery cancels into a dodge; anticipation does not', async () => {
    const { G, updateSpear, m } = await rig();

    // Anticipation + dodge: commitment window holds, strike still resolves.
    tapMelee(updateSpear, 0.02);
    G.player.dodging = true; // rising edge during windup
    frames(updateSpear, 0.02, 0.14);
    expect(m.hitCalls).toHaveLength(1); // NOT cancellable
    frames(updateSpear, 0.02, 0.3);
    G.player.dodging = false;
    updateSpear(0.02); // clear the edge detector
    frames(updateSpear, 0.02, 0.5); // finish swing + most of cooldown

    // Fresh swing, cancel during recovery via dodge rising edge.
    frames(updateSpear, 0.02, 0.4); // cooldown fully elapsed
    tapMelee(updateSpear, 0.02);
    // Windows are 0.12/0.10/0.22 -> recovery starts at 0.22s after trigger.
    // Ride ~0.28s so the FSM is genuinely into recovery before the edge.
    frames(updateSpear, 0.02, 0.26); // through active into recovery
    expect(G.player.meleeT).toBeGreaterThan(0.62);
    G.player.dodging = true;
    updateSpear(0.02);
    expect(G.player.meleeT).toBe(0); // pose channel dropped
    frames(updateSpear, 0.02, 0.06);
    expect(G.player.meleeT).toBe(0); // stays cancelled while dodging
    expect(m.hitCalls).toHaveLength(2); // the already-resolved strike stays resolved
  });

  it('death during anticipation hard-resets: no damage, clean channel', async () => {
    const { G, updateSpear, m } = await rig();
    const busMod = await import('../../src/core/events.js');
    const ev = record(busMod.bus, ['hitstop']);
    tapMelee(updateSpear, 0.02);
    G.player.dead = true;
    frames(updateSpear, 0.02, 0.3); // well past the anticipation window
    expect(m.hitCalls).toHaveLength(0);
    expect(ev.hitstop).toHaveLength(0);
    expect(G.player.meleeT).toBe(0); // corpse channel cleaned, not frozen midwindup
  });

  it('idle frames are inert: no press means no state change', async () => {
    const { G, updateSpear, m } = await rig();
    frames(updateSpear, 0.02, 0.2);
    expect(m.hitCalls).toHaveLength(0);
    expect(G.player.meleeT).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// player/bow.js - draw/release FSM + pure assist/feedback functions
// ---------------------------------------------------------------------------
describe('bow FSM (createBow + updateBow)', () => {
  /** Capture the window listeners createBow installs so tests can fire them. */
  function captureWindowListeners() {
    const handlers = {};
    const orig = globalThis.window.addEventListener;
    globalThis.window.addEventListener = (type, fn) => {
      (handlers[type] = handlers[type] || []).push(fn);
    };
    return { handlers, restore: () => { globalThis.window.addEventListener = orig; } };
  }

  async function rig() {
    const mods = await loadFresh();
    const { G } = mods;
    G.scene = new THREE.Scene();
    G.started = true;
    G.paused = false;
    G.gameOver = false;
    G.elapsed = 1.23; // sway/settle clocks get a fixed deterministic tick
    G.inventory.arrows = 5;
    G.inventory.fireArrows = 0;
    G.arrowType = 'standard';
    G.skills.steadyAim = 0;
    G.settings.aimAssist = 0;
    G.camera = null; // fire() falls back to cam.aimOrigin (headless path)
    G.cam.aiming = true;
    G.cam.aimOrigin.set(0, 2, 0);
    G.cam.aimDir.set(0, 0, -1);
    G.cam.right.set(1, 0, 0);
    G.cam.forward.set(0, 0, -1);
    G.player = makePlayer(mods.heightAt(0, 0));
    G.machines = [];
    const cap = captureWindowListeners();
    mods.createBow();
    cap.restore();
    return { ...mods, handlers: cap.handlers };
  }

  const mouse = (handlers, type, button) => {
    for (const fn of handlers[type] || []) fn({ button });
  };

  it('idle -> drawing -> full -> release -> idle with one arrowFired', async () => {
    const { G, updateBow, handlers } = await rig();
    const busMod = await import('../../src/core/events.js');
    const ev = record(busMod.bus, ['bowState', 'arrowFired']);

    mouse(handlers, 'mousedown', 0);
    updateBow(0.016);
    expect(ev.bowState.map((p) => p.state)).toEqual(['drawing']);

    frames(updateBow, 0.1, 0.9); // >= CONFIG.drawTimeFull (0.85, no steadyAim)
    expect(ev.bowState.map((p) => p.state)).toEqual(['drawing', 'full']);
    expect(ev.bowState[1].power).toBe(1);

    mouse(handlers, 'mouseup', 0);
    updateBow(0.016);
    expect(ev.bowState.map((p) => p.state)).toEqual(['drawing', 'full', 'release']);
    expect(ev.arrowFired).toHaveLength(1);
    expect(G.inventory.arrows).toBe(4);
    expect(G.arrows.filter((a) => a.alive)).toHaveLength(1); // pooled record flying

    frames(updateBow, 0.05, 0.2); // release lag decays back to idle
    expect(ev.bowState.map((p) => p.state)).toEqual(['drawing', 'full', 'release', 'idle']);
  });

  it('release from idle is a no-op; aim drop without draw touches nothing', async () => {
    const { G, updateBow, handlers } = await rig();
    const busMod = await import('../../src/core/events.js');
    const ev = record(busMod.bus, ['bowState', 'arrowFired']);

    mouse(handlers, 'mouseup', 0); // string already home
    updateBow(0.016);
    mouse(handlers, 'mousedown', 0);
    G.cam.aiming = false; // not aiming -> wantDraw false even with LMB held
    updateBow(0.016);
    mouse(handlers, 'mouseup', 0);
    updateBow(0.016);

    expect(ev.bowState).toHaveLength(0);
    expect(ev.arrowFired).toHaveLength(0);
    expect(G.inventory.arrows).toBe(5);
  });

  it('dry draw with an empty quiver never enters drawing', async () => {
    const { G, updateBow, handlers } = await rig();
    const busMod = await import('../../src/core/events.js');
    const ev = record(busMod.bus, ['bowState']);
    G.inventory.arrows = 0;
    mouse(handlers, 'mousedown', 0);
    frames(updateBow, 0.016, 0.1);
    expect(ev.bowState).toHaveLength(0);
  });
});

describe('bow aim assist + HUD feedback (pure parts)', () => {
  async function rigWithTarget(offX) {
    const mods = await loadFresh();
    const { G } = mods;
    G.settings.aimAssist = 0;
    G.cam.aimOrigin.set(0, 2, 0);
    G.cam.aimDir.set(0, 0, -1);
    const m = makeMachine({ pos: [0, 0, 0] }); // group at world origin
    const wp = makeWeakPoint(m.group, 'core', offX, 2, -30, 0.5);
    m.weakPoints.push(wp);
    G.machines = [m];
    return { ...mods, m, wp };
  }

  it('aimAssist = 0 leaves the direction untouched (new vector, same parts)', async () => {
    const { computeAssistAdjust } = await rigWithTarget(1.048);
    const dir = new THREE.Vector3(0, 0, -1);
    const out = computeAssistAdjust(new THREE.Vector3(0, 2, 0), dir);
    expect(out).not.toBe(dir); // clone contract: inputs never mutated
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    expect(out.z).toBe(-1);
  });

  it('aimAssist > 0 bends the line toward a staged weak point inside the cone', async () => {
    const { computeAssistAdjust } = await rigWithTarget(1.048); // ~2 deg off-axis
    const origin = new THREE.Vector3(0, 2, 0);
    const dir = new THREE.Vector3(0, 0, -1);
    G_setAimAssist(1);
    function G_setAimAssist(_v) { /* hoisted below */ }
    const { G } = await import('../../src/core/state.js');
    G.settings.aimAssist = 1;
    const out = computeAssistAdjust(origin, dir);
    const toTarget = new THREE.Vector3(1.048, 0, -30).normalize();
    expect(out.dot(toTarget)).toBeGreaterThan(dir.dot(toTarget)); // bent closer
    expect(Math.abs(out.length() - 1)).toBeLessThan(1e-6); // still unit
    expect(dir.x).toBe(0); // input untouched
  });

  it('weak points outside the 4-degree assist cone are ignored even at max', async () => {
    const { computeAssistAdjust } = await rigWithTarget(5.29); // ~10 deg off-axis
    const { G } = await import('../../src/core/state.js');
    G.settings.aimAssist = 1;
    const dir = new THREE.Vector3(0, 0, -1);
    const out = computeAssistAdjust(new THREE.Vector3(0, 2, 0), dir);
    expect(out.x).toBe(0);
    expect(out.z).toBe(-1); // identical direction: nothing in range to bend to
  });

  it('getBowFeedback reports targetAligned independently of the setting and memoizes per frame', async () => {
    const { G, getBowFeedback } = await rigWithTarget(1.048);
    const a = getBowFeedback();
    expect(a.targetAligned).toBe(true); // cone occupancy != assist strength
    expect(getBowFeedback()).toBe(a); // same gameplay frame -> cached object
    G.elapsed += 0.016;
    const b = getBowFeedback();
    expect(b).not.toBe(a);
    expect(b.targetAligned).toBe(true);
    expect(b.state).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// combat/projectiles.js - one-hit guarantee + impact classification
// ---------------------------------------------------------------------------
describe('projectiles one-hit + impact contract', () => {
  /**
   * Rig with a scene, a grounded firing perch and an optional target placed
   * relative to local ground height so the REAL heightAt() can't interfere.
   */
  async function rig() {
    const mods = await loadFresh();
    const { G } = mods;
    const busMod = await import('../../src/core/events.js');
    const ev = record(busMod.bus, ['impact', 'machineHit', 'hitMarker', 'camShake', 'machineDamaged']);
    const gy = mods.heightAt(0, 0);
    G.scene = new THREE.Scene();
    G.machines = [];
    return { ...mods, ev, gy };
  }

  function fireAt(mods, targetMachine) {
    mods.G.machines = targetMachine ? [targetMachine] : [];
    return mods.spawnArrow({
      origin: new THREE.Vector3(0, mods.gy + 1.5, 0),
      dir: new THREE.Vector3(0, 0, -1),
      speed: 40,
      damage: 22,
    });
  }

  it('arrow hitting a machine double resolves exactly one hit and one impact', async () => {
    const mods = await rig();
    const { G, ev } = mods;
    const m = makeMachine({
      pos: [0, mods.gy, 0],
      bodySpheres: [{ localPos: new THREE.Vector3(0, 1.5, -2), radius: 0.5 }],
    });
    const arrow = fireAt(mods, m);
    expect(arrow).not.toBeNull();
    mods.updateProjectiles(0.05); // first frame covers the 2u gap (3 substeps)

    expect(m.hitCalls).toHaveLength(1);
    expect(ev.impact).toHaveLength(1);
    expect(ev.impact[0].material).toBe('metal');
    expect(Number.isFinite(ev.impact[0].strength)).toBe(true);
    expect(ev.machineHit).toHaveLength(1);
    expect(arrow.alive).toBe(false); // deactivated post-resolution

    // Every later frame is inert: no second hit(), no second 'impact'.
    frames(mods.updateProjectiles, 0.05, 0.5);
    expect(m.hitCalls).toHaveLength(1);
    expect(ev.impact).toHaveLength(1);
    void G;
  });

  it('deflected hit (hit() returns false): one metal ping, zero damage events', async () => {
    const mods = await rig();
    const { ev } = mods;
    const m = makeMachine({
      pos: [0, mods.gy, 0],
      hitImpl: () => false, // bulwark-style deflect
      bodySpheres: [{ localPos: new THREE.Vector3(0, 1.5, -2), radius: 0.5 }],
    });
    fireAt(mods, m);
    mods.updateProjectiles(0.05);
    expect(ev.impact).toHaveLength(1); // deflection still owes its material ping
    expect(ev.impact[0].material).toBe('metal');
    expect(ev.machineHit).toHaveLength(0);
    expect(ev.hitMarker).toHaveLength(0);
    expect(ev.camShake).toHaveLength(0);
    frames(mods.updateProjectiles, 0.05, 0.3);
    expect(ev.impact).toHaveLength(1);
  });

  it('killing shot: machine death suppresses tier events but the impact fired once', async () => {
    const mods = await rig();
    const { ev } = mods;
    const m = makeMachine({
      hp: 10,
      pos: [0, mods.gy, 0],
      bodySpheres: [{ localPos: new THREE.Vector3(0, 1.5, -2), radius: 0.5 }],
    });
    fireAt(mods, m);
    mods.updateProjectiles(0.05);
    expect(m.alive).toBe(false);
    expect(ev.impact).toHaveLength(1);
    expect(ev.machineDamaged).toHaveLength(0); // corpses own no tier crossings
    frames(mods.updateProjectiles, 0.05, 0.3);
    expect(ev.impact).toHaveLength(1);
  });

  it('lake landing classifies water with the splash clamped to the surface', async () => {
    const mods = await rig();
    const { G, ev } = mods;
    // Lake basin centre (documented dip below CONFIG.waterLevel in terrain.js).
    const lx = 0;
    const lz = -60;
    const lgy = mods.heightAt(lx, lz);
    expect(lgy).toBeLessThan(mods.CONFIG.waterLevel); // precondition: real lakebed
    mods.spawnArrow({
      origin: new THREE.Vector3(lx, lgy + 14, lz),
      dir: new THREE.Vector3(0, -1, 0),
      speed: 28,
      damage: 22,
    });
    for (let i = 0; i < 60 && !G.arrows.some((a) => a.stuckT >= 0); i++) {
      mods.updateProjectiles(0.05);
    }
    expect(ev.impact).toHaveLength(1);
    expect(ev.impact[0].material).toBe('water');
    expect(ev.impact[0].pos.y).toBe(mods.CONFIG.waterLevel);
    frames(mods.updateProjectiles, 0.05, 0.2); // stuck arrow stays silent
    expect(ev.impact).toHaveLength(1);
  });

  it('meadow landing classifies soil; walk-over collect adds no impact', async () => {
    const mods = await rig();
    const { G, ev } = mods;
    const px = 12;
    const pz = 12;
    const pgy = mods.heightAt(px, pz);
    expect(pgy).toBeGreaterThan(mods.CONFIG.waterLevel); // dry land precondition
    expect(['meadow', 'forest']).toContain(mods.biomeAt(px, pz));
    mods.spawnArrow({
      origin: new THREE.Vector3(px, pgy + 12, pz),
      dir: new THREE.Vector3(0, -1, 0),
      speed: 28,
      damage: 22,
    });
    for (let i = 0; i < 60 && !G.arrows.some((a) => a.stuckT >= 0); i++) {
      mods.updateProjectiles(0.05);
    }
    expect(ev.impact).toHaveLength(1);
    expect(ev.impact[0].material).toBe('soil');

    // Silent auto-collect: refunds the arrow without emitting anything.
    const stuck = G.arrows.find((a) => a.stuckT >= 0);
    G.inventory.arrows = 10;
    G.player = makePlayer(pgy);
    G.player.pos.set(stuck.pos.x + 0.5, stuck.pos.y, stuck.pos.z);
    mods.updateProjectiles(0.016);
    expect(G.inventory.arrows).toBe(11);
    expect(ev.impact).toHaveLength(1);
  });

  it('highland-biome landings classify stone (gap 3D decision tree)', async () => {
    const mods = await rig();
    const { G, ev } = mods;
    // Deterministic candidate scan: pick the first spot the SEEDED biome field
    // verdicts as highland (the game has one fixed terrain, so this either
    // always finds a spot or the terrain itself changed).
    const candidates = [
      [150, 250], [-150, 250], [100, 250], [-100, 250],
      [200, 200], [-200, 200], [220, 120], [-220, 120], [0, 260],
    ];
    let spot = null;
    for (const [cx, cz] of candidates) {
      if (mods.biomeAt(cx, cz) === 'highland' && mods.heightAt(cx, cz) > mods.CONFIG.waterLevel + 1.1) {
        spot = [cx, cz];
        break;
      }
    }
    expect(spot, 'seeded terrain lost its highland ring - update candidates').not.toBeNull();
    const [sx, sz] = spot;
    const sgy = mods.heightAt(sx, sz);
    mods.spawnArrow({
      origin: new THREE.Vector3(sx, sgy + 12, sz),
      dir: new THREE.Vector3(0, -1, 0),
      speed: 28,
      damage: 22,
    });
    for (let i = 0; i < 60 && !G.arrows.some((a) => a.stuckT >= 0); i++) {
      mods.updateProjectiles(0.05);
    }
    expect(ev.impact).toHaveLength(1);
    expect(ev.impact[0].material).toBe('stone');
  });

  it('out-of-bounds flight ends silently: no impact event is owed', async () => {
    const mods = await rig();
    const { G, ev } = mods;
    mods.spawnArrow({
      origin: new THREE.Vector3(0, mods.heightAt(0, 0) + 2, 0),
      dir: new THREE.Vector3(0, 0.08, -1),
      speed: 90,
      damage: 22,
    });
    // A ballistic flat shot strikes the heightfield long before the world
    // bound, so stage the silent-exit contract directly: park the live arrow
    // just inside BOUND_SQ at high altitude for a few frames (past any
    // spawn-frame collision), then release — at ~90 u/s it crosses the bound
    // mid-air within one step and must deactivate with no impact emitted.
    const a0 = G.arrows.find((x) => x.alive); // pool slots: pick the LIVE arrow
    a0.vel.set(0, -5, -90);
    let pinned = 0;
    for (let i = 0; i < 400 && G.arrows.some((x) => x.alive); i++) {
      if (a0.alive && pinned++ < 3) a0.pos.set(0, 250, -292);
      mods.updateProjectiles(0.05);
    }
    expect(G.arrows.some((a) => a.alive)).toBe(false);
    expect(ev.impact).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// combat/damage.js - hp tiers + component rules
// ---------------------------------------------------------------------------
describe('checkDamageTiers (hp threshold crossings)', () => {
  async function rig() {
    const mods = await loadFresh();
    const busMod = await import('../../src/core/events.js');
    const ev = record(busMod.bus, ['machineDamaged']);
    return { ...mods, ev };
  }

  it('tier1 fires crossing <=50%, tier2 <=25%, each exactly once', async () => {
    const { checkDamageTiers, ev } = await rig();
    const m = makeMachine({ hp: 60 });
    checkDamageTiers(m); // first sighting baselines at maxHp: 60 is above 50
    expect(ev.machineDamaged).toHaveLength(0);

    m.hp = 49;
    checkDamageTiers(m);
    expect(ev.machineDamaged).toHaveLength(1);
    expect(ev.machineDamaged[0].tier).toBe(1);

    m.hp = 30; // between the lines: silent
    checkDamageTiers(m);
    expect(ev.machineDamaged).toHaveLength(1);

    m.hp = 24;
    checkDamageTiers(m);
    expect(ev.machineDamaged).toHaveLength(2);
    expect(ev.machineDamaged[1].tier).toBe(2);

    m.hp = 5;
    checkDamageTiers(m);
    expect(ev.machineDamaged).toHaveLength(2); // no re-fire below the lines
  });

  it('a first sighting below BOTH lines emits each crossed tier once, in order', async () => {
    const { checkDamageTiers, ev } = await rig();
    const m = makeMachine({ hp: 20 }); // unseen machines baseline at maxHp,
    checkDamageTiers(m);               // so 20/100 crosses 50% AND 25% here
    expect(ev.machineDamaged.map((e) => e.tier)).toEqual([1, 2]);
    m.hp = 15;
    checkDamageTiers(m);
    expect(ev.machineDamaged).toHaveLength(2); // no refires below the lines
  });

  it('crossings are suppressed once the machine is dead', async () => {
    const { checkDamageTiers, ev } = await rig();
    const m = makeMachine({ hp: 30 });
    m.hp = 0;
    m.alive = false;
    checkDamageTiers(m);
    expect(ev.machineDamaged).toHaveLength(0);
  });

  it('degenerate inputs are guarded without throwing', async () => {
    const { checkDamageTiers, ev } = await rig();
    expect(() => checkDamageTiers(null)).not.toThrow();
    expect(() => checkDamageTiers({ hp: NaN, maxHp: 100, alive: true })).not.toThrow();
    expect(() => checkDamageTiers({ hp: 10, maxHp: 0, alive: true })).not.toThrow();
    expect(ev.machineDamaged).toHaveLength(0);
  });
});

describe('componentRule class selection', () => {
  it('class multipliers order armor < body < weakpoint (table inequality)', async () => {
    const { COMPONENT_RULES } = await loadFresh();
    expect(COMPONENT_RULES.armor.multiplier)
      .toBeLessThan(COMPONENT_RULES.body.multiplier);
    expect(COMPONENT_RULES.body.multiplier)
      .toBeLessThan(COMPONENT_RULES.weakpoint.multiplier);
  });

  it('live weak point -> weakpoint; shattered part falls back off weakpoint', async () => {
    const { componentRule } = await loadFresh();
    const m = makeMachine({});
    const wp = { name: 'core', broken: false };
    expect(componentRule(m, wp, null).key).toBe('weakpoint');
    expect(componentRule(m, { ...wp, broken: true }, null).key).toBe('body');
    expect(componentRule(null, null, null).key).toBe('body'); // defensive fallback
  });

  it('bulwark front-facing contact reads armor; rear contact stays body', async () => {
    const { componentRule, COMPONENT_RULES } = await loadFresh();
    const m = makeMachine({ type: 'bulwark', pos: [0, 0, 0] });
    m.group.rotation.y = 0; // facing cone: (sin(ry)*dx + cos(ry)*dz)/len > 0.5
    const front = componentRule(m, null, new THREE.Vector3(0, 0, 5));
    const rear = componentRule(m, null, new THREE.Vector3(0, 0, -5));
    expect(front.key).toBe('armor');
    expect(rear.key).toBe('body');
    expect(front.multiplier).toBeLessThan(COMPONENT_RULES.weakpoint.multiplier);
  });
});
