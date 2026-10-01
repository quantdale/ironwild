# Design — Harden core verification (tests + CI gates)

## Current-state analysis

### What the unit suite actually covers

Scanning every `src/...` import across `tests/unit/*.test.js` (15 files, 336 tests, all green) yields:

| Covered | Not covered |
| --- | --- |
| `core/utils`, `core/events`, `core/state`, `core/input` (action layer) | `systems/save`, `systems/quests`, `systems/xp`, `systems/bestiary` |
| `world/terrain` | `world/props`, `world/cells`, `world/environment`, `world/weather`, `world/lod`, `world/landmark`, `world/materials` |
| `combat/damage`, `combat/projectiles`, `combat/status` | `machines/machines`, `machines/ai` (only `machines/perception` is covered) |
| `player/bow`, `player/spear` | `player/player`, `player/camera`, `player/hunterView` |
| `systems/perf`, `systems/dynres`, `systems/assets`, `assets/manifest` | `audio/audio`, `audio/emitters`, `render/lighting` |
| `ui/hud` (pure helpers only) | `ui/menus`, `ui/settings`, `ui/focus`, `ui/minimap`, `ui/tips`, `ui/weakcue`, `ui/a11y` |
| `vfx/vfx`, `vfx/library`, `anim/events`, `anim/graph`, `anim/machineAnim` | `src/main.js` integration |

### The specific gap this change closes

`README.md` states:

> "Unit tests cover the deterministic core — RNG, event bus, damage/weak-point math, status timing, terrain generation, **XP, quests, bestiary, and save normalization (including corrupt-save handling)**."

Four of those eight named areas have no unit test at all. `systems/save.js` is the sharpest case: it is the single most user-visible persistence contract in the game (localStorage `ironwild-save`, versioned schema v2→v3, backward compatibility promise, corrupt-data rejection), and it is defended only by `tests/e2e/save-continue.spec.js`, which asserts a position round-trip through a real browser. The version gate, the `pos` magnitude/finiteness guard, quest-record validation via `isValidQuest`, and the "never load back dead" floor are entirely unverified.

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

1. Round-trip: set player pos/hp/stamina, inventory, skills, timeOfDay, mapRevealed, quests, xp, bestiary → `saveGame()` → reset `G` → `loadGame()` → deep-equal on every field.
2. Version gate: `v: 1` and `v: 99` are rejected (return `false`); `v: 2` and `v: 3` accepted.
3. `pos` guard: missing array, length < 3, non-finite entry, and magnitude beyond `CONFIG.worldSize` are all rejected.
4. Corrupt JSON in storage → `loadGame()` returns `false`, no throw, no partial mutation of `G`.
5. `hp` floor: `hp: 0` or negative loads as at least 1 (never dead on load).
6. XP `next` is never trusted from the save; it is recomputed from the level curve.
7. Quest slots: a malformed record is dropped to `null` (not left wedged), a valid one is restored and re-emits `questUpdate`.
8. Unknown/invalid inventory values are ignored; valid finite numbers are applied.
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

Add to `.github/workflows/ci.yml`, as separate fast steps before the E2E job:

```yaml
- name: Dependency audit
  run: npm audit --audit-level=high

- name: Asset validation
  run: npm run assets:validate
```

Add a coverage script to `package.json` using vitest's built-in coverage (`@vitest/coverage-v8` as a devDependency) and publish the summary as a build artifact. Add the coverage command to `npm run verify`. Do **not** set a hard coverage threshold in this change — establish the measured baseline first, then set a ratchet in a follow-up (the directive's "no percentage theater" rule; a number nobody has agreed on is worse than none).

## Alternatives considered

- **Set a coverage percentage gate now.** Rejected: no baseline exists, and a percentage alone does not indicate confidence. Measure first, ratchet second.
- **Mock the whole `G` singleton for save/quest tests.** Rejected: the existing suites use the real `G` with `vi.resetModules()`, which catches the real serialization shape. Keep that.
- **Add integration tests instead of unit tests for `machines/ai.js`.** Partially adopted: the full FSM is covered by E2E already; this change adds targeted unit coverage only for the deterministic, high-value pieces (spawn layout determinism, respawn queue timing, harvest arithmetic) and leaves deep FSM behavior to E2E.

## Risks

- Tests that lock in *current* behavior can enshrine a bug. Mitigation: every assertion carries a comment naming the behavior it pins; any assertion that looks like it is pinning a defect gets a `FIXME`-style reference to the change that fixes it (this repo currently has zero TODO markers, so introduce them deliberately and sparingly).
- Coverage tooling adds a devDependency; `@vitest/coverage-v8` must be pinned to the installed vitest major (currently `^4.1.11`).

## Testing strategy

The change is validated by its own new tests plus the existing gates: `npm run lint`, `npm test` (existing 336 tests plus new ones), `npm run build`, `npm run assets:validate`, `npm audit --audit-level=high`, and the unchanged Playwright suite.

## Rollout

Documentation and CI only, plus new test files. No production code is modified, so there is no runtime risk and no migration.
