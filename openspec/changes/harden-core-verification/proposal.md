## Why

The README claims the unit suite covers "XP, quests, bestiary, and save normalization (including corrupt-save handling)", but no test file imports those modules — verified by scanning every import in `tests/unit/`. The persistence, progression, contract, bestiary and machine-damage layers (the most user-visible and most regression-prone surfaces in the game) have **zero** unit coverage, protected only by a single E2E spec that round-trips one position value. CI additionally runs no dependency audit, no coverage floor, and no bundle-size gate, so a regressed save schema, a broken quest deal, or a vulnerable transitive dependency would all merge green.

## What Changes

- **Add unit coverage for the untested core modules**, asserting the behavior that already exists so it cannot silently regress:
  - `src/systems/save.js` — snapshot/restore round-trip, version acceptance/rejection, corrupt-JSON and malformed-record rejection, out-of-range position rejection, "never load back dead" floor, and the recomputed XP threshold.
  - `src/systems/quests.js` — forced opening trio, deterministic deal stream, gather/hunt/scan progress and completion, refill timing, and `isValidQuest` rejection of unprogressable records.
  - `src/systems/xp.js` — level curve, multi-level carry on a single grant, skill-point grant, alpha multiplier, and streak bonus.
  - `src/systems/bestiary.js` — seen/killed transitions, idempotence, and lore reveal gating.
  - `src/machines/machines.js` — weak-point damage and break, per-part break isolation (char must not spread to the whole body), front-armor deflection returning zero damage, alpha variant scaling, kill-once semantics, and loot table shape.
- **Correct the README's testing claims** to describe the coverage that actually exists.
- **Add CI gates** for dependency advisories and for the authored-asset validator, and record the coverage command so coverage is measurable rather than asserted.
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
