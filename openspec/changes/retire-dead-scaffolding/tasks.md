# Tasks — Retire dead scaffolding (cleanup)

## 0. Cross-change coordination (read before editing)

This change deletes and edits files that other changes reference. Read this before starting:

- **`src/world/lod.js`** — this change deletes `DistanceLOD`, `foliageTierDensity`, and `makeBillboardImpostor`. `fix-cell-streaming-initial-hide` explicitly lists the `lod.js` helpers as **out of scope** and does not edit them, so there is no conflict — but apply this change first if you prefer to keep the streaming change's import surface stable while it lands.
- **`src/ui/hud.js` / `src/ui/settings.js` / `src/assets/manifest.js`** — referenced by `sync-project-documentation` for the state-ownership note only; that change must not edit them beyond its note. No edit conflict here.
- **`src/input/gamepad.js`** — this change deletes the unused `rumble()`; `complete-input-action-coverage` adds D-pad/R3/Select button indices to the same file. **Sequence the two** (either order works; separate commits), and ensure this change does not re-add `rumble` after the input change lands.
- **`src/player/bow.js`** — this change deletes `getBowFeedback()`. No other change edits `bow.js`; `restore-machine-combat-visuals` touches `machineAnim`/`machines`/`ai` only.

Also record (do not act on): `window.__IW_AUDIO_STATS` and `window.__IW_VFX_STATS` are published but never read by any consumer. That is a **missing feature**, not dead code, so it is explicitly out of scope here — deleting a diagnostics getter and adding a consumer are opposite responses. It belongs with the HUD/telemetry work (`fix-hud-telemetry-accuracy`).

## 1. Remove the unused material library

- [ ] 1.1 Delete `src/world/materials.js` (479 lines).
- [ ] 1.2 Confirm with a repository-wide search that nothing imports it (the only reference is a comment in `src/render/lighting.js`).
- [ ] 1.3 In `src/render/lighting.js`, fix the comment that references `materials.js` so it no longer points at a deleted file.
- [ ] 1.4 Record (in the commit message or the change notes) that the weak-point emissive/base-color/intensity constants now live solely in `src/machines/machines.js glowMat()` so future edits have one obvious home.
- [ ] 1.5 Do **not** rewire live materials to a shared library in this change; that is a separate visual change with its own QA.

## 2. Trim `src/world/lod.js` to what ships

- [ ] 2.1 Delete `DistanceLOD`, `foliageTierDensity`, and `makeBillboardImpostor` from `src/world/lod.js`.
- [ ] 2.2 Keep `groupInstancesByCell` (the only symbol `src/world/props.js` imports) and its full doc comment.
- [ ] 2.3 Rewrite the module header so it describes only what the file provides, and remove the bullet list of removed helpers.
- [ ] 2.4 Confirm `props.js` still imports and uses `groupInstancesByCell` and that no other module imported the removed symbols.

## 3. Retire the unused positional-emitter pool

- [ ] 3.1 Delete `src/audio/emitters.js`.
- [ ] 3.2 In `src/audio/audio.js`: remove the `emitters.js` import line, the `createEmitters({ ctx, destination: busIn })` call in `initAudio()`, and the `updateEmitters(_dt)` call in `updateAudio()`.
- [ ] 3.3 Remove the `emitAt` re-export from `audio.js` and the now-unused `getEmitterStats` import.
- [ ] 3.4 Remove the `emitters` key from the object returned by `getVoiceStats()` and update any consumer that reads it.
- [ ] 3.5 Remove `setSampleBank`, the `sampleBank` module variable, and `playSampleOrSynth`; simplify the `sfx()` call site accordingly (it currently routes through `playSampleOrSynth` with a `null` bank).
- [ ] 3.6 Verify `sfx()` still builds its per-call panner for `opts.pos` (that is the production positional path and must be untouched).
- [ ] 3.7 Update the `audio.js` and `emitters.js`-referencing header comments so they no longer describe a removed subsystem.

## 4. Remove the remaining unused exports

- [ ] 4.1 Delete `rumble()` from `src/input/gamepad.js` (and its doc comment).
- [ ] 4.2 Delete `applyExposure()` and `applyShadowPolicy()` from `src/render/lighting.js`; fix the header comment that names `applyShadowPolicy` as an integrator export.
- [ ] 4.3 In `src/player/bow.js`, delete `getBowFeedback()` and the `_fbCache` / `_fbCacheFrame` module state; remove the cache-invalidation line inside `setBowState()` and confirm the bow FSM still emits identically.
- [ ] 4.4 Keep `computeAssistAdjust()` (used internally by `fire()`); only the unused export surface changes if any.
- [ ] 4.5 Delete `isAuthoredActive()` from `src/player/hunterView.js`; verify the `active` flag has no other reader before removing its bookkeeping.
- [ ] 4.6 Explicitly **keep** `perception.debugStats`, `perf.GpuTimer`, and `combat/status.registerStatus` (test-covered or documented extension points) and leave a brief comment in each so a future cleanup does not re-litigate them.

## 5. Update tests for removed symbols

- [ ] 5.1 In `tests/unit/combat-waves.test.js`, remove the `getBowFeedback` import from the bow mock rig and delete the test "getBowFeedback reports targetAligned independently of the setting and memoizes per frame".
- [ ] 5.2 Keep the `computeAssistAdjust` tests (that function remains).
- [ ] 5.3 Search the test suite for any other reference to a removed symbol (`rumble`, `setSampleBank`, `emitAt`, `isAuthoredActive`, `applyExposure`, `applyShadowPolicy`, `libraryStats`) and update accordingly; the audit found none, but confirm.
- [ ] 5.4 Run `npm test` and confirm the suite passes with no import errors.

## 6. Record the follow-up that is deliberately not in this change

- [ ] 6.1 In the change notes (and `docs/ASSET-GATES.md` or a suitable doc if one exists), record that `window.__IW_AUDIO_STATS` and `window.__IW_VFX_STATS` are published but never consumed by the F3 HUD or any other reader, and that surfacing them is a follow-up rather than part of a deletion sweep.
- [ ] 6.2 Cross-reference the `fix-hud-telemetry-accuracy` change, where the HUD/telemetry surface is already being corrected, as the natural home for that follow-up.

## 7. Verification

- [ ] 7.1 `npm run lint` clean (ESLint's unused-import rule is a useful check that no dangling `emitters.js` import survived).
- [ ] 7.2 `npm test` passes.
- [ ] 7.3 `npm run build` succeeds.
- [ ] 7.4 `npx playwright test` — full suite green; pay attention to any console warnings (E2E fails on warnings except the allowlisted SwiftShader notice), which would reveal a broken audio path.
- [ ] 7.5 Manual check: start a run, confirm machine footsteps/growls and impact sounds still play positionally (the per-call panner path), and that no audio errors appear in the console.
- [ ] 7.6 `git status` review: confirm the changed/deleted file set matches this task list exactly and no unrelated file was touched.
