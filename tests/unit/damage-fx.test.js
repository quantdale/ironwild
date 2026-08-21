// IRONWILD - unit tests for src/combat/damage.js (bus-driven pooled combat FX).
// NOTE: this module is the FX layer (damage numbers / sparks / rings / smoke /
// oil splats), NOT the damage-formula module - weak-point multipliers,
// front-cone checks and kill-once semantics live in machines/machines.js
// (outside this test scope). Here we verify pool lifecycle, bus subscription,
// payload guards and FX timing with a stubbed canvas + plain THREE.Scene.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { installCanvasStub } from './helpers/canvas2d.js';

const NUM_POOL = 24;
const SPARK_POOL = 3;
const RING_POOL = 4;
const SMOKE_POOL = 8;
const SPLAT_POOL = 10;

const SPARK_WEAK = 0xbdf3ff;
const SPARK_FIRE = 0xff8c3b;
const SPARK_BODY = 0x9fd8e8;
const SPLAT_COLOR = 0x4a3826;
const SPLAT_COLOR_FIRE = 0xc46a2a;

let restoreCanvas = () => {};

async function loadFresh() {
  vi.resetModules();
  const mods = await Promise.all([
    import('../../src/core/state.js'),
    import('../../src/core/events.js'),
    import('../../src/combat/damage.js'),
  ]);
  return { G: mods[0].G, bus: mods[1].bus, ...mods[2] };
}

function makeMachine({ position = new THREE.Vector3(1, 2, 3), weakPoints } = {}) {
  return { group: { position }, weakPoints };
}

function hitPayload(over = {}) {
  return {
    machine: makeMachine(),
    point: new THREE.Vector3(3, 4, 5),
    damage: 12.6,
    weak: false,
    partName: null,
    ...over,
  };
}

const visible = (scene) => scene.children.filter((c) => c.visible);
const ofType = (scene, Ctor) => scene.children.filter((c) => c instanceof Ctor);

describe('initialization', () => {
  beforeEach(() => {
    vi.resetModules();
    restoreCanvas = installCanvasStub();
  });
  afterEach(() => restoreCanvas());

  it('is a safe no-op without a scene (never initializes, never throws)', async () => {
    const { G, bus, createDamageFX, updateDamageFX } = await loadFresh();
    G.scene = null;
    expect(() => createDamageFX()).not.toThrow();
    expect(() => updateDamageFX(0.016)).not.toThrow();
    // Handlers were never subscribed: emitting must be equally harmless.
    expect(() => bus.emit('machineHit', hitPayload())).not.toThrow();
  });

  it('builds the full pool composition exactly once (idempotent)', async () => {
    const { G, createDamageFX } = await loadFresh();
    G.scene = new THREE.Scene();
    createDamageFX();
    expect(G.scene.children).toHaveLength(
      NUM_POOL + SPARK_POOL + RING_POOL + SMOKE_POOL + SPLAT_POOL,
    );
    expect(ofType(G.scene, THREE.Sprite)).toHaveLength(NUM_POOL + SMOKE_POOL + SPLAT_POOL);
    expect(ofType(G.scene, THREE.Points)).toHaveLength(SPARK_POOL);
    expect(ofType(G.scene, THREE.Mesh)).toHaveLength(RING_POOL);
    const before = G.scene.children.length;
    createDamageFX();
    expect(G.scene.children).toHaveLength(before);
  });
});

describe('machineHit handling', () => {
  beforeEach(() => {
    vi.resetModules();
    restoreCanvas = installCanvasStub();
  });
  afterEach(() => restoreCanvas());

  async function init() {
    const mods = await loadFresh();
    mods.G.scene = new THREE.Scene();
    mods.createDamageFX();
    return mods;
  }

  it('spawns one damage number, one spark burst and one oil splat', async () => {
    const { G, bus } = await init();
    bus.emit('machineHit', hitPayload());
    const vis = visible(G.scene);
    expect(vis).toHaveLength(3);
    expect(vis.filter((c) => c instanceof THREE.Sprite)).toHaveLength(2); // number + splat
    expect(vis.filter((c) => c instanceof THREE.Points)).toHaveLength(1);
  });

  it('draws the rounded damage value into the number sprite', async () => {
    const { G, bus } = await init();
    bus.emit('machineHit', hitPayload({ damage: 12.6 }));
    const numSprite = visible(G.scene).find((c) => c.renderOrder === 30);
    expect(numSprite).toBeDefined();
    // The recording ctx captured fillText calls; last one is the value.
    const texts = numSprite.material.map.image.getContext().fillTexts;
    expect(texts[texts.length - 1]).toBe('13');
  });

  it('renders "0" when the payload has no damage field', async () => {
    const { G, bus } = await init();
    bus.emit('machineHit', hitPayload({ damage: undefined }));
    const numSprite = visible(G.scene).find((c) => c.renderOrder === 30);
    const texts = numSprite.material.map.image.getContext().fillTexts;
    expect(texts[texts.length - 1]).toBe('0');
  });

  it('weak hits scale the number sprite up (1.15x)', async () => {
    const { G, bus } = await init();
    bus.emit('machineHit', hitPayload({ weak: true }));
    const numSprite = visible(G.scene).find((c) => c.renderOrder === 30);
    expect(numSprite.scale.x).toBeCloseTo(1.5 * 1.15, 6);
    bus.emit('machineHit', hitPayload({ weak: false }));
    const bodyNums = visible(G.scene).filter((c) => c.renderOrder === 30);
    const plain = bodyNums.find((c) => Math.abs(c.scale.x - 1.5) < 1e-9);
    expect(plain).toBeDefined();
  });

  it('tints sparks cyan for weak hits, pale for body, orange for fire', async () => {
    const { G, bus } = await init();
    bus.emit('machineHit', hitPayload({ weak: true }));
    expect(visible(G.scene).find((c) => c instanceof THREE.Points).material.color.getHex())
      .toBe(SPARK_WEAK);

    bus.emit('machineHit', hitPayload());
    const points = visible(G.scene).filter((c) => c instanceof THREE.Points);
    expect(points[points.length - 1].material.color.getHex()).toBe(SPARK_BODY);

    bus.emit('machineHit', hitPayload({ fire: true }));
    const allPoints = visible(G.scene).filter((c) => c instanceof THREE.Points);
    expect(allPoints[allPoints.length - 1].material.color.getHex()).toBe(SPARK_FIRE);
  });

  it('tints the oil splat darker normally, burning-orange on fire hits', async () => {
    const { G, bus } = await init();
    bus.emit('machineHit', hitPayload());
    let splat = visible(G.scene).find((c) => c.renderOrder === 15);
    expect(splat.material.color.getHex()).toBe(SPLAT_COLOR);

    bus.emit('machineHit', hitPayload({ fire: true }));
    splat = visible(G.scene)
      .filter((c) => c.renderOrder === 15)
      .find((c) => c.material.color.getHex() === SPLAT_COLOR_FIRE);
    expect(splat).toBeDefined();
  });

  it('ignores nullish payloads and nullish points without spawning anything', async () => {
    const { G, bus } = await init();
    for (const bad of [null, undefined, {}, { point: null }]) {
      expect(() => bus.emit('machineHit', bad)).not.toThrow();
    }
    expect(visible(G.scene)).toHaveLength(0);
  });

  it('treats any truthy point as valid - even a zero vector spawns full FX (current guard semantics)', async () => {
    const { G, bus } = await init();
    bus.emit('machineHit', hitPayload({ point: new THREE.Vector3(0, 0, 0) }));
    expect(visible(G.scene)).toHaveLength(3); // number + sparks + splat
  });
});

describe('partBroken handling', () => {
  beforeEach(() => {
    vi.resetModules();
    restoreCanvas = installCanvasStub();
  });
  afterEach(() => restoreCanvas());

  async function init() {
    const mods = await loadFresh();
    mods.G.scene = new THREE.Scene();
    mods.createDamageFX();
    return mods;
  }

  it('sparks + shockwave ring anchored at the broken part world position', async () => {
    const { G, bus } = await init();
    const machine = makeMachine({
      weakPoints: [
        { name: 'canister', mesh: { getWorldPosition: (v) => v.set(5, 6, 7) } },
      ],
    });
    bus.emit('partBroken', { machine, partName: 'canister' });
    const vis = visible(G.scene);
    expect(vis.filter((c) => c instanceof THREE.Points)).toHaveLength(1);
    const ring = vis.find((c) => c instanceof THREE.Mesh);
    expect(ring).toBeDefined();
    expect(ring.renderOrder).toBe(25);
    expect(ring.position.x).toBe(5);
    expect(ring.position.y).toBe(6);
    expect(ring.position.z).toBe(7);
  });

  it('falls back to the machine body position when the part is unknown', async () => {
    const { G, bus } = await init();
    const groupPos = new THREE.Vector3(9, 1, 4);
    const machine = makeMachine({ position: groupPos, weakPoints: [] });
    bus.emit('partBroken', { machine, partName: 'nope' });
    const ring = visible(G.scene).find((c) => c instanceof THREE.Mesh);
    expect(ring.position.equals(groupPos)).toBe(true);
  });

  it('falls back safely when the machine has no weakPoints list at all', async () => {
    const { G, bus } = await init();
    const groupPos = new THREE.Vector3(-2, 3, 8);
    const machine = makeMachine({ position: groupPos }); // weakPoints undefined
    expect(() => bus.emit('partBroken', { machine, partName: 'canister' })).not.toThrow();
    const ring = visible(G.scene).find((c) => c instanceof THREE.Mesh);
    expect(ring.position.equals(groupPos)).toBe(true);
  });

  it('ignores malformed payloads', async () => {
    const { G, bus } = await init();
    for (const bad of [null, undefined, {}, { machine: null }]) {
      expect(() => bus.emit('partBroken', bad)).not.toThrow();
    }
    expect(visible(G.scene)).toHaveLength(0);
  });
});

describe('machineDied handling', () => {
  beforeEach(() => {
    vi.resetModules();
    restoreCanvas = installCanvasStub();
  });
  afterEach(() => restoreCanvas());

  async function init() {
    const mods = await loadFresh();
    mods.G.scene = new THREE.Scene();
    mods.createDamageFX();
    return mods;
  }

  it('explodes with one big spark burst plus four smoke puffs at p.pos', async () => {
    const { G, bus } = await init();
    const deathPos = new THREE.Vector3(50, 6, -20);
    bus.emit('machineDied', { machine: makeMachine(), pos: deathPos });
    const vis = visible(G.scene);
    expect(vis.filter((c) => c instanceof THREE.Points)).toHaveLength(1);
    const smoke = vis.filter(
      (c) => c instanceof THREE.Sprite && c.renderOrder !== 30 && c.renderOrder !== 15,
    );
    expect(smoke).toHaveLength(4);
    for (const s of smoke) {
      // Smoke jitters within ~±0.6 x/z and +0.3..1.1 y around the anchor.
      expect(s.position.distanceTo(deathPos)).toBeLessThan(2);
    }
  });

  it('falls back to the machine group position when p.pos is absent', async () => {
    const { G, bus } = await init();
    const groupPos = new THREE.Vector3(-30, 2, 10);
    bus.emit('machineDied', { machine: makeMachine({ position: groupPos }) });
    const smoke = visible(G.scene).filter(
      (c) => c instanceof THREE.Sprite && c.renderOrder !== 30 && c.renderOrder !== 15,
    );
    expect(smoke).toHaveLength(4);
    for (const s of smoke) expect(s.position.distanceTo(groupPos)).toBeLessThan(2);
  });

  it('ignores malformed payloads', async () => {
    const { G, bus } = await init();
    for (const bad of [null, undefined, {}, { machine: null }]) {
      expect(() => bus.emit('machineDied', bad)).not.toThrow();
    }
    expect(visible(G.scene)).toHaveLength(0);
  });
});

describe('updateDamageFX timing', () => {
  beforeEach(() => {
    vi.resetModules();
    restoreCanvas = installCanvasStub();
  });
  afterEach(() => restoreCanvas());

  async function init() {
    const mods = await loadFresh();
    mods.G.scene = new THREE.Scene();
    mods.createDamageFX();
    return mods;
  }

  it('non-positive dt leaves every effect frozen', async () => {
    const { G, bus, updateDamageFX } = await init();
    bus.emit('machineHit', hitPayload());
    const before = visible(G.scene).length;
    expect(before).toBeGreaterThan(0);
    updateDamageFX(0);
    updateDamageFX(-0.1);
    expect(visible(G.scene)).toHaveLength(before);
  });

  it('numbers, sparks and splats expire within 0.85s of a hit', async () => {
    const { G, bus, updateDamageFX } = await init();
    bus.emit('machineHit', hitPayload());
    updateDamageFX(0.85); // > NUM_DUR .8, SPARK_DUR .4, SPLAT_DUR .7
    expect(visible(G.scene)).toHaveLength(0);
  });

  it('break rings expire within 0.55s', async () => {
    const { G, bus, updateDamageFX } = await init();
    bus.emit('partBroken', { machine: makeMachine(), partName: null });
    updateDamageFX(0.55); // > RING_DUR .5 (spark burst .4 already gone)
    expect(visible(G.scene)).toHaveLength(0);
  });

  it('death smoke lingers past 1s but is gone by 1.3s', async () => {
    const { G, bus, updateDamageFX } = await init();
    bus.emit('machineDied', { machine: makeMachine(), pos: new THREE.Vector3() });
    updateDamageFX(1.0); // smoke lifetime is 1.2 -> still visible
    expect(visible(G.scene).length).toBeGreaterThanOrEqual(4);
    updateDamageFX(0.3); // cumulative 1.3 > 1.2
    expect(visible(G.scene)).toHaveLength(0);
  });

  it('active rings billboard toward the current camera orientation', async () => {
    const { G, bus, updateDamageFX, createDamageFX } = await loadFresh();
    G.scene = new THREE.Scene();
    G.camera = new THREE.Object3D();
    G.camera.quaternion.setFromEuler(new THREE.Euler(0.3, 0.4, 0));
    createDamageFX();
    bus.emit('partBroken', { machine: makeMachine(), partName: null });
    updateDamageFX(0.1); // ring mid-flight (k=0.2 < 1)
    const ring = visible(G.scene).find((c) => c instanceof THREE.Mesh);
    expect(ring).toBeDefined();
    expect(ring.quaternion.equals(G.camera.quaternion)).toBe(true);
    G.camera = null;
  });

  it('number sprites climb and fade over their lifetime', async () => {
    const { G, bus, updateDamageFX } = await init();
    bus.emit('machineHit', hitPayload());
    const num = visible(G.scene).find((c) => c.renderOrder === 30);
    const startY = num.position.y;
    const mat = num.material;
    updateDamageFX(0.4); // k = 0.5: full opacity, risen half a unit
    expect(num.position.y).toBeCloseTo(startY + 1.2 * 0.5, 5);
    expect(mat.opacity).toBe(1);
    updateDamageFX(0.35); // k = ~0.94: fading tail
    expect(mat.opacity).toBeGreaterThan(0);
    expect(mat.opacity).toBeLessThan(0.3);
    updateDamageFX(0.1); // expired
    expect(num.visible).toBe(false);
  });
});

describe('pool saturation', () => {
  beforeEach(() => {
    vi.resetModules();
    restoreCanvas = installCanvasStub();
  });
  afterEach(() => restoreCanvas());

  it('30 rapid hits cap out at 24 numbers, 10 splats and 3 spark bursts', async () => {
    const { G, bus } = await loadFresh();
    G.scene = new THREE.Scene();
    const { createDamageFX } = await import('../../src/combat/damage.js');
    createDamageFX();
    for (let i = 0; i < 30; i++) bus.emit('machineHit', hitPayload());
    const vis = visible(G.scene);
    expect(vis.filter((c) => c.renderOrder === 30)).toHaveLength(NUM_POOL);
    expect(vis.filter((c) => c.renderOrder === 15)).toHaveLength(SPLAT_POOL);
    expect(vis.filter((c) => c instanceof THREE.Points)).toHaveLength(SPARK_POOL);
  });
});
