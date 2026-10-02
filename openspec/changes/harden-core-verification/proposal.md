## Why

The README claims the unit suite covers "XP, quests, bestiary, and save normalization (including corrupt-save handling)". As of `2ced7bd`, that claim is still too broad, but it is no longer true that no test imports these modules. `tests/unit/save.test.js` covers hostile load boundaries, and `tests/unit/expedition.test.js` covers the expedition system. Quests, XP, bestiary, and machine-body damage still have no unit suite. The full unit run is 17 files and 348 tests, not the older 15-file / 336-test count. CI still has no dependency audit, no coverage command, and no asset-validation step.

## What Changes

- **Add unit coverage for the untested core modules**, asserting the behavior that already exists so it cannot silently regress:
  - `src/systems/save.js` — snapshot/restore round-trip, version acceptance/rejection, corrupt-JSON and malformed-record rejection, out-of-range position rejection, "never load back dead" floor, and the recomputed XP threshold.
  - `src/systems/quests.js` — forced opening trio, deterministic deal stream, gather/hunt/scan progress and completion, refill timing, and `isValidQuest` rejection of unprogressable records.
  - `src/systems/xp.js` — level curve, multi-level carry on a single grant, skill-point grant, alpha multiplier, and streak bonus.
  - `src/systems/bestiary.js` — seen/killed transitions, idempotence, and lore reveal gating.
  - `src/machines/machines.js` — weak-point damage and break, per-part break isolation (char must not spread to the whole body), front-armor deflection returning zero damage, alpha variant scaling, kill-once semantics, and loot table shape.
- **Correct the README's testing claims** to describe the coverage that actually exists.
- **Add a coverage command, but do not own the audit or asset gates.** `gate-assets-in-ci` is the only change that adds `npm audit` and `npm run assets:validate` to CI and to `verify`. This change adds `test:coverage` as its own script and does not edit those steps.
- No production behavior changes: every test asserts existing behavior. Where a test uncovers a genuine defect, file it as a separate change rather than changing behavior here.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
<!-- None. -->

This change is non-behavioral: it adds tests, CI gates, and corrects documentation claims. It is marked `skip_specs: true` in `.openspec.yaml` because no externally observable behavior changes.

## Impact

- Affected code: new/extended files under `tests/unit/`; `.github/workflows/ci.yml`; `package.json` (a coverage script); `README.md` (testing section).
- Test files follow the established node-env pattern already in the repo (`vi.resetModules()` + dynamic import for module state, plain stubs instead of WebGL, `tests/setup.dom.js` browser shims).
- CI runtime increases; the E2E job already dominates wall-clock, and these additions run in the fast unit job.
