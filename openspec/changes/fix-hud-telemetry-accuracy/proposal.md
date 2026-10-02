## Why

Two user- and operator-facing surfaces report things that are not true. The HUD compass allocates 14 threat dots from `CONFIG.maxMachines` while the world can contain 17 machines. `updateDots()` skips calm machines before taking a dot, so this is not "index 14 and above never appear". The failure is simultaneous aggro: once 14 aggro machines have taken the pool, every further aggro machine is skipped. Separately, performance telemetry clamps frame-time samples at 250 ms before computing percentiles, so the committed baseline's `p99: 250` is the clamp, not an observation. That hides the tail-latency regressions the metric exists to catch.

## What Changes

- **Size the compass dot pool from the real machine cap.** The pool must be large enough for every machine the world can contain, and the HUD must still work if that count changes at runtime.
- **Report hitch samples and exclude only non-frames.** A rendered hitch, including a 900 ms frame, must enter the distribution at its true duration. Only non-finite, non-positive, and true gap deltas (above a 2000 ms ceiling, or a hidden-tab resume) are excluded. Do not reuse `dynres.js`'s 250 ms controller cutoff for this distribution: that cutoff is what currently hides the tail.
- **Distinguish "clamped" from "observed" in the report.** If any sample is excluded, the report must say so instead of presenting a truncated distribution as if it were complete.
- **Stop reporting pool size as live entity count.** The telemetry scene snapshot currently reports `arrows: 40` because it reports the size of the fixed arrow pool rather than the number of arrows in flight; same class of issue for any other pool-derived number.
- **Make the committed baseline honest.** Regenerate or annotate it so a saturated percentile is not read as a measurement.
- No change to gameplay, rendering, or input.

## Capabilities

### New Capabilities
- `hud-telemetry`: The observable contract of the in-game instrumentation and HUD threat display — that on-screen threat indicators cover every machine the world can contain, and that reported frame-time statistics, percentiles, and entity counts reflect observations rather than internal caps or pool sizes.

### Modified Capabilities
<!-- None: first specification of this behavior; openspec/specs/ is currently empty. -->

## Impact

- Affected code: `src/ui/hud.js` (dot pool construction, `updateDots`), `src/core/state.js` (the `maxMachines` constant that several modules treat as the cap), `src/systems/perf.js` (`DT_CLAMP_MS`, `updatePerf`, `recomputeFrameStats`, `captureSceneSnapshot`, the shared `report` object and the F3 HUD text), `src/systems/dynres.js` (its own separate `DT_CLAMP_S` gap handling, for consistency of vocabulary), `docs/perf/baseline-45cfa51-inteluhd.txt`.
- Observers of the change: `scripts/perf-capture.mjs` (reads `window.__IW.perf.getReport()`), `tests/unit/perf-dynres.test.js`, `tests/e2e/telemetry.spec.js`.
- Telemetry is diagnostic-only; a bug here degrades observability, not gameplay.
