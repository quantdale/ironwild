# Design — Harden core verification (tests + CI gates)

## Current-state analysis

### What the unit suite actually covers

Scanning `tests/unit/` at `2ced7bd` (17 files, 348 tests) yields:

| Covered | Not covered |
| --- | --- |
| `core/utils`, `core/events`, `core/state`, `core/input` (action layer) | `systems/quests`, `systems/xp`, `systems/bestiary` (no unit file) |
| `world/terrain` | `world/props`, `world/cells`, `world/environment`, `world/weather`, `world/lod`, `world/landmark`, `world/materials` |
| `combat/damage`, `combat/projectiles`, `combat/status` | `machines/machines`, `machines/ai` (only `machines/perception` is covered) |
| `player/bow`, `player/spear` | `player/player`, `player/camera`, `player/hunterView` |
| `systems/perf`, `systems/dynres`, `systems/assets`, `assets/manifest` | `audio/audio`, `audio/emitters`, `render/lighting` |
| `ui/hud` (pure helpers only) | `ui/menus`, `ui/settings`, `ui/focus`, `ui/minimap`, `ui/tips`, `ui/weakcue`, `ui/a11y` |
| `vfx/vfx`, `vfx/library`, `anim/events`, `anim/graph`, `anim/machineAnim` | `src/main.js` integration |

### The specific gap this change closes

`README.md` states:

> "Unit tests cover the deterministic core — RNG, event bus, damage/weak-point math, status timing, terrain generation, **XP, quests, bestiary, and save normalization (including corrupt-save handling)**."

XP, quests, and bestiary still have no unit file. Save is no longer uncovered: `tests/unit/save.test.js` rejects an out-of-world position before mutation, clamps hostile XP/inventory/quest counters, and normalizes a malformed expedition record. It does not cover a full happy-path round trip, version acceptance, or quest-record restoration. New save tests must extend that behavior, not restate the pre-merge loader.

Current loader facts the new tests must pin:

- `SAVE_VERSION` is 4. `loadGame()` accepts integer versions `2..4` and rejects anything below 2 or above 4.
- Position is rejected when `Math.hypot(x, z) > CONFIG.playRadius + 12`, `y < -48`, or `y > 220`. It is not bounded by `CONFIG.worldSize`.
- Inventory restore is already capped (`shards`/`wood`/`oil`/`hide`/`skillPoints` at 9999, medicine at 99, armor at 0..2, arrows at the live max). Do not write a test that expects an uncapped finite value to round-trip.
- Expedition state is part of the v4 snapshot and is passed through `normalizeExpeditionState()`.

### CI gaps

`.github/workflows/ci.yml` runs, in order: `npm ci` → `npm run lint` → `npm test` → `npm run build` → `npx playwright install` → `npm run test:e2e` → upload report on failure.

Absent:

- **Dependency advisory check** — `npm audit` / `npm audit --audit-level=high` is never run. A vulnerable transitive dependency merges silently.
- **Coverage** — no coverage tooling is installed or run, so coverage is unmeasurable; the README's coverage sentence is a prose claim, not a report.
- **Asset validation** — `npm run assets:validate` exists but is not in CI and not in `npm run verify`, despite the repo now shipping five authored GLB assets with provenance sidecars.
- **Bundle-size budget** — `vite build` emits a ">500 kB chunk" warning (the `three` chunk is 546 kB) that no gate enforces.

## Intended approach

This is a **characterization-test** change, not a behavior change. The rule: every new test asserts what the code does *today*, verified by reading the implementation. If a test reveals a genuine defect, that defect becomes its own change; the test is still added (documenting current behavior) or is added in its "should" form only when the fix ships in the same change.

### Test harness constraints (already established in-repo)

- `vite.config.js` runs vitest with `environment: 'node'`, `include: ['tests/unit/**/*.test.js']`, `setupFiles: ['tests/setup.dom.js']`.
- `tests/setup.dom.js` provides a `window` stub that *records* listeners but cannot dispatch, an in-memory `localStorage`, and a minimal `document`.
- Modules with module-level singletons (bus, Input, pools) use the `vi.resetModules()` + dynamic `import()` pattern (`status-burn.test.js`, `input-actions.test.js`, `assets-pipeline.test.js`, `machine-animator.test.js`).
- WebGL-free construction: use `new THREE.Scene()` and real `THREE` math; stub `document.createElement('canvas')` via `tests/unit/helpers/canvas2d.js` for modules that build canvas textures.

### Per-module test plans

#### `systems/save.js`

Requires mocking `../core/input.js` (save.js imports `Input` for the quicksave poll) and needs a live `G.player`. Cases:

1. Round-trip: set player pos/hp/stamina, inventory, skills, timeOfDay, mapRevealed, quests, xp, bestiary, and expedition → `saveGame()` → reset `G` → `loadGame()` → deep-equal on every persisted field.
2. Version gate: `v: 1` and `v: 99` are rejected; `v: 2`, `v: 3`, and current `v: 4` are accepted.
3. Position guard: missing array, length < 3, non-finite entry, `hypot(x, z) > CONFIG.playRadius + 12`, `y < -48`, or `y > 220` are rejected. Do not use `CONFIG.worldSize`.
4. Corrupt JSON in storage → `loadGame()` returns `false`, no throw, no partial mutation of `G`.
5. `hp` floor: `hp: 0` or negative loads as at least 1 (never dead on load).
6. XP `next` is never trusted from the save; it is recomputed from the level curve.
7. Quest slots: a malformed record is dropped to `null` (not left wedged), a valid one is restored and re-emits `questUpdate`.
8. Unknown or non-finite inventory values are ignored; finite values are clamped to the caps already in `restoreInventory`.
9. `hasSave()` / `clearSave()` behavior including storage-unavailable paths.

#### `systems/quests.js`

1. Fresh `createQuests()` deals exactly three slots, and the first three are one of each type (hunt/gather/scanVantage) via `genCount`.
2. `machineDied` with a matching type increments only matching hunt slots and completes at `need`.
3. `pickup` increments gather slots by the emitted amount, capped at `need`.
4. `machineScanned` completes a `scanVantage` slot.
5. Completion grants the documented reward (+1 SP for hunt, +6 shards gather, +1 medicine scan; +1 bonus SP for ironmaw hunt) and increments `G.quests.completed`.
6. A completed slot refills after `REFILL_DELAY` seconds of `updateQuests(dt)`.
7. A `scanVantage` slot is replaced when no live Vantage exists (no deadlock).
8. `isValidQuest` rejects: unknown type, hunt target not in `HUNT_TYPES`, gather target not in `GATHER_TYPES`, non-finite progress/need, `need <= 0`, non-finite `refillT`.
9. `genCount` is persisted/serializable (needed for "first three really means first three" across Continue).

#### `systems/xp.js`

1. `nextFor(level)` is monotonic and matches `round(100 * level^1.35)`.
2. A grant that crosses multiple thresholds levels up once per threshold and grants one skill point each.
3. `cur` is decremented by each threshold as it is crossed (no XP lost on multi-level).
4. Kill XP table per type; `vantage` grants nothing.
5. Alpha kill grants 1.5× base.
6. `killStreak` pays only on every third link; `pickup` pays a flat amount; `machineScanned` pays its amount.
7. `createXp()` normalizes a partially-corrupt `G.xp` (non-finite level/cur/next).

#### `systems/bestiary.js`

1. Scan marks `seen` only (not `killed`); kill marks both.
2. Re-entry is idempotent (no duplicate toasts/events) — assert `bestiaryUnlock` fires exactly once per (type, kind).
3. Unknown type is ignored.
4. Lore is exposed only for `killed` species; `speciesName` falls back to the raw key.

#### `machines/machines.js`

1. Weak-point damage reduces `wp.hp`; at zero it becomes `broken`, emits `partBroken`, staggers the machine, and stops taking weak-point damage.
2. Part-break charring touches only that part's materials — the shared hull/rust/joint instances must remain uncharred (this is a documented invariant in `registerWeakPoint`).
3. Body damage reduces machine hp; `hp <= 0` kills exactly once (`machineDied` emitted once; `alive` false).
4. Bulwark front-cone hits return `false` from `hit()` (deflection), deal zero hp damage, still set `hitFlag`, and do not apply burn (the `burnInteraction: 'immune'` rule).
5. Alpha variant: name prefix, +60% max hp, damage multiplier, double loot.
6. Loot drop count matches the `LOOT` table (alpha doubles it).
7. `dispose()` removes the record from `G.machines` exactly once and is idempotent.

### CI additions

This change does **not** add the dependency-audit step or the asset-validation step. Those belong only to `gate-assets-in-ci`, which also owns inserting `assets:validate` into `verify`. Adding them here would make two changes append the same steps to `ci.yml` and rewrite the same script string.

Add a `test:coverage` script using `@vitest/coverage-v8`, pinned to the installed Vitest major. Do not fold that script into `verify` and do not set a coverage percentage gate. Measure first; ratchet later.

## Alternatives considered

- **Set a coverage percentage gate now.** Rejected: no baseline exists, and a percentage alone does not indicate confidence. Measure first, ratchet second.
- **Mock the whole `G` singleton for save/quest tests.** Rejected: the existing suites use the real `G` with `vi.resetModules()`, which catches the real serialization shape. Keep that.
- **Add integration tests instead of unit tests for `machines/ai.js`.** Partially adopted: the full FSM is covered by E2E already; this change adds targeted unit coverage only for the deterministic, high-value pieces (spawn layout determinism, respawn queue timing, harvest arithmetic) and leaves deep FSM behavior to E2E.

## Risks

- Tests that lock in *current* behavior can enshrine a bug. Mitigation: every assertion carries a comment naming the behavior it pins; any assertion that looks like it is pinning a defect gets a `FIXME`-style reference to the change that fixes it (this repo currently has zero TODO markers, so introduce them deliberately and sparingly).
- Coverage tooling adds a devDependency; `@vitest/coverage-v8` must be pinned to the installed vitest major (currently `^4.1.11`).

## Testing strategy

The change is validated by its own new tests plus `npm run lint`, `npm test`, `npm run build`, and the unchanged Playwright suite. The current suite is 17 files and 348 tests; do not treat 336 as the baseline. Dependency audit and asset validation are run by `gate-assets-in-ci`, not by this change.

## Rollout

Documentation and CI only, plus new test files. No production code is modified, so there is no runtime risk and no migration.
