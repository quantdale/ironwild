// IRONWILD - unit tests for src/vfx/vfx.js (pooled particle engine) and
// src/vfx/library.js (named effects + bus wiring).
//
// Runs scene-less against a real three.js: THREE.Points/InstancedMesh/Sprite
// construct fine without WebGL (nothing renders), matching damage-fx.test.js.
// Canvas-dependent texture building goes through the shared recording-canvas
// stub because the vitest setup provides no createElement. Module state is
// reset per test via vi.resetModules() + dynamic imports.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { installCanvasStub } from './helpers/canvas2d.js';

let restoreCanvas = () => {};

async function loadFresh() {
  vi.resetModules();
  const mods = await Promise.all([
    import('../../src/core/state.js'),
    import('../../src/core/events.js'),
    import('../../src/vfx/vfx.js'),
    import('../../src/vfx/library.js'),
  ]);
  return { G: mods[0].G, bus: mods[1].bus, vfx: mods[2], lib: mods[3] };
}

/** Fresh engine bound to a fresh scene. LOD anchor stays null (camera/player
 *  unset) so distance culling passes everything - counts are then driven only
 *  by opts x quality multiplier, which keeps every count assertion exact. */
async function booted() {
  const mods = await loadFresh();
  mods.G.scene = new THREE.Scene();
  expect(mods.vfx.initVfxEngine()).toBe(true);
  return mods;
}

const P = () => new THREE.Vector3(2, 5, -3);

/** Advance in 0.1s slices (inside updateVfx's own clamp) until `sec` elapsed. */
function settle(updateVfx, sec) {
  let t = 0;
  while (t < sec - 1e-9) { updateVfx(0.1); t += 0.1; }
}

beforeEach(() => {
  vi.resetModules();
  restoreCanvas = installCanvasStub();
  delete globalThis.window.__IW_VFX_STATS;
});

afterEach(() => restoreCanvas());

describe('engine init', () => {
  it('builds once (idempotent) and reports the spec budgets', async () => {
    const { G, vfx } = await loadFresh();
    G.scene = new THREE.Scene();
    expect(vfx.initVfxEngine()).toBe(true);
    const children = G.scene.children.length;
    expect(children).toBeGreaterThan(0);
    expect(vfx.initVfxEngine()).toBe(true); // second call: no rebuild
    expect(G.scene.children).toHaveLength(children);

    // Campaign-spec constants: class caps sum to 880, global budget 900.
    const s = vfx.getVfxStats();
    expect(s.budget).toBe(900);
    expect(s.sparks.cap).toBe(512);
    expect(s.debris.cap).toBe(256);
    expect(s.smoke.cap).toBe(64);
    expect(s.flash.cap).toBe(32);
    expect(s.ring.cap).toBe(16);
    const capSum = s.sparks.cap + s.debris.cap + s.smoke.cap + s.flash.cap + s.ring.cap;
    expect(capSum).toBe(880);
    expect(capSum).toBeLessThanOrEqual(s.budget);
    expect(s.active).toBe(0);
  });

  it('without a scene init fails softly and callers lazily retry', async () => {
    const { G, vfx } = await loadFresh();
    G.scene = null;
    expect(() => vfx.initVfxEngine()).not.toThrow();
    expect(vfx.initVfxEngine()).toBe(false);
    expect(vfx.spawnEffect('spark', { pos: P() })).toBe(0); // still dead: no throw
  });
});

describe('spawn + slot accounting', () => {
  it('spawns through acquireSlot and counts in stats (lazy boot included)', async () => {
    const { G, vfx } = await loadFresh();
    G.scene = new THREE.Scene();
    // No explicit initVfxEngine: spawnEffect lazy-boots the engine itself.
    expect(vfx.spawnEffect('spark', { pos: P() })).toBe(1);
    const s = vfx.getVfxStats();
    expect(s.active).toBe(1);
    expect(s.sparks.active).toBe(1);
  });

  it('rejects unknown kinds, missing positions and non-finite counts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { vfx } = await booted();
      expect(vfx.spawnEffect('plasma', { pos: P() })).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(vfx.spawnEffect('spark', {})).toBe(0);            // no pos
      expect(vfx.spawnEffect('spark', { pos: {} })).toBe(0);   // pos without x
      expect(vfx.spawnEffect('spark', { pos: P(), count: 0 })).toBe(0);
      expect(vfx.getVfxStats().active).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('full spark pool: lower priority cannot punch down, higher priority steals', async () => {
    const { vfx } = await booted();
    // Flood every spark slot with priority-5 units.
    expect(vfx.spawnEffect('spark', { pos: P(), count: 512, priority: 5 })).toBe(512);
    expect(vfx.getVfxStats().sparks.active).toBe(512);

    // Priority-1 spawn must refuse to evict ANY priority-5 occupant.
    expect(vfx.spawnEffect('spark', { pos: P(), count: 5, priority: 1 })).toBe(0);
    expect(vfx.getVfxStats().sparks.active).toBe(512);

    // Priority-9 spawn steals the lowest-priority most-progressed slots; the
    // pool stays pinned at cap and total active is conserved.
    expect(vfx.spawnEffect('spark', { pos: P(), count: 2, priority: 9 })).toBe(2);
    const s = vfx.getVfxStats();
    expect(s.sparks.active).toBe(512);
    expect(s.active).toBe(512);
    // NOTE: "oldest replaced" exactly is not observable through the public API
    // because spawn jitters ttl +-20% per slot; the priority dominance checks
    // below pin the policy instead.
  });

  it('steal targets the LOWEST-priority occupant regardless of age jitter', async () => {
    const { vfx } = await booted();
    // Two low-stakes units, then a high-priority flood fills the rest.
    expect(vfx.spawnEffect('spark', { pos: P(), count: 1, priority: 0.2 })).toBe(1);
    expect(vfx.spawnEffect('spark', { pos: P(), count: 1, priority: 0.2 })).toBe(1);
    expect(vfx.spawnEffect('spark', { pos: P(), count: 510, priority: 5 })).toBe(510);

    // Incoming 0.5 beats the pri-0.2 victims: pri*4 dominates the age term
    // (age ratio <= 1), so victim choice cannot be flipped by ttl jitter.
    expect(vfx.spawnEffect('spark', { pos: P(), count: 2, priority: 0.5 })).toBe(2);

    // Now the weakest occupants are pri-0.5: incoming 0.3 must refuse.
    expect(vfx.spawnEffect('spark', { pos: P(), count: 1, priority: 0.3 })).toBe(0);
    expect(vfx.getVfxStats().sparks.active).toBe(512);
  });

  it('rings: always exactly one unit, visible while alive, hidden after expiry', async () => {
    const { G, vfx } = await booted();
    expect(vfx.spawnEffect('ring', { pos: P() })).toBe(1);
    vfx.updateVfx(0.05);
    const meshes = G.scene.children.filter((c) => c.isMesh && !c.isInstancedMesh);
    expect(meshes.some((m) => m.visible)).toBe(true);
    settle(vfx.updateVfx, 0.8); // ring ttl 0.55 * 1.2 jitter ceiling = 0.66
    const s = vfx.getVfxStats();
    expect(s.ring.active).toBe(0);
    expect(G.scene.children.filter((c) => c.isMesh && !c.isInstancedMesh).every((m) => !m.visible))
      .toBe(true);
  });
});

describe('expiry + parking', () => {
  it('expired debris/smoke free their slots; debris instances end zero-scaled', async () => {
    const { G, vfx } = await booted();
    expect(vfx.spawnEffect('debris', { pos: P(), count: 4 })).toBe(4);
    expect(vfx.spawnEffect('smoke', { pos: P(), count: 3 })).toBe(3);
    expect(vfx.getVfxStats().active).toBe(7);

    settle(vfx.updateVfx, 3.2); // debris ttl <= 1.08, smoke ttl <= 1.56
    expect(vfx.getVfxStats().active).toBe(0);

    // GPU-resident debris must not hang mid-air: EVERY instance matrix ends
    // zero-scaled (releaseSlot branch), not just freshly-built ones.
    const inst = G.scene.children.find((c) => c.isInstancedMesh);
    expect(inst).toBeDefined();
    const m = new THREE.Matrix4();
    for (let i = 0; i < 256; i++) {
      inst.getMatrixAt(i, m);
      const e = m.elements;
      expect(e[0]).toBe(0); // scale X column collapsed
      expect(e[5]).toBe(0); // scale Y
      expect(e[10]).toBe(0); // scale Z
    }
    // Billboards/rings are covered by visibility instead.
    expect(G.scene.children.filter((c) => c.isSprite).every((c) => !c.visible)).toBe(true);
  });

  it('absurd dt frames are clamped (no NaN teleport), effects still expire', async () => {
    const { G, vfx } = await booted();
    vfx.spawnEffect('spark', { pos: P(), count: 8 });
    vfx.spawnEffect('debris', { pos: P(), count: 4 });
    expect(() => vfx.updateVfx(1e6)).not.toThrow(); // single giant frame
    settle(vfx.updateVfx, 3.2);
    expect(vfx.getVfxStats().active).toBe(0);
    const pts = G.scene.children.find((c) => c.isPoints);
    const arr = pts.geometry.attributes.position.array;
    for (let i = 0; i < 30; i++) expect(Number.isFinite(arr[i])).toBe(true);
  });
});

describe('quality multiplier', () => {
  it('settingsChanged drives emission up/down repeatedly without losing the handler', async () => {
    const { G, bus, vfx } = await booted();
    const identical = { pos: P(), count: 100 };

    expect(vfx.spawnEffect('spark', { ...identical })).toBe(100); // high: 1.0x
    settle(vfx.updateVfx, 1.0); // drain (spark ttl <= 0.54)

    // Integrator order mirrors ui/settings.js: mutate G.settings FIRST, then
    // emit - the handler only refreshes FROM G.settings.
    G.settings.quality = 'low';
    bus.emit('settingsChanged', { key: 'quality', value: 'low' });
    expect(vfx.getVfxStats().qualityMul).toBeCloseTo(0.45, 5);
    expect(vfx.spawnEffect('spark', { ...identical })).toBe(45); // round(100*.45)
    settle(vfx.updateVfx, 1.0);

    G.settings.quality = 'high';
    bus.emit('settingsChanged', { key: 'quality', value: 'high' });
    expect(vfx.spawnEffect('spark', { ...identical })).toBe(100); // handler alive

    // Unrelated settings keys must not touch the multiplier.
    bus.emit('settingsChanged', { key: 'master', value: 0.1 });
    expect(vfx.getVfxStats().qualityMul).toBeCloseTo(1.0, 5);
  });
});

describe('disposeVfx', () => {
  it('is idempotent, zeroes stats, and allows clean re-init', async () => {
    const { G, vfx } = await loadFresh();
    G.scene = new THREE.Scene();
    vfx.initVfxEngine();
    vfx.spawnEffect('spark', { pos: P(), count: 10 });
    vfx.spawnEffect('smoke', { pos: P(), count: 5 });
    expect(vfx.getVfxStats().active).toBe(15);

    vfx.disposeVfx();
    let s = vfx.getVfxStats();
    expect(s.active).toBe(0);
    expect(s.budget).toBe(900); // getter stays valid for the perf HUD
    expect(() => vfx.disposeVfx()).not.toThrow(); // second call: no-op
    expect(vfx.getVfxStats().active).toBe(0);

    // Re-init rebuilds GPU objects around the same pools and works again.
    G.scene = new THREE.Scene();
    expect(vfx.initVfxEngine()).toBe(true);
    expect(vfx.spawnEffect('spark', { pos: P(), count: 3 })).toBe(3);
  });
});

describe('library named fx', () => {
  it('minimal payloads spawn; malformed ones are rejected silently', async () => {
    const { lib, vfx } = await booted();
    const ok = [
      () => lib.fxArrowImpact('wood', { pos: new THREE.Vector3(1, 2, 3) }),
      () => lib.fxArrowImpact(undefined, { pos: P() }),          // generic fallback
      () => lib.fxWeakPointHit(P()),
      () => lib.fxWeakPointBreak(P()),
      () => lib.fxArmorBreak(P()),
      () => lib.fxFluidLeak(P()),
      () => lib.fxBurnTick(P()),
      () => lib.fxMovementDust(P(), 1),
      () => lib.fxDeathExplosion(P(), 1),
    ];
    for (const fn of ok) expect(fn).not.toThrow();
    expect(vfx.getVfxStats().active).toBeGreaterThan(0);

    const before = vfx.getVfxStats().active;
    const bad = [null, undefined, {}, { pos: 'nope' }, { pos: { y: 1 } }];
    for (const p of bad) {
      expect(() => lib.fxArrowImpact('metal', p)).not.toThrow();
      expect(() => lib.fxWeakPointHit(p)).not.toThrow();
      expect(() => lib.fxDeathExplosion(p)).not.toThrow();
    }
    expect(lib.fxMovementDust(P(), 0)).toBeUndefined(); // below strength floor
    expect(vfx.getVfxStats().active).toBe(before);       // nothing spawned
  });

  it("'impact' bus event routes materials with a generic fallback", async () => {
    const { bus, vfx, lib } = await booted();
    lib.createVfx();

    // Known material: classified burst (12*s sparks + one flash pop).
    bus.emit('impact', { pos: P(), material: 'metal', strength: 1 });
    const afterMetal = vfx.getVfxStats();
    expect(afterMetal.sparks.active).toBe(12);
    expect(afterMetal.flash.active).toBe(1);

    // Unknown/absent material still gets feedback via the generic fallback.
    bus.emit('impact', { pos: P() });
    const s = vfx.getVfxStats();
    expect(s.sparks.active).toBe(afterMetal.sparks.active + 8);

    // Malformed payloads never throw through the bus isolation layer.
    expect(() => bus.emit('impact', null)).not.toThrow();
    expect(() => bus.emit('impact', {})).not.toThrow();
  });

  it('machineDamaged attaches a plume; machineDied replaces it (auto-detach)', async () => {
    const { bus, vfx, lib } = await booted();
    lib.createVfx();
    const machine = { group: { position: P() }, alive: true };

    bus.emit('machineDamaged', { machine, tier: 1 });
    settle(lib.updateVfx, 0.5); // LIBRARY wrapper: ticks plumes, not just pools
    expect(vfx.getVfxStats().smoke.active).toBeGreaterThan(0); // plume puffing

    bus.emit('machineDied', { machine, pos: P() }); // death FX + detach plume
    settle(lib.updateVfx, 3.2); // death smoke ttl <= 2.04, plume stopped
    expect(vfx.getVfxStats().smoke.active).toBe(0);
  });

  it('plume handle detaches and re-attaching revives; post-hitch burst is clamped', async () => {
    const { lib, vfx } = await booted();
    const machine = { group: { position: P() }, alive: true };
    const handle = lib.fxAttachPlume(machine, 'steam');
    expect(handle && typeof handle.detach).toBe('function');

    lib.updateVfx(0.5); // library wrapper ticks the plume emitters
    expect(vfx.getVfxStats().smoke.active).toBeGreaterThan(0);

    handle.detach();
    settle(lib.updateVfx, 2.5); // steam puff ttl <= 0.96; detached record is spliced
    expect(vfx.getVfxStats().smoke.active).toBe(0);

    // Re-attach after full detach builds a FRESH emitter (the old record was
    // spliced out of the registry) and emission resumes, bounded per frame.
    const handle2 = lib.fxAttachPlume(machine, 'smoke-heavy');
    expect(handle2).toBeDefined();
    lib.updateVfx(0.3); // heavy interval 0.12 -> exactly 2 catch-up puffs
    const afterReattach = vfx.getVfxStats().smoke.active;
    expect(afterReattach).toBeGreaterThan(0);

    // Regression (backlog clamp): a single huge frame must NOT leave acc
    // inflated - the next normal frame emits nothing extra while nothing
    // expires (heavy ttl <= 1.8s >> 16ms).
    lib.updateVfx(100); // hitch frame
    const during = vfx.getVfxStats().smoke.active;
    expect(during).toBeGreaterThan(afterReattach); // hitch emitted its capped batch
    lib.updateVfx(0.016);
    expect(vfx.getVfxStats().smoke.active).toBe(during);
  });

  it('rain splash gates on weather and player anchor', async () => {
    const { G, lib, vfx } = await booted();
    expect(lib.fxRainSplash()).toBe(false); // clear weather

    G.weather = { type: 'rain', intensity: 1, wind: 0.3 };
    expect(lib.fxRainSplash()).toBe(false); // no player anchor yet
    G.player = { pos: new THREE.Vector3(3, 6, 5) };
    const before = vfx.getVfxStats().smoke.active;
    expect(lib.fxRainSplash()).toBe(true);
    expect(vfx.getVfxStats().smoke.active).toBe(before + 1);

    // The internal splash cycle runs through the same gate, terrain sampling
    // included (pure seeded fbm - safe headless), without throwing.
    expect(() => lib.updateVfx(0.2)).not.toThrow();
  });

  it('createVfx publishes __IW_VFX_STATS and dispose unwires bus handlers', async () => {
    const { G, bus, vfx, lib } = await loadFresh();
    G.scene = new THREE.Scene();
    lib.createVfx();
    expect(typeof globalThis.window.__IW_VFX_STATS).toBe('function');
    expect(globalThis.window.__IW_VFX_STATS().budget).toBe(900);

    bus.emit('impact', { pos: P(), material: 'metal' });
    expect(vfx.getVfxStats().active).toBeGreaterThan(0);

    lib.disposeVfx();
    expect(() => lib.disposeVfx()).not.toThrow(); // idempotent teardown
    bus.emit('impact', { pos: P(), material: 'metal' });
    bus.emit('machineHit', { machine: null, point: P(), damage: 10, weak: false });
    expect(vfx.getVfxStats().active).toBe(0); // handlers gone: silence proves it
  });
});
