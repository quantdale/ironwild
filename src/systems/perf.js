// IRONWILD - runtime performance telemetry + developer HUD (Wave A).
// Passive, near-zero-cost instrumentation: a rolling frame-time ring buffer,
// lazily computed percentile stats, allocation-free named CPU marks, periodic
// renderer.info / scene-counter / JS-heap captures, and a hidden F3 overlay.
//
// Design rules:
//   - updatePerf(rawDt) is the only hot-path entry point; with the HUD hidden
//     it does O(ring push + marks snapshot) work and ZERO DOM access.
//   - Anything expensive (percentile sort, report/HUD string assembly) runs at
//     most ~4x/sec and only on demand (HUD paint / getReport callers).
//   - Every external dependency is feature-detected and failure-isolated:
//     renderer.info, performance.memory (Chromium only), window.__IW_PERF_CELLS
//     (getter another module may publish), window.__IW_DYNRES_SCALE (published
//     by systems/dynres.js - identical definition on both sides: finite number
//     while dynamic resolution is active, null while disabled). A missing or
//     broken source degrades to a dash/null in the report, never a throw.
//
// Integrator wiring (main.js owns the loop):
//   createPerf();                      // boot, once (idempotent)
//   beginMark('sim'); ... endMark('sim');
//   beginMark('render-submit'); ... endMark('render-submit');
//   updatePerf(rawDt);                 // LAST line of the frame, raw unscaled dt
// F3 toggles the HUD (own keydown listener, installed once).

import { G } from '../core/state.js';

// --- tuning -----------------------------------------------------------------

const RING_CAP = 240;         // ~4s of frame times at 60 Hz
const STATS_INTERVAL = 0.25;  // seconds between percentile recomputes (lazy)
const INFO_INTERVAL = 1.0;    // renderer.info + heap capture cadence
const HUD_INTERVAL = 0.25;    // HUD repaint cadence while visible
const DT_CLAMP_MS = 250;      // tab-switch resumes push one huge dt; cap it so
                              // percentiles stay representative of real frames
const TOP_MARKS = 6;          // marks shown in the HUD / report

// --- module state -----------------------------------------------------------

let inited = false;

// Frame-time ring (ms). Slots [0..ringCount) are live: the head only wraps
// after the buffer has been filled once, so a prefix scan is always exact.
const ringMs = new Float32Array(RING_CAP);
let ringHead = 0;
let ringCount = 0;
let sumMs = 0; // running mean numerator, maintained incrementally
const sortScratch = new Float32Array(RING_CAP); // reused, sorted in place
const stats = { avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };

// Timers (own clock fed by raw dt; G.elapsed is gameplay-scaled and pauses).
let tStats = STATS_INTERVAL;  // forces a first refresh on the opening frame
let tInfo = INFO_INTERVAL;
let tHud = HUD_INTERVAL;

// Named CPU marks. Parallel arrays instead of a Map: label lookup is a short
// linear scan over a handful of entries, and the per-frame snapshot walks the
// arrays with plain index loops - no iterators, no allocations after warmup.
const markNames = [];
const markAcc = [];   // ms accumulated inside the CURRENT frame
const markLast = [];  // ms attributed to the LAST completed frame
const markTotal = []; // lifetime ms per label (session-wide accounting)
const markOpenAt = [];// performance.now() stamp while open, -1 when closed

// Captured snapshots (written by the periodic refreshes, read by report/HUD).
let giHas = false;                 // did we ever see a usable renderer.info?
let giCalls = 0, giTris = 0, giGeo = 0, giTex = 0, giProg = 0;
let giMemGeo = null, giMemTex = null;   // renderer.info.memory when present
let heapMB = null;                 // performance.memory?.usedJSHeapSize / MiB
let scMachines = 0, scArrows = 0, scPickups = 0;
let cellsVal = null;               // pass-through of __IW_PERF_CELLS() output
let assetsVal = null;              // pass-through of __IW_PERF_ASSETS() output
let qualityVal = 'high';
let dynVal = null;                 // mirrors window.__IW_DYNRES_SCALE

// Shared report object handed out by getReport(). Mutated in place: callers
// must read it immediately, not retain it across frames.
const report = {
  fps: 0,
  frames: 0,
  frameMs: { avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 },
  gpu: { calls: 0, triangles: 0, geometries: 0, textures: 0, programs: 0 },
  memory: { heapMB: null, gpuGeometries: null, gpuTextures: null },
  scene: { machinesAlive: 0, arrows: 0, pickups: 0 },
  assets: null,
  cells: null,
  quality: 'high',
  dynResScale: null,
  hasGpuInfo: false, // true once a usable renderer.info was captured
  marks: [], // [{ name, ms, totalMs }] sorted desc by last-frame ms, capped
};

// --- developer HUD ----------------------------------------------------------

let hudEl = null;
let hudTextEl = null;
let hudVisible = false;

function isEditableTarget(t) {
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable === true;
}

function onHudKey(e) {
  if (e.key !== 'F3') return;
  if (isEditableTarget(e.target)) return; // don't hijack text entry fields
  e.preventDefault();                     // stop the browser's own F3 binding
  toggleHud();
}

/**
 * Builds the overlay DOM once. Hidden by default; never steals input.
 * Fully failure-isolated: a partial/hostile document (headless test envs ship
 * `document` with no createElement; some embeds have no body) must degrade to
 * "no overlay" rather than throw out of createPerf/toggleHud - telemetry is
 * optional by contract. Atomic assignment keeps the hudEl/hudTextEl pair
 * consistent: either both are usable or both stay null.
 */
function installHud() {
  if (hudEl || typeof document === 'undefined') return;
  try {
    const el = document.createElement('div');
    el.id = 'iw-perf-hud';
    const s = el.style;
    s.position = 'fixed';
    s.top = '8px';
    s.left = '8px';
    s.zIndex = '9999';
    s.font = '11px/1.5 ui-monospace, Menlo, Consolas, monospace';
    s.color = '#d7fbe8';
    s.background = 'rgba(8, 14, 10, 0.72)';
    s.padding = '6px 9px';
    s.borderRadius = '6px';
    s.pointerEvents = 'none';
    s.whiteSpace = 'pre';
    s.textShadow = '0 1px 2px rgba(0,0,0,0.8)';
    s.display = 'none'; // hidden by default - hudVisible starts false and
                        // toggleHud owns the only display flips
    const textEl = document.createElement('div');
    el.appendChild(textEl);
    (document.body || document.documentElement).appendChild(el);
    hudEl = el;
    hudTextEl = textEl;
  } catch (_) { /* no real DOM available: only the overlay is lost */ }
}

function fmtTris(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function fmtCells(c) {
  if (c == null) return '-';
  try {
    const s = JSON.stringify(c);
    return s.length > 48 ? s.slice(0, 45) + '...' : s;
  } catch (_) {
    return '[unprintable]';
  }
}

/** One textContent write per repaint: the whole panel is a single text node. */
function paintHud() {
  if (!hudEl || !hudVisible) return;
  const r = getReport();
  const f = r.frameMs;
  const lines = [];
  lines.push(`FPS ${r.fps}  ${f.avg.toFixed(1)}ms avg  ` +
    `p50 ${f.p50.toFixed(1)} / p95 ${f.p95.toFixed(1)} / p99 ${f.p99.toFixed(1)}` +
    `  (min ${f.min.toFixed(1)} max ${f.max.toFixed(1)})`);
  lines.push(`draw ${r.gpu.calls}  tris ${fmtTris(r.gpu.triangles)}  ` +
    `geo ${r.gpu.geometries}  tex ${r.gpu.textures}  prog ${r.gpu.programs}`);
  lines.push(`machines ${r.scene.machinesAlive}  arrows ${r.scene.arrows}  ` +
    `pickups ${r.scene.pickups}  cells ${fmtCells(r.cells)}`);
  lines.push(`heap ${r.memory.heapMB == null ? '-' : r.memory.heapMB.toFixed(0) + 'MB'}  ` +
    `q ${r.quality}  res ${r.dynResScale == null ? 'off' : 'x' + r.dynResScale.toFixed(2)}`);
  if (r.marks.length) {
    lines.push(r.marks.map(mk => `${mk.name} ${mk.ms.toFixed(1)}`).join(' · ') + ' ms');
  }
  hudTextEl.textContent = lines.join('\n');
}

// --- capture helpers --------------------------------------------------------

function captureRendererInfo() {
  giHas = false;
  try {
    const info = G.renderer && G.renderer.info;
    if (info && info.render) {
      giCalls = info.render.calls | 0;
      giTris = info.render.triangles | 0;
      const mem = info.memory;
      giGeo = mem ? mem.geometries | 0 : 0;
      giTex = mem ? mem.textures | 0 : 0;
      giMemGeo = mem ? mem.geometries : null;
      giMemTex = mem ? mem.textures : null;
      giProg = Array.isArray(info.programs) ? info.programs.length : 0;
      giHas = true;
    }
  } catch (_) { /* context lost or renderer swapped mid-capture: keep last */ }
}

function captureHeap() {
  heapMB = null;
  try {
    const mem = typeof performance !== 'undefined' ? performance.memory : null;
    if (mem && Number.isFinite(mem.usedJSHeapSize)) {
      heapMB = mem.usedJSHeapSize / 1048576;
    }
  } catch (_) { /* privacy-hardened engines hide performance.memory entirely */ }
}

function captureSceneSnapshot() {
  scMachines = 0;
  const machines = G.machines;
  if (Array.isArray(machines)) {
    for (let i = 0; i < machines.length; i++) {
      if (machines[i] && machines[i].alive) scMachines++;
    }
  }
  scArrows = Array.isArray(G.arrows) ? G.arrows.length : 0;
  scPickups = Array.isArray(G.pickups) ? G.pickups.length : 0;

  // Cross-module getters follow the window-publish convention; absence and
  // throwing implementations both degrade to null here.
  cellsVal = null;
  try {
    const fn = typeof window !== 'undefined' ? window.__IW_PERF_CELLS : null;
    if (typeof fn === 'function') cellsVal = fn() || null;
  } catch (_) { /* publisher had a bad tick; show a dash instead of crashing */ }

  assetsVal = null;
  try {
    const fn = typeof window !== 'undefined' ? window.__IW_PERF_ASSETS : null;
    if (typeof fn === 'function') assetsVal = fn() || null;
  } catch (_) { /* publisher had a bad tick; show a dash instead of crashing */ }

  qualityVal = (G.settings && G.settings.quality) || 'high';
  const dv = typeof window !== 'undefined' ? window.__IW_DYNRES_SCALE : null;
  dynVal = typeof dv === 'number' && Number.isFinite(dv) ? dv : null;
}

/** Recompute percentiles/min/max over the live ring prefix. */
function recomputeFrameStats() {
  const n = ringCount;
  if (n === 0) {
    stats.avg = stats.min = stats.max = stats.p50 = stats.p95 = stats.p99 = 0;
    return;
  }
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = ringMs[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    sortScratch[i] = v;
  }
  // Nearest-rank on the ascending scratch copy (Float32Array.sort is numeric).
  const sub = sortScratch.subarray(0, n); // view, no copy
  sub.sort();
  const pick = q => sub[Math.floor(q * (n - 1) + 0.5)];
  stats.avg = sumMs / n;
  stats.min = mn;
  stats.max = mx;
  stats.p50 = pick(0.50);
  stats.p95 = pick(0.95);
  stats.p99 = pick(0.99);
}

function topMarks() {
  const out = [];
  for (let i = 0; i < markNames.length; i++) {
    if (markLast[i] > 0 || markTotal[i] > 0) {
      out.push({ name: markNames[i], ms: markLast[i], totalMs: markTotal[i] });
    }
  }
  out.sort((a, b) => b.ms - a.ms);
  return out.slice(0, TOP_MARKS);
}

/** Refresh the throttled caches when their interval has elapsed. */
function refreshCaches() {
  if (tStats >= STATS_INTERVAL) {
    tStats = 0;
    recomputeFrameStats();
    captureSceneSnapshot();
  }
  if (tInfo >= INFO_INTERVAL) {
    tInfo = 0;
    captureRendererInfo();
    captureHeap();
  }
}

// --- public API -------------------------------------------------------------

/**
 * Boot the telemetry module: builds the hidden HUD and installs the single F3
 * listener. Idempotent - repeated create calls neither duplicate DOM nor
 * listeners (contract: a broken subsystem must never crash boot, so DOM
 * failures are swallowed and only cost the overlay).
 */
export function createPerf() {
  if (inited) return;
  inited = true;
  try {
    installHud();
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', onHudKey);
    }
  } catch (_) { /* telemetry must never block boot */ }
}

/**
 * Feed one raw frame delta (seconds, unscaled - NOT multiplied by G.timeScale).
 * With the HUD hidden the only recurring costs are the ring push, the marks
 * snapshot and two float comparisons for the throttled timers.
 */
export function updatePerf(rawDt) {
  const dt = Number(rawDt);
  if (Number.isFinite(dt) && dt > 0) {
    const ms = Math.min(dt * 1000, DT_CLAMP_MS);
    if (ringCount < RING_CAP) {
      ringCount++;
    } else {
      sumMs -= ringMs[ringHead]; // evict the slot we are about to overwrite
    }
    ringMs[ringHead] = ms;
    sumMs += ms;
    ringHead = (ringHead + 1) % RING_CAP;
    tStats += dt;
    tInfo += dt;
    tHud += dt;
    refreshCaches();
  }

  // Marks snapshot closes the bookkeeping for this frame. A label left open
  // keeps its start stamp; its span lands in whichever frame ends it.
  for (let i = 0; i < markNames.length; i++) {
    markLast[i] = markAcc[i];
    markTotal[i] += markAcc[i];
    markAcc[i] = 0;
  }

  if (hudVisible && tHud >= HUD_INTERVAL) {
    tHud = 0;
    paintHud();
  }
}

function markIndex(name) {
  const key = String(name);
  for (let i = 0; i < markNames.length; i++) {
    if (markNames[i] === key) return i;
  }
  markNames.push(key);
  markAcc.push(0);
  markLast.push(0);
  markTotal.push(0);
  markOpenAt.push(-1);
  return markNames.length - 1;
}

/** Start timing `name`. Re-beginning an open label restarts its stamp. */
export function beginMark(name) {
  markOpenAt[markIndex(name)] =
    (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
}

/** Close `name`; adds the span to this frame's and the lifetime totals. */
export function endMark(name) {
  const key = String(name);
  for (let i = 0; i < markNames.length; i++) {
    if (markNames[i] !== key) continue;
    if (markOpenAt[i] < 0) return; // end without begin: ignore silently
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    markAcc[i] += Math.max(0, now - markOpenAt[i]);
    markOpenAt[i] = -1;
    return;
  }
}

/**
 * Latest telemetry snapshot. Recomputes the lazy caches first if stale.
 * Returns a SHARED object - read it, don't retain or mutate it.
 */
export function getReport() {
  refreshCaches();
  report.fps = stats.avg > 0 ? Math.round(1000 / stats.avg) : 0;
  report.frames = ringCount;
  report.frameMs.avg = stats.avg;
  report.frameMs.min = stats.min;
  report.frameMs.max = stats.max;
  report.frameMs.p50 = stats.p50;
  report.frameMs.p95 = stats.p95;
  report.frameMs.p99 = stats.p99;
  report.gpu.calls = giCalls;
  report.gpu.triangles = giTris;
  report.gpu.geometries = giGeo;
  report.gpu.textures = giTex;
  report.gpu.programs = giProg;
  report.memory.heapMB = heapMB;
  report.memory.gpuGeometries = giMemGeo;
  report.memory.gpuTextures = giMemTex;
  report.scene.machinesAlive = scMachines;
  report.scene.arrows = scArrows;
  report.scene.pickups = scPickups;
  report.cells = cellsVal;
  report.assets = assetsVal;
  report.quality = qualityVal;
  report.dynResScale = dynVal;
  report.marks = topMarks();
  report.hasGpuInfo = giHas;
  return report;
}

/**
 * Show/hide the HUD. force (optional): true=show, false=hide, undefined=flip.
 * Returns the resulting visibility. Repaints immediately so toggling feels
 * instant even between throttled updates.
 */
export function toggleHud(force) {
  installHud(); // tolerate toggle-before-create
  if (!hudEl) return false;
  hudVisible = force === undefined ? !hudVisible : !!force;
  hudEl.style.display = hudVisible ? 'block' : 'none';
  if (hudVisible) paintHud();
  return hudVisible;
}

/**
 * Optional GPU-duration probe on EXT_disjoint_timer_query_webgl2. Deliberately
 * NOT wired into the frame loop - instantiate it around a dedicated benchmark
 * session, bracket the passes of interest, poll once per frame:
 *
 *   const gt = new GpuTimer(G.renderer);
 *   if (gt.begin()) { renderFrame(); gt.end(); }
 *   gt.poll(); // gt.ms fills when the GPU reports back (async, may lag frames)
 *   gt.destroy();
 *
 * Single-bracket by design: one query object is recycled, keeping the helper
 * tiny and allocation-stable. Every method no-ops (false / null) when the
 * extension, the context or the query is unavailable.
 */
export class GpuTimer {
  constructor(renderer) {
    this.ok = false;
    this.ms = null; // last completed measurement in milliseconds
    try {
      const gl = renderer && renderer.getContext && renderer.getContext();
      this._gl = gl;
      this._ext = gl && gl.getExtension('EXT_disjoint_timer_query_webgl2');
      this._query = this._ext ? gl.createQuery() : null;
      this._active = false;
      this.ok = !!this._query;
    } catch (_) { this.ok = false; }
  }

  /** Open the timing bracket. Returns false when unsupported/busy. */
  begin() {
    if (!this.ok || this._active) return false;
    this._gl.beginQuery(this._ext.TIME_ELAPSED_EXT, this._query);
    this._active = true;
    return true;
  }

  /** Close the bracket. The result becomes available a few frames later. */
  end() {
    if (!this.ok || !this._active) return false;
    this._gl.endQuery(this._ext.TIME_ELAPSED_EXT);
    this._active = false;
    return true;
  }

  /**
   * Poll once per frame. Returns the newest known ms (null until the first
   * result lands). A disjoint event means the GPU merged/resets timings, so
   * the stale sample is discarded rather than reported as truth. WebGL2 hands
   * QUERY_RESULT back as a full uint64-valued JS Number (ns) - exact far past
   * any plausible frame duration.
   */
  poll() {
    if (!this.ok || this._active) return this.ms;
    const gl = this._gl;
    const ext = this._ext;
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      this.ms = null;
      return null;
    }
    const ready = gl.getQueryParameter(this._query, gl.QUERY_RESULT_AVAILABLE);
    if (!ready) return this.ms;
    this.ms = gl.getQueryParameter(this._query, gl.QUERY_RESULT) / 1e6;
    return this.ms;
  }

  /** Release the query object; the instance is dead afterwards. */
  destroy() {
    if (this.ok) {
      try { this._gl.deleteQuery(this._query); } catch (_) { /* already gone */ }
    }
    this.ok = false;
    this._active = false;
    this._query = null;
  }
}
