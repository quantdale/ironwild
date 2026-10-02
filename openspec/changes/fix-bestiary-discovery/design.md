# Design — Fix bestiary discovery (bestiary-progression)

## Current-state analysis

### The event plumbing (verified)

`machineScanned` has exactly two emit sites, and **both** filter to Vantage before emitting:

```js
// src/machines/ai.js:1910  (updateScans)
if (!m.alive || m.type !== 'vantage' || !m._ai || m._ai.scanCd > 0) continue;
...
bus.emit('machineScanned', { machine: m });          // :1924

// src/ui/focus.js:320  (checkVantageScan)
if (!m || m.type !== 'vantage' || m.alive === false || !m.group) continue;
...
bus.emit('machineScanned', { machine: m });          // :324
```

Both filters are correct for their purpose: the event carries the map-reveal + skill-point reward (`ai.js grantScanReward`) and drives the `scanVantage` contract and scan XP, all of which are documented as Vantage-only rewards.

`src/systems/bestiary.js` subscribes to exactly two events:

```js
bus.on('machineScanned', onScanned);   // -> markSeen(m.type)
bus.on('machineDied',     onDied);     // -> markKilled(m.type)
```

and `markKilled` sets `e.seen = true` in addition to `e.killed = true`.

### The resulting state machine

| Path | sets `seen` | sets `killed` | reachable for |
| --- | --- | --- | --- |
| focus-scan a Vantage | yes | no | vantage only |
| kill any machine | yes | yes | all species |

So for the eight non-Vantage species, the **only** path to `seen` is `killed`. A player who has fought a skitter repeatedly — damaged it, been chased by it, fled it — sees `???` in the bestiary, which contradicts `README.md:92`:

> "**Bestiary** (key B): every species starts as '???'; **scanning or fighting one reveals its name**, killing it unlocks a one-line lore entry."

Runtime probe (production build, fresh run, machines present and visible): all nine species report `{seen: false, killed: false}` after boot, and non-Vantage entries stay that way through combat unless a kill lands.

### Root cause

The bestiary overloaded a **reward-bearing** event (`machineScanned`, deliberately Vantage-gated) as its **discovery** signal. When the scan reward was correctly restricted to Vantage, discovery silently inherited that restriction. The module header states the intent correctly ("`seen` (focus-scanned **or fought** at least once)") — the fought path was simply never implemented.

## Intended approach

Decouple discovery from the reward event. The bestiary needs to observe *engagement*, which is a different signal from *scanning*.

### Trigger selection

Candidate signals already available on the bus, with their cost/precision trade-offs:

| Candidate | Emitted by | Precision | Notes |
| --- | --- | --- | --- |
| `machineHit` | `projectiles.js` + `spear.js` on every resolved hit | exact: the player caused damage | Fires on deflected bulwark hits too (those return `false` before the event) — acceptable, the player *did* engage. |
| `machineAlert` | `ai.js enterAttack` / mirefang ambush | "the machine noticed you" | Nice flavor but not player-initiated, and misses ambushes where the player never saw the machine. |
| `awareness` from `perception.js` | not a bus event | would need a new event | Adds coupling; the player being *noticed* is not the same as having *identified* the species. |
| aggro state polling | none | — | Would need per-frame work; rejected. |

**Choose `machineHit`.** It is already emitted on the single path that unambiguously means "the player engaged this machine", it is event-driven (zero per-frame cost), and it is already consumed by four other modules (audio, VFX library, damage FX, HUD kill banner) so adding one more subscriber is idiomatic for this codebase. It also naturally satisfies "fighting one reveals its name" and generalizes to melee (spear) without a second trigger.

One precision concern: a *deflected* hit (`bulwark` front armor returns `false` from `machine.hit()`) does **not** emit `machineHit` — `projectiles.js resolveHit` returns early. So deflecting arrows would not reveal the bulwark until a real hit lands. That is a defensible, even desirable, reading (you learned what it is when you actually hurt it), and the alternative — revealing on any projectile contact — is not worth a new event from the projectile path.

### Implementation shape

`src/systems/bestiary.js`:

- Add a `onHit(p)` handler subscribing to `machineHit`, calling `markSeen(p.machine.type)` with the same `NAMES` guard `markSeen` already applies (unknown types are ignored).
- `markSeen` already early-returns when `e.seen` is true, which is the idempotence guarantee the announcement requirement needs. No new state required.
- `markKilled` already sets `e.seen = true`; leave it.
- Keep the `machineScanned` subscription: the Vantage is a peaceful, never-aggro machine, so it will essentially never be hit and would otherwise be *unreachable* without it. The scan path is load-bearing for exactly one species.

This resolves to a ~10-line change plus tests. No changes to `ai.js`, `focus.js`, `projectiles.js`, or `spear.js` — the signal already exists and already carries the machine.

### Persisted shape

Unchanged. `G.bestiary[type] = { seen, killed }` is already what `save.js` serializes and restores (`for (const type in data.bestiary) ... G.bestiary[type] = { seen: !!e.seen, killed: !!e.killed }`). No migration, no version bump.

## Control flow after the change

```text
arrow or spear -> weapon path confirms the hit
  -> machine.hit() resolves damage and returns true
  -> the weapon path, not hit() itself, emits machineHit
       projectiles.js resolveHit
       spear.js applySwingHits
  -> bus.emit('machineHit', { machine, point, damage, weak, partName })
       -> bestiary.onHit  -> markSeen(m.type)      [NEW]
       -> audio, vfx, damage FX                     (existing)

focus scan (Vantage only)
  -> bus.emit('machineScanned', { machine })        [unchanged]
       -> bestiary.onScanned -> markSeen(m.type)    -> notify once + bestiaryUnlock
       -> grantScanReward (map reveal + 2 SP)       [unchanged]
       -> quests/xp scan paths                     [unchanged]

kill
  -> bus.emit('machineDied', { machine })
       -> bestiary.onDied -> markKilled(m.type)     -> seen = true, killed = true, lore revealed
```

Note the ordering property this preserves: `markSeen` is guarded by `if (e.seen) return`, so a machine that is hit and then killed produces exactly one reveal and one completion announcement.

## Failure handling

- `machineHit` payloads with no `machine` field, or a machine with an unlisted `type`, are ignored by the existing `NAMES[type]` guard — no crash, no entry created.
- A `machineHit` emitted during machine disposal (the bus is synchronous and `machineDied` runs inside `killMachine` before `m.dispose()`) is safe: the handler only reads `machine.type`, a string.
- Boot-order: `createBestiary()` is called in `main.js` before the frame loop starts, and machines are populated in `populateWorld()` before `createBestiary()`. Since `markSeen` creates entries on demand via `ensureEntry`, an early hit cannot hit a missing entry.

## Alternatives considered

- **Emit a dedicated `machineEngaged` event from `projectiles.js`/`spear.js`.** Rejected: `machineHit` already carries the machine and means precisely this. A second event would duplicate the channel and force every future consumer to pick between them.
- **Reveal on aggro (`machineAlert`) as well.** Rejected: reveals species the player may not have visually identified (an ambush from off-screen), which cheapens discovery. Combat damage is the honest signal.
- **Reveal on proximity / any machine within vision range.** Rejected: requires a per-frame scan (the tier's own anti-pattern — the module header praises its "few compares" design) and would reveal species merely standing near the player.
- **Loosen the `machineScanned` filter to all machines.** Rejected: that event grants the map reveal and skill points; widening it would hand out a Vantage-only reward for scanning any skitter. This is a correctness regression, not a simplification.

## Rollout / compatibility

Additive subscriber; no signature, persistence, or settings changes. `G.bestiary` shape and save version unchanged, so existing saves load identically — a partially-discovered bestiary (e.g. a Vantage revealed) continues to work. No migration.

## Testing strategy

- Unit (`src/systems/bestiary.js`; the bus is a module singleton, so use the established `vi.resetModules()` + dynamic-import pattern from `tests/unit/events.test.js` and unsubscribe in `afterEach`):
  - `machineHit` with a machine of a known type sets `seen` and not `killed`;
  - a second and third `machineHit` for the same type do not re-emit `bestiaryUnlock` or `notify` (count bus emissions on the `bus.on('bestiaryUnlock')` channel and on a `notify` subscription);
  - `machineDied` sets both flags and emits `bestiaryUnlock { kind: 'killed' }` exactly once for repeat kills;
  - reveal-then-kill produces exactly one `kind: 'seen'` and one `kind: 'killed'` transition;
  - `machineScanned` still reveals (Vantage path preserved), and reveals without killing;
  - an unknown type is ignored (no entry created, no throw);
  - `machineHit` with no `machine` is ignored;
  - `speciesLore` returns the line only when `killed`, and `speciesName` falls back to the raw key.
- Save round-trip (extend the save suite from `harden-core-verification`, or assert here): a revealed-only entry serializes and restores as `{seen: true, killed: false}`; a malformed bestiary record from a hand-edited save restores to safe booleans (already implemented in `save.js`, now covered).
- E2E: `machine.hit()` does not emit `machineHit`. `combat-smoke.spec.js` uses `hit()` to prove damage and death, which is not a discovery signal. A non-lethal `hit()` alone must leave `seen === false`. The E2E must emit `machineHit` after a non-lethal resolved hit, or drive the projectile/spear path that emits it, and only then assert `seen === true` and `killed === false`. A lethal `hit()` marks seen through `machineDied` and does not prove the new trigger.
- Non-regression: the existing Vantage scan → map reveal path (covered by manual/contract behavior and, if present, an existing E2E assertion) must still pass.

## Risks

- **Revealing too eagerly** would make the bestiary a list of everything you have touched, reducing its value. Mitigated by keying on actual damage, not proximity. If playtesting shows it reveals too much, the tuning knob is a per-species "requires N hits" counter — deliberately not built now, because the documented promise is binary ("fighting one reveals its name").
- **Notification spam** on first engagement of many species in one fight. Bounded by the `markSeen` early-return and the existing toast cap in `hud.js` (5 max).
