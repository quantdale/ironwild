# Tasks — Bound progression integrity (progression-integrity)

> **Read this first: scope changed after the parallel work landed on `main`.** `systems/save.js` now already clamps `level` to `1..MAX_LEVEL` and `cur` to `0..next-1` via a `bounded()` helper. **Do not re-implement the load-path clamp** — tasks that asked for it have been removed. What remains is the boot-time invariant (section 3) and the loop guard (section 2). Re-read `src/systems/save.js` and `src/systems/xp.js` before starting: both may have changed again.

## 0. Cross-change coordination (read before editing)

This change edits `src/systems/xp.js` and may move `MAX_LEVEL` out of `src/systems/save.js`. Sibling changes that also touch them:

- **`enforce-permadeath-run-model`** edits `src/systems/save.js` (run-lifecycle marker, `playerDied` handler, a rejection branch in `loadGame`). If `MAX_LEVEL` is moved out of `save.js`, that change and this one edit the same file — **sequence them, ideally in separate commits**, and re-read the file before editing rather than assuming the shape seen in the design.
- **`harden-core-verification`** creates the XP unit suite this change's tests extend. Apply it first if possible so the tests have a home; if it has not landed, create `tests/unit/xp-integrity.test.js` standalone and note that the two suites may need merging later.
- **`fix-bestiary-discovery`** is fully independent (it edits only `src/systems/bestiary.js`).

## 1. State the invariant

- [ ] 1.1 In `src/systems/xp.js`, add a module-header line stating the invariant: `G.xp.cur` is always within `[0, G.xp.next)` outside a `grantXp` call.
- [ ] 1.2 Note in the same header why it is enforced. The save loader already clamps it; `createXp()` is one-shot, so `grantXp()` must restore the invariant before returning.

## 2. Bound the level-up loop

- [ ] 2.1 Add a module constant for the maximum number of level-ups a single `grantXp` may perform, sized far above any legitimate reward (design suggests ~1000; confirm against the largest reward in the XP table, monarch at 500, plus a generous future margin).
- [ ] 2.2 In `grantXp`, add an iteration counter to the `while` condition so the loop cannot run unbounded.
- [ ] 2.3 When the bound is reached, clamp `G.xp.cur` back into `[0, G.xp.next)` and emit a single `console.warn` naming the anomalous level/experience values, so the condition is diagnosable rather than silently absorbed.
- [ ] 2.4 Keep the normal loop body for levels below `MAX_LEVEL`: level increment, threshold re-derivation, skill-point grant, toast, and `levelUp` emission stay as they are. At the ceiling, do not increment level or grant a skill point; clamp `cur` into `[0, next)` before returning so the next grant cannot spin.
- [ ] 2.5 Do not change `nextFor`, the reward tables, or the toast text.
- [ ] 2.6 Document that `createXp()` is one-shot. Its clamp does not observe a later direct write; `grantXp()` is the guard for that case.

## 3. Enforce the invariant at boot

- [ ] 3.1 In `src/systems/xp.js createXp()`, extend the existing normalization block to establish `cur < next` (clamp `cur` into `[0, next)`), so the invariant holds at boot alongside the per-field checks that are already there.
- [ ] 3.2 Apply the same `MAX_LEVEL` ceiling in `createXp()` that `save.js` already applies. This covers boot only; `createXp()` does not run again for a later writer.
- [ ] 3.3 Do **not** modify the `bounded()` clamp in `src/systems/save.js` — verify it is still present and correct, and leave it alone if so.
- [ ] 3.4 Decide where `MAX_LEVEL` lives. It is currently declared in `save.js` but is progression tuning, not persistence; prefer moving it to `core/state.js` `CONFIG` or `xp.js` so both consumers can read it without a save→xp dependency. Record the choice.
- [ ] 3.5 Add a short comment at both the save clamp and the boot clamp stating that they defend the same invariant, so a future change does not remove one believing the other covers it.

## 4. Unit coverage

- [ ] 4.1 Extend the XP unit suite (or create `tests/unit/xp-integrity.test.js`) using the established node-env + `vi.resetModules()` pattern; unsubscribe bus handlers in `afterEach`.
- [ ] 4.2 `{ level: 1, cur: 1e12 }` is clamped to `cur < nextFor(1)` by `createXp()` (the **boot** path).
- [ ] 4.3 `grantXp` on an inconsistent state returns and emits a number of `levelUp` events at or below the documented cap (assert the bound, not just termination).
- [ ] 4.4 A legitimate multi-level grant (large enough to cross 3 thresholds) awards exactly 3 level increments, exactly 3 skill points, and leaves `cur` correct — i.e. the bound does not truncate normal play.
- [ ] 4.5 A grant landing exactly on a threshold awards exactly 1 level-up and leaves `cur === 0`.
- [ ] 4.6 A consistent save round-trips with values unchanged (this exercises the existing `save.js` clamp as a regression lock — do not change that code, just pin its behavior).
- [ ] 4.7 `{ level: 1e9, cur: 0 }` is clamped to the supported level range and yields a consistent state.
- [ ] 4.11 At `MAX_LEVEL`, another grant does not increment level or skill points, and it leaves `cur < next`.
- [ ] 4.8 Non-finite and negative `level`/`cur` are rejected exactly as they are today.
- [ ] 4.9 Assert the XP curve and reward tables are unchanged, so a balance regression cannot hide inside this defensive change.
- [ ] 4.10 Run `npm test` and confirm the full suite passes.

## 5. E2E coverage (optional but cheap)

- [ ] 5.1 In an existing E2E spec that drives combat (e.g. `tests/e2e/combat-smoke.spec.js`), assert after a kill that `G.xp.cur < G.xp.next` holds, pinning the invariant in the live game.
- [ ] 5.2 No E2E is required for this change: the residual trigger needs a boot-time/partial-restore state that no UI flow produces, so it belongs at the unit level. State that explicitly rather than leaving it implied.

## 6. Verification

- [ ] 6.1 `npm run lint` clean.
- [ ] 6.2 `npm test` passes.
- [ ] 6.3 `npm run build` succeeds.
- [ ] 6.4 `npx playwright test` — full suite green.
- [ ] 6.5 Headless/manual check: load a save, then in the console force an inconsistent state (`__IW.G.xp.cur = 1e12`) and call `grantXp` indirectly via a kill; confirm the run responds promptly and the state settles consistently rather than stalling.

## 7. Documentation

- [ ] 7.1 Update the `src/systems/xp.js` header to document the invariant and the bound (following the precedent of `combat/status.js MAX_TICKS_PER_FRAME` and `vfx/library.js` backlog cap, which both explain their guards in prose).
- [ ] 7.2 Note in `docs/BALANCE.md` only if the clamp changes any legitimate progression outcome — it should not, since legitimate saves already satisfy the invariant. State that explicitly rather than leaving it unverified.
