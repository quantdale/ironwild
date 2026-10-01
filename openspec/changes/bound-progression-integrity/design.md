# Design — Bound progression integrity (progression-integrity)

## Current-state analysis

### The unbounded loop

`src/systems/xp.js`:

```js
export function grantXp(amount, reason) {
  const amt = Math.round(Number(amount) || 0);
  if (amt <= 0) return;
  G.xp.cur += amt;
  bus.emit('xpGain', { amount: amt, reason: String(reason || '') });
  while (G.xp.cur >= G.xp.next) {          // <-- no iteration bound
    G.xp.cur -= G.xp.next;
    G.xp.level++;
    G.xp.next = nextFor(G.xp.level);
    G.inventory.skillPoints++;
    bus.emit('notify', { text: `LEVEL ${G.xp.level}`, tone: 'good' });
    bus.emit('levelUp', { level: G.xp.level });
  }
}
```

Every other accumulator in the project is explicitly bounded:

| Site | Guard |
| --- | --- |
| `src/combat/status.js:212` | `let guard = MAX_TICKS_PER_FRAME; ... guard-- > 0` |
| `src/vfx/library.js:217` | `while (... && guard++ < 4)` |
| `src/vfx/library.js:236` | `while (... && budget-- > 0)` |
| `src/world/props.js` (7 sites) | `guard++ < target * N` |
| `src/machines/ai.js:534` | `while (moved < STUCK_MIN_MOVE)` — audited below |
| `src/systems/xp.js:68` | **none** |

### The data feeding it is save-restored, and only half-validated

`src/systems/save.js loadGame()`:

```js
if (data.xp && typeof data.xp === 'object') {
  if (Number.isFinite(data.xp.level) && data.xp.level >= 1) G.xp.level = data.xp.level;
  if (Number.isFinite(data.xp.cur) && data.xp.cur >= 0) G.xp.cur = data.xp.cur;
  // `next` is never trusted from the save: recompute it from the level
  // curve so a tampered/stale threshold can't hand out instant level-ups
  // or wedge progression. ...
  G.xp.next = nextFor(G.xp.level);
}
```

The comment shows the author reasoning about exactly this threat class ("wedge progression") and defending the **threshold**. The **accumulator** is restored with a finiteness/positivity check and no upper bound. Those two fields are the only two halves of the loop's termination condition, and only one of them is constrained.

### Quantified consequence

`nextFor(level) = Math.round(100 * level ** 1.35)`, so the cumulative cost to reach level N grows as `100 * N^2.35 / 2.35`. Inverting: to consume `cur`, the loop runs roughly `(cur * 2.35 / 100) ** (1/2.35)` times.

| `G.xp.cur` restored | Approx. iterations | Bus events emitted (2/iter) |
| --- | --- | --- |
| 1e6 | ~90 | ~180 |
| 1e8 | ~1,000 | ~2,000 |
| 1e12 | ~13,000 | ~26,000 |

Each iteration emits `notify` (HUD toast — `hud.js spawnToast` creates a DOM node and evicts the oldest beyond a 5-deep cap) and `levelUp` (`audio.js` plays a fanfare, subject to voice caps; `hud.js` restarts the XP-bar pulse via a forced reflow). So a 1e8 restore is roughly 2,000 toast DOM create/destroy cycles plus 1,000 reflow-forced animations, all synchronous inside one call on the first XP gain after the run starts.

This is a frame-time spike of seconds, not a cosmetic issue, and it happens at a moment the player cannot act around (immediately after Continue).

### Is it reachable without malice?

Through ordinary play, **no**: `grantXp` always drains `cur` below `next` before returning, so a legitimately-written save always satisfies `cur < nextFor(level)` and the loop runs at most a few times.

It is reachable through:

1. **A corrupt or hand-edited save.** `loadGame` accepts any finite `cur >= 0`. `cur: 1e12` passes every check. The save schema's own defensive posture (rejecting bad `pos`, malformed quest records, stale thresholds) is defeated by the one field it does not bound.
2. **A future level-curve retune in the wrong direction.** `next` is derived at load from the *current* curve, while `cur` was written under the *old* curve. Raising the curve makes old saves harmless; **lowering** it (e.g. flattening early levels) can push an existing save's `cur` above the new `next`. That is a plausible future edit to a curve the project has already tuned once (`docs/BALANCE.md` records curve/tuning changes), and it would convert a tuning change into a stall for every existing save.
3. **Any future code path that writes `G.xp.cur` directly** without draining it.

Case 2 is the important one: this is a latent trap that a routine balance edit would spring.

## Intended approach

Fix it on both sides, defense in depth, and keep the two concerns separate so each is independently testable.

### 1. Bound the loop in `grantXp`

Add an explicit iteration cap consistent with the project's existing style, and define the behavior when it is hit. The cap must be far above anything legitimate.

Legitimate worst case: the largest single `grantXp` amount in the game. The reward table tops out at monarch kills (500) and the streak bonus (15); even a generous future reward of ~10,000 XP crosses at most 2–3 levels early on. A cap of **1000 iterations** is two to three orders of magnitude above any legitimate case while still bounding a pathological grant to 1,000 iterations × 2 events = 2,000 events (~tens of ms) — a visible hiccup rather than a multi-second lockup.

On hitting the cap: rather than silently truncating (which would corrupt the level/XP relationship), **clamp defensively and normalize** — stop the loop and clamp `cur` into `[0, next)`, and log once. The requirement is bounded work and a consistent state; a truncated-but-consistent state is the correct outcome for data that should never have existed.

### 2. Validate the accumulator on load

Mirror the existing threshold treatment: after restoring `cur`, if `cur >= next`, the pair is inconsistent, so clamp `cur` into `[0, next)`. This makes the impossible state unreachable at the boundary rather than only survivable at the consumer.

Note the ordering subtlety: `next` is derived from `level` **after** `level` is restored, so the clamp must happen after both. That is the natural order already in the code.

### 3. Normalize in `createXp` too

`createXp()` already normalizes non-finite/invalid `G.xp` at boot, but it does not check the `cur < next` relationship. Adding the same clamp there covers the case where `G.xp` was set by some path that bypassed `loadGame` (e.g. a future restore path, or a test fixture). Three lines, and it makes the invariant hold at every entry point.

### The invariant to state

> `G.xp.cur` is always in `[0, G.xp.next)` outside a `grantXp` call.

This is the single sentence worth putting in the module header. It is currently true by construction through normal play and is what makes the loop terminate; making it an enforced invariant at every entry point is what makes it robust.

## Control flow after the change

```text
boot:   createXp()          -> normalize level/cur/next, clamp cur into [0, next)
load:   loadGame()          -> restore level, derive next = nextFor(level),
                               restore cur, clamp cur into [0, next)
play:   grantXp(amount)
          cur += amt
          iterations = 0
          while (cur >= next && iterations++ < MAX_LEVEL_UPS) {
            cur -= next; level++; next = nextFor(level); skillPoints++
            emit notify; emit levelUp
          }
          if (iterations hit the cap) { cur = clamp(cur, 0, next); log once }
```

## Data-flow / state changes

- `src/systems/xp.js`: new module constant for the cap; `grantXp` gains a counter and a post-loop clamp; `createXp` gains the same clamp; module header documents the invariant.
- `src/systems/save.js`: `loadGame` clamps restored `cur` into `[0, next)` after deriving `next`; the existing comment is extended to state that **both** progression fields are now validated, not just the threshold.
- No change to: `nextFor`, `KILL_XP`, `ALPHA_MULT`, `PICKUP_XP`, `SCAN_XP`, `STREAK_XP`, the skill-point grant, the toast text, or the save format.

## Failure handling

- Cap reached: clamp + one `console.warn` naming the anomalous values, so the condition is diagnosable in the field rather than silently absorbed. The repo already has a strong culture of documenting anomaly guards in comments (see `status.js MAX_TICKS_PER_FRAME`, `vfx/library.js` backlog cap); follow that precedent.
- `cur` restored as exactly `next`: clamps to 0, which is the correct reading (the player had exactly enough for that level and should have leveled; the load path does not replay the level-up).
- `level` restored as a huge finite value (e.g. 1e9): `nextFor(1e9)` is astronomically large but finite, so the invariant holds and the loop cannot run more than once. Worth asserting, because it is the cheap test that proves the bound is not needed for that case.
- Non-finite `cur`: already rejected by the existing `Number.isFinite` check.

## Alternatives considered

- **Clamp only at the consumer (`grantXp`).** Rejected: leaves the impossible state present in `G` and leaves every other future reader of `G.xp.cur` unprotected. The boundary is where validation belongs, matching how `pos` and quest records are handled in the same loader.
- **Reject the save entirely when `cur >= next`.** Rejected: harsher than necessary — a player with a slightly-inconsistent save loses the whole run over one field, and the clamp is a lossless repair for that case. Rejecting the whole save is already the behavior for genuinely malformed data (non-array `pos`, wrong version).
- **Cap the grant amount instead of the loop.** Rejected: the amount is bounded already (`amt <= 0` returns, and rewards are a fixed table); the problem is the *ratio* between `cur` and `next`, not the grant size. Capping the amount leaves a 1e12 `cur` untouched.
- **Make the XP curve saturating** so thresholds always exceed any plausible `cur`. Rejected: changes game balance to fix a robustness problem.
- **Asynchronous/deferred level-ups** to smooth the emissions. Rejected: disproportionate — the legitimate case never needs it, and the cap makes the pathological case bounded.

## Explicitly considered and excluded

`loadGame()` also restores the **inventory** with only a finiteness check:

```js
if (data.inventory && typeof data.inventory === 'object') {
  for (const k in G.inventory) {
    const v = data.inventory[k];
    if (typeof v === 'number' && isFinite(v)) G.inventory[k] = v;
  }
}
```

So a tampered save can set `arrows: 1e9` or `maxArrows: 1e9`. This is deliberately **out of scope** for this change: unlike `xp.cur`, no loop or accumulator consumes those values, so the worst outcome is a wrong-looking HUD readout (`1000000000 / 60`) in a save the player hand-edited. There is no stall, no corruption, and no security consequence. Treating it as the same defect would inflate the severity of a cosmetic issue; it is recorded here so the audit trail shows it was considered rather than missed. If a future change introduces a loop, sorting, or allocation driven by an inventory value, that value must be bounded at that point.

## Rollout / compatibility

Purely defensive. Legitimate saves (`cur < next`, which every save written by the current code satisfies) are bit-for-bit unaffected: the clamp is a no-op and the cap is never approached. No migration, no save version bump, no balance change.

## Testing strategy

- Unit (`src/systems/xp.js`; extend the XP suite from `harden-core-verification` if it landed, otherwise create `tests/unit/xp-integrity.test.js`):
  - a restore-equivalent state of `{ level: 1, cur: 1e12 }` is clamped to `cur < nextFor(1)` by `createXp` and by `loadGame`;
  - `grantXp` on such a state completes and emits a bounded number of `levelUp` events (assert the count is at or below the documented cap, and that the call returns);
  - a legitimate multi-level grant (e.g. `grantXp` large enough to cross 3 thresholds) awards exactly 3 level increments, 3 skill points, and leaves `cur` correct;
  - `grantXp` bringing `cur` exactly to `next` awards exactly 1 level-up and leaves `cur === 0`;
  - a consistent save (`cur < next`) round-trips through `loadGame` with values unchanged;
  - `level: 1e9` with `cur: 0` produces a consistent state and at most one level-up per grant;
  - non-finite and negative `level`/`cur` are rejected as they are today.
- Save-loader unit: assert `cur >= next` in a save is repaired rather than adopted, and that the "never trust the threshold" behavior is unchanged.
- E2E: not strictly required (the trigger needs a crafted save), but a cheap equivalent is asserting that a normal run's `G.xp.cur < G.xp.next` holds after a kill, pinning the invariant in the live game.
- Non-regression: `npm test` and `npx playwright test` green; the XP curve and reward values are asserted unchanged so a balance regression cannot hide in this change.

## Risks

- **The cap is set too low and truncates a legitimate grant.** Mitigated by the multi-level test asserting a real large grant is not truncated, and by sizing the cap three orders of magnitude above any plausible reward. If a future reward is genuinely huge, the cap is a single constant to raise and the clamp keeps the state consistent either way.
- **Clamping at load silently alters a save's meaning.** For the only case that reaches it (`cur >= next`), the current behavior is a stall, so no working state is lost. The clamp is logged.
