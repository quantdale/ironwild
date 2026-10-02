# Tasks — Fix cell streaming initial-hide (world-streaming)

## 0. Cross-change coordination (read before editing)

This change is scoped tightly to `src/world/cells.js` and a new unit suite, so it has **no file-edit conflicts** with any sibling change:

- `retire-dead-scaffolding` deletes unused exports from `src/world/lod.js`. This change keeps using `groupInstancesByCell` (the one symbol `props.js` actually imports) and treats the `lod.js` helpers as explicitly out of scope. No overlap — but if you want the streaming fix to land against a stable import surface, apply the cleanup first.
- `fix-hud-telemetry-accuracy` changes the machine population cap (`CONFIG` + `ai.js MACH_CAP`). The streaming band is measured in world units and is independent of population, so the two do not interact.

## 1. Fix the visibility state machine

- [x] 1.1 In `src/world/cells.js`, add a per-cell `streamed` boolean (default `false`) to the record produced by `makeCell()`, to distinguish "never judged against an anchor" from "judged and currently out of band".
- [x] 1.2 Rework the visibility branch in `updateCells()`. On a cell's first evaluation against a valid anchor, use the entry radius (`d2 <= active2`): hide records outside it even when `cell.active` is already false. On later passes, keep both radii: show only at `d2 <= active2`, hide only at `d2 > deact2`, and do not toggle while the anchor sits between them. Do not replace the two radii with `d2 <= deact2`, and do not skip the first hide because `active === false`. Call `setRecordShown()` rather than writing `group.visible` directly.
- [x] 1.3 Preserve the pre-adoption parity: when the manager has not yet been given a valid anchor, return early and leave all registered content visible. On the first pass that does have a valid anchor, cells out of band must be hidden in that same pass (this is the actual fix).
- [x] 1.4 Mark `cell.streamed = true` on the first pass in which the cell is evaluated against a valid anchor, so a later out-of-band cell is always hidden even if it was never in band.
- [x] 1.5 Keep the shadow-caster budget block (`shadowRadius`, entry/exit hysteresis at 1.18x) operating on the same `d2` value and independent of the `active`/`streamed` flags; verify it still writes `castShadow` only on transitions.
- [x] 1.6 Do not change the `cellHooks.onCellApproaching` prefetch latch behavior, the `retire()` bookkeeping, or any exported name/signature.

## 2. Counter and invariant correctness

- [x] 2.1 Verify `getCellStats()` returns `{ registered, active, retired }` where `active` equals the number of live records whose shown flag is true, and `registered` equals the number of live (non-retired) records.
- [x] 2.2 Confirm `setRecordShown()` cannot drive `totalShown` negative or above `totalRegistered` across repeated passes with a moving anchor (activate → deactivate → activate cycles).
- [x] 2.3 Confirm `totalRetired` bookkeeping is unaffected: retiring records decrements `registered`, and `active` drops accordingly when retired records were shown.

## 3. Unit regression coverage

- [x] 3.1 Add a new unit suite (e.g. `tests/unit/cell-streaming.test.js`) using the existing node-env pattern (`vi.resetModules()` + dynamic import, plain stub groups instead of WebGL) with no changes to product code.
- [x] 3.2 Case: register a batch in a far cell, run one `updateCells()` with a near anchor → far group's `visible` is `false`, near group's `visible` is `true`.
- [x] 3.3 Case: pre-adoption parity — after `register()` and before any `updateCells()` call, the registered group is `visible: true`.
- [x] 3.4 Case: never-active cell stays hidden — register far, evaluate (hides it), move the anchor away further, evaluate again → still hidden; and a cell that was visible then goes out of band → becomes hidden.
- [x] 3.5 Case: counter invariant — after several passes with a moving anchor, `getCellStats().active` equals the manually counted shown live records.
- [x] 3.6 Case: hysteresis — a never-evaluated cell between the entry and exit radii is hidden on the first pass; a cell already shown in that band stays shown; only past the wider exit radius hides a shown cell. Oscillating inside the band does not toggle.
- [x] 3.7 Case: non-finite / missing anchor is ignored and content stays visible (no throw).
- [x] 3.8 Case: retiring all records of a cell removes the cell and decrements `registered`/`active` correctly.

## 4. Integration verification

- [x] 4.1 Run `npm test` (vitest) — all unit suites pass including the new one.
- [x] 4.2 Run `npm run lint` — clean.
- [x] 4.3 Run `npm run build` — succeeds with no new warnings beyond the pre-existing chunk-size notice.
- [x] 4.4 Run the production build under `vite preview` and confirm with a headless probe that, at the spawn meadow, `window.__IW_PERF_CELLS().active` is strictly less than `registered`, and the count of visible instanced meshes is lower than the total registered.
- [x] 4.5 Capture a fresh `node scripts/perf-capture.mjs` run (hardware GL via `IW_E2E_GPU=1` if available, else label software GL) and confirm the spawn-meadow draw-call and triangle counts drop relative to `docs/perf/baseline-45cfa51-inteluhd.txt`.
- [x] 4.6 Re-run the existing Playwright suite (`npx playwright test`) — all specs still pass and the world renders vegetation at the spawn point (no regression into an empty-looking world).
- [x] 4.7 Walk the player to a previously-unculled region and confirm vegetation fades in without a visible pop (manual/visual validation, or via the cell counters in an automated probe).

## 5. Documentation

- [x] 5.1 Update the module header comment in `src/world/cells.js` to describe the corrected first-pass behavior and the `streamed` flag, replacing any statement implying far cells stay visible indefinitely.
- [x] 5.2 Note the corrected baseline in `docs/perf/` only if the fresh capture materially changes the recorded numbers, keeping the commit SHA and renderer attribution format used by the existing baseline file.
