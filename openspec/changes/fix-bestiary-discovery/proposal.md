## Why

The bestiary's two states are "seen" and "killed", but "seen" is currently unreachable for eight of the nine species. It is driven solely by the `machineScanned` event, and **both** emitters of that event hard-filter to Vantage (`ai.js` and `focus.js` both skip any machine whose type is not `vantage`, because the event carries the map-reveal reward). Kills set both flags, so the only ways a species ever becomes "seen" are: kill it, or be the single Vantage. A machine the player has fought repeatedly, wounded, and fled from stays "???" forever — contradicting the documented promise that "scanning or fighting one reveals its name".

## What Changes

- **Make combat a discovery trigger.** A machine the player engages becomes "seen": at minimum when it takes damage, and consistently with how scanning feels, from close-range awareness (entering combat awareness / being aggro on the player).
- **Keep the existing Vantage scan path working.** Scanning still reveals, and the map-reveal reward is unchanged.
- **Keep "killed" strictly stronger than "seen".** Lore stays gated behind a confirmed kill; discovery never reveals lore.
- **Avoid noisy/duplicate notifications.** Discovery must announce itself once per species, and must not fire for machines the player never actually engaged.
- **Add regression coverage** that engaging a machine reveals it, that killing still completes the entry, and that the reward paths (map reveal, scan XP, contracts) are unaffected.
- No change to the save format (the bestiary object shape is unchanged), settings, or combat balance.

## Capabilities

### New Capabilities
- `bestiary-progression`: The observable contract of species discovery and completion — that engaging a machine reveals its entry, that a confirmed kill completes it and reveals its lore, that each transition is announced at most once, and that discovery does not grant the rewards reserved for scanning.

### Modified Capabilities
<!-- None: first specification of this behavior; openspec/specs/ is currently empty. -->

## Impact

- Affected code: `src/systems/bestiary.js` (new discovery trigger, unchanged data shape), `src/machines/ai.js` (emitting or exposing the engagement signal), `src/combat/projectiles.js` / `src/player/spear.js` (damage path already emits `machineHit`), `src/systems/save.js` (bestiary round-trip is unchanged; add coverage), `tests/unit/`, and `README.md` (no change needed — the README already describes the intended behavior; this change makes the code match it).
- Player-visible: species entries unlock through normal play instead of requiring a kill or a Vantage scan.
- No balance, persistence-shape, or performance change of note (one additional bus subscriber with an early idempotence check).
