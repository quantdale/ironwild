# Tasks — Enforce the permadeath run model (save-persistence)

## 0. Cross-change coordination (read before editing)

This change edits `src/ui/menus.js buildDom()` and `src/main.js`. Sibling changes that also touch them:

- **`complete-input-action-coverage`** edits `menus.js updateMenus()` (panel action reads) in the same module. Different functions, but the same file: **sequence the two, ideally as separate commits.**
- **`harden-core-verification`** edits `src/main.js` only as a test target (no code change) and extends the save unit suite that this change consumes. Apply it first if possible so the lifecycle tests have a home to extend; this change's task 4.1 already refers to that suite.
- **`sync-project-documentation`** edits the `setPanelHtml` comment in `menus.js` — comment-only, apply last.

## 1. Add the run lifecycle to the save slot

- [ ] 1.1 In `src/systems/save.js`, add an optional `run` field to the serialized payload: `{ ended: boolean, endedAt: number }`, written only on termination. Keep the rest of the snapshot shape unchanged.
- [ ] 1.2 Add `hasRestorableRun()` that returns true only when a save slot exists, parses, and does **not** carry `run.ended === true`. Treat any missing, non-boolean, or malformed `run` value as "not ended" (a corrupt field must never brick a live run).
- [ ] 1.3 Keep `hasSave()` as a slot-presence check (do not change its meaning) — the fix depends on the two predicates being distinct.
- [ ] 1.4 In `loadGame()`, add an early rejection for a save whose `run.ended === true` (return `false`, no mutation of `G`).
- [ ] 1.5 Ensure a save written **without** a `run` field still loads (backward compatibility for existing v2/v3 saves).

## 2. Mark the run ended on death

- [ ] 2.1 In `src/systems/save.js initSave()`, subscribe to `bus.on('playerDied')` and add an internal `markRunEnded()` handler that writes the terminated run's snapshot with `run: { ended: true, endedAt: <elapsed> }` directly to the slot.
- [ ] 2.2 Confirm the mark write cannot be skipped by the `!G.gameOver` guard on `saveGame()` — the handler composes the payload itself rather than calling `saveGame()`.
- [ ] 2.3 Verify frame ordering: `playerDied` is emitted during the sim step, before the per-frame save tick, so the mark is written before any later save could occur; add a comment recording this ordering dependency.
- [ ] 2.4 Make the mark write failure-safe: if the write throws or the slot is unparsable, fall back to `clearSave()` so a finished run is not left restorable; never throw into the death flow.
- [ ] 2.5 Keep `menus.js onPlayerDied` responsible for presentation only (it must not gain direct knowledge of persistence); preserve the existing `deathHandled` one-shot guard.

## 3. Start-screen presentation

- [ ] 3.1 In `src/ui/menus.js buildDom()`, replace the `saveAvailable()` gate for the CONTINUE button with the new restorable predicate.
- [ ] 3.2 Keep the NEW RUN button rendered whenever a slot exists (including a finished run), so the player can deliberately start over; its existing `clearSave() + location.reload()` behavior is correct and unchanged.
- [ ] 3.3 Confirm the start screen's "click anywhere to begin" still starts a fresh run (not a continue) when no restorable run exists.
- [ ] 3.4 Do not add any "continue from death" path.

## 4. Unit coverage

- [ ] 4.1 Extend the save unit suite (from `harden-core-verification` if landed, otherwise create `tests/unit/save-run-lifecycle.test.js`) with the node-env + `vi.resetModules()` pattern and `../core/input.js` mocked.
- [ ] 4.2 Mid-run save → `loadGame()` accepts and restores; `hasRestorableRun()` is true.
- [ ] 4.3 A save carrying `run.ended === true` is rejected by `loadGame()` (returns false, `G` unmutated) and `hasRestorableRun()` is false while `hasSave()` is still true.
- [ ] 4.4 A save with no `run` field loads (backward compatibility) and is restorable.
- [ ] 4.5 A malformed `run` value (string / number / `{}` / `null`) is treated as not-ended and does not crash `loadGame()`.
- [ ] 4.6 Firing `bus.emit('playerDied')` marks the run ended in the slot exactly once (subsequent emissions do not duplicate or throw).
- [ ] 4.7 With a throwing `localStorage`, the death flow completes without throwing and the failure is handled (clear-save fallback).
- [ ] 4.8 Autosave / quicksave / pause / panel-open triggers remain no-ops once the run is ended.
- [ ] 4.9 Run `npm test` and confirm the full suite passes.

## 5. E2E coverage

- [ ] 5.1 Add a spec: start a run, save (quicksave), die, click RESTART, and assert the title screen shows no CONTINUE and does show NEW RUN.
- [ ] 5.2 Add a spec: after a death, choose NEW RUN and assert the new run starts from default state (health, inventory, level).
- [ ] 5.3 Keep `tests/e2e/save-continue.spec.js` (save → reload → continue restores position) passing unchanged — this guards against over-correction that would make live runs non-restorable.
- [ ] 5.4 Add a spec asserting a new run can itself be saved and continued (so the lifecycle is not a dead end).
- [ ] 5.5 Run the full Playwright suite; confirm the console stays clean.

## 6. Verification

- [ ] 6.1 `npm run lint` clean.
- [ ] 6.2 `npm test` passes.
- [ ] 6.3 `npm run build` succeeds.
- [ ] 6.4 `npx playwright test` — full suite green, including the existing save/continue spec.

## 7. Documentation

- [ ] 7.1 Update the `README.md` "How to play" line so the death/restart flow matches the enforced behavior (death ends the run; the next start begins a new run).
- [ ] 7.2 Update the `src/systems/save.js` header comment to document the run lifecycle, the `run.ended` marker, and the distinction between `hasSave()` and the restorable predicate.
- [ ] 7.3 If a `docs/` run-economy or bestiary doc describes continuing after death, update it to match.
- [ ] 7.4 Record in the change notes that this is an intentional reduction in player convenience, matching the documented design.
