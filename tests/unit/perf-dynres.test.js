// IRONWILD - unit tests for src/systems/perf.js (frame telemetry) and
// src/systems/dynres.js (dynamic-resolution controller).
//
// Both modules run scene-less and renderer-less here: perf.js only reads
// optional globals (renderer.info, performance.memory, window hooks), and
// dynres.js takes plain stub objects for renderer/composer - the stubs record
// every setPixelRatio call so the control law can be asserted without WebGL.
// Module-level state (ring buffer, controller internals) is reset per test via
// vi.resetModules() + dynamic imports, matching status-burn.test.js.

import { describe, it, expect, vi, beforeEach } from "vitest";

async function loadFresh() {
  vi.resetModules();
  const mods = await Promise.all([
    import("../../src/core/state.js"),
    import("../../src/systems/perf.js"),
    import("../../src/systems/dynres.js"),
  ]);
  return { G: mods[0].G, perf: mods[1], dynres: mods[2] };
}

/**
 * Renderer/composer doubles for dynres. `gfx.pr` is mutable so tests can play
 * the integrator role: a quality preset writes its own base pixel ratio into
 * the renderer BEFORE calling onQualityChanged, which must recapture it.
 */
function makeGfx(basePR = 1.5) {
  const gfx = { pr: basePR };
  const applied = [];
  const renderer = {
    getPixelRatio: () => gfx.pr,
    setPixelRatio: (v) => applied.push(v),
  };
  const composer = { setPixelRatio: (v) => applied.push(v) };
  return { gfx, renderer, composer, applied };
}

/** Feed n identical frames to updateDynRes. */
const feed = (update, dt, n) => {
  for (let i = 0; i < n; i++) update(dt);
};

// Busy work sized to measure as clearly > 0ms on any clock granularity.
// `burned` is asserted >0 by the marks tests so the optimizer cannot DCE the loop.
let sink = 0;
let burned = 0;
function burn(msWorth) {
  const iters = msWorth * 200000; // ~0.005ms per 1k float adds in V8, order-of-magnitude only
  for (let i = 0; i < iters; i++) sink += i % 7;
  burned = sink;
}

beforeEach(() => {
  // The setup.dom.js window/document singletons persist across tests; clear
  // the publish slots so assertions see only what THIS test wrote.
  delete globalThis.window.__IW_DYNRES_SCALE;
  delete globalThis.window.__IW_PERF_CELLS;
  globalThis.document.hidden = false;
});

describe("perf: frame ring + percentiles", () => {
  beforeEach(() => vi.resetModules());

  it("constant input: p50 == p95 == p99 == min == max (sorted-copy math)", async () => {
    const { G, perf } = await loadFresh();
    G.paused = false;
    for (let i = 0; i < 240; i++) perf.updatePerf(1 / 60);
    const f = perf.getReport().frameMs;
    // Every slot holds the identical Float32 value, so every percentile picks
    // the same bits. Strict equality also proves the sort ran on the scratch
    // COPY - sorting the ring itself could not preserve identical-order stats,
    // but the real hazard (mutating live samples) is covered by min/max being
    // scanned pre-sort yet agreeing with post-sort percentiles.
    expect(f.min).toBe(f.max);
    expect(f.p50).toBe(f.p95);
    expect(f.p95).toBe(f.p99);
    expect(f.p99).toBe(f.max);
    expect(f.avg).toBeCloseTo(f.p50, 3);
    expect(perf.getReport().frames).toBe(240);
  });

  it("rolling replacement: old samples age out once the ring wraps", async () => {
    const { G, perf } = await loadFresh();
    G.paused = false;
    // getReport() serves throttled caches (~4 Hz): a recompute only fires when
    // tStats crosses STATS_INTERVAL, so stats can lag the ring by up to
    // ceil(0.25/dt) frames. Each phase ends with same-value FLUSH frames
    // guaranteed to cross the threshold (ceil(STATS_INTERVAL/dt)+1) so the
    // lagging window is dominated by the phase's own value - assertions stay
    // exact without weakening anything.
    const feedN = (sec, n) => {
      for (let i = 0; i < n; i++) perf.updatePerf(sec);
    };
    const flushN = (sec) => feedN(sec, Math.ceil(0.25 / sec) + 1);
    feedN(0.01, 240); // fill with fast frames + flush
    flushN(0.01);
    let f = perf.getReport().frameMs;
    expect(f.max).toBeCloseTo(10, 1);

    feedN(0.06, 40); // partial overwrite: 40 slowest slots replaced
    flushN(0.06);
    f = perf.getReport().frameMs;
    expect(f.max).toBeCloseTo(60, 1); // new samples present...
    expect(f.min).toBeCloseTo(10, 1); // ...old ones still counted

    feedN(0.06, 200); // complete one full wrap: every 10ms sample evicted
    flushN(0.06);
    f = perf.getReport().frameMs;
    expect(f.min).toBeCloseTo(60, 1);
    expect(f.max).toBeCloseTo(60, 1);

    feedN(0.01, 240); // and back again - wraparound fully recycled
    flushN(0.01);
    f = perf.getReport().frameMs;
    expect(f.max).toBeCloseTo(10, 1);
  });

  it("huge tab-resume dt is clamped out of percentiles", async () => {
    const { G, perf } = await loadFresh();
    G.paused = false;
    for (let i = 0; i < 100; i++) perf.updatePerf(1 / 60);
    perf.updatePerf(5000); // tab was hidden "for an hour"
    const f = perf.getReport().frameMs;
    expect(f.max).toBeLessThanOrEqual(250 + 1e-3); // DT_CLAMP_MS ceiling
    expect(f.p99).toBeLessThan(20);
  });
});

describe("perf: marks", () => {
  beforeEach(() => vi.resetModules());

  it("beginMark/endMark accumulation appears in getReport().marks", async () => {
    const { G, perf } = await loadFresh();
    G.paused = false;
    perf.beginMark("sim");
    burn(3); // genuinely measurable span, not clock-granularity luck
    perf.endMark("sim");
    perf.updatePerf(0.016); // snapshot moves acc -> last-frame bucket
    expect(burned).toBeGreaterThan(0); // busy work really executed (anti-DCE)
    const mk = perf.getReport().marks.find((m) => m.name === "sim");
    expect(mk).toBeDefined();
    expect(mk.ms).toBeGreaterThan(0);
    expect(mk.totalMs).toBeGreaterThanOrEqual(mk.ms);
  });

  it("per-frame attribution resets: closed mark reports 0ms on idle frames", async () => {
    const { G, perf } = await loadFresh();
    G.paused = false;
    perf.beginMark("sim");
    burn(2);
    perf.endMark("sim");
    perf.updatePerf(0.016);
    perf.updatePerf(0.016); // idle frame: nothing accumulated
    const mk = perf.getReport().marks.find((m) => m.name === "sim");
    expect(mk).toBeDefined(); // still listed (lifetime total > 0) ...
    expect(mk.ms).toBe(0); // ...but this frame's slice is zero
    expect(mk.totalMs).toBeGreaterThan(0);
  });

  it("mark left open across frames stays pending, lands in the ending frame", async () => {
    const { G, perf } = await loadFresh();
    G.paused = false;
    perf.beginMark("open");
    perf.updatePerf(0.016);
    perf.updatePerf(0.016);
    // While open, acc never advances - intermediate frames stay clean instead
    // of inheriting garbage from the unfinished span.
    expect(
      perf.getReport().marks.find((m) => m.name === "open"),
    ).toBeUndefined();
    burn(2);
    perf.endMark("open"); // span attributed to whichever frame ends it
    perf.updatePerf(0.016);
    const mk = perf.getReport().marks.find((m) => m.name === "open");
    expect(mk).toBeDefined();
    expect(mk.ms).toBeGreaterThan(0);
  });

  it("endMark without begin is ignored silently; unknown names are no-ops", async () => {
    const { perf } = await loadFresh();
    expect(() => perf.endMark("ghost")).not.toThrow();
    expect(() => perf.beginMark("ghost")).not.toThrow();
    expect(() => perf.endMark("ghost")).not.toThrow(); // restart-then-close ok
  });
});

describe("perf: HUD + lifecycle hardening", () => {
  beforeEach(() => vi.resetModules());

  it("createPerf is idempotent: one keydown listener, no throws, headless-safe", async () => {
    const spy = vi.spyOn(globalThis.window, "addEventListener");
    try {
      const { perf } = await loadFresh();
      // Node-env document stub has no createElement: installHud must degrade
      // silently instead of throwing out of createPerf.
      expect(() => {
        perf.createPerf();
        perf.createPerf();
      }).not.toThrow();
      const keydowns = spy.mock.calls.filter(([t]) => t === "keydown");
      expect(keydowns).toHaveLength(1); // listener duplication guard
      expect(typeof keydowns[0][1]).toBe("function");
    } finally {
      spy.mockRestore();
    }
  });

  it("toggleHud flips without DOM (returns false, never throws headless)", async () => {
    const { perf } = await loadFresh();
    perf.createPerf();
    expect(() => {
      expect(perf.toggleHud(true)).toBe(false); // no overlay available
      expect(perf.toggleHud(false)).toBe(false);
      expect(perf.toggleHud()).toBe(false); // flip form
    }).not.toThrow();
  });

  it("with a minimal DOM: HUD built once, toggles paint, F3 handler respects inputs", async () => {
    // Upgrade the node stub to a tiny recording document - just enough surface
    // for installHud/paintHud, no real layout.
    const created = [];
    const origDoc = globalThis.document;
    globalThis.document = {
      hidden: false,
      addEventListener() {},
      removeEventListener() {},
      body: { appendChild() {} },
      createElement(tag) {
        const el = {
          tag,
          id: "",
          style: {},
          children: [],
          textContent: "",
          appendChild(c) {
            el.children.push(c);
          },
        };
        created.push(el);
        return el;
      },
    };
    const spy = vi.spyOn(globalThis.window, "addEventListener");
    try {
      const { perf } = await loadFresh();
      perf.createPerf();
      perf.createPerf(); // second call must not rebuild DOM or re-listen
      expect(created).toHaveLength(2); // container + text node, exactly once
      const keydown = spy.mock.calls.find(([t]) => t === "keydown")[1];

      expect(perf.toggleHud(true)).toBe(true);
      expect(created[0].style.display).toBe("block");
      expect(created[0].children[0].textContent.length).toBeGreaterThan(0); // painted

      expect(perf.toggleHud(false)).toBe(false);
      expect(created[0].style.display).toBe("none");

      // F3 via the captured handler: editable targets must be ignored.
      const press = (target) => {
        let prevented = false;
        keydown({
          key: "F3",
          target,
          preventDefault: () => {
            prevented = true;
          },
        });
        return prevented;
      };
      expect(press({ tagName: "INPUT" })).toBe(false); // not hijacked...
      expect(perf.toggleHud()).toBe(true); // ...was still hidden
      expect(press(null)).toBe(true); // normal target: hijacked -> off
      expect(perf.toggleHud()).toBe(true); // flip form works
    } finally {
      spy.mockRestore();
      globalThis.document = origDoc;
    }
  });

  it("installs under documentElement when document.body is absent (fallback path)", async () => {
    const created = [];
    const origDoc = globalThis.document;
    globalThis.document = {
      hidden: false,
      addEventListener() {},
      removeEventListener() {},
      // No body: installHud must fall through to documentElement, and if BOTH
      // are missing its own try/catch degrades to "no overlay" instead of throw.
      documentElement: { appendChild() {} },
      createElement(tag) {
        const el = {
          tag,
          id: "",
          style: {},
          children: [],
          textContent: "",
          appendChild(c) {
            el.children.push(c);
          },
        };
        created.push(el);
        return el;
      },
    };
    try {
      const { perf } = await loadFresh();
      perf.createPerf();
      expect(created).toHaveLength(2);
      expect(perf.toggleHud(true)).toBe(true); // HUD lives under documentElement now
    } finally {
      globalThis.document = origDoc;
    }
  });
});

describe("perf: report contracts", () => {
  beforeEach(() => vi.resetModules());

  it("getReport returns the shared mutable snapshot (documented read-immediately contract)", async () => {
    const { perf } = await loadFresh();
    const r1 = perf.getReport();
    const r2 = perf.getReport();
    expect(r1).toBe(r2);
    expect(r1.frameMs).toBe(r2.frameMs);
  });

  it("__IW_PERF_CELLS passthrough: value flows, throwing publisher degrades to null", async () => {
    const { G, perf } = await loadFresh();
    G.paused = false;
    globalThis.window.__IW_PERF_CELLS = () => ({ grass: 12 });
    perf.updatePerf(0.016);
    expect(perf.getReport().cells).toEqual({ grass: 12 });

    globalThis.window.__IW_PERF_CELLS = () => {
      throw new Error("bad tick");
    };
    perf.updatePerf(0.25); // past STATS_INTERVAL: recaptures
    expect(perf.getReport().cells).toBeNull();
  });

  it("GpuTimer degrades to inert no-ops without a WebGL context", async () => {
    const { perf } = await loadFresh();
    const gt = new perf.GpuTimer(null);
    expect(gt.ok).toBe(false);
    expect(gt.begin()).toBe(false);
    expect(gt.end()).toBe(false);
    expect(gt.poll()).toBeNull();
    expect(() => gt.destroy()).not.toThrow();
  });
});

describe("dynres: publishing contract", () => {
  beforeEach(() => vi.resetModules());

  it("null while unwired/disabled, finite number while active", async () => {
    const { G, dynres } = await loadFresh();
    G.paused = false;
    dynres.createDynRes();
    expect(dynres.getScale()).toBeNull();
    expect(globalThis.window.__IW_DYNRES_SCALE).toBeNull();

    dynres.setContext({ renderer: {} }); // not a three renderer: stays disabled
    expect(dynres.getScale()).toBeNull();
    expect(globalThis.window.__IW_DYNRES_SCALE).toBeNull();

    const { renderer, composer, applied } = makeGfx(1.5);
    dynres.setContext({ renderer, composer });
    expect(dynres.getScale()).toBe(1);
    expect(globalThis.window.__IW_DYNRES_SCALE).toBe(1);
    // Baseline established immediately: quantized basePR*scale pushed to both.
    expect(applied[0]).toBeCloseTo(1.5, 5);
    expect(applied).toHaveLength(2); // renderer + composer
  });

  it("composer absence is tolerated (renderer-only wiring)", async () => {
    const { G, dynres } = await loadFresh();
    G.paused = false;
    const { renderer, applied } = makeGfx(1.0);
    dynres.setContext({ renderer }); // no composer key at all
    feed(dynres.updateDynRes, 0.02, 120); // drive a step
    expect(applied.length).toBeGreaterThan(1);
    expect(applied.every((v) => typeof v === "number")).toBe(true);
  });
});

describe("dynres: sustained-load control law", () => {
  beforeEach(() => vi.resetModules());

  it("sustained 20ms frames step down monotonically and pin at the quality lo bound", async () => {
    const { G, dynres } = await loadFresh();
    G.paused = false;
    G.settings.quality = "high";
    const { renderer, composer, applied } = makeGfx(1.5);
    dynres.createDynRes();
    dynres.setContext({ renderer, composer });

    feed(dynres.updateDynRes, 0.02, 900);
    expect(dynres.getScale()).toBe(0.65); // high-tier lo bound, exact
    expect(globalThis.window.__IW_DYNRES_SCALE).toBe(0.65);
    // Every push moved DOWN (quantization may skip pushes but never reverse).
    // Entries arrive as equal renderer/composer PAIRS per applyRatio, so the
    // monotonic check compares each push against the previous push (stride 2).
    for (let i = 2; i < applied.length; i += 2) {
      expect(applied[i]).toBeLessThan(applied[i - 2]);
    }
    // All pushes inside [basePR*lo - quantum, basePR*hi].
    for (const v of applied) {
      expect(v).toBeGreaterThanOrEqual(1.5 * 0.65 - 0.05 + 1e-9);
      expect(v).toBeLessThanOrEqual(1.5 * 1.0 + 1e-9);
    }

    const len = applied.length;
    feed(dynres.updateDynRes, 0.02, 300); // more overload at the bound: pinned
    expect(applied).toHaveLength(len);
  });

  it("medium tier sheds to its own floor; boot applies exactly the preset ratio", async () => {
    const { G, dynres } = await loadFresh();
    G.paused = false;
    G.settings.quality = "medium";
    const { renderer, composer, applied } = makeGfx(1.0);
    dynres.createDynRes();
    dynres.setContext({ renderer, composer });
    // Boot honors the user's tier selection EXACTLY (scale 1.0 == preset).
    expect(applied[0]).toBeCloseTo(1.0 * 1.0, 5);
    feed(dynres.updateDynRes, 0.02, 1100);
    expect(dynres.getScale()).toBe(0.55); // medium lo
    for (const v of applied) {
      expect(v).toBeGreaterThanOrEqual(1.0 * 0.55 - 0.05 + 1e-9);
      // scale <= 1.0 in every tier: never above the preset's own resolution.
      expect(v).toBeLessThanOrEqual(1.0 * 1.0 + 1e-9);
    }
  });

  it("sub-band fast frames add pixels until the 1.0 ceiling (monotonic climb)", async () => {
    const { G, dynres } = await loadFresh();
    G.paused = false;
    const { renderer, composer, applied } = makeGfx(1.5);
    dynres.createDynRes();
    dynres.setContext({ renderer, composer });

    feed(dynres.updateDynRes, 0.02, 650); // shed to the floor first
    expect(dynres.getScale()).toBe(0.65);
    const floorLen = applied.length;

    feed(dynres.updateDynRes, 0.01, 1400); // 10ms avg < BAND_LO: confirmed speed-ups
    const scale = dynres.getScale();
    // NOTE: convergence freezes epsilon below hi (the 1e-4 dead-zone skips the
    // final sub-threshold nudge on purpose - applied ratio is already exact).
    expect(scale).toBeGreaterThanOrEqual(1.0 - 1e-3);
    expect(scale).toBeLessThanOrEqual(1.0);
    // Pushes climb strictly push-over-push (stride 2 = renderer/composer pairs).
    for (let i = floorLen; i < applied.length; i += 2) {
      expect(applied[i]).toBeGreaterThan(applied[i - 2]);
    }
    expect(applied[applied.length - 1]).toBeCloseTo(1.5, 5); // back to full ratio
  });

  it("in-band frames recover gently: comfort delay then 0.01 steps, not jumps", async () => {
    const { G, dynres } = await loadFresh();
    G.paused = false;
    const { renderer, composer, applied } = makeGfx(1.5);
    dynres.createDynRes();
    dynres.setContext({ renderer, composer });

    feed(dynres.updateDynRes, 0.02, 650);
    expect(dynres.getScale()).toBe(0.65);
    const preRecoveryPush = applied[applied.length - 1];

    // 17ms sits INSIDE [15.4, 18.5]: hysteresis resets, comfort accumulates,
    // recovery crawls at RECOVERY_STEP per decision after RECOVERY_AFTER.
    feed(dynres.updateDynRes, 0.017, 600);
    const s = dynres.getScale();
    expect(s).toBeGreaterThan(0.65); // recovering
    expect(s).toBeLessThan(0.85); // ...slowly (comfort + ~12 steps max)
    expect(applied[applied.length - 1]).toBeGreaterThan(preRecoveryPush);
  });
});

describe("dynres: hysteresis (no borderline oscillation)", () => {
  beforeEach(() => vi.resetModules());

  it("borderline averages (17ms, exact 18.5ms, 15.5ms) never move resolution", async () => {
    const { G, dynres } = await loadFresh();
    G.paused = false;
    const { renderer, composer, applied } = makeGfx(1.5);
    dynres.createDynRes();
    dynres.setContext({ renderer, composer });

    // 6+ decisions worth of each in-band flavor. 18.5 and 15.5 are exactly
    // representable in the Float32 ring (binary fractions), so these really do
    // probe the band edges themselves; 15.4 cannot exist in the ring (f32
    // rounding), which is why its nearest representable neighbor is used.
    feed(dynres.updateDynRes, 0.017, 400);
    feed(dynres.updateDynRes, 0.0185, 400);
    feed(dynres.updateDynRes, 0.0155, 400);
    expect(applied).toHaveLength(2); // only the forced baseline (renderer+composer)
    expect(dynres.getScale()).toBe(1);
  });

  it("alternating fast/slow decisions cancel: no flip-flop stepping", async () => {
    const { G, dynres } = await loadFresh();
    G.paused = false;
    const { renderer, composer, applied } = makeGfx(1.5);
    dynres.createDynRes();
    dynres.setContext({ renderer, composer });
    // Every decision interval sees the SAME mixed average (~17ms, in band):
    // alternate 14/20ms within each window so consecutive decisions agree.
    for (let i = 0; i < 600; i++) {
      dynres.updateDynRes(i % 2 === 0 ? 0.014 : 0.02);
    }
    expect(applied).toHaveLength(2); // baseline pair only
    expect(dynres.getScale()).toBe(1);
  });

  it("a sub-band transient spike can never move resolution", async () => {
    const { G, dynres } = await loadFresh();
    G.paused = false;
    const { renderer, composer, applied } = makeGfx(1.5);
    dynres.createDynRes();
    dynres.setContext({ renderer, composer });

    feed(dynres.updateDynRes, 1 / 60, 200); // healthy in-band baseline
    // 80ms hitch: even fully resident in the 45-frame window the average
    // stays (44*16.7+80)/45 ~ 18.1 < BAND_HI -> zero out-of-band decisions.
    dynres.updateDynRes(0.08);
    feed(dynres.updateDynRes, 1 / 60, 400);
    expect(applied).toHaveLength(2); // baseline pair only
    expect(dynres.getScale()).toBe(1);
  });

  it("a full overload transient steps exactly once, then in-band frames recover", async () => {
    const { G, dynres } = await loadFresh();
    G.paused = false;
    const { renderer, composer, applied } = makeGfx(1.5);
    dynres.createDynRes();
    dynres.setContext({ renderer, composer });

    feed(dynres.updateDynRes, 1 / 60, 200);
    // 250ms stall: resident in the window across two DECISION_INTERVALs, so
    // exactly ONE confirmed down-step fires - then the spike evicts and
    // hysteresis resets instead of cascading.
    dynres.updateDynRes(0.25);
    feed(dynres.updateDynRes, 1 / 60, 60);
    expect(dynres.getScale()).toBe(0.97); // one step, pinned
    let downs = 0;
    for (let i = 2; i < applied.length; i += 2) {
      if (applied[i] < applied[i - 2]) downs++;
      expect(applied[i]).toBeGreaterThan(0); // sanity: pushes are numbers
    }
    expect(downs).toBe(1);

    feed(dynres.updateDynRes, 1 / 60, 600); // clean frames: comfort + recovery
    const s = dynres.getScale();
    expect(s).toBeGreaterThanOrEqual(0.97); // climbing back, never further down
    expect(s).toBeLessThanOrEqual(1.0);
  });
});

describe("dynres: quality recalibration", () => {
  beforeEach(() => vi.resetModules());

  it("onQualityChanged recaptures basePR from the CURRENT renderer value", async () => {
    const { G, dynres } = await loadFresh();
    G.paused = false;
    G.settings.quality = "high";
    const { gfx, renderer, composer, applied } = makeGfx(1.5);
    dynres.createDynRes();
    dynres.setContext({ renderer, composer });
    feed(dynres.updateDynRes, 0.02, 650);
    expect(dynres.getScale()).toBe(0.65);
    const beforeLen = applied.length;
    const beforeLast = applied[applied.length - 1];

    // Integrator flow: the quality preset just wrote ITS OWN pixel ratio (1.0)
    // into the renderer; onQualityChanged must adopt THAT as the new base AND
    // re-baseline scale to 1.0 - a tier switch applies the newly selected
    // tier's own full resolution immediately, dropping any adaptive deficit
    // earned under the old tier.
    gfx.pr = 1.0;
    dynres.onQualityChanged();
    expect(applied).toHaveLength(beforeLen + 2); // force-pushed to both targets
    expect(applied[applied.length - 1]).toBeCloseTo(1.0, 5); // 1.0 * reset scale 1.0
    expect(dynres.getScale()).toBe(1.0);
    // Last pre-switch push is 1.0, NOT 1.5*0.65=0.95: the descent's final
    // internal step (scale 0.67 -> 0.65) quantizes raw=0.975.. into the same
    // 0.05 bucket as the previous step, so its renderer push dedups away.
    expect(beforeLast).toBeCloseTo(1.0, 5);
  });

  it("onQualityChanged clamps scale into the new tier bounds (downgrade case)", async () => {
    const { G, dynres } = await loadFresh();
    G.paused = false;
    G.settings.quality = "high";
    const { gfx, renderer, composer, applied } = makeGfx(1.5);
    dynres.createDynRes();
    dynres.setContext({ renderer, composer });

    feed(dynres.updateDynRes, 0.02, 650); // shed to 0.65...
    feed(dynres.updateDynRes, 0.01, 1400); // ...then climb back toward 1.0
    expect(dynres.getScale()).toBeGreaterThanOrEqual(1.0 - 1e-3);

    // Downgrade to medium while scale sits at the high ceiling: hi is 1.0 in
    // every tier, so scale 1.0 stays legal and the new preset's OWN ratio
    // applies immediately - the settings UI's promised resolution.
    G.settings.quality = "medium";
    gfx.pr = 0.9;
    dynres.onQualityChanged();
    expect(dynres.getScale()).toBe(1.0);
    // quantize(0.9 * 1.0 = 0.9) = round(18) * 0.05 = 0.90
    expect(applied[applied.length - 1]).toBeCloseTo(0.9, 5);
    expect(globalThis.window.__IW_DYNRES_SCALE).toBe(1.0);
  });
});

describe("dynres: pause/hide gaps", () => {
  beforeEach(() => vi.resetModules());

  it("paused frames are skipped entirely; first post-resume decision needs a fresh window", async () => {
    const { G, dynres } = await loadFresh();
    G.paused = false;
    const { renderer, composer, applied } = makeGfx(1.5);
    dynres.createDynRes();
    dynres.setContext({ renderer, composer });

    feed(dynres.updateDynRes, 0.02, 24); // 0.48s: still short of decision #1
    expect(applied).toHaveLength(2); // baseline pair only

    G.paused = true;
    feed(dynres.updateDynRes, 0.06, 100); // paused overload: all ignored
    expect(applied).toHaveLength(2);
    expect(dynres.getScale()).toBe(1);

    G.paused = false;
    // Resume dropped the averaging AND the decision timer: another 0.48s of
    // slow frames must STILL not reach a decision (proves the reset happened -
    // stale pre-pause time would have fired one immediately).
    feed(dynres.updateDynRes, 0.02, 24);
    expect(applied).toHaveLength(2);
    feed(dynres.updateDynRes, 0.02, 25); // resumed frames 25-49: decision #1 only
    expect(applied).toHaveLength(2); // (outRun=1: confirm still pending)
    feed(dynres.updateDynRes, 0.02, 1); // resumed frame 50 crosses: #2 agrees
    expect(applied).toHaveLength(4); // one new renderer+composer push pair
    expect(dynres.getScale()).toBeCloseTo(0.97, 5);
  });

  it("hidden-tab frames are skipped like paused ones (document.hidden)", async () => {
    const { G, dynres } = await loadFresh();
    G.paused = false;
    const { renderer, composer, applied } = makeGfx(1.5);
    dynres.createDynRes();
    dynres.setContext({ renderer, composer });

    globalThis.document.hidden = true;
    feed(dynres.updateDynRes, 0.06, 60);
    expect(applied).toHaveLength(2); // baseline pair, untouched while hidden
    expect(dynres.getScale()).toBe(1);

    globalThis.document.hidden = false;
    feed(dynres.updateDynRes, 0.02, 49); // fresh window: decision #1 only (at frame 25)
    expect(applied).toHaveLength(2);
    feed(dynres.updateDynRes, 0.02, 26); // decision #2 (frame 50): confirmed step
    expect(applied).toHaveLength(4);
  });

  it("an absurd rawDt (tab resume burst) is dropped whole, not averaged or decided on", async () => {
    const { G, dynres } = await loadFresh();
    G.paused = false;
    const { renderer, composer, applied } = makeGfx(1.5);
    dynres.createDynRes();
    dynres.setContext({ renderer, composer });

    // Warm up near a decision boundary, then slam one giant delta through.
    feed(dynres.updateDynRes, 0.02, 30);
    dynres.updateDynRes(3600); // one-hour gap arriving as a single frame
    // Pre-fix behavior fed raw dt into the decision timer, minting a decision
    // on EVERY following frame until the debt drained - two of those stale
    // verdicts confirm a bogus step. Now the gap resets the controller, so 30
    // more frames reach at most the single fresh decision #1 (frame 25) and
    // nothing can step.
    feed(dynres.updateDynRes, 0.02, 30);
    expect(applied).toHaveLength(2); // baseline pair only - nothing stepped
    expect(dynres.getScale()).toBe(1);
  });
});

describe("perf <-> dynres shared publish contract", () => {
  beforeEach(() => vi.resetModules());

  it("perf report mirrors window.__IW_DYNRES_SCALE both ways", async () => {
    const { G, perf, dynres } = await loadFresh();
    G.paused = false;
    perf.createPerf();
    const { renderer, composer } = makeGfx(1.5);
    dynres.createDynRes();
    dynres.setContext({ renderer, composer });

    perf.updatePerf(0.016);
    expect(perf.getReport().dynResScale).toBe(1);

    feed(dynres.updateDynRes, 0.02, 50); // first confirmed step: 1 -> 0.97
    expect(dynres.getScale()).toBeCloseTo(0.97, 5);

    perf.updatePerf(0.26); // force the throttled telemetry refresh
    expect(perf.getReport().dynResScale).toBeCloseTo(0.97, 5);
  });
});
