// IRONWILD - unit tests for src/core/utils.js (pure math + deterministic RNG).

import { describe, it, expect } from 'vitest';
import {
  clamp,
  lerp,
  smoothstep,
  damp,
  makeRng,
  randRange,
  hash2,
  valueNoise2,
  fbm2,
} from '../../src/core/utils.js';
import { CONFIG } from '../../src/core/state.js';

describe('clamp', () => {
  it('leaves in-range values untouched', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
    expect(clamp(-3.5, -5, 5)).toBe(-3.5);
  });

  it('clamps below the low bound and above the high bound', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(-100, -5, 5)).toBe(-5);
    expect(clamp(100, -5, 5)).toBe(5);
  });

  it('works with reversed-looking bounds by returning the min bound', () => {
    // Math.max(a, Math.min(b, v)) with a > b always collapses to a.
    expect(clamp(5, 10, 0)).toBe(10);
    expect(clamp(-5, 10, 0)).toBe(10);
  });

  it('propagates NaN (current behavior: no guard)', () => {
    expect(clamp(NaN, 0, 1)).toBeNaN();
  });
});

describe('lerp', () => {
  it('returns endpoints at t=0 and t=1', () => {
    expect(lerp(2, 10, 0)).toBe(2);
    expect(lerp(2, 10, 1)).toBe(10);
  });

  it('returns the midpoint at t=0.5', () => {
    expect(lerp(2, 10, 0.5)).toBe(6);
    expect(lerp(-4, 4, 0.5)).toBe(0);
  });

  it('extrapolates for t outside [0,1] (current behavior)', () => {
    expect(lerp(0, 10, 2)).toBe(20);
    expect(lerp(0, 10, -1)).toBe(-10);
  });
});

describe('smoothstep', () => {
  it('is 0 at/below edge a and 1 at/above edge b', () => {
    expect(smoothstep(0, 10, -5)).toBe(0);
    expect(smoothstep(0, 10, 0)).toBe(0);
    expect(smoothstep(0, 10, 10)).toBe(1);
    expect(smoothstep(0, 10, 15)).toBe(1);
  });

  it('is 0.5 at the midpoint and complement-symmetric around it', () => {
    expect(smoothstep(0, 10, 5)).toBe(0.5);
    // s(x) = 1 - s(1-x): value at 25% of the band mirrors 75%.
    expect(smoothstep(0, 10, 2.5)).toBeCloseTo(1 - smoothstep(0, 10, 7.5), 12);
  });

  it('matches the hermite curve x*x*(3-2x) inside the band', () => {
    const x = (3 - 0) / (10 - 0); // t=3 between edges 0..10
    expect(smoothstep(0, 10, 3)).toBeCloseTo(x * x * (3 - 2 * x), 12);
  });

  it('supports decreasing edges (a > b), as used by terrain masks', () => {
    // smoothstep(42, 16, r): 1 at r<=16, 0 at r>=42.
    expect(smoothstep(42, 16, 16)).toBe(1);
    expect(smoothstep(42, 16, 42)).toBe(0);
    expect(smoothstep(42, 16, 29)).toBe(0.5);
  });

  it('is monotonic within the band', () => {
    let prev = -1;
    for (let t = 0; t <= 10.0001; t += 0.25) {
      const v = smoothstep(0, 10, t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('damp', () => {
  it('moves toward the target without overshooting', () => {
    const v = damp(0, 10, 4, 0.016);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(10);
  });

  it('equals lerp with factor 1 - exp(-lambda*dt)', () => {
    const dt = 0.033;
    const lambda = 6;
    expect(damp(3, 9, lambda, dt)).toBe(lerp(3, 9, 1 - Math.exp(-lambda * dt)));
  });

  it('does not move when lambda is 0 or dt is 0', () => {
    expect(damp(5, 100, 0, 0.016)).toBe(5);
    expect(damp(5, 100, 8, 0)).toBe(5);
  });

  it('approaches the target asymptotically over repeated steps', () => {
    let v = 0;
    for (let i = 0; i < 2000; i++) v = damp(v, 1, 5, 0.016);
    expect(v).toBeGreaterThan(0.99);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe('makeRng determinism (mulberry32)', () => {
  it('produces an identical sequence for the same seed', () => {
    const a = makeRng(1337);
    const b = makeRng(1337);
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });

  it('produces different sequences for different seeds', () => {
    const a = makeRng(1);
    const b = makeRng(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it('emits values in [0, 1)', () => {
    const rng = makeRng(CONFIG.seed);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('instances advance independently', () => {
    const a = makeRng(7);
    const b = makeRng(7);
    a(); a(); a(); // burn three draws on a only
    const expected = [b(), b(), b()];
    expect(a()).not.toBe(expected[0]);
    // A fresh instance from the same seed still replays the burned draws.
    const c = makeRng(7);
    expect(c()).toBe(expected[0] === undefined ? undefined : makeRng(7)());
  });

  it('coerces the seed with >>>0 (negative and large seeds are stable)', () => {
    expect(makeRng(-1)()).toBe(makeRng((-1) >>> 0)());
    expect(makeRng(2 ** 31)()).toBe(makeRng(2 ** 31 >>> 0)());
  });

  it('seed 0 is valid and deterministic', () => {
    const a = makeRng(0);
    const b = makeRng(0);
    expect(a()).toBe(b());
    expect(a()).toBe(b());
  });
});

describe('randRange', () => {
  it('stays within [a, b) across many draws', () => {
    const rng = makeRng(99);
    for (let i = 0; i < 1000; i++) {
      const v = randRange(rng, -3, 7);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThan(7);
    }
  });

  it('matches the manual formula against the same rng stream', () => {
    const rng = makeRng(1234);
    const draw = rng();
    const rng2 = makeRng(1234);
    expect(randRange(rng2, 2, 6)).toBe(2 + draw * 4);
  });

  it('degenerates to a constant when a === b', () => {
    const rng = makeRng(5);
    for (let i = 0; i < 10; i++) expect(randRange(rng, 4, 4)).toBe(4);
  });
});

describe('hash2', () => {
  it('is deterministic for identical inputs', () => {
    expect(hash2(17, -4)).toBe(hash2(17, -4));
    expect(hash2(17, -4, 42)).toBe(hash2(17, -4, 42));
  });

  it('returns values in [0, 1) over a broad grid', () => {
    for (let x = -50; x <= 50; x += 7) {
      for (let y = -50; y <= 50; y += 5) {
        const h = hash2(x, y);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(1);
      }
    }
  });

  it('varies with inputs and seed', () => {
    // Not a proof of uniformity, but guards against a collapsed hash.
    const samples = new Set();
    for (let i = 0; i < 100; i++) samples.add(hash2(i, i * 3));
    expect(samples.size).toBeGreaterThan(90);
    expect(hash2(3, 4, 1)).not.toBe(hash2(3, 4, 2));
  });

  it('truncates float coordinates to integers (x|0 semantics)', () => {
    expect(hash2(1.9, 2.9)).toBe(hash2(1, 2));
    expect(hash2(-1.5, 3.7)).toBe(hash2(-1, 3));
  });

  it('defaults its seed to CONFIG.seed', () => {
    expect(hash2(9, 9)).toBe(hash2(9, 9, CONFIG.seed));
  });
});

describe('valueNoise2', () => {
  it('is deterministic', () => {
    expect(valueNoise2(3.3, -7.7)).toBe(valueNoise2(3.3, -7.7));
  });

  it('returns values in [0, 1)', () => {
    for (let x = 0; x < 20; x += 0.37) {
      for (let y = 0; y < 20; y += 0.41) {
        const v = valueNoise2(x, y);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it('reproduces the lattice hash exactly at integer coordinates', () => {
    // At integer coords the fract part is 0, so the bilinear mix returns
    // corner a = hash2(xi, yi) verbatim.
    for (const [x, y] of [[3, 4], [-2, 9], [0, 0], [17, -13]]) {
      expect(valueNoise2(x, y)).toBe(hash2(x, y));
    }
  });

  it('is continuous: nearby samples differ only slightly', () => {
    let maxDiff = 0;
    for (let x = 10; x < 30; x += 0.01) {
      maxDiff = Math.max(maxDiff, Math.abs(valueNoise2(x, 5.5) - valueNoise2(x + 0.01, 5.5)));
    }
    expect(maxDiff).toBeLessThan(0.05);
  });
});

describe('fbm2', () => {
  it('is deterministic', () => {
    expect(fbm2(1.234, -9.87, 4)).toBe(fbm2(1.234, -9.87, 4));
  });

  it('stays within ~[0, 1]', () => {
    for (let x = -40; x <= 40; x += 3.1) {
      for (let y = -40; y <= 40; y += 2.7) {
        const v = fbm2(x, y, 4);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('with one octave reduces exactly to valueNoise2 at octave-0 seed', () => {
    // sum = 0.5 * noise(x,y,seed), norm = 0.5 -> identity.
    expect(fbm2(2.5, 3.5, 1)).toBe(valueNoise2(2.5, 3.5));
  });

  it('changes with the octave count', () => {
    expect(fbm2(2.5, 3.5, 2)).not.toBe(fbm2(2.5, 3.5, 4));
  });

  it('honors custom lacunarity/gain/seed arguments deterministically', () => {
    const a = fbm2(5.5, 6.5, 3, 2.0, 0.5, 777);
    const b = fbm2(5.5, 6.5, 3, 2.0, 0.5, 777);
    expect(a).toBe(b);
    expect(a).not.toBe(fbm2(5.5, 6.5, 3, 3.0, 0.5, 777));
  });
});
