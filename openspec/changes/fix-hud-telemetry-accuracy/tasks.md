# Tasks — Fix HUD & telemetry accuracy (hud-telemetry)

## 0. Cross-change coordination (read before editing)

This change edits four shared files. Sibling changes that also touch them:

- **`src/machines/ai.js`** — this change replaces the local `MACH_CAP` constant; `restore-machine-combat-visuals` adds `playAttack` calls across the same file's attack scripts. **Apply this change first**, or keep the `MACH_CAP` edit in its own commit.
- **`src/ui/hud.js`** — this change rewrites the compass dot pool (`buildDom` / `updateDots`); `honor-accessibility-preferences` adds a CSS rule block to `injectStyles`. Different functions, but the same file: sequence the two, ideally in separate commits.
- **`src/core/state.js`** — this change adds the world machine-cap constant; `sync-project-documentation` adds a cross-module-state header note to the same file. Apply this change first, then the doc note.
- **`scripts/perf-capture.mjs`** — this change extends the sampler; `gate-assets-in-ci` only references it. No edit conflict.

`tests/e2e/telemetry.spec.js` is owned by this change alone.

## 1. Single source of truth for the machine population cap

- [ ] 1.1 In `src/core/state.js CONFIG`, add an explicit world machine cap (e.g. `maxMachinesWorld: 17`) with a comment explaining that it is the ceiling the AI spawner and respawner enforce, distinct from the historical v1 tuning constant.
- [ ] 1.2 In `src/machines/ai.js`, replace the local `const MACH_CAP = CONFIG.maxMachines + 3;` with the new `CONFIG` value; remove the comment claiming the constant is kept local so core tuning stays untouched (that choice is what allowed the drift).
- [ ] 1.3 Verify the resulting population is unchanged: `populateWorld()` must still deal 17 machines and `processRespawns` must still top up to the same cap.
- [ ] 1.4 Confirm no other module derives a population cap from `CONFIG.maxMachines` (check `ui/hud.js`, `ui/minimap.js`, `ui/weakcue.js`, `ui/focus.js` pool sizes) and reconcile each.

## 2. Self-growing compass threat dots

- [ ] 2.1 In `src/ui/hud.js`, stop sizing `dotPool` from `CONFIG.maxMachines` alone; allocate from the real world cap as the initial size.
- [ ] 2.2 In `updateDots()`, if the number of aggro machines exceeds `dotPool.length`, append new `.iw-dot` elements to `#iw-dots` (reusing the same `div('iw-dot', ...)` helper and initial `display:none` state) until the pool covers the current population, so indicators are never silently dropped.
- [ ] 2.3 Preserve the existing behavior: surplus elements are hidden (`style.display = 'none'`) each frame, and the compass-relative positioning math is unchanged.
- [ ] 2.4 Confirm the growth is bounded and stable: re-allocating must not run every frame (only grow when the requirement increases, and never shrink).

## 3. Exclude gap frames instead of truncating them

- [ ] 3.1 In `src/systems/perf.js`, stop clamping stored samples with `Math.min(dt * 1000, DT_CLAMP_MS)`. Store a finite positive sample at its true duration when it is at or below 2000 ms. Exclude non-finite, non-positive, and above-2000 ms samples. Do not reuse `dynres.js`'s 0.25 s controller cutoff; that cutoff would reject the 900 ms hitch this change must report. Leave `dynres.js` behavior unchanged.
- [ ] 3.2 When a sample is excluded, do not push it into the ring; increment a new `excludedFrames` counter and leave the ring and its running mean untouched (correct incremental mean maintenance when nothing is evicted).
- [ ] 3.3 Treat a non-finite or non-positive delta as excluded rather than stored, and assert this in tests so a NaN can never poison the distribution.
- [ ] 3.4 Confirm `recomputeFrameStats()` needs no change: it already reads the ring contents and its `sumMs` bookkeeping is maintained at push time.
- [ ] 3.5 Keep `RING_CAP` and the lazy 0.25 s recompute cadence unchanged (no allocation or cadence regression).
- [ ] 3.6 Update the `DT_CLAMP_MS` comment (or replace the constant) so the header no longer claims a clamp that no longer exists.

## 4. Report live entity counts and unavailable sources

- [ ] 4.1 In `src/systems/perf.js captureSceneSnapshot()`, count live arrows (`G.arrows` entries with `alive === true`) instead of reporting `G.arrows.length`; keep the scan throttled (it runs at the 0.25 s cadence, array is 40 entries) so no hot-path cost is added.
- [ ] 4.2 Add a separate `arrowsPool` field to the report for the fixed capacity, so capacity and live count are both available and not conflated.
- [ ] 4.3 When `renderer.info` is unavailable, set the `gpu.calls` / `gpu.triangles` / geometry / texture / program fields to `null` rather than leaving the previous values, and keep `hasGpuInfo` as the authoritative flag.
- [ ] 4.4 In `paintHud()`, honor `hasGpuInfo`: print a dash (matching the existing `fmtCells` dash convention) instead of `0` for draw calls, triangles, and resource counts when the source is unavailable.
- [ ] 4.5 Surface `excludedFrames` in both `getReport()` and the F3 HUD text, using wording that distinguishes "excluded" from "zero".
- [ ] 4.6 Verify the `report` object is still mutated in place and documented as read-immediately (its existing contract); do not start allocating per call.

## 5. Update tooling and specs that read the report

- [ ] 5.1 In `scripts/perf-capture.mjs sample()`, print `arrows` (live) and `arrowsPool` (capacity) separately, and add `excludedFrames` to the printed line and to the soak growth summary.
- [ ] 5.2 In the soak growth heuristic, decide explicitly whether a rising `excludedFrames` count should be flagged (a capture that is mostly excluded frames is not measuring what it claims); document the decision in the script header.
- [ ] 5.3 Update `tests/e2e/telemetry.spec.js` to the new report semantics (it currently asserts on `getReport()` fields; `scene.arrows` changes meaning).

## 6. Unit coverage

- [ ] 6.1 Extend `tests/unit/perf-dynres.test.js` (existing harness: `vi.resetModules()` + dynamic import, stub renderer/composer):
  - a 900 ms frame is stored and produces a p99 of 900, not 250;
  - a delta above 2000 ms is not pushed into the ring and increments `excludedFrames`;
  - a NaN, zero, or negative delta is excluded, not stored;
  - a normal stream of frames produces zero exclusions.
- [ ] 6.2 Add a case asserting `report.scene.arrows` is 0 for an untouched arrow pool, and that `arrowsPool` still reports the capacity.
- [ ] 6.3 Add a case asserting `hasGpuInfo === false` and gpu fields are `null` when `renderer.info` is missing (not stale zeros).
- [ ] 6.4 Add a case asserting a throwing `window.__IW_PERF_CELLS` publisher leaves the report intact with `cells === null`.
- [ ] 6.5 Add the "single source of truth" lock: assert the machine population cap `ai.js` uses equals the `CONFIG` value (a cheap test that fails loudly if the two drift again).
- [ ] 6.6 Run `npm test` and confirm the full suite passes.

## 7. E2E coverage

- [ ] 7.1 In `tests/e2e/telemetry.spec.js`, assert `getReport().scene.arrows === 0` on a fresh run before firing any arrow (this assertion alone would have caught the pool-size defect).
- [ ] 7.2 Add an assertion that the F3 overlay text contains no `draw 0` figure when renderer info is unavailable, and shows the excluded-frame count when frames have been excluded.
- [ ] 7.3 Confirm the console stays clean across HUD toggles.

## 8. Regenerate and annotate the perf baseline

- [ ] 8.1 Do not rewrite `docs/perf/baseline-45cfa51-inteluhd.txt`; add a short header note (or a companion file) stating that its p99 is the pre-fix clamp value and its `arrows` column is pool size, so it must not be used as a regression baseline.
- [ ] 8.2 After the fix lands, run `node scripts/perf-capture.mjs` (with `IW_E2E_GPU=1` for hardware GL if available, else record the software-GL label) and commit the new capture with commit SHA, renderer, and the new field set, following the existing baseline file's attribution format.
- [ ] 8.3 In the new capture, confirm p99 is not pinned to 250 and that the `arrows` column differs between scenarios. A p99 of 2000 would mean the gap ceiling was stored; that is still a failed capture.

## 9. Documentation

- [ ] 9.1 Update the `src/systems/perf.js` header to document the gap-exclusion policy, the `excludedFrames` counter, and the live-vs-capacity distinction.
- [ ] 9.2 Add a short subsection to `docs/aaa-upgrade/PERFORMANCE_BUDGETS.md` §14 (Instrumentation requirements) noting that p95/p99 exclude tab-resume gap frames, and that a capture reporting many excluded frames is not a valid measurement.
- [ ] 9.3 Note in the `README.md` testing section that telemetry honesty (unclamped tail latency, live entity counts) is covered by `tests/unit/perf-dynres.test.js` and the telemetry E2E spec.

## 10. Final verification

- [ ] 10.1 `npm run lint` clean.
- [ ] 10.2 `npm test` passes.
- [ ] 10.3 `npm run build` succeeds.
- [ ] 10.4 `npx playwright test` — full suite green.
- [ ] 10.5 `git status` shows only telemetry/HUD/CONFIG/tooling/docs changes; no gameplay behavior change.
