# Design — Retire dead scaffolding (cleanup)

## Current-state analysis

Every item below was confirmed by reference search across `src/`, `scripts/`, and `tests/` (not inferred from naming or comments).

### 1. `src/world/materials.js` — 479 lines, zero importers

```text
$ grep -rn "materials.js" src scripts tests --include=*.js --include=*.mjs
src/render/lighting.js:83:    // QA pass alongside envMapIntensity retunes in materials.js.
```

That is the **only** occurrence in the repository, and it is a comment. The module is not imported by any production file, any test, or any script. Its header describes it as "One place to author the game's metallic/roughness surface language so later systems stop hand-rolling materials" — but the live code still hand-rolls them:

| Constant | `materials.js` (dead) | Live code |
| --- | --- | --- |
| weak-point emissive | `WEAK_CYAN = 0x59e3ff` | `machines/machines.js glowMat()` → `emissive: 0x59e3ff` |
| weak-point base color | `0x10333c` | `machines/machines.js glowMat()` → `color: 0x10333c` |
| weak-point intensity | `1.6` | `machines/machines.js glowMat()` → `emissiveIntensity: 1.6` |
| stone | `0x7d7f82` | `world/props.js` rock/ruin `colorJitter(0x7d7f82, ...)` |
| grass pair | `0x6a8f4f` / `0x8aa85c` | `world/props.js` `_colA` / `_colB` |
| leather | `0x7d573a` | `player/player.js matLeatherDark` |
| water | `0x3d6f7d` | `world/terrain.js waterMat` |

`materials.js` explicitly claims byte-for-byte parity with `machines.js` for the weak-point case. That is a **duplicated source of truth presented as canonical**: a future edit to one silently diverges from the other, and the divergence is invisible because the "canonical" copy is never executed. `libraryStats()` has zero references, confirming even its intended diagnostic consumer never arrived.

### 2. `src/world/lod.js` — three unused exports

`props.js` imports exactly one symbol: `groupInstancesByCell`. `DistanceLOD`, `foliageTierDensity`, and `makeBillboardImpostor` have no callers (their only other occurrences are the doc example inside `DistanceLOD`'s own comment and the module header). The file header lists all four as delivered features, which overstates what ships.

Note this is *not* the same as "the project has no LOD": machines do their own bespoke distance gating (`machines.js _detailTick`, `SHADOW_CAST_DIST`) and props uses the cell manager. The generic helper is the orphan, not the capability.

### 3. `src/audio/emitters.js` — a live per-frame loop for a feature with no caller

```text
$ grep -rn "emitAt" src --include=*.js
src/audio/audio.js:22:  import { createEmitters, updateEmitters, emitAt as emitterEmitAt, ... }
src/audio/audio.js:1576: export function emitAt(...)      # re-export only
src/audio/emitters.js:101: export function emitAt(...)    # the implementation
```

Nothing calls it. But the surrounding machinery **is** live:

- `audio.js:1104` — `createEmitters({ ctx, destination: busIn })` runs at audio init and builds a pool of `POOL_SIZE = 12` `PannerNode`s.
- `audio.js:1308` — `updateEmitters(_dt)` runs **every frame** inside `updateAudio`, writing listener orientation from `G.camera` and recomputing a busy count across the 12 slots.

So the game maintains 12 audio nodes and a per-frame orientation pass for a pool that can never be occupied. Meanwhile `sfx()` already has its own working positional path: it builds a per-call `PannerNode` when `opts.pos` is set (`audio.js makePanner`, used by every machine/impact/step sound). The pool is therefore not just unused, it is redundant with a path that is in production use.

`setSampleBank()` is likewise never called (only its own definition and three comments). Its purpose — swapping synthesized sounds for authored AudioBuffers — is a legitimate future direction, but the asset pipeline produces GLB/KTX2 only and registers no audio, so the hook is currently unreachable.

### 4. Smaller unused exports

| Symbol | File | Status |
| --- | --- | --- |
| `rumble(intensity, durationMs)` | `src/input/gamepad.js` | no caller, no test |
| `applyExposure(v)` | `src/render/lighting.js` | no caller |
| `applyShadowPolicy(tier)` | `src/render/lighting.js` | no caller; duplicates `main.js setShadowMapSize` |
| `isAuthoredActive()` | `src/player/hunterView.js` | no caller |
| `getBowFeedback()` | `src/player/bow.js` | no production caller; header says "for HUD consumption" |
| `computeAssistAdjust()` | `src/player/bow.js` | **used internally** at `bow.js:290`; only the *export* is test-only — keep the function |
| `debugStats()` | `src/machines/perception.js` | no production caller **but** covered by `tests/unit/perception-logic.test.js` — intentional debug affordance, keep |
| `registerStatus()` | `src/combat/status.js` | called internally to register `burn`; the export is an extension point — keep |
| `GpuTimer` | `src/systems/perf.js` | no production caller, covered by `tests/unit/perf-dynres.test.js` — documented as a deliberate "not wired into the frame loop" tool, keep |

The distinction that matters: **remove what has no caller and no justification; keep what is covered by tests or is a documented extension point.** `debugStats`, `GpuTimer`, and `registerStatus` fall in the keep column; the rest do not.

`applyShadowPolicy` deserves an explicit note: it duplicates shadow-map resizing (`s.map.dispose(); s.map = null; s.mapSize.set(...)`) that `main.js setShadowMapSize` already performs, plus bias/normalBias/extent settings that nothing reads. Two implementations of the same policy, one live and one not, is precisely the divergence hazard this change exists to remove.

### 5. Claims that make dead code look live

- `bow.js:10` — "and getBowFeedback() for HUD consumption" (no HUD consumer).
- `emitters.js` / `audio.js` headers describe the pool as part of the delivered audio architecture.
- `materials.js` header — describes a central library nothing uses.
- `lod.js` header — lists four delivered features, three unused.
- `render/lighting.js:20` — "applyShadowPolicy is exported for the integrator but NOT called from here" (accurate, but it is dead weight, not a documented seam, because no other integrator calls it either).

## Intended approach

Delete the dead code and correct the claims. Do **not** wire the unused subsystems up — adopting `materials.js` or the emitter pool would be a visual/audio-behavior change belonging in its own change with its own validation, and there is no evidence the team wants either today.

### Removal list

1. Delete `src/world/materials.js`.
2. In `src/world/lod.js`, delete `DistanceLOD`, `foliageTierDensity`, `makeBillboardImpostor`; keep `groupInstancesByCell` and rewrite the header to describe only that.
3. Delete `src/audio/emitters.js`; in `src/audio/audio.js` delete the `emitters.js` import, the `createEmitters(...)` call, the `updateEmitters(...)` per-frame call, the `emitAt` re-export, `setSampleBank`/`sampleBank`/`playSampleOrSynth`, and the `emitters` key in `getVoiceStats()`.
4. In `src/input/gamepad.js`, delete `rumble()`.
5. In `src/render/lighting.js`, delete `applyExposure()` and `applyShadowPolicy()`, and fix the header comment that references the latter.
6. In `src/player/bow.js`, delete `getBowFeedback()` and its `_fbCache`/`_fbCacheFrame` memo; keep `computeAssistAdjust()` (internally used). Remove the memo invalidation inside `setBowState()` that exists only to invalidate the feedback cache.
7. In `src/player/hunterView.js`, delete `isAuthoredActive()` and the now-unneeded `active` bookkeeping only if it has no other reader (verify before removing).

### Deliberately kept

- `perception.debugStats` (test-covered debug affordance).
- `perf.GpuTimer` (test-covered, documented as deliberately unwired).
- `combat/status.registerStatus` (used internally; documented extension point).
- `audio`'s per-call panner path in `sfx()` (production, in use).

### Test impact

`tests/unit/combat-waves.test.js` imports `getBowFeedback` and `computeAssistAdjust` from the bow module and has a test named "getBowFeedback reports targetAligned independently of the setting and memoizes per frame". That test must be removed with the function; the `computeAssistAdjust` tests stay. No other suite references removed symbols (`rumble`, `setSampleBank`, `emitAt`, `isAuthoredActive`, `applyExposure`, `applyShadowPolicy`, `libraryStats` had zero test references).

### Out of scope

- **Surfacing the unread telemetry getters.** `window.__IW_AUDIO_STATS` (audio.js) and `window.__IW_VFX_STATS` (vfx/library.js) are published but never read by the F3 HUD or any consumer. That is a *missing feature*, not dead code — deleting a diagnostics getter and adding a consumer are opposite responses, and conflating them in a cleanup change would hide the intent. Track it as an explicit follow-up (and it belongs naturally with the HUD/telemetry accuracy work).
- Any change to `materials.js`'s constants being adopted by live code (that is the adoption change, if anyone wants it).
- Removing the `lodash`-style helper patterns used by the retained modules.

## Control flow after the change

```text
audio init:  createEmitters(...)  [REMOVED]  -> 12 panners no longer allocated
frame loop:  updateAudio() -> updateEmitters(_dt)  [REMOVED]
             updateAudio() still runs updateListener() and every other audio tick
             sfx(name, {pos}) still builds its own per-call PannerNode (unchanged)
```

## Data-flow / state changes

None. No persisted field, no `G.*` field, no event payload, no settings key is touched. The only runtime delta is the elimination of the per-frame `updateEmitters` call and 12 idle audio nodes.

## Failure handling

The primary risk of a deletion sweep is removing something that is actually used through a path the search missed. Mitigations:

- `audio.js` is the only importer of `emitters.js`; after deletion, `getVoiceStats().emitters` must be removed and its unit test (if any) updated. Verify by running the audio-related assertions and the full suite.
- `getBowFeedback` removal must not break the `bowState` FSM: check that `_fbCacheFrame`/`_fbCache` are only referenced by `getBowFeedback` and `setBowState`'s cache invalidation, and that removing the latter does not alter FSM behavior (it is only a cache-bust).
- `isAuthoredActive` removal must confirm no other module reads `hunterView`'s `active` flag.

## Alternatives considered

- **Wire up `materials.js` instead of deleting it.** Tempting (single source of truth is a real quality win) but it is a visual change across machines, props, and the player, with no evidence the current look is wrong, and the module's parameters were authored blind. That is a separate design decision with its own QA pass, not a cleanup.
- **Keep the emitter pool but make it lazy** (skip `updateEmitters` when no slot is busy). Preserves an unused feature at the cost of a branch and continued surface. Rejected: an unreachable feature should be removed or adopted, not made cheaper.
- **Keep everything and add a "dead code" lint rule.** Complementary, not a substitute; out of scope for a one-time sweep. Worth a follow-up if the codebase keeps accumulating this.
- **Delete `debugStats` / `GpuTimer` as "unused in production".** Rejected: both are test-covered and documented; they are debug affordances with a real consumer (the test suite), not orphans.

## Rollout / compatibility

Pure deletion plus comment corrections. No behavior change beyond removing wasted per-frame work. No migration, no config change, no save-format change. The risk profile is "did we miss a caller", addressed by the full test suite and E2E run.

## Testing strategy

- `npm run lint` — must pass; ESLint's `no-unused-vars` will catch any dangling import left behind (e.g. an unused `emitters.js` import in `audio.js`), which is a useful secondary check for this change.
- `npm test` — remove the `getBowFeedback` case from `tests/unit/combat-waves.test.js`; everything else must pass unchanged.
- `npm run build` — must succeed; confirms no dangling import survives tree-shaking into a runtime resolution error.
- `npx playwright test` — the audio-related assertions matter most here (a removed per-frame call or a broken panner path would show as a console warning or missing sound event); the E2E console discipline (warnings are failures except the allowlisted SwiftShader notice) is a real check.
- Manual/headless confirmation: after a run starts, confirm machine footstep/growl positional audio still plays (the per-call panner path is the one that matters) and that no audio errors appear.
- `git status` review: confirm the deletion set is exactly the agreed list and no unrelated file changed.

## Risks

- **Accidentally deleting a live path.** The only real candidates are the audio pool's role in `updateAudio`'s call chain and `getBowFeedback`'s cache invalidation inside `setBowState`; both are called out in the failure-handling section and are checked by the suite.
- **Churn in review.** A large-looking deletion diff can obscure the small behavioral part (removing the per-frame audio call). Keep the two concerns in separate commits if the project's workflow allows it.
