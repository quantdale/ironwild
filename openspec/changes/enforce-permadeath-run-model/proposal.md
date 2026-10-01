## Why

The README promises "Death is permanent per run — restart and try again", but nothing enforces it. The save slot is snapshotted on a 90-second autosave, on every pause, **and on every panel open** (`bus.on('ui', action === 'open')`), so the state on disk is almost always a recent full-health run. The death screen's only action reloads the page, `clearSave()` is reachable *only* from the NEW RUN button, and `main.js` stops the save tick at `G.gameOver` — so the slot survives death untouched. The player is then returned to a title screen offering CONTINUE, which restores a pre-death snapshot at full health. The advertised roguelike loop is silently optional.

## What Changes

- **A death ends the run's save.** When the player dies, the current run's save slot is invalidated so that continuing into the finished run is not possible. The run's progress is not restorable; the next start begins a new run.
- **Make the post-death start flow explicit and honest.** After death, the player restarts into a new run. If a title screen is shown, it must not offer a continue path into a completed run.
- **Keep the existing manual/autosave behavior during a live run** unchanged: quicksave, the 90-second autosave, pause snapshots, and panel-open snapshots all continue to work exactly as today while the player is alive.
- **Keep a corrupt/unrelated slot safe.** If the save slot cannot be written or read (storage unavailable), the death flow must still complete without throwing and without leaving the player stuck.
- **Add regression coverage** that a death invalidates the slot, that a live run's saves are unaffected, and that the new-run flow still saves and restores normally.

## Capabilities

### New Capabilities
- `save-persistence`: The observable contract of run persistence — when a run's progress is saved, when it is restorable, that a run's end permanently prevents restoring that run, and that the persistence surface degrades safely when storage is unavailable.

### Modified Capabilities
<!-- None: first specification of this behavior; openspec/specs/ is currently empty. -->

## Impact

- Affected code: `src/systems/save.js` (death handling / slot invalidation, `hasSave`, `loadGame`), `src/ui/menus.js` (death flow, `onPlayerDied`, `deathHandled`, start-screen `saveAvailable`/`continueGame`/`newRun`), `src/main.js` (frame-loop ordering of the death signal relative to the save tick), `tests/unit/` and `tests/e2e/save-continue.spec.js`.
- Persisted shape: an optional run-state marker inside the existing `ironwild-save` object (additive; older saves without the marker keep loading unchanged). No migration is required because the change only ever *adds* a field and reads it defensively.
- Player-visible: the Continue button disappears after a death; a new run starts clean. This is a deliberate reduction in player convenience and must be reflected in the README.
