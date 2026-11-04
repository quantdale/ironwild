## Why

The spatial cell streaming system (`src/world/cells.js`) that is supposed to hide world-content batches beyond a radius around the player is inert for the vast majority of the world. On a fresh run at the starting meadow, every one of the 279 registered content batches (291 instanced meshes) reports as visible, and the committed perf baseline shows the full world's triangle/draw-call load being submitted from the first frame. The system only ever *hides* cells that it first saw become active, so any cell the player has not physically walked into is never culled — the exact opposite of the streaming design's intent.

## What Changes

- **Fix the initial-visibility state machine in the cell manager.** `updateCells()` must be able to transition a cell from "registered and visible" to "out of band and hidden" even on its very first streamed pass, instead of only deactivating cells whose `active` flag is already set. A cell outside the activation radius at the first pass must begin hidden (or be driven through the same active→inactive transition), and the pre-streaming "everything visible" parity must only be a *first-frame* default, not a permanent state for far cells.
- **Make the first evaluation able to hide a never-activated cell.** The hide path must run for a cell that starts `active: false` and is outside the entry radius. Later passes keep the existing two-radius hysteresis: enter at 2 cells, leave past 2.6. Do not collapse those radii into one `d2 <= deact2` test, and do not skip a first hide because `active` is already false.
- **Add regression coverage** for "a freshly-registered out-of-band cell becomes hidden after the first `updateCells` pass" and for the counter/`visible` agreement invariant.
- Preserve the existing gradual-adoption property: content must not one-frame flash to hidden before the manager has produced its first streaming decision.

## Capabilities

### New Capabilities
- `world-streaming`: Correct, observable behavior of the spatial cell streaming manager — which registered content batches are visible at any moment, how that state is reached, and the correctness of the reported active/registered counters.

### Modified Capabilities
<!-- None: this is the first specification of the cell-streaming behavior; openspec/specs/ is currently empty. -->

## Impact

- Affected code: `src/world/cells.js` (`makeCell`, `register`, `updateCells`, `getCellStats`); producers/consumers of the manager — `src/world/props.js` (`installCellBatches` registration) and `src/systems/perf.js` (reads `window.__IW_PERF_CELLS` counters).
- Observable effects: per-cell `InstancedMesh.visible` and the `__IW_PERF_CELLS` `{registered, active, retired}` counters now converge to the streaming band instead of reporting the whole world as active. Draw-call and triangle submission drop accordingly.
- No public API signatures, persistence formats, or gameplay rules change.
