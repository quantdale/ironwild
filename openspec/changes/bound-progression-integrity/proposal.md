## Why

> **Revised after `origin/main` merge (commit 7786150 / f5bd8d5).** The load-path half of this finding has since been fixed independently: `systems/save.js` now clamps `level` to `1..MAX_LEVEL` and `cur` to `0 .. next-1` via a `bounded()` helper before assigning. That closes the tampered-save trigger this change originally identified. Two residual gaps remain, and this change now covers only those.

`grantXp` carries the only unbounded accumulator loop in the codebase, and the loop's termination condition depends on an invariant (`cur < next`) that **only the save loader now enforces**:

- `createXp()` normalizes non-finite/negative `level`/`cur`/`next` individually, but never checks the `cur < next` relationship, so a partially-initialized or future-restored `G.xp` can violate it at boot.
- `grantXp()`'s `while (G.xp.cur >= G.xp.next)` has no iteration guard, so any path that violates the invariant produces unbounded synchronous work and unbounded `notify`/`levelUp` emissions.

Every other accumulator in the project is explicitly guarded (`MAX_TICKS_PER_FRAME` in `combat/status.js`, `guard++ < 4` in `vfx/library.js`, `guard++ < target * N` in every `world/props.js` placement builder); this one is not. The residual risk is no longer "a hand-edited save stalls the game" — it is "the invariant is enforced in exactly one place, so any second restore path, boot-order change, or future feature that writes `G.xp` re-opens the same unbounded loop".

## What Changes

- **State and enforce the `cur < next` invariant at every entry point**, not only in the save loader: `createXp()` should establish it at boot alongside the existing per-field normalization.
- **Bound the level-up loop.** The loop that carries XP across level thresholds must have a finite iteration bound, matching the guard style already used elsewhere in the project, so a single grant can never spend unbounded time or emit unbounded events regardless of how the invariant was reached.
- **Preserve legitimate multi-level grants.** A normal grant that legitimately crosses several thresholds (a large reward, a streak bonus) must still award every threshold crossed — the bound must not truncate normal play.
- **Honor the existing `MAX_LEVEL` ceiling** rather than introducing a second, competing cap for level advancement.
- **Add regression coverage** for the boot-time invariant, the loop bound, and the existing normal cases.
- No change to the XP curve, the reward amounts, or the leveling rewards themselves.

## Capabilities

### New Capabilities
- `progression-integrity`: The observable contract that level progression is robust against restored or corrupted data — that a single experience grant completes in bounded time, that inconsistent progression state is repaired rather than deferred, and that legitimate multi-level grants still award every threshold crossed.

### Modified Capabilities
<!-- None: first specification of this behavior; openspec/specs/ is currently empty. -->

## Impact

- Affected code: `src/systems/xp.js` (`grantXp` loop bound, `createXp` invariant enforcement). `src/systems/save.js` is **already correct** for the load path and needs no change beyond a comment if one is useful.
- No change to the level curve, XP reward values, skill-point grant, or any persisted field's meaning.
- Player-visible only in the corrupt-save case, where the current behavior is a multi-second stall at run start.
