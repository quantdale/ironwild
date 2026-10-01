# Tasks — Bound progression integrity (progression-integrity)

## 0. Cross-change coordination (read before editing)

This change edits `src/systems/xp.js` and the progression block of `src/systems/save.js loadGame()`. Sibling changes that also touch them:

- **`enforce-permadeath-run-model`** edits `src/systems/save.js` (adds the run-lifecycle marker, a `playerDied` handler, and a rejection branch in `loadGame`). **Both changes edit `loadGame` in the same file** — sequence them, ideally in separate commits, and re-read the file before editing rather than assuming the shape you saw in the design.
- **`harden-core-verification`** creates the XP unit suite this change's tests extend. Apply it first if possible so the tests have a home; if it has not landed, create `tests/unit/xp-integrity.test.js` standalone and note that the two suites may need merging later.
- **`fix-bestiary-discovery`** is fully independent (it edits only `src/systems/bestiary.js`).

## 1. State the invariant

- [ ] 1.1 In `src/systems/xp.js`, add a module-header line stating the invariant: `G.xp.cur` is always within `[0, G.xp.next)` outside a `grantXp` call.
- [ ] 1.2 Note in the same header *why* it is enforced (it is what makes the level-up loop terminate, and it is not guaranteed by the restore path without validation).

## 2. Bound the level-up loop

- [ ] 2.1 Add a module constant for the maximum number of level-ups a single `grantXp` may perform, sized far above any legitimate reward (design suggests ~1000; confirm against the largest reward in the XP table, monarch at 500, plus a generous future margin).
- [ ] 2.2 In `grantXp`, add an iteration counter to the `while` condition so the loop cannot run unbounded.
- [ ] 2.3 When the bound is reached, clamp `G.xp.cur` back into `[0, G.xp.next)` and emit a single `console.warn` naming the anomalous level/experience values, so the condition is diagnosable rather than silently absorbed.
- [ ] 2.4 Do not change the loop body: the level increment, threshold re-derivation, skill-point grant, toast, and `levelUp` emission all stay exactly as they are.
- [ ] 2.5 Do not change `nextFor`, the reward tables, or the toast text.

## 3. Validate restored progression

- [ ] 3.1 In `src/systems/save.js loadGame()`, after `G.xp.next = nextFor(G.xp.level)` is derived, clamp `G.xp.cur` into `[0, G.xp.next)`.
- [ ] 3.2 Extend the existing comment so it records that **both** progression fields are now validated (the threshold is derived, the accumulator is clamped), not just the threshold.
- [ ] 3.3 In `src/systems/xp.js createXp()`, apply the same clamp to the existing normalization block, so the invariant holds at boot as well as at load.
- [ ] 3.4 Confirm the clamp is a no-op for every save the current code writes (legitimate saves always satisfy `cur < next`).
- [ ] 3.5 Do not bump the save version and do not change the persisted shape.

## 4. Unit coverage

- [ ] 4.1 Extend the XP unit suite (or create `tests/unit/xp-integrity.test.js`) using the established node-env + `vi.resetModules()` pattern; unsubscribe bus handlers in `afterEach`.
- [ ] 4.2 `{ level: 1, cur: 1e12 }` is clamped to `cur < nextFor(1)` by `createXp`.
- [ ] 4.3 The same state is clamped when produced through the save-load path.
- [ ] 4.4 `grantXp` on an inconsistent state returns and emits a number of `levelUp` events at or below the documented cap (assert the bound, not just termination).
- [ ] 4.5 A legitimate multi-level grant (large enough to cross 3 thresholds) awards exactly 3 level increments, exactly 3 skill points, and leaves `cur` correct.
- [ ] 4.6 A grant landing exactly on a threshold awards exactly 1 level-up and leaves `cur === 0`.
- [ ] 4.7 A consistent save round-trips with values unchanged.
- [ ] 4.8 `{ level: 1e9, cur: 0 }` yields a consistent state and at most one level-up per grant.
- [ ] 4.9 Non-finite and negative `level`/`cur` are rejected exactly as they are today.
- [ ] 4.10 Assert the XP curve and reward tables are unchanged, so a balance regression cannot hide inside this defensive change.
- [ ] 4.11 Run `npm test` and confirm the full suite passes.

## 5. E2E coverage (optional but cheap)

- [ ] 5.1 In an existing E2E spec that drives combat (e.g. `tests/e2e/combat-smoke.spec.js`), assert after a kill that `G.xp.cur < G.xp.next` holds, pinning the invariant in the live game.
- [ ] 5.2 No E2E is required for the corrupt-save path (constructing one is a unit-level concern); note that explicitly rather than leaving it implied.

## 6. Verification

- [ ] 6.1 `npm run lint` clean.
- [ ] 6.2 `npm test` passes.
- [ ] 6.3 `npm run build` succeeds.
- [ ] 6.4 `npx playwright test` — full suite green.
- [ ] 6.5 Manual/headless check: load a hand-edited save containing `xp.cur: 1e12` and confirm the run starts promptly with a sane level and zero accumulated experience (rather than stalling).

## 7. Documentation

- [ ] 7.1 Update the `src/systems/xp.js` header to document the invariant and the bound (following the precedent of `combat/status.js MAX_TICKS_PER_FRAME` and `vfx/library.js` backlog cap, which both explain their guards in prose).
- [ ] 7.2 Note in `docs/BALANCE.md` only if the clamp changes any legitimate progression outcome — it should not, since legitimate saves already satisfy the invariant. State that explicitly rather than leaving it unverified.
