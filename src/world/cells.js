// IRONWILD - spatial cell streaming (Wave D).
// World-space grid of CELL_SIZE cells keyed 'cx,cz' via floor(x / CELL_SIZE),
// so keys line up 1:1 with lod.js groupInstancesByCell() at the same size.
// Systems register scene records per cell; updateCells() shows cells near the
// player and hides them beyond a hysteresis band. Activation is strictly
// VISIBILITY-ONLY: groups stay in the scene graph the whole time (no add/remove,
// no GPU reallocation, no reparenting mid-frame).
//
// Resident-vs-streamed split (important): cells gate visibility of bulky,
// purely-decorative batches only. Lightweight GAMEPLAY state - spawn anchors,
// G.pickups records, concealment patches, machine spawns - stays resident in
// its owning system at all times and must never be routed through cells: a
// pickup the player can still walk into must not vanish because its cell slept.
//
// Distances are measured from the anchor position to the cell's XZ rectangle,
// not to its centre: any point d units away always lies in a cell whose rect is
// within d of the anchor, so "activate within ACTIVE_DIST" guarantees visible
// content can never pop off near cell corners (centre-distance schemes can't).
//
// Records start VISIBLE on register: until the first updateCells() call the
// world renders exactly like the pre-streaming build (title screen included,
// since updateProps - and thus updateCells - only runs in the gameplay branch).
// The first streamed update adopts streaming mode gradually through the same
// hysteresis band, so there is no one-frame all-hidden flash at adoption.

// ---- tuning ---------------------------------------------------------------

export const CELL_SIZE = 60;      // grid pitch; keep in sync with groupInstancesByCell callers
const ACTIVE_CELLS = 2;           // activate within 2 cells of the player ...
const DEACT_CELLS = 2.6;          // ... and hide again past 2.6 (hysteresis, no thrash)
const APPROACH_CELLS = 3;         // prefetch ring: fire onCellApproaching once per entry
const RETIRE_CELLS = 5;           // guidance for explicit retire() calls by owners

const ACTIVE_DIST = ACTIVE_CELLS * CELL_SIZE;
const DEACT_DIST = DEACT_CELLS * CELL_SIZE;
const APPROACH_DIST = APPROACH_CELLS * CELL_SIZE;
const APPROACH_EXIT = APPROACH_DIST * 1.05; // small exit hysteresis so the ring edge can't chatter

// ---- module state ---------------------------------------------------------

let inited = false;
const cellsMap = new Map(); // 'cx,cz' -> cell record
let totalRegistered = 0;    // records still live (not retired)
let totalShown = 0;         // live records currently visible
let totalRetired = 0;       // records retired over the session

/**
 * Prefetch hook slot. Asset pipelines assign `cellHooks.onCellApproaching =
 * (cellKey) => {...}`; it fires once when a cell enters the radius-3 ring and
 * re-arms after the cell exits it. Absent handler = prefetch disabled.
 */
export const cellHooks = { onCellApproaching: null };

// ---- internals ------------------------------------------------------------

function makeCell(key) {
  const comma = key.indexOf(',');
  const cx = parseInt(key.slice(0, comma), 10);
  const cz = parseInt(key.slice(comma + 1), 10);
  return {
    key,
    cx,
    cz,
    minX: cx * CELL_SIZE,
    minZ: cz * CELL_SIZE,
    records: [],
    active: false,     // cell-level state machine (band logic in updateCells)
    approached: false, // prefetch latch for this visit
  };
}

function fireApproach(key) {
  const fn = cellHooks.onCellApproaching;
  if (!fn) return;
  try {
    fn(key);
  } catch (err) {
    console.error('[cells] onCellApproaching handler failed:', err);
  }
}

// Show/hide one record through its optional callbacks, defaulting to plain
// visibility toggling. Wrapped so a broken consumer can never take down the
// frame loop (same defensive posture as the rest of the codebase).
function setRecordShown(rec, show) {
  if (rec.shown === show) return;
  rec.shown = show;
  try {
    if (show) {
      if (rec.onActivate) rec.onActivate(rec.group);
      else if (rec.group) rec.group.visible = true;
      totalShown++;
    } else {
      if (rec.onDeactivate) rec.onDeactivate(rec.group);
      else if (rec.group) rec.group.visible = false;
      totalShown--;
    }
  } catch (err) {
    console.error(`[cells] ${show ? 'onActivate' : 'onDeactivate'} failed for "${rec.kind}":`, err);
    // Last-resort fallback so a throwing callback can't leave stale visibility.
    if (rec.group) rec.group.visible = show;
  }
}

// ---- public API -----------------------------------------------------------

/** Canonical cell key for a world position ('cx,cz', unbounded floor grid). */
export function cellKeyAt(x, z) {
  // Non-finite input yields an unmatched key, which simply registers nowhere.
  return `${Math.floor(x / CELL_SIZE)},${Math.floor(z / CELL_SIZE)}`;
}

/**
 * Idempotent boot. Publishes the perf-HUD getter (window.__IW_PERF_CELLS);
 * telemetry tolerates its absence, so this stays safe everywhere.
 */
export function createCells() {
  if (inited) return;
  inited = true;
  if (typeof window !== 'undefined') window.__IW_PERF_CELLS = getCellStats;
}

/**
 * Attach a record {group, kind, onActivate?, onDeactivate?, onRetire?} to a
 * cell. Callbacks are optional; without them activation just flips
 * group.visible. The record starts SHOWN (pre-streaming parity, see header).
 * Lazy-inits the manager so register-before-create call orders just work.
 * Returns the stored record (identity used by retire bookkeeping).
 */
export function register(cellKey, record) {
  createCells();
  const key = String(cellKey); // one canonical namespace even for odd callers
  const rec = {
    group: (record && record.group) || null,
    kind: (record && record.kind) || 'generic',
    onActivate: record && record.onActivate,
    onDeactivate: record && record.onDeactivate,
    onRetire: record && record.onRetire,
    retired: false,
    shown: false,
  };
  let cell = cellsMap.get(key);
  if (!cell) {
    cell = makeCell(key);
    cellsMap.set(key, cell);
  }
  cell.records.push(rec);
  totalRegistered++;
  setRecordShown(rec, true);
  return rec;
}

/**
 * Per-frame streaming pass around `pos` (player position). dt unused today:
 * the pass is O(registered cells), far too cheap to throttle. Guards itself -
 * safe to call before createCells() or with a missing/partial position.
 */
export function updateCells(pos, _dt) {
  if (!inited || !pos) return;
  const px = pos.x;
  const pz = pos.z;
  if (!Number.isFinite(px) || !Number.isFinite(pz)) return;

  const active2 = ACTIVE_DIST * ACTIVE_DIST;
  const deact2 = DEACT_DIST * DEACT_DIST;
  const approach2 = APPROACH_DIST * APPROACH_DIST;
  const approachExit2 = APPROACH_EXIT * APPROACH_EXIT;

  for (const cell of cellsMap.values()) {
    // Squared distance from the anchor to the cell's XZ rectangle.
    const dx = px < cell.minX ? cell.minX - px : px > cell.minX + CELL_SIZE ? px - (cell.minX + CELL_SIZE) : 0;
    const dz = pz < cell.minZ ? cell.minZ - pz : pz > cell.minZ + CELL_SIZE ? pz - (cell.minZ + CELL_SIZE) : 0;
    const d2 = dx * dx + dz * dz;

    // Prefetch ring (radius 3): latch on entry, re-arm once clearly outside.
    if (!cell.approached) {
      if (d2 <= approach2) {
        cell.approached = true;
        fireApproach(cell.key);
      }
    } else if (d2 > approachExit2) {
      cell.approached = false;
    }

    // Visibility band: enter at 2 cells, leave past 2.6. The gap between the
    // thresholds is the hysteresis that stops boundary flicker while strafing
    // a cell edge. Rect distance keeps every point within ACTIVE_DIST shown.
    if (cell.active) {
      if (d2 > deact2) {
        cell.active = false;
        for (const r of cell.records) if (!r.retired) setRecordShown(r, false);
      }
    } else if (d2 <= active2) {
      cell.active = true;
      for (const r of cell.records) if (!r.retired) setRecordShown(r, true);
    }
  }
}

/**
 * Explicit teardown for disposable content (dynamic decals, spawned debris)
 * once its owner decides it's past usefulness - guidance threshold
 * RETIRE_CELLS cells from the player. Deactivates first (callbacks run),
 * then detaches groups from the scene; geometry/material disposal stays with
 * the owner via onRetire because batches routinely SHARE those resources
 * across cells. Static prop cells never need this (hidden draws cost ~0).
 */
export function retire(cellKey) {
  const cell = cellsMap.get(String(cellKey));
  if (!cell) return false;
  for (const r of cell.records) {
    if (r.retired) continue;
    setRecordShown(r, false);
    r.retired = true;
    totalRegistered--;
    totalRetired++;
    try {
      if (r.onRetire) r.onRetire(r.group);
    } catch (err) {
      console.error('[cells] onRetire failed:', err);
    }
    if (r.group && r.group.parent) r.group.parent.remove(r.group);
  }
  cell.records = cell.records.filter((r) => !r.retired);
  if (cell.records.length === 0) cellsMap.delete(String(cellKey));
  return true;
}

/** Live counters for the perf HUD (fresh object each call; cheap). */
export function getCellStats() {
  return { registered: totalRegistered, active: totalShown, retired: totalRetired };
}
