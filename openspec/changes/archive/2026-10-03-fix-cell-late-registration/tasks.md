# Tasks — Fix cell late-registration leak + movement E2E transition check

## 1. Registration-state handling

- [x] 1.1 In `src/world/cells.js` `register()`, after the parity `setRecordShown(rec, true)`, hide the record when the target cell has already been evaluated (`streamed === true`) and is out of band (`active === false`).
- [x] 1.2 Keep pre-first-decision parity: never-evaluated cells still show the record until the first `updateCells` pass.
- [x] 1.3 Use `setRecordShown` so `totalShown` and `onDeactivate` callbacks stay consistent.

## 2. Regression coverage

- [x] 2.1 Unit: late registration into an already-hidden cell is hidden immediately, counters agree, and the record adopts band state on later passes.
- [x] 2.2 Unit: late registration into a never-evaluated cell keeps parity until its first pass, then hides like any out-of-band cell.
- [x] 2.3 E2E: movement spec requires an observable visible-batch transition (not a re-assertion of the pre-teleport invariant) and uses a reachable destination inside the soft border.

## 3. Validation

- [x] 3.1 `npx vitest run tests/unit/cell-streaming.test.js` passes.
- [x] 3.2 `npm run lint` clean.
- [x] 3.3 `npm test` — all unit suites pass.
- [x] 3.4 `npm run build` succeeds; `npx playwright test tests/e2e/cell-streaming.spec.js` — both specs pass.
