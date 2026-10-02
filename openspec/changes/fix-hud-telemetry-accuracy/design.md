# Design — Fix HUD & telemetry accuracy (hud-telemetry)

## Current-state analysis

### Finding 1 — the compass dot pool is sized from the wrong constant

`src/ui/hud.js buildDom()`:

```js
for (let i = 0; i < CONFIG.maxMachines; i++) {
  const d = div('iw-dot', dotContainer);
  d.style.display = 'none';
  dotPool.push(d);
}
```

`updateDots()` iterates machines and stops at the pool size:

```js
for (let i = 0; i < G.machines.length && di < dotPool.length; i++) { ... }
```

But the population cap used by the AI is different. `src/machines/ai.js`:

```js
const MACH_CAP = CONFIG.maxMachines + 3;   // "kept local so core tuning stays untouched"
```

and `populateWorld()` deals 17 machines: skitter ×3, bramblehorn ×3, rendclaw ×2, ironmaw ×1, duskwing ×2, bulwark ×2, vantage ×1, mirefang ×2, monarch ×1. `processRespawns` also tops the roster back up to `MACH_CAP`.

Runtime probe (production build, after start): `G.machines.length === 17`, allocated `#iw-dots .iw-dot` elements `=== 14`.

Consequence: at most 14 aggro machines receive dots, in roster order. A machine at index 16 still gets a dot when fewer than 14 earlier machines are aggro. The defect is simultaneous-aggro overflow, not a permanent skip of every machine past index 13. `CONFIG.maxMachines` is a v1 tuning constant. The AI derives a larger local cap, and the HUD pool follows the smaller constant. Minimap dots are drawn from the live roster rather than this pool; do not describe the minimap as sharing the 14-dot cap unless a fresh read shows that it does.

### Finding 2 — percentiles are computed from pre-clamped samples

`src/systems/perf.js`:

```js
const DT_CLAMP_MS = 250;
...
const ms = Math.min(dt * 1000, DT_CLAMP_MS);
ringMs[ringHead] = ms;
```

The clamp exists for a good reason (a tab-switch resume produces one enormous delta that would poison the ring), but it is applied to the *value stored in the distribution*, not to the *eligibility* of the sample. So:

- a real 900 ms hitch is stored as 250 ms;
- p99 of any capture that contains a hitch equals exactly 250.

The committed baseline `docs/perf/baseline-45cfa51-inteluhd.txt` shows this directly — `p99: 250` in every one of the five scenarios, and `p95` between 197.8 and 250. The p99 is the clamp constant, not a measurement. The metric therefore cannot detect the tail-latency regressions `docs/aaa-upgrade/PERFORMANCE_BUDGETS.md` §15 defines (>5% p95 regression) is meant to gate on.

Note the sibling module `src/systems/dynres.js` already implements the *correct* pattern for the same problem:

```js
if (dt > DT_CLAMP_S) { resetAveraging(); return; }   // drop the sample entirely
```

So the codebase contains both approaches and the two disagree; the fix is to make `perf.js` match `dynres.js`.

### Finding 3 — pool size reported as a live count

`captureSceneSnapshot()`:

```js
scArrows = Array.isArray(G.arrows) ? G.arrows.length : 0;
```

`G.arrows` is the *entire* pool: `combat/projectiles.js ensurePool()` does `G.arrows.length = 0; for (...) G.arrows.push(pool[i]);` with `MAX_ARROWS = 40`, and never removes entries (dead slots stay in the array; `alive` is the flag). The baseline consequently reports `arrows: 40` in all five scenarios regardless of whether any arrow was fired. The same shape of problem would apply to any future pool-backed count.

### Finding 4 — no "unavailable" representation

`perf.js` distinguishes "no data" from "zero" in some places (`hasGpuInfo`, `heapMB = null`, `cellsVal = null`) but not for draw calls: `giCalls` keeps its last value and `report.gpu.calls` reports it as a number. If `renderer.info` is unavailable, the HUD shows `draw 0` — which reads as a measurement. `getReport()` already has `hasGpuInfo` for exactly this purpose, but `paintHud()` ignores it and prints the numbers unconditionally.

### Finding 5 — the committed baseline is unusable as a gate

`docs/perf/baseline-45cfa51-inteluhd.txt` mixes three problems: saturated p99, `arrows: 40` (pool size), and a `heapMB` that is byte-identical across all five scenarios (20.694732666015625) — which either means the heap genuinely never moved (implausible to 13 significant figures across a combat teleport and a 75-unit position change) or that the value is quantized/stale. Either way the record cannot support the regression gate the budgets document describes.

## Intended approach

### 1. One population cap, one truth

Introduce the real cap as the single source of truth. `ai.js` already keeps it local ("kept local so core tuning stays untouched"), which is precisely why it drifted. Move it to `core/state.js CONFIG` as an explicit `maxMachinesWorld` (or rename `maxMachines` to mean what the world actually spawns) and have `ai.js`, `hud.js`, and `minimap.js` read it. The change must not alter the current population (17) — it must only make everyone agree on 17.

For the dot pool, additionally make it **self-growing**: if `updateDots` finds more aggro machines than allocated elements, append new elements. That removes the "silently drop" failure mode permanently, so a future population change cannot silently regress the HUD again. A 17-element cache is trivial; a `CONFIG` cap alone would be a soft guarantee.

### 2. Store hitch samples; exclude only non-frames

Do not copy `dynres.js`'s 250 ms cutoff into the percentile ring. `updateDynRes()` drops deltas above 0.25 s because one such sample poisons its short controller average. `debugFeed()` still clamps to that ceiling. Telemetry has the opposite job: a 900 ms rendered hitch must remain visible in p99. Using 250 ms as the telemetry exclusion line would make task and spec disagree, and would keep the tail invisible.

Policy:

- Finite positive samples at or below `GAP_MS` (2000) are stored at their true duration. A 900 ms frame is stored as 900.
- Samples above 2000 ms, non-finite samples, and non-positive samples are not stored. Increment `excludedFrames`.
- A hidden-tab resume is a gap even if some future caller clamps it first. Prefer excluding `document.hidden` resumes at the caller when that signal is available; the 2000 ms ceiling is the backstop when only a raw delta arrives.
- Do not write the excluded value into the ring as 250, 900, or 2000.

The ring keeps `RING_CAP`. `dynres.js` is unchanged by this policy.

### 3. Count live entities, expose capacity separately

`G.arrows` should not be reported as-is. Either:
- add a cheap live counter to `combat/projectiles.js` (it already tracks `alive` per slot; a maintained `liveCount` incremented in `spawnArrow`/`deactivate` is O(1) and survives pooling), and report that; or
- have `perf.js` count `a.alive` in its throttled `captureSceneSnapshot()` (runs at 0.25 s, array is 40 — trivially cheap, and keeps the knowledge out of the hot path).

Prefer the throttled count in `perf.js`: it keeps `projectiles.js` unchanged (that module has a "no allocations in hot loops" contract and a `resolved`-flag discipline worth not disturbing) and the scan is bounded and infrequent. Report `arrows` (live) and `arrowsPool` (capacity) as separate fields.

Apply the same live-vs-capacity distinction to `machines` (already live-counted via `machines[i].alive`), `pickups` (already live — `G.pickups` splices on collect), and any particle/VFX counts if they are later surfaced.

### 4. Represent unavailable as unavailable

Use the `hasGpuInfo` flag that already exists: when false, `paintHud()` prints `draw -` / `tris -` (the `fmtCells`-style dash already used for missing cells) instead of `0`. Same for heap (`heapMB == null` already prints `-`, keep it) and cells.

## Control flow after the change

```text
frame: clock.getDelta() -> rawDt
  -> perfStep(unclampedDelta)
       finite && 0 < dt*1000 <= 2000 ?  push true duration into ring
                                    :  excludedFrames++, no push
  -> every 250 ms : recomputeFrameStats() over ring
  -> every 1 s    : captureRendererInfo(), captureHeap(), captureSceneSnapshot()
                      arrows = count of G.arrows where alive   (throttled)
  -> getReport()  : {frameMs{p50,p95,p99,...}, excludedFrames, gpu{...}, hasGpuInfo, ...}
  -> paintHud()   : prints '-' for unavailable sources, shows excluded count

G.machines.length (== CONFIG max) -> hud dot pool self-grows if needed
                                     (no longer sized from CONFIG.maxMachines)
```

## Data-flow / state changes

- `CONFIG` gains an explicit world machine cap; `ai.js MACH_CAP` is replaced by it. **No change to the resulting population (17).**
- `perf.js` gains `excludedFrames`; `report` gains `excludedFrames` and `arrowsPool`; `report.scene.arrows` changes meaning from "pool size" to "in flight". `scripts/perf-capture.mjs` should print both.
- `report.gpu.calls`/`triangles` keep their numeric type; `hasGpuInfo` is the authoritative "is this real" flag and the HUD starts honoring it.
- No persisted state, no gameplay state, no settings keys.

## Failure handling

- `renderer.info` absent → `hasGpuInfo` false → HUD prints dashes; report still returns the previous last-known numbers but consumers can check the flag. (Prefer: null the fields when unavailable rather than serving stale numbers, so nobody mistakes a stale value for a current one.)
- A throwing `window.__IW_PERF_CELLS` publisher is already caught (`try/catch` → `cellsVal = null`); keep.
- If a future frame source can produce NaN, the gap test (`dt * 1000 <= GAP_MS`) is false for NaN, so a NaN would be counted as "excluded" rather than poisoning the ring — correct by construction, but assert it.

## Alternatives considered

- **Keep the clamp but surface it** (e.g. report `p99Clamped: true`). Rejected: it keeps a permanently-saturated metric.
- **Exclude every sample above 250 ms.** Rejected: that is the dynres controller policy, and it would drop the 900 ms hitch this metric must report. Telemetry excludes only non-frames and deltas above 2000 ms.
- **Change the dot pool to a fixed large number (e.g. 64).** Rejected as a band-aid: it hides the two-sources-of-truth problem, which is what actually caused the bug. Self-growing elements plus a single cap fixes both.
- **Move the live-arrow count into `projectiles.js`.** Rejected for now (see above); note it as the natural home if a hot path ever needs the count per frame.
- **Rewrite the whole telemetry module.** Rejected: the module is well-structured (ring buffer, lazy percentiles, allocation-free marks) and the defects are three small, local ones.

## Rollout / compatibility

- `scripts/perf-capture.mjs` and `docs/perf/*.txt` consumers must be updated together with the report shape. The E2E telemetry spec asserts on `getReport()` fields — update it to the new meanings.
- The committed baseline is historical evidence of a real measurement session; do not silently rewrite it. Supersede it with a new capture after the fix and mark the old file as pre-fix, noting *why* its p99 is not usable.

## Testing strategy

- Unit (`tests/unit/perf-dynres.test.js`, existing harness):
  - a 900 ms frame is stored and yields a p99 of 900, not 250;
  - a sample above 2000 ms is not pushed into the ring and increments `excludedFrames`;
  - `report.scene.arrows` is 0 with an untouched pool, 1 after one `spawnArrow`, 0 again after the arrow resolves;
  - `hasGpuInfo === false` when `renderer.info` is absent, and the report's gpu fields are null rather than stale numbers;
  - a NaN frame is treated as excluded, not stored.
- Unit for the cap agreement: assert `CONFIG`'s world machine cap equals the value `ai.js` uses for `MACH_CAP`, so the two cannot drift again (a cheap "single source of truth" lock).
- HUD: assert the dot pool grows to cover N aggro machines for N above the previous 14, and that surplus elements are hidden when machines go calm.
- E2E (`tests/e2e/telemetry.spec.js`): assert `getReport().scene.arrows === 0` on a fresh run (this alone would have caught the pool-size bug), and that the F3 HUD text contains no `0` draw-call figure when renderer info is unavailable.
- Tooling: re-run `node scripts/perf-capture.mjs` and confirm the new baseline's p99 is not pinned to 250, and that the five scenarios now differ in `arrows`.

## Risks

- Changing the meaning of `report.scene.arrows` silently invalidates any external dashboard reading it. Mitigation: ship the new field name (`arrowsPool`) alongside, and call the semantics change out explicitly in the change notes and the regenerated baseline header.
- A 2000 ms ceiling can still hide a multi-second rendered stall. That is accepted: those deltas are indistinguishable from tab-resume gaps without a hidden-tab signal, and `excludedFrames` makes the omission visible. A 260 ms or 900 ms hitch is stored. Document this split in `PERFORMANCE_BUDGETS.md`.
