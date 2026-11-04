# Tasks — Harden core verification (tests + CI gates)

## 0. Cross-change coordination (read before editing)

This change edits `.github/workflows/ci.yml`, `package.json`, and `README.md`. Sibling changes that also touch them:

- **`gate-assets-in-ci` owns the CI audit step, the CI asset-validation step, and the `assets:validate` insertion into `verify`.** This change must not add those steps or edit that part of `verify`. Its only `package.json` edit is the separate `test:coverage` script. If both changes are applied, do them in separate commits and re-read `package.json` first.
- **`sync-project-documentation`** edits `README.md` (layout block, quality gates, testing section). Task 1.3 below tells that change to defer to this one for the coverage paragraph; keep the same division so the two do not both rewrite it.
- **`enforce-permadeath-run-model`** extends the save unit suite this change creates (see its task 4.1). Apply this change first so the lifecycle tests have a suite to extend.

`tests/e2e/save-continue.spec.js` is referenced by this change (kept green) and extended by `enforce-permadeath-run-model`; this change must not edit its assertions.

## 1. Save system unit coverage

- [ ] 1.1 Create `tests/unit/save-system.test.js` using the `vi.resetModules()` + dynamic-import pattern; stub `../core/input.js` (save.js imports `Input` for the quicksave poll) and provide a live `G.player`.
- [ ] 1.2 Round-trip: seed player pos/hp/stamina, inventory, skills, timeOfDay, mapRevealed, quests (incl. `genCount`), xp, bestiary, and expedition → `saveGame()` → mutate/reset `G` → `loadGame()` → assert every field is restored. Keep `tests/unit/save.test.js` passing; extend it or add a sibling rather than replacing its hostile-input cases.
- [ ] 1.3 Version gate: reject `v: 1` and `v: 99`; accept `v: 2`, `v: 3`, and the current `v: 4`. Do not write a test that treats v4 as invalid.
- [ ] 1.4 Position guard: reject non-array, length < 3, non-finite entries, `Math.hypot(x, z) > CONFIG.playRadius + 12`, `y < -48`, and `y > 220`. Assert `loadGame()` returns `false` and does not partially mutate `G`. Do not assert a `CONFIG.worldSize` bound; that is not the current check.
- [ ] 1.5 Corrupt JSON in storage → `loadGame()` returns `false`, throws nothing, and leaves `G` untouched.
- [ ] 1.6 `hp: 0` and negative `hp` load as at least 1 ("never load back dead" floor).
- [ ] 1.7 A tampered/stale `xp.next` in the save is ignored and recomputed from the level curve via `nextFor`.
- [ ] 1.8 Quest slots: a record failing `isValidQuest` is dropped to `null`; a valid record is restored and re-emits `questUpdate`.
- [ ] 1.9 Inventory: non-finite values ignored, unknown keys ignored, and finite values clamped to the caps already implemented in `restoreInventory` (resources and skill points 9999, medicine 99, armor 0..2, arrows at the live max). Do not expect `1e9` to round-trip; `tests/unit/save.test.js` already locks the caps.
- [ ] 1.10 `hasSave()` / `clearSave()` happy paths and the storage-unavailable (throwing) path.
- [ ] 1.11 `updateSave()`: autosave fires at `AUTOSAVE_INTERVAL`; the pause rising edge snapshots once; `quicksave` action triggers a manual save; the interval resets even when the write fails.

## 2. Quest system unit coverage

- [ ] 2.1 Create `tests/unit/quests-system.test.js` (same pattern; quests.js imports `G`, `bus`, `utils` only).
- [ ] 2.2 `createQuests()` deals exactly three slots and the first three are one of each type (hunt / gather / scanVantage) driven by `G.quests.genCount`.
- [ ] 2.3 `machineDied` with a matching type increments only matching hunt slots and completes at `need`; a non-matching type is ignored.
- [ ] 2.4 `pickup` increments a matching gather slot by the emitted amount, capped at `need`.
- [ ] 2.5 `machineScanned` completes a `scanVantage` slot.
- [ ] 2.6 Completion grants the documented reward and increments `G.quests.completed`: hunt +1 SP, gather +6 shards, scanVantage +1 medicine, ironmaw hunt +1 bonus SP.
- [ ] 2.7 A completed slot refills after `REFILL_DELAY` seconds of `updateQuests(dt)`; an open slot does not.
- [ ] 2.8 An open `scanVantage` slot is replaced when no live Vantage exists (no deadlock), and a null slot is dealt a replacement.
- [ ] 2.9 `isValidQuest` rejects: unknown type; hunt target not in `HUNT_TYPES`; gather target not in `GATHER_TYPES`; non-finite `progress`/`need`/`refillT`; `need <= 0`; non-object input.
- [ ] 2.10 `genCount` is incremented on every deal and is part of the serializable quest state (required for "first three" to survive Continue).

## 3. XP system unit coverage

- [ ] 3.1 Create `tests/unit/xp-system.test.js`.
- [ ] 3.2 `nextFor(level)` matches `Math.round(100 * level ** 1.35)` and is monotonically increasing.
- [ ] 3.3 A single grant that crosses multiple thresholds levels up once per threshold, grants one skill point per level, and decrements `cur` by each threshold (no XP lost).
- [ ] 3.4 `xpGain` fires once per grant with the amount and reason; `levelUp` fires once per level with the level.
- [ ] 3.5 Kill XP per roster type; `vantage` grants nothing; alpha kills grant 1.5× base.
- [ ] 3.6 `pickup` grants a flat amount; `machineScanned` grants its amount; `killStreak` pays only on every third link.
- [ ] 3.7 `createXp()` normalizes a partially-corrupt `G.xp` (non-finite `level`, negative `cur`, non-finite/`<= 0` `next`).
- [ ] 3.8 Non-positive / non-finite grant amounts are rejected without mutating state.

## 4. Bestiary unit coverage

- [ ] 4.1 Create `tests/unit/bestiary-system.test.js`.
- [ ] 4.2 Scanning a machine marks `seen` only; killing it marks both `seen` and `killed`.
- [ ] 4.3 Re-entry is idempotent: `bestiaryUnlock` fires exactly once per (type, kind) and no duplicate `notify` is emitted.
- [ ] 4.4 An unknown machine type is ignored and creates no entry.
- [ ] 4.5 `speciesLore` returns a line only for `killed` species and `''` otherwise; `speciesName` falls back to the raw key for unknown types.
- [ ] 4.6 `createBestiary()` seeds every `SPECIES` entry as undiscovered and is idempotent.

## 5. Machine body / damage unit coverage

- [ ] 5.1 Create `tests/unit/machine-bodies.test.js` (real `THREE.Scene`, no WebGL; `G.scene` set, `G.player` present for animation channels).
- [ ] 5.2 Weak-point damage reduces `wp.hp`; at zero the point becomes `broken`, `partBroken` fires once, the machine staggers, and further weak-point hits fall through to the body.
- [ ] 5.3 Part-break charring touches only that part's own materials — the shared hull/rust/joint material instances must NOT be charred (pins the documented `registerWeakPoint` invariant).
- [ ] 5.4 Body damage reduces hp; `hp <= 0` kills exactly once (`machineDied` emitted once, `alive === false`).
- [ ] 5.5 Bulwark front-cone hits: `hit()` returns `false`, hp is unchanged, `hitFlag` is set, no `machineHit` damage path, and no burn is applied (pins the `burnInteraction: 'immune'` rule).
- [ ] 5.6 Alpha variant: `Alpha ` name prefix, max hp × 1.6, `damageMul` 1.25, and double loot.
- [ ] 5.7 Loot drops match the `LOOT` table entry count for the type (and double for alpha), registering into `G.pickups`.
- [ ] 5.8 `dispose()` removes the record from `G.machines` exactly once and is idempotent on a second call.
- [ ] 5.9 `createMachine` throws a clear error for an unknown type (pins the guard).
- [ ] 5.10 Detail/shadow LOD tick: beyond the detail distance, sub-threshold parts hide; beyond the shadow-caster distance, casting stops; crossing back re-enables — and weak-point nodes are never hidden.

## 6. Targeted AI unit coverage

- [ ] 6.1 Create `tests/unit/ai-spawn.test.js` covering only the deterministic, high-value paths (deep FSM behavior stays with E2E): deterministic spawn layout for the fixed seed (count per type, monarch far spawn, mirefang submerged lairs).
- [ ] 6.2 Respawn queue: a dead non-alpha machine is re-dealt after `RESPAWN_AFTER`, an alpha after `RESPAWN_AFTER_ALPHA`, and the Monarch/Vantage never respawn.
- [ ] 6.3 Respawn never pops in within 12 units of the player, and respects the population cap.
- [ ] 6.4 Hardened difficulty multiplies rather than overwrites the alpha damage/hp scaling.
- [ ] 6.5 Carcass harvest arithmetic: grants shards/oil/wood/hide scaled by the scavenger skill, emits one `pickup` per resource, and marks the carcass harvested so it cannot be harvested twice.
- [ ] 6.6 `G.threat` and `G.bossNear` are written each `updateMachines` tick consistent with the aggro roster and monarch proximity.
- [ ] 6.7 Noise hearing: a noise inside radius escalates a non-attacking machine; Vantage, Mirefang and Monarch ignore it.

## 7. CI gates

- [ ] 7.1 Do **not** add a dependency-audit step or an asset-validation step to `.github/workflows/ci.yml`. Those steps are owned exclusively by `gate-assets-in-ci`.
- [ ] 7.2 Add `@vitest/coverage-v8`, pinned to the installed Vitest major, and a `test:coverage` script. Do not add that script to `verify`.
- [ ] 7.3 Publish the coverage summary as a CI artifact. Do not change the existing Playwright failure-upload step except to avoid a name clash.
- [ ] 7.4 Do not add a hard coverage percentage gate. Record the measured baseline in the change notes.
- [ ] 7.5 Confirm this change does not reorder lint → unit → build → e2e and does not lengthen the E2E job.

## 8. Documentation

- [ ] 8.1 Rewrite the `README.md` "Testing" section so the enumerated coverage list matches reality after this change; explicitly state that DOM/UI panels, the machine FSM, audio, and full integration are covered by the Playwright suite rather than unit tests.
- [ ] 8.2 Document the new `npm run` scripts (`test:coverage`) and the new CI gates in the README's quality-gate block.
- [ ] 8.3 If any new test pins behavior that is arguably a defect, add a short comment referencing the follow-up change that fixes it; do not silently normalize the defect.
- [ ] 8.4 Update `docs/aaa-upgrade/ROADMAP.md` P0 item "CI quality gate" with a pointer to the gates added here (documentation-only; no product code).

## 9. Final verification

- [ ] 9.1 `npm run lint` clean.
- [ ] 9.2 `npm test` — all pre-existing tests still pass, plus the new suites. Do not hard-code 336; the merged tree already has 348.
- [ ] 9.3 `npm run assets:validate` exits 0.
- [ ] 9.4 `npm run build` succeeds.
- [ ] 9.5 `npx playwright test` — full suite green, console clean.
- [ ] 9.6 `npm run verify` (lint + unit + e2e) passes end to end.
- [ ] 9.7 `git status` shows only test files, CI config, `package.json`/lockfile, and documentation changed — no production source modified.
