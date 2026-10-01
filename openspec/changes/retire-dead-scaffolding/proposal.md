## Why

Several subsystems were built as infrastructure for later waves and never adopted. They are not harmless: one is a 479-line "canonical" material library that duplicates the constants the live code actually hardcodes (a divergence trap), and one allocates a 12-node audio pool and runs a per-frame upkeep loop for a feature that has no caller at all. Others are exports whose own doc comments claim consumers that do not exist. Leaving them in place inflates the surface a maintainer must reason about, misleads readers about what is live, and — in two cases — costs work every frame.

## What Changes

- **Remove `src/world/materials.js`** (479 lines). It is imported by nothing; the only reference anywhere in the repository is a passing comment. Its factories duplicate constants that `machines/machines.js` and `world/props.js` define independently, so it is a second source of truth for values that must not drift.
- **Remove the unused exports of `src/world/lod.js`.** Only `groupInstancesByCell` is consumed (by `props.js`); `DistanceLOD`, `foliageTierDensity`, and `makeBillboardImpostor` have no callers.
- **Retire the unused positional-emitter pool in `src/audio/`.** `emitAt` has no production caller, yet `createEmitters` allocates 12 `PannerNode`s at audio init and `updateEmitters` runs on **every frame** inside `updateAudio`. Remove the pool, its per-frame upkeep, the `emitAt` re-export, and the unused `setSampleBank` hook.
- **Remove the unused gamepad `rumble()` helper**, which has no caller.
- **Remove `applyExposure` / `applyShadowPolicy` from `src/render/lighting.js`.** Neither is called; `applyShadowPolicy` additionally duplicates the shadow-map resize logic that `main.js setShadowMapSize` already owns, so keeping it invites divergence in one of two places.
- **Remove `getBowFeedback()` from `src/player/bow.js`.** Its header claims it exists "for HUD consumption" and no HUD code reads it.
- **Remove `isAuthoredActive()` from `src/player/hunterView.js`,** which has no caller.
- **Correct the claims that make dead code look live.** Fix comments that describe nonexistent consumers.
- Keep genuinely test-covered debug affordances (e.g. `perception.debugStats`), which are exercised and intentional.
- No gameplay, visual, audio-output, or persistence change.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
<!-- None. -->

Non-behavioral: this removes code that has no production callers. It is marked `skip_specs: true` in `.openspec.yaml`. The one item with any runtime effect is the audio pool's per-frame upkeep, which is pure waste rather than behavior.

## Impact

- Affected files: `src/world/materials.js` (deleted), `src/world/lod.js`, `src/audio/audio.js`, `src/audio/emitters.js` (deleted), `src/input/gamepad.js`, `src/render/lighting.js`, `src/player/bow.js`, `src/player/hunterView.js`, and comments in `src/render/lighting.js` / `src/player/bow.js` / `src/systems/assets.js` that reference removed items.
- Per-frame work removed: one `updateEmitters` call per frame (listener-orientation writes + a 12-slot busy count) and the 12 retained panner nodes.
- Tests that reference removed exports must be updated, not deleted wholesale: `tests/unit/combat-waves.test.js` exercises `getBowFeedback` and `computeAssistAdjust`; `computeAssistAdjust` stays (it is used internally by `fire()`), only the `getBowFeedback` coverage needs to move or go.
- Bundle size: `materials.js` is already tree-shaken out of the production build (it is never imported), so there is no bundle-size win — the win is in the source surface and the honesty of the docs.
