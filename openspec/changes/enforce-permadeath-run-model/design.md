# Design — Enforce the permadeath run model (save-persistence)

## Current-state analysis

### The documented contract

`README.md:34`:

> "You are a hunter in a valley reclaimed by wilderness and patrolled by animal-like machines. Hunt them, break their glowing weak points, harvest resources, craft, and grow your skills. **Death is permanent per run — restart and try again.**"

### The implemented behavior (traced end to end)

**Where saves come from** (`src/systems/save.js`):

| Trigger | Line | Condition |
| --- | --- | --- |
| Manual quicksave | `:199` | `Input.wasActionPressed('quicksave')`, gated `!G.gameOver` |
| Autosave interval | `:204` | `autosaveT >= AUTOSAVE_INTERVAL` (90 s), gated `!G.gameOver` |
| Pause rising edge | `:193` | `!wasPaused && G.started && !G.gameOver` |
| **Any panel open** | `:178` | `bus.on('ui', a === 'open' \|\| a === 'open-panel')` — inventory, skills, **and the settings modal** all emit `'open'` |
| Death | `:61` | `saveGame()` early-returns `false` when `G.gameOver` |

`src/main.js:835` also stops the per-frame save tick at death: `if (saveStep && G.started && !G.gameOver) saveStep(rawDt);`.

**What death does** (`src/ui/menus.js`):

```js
function onPlayerDied() {
  if (deathHandled) return;
  deathHandled = true;
  G.gameOver = true;
  if (activePanel && activePanel !== "death") { els[activePanel].classList.add("hidden"); }
  activePanel = "death";
  G.paused = true;
  Input.unlockPointer();
  setTimeout(() => els.death.classList.add("show"), 650);
}
```

The death screen's only control:

```js
els.restartBtn.addEventListener("click", () => location.reload());   // :60
```

**What the reload lands on** (`src/ui/menus.js buildDom`):

```js
const canContinue = saveAvailable();     // save.hasSave() -> localStorage 'ironwild-save'
... ${canContinue ? '<button id="iw-continue">CONTINUE</button>' : ""}
```

`clearSave()` is called from exactly one place — the NEW RUN button (`:188`). It is **never** called from the death flow.

### The resulting exploit path

1. Player opens the inventory (or the 90 s autosave fires) → slot snapshots a live, healthy run.
2. Player dies. `G.gameOver = true`; no further writes; the slot is untouched.
3. Player clicks RESTART → `location.reload()`.
4. Boot: `saveAvailable()` is `true` → the title screen renders CONTINUE.
5. Player clicks CONTINUE → `loadGame()` restores position, hp, stamina, inventory, skills, xp, bestiary, quests — from the snapshot taken in step 1.

The player is returned to a full-health pre-death state. The "permadeath" loop is not enforced; it is a one-click undo. Because the panel-open snapshot is the most common save trigger, the window between the last save and death is typically seconds, not minutes.

### Why this has survived

Nothing is *broken* — every individual piece behaves as written. The gap is that the death flow never invalidates the run it ended, and the save system has no concept of a run's lifecycle beyond "is the player alive right now". `save.js`'s header describes autosave/pause/panel triggers but says nothing about termination, and `docs/BALANCE.md` (the only doc that tracks run-economy behavior) does not cover the run model either.

## Intended approach

Give the save slot an explicit **run lifecycle**. Three states matter, and the death transition must be the only thing that moves a run out of `restorable`:

```text
(no slot)  --start-->  RUNNING  --save-->  RUNNING(restorable)
                              --death-->  ENDED(not restorable)  --start-->  RUNNING(new)
```

### Design choice: mark vs. clear

Two options for ending a run:

- **(A) Clear the slot** (`localStorage.removeItem`). Simple, no schema change. But it destroys the record of the finished run entirely, and it makes the failure mode "the save vanished" indistinguishable from "the save was never written" — bad for diagnosing storage problems.
- **(B) Mark the slot as ended** (add a field, stop offering continue). Additive to the existing object; the data is retained but not restorable; the distinction between "no run" and "finished run" is observable.

**Choose (B).** Rationale: the save object is already versioned and strictly additive (`loadGame()` accepts v2..v3 and ignores unknown fields), so adding a field costs nothing in migration terms; it keeps the failure diagnosable; and it leaves a clean seam for a future "run history / bestiary of past runs" feature without a second storage key.

Field shape (inside the existing `ironwild-save` object):

```
run: { ended: true, endedAt: <G.elapsed or timestamp> }
```

`loadGame()` rejects any save whose `run.ended` is truthy. `hasSave()` continues to report slot presence (used for the Continue button), so a **separate** predicate is needed for "restorable" — that distinction is the actual fix, and conflating the two is what produced the bug.

### Where the transition fires

`systems/save.js` already subscribes to bus events (`initSave()` wires `bus.on('ui', ...)`), so the natural owner of the transition is the save module itself, on `bus.on('playerDied')`. `menus.js` `onPlayerDied` then remains responsible for the *presentation* (hide panels, unlock pointer, show the death screen) and does not need to know about persistence — preserving the existing "menus owns UI, save owns persistence" separation that the ARCHITECTURE contract states ("no direct G surgery outside save.js").

Ordering: `playerDied` is emitted synchronously from `player.takeDamage()` during the sim step, while `saveStep` runs later in the same frame under `!G.gameOver`. Because `saveGame()` already early-returns on `G.gameOver`, and the bus handler runs during the sim (before the save tick), the mark is written before any later save could occur. The mark write must be a *direct* write of the terminated run's state, not via `saveGame()` (which refuses to write post-death) — so the handler composes the payload itself and sets the marker, then writes.

### Start-screen presentation

- `buildDom()` currently calls `saveAvailable()` once at build time. Replace with a restorability predicate (`save.hasRestorableRun()`), so a finished run renders the title screen without CONTINUE.
- The NEW RUN button is currently only rendered when `canContinue` is true. With (B), a finished run means `hasSave()` is true but `hasRestorableRun()` is false — the player needs a way to *start over deliberately*. Keep NEW RUN rendered whenever a slot exists (finished or not), and have it clear the slot and reload, which is exactly its current behavior.

### What is explicitly out of scope

- Mid-run "abandon run" or "retire run" flows.
- Any change to the 90 s interval, the quicksave binding, the pause snapshot, or the panel-open snapshot. Those are correct while alive.
- Multiple save slots. The directive explicitly warns against solving a narrow problem with a broad redesign; one slot plus a lifecycle marker is the minimum that fixes the defect.
- Death causes other than the player dying.

## Control flow after the change

```text
player.takeDamage() -> hp <= 0 -> bus.emit('playerDied')
   |
   +-> menus.onPlayerDied        : G.gameOver = true, panels hidden, death screen (presentation only)
   +-> save.onPlayerDied         : write { ...serialize(), run: { ended: true } } to the slot
   |
frame end: main.js saveStep is gated on !G.gameOver -> no further writes

RESTART -> location.reload()
   -> boot: hasSave() === true, hasRestorableRun() === false
   -> title screen: no CONTINUE, NEW RUN offered
   -> NEW RUN -> clearSave() + reload -> fresh boot, defaults
```

## Data-flow / state changes

- `ironwild-save` gains an optional `run: { ended: boolean, endedAt: number }`. Current `SAVE_VERSION` is 4. A v2, v3, or v4 save with no `run` field, or with `run.ended` not strictly `true`, stays restorable. `markRunEnded()` must write the existing `serialize()` payload plus the marker, so expedition state is not dropped from the ended slot.
- `save.js` gains `hasRestorableRun()` and an internal `markRunEnded()`; `loadGame()` gains a rejection branch.
- `menus.js buildDom()` switches its gate from `saveAvailable()` to the restorable predicate; NEW RUN's render condition changes from "slot exists" to "slot exists" (unchanged) but its *meaning* now also covers finished runs.
- No other persisted field changes. No settings change. No `G.*` field is added.

## Failure handling

- If the mark write fails (storage unavailable), the game must still complete the death flow. The player then reloads into a title screen whose slot is the pre-death snapshot — the bug persists in that degraded environment, which is the correct trade (an unreadable-storage environment cannot be given a stronger guarantee) and must be documented rather than papered over.
- If the slot contains corrupt JSON at death time, the mark write must not throw; `clearSave()` is the fallback in that case.
- Reading `run.ended` must be defensive: a hand-edited or truncated value must not make the game crash or silently treat a live run as ended. Only a strict `=== true` counts as ended.

## Alternatives considered

- **Clear the slot on death (A).** Rejected: loses diagnosability and conflates "no run" with "finished run". Kept as the fallback when the mark cannot be written.
- **Only hide the Continue button, leave the slot intact.** Rejected: cosmetic. A player who clears localStorage, or a future flow that calls `loadGame()` directly, would still restore the dead run. The refusal must live in the data, not only in the UI.
- **Suppress the panel-open autosave to shrink the exploit window.** Rejected: does not remove the exploit (the 90 s autosave and pause snapshot remain), and removes a useful save trigger. Fix the model, not the window.
- **Multiple save slots ("snapshot per run").** Rejected as scope creep; one slot plus a lifecycle marker is sufficient and preserves the existing storage contract.

## Rollout / compatibility

- Backward compatible: a pre-existing save without `run` remains restorable, so nobody loses an in-progress run on upgrade.
- Player-visible loss of convenience is the point of the change, and the README must be updated to describe the actual flow.
- `tests/e2e/save-continue.spec.js` covers continue-after-save and will need a sibling spec for die-then-restart; the existing spec must keep passing unchanged.

## Testing strategy

- Unit (`systems/save.js`, existing node-env + `vi.resetModules()` pattern with `../core/input.js` mocked):
  - a save written mid-run round-trips and `loadGame()` accepts it;
  - a save carrying `run.ended === true` is rejected by `loadGame()` and reported as non-restorable;
  - a save **without** a `run` field is accepted (backward compatibility);
  - a malformed `run` value (string, number, partial object) is treated as **not** ended, so a corrupt field cannot brick a live run;
  - `markRunEnded()` writes exactly one slot and does not throw when storage throws;
  - `hasSave()` still reports slot presence after a run ends, while the restorable predicate reports false (the distinction the fix depends on);
  - autosave/quicksave/pause/panel triggers are all still no-ops once the run is ended.
- E2E:
  - save → die → reload → assert the title screen has no CONTINUE and has NEW RUN;
  - save → die → NEW RUN → assert a fresh default state (inventory/hp/level reset);
  - save → reload → CONTINUE → assert the existing behavior is unchanged (guards against over-correction).
- Unit for the presentation gate: `menus.js buildDom()` renders the continue button only when a restorable run exists (may need a DOM-capable harness; if that is disproportionate, cover it in the E2E assertions above and note the omission).

## Risks

- **Over-correction**: accidentally making saves non-restorable during a live run. Mitigated by scoping the refusal strictly to `run.ended === true` and by the three E2E cases above (live save still continues; new run still saves).
- **Players relying on the current escape hatch** (using death as a free rewind). This is a real behavior change; it is the intent of the documented design, and the README must say so plainly.
- **`loadGame()` being called from a path that bypasses the title screen** (e.g. a future "continue from death" shortcut) would reintroduce the bug; the refusal is in the data layer, so such a path is still safe.
