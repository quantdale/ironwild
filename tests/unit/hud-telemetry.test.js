// IRONWILD - unit tests for src/ui/hud.js telemetry consumers (gap 3B).
// hud.js builds all of its DOM inside createHUD(), and vitest runs in plain
// node with only the window/localStorage stubs from tests/setup.dom.js, so
// these tests cover the module's deterministic surface instead of pixels:
//   - computeUiScale(): the uiScale priority/clamp resolver (pure export)
//   - scene-less import safety + updateHUD-before-create no-op (boot contract:
//     a HUD defect must never crash boot or the frame loop)
//   - the bus 'bowState' subscribe/unsubscribe symmetry that the new reticle
//     consumer depends on (core/events.js contract pin)
// Visual DOM behavior (class toggles, transform application) is Playwright
// territory (npm run test:e2e) and deliberately not duplicated here.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const UI_SCALE_MIN = 0.85; // mirrors a11y.js clampNum band
const UI_SCALE_MAX = 1.3;

async function loadHud() {
  vi.resetModules();
  return import('../../src/ui/hud.js');
}

async function loadBus() {
  vi.resetModules();
  return import('../../src/core/events.js');
}

describe('computeUiScale (priority + clamping)', () => {
  beforeEach(() => vi.resetModules());

  it('defaults to exactly 1 when neither source publishes a value', async () => {
    const { computeUiScale } = await loadHud();
    expect(computeUiScale(undefined, undefined)).toBe(1);
    expect(computeUiScale(null, null)).toBe(1);
    expect(computeUiScale({}, {})).toBe(1); // snapshots exist but keyless
  });

  it('prefers the published __IW_A11Y snapshot over the raw setting', async () => {
    const { computeUiScale } = await loadHud();
    // a11y.js holds the applied/clamped value every consumer shares; the raw
    // setting is only a fallback for the boot window before createA11y runs.
    expect(computeUiScale({ uiScale: 1.2 }, { uiScale: 0.9 })).toBe(0.9);
    expect(computeUiScale({ uiScale: 0.85 }, { uiScale: 1 })).toBe(1);
  });

  it('falls back to G.settings while the snapshot is absent', async () => {
    const { computeUiScale } = await loadHud();
    expect(computeUiScale({ uiScale: 1.2 }, null)).toBe(1.2);
    expect(computeUiScale({ uiScale: 1.2 }, undefined)).toBe(1.2);
    expect(computeUiScale({ uiScale: 1.15 }, {})).toBe(1.15); // keyless snapshot
  });

  it('clamps out-of-band values from either source into [0.85, 1.3]', async () => {
    const { computeUiScale } = await loadHud();
    expect(computeUiScale({ uiScale: 5 }, null)).toBe(UI_SCALE_MAX);
    expect(computeUiScale({ uiScale: 0.1 }, null)).toBe(UI_SCALE_MIN);
    expect(computeUiScale(null, { uiScale: 9 })).toBe(UI_SCALE_MAX);
    expect(computeUiScale(null, { uiScale: -2 })).toBe(UI_SCALE_MIN);
  });

  it('keeps exact boundary values unchanged', async () => {
    const { computeUiScale } = await loadHud();
    expect(computeUiScale(null, { uiScale: UI_SCALE_MIN })).toBe(UI_SCALE_MIN);
    expect(computeUiScale(null, { uiScale: UI_SCALE_MAX })).toBe(UI_SCALE_MAX);
    expect(computeUiScale({ uiScale: UI_SCALE_MIN }, null)).toBe(UI_SCALE_MIN);
  });

  it('treats non-finite values as absent instead of poisoning scale()', async () => {
    const { computeUiScale } = await loadHud();
    // ?? would pass NaN/Infinity straight into style.transform; the resolver
    // must skip them like a missing publish.
    expect(computeUiScale({ uiScale: NaN }, { uiScale: NaN })).toBe(1);
    expect(computeUiScale({ uiScale: Infinity }, { uiScale: -Infinity })).toBe(1);
    expect(computeUiScale({ uiScale: '1.1' }, { uiScale: NaN })).toBe(1); // wrong type = absent
    expect(computeUiScale({ uiScale: 1.1 }, { uiScale: Infinity })).toBe(1.1);
    expect(computeUiScale({ uiScale: NaN }, { uiScale: 0.95 })).toBe(0.95);
  });
});

describe('hud scene-less module surface (boot contract)', () => {
  beforeEach(() => vi.resetModules());

  it('imports cleanly under the repo browser stubs and keeps its public API', async () => {
    const hud = await loadHud();
    expect(typeof hud.createHUD).toBe('function');
    expect(typeof hud.updateHUD).toBe('function');
    expect(typeof hud.computeUiScale).toBe('function');
  });

  it('updateHUD before createHUD is a safe no-op, even with hostile dt', async () => {
    const { updateHUD } = await loadHud();
    expect(() => updateHUD(1 / 60)).not.toThrow();
    expect(() => updateHUD(NaN)).not.toThrow(); // sanitized to 1/60 internally
    expect(() => updateHUD(-1)).not.toThrow();
  });
});

describe("bus 'bowState' subscription contract", () => {
  beforeEach(() => vi.resetModules());

  it('delivers the payload to subscribers and stops after unsubscribe', async () => {
    const { bus } = await loadBus();
    const seen = [];
    const off = bus.on('bowState', (p) => seen.push(p));
    const payload = { state: 'drawing', power: 0.4 };
    bus.emit('bowState', payload);
    expect(seen).toEqual([payload]);
    off();
    bus.emit('bowState', { state: 'full', power: 1 }); // hud must no longer react
    expect(seen).toHaveLength(1);
  });

  it('unsubscribe removes exactly its own listener (add/remove symmetry)', async () => {
    const { bus } = await loadBus();
    const first = [];
    const second = [];
    const offFirst = bus.on('bowState', (p) => first.push(p));
    bus.on('bowState', (p) => second.push(p));
    offFirst();
    bus.emit('bowState', { state: 'idle', power: 0 });
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
  });

  it('a throwing listener cannot starve the other subscribers', async () => {
    const { bus } = await loadBus();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen = [];
    bus.on('bowState', () => { throw new Error('boom'); });
    bus.on('bowState', (p) => seen.push(p));
    try {
      expect(() => bus.emit('bowState', { state: 'full', power: 1 })).not.toThrow();
      expect(seen).toHaveLength(1); // the consumer still got the event
      expect(errSpy).toHaveBeenCalledTimes(1); // isolation was logged, not silent
    } finally {
      errSpy.mockRestore();
    }
  });
});
