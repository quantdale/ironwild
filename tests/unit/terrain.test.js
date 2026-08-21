// IRONWILD - unit tests for src/world/terrain.js (pure heightfield + biomes).
// No WebGL: only pure functions plus one createTerrain() smoke test that
// builds CPU-side geometry into a plain THREE.Scene.

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { CONFIG, G } from '../../src/core/state.js';
import {
  terrainHeight,
  heightAt,
  biomeAt,
  biomeFactors,
  normalAt,
  createTerrain,
  updateWaterWaves,
  setWaterSkyUniforms,
} from '../../src/world/terrain.js';

const WATER = CONFIG.waterLevel;

describe('heightAt / terrainHeight determinism', () => {
  it('heightAt is the same function as terrainHeight', () => {
    expect(heightAt).toBe(terrainHeight);
  });

  it('repeated calls with identical inputs return identical outputs', () => {
    const samples = [
      [0, 0], [123.456, -77.89], [-200, 200], [0.1, -0.1],
      [265, 0], [0, -60], [-279.5, 279.5],
    ];
    for (const [x, z] of samples) {
      const a = terrainHeight(x, z);
      const b = terrainHeight(x, z);
      expect(a).toBe(b);
    }
  });

  it('is deterministic across fresh module instances (no hidden mutable state)', async () => {
    const before = [
      [10, 20], [-150, -33.3], [250, -250], [42, 42],
    ].map(([x, z]) => terrainHeight(x, z));
    vi.resetModules();
    const fresh = await import('../../src/world/terrain.js');
    const after = [
      [10, 20], [-150, -33.3], [250, -250], [42, 42],
    ].map(([x, z]) => fresh.terrainHeight(x, z));
    expect(after).toEqual(before);
  });
});

describe('terrainHeight landscape shape', () => {
  it('spawn meadow is dry and well above the water level', () => {
    expect(terrainHeight(0, 0)).toBeGreaterThan(WATER + 1);
    expect(terrainHeight(10, 10)).toBeGreaterThan(WATER);
  });

  it('lake basin at (0,-60) dips far below the water level', () => {
    expect(terrainHeight(0, -60)).toBeLessThan(WATER - 5);
    expect(terrainHeight(20, -60)).toBeLessThan(WATER);
  });

  it('mountain ring rises sharply toward the world corner', () => {
    const inner = terrainHeight(140, 140); // r~198: inside the ring start (245)
    const outer = terrainHeight(205, 205); // r~290: deep in the saturated ring
    expect(outer - inner).toBeGreaterThan(40);
    expect(outer).toBeGreaterThan(60);
  });

  it('stays finite for ordinary inputs', () => {
    for (let x = -300; x <= 300; x += 97) {
      for (let z = -300; z <= 300; z += 89) {
        expect(Number.isFinite(terrainHeight(x, z))).toBe(true);
      }
    }
  });
});

describe('terrainHeight continuity (no jumps between adjacent samples)', () => {
  // Observed max |dh| for a 0.25-unit step across the playable area is ~2.1
  // (steepest at the mountain-ring skirt). A discontinuity would blow far
  // past this bound.
  const MAX_STEP_DELTA = 4;

  it('adjacent x samples differ by less than the continuity bound', () => {
    let maxDelta = 0;
    for (let x = -280; x <= 280; x += 0.25) {
      for (let z = -280; z <= 280; z += 5) {
        const d = Math.abs(terrainHeight(x + 0.25, z) - terrainHeight(x, z));
        if (d > maxDelta) maxDelta = d;
        expect(d).toBeLessThan(MAX_STEP_DELTA);
      }
    }
    expect(maxDelta).toBeGreaterThan(0); // sanity: field is not flat
  }, 30_000);

  it('adjacent z samples differ by less than the continuity bound', () => {
    let maxDelta = 0;
    for (let x = -280; x <= 280; x += 10) {
      for (let z = -280; z <= 280; z += 0.25) {
        const d = Math.abs(terrainHeight(x, z + 0.25) - terrainHeight(x, z));
        if (d > maxDelta) maxDelta = d;
        expect(d).toBeLessThan(MAX_STEP_DELTA);
      }
    }
    expect(maxDelta).toBeGreaterThan(0);
  }, 30_000);

  it('zero-distance queries agree exactly (same call path)', () => {
    expect(terrainHeight(12.34, -56.78)).toBe(terrainHeight(12.34, -56.78));
  });
});

describe('biomeAt classification', () => {
  const VALID = new Set(['meadow', 'forest', 'highland', 'shore']);

  it('only ever returns the four canonical biome ids', () => {
    for (let x = -270; x <= 270; x += 37) {
      for (let z = -270; z <= 270; z += 29) {
        expect(VALID.has(biomeAt(x, z))).toBe(true);
      }
    }
  });

  it('classifies known anchor points (seeded, therefore stable)', () => {
    expect(biomeAt(0, 0)).toBe('meadow');       // spawn meadow
    expect(biomeAt(0, -60)).toBe('shore');      // lake centre
    expect(biomeAt(100, -100)).toBe('forest');  // NE quadrant
    expect(biomeAt(150, -150)).toBe('forest');
    expect(biomeAt(30, 180)).toBe('highland');  // deep south
    expect(biomeAt(-150, 50)).toBe('meadow');   // west grassland
  });

  it('agrees with biomeFactors thresholds on every sampled point', () => {
    for (let x = -260; x <= 260; x += 23) {
      for (let z = -260; z <= 260; z += 19) {
        const h = terrainHeight(x, z);
        const biome = biomeAt(x, z);
        if (h < WATER + 1.1) {
          expect(biome).toBe('shore');
          continue;
        }
        const { forest, highland } = biomeFactors(x, z);
        if (forest >= highland) {
          expect(biome).toBe(forest > 0.45 ? 'forest' : 'meadow');
        } else {
          expect(biome).toBe(highland > 0.45 ? 'highland' : 'meadow');
        }
      }
    }
  }, 20_000);
});

describe('biomeFactors', () => {
  it('returns factors in [0,1] and reuses the caller-supplied out object', () => {
    const out = { forest: -1, highland: -1 };
    const ret = biomeFactors(100, -100, out);
    expect(ret).toBe(out);
    expect(out.forest).toBeGreaterThanOrEqual(0);
    expect(out.forest).toBeLessThanOrEqual(1);
    expect(out.highland).toBeGreaterThanOrEqual(0);
    expect(out.highland).toBeLessThanOrEqual(1);
  });

  it('allocates a default out object when none is given', () => {
    const f = biomeFactors(-50, 80);
    expect(Object.keys(f).sort()).toEqual(['forest', 'highland']);
  });

  it('reads exactly saturated in the NE forest core and south highlands', () => {
    const ne = biomeFactors(100, -100);
    expect(ne.forest).toBeCloseTo(1, 6);
    const s = biomeFactors(0, 200);
    expect(s.highland).toBeCloseTo(1, 6);
  });

  it('is deterministic per point', () => {
    expect(biomeFactors(7.7, -8.8)).toEqual(biomeFactors(7.7, -8.8));
  });
});

describe('normalAt', () => {
  it('returns unit-length, up-facing normals across the map', () => {
    for (let x = -270; x <= 270; x += 61) {
      for (let z = -270; z <= 270; z += 53) {
        const n = normalAt(x, z);
        expect(n.length()).toBeCloseTo(1, 5);
        expect(n.y).toBeGreaterThan(0);
      }
    }
  });

  it('is exactly flat (0,1,0) at the flattened spawn centre', () => {
    const n = normalAt(0, 0);
    expect(n.x).toBeCloseTo(0, 4);
    expect(n.y).toBeCloseTo(1, 4);
    expect(n.z).toBeCloseTo(0, 4);
  });

  it('writes into a provided out vector and returns it', () => {
    const out = new THREE.Vector3();
    const ret = normalAt(30, -40, out);
    expect(ret).toBe(out);
    expect(out.length()).toBeCloseTo(1, 5);
  });

  it('matches an independent central-difference computation', () => {
    const eps = 0.5;
    const x = 90;
    const z = -120;
    const hx = terrainHeight(x + eps, z) - terrainHeight(x - eps, z);
    const hz = terrainHeight(x, z + eps) - terrainHeight(x, z - eps);
    const expected = new THREE.Vector3(-hx / (2 * eps), 1, -hz / (2 * eps)).normalize();
    const got = normalAt(x, z);
    expect(got.x).toBeCloseTo(expected.x, 8);
    expect(got.y).toBeCloseTo(expected.y, 8);
    expect(got.z).toBeCloseTo(expected.z, 8);
  });
});

describe('createTerrain smoke test (CPU geometry only)', () => {
  afterEach(() => {
    G.scene = null;
  });

  it('builds ground, water and foam meshes and adds them to G.scene', () => {
    G.scene = new THREE.Scene();
    const { groundMesh, waterMesh, foamMesh } = createTerrain();

    expect(groundMesh).toBeInstanceOf(THREE.Mesh);
    expect(waterMesh).toBeInstanceOf(THREE.Mesh);
    expect(foamMesh).toBeInstanceOf(THREE.Mesh);
    expect(G.scene.children).toContain(groundMesh);
    expect(G.scene.children).toContain(waterMesh);
    expect(G.scene.children).toContain(foamMesh);

    expect(waterMesh.name).toBe('ironwild_water');
    expect(waterMesh.position.y).toBe(WATER);
    expect(foamMesh.name).toBe('ironwild_foam');

    // Ground is displaced non-indexed geometry with baked vertex colours.
    const pos = groundMesh.geometry.attributes.position;
    expect(pos.count).toBe(128 * 128 * 2 * 3); // SEG^2 quads -> 2 tris -> 3 verts
    expect(groundMesh.geometry.attributes.color.count).toBe(pos.count);

    // Displaced vertices must sit ON the heightfield source of truth
    // (geometry stores float32, so compare with a small tolerance).
    const probe = Math.floor(pos.count / 2);
    expect(pos.getY(probe)).toBeCloseTo(
      terrainHeight(pos.getX(probe), pos.getZ(probe)),
      4,
    );
  }, 30_000);

  it('uniform writers run without throwing (values are shader-internal)', () => {
    G.scene = new THREE.Scene();
    createTerrain();
    expect(() => updateWaterWaves(12.5)).not.toThrow();
    expect(() =>
      setWaterSkyUniforms(
        new THREE.Color(0x112233),
        new THREE.Color(0x445566),
        new THREE.Vector3(0.5, 0.8, 0.2),
        new THREE.Color(0xffffff),
        0.75,
      ),
    ).not.toThrow();
  }, 30_000);
});
