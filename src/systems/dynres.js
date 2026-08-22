// IRONWILD - bounded dynamic-resolution controller (Wave A).
// Scales ONLY the 3D render resolution: renderer.setPixelRatio(basePR * scale)
// plus composer.setPixelRatio(same) when a postprocessing pipeline is wired.
// DOM/UI sizing is never touched (CSS pixel size stays fixed; only the drawing
// buffer shrinks/grows).
//
// HONEST SCOPE NOTE: resolution scaling relieves GPU fill-rate cost ONLY.
// CPU-bound frames (JS simulation, draw-call submission overhead, GC pauses)
// will NOT improve at a lower pixel ratio - see PERFORMANCE_BUDGETS.md, which
// ranks dynamic res as "a controlled final lever, not a substitute for fixing
// pathological work". The controller therefore acts slowly, with hysteresis,
// and always drifts back toward full resolution once the frame budget is met.
//
// INTEGRATION ORDER CONTRACT (main.js owns these calls):
//   createDynRes();                      // boot, once, before setContext
//   setContext({ renderer, composer });  // once AFTER both objects exist
//   applyQuality():                      // settings preset flow:
//     ...preset writes its own base pixel ratio + sizes FIRST...
//     onQualityChanged();                // THEN we re-capture that base ratio
//   updateDynRes(rawDt);                 // every frame, raw unscaled dt
//
// Publishing convention (shared with systems/perf.js): window.__IW_DYNRES_SCALE
// is a finite number while active, null while disabled/unwired. perf.js reads
// it defensively; both sides define it identically.

import { G } from '../core/state.js';
import { clamp } from '../core/utils.js';

// --- tuning -----------------------------------------------------------------

const AVG_WINDOW = 45;          // frames in the moving average (~0.75s @60Hz)
const DECISION_INTERVAL = 0.5;  // seconds between control decisions
// Comfort band around the 16.7ms (60fps) target: inside it the controller is
// deliberately inert - chasing sub-millisecond noise would churn resolution.
const BAND_LO = 15.4;           // ms - below this we can afford MORE pixels
const BAND_HI = 18.5;           // ms - above this we shed pixels
const CONFIRM_DECISIONS = 2;    // consecutive out-of-band decisions before a step
const STEP = 0.03;              // scale change per confirmed decision
const RECOVERY_STEP = 0.01;     // gentle climb back while comfortable
const RECOVERY_AFTER = 4.0;     // seconds continuously in-band before recovery
const QUANTUM = 0.05;           // applied-ratio rounding step (see applyRatio)
const DT_CLAMP_S = 0.25;        // deltas above this are gaps, not rendered frames
                                // (tab resume / debugger pause) - dropped whole

// Per-quality scale bounds. hi is 1.0 for EVERY tier: scale multiplies the
// quality preset's own pixel ratio, so scale <= 1.0 already guarantees the
// controller never exceeds the tier's declared resolution - the settings UI
// promises "medium == 1.25" and boot must honor that exactly, shedding BELOW
// it only while measured load demands, then recovering precisely back to the
// preset ratio once the frame budget is met (see module-header philosophy).
const BOUNDS = {
  high:   { lo: 0.65, hi: 1.0 },
  medium: { lo: 0.55, hi: 1.0 },
  low:    { lo: 0.5,  hi: 1.0 },
};

// --- module state -----------------------------------------------------------

let inited = false;
let renderer = null;
let composer = null;      // optional; postprocessing may be off on some presets
let basePR = 1;           // quality-preset pixel ratio captured at setContext /
                          // onQualityChanged time (AFTER the preset wrote it)
let enabled = false;      // true once a usable renderer arrived via setContext
let scale = 1;            // controller output, clamped to current bounds
let appliedRatio = -1;    // last ratio actually pushed to renderer/composer

// Moving-average ring over raw frame ms (allocation-free after warmup).
const avgBuf = new Float32Array(AVG_WINDOW);
let avgHead = 0;
let avgCount = 0;
let avgSum = 0;

// Control state.
let decisionT = 0;        // seconds accumulated toward the next decision
let outRun = 0;           // consecutive out-of-band decisions (hysteresis)
let comfortT = 0;         // seconds continuously inside the comfort band
let activeLast = true;    // previous-frame activity flag (pause-gap detection)

// --- internals --------------------------------------------------------------

function boundsFor(quality) {
  return BOUNDS[quality] || BOUNDS.high;
}

function sanitizePR(v) {
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/**
 * Push window.__IW_DYNRES_SCALE per the shared convention: finite number while
 * active, null while disabled or unwired. Cheap enough to call on every change.
 */
function publish() {
  if (typeof window !== 'undefined') {
    window.__IW_DYNRES_SCALE = enabled ? scale : null;
  }
}

/**
 * Quantize basePR*scale to QUANTUM steps before pushing. Pixel-ratio jitter
 * smaller than ~5% buys nothing visually but churns render-target reallocation
 * on every change; stepping keeps the applied value stable while the internal
 * controller moves in finer 0.03 increments. Both setters re-apply size
 * internally in three r166 (WebGLRenderer / EffectComposer), so no extra
 * setSize call is needed here.
 */
function applyRatio(force) {
  if (!enabled || !renderer) return;
  const b = boundsFor(G.settings && G.settings.quality);
  const raw = basePR * clamp(scale, b.lo, b.hi);
  const ratio = Math.max(QUANTUM, Math.round(raw / QUANTUM) * QUANTUM);
  // Publish BEFORE the dedup gate: adjacent internal scales can quantize into
  // the same pixel-ratio bucket (0.67 and 0.65 both -> 1.0 at basePR 1.5).
  // Skipping the redundant setPixelRatio is correct; letting the shared
  // __IW_DYNRES_SCALE contract lag a bucket behind getScale() is not.
  publish();
  if (!force && Math.abs(ratio - appliedRatio) < QUANTUM * 0.5) return;
  appliedRatio = ratio;
  try {
    renderer.setPixelRatio(ratio);
  } catch (_) { /* lost context: keep the last good ratio */ }
  if (composer) {
    try {
      composer.setPixelRatio(ratio);
    } catch (_) { /* composer swapped mid-flight: renderer is still scaled */ }
  }
}

/** One control decision from the current moving average (ms). */
function decide(avgMs) {
  const b = boundsFor(G.settings && G.settings.quality);
  scale = clamp(scale, b.lo, b.hi); // self-heal after quality-tier switches

  if (avgMs <= BAND_HI && avgMs >= BAND_LO) {
    // Comfortable: reset hysteresis, accumulate quiet time, then creep back
    // toward full resolution one small step per decision. The clamp makes the
    // effective recovery target min(1.0, tier ceiling), so medium/low stop at
    // their own bounds instead of overshooting the preset's intent.
    outRun = 0;
    comfortT += DECISION_INTERVAL;
    if (comfortT >= RECOVERY_AFTER && scale < b.hi - 1e-4) {
      scale = clamp(scale + RECOVERY_STEP, b.lo, b.hi);
      applyRatio(false);
    }
    return;
  }

  // Out of band: only act after CONFIRM_DECISIONS agreeing reads so one noisy
  // second (a spawn burst, a GC hiccup) cannot move the resolution.
  comfortT = 0;
  outRun++;
  if (outRun < CONFIRM_DECISIONS) return;
  outRun = 0;
  const dirDown = avgMs > BAND_HI; // too slow -> shed pixels; too fast -> add
  const next = clamp(scale + (dirDown ? -STEP : STEP), b.lo, b.hi);
  if (Math.abs(next - scale) > 1e-4) {
    scale = next;
    applyRatio(false);
  }
}

function resetAveraging() {
  avgHead = 0;
  avgCount = 0;
  avgSum = 0;
  decisionT = 0;
  outRun = 0;
  comfortT = 0;
}

// --- public API -------------------------------------------------------------

/** Boot the controller. Idempotent; advertises 'disabled' until wired. */
export function createDynRes() {
  if (inited) return;
  inited = true;
  enabled = false;
  scale = 1;
  appliedRatio = -1;
  resetAveraging();
  publish();
}

/**
 * Hand over the render objects once, after boot creates them. A missing or
 * non-three renderer leaves the module permanently disabled (publishes null)
 * rather than throwing - a broken subsystem must never crash boot. Call this
 * exactly once per renderer instance: basePR is captured from the CURRENT
 * pixel ratio, so re-calling it after we have already scaled would mistake our
 * own scaled value for the preset base.
 */
export function setContext(ctx) {
  const r = ctx && ctx.renderer;
  if (!r || typeof r.setPixelRatio !== 'function') {
    enabled = false;
    renderer = null;
    composer = null;
    publish();
    return;
  }
  renderer = r;
  composer = ctx.composer && typeof ctx.composer.setPixelRatio === 'function'
    ? ctx.composer
    : null;
  basePR = sanitizePR(r.getPixelRatio());
  enabled = true;
  resetAveraging();
  applyRatio(true); // force: establish our quantized baseline immediately
}

/**
 * Quality preset changed. MUST be called by the integrator inside applyQuality
 * AFTER the preset wrote its own base pixel ratio, because that write is what
 * gets re-captured as basePR. Re-clamps the running scale into the new tier's
 * bounds and re-applies. No-op until setContext succeeded.
 */
export function onQualityChanged() {
  if (!enabled || !renderer) return;
  basePR = sanitizePR(renderer.getPixelRatio());
  const b = boundsFor(G.settings && G.settings.quality);
  scale = clamp(scale, b.lo, b.hi);
  applyRatio(true);
}

/**
 * Feed one raw frame delta (seconds, unscaled). Skips ALL work while the tab
 * is hidden or the game paused - those frames do not represent rendering load,
 * and acting on them would chase artifacts like the single huge dt after a tab
 * switch. On the first frame back from such a gap the averaging window is
 * dropped so stale pre-pause samples cannot drive a decision.
 */
export function updateDynRes(rawDt) {
  if (!enabled) return;
  const hidden = typeof document !== 'undefined' && document.hidden;
  if (hidden || G.paused) {
    activeLast = false;
    return;
  }
  if (!activeLast) {
    activeLast = true;
    resetAveraging(); // drop samples from before the pause/hide gap
  }

  const dt = Number(rawDt);
  if (!Number.isFinite(dt) || dt <= 0) return;
  // A delta larger than the clamp ceiling is a GAP (tab switch, debugger halt,
  // hitch storm), not a rendered frame. It must be dropped whole, exactly like
  // the paused path drops its frames: clamping it into the average would still
  // poison a warmup window with one fake 250ms sample, and feeding raw dt to
  // decisionT below would mint a storm of stale-average decisions after every
  // long gap (each one able to confirm a step). Reset instead - the first real
  // frame back starts a fresh window, mirroring resume-from-pause semantics.
  if (dt > DT_CLAMP_S) {
    resetAveraging();
    return;
  }
  const ms = dt * 1000;
  feedFrameMs(ms, dt);
}

/**
 * Shared decision path: push one frame's ms into the moving average and run
 * the hysteresis decision on its cadence clock. Split out so the E2E debug
 * seam below feeds byte-identical logic.
 */
function feedFrameMs(ms, dtSeconds) {
  if (avgCount < AVG_WINDOW) avgCount++;
  else avgSum -= avgBuf[avgHead];
  avgBuf[avgHead] = ms;
  avgSum += ms;
  avgHead = (avgHead + 1) % AVG_WINDOW;

  decisionT += dtSeconds;
  if (decisionT < DECISION_INTERVAL) return;
  decisionT -= DECISION_INTERVAL; // carry the remainder so cadence stays honest
  decide(avgSum / avgCount);
}

/**
 * Test/E2E seam: feed synthetic frame times directly into the SAME average +
 * decision path as real frames, bypassing the hidden/paused activity gates
 * (a paused game drops ALL frames by design, which would also drop synthetic
 * ones and make browser specs non-deterministic). Production code never calls
 * this; window.__IW.dynres exposes it to automation only.
 */
export function debugFeed(ms) {
  if (!enabled) return;
  const v = Number(ms);
  if (!Number.isFinite(v) || v <= 0) return;
  activeLast = true;
  feedFrameMs(Math.min(v, DT_CLAMP_S * 1000), DECISION_INTERVAL / 10);
}

/** Current controller scale (number), or null while disabled/unwired. */
export function getScale() {
  return enabled ? scale : null;
}
