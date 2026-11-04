# Design — Fix cell streaming initial-hide (world-streaming)

## Context and evidence

The Wave D spatial cell manager lives in `src/world/cells.js`. Producers (`src/world/props.js: installCellBatches`) stage placement matrices, group them by 60-unit grid cell (`src/world/lod.js: groupInstancesByCell`), build one `InstancedMesh` per cell, and register each with the manager. The manager is supposed to keep only a band of cells around the player visible.

### The defect (current-state analysis)

Three pieces of state interact incorrectly:

1. `makeCell()` initializes `cell.active = false` and `cell.approached = false`.
2. `register()` calls `setRecordShown(rec, true)`, which sets `rec.shown = true` and increments `totalShown`. This is the documented "pre-streaming parity" (everything visible until the first pass).
3. `updateCells()` visibility band logic is:

```js
if (cell.active) {
  if (d2 > deact2) { cell.active = false; /* hide */ }
} else if (d2 <= active2) {
  cell.active = true; /* show (no-op, already shown) */
}
```

The deactivation branch is guarded by `cell.active`. A cell that is out of band on the first pass never sets `active = true`, so it never reaches the branch that hides it. It stays `active:false, shown:true` forever. Only cells the player physically enters (becoming active) can ever later be hidden.

### Runtime evidence (measured, not inferred)

A headless probe against the production build (`vite preview`, Playwright/Chromium) with the game started and the player at the spawn meadow (0, 8):

- `__IW_PERF_CELLS()` → `{registered: 279, active: 279, retired: 0}` (every batch "active").
- Scene traversal → 291 instanced meshes, **291 visible**.
- After teleporting the player to (75, -75) and letting one pass run → `{registered: 279, active: 263}` and 275/291 visible (only the previously-near cells deactivated).

The committed perf baseline `docs/perf/baseline-45cfa51-inteluhd.txt` corroborates: 843 draw calls / 931,833 triangles at the spawn meadow, dropping to 505 calls / 609,629 triangles only in the dense-forest scenario (where the player has moved). If streaming worked from the first frame, spawn should not carry the whole world's cost.

## Goals / non-goals

### Goals

- A registered cell outside the band reaches hidden within the first streaming pass.
- The `visible ⇔ in-band` invariant holds for every live record on every pass.
- Preserve the deliberate "no all-hidden flash before the first decision" property.

### Non-goals

- Changing cell size, band radii, hysteresis numbers, or the shadow-radius budget.
- Changing the resident-vs-streamed split policy (gameplay state stays resident).
- Adding new content types or retuning the `lod.js` helpers (covered elsewhere).

## Chosen approach

> **Plan correction.** An earlier draft used one predicate, `inBand = d2 <= deact2`, and skipped work when `cell.active === inBand`. That rule reintroduces the bug: a never-activated far cell has `active === false` and `inBand === false`, so nothing hides it. Do not implement that draft.

Keep the two radii that already exist in `src/world/cells.js`:

- entry: `d2 <= active2` (`ACTIVE_DIST`, 2 cells)
- exit: `d2 > deact2` (`DEACT_DIST`, 2.6 cells)

Add `cell.streamed`, default `false`, set true the first time that cell is evaluated against a finite anchor.

For every cell on a pass that has a finite anchor:

1. If `!cell.streamed`, the first evaluation uses the **entry** radius. `d2 <= active2` shows and sets `active`. Otherwise hide and set `active = false`, even though `active` was already false. Then set `streamed = true`.
2. If `cell.streamed`, use hysteresis. Hide only when `active && d2 > deact2`. Show only when `!active && d2 <= active2`. Between the radii, leave the previous state unchanged.
3. A missing or non-finite anchor still returns before this decision and leaves registered content visible.

`setRecordShown()` remains the only visibility writer. The shadow-radius block keeps its own `d2` comparisons and its 1.18x exit hysteresis; it is not gated on `streamed`.

### Why not one in-band predicate?

`d2 <= deact2` cannot express "enter at 2 cells, leave at 2.6". Using the exit radius on the first pass would also show cells in the hysteresis gap that the entry rule would hide. The `streamed` flag is what lets the first pass hide a cell whose `active` flag is still false without collapsing later hysteresis.

`setRecordShown` is already idempotent, so repeating the decision every pass does not churn the scene graph. There are on the order of 121 cells.

### Alternatives considered

- **Global "adopt" pass** (on first update, hide every out-of-band cell). Rejected: it collapses the intentional gradual-adoption behavior and would cause a one-frame content pop on the very first streamed frame; the per-cell predicate approach yields the same end state with no pop.
- **Seeding `cell.active = true` at registration.** Rejected: it would make the counter meaningless before the first pass and forces an extra write on every record.

## Data model / state changes

Per cell, in addition to existing fields, add a boolean `streamed` (default false) set to true the first time the cell is evaluated against an anchor. Used only to decide whether the not-in-band hide is "authoritative" (hide) or "pre-adoption" (leave visible).

No changes to the public API (`register`, `updateCells`, `retire`, `getCellStats`, `cellHooks.onCellApproaching`, `CELL_SIZE`, `RETIRE_CELLS`). No changes to persistence, gameplay, or rendering beyond visibility.

## Failure / edge handling

- Non-finite or missing anchor: keep the current guard (return early, leave content visible) — preserves pre-adoption parity.
- A cell whose records were all retired: the per-record loop already skips `retired` records; the cell is deleted from the map when empty.
- The shadow-budget block (`shadowRadius`) is independent and continues to use `cell.active`-independent `d2` comparisons; it is not gated by the streaming fix.

## Rollout / compatibility

Purely internal to the manager. Downstream consumers (`props.js`, `perf.js` via `__IW_PERF_CELLS`) already read the counters generically and will simply begin reporting truthful values. No migration, no compatibility concerns.

## Testing strategy

Unit tests (node env, no WebGL) against `src/world/cells.js` with a fake scene and plain `Object3D`-like groups:

1. Register a batch in a far cell, run one `updateCells` with a near anchor → far group hidden, near group visible.
2. Register a batch, then move the anchor far → the previously-far (never-active) batch stays hidden; the previously-near batch hides.
3. Counter invariant: `active === number of live records with shown=true`, `registered === live records`.
4. Adoption parity: before any evaluation, a registered batch is visible; after the first evaluation, out-of-band batches are hidden.
5. Hysteresis: an anchor just past the entry radius keeps the cell active; only past the (wider) exit radius hides it.
6. Gamepad/other producers unaffected: registering the same cell key twice accumulates records; retiring empties and deletes the cell.

E2E: extend the existing cell/telemetry coverage (or add a small spec) to assert that after starting a run at spawn, `__IW_PERF_CELLS().active` is strictly less than `registered` — the observable symptom of the bug.

## Risks

- Under-hiding if a producer relies on the old "always visible until entered" behavior. Audit shows only `props.js` registers batches, all purely decorative; gameplay state is explicitly resident. Low risk.
- Over-hiding causing visible pop: mitigated by the entry/exit hysteresis and the rect-distance rule already in place.
