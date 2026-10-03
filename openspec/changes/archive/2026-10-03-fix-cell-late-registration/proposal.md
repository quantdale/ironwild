## Why

Two P2 findings from the post-archive review of `fix-cell-streaming-initial-hide`:

1. **Late registration leaks a permanently-visible batch** (`src/world/cells.js`). `register()` unconditionally shows the new record (`setRecordShown(rec, true)`), even when the target cell has already been streamed and is out of band. The manager only ever re-judges a cell when the anchor band state changes, so the late record stays visible indefinitely and breaks the "every cell outside the exit radius has its records hidden" invariant.
2. **The movement E2E test can pass without any streaming transition** (`tests/e2e/cell-streaming.spec.js`). `active < registered` already holds before the teleport, and the destination `x = 600` exceeds the soft world border (`playRadius + 25 = 295`), so the player gets clamped back and no transition is ever exercised.

## What Changes

- **Adopt the evaluated cell state on registration** in `src/world/cells.js`: when a record is added to a cell whose `streamed` flag is already set and whose `active` flag is false, the new record is hidden immediately instead of leaking visible. Pre-first-decision cells keep pre-streaming parity (shown), so the title-screen/first-frame behavior is unchanged.
- **Add unit regression coverage** for late registration into an already-hidden cell (hidden immediately, adopts band state on later passes, counters stay coherent) and for parity of a late registration into a never-evaluated cell.
- **Fix the movement E2E** to (a) teleport to a reachable destination (~240u from spawn, inside the 295u border), (b) require an observable transition of the visible-`InstancedMesh` set before asserting counters, instead of re-asserting a state that already held.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `world-streaming`: adds the late-registration adoption rule to the existing spec.

## Impact

- Affected code: `src/world/cells.js` (`register`); tests: `tests/unit/cell-streaming.test.js`, `tests/e2e/cell-streaming.spec.js`.
- No public API signatures, persistence formats, or gameplay rules change. The only live registration path (`src/world/props.js`, at build time, before the first streamed pass) is unaffected because those cells are not yet `streamed`.
