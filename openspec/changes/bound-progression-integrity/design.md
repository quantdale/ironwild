# Design — Bound progression integrity (progression-integrity)

## Current-state analysis

> **Post-merge state (this analysis reflects `main` after the parallel work landed, not the pre-merge tree).** The load-path guard described below has since been implemented; the residual gaps are the boot-time invariant and the loop guard.

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

### What is already fixed on `main`

`src/systems/save.js` now validates both progression fields through a `bounded()` helper:

```js
const MAX_LEVEL = 100;
...
G.xp.level = Math.floor(bounded(data.xp.level, 1, MAX_LEVEL, G.xp.level || 1));
G.xp.next = nextFor(G.xp.level);
G.xp.cur  = Math.floor(bounded(data.xp.cur, 0, G.xp.next - 1, G.xp.cur || 0));
```

This correctly closes the *tampered-save* trigger this change originally identified (a hand-edited `cur: 1e12` can no longer survive a load), and it correctly derives `next` from `level`. **Do not re-implement this.**

### What remains unfixed

Two gaps, both real:

**(a) The invariant is enforced in exactly one place.** `createXp()` — the boot entry point — normalizes each field independently but never checks the relationship:

```js
if (!Number.isFinite(G.xp.level) || G.xp.level < 1) G.xp.level = 1;
if (!Number.isFinite(G.xp.cur)   || G.xp.cur   < 0) G.xp.cur   = 0;
if (!Number.isFinite(G.xp.next)  || G.xp.next  <= 0) G.xp.next = nextFor(G.xp.level);
```

Nothing here stops `G.xp.cur >= G.xp.next`. Every field can be individually valid while the pair is inconsistent — which is precisely the condition `grantXp`'s loop depends on.

**(b) The loop itself is still unguarded:**

```js
while (G.xp.cur >= G.xp.next) {          // no iteration bound
  G.xp.cur -= G.xp.next;
  G.xp.level++;
  G.xp.next = nextFor(G.xp.level);
  G.inventory.skillPoints++;
  bus.emit('notify', { text: `LEVEL ${G.xp.level}`, tone: 'good' });
  bus.emit('levelUp', { level: G.xp.level });
}
```

Every other accumulator in the project is explicitly bounded:

| Site | Guard |
| --- | --- |
| `src/combat/status.js` | `let guard = MAX_TICKS_PER_FRAME; ... guard-- > 0` |
| `src/vfx/library.js:217` | `while (... && guard++ < 4)` |
| `src/vfx/library.js:236` | `while (... && budget-- > 0)` |
| `src/world/props.js` (7 sites) | `guard++ < target * N` |
| `src/systems/xp.js:68` | **none** |

### Why the residual gap still matters

The trigger is no longer "a player edits their save" — that is fixed. It is now a **structural fragility**: one unenforced invariant is load-bearing for an unbounded loop, and it is defended in a single place.

Concrete paths that can still violate it:

1. **Boot ordering / partial restore.** `createXp()` runs before `loadGame()` (Continue is clicked later). Any future path that sets `G.xp` from a different source — a second save slot, an import feature, a test fixture, a dev console command — reproduces the original defect with no guard in the way.
2. **A `G.xp.next` change under an existing `cur`.** The curve has already been retuned once in this project's history (`docs/BALANCE.md` records the `maxArrows` and monarch-HP drift). Any future curve edit that lowers `nextFor` for a given level can put a live, in-memory `cur` above the new `next` — and `grantXp` runs immediately after, in-session, with no reload to re-validate.
3. **`MAX_LEVEL` interaction.** `level` is now clamped to `1..100` on load, but `createXp()` does not apply that ceiling, and `grantXp` increments `level` with no ceiling check. The bound on level advancement is therefore also enforced in only one place.

Quantitatively, if the invariant is violated with a large `cur`, the loop iterates roughly `(cur * 2.35 / 100) ** (1/2.35)` times — a 1e8 violation is ~1,000 iterations emitting ~2,000 bus events (each a HUD toast DOM create/evict and an audio fanfare) synchronously inside one call.

## Intended approach

Fix it on both sides, defense in depth, and keep the two concerns separate so each is independently testable.

### 1. Bound the loop in `grantXp`

Add an explicit iteration cap consistent with the project's existing style, and define the behavior when it is hit. The cap must be far above anything legitimate.

Legitimate worst case: the largest single `grantXp` amount in the game. The reward table tops out at monarch kills (500) and the streak bonus (15); even a generous future reward of ~10,000 XP crosses at most 2–3 levels early on. A cap of **1000 iterations** is two to three orders of magnitude above any legitimate case while still bounding a pathological grant to 1,000 iterations × 2 events = 2,000 events (~tens of ms) — a visible hiccup rather than a multi-second lockup. The `MAX_LEVEL` ceiling (section 3) is the tighter bound on level advancement; the loop cap is the belt-and-braces guard on iteration count.

On hitting the cap: rather than silently truncating (which would corrupt the level/XP relationship), **clamp defensively and normalize** — stop the loop and clamp `cur` into `[0, next)`, and log once. The requirement is bounded work and a consistent state; a truncated-but-consistent state is the correct outcome for data that should never have existed.

### 2. Enforce the invariant at the boot entry point

`createXp()` should establish `cur < next` alongside the per-field normalization it already performs — three lines, no new concept, and it makes the invariant hold at every entry point that currently exists. Do **not** touch `save.js`: its `bounded()` clamp is already correct.

### 3. Reuse `MAX_LEVEL` rather than adding a second ceiling

`MAX_LEVEL` already exists in `save.js` (currently 100). Applying it in `grantXp` gives the loop a hard, already-agreed bound on level advancement rather than introducing a competing constant. Note it currently lives in `save.js`, so implementing this either moves it to `state.js`/`xp.js` (preferred — it is progression tuning, not persistence) or imports it. Flag this choice in the implementation notes.

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

- `src/systems/xp.js`: new module constant for the loop cap; `grantXp` gains a counter and a post-loop clamp; `createXp` gains the `cur < next` clamp; module header documents the invariant. `MAX_LEVEL` may move here from `save.js` (it is progression tuning, not persistence).
- `src/systems/save.js`: **no change required** — its existing `bounded()` clamp is already correct. Optionally note in its comment that `xp.js` now also enforces the invariant at boot.
- No change to: `nextFor`, `KILL_XP`, `ALPHA_MULT`, `PICKUP_XP`, `SCAN_XP`, `STREAK_XP`, the skill-point grant, the toast text, or the save format.

## Failure handling

- Cap reached: clamp + one `console.warn` naming the anomalous values, so the condition is diagnosable in the field rather than silently absorbed. The repo already has a strong culture of documenting anomaly guards in comments (see `status.js MAX_TICKS_PER_FRAME`, `vfx/library.js` backlog cap); follow that precedent.
- `cur` exactly equal to `next`: clamps to 0, which is the correct reading (the player had exactly enough for that level and should have leveled; the load path does not replay the level-up). The save loader's `bounded(cur, 0, next - 1, ...)` already produces this.
- `level` at or above `MAX_LEVEL`: the load path already clamps it to 100. If `createXp` adopts the same ceiling, a level restored in-session at the ceiling stops advancing — assert this explicitly so it is a documented design decision rather than an accident.
- Non-finite `cur`/`level`/`next`: already rejected by the existing `Number.isFinite` checks in `createXp`.

## Alternatives considered

- **Clamp only at the consumer (`grantXp`).** Rejected: leaves the impossible state present in `G` and leaves every other future reader of `G.xp.cur` unprotected. The boundary is where validation belongs, matching how `pos` and quest records are handled in the same loader.
- **Reject the save entirely when `cur >= next`.** Rejected: harsher than necessary — a player with a slightly-inconsistent save loses the whole run over one field, and the clamp is a lossless repair for that case. Rejecting the whole save is already the behavior for genuinely malformed data (non-array `pos`, wrong version).
- **Cap the grant amount instead of the loop.** Rejected: the amount is bounded already (`amt <= 0` returns, and rewards are a fixed table); the problem is the *ratio* between `cur` and `next`, not the grant size. Capping the amount leaves a 1e12 `cur` untouched.
- **Make the XP curve saturating** so thresholds always exceed any plausible `cur`. Rejected: changes game balance to fix a robustness problem.
- **Asynchronous/deferred level-ups** to smooth the emissions. Rejected: disproportionate — the legitimate case never needs it, and the cap makes the pathological case bounded.

## Explicitly considered and excluded

**The save loader (`src/systems/save.js`).** `loadGame` already clamps `level` to `1..MAX_LEVEL` and `cur` to `0..next-1` via `bounded()`. That correctly closes the tampered-save trigger and correctly derives `next` from `level`. Re-implementing or "hardening" it here would be redundant work against an existing correct guard. **Read the current implementation before starting — this section may be out of date if the loader is changed again.**

**Unbounded inventory restore.** `loadGame` restores the inventory with only a finiteness check, so a tampered save can set `arrows: 1e9` or `maxArrows: 1e9`. Also out of scope: no loop or accumulator consumes those values, so the worst outcome is a wrong-looking HUD readout (`1000000000 / 60`) in a save the player hand-edited — no stall, no corruption, no security consequence. Recorded here so the audit trail shows it was considered rather than missed. If a future change introduces a loop, sorting, or allocation driven by an inventory value, that value must be bounded at that point.

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
