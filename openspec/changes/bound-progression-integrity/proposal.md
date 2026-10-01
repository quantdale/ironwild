## Why

`grantXp` carries the only unbounded accumulator loop in the codebase, and the values it iterates on can be restored from the save slot. `save.js` deliberately re-derives the level threshold on load precisely so a tampered or stale save "can't hand out instant level-ups or **wedge progression**" — but the companion field, the accumulated XP itself, is restored with only a `>= 0` finiteness check and **no upper bound**. Every other accumulator in the project is explicitly guarded (`MAX_TICKS_PER_FRAME` in `combat/status.js`, `guard++ < 4` in `vfx/library.js`, `guard++ < target * N` in every `world/props.js` placement builder); this one is not. A save whose accumulated XP is far above the level threshold makes the loop run thousands of times synchronously inside a single `grantXp` call, emitting thousands of `notify` and `levelUp` events (each creating HUD toasts and audio voices) and stalling the frame.

## What Changes

- **Bound the level-up loop.** The loop that carries XP across level thresholds must have a finite iteration bound, matching the guard style already used elsewhere in the project, so a single grant can never spend an unbounded amount of time or emit an unbounded number of events.
- **Bound restored progression data.** Progression state restored from a save must be validated so that accumulated XP is consistent with the level threshold, matching the validation already applied to the threshold itself. A save whose values are inconsistent must be repaired to a consistent state rather than left to be resolved on the first grant.
- **Preserve legitimate multi-level grants.** A normal grant that legitimately crosses several thresholds (a large single reward, a streak bonus) must still award every threshold crossed — the bound must not truncate normal play.
- **Add regression coverage** for the corrupt-save case, the large-legitimate-grant case, and the existing normal cases.
- No change to the XP curve, the reward amounts, or the leveling rewards themselves.

## Capabilities

### New Capabilities
- `progression-integrity`: The observable contract that level progression is robust against restored or corrupted data — that a single experience grant completes in bounded time, that inconsistent progression state is repaired rather than deferred, and that legitimate multi-level grants still award every threshold crossed.

### Modified Capabilities
<!-- None: first specification of this behavior; openspec/specs/ is currently empty. -->

## Impact

- Affected code: `src/systems/xp.js` (`grantXp` loop bound, `createXp` normalization), `src/systems/save.js` (`loadGame` progression validation), `tests/unit/` (progression unit suite — the natural home is the XP suite added by `harden-core-verification`), and a comment in `src/systems/save.js` recording that both progression fields are now validated.
- No change to the level curve, XP reward values, skill-point grant, or any persisted field's meaning.
- Player-visible only in the corrupt-save case, where the current behavior is a multi-second stall at run start.
