## Context

`src/world/cells.js` tracks per-cell visibility with a `streamed` latch (first evaluation against a valid anchor) and an `active` flag (inside the entry band). `register()` shows every new record unconditionally for pre-streaming parity; that default is only correct before the cell has been evaluated.

## Decision

In `register()`, after the parity show, immediately re-hide the record when the target cell has `streamed === true && active === false`. The cell's band state machine remains the single writer of visibility transitions; registration just stops leaking a stale "shown" into an already-decided hidden cell. Counters stay consistent because `setRecordShown` is used (it maintains `totalShown` and routes through `onDeactivate` when present).

## Alternatives considered

- Re-run the full band evaluation for the cell on every registration: rejected, it would couple registration to the anchor position and cost more than necessary; adoption only needs the cell's current decision.
- Mark the cell dirty and let the next `updateCells` pass fix it: rejected, one stale frame of a "hidden region" batch visible still violates the invariant and can persist if the anchor never re-enters.

## Risks

- A late `register()` into a streamed-but-active cell stays shown — correct.
- Late `register()` into a streamed, inactive cell whose anchor later re-enters the band: the next `updateCells` pass shows it via the `!cell.active && d2 <= active2` branch, which iterates all non-retired records including the new one — covered by a unit test.
