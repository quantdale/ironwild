# Design — Complete input action coverage (input-actions)

## Current-state analysis

### The action layer's shape

`src/core/input.js` is built around `DEFAULT_BINDINGS` (action → array of `KeyboardEvent.code` or `MouseN` pseudo-codes) merged with persisted overrides from localStorage `ironwild-bindings`, plus `PAD_ACTIONS` (action → predicate over the gamepad snapshot) for controller support. `beginFrame()` polls gamepads, folds in event-time edges (`_edgePending`), and refreshes `_actionDown`; `endFrame()` clears `pressedSet`, `wheelDelta`, `_edgePending`, and rolls `_actionPrev`. Consumers read `isAction(name)` (level) and `wasActionPressed(name)` (rising edge).

### Gap 1 — gamepad parity (measured)

Comparing the two tables mechanically:

```text
DEFAULT_BINDINGS (20): forward,back,left,right,jump,dodge,sprint,crouch,interact,
                       focus,heal,quicksave,melee,arrowToggle,aim,fire,
                       uinavUp,uinavDown,uinavConfirm,uinavCancel
PAD_ACTIONS      (16): forward,back,left,right,jump,dodge,interact,crouch,
                       sprint,focus,aim,fire,uinavUp,uinavDown,uinavConfirm,uinavCancel

NO GAMEPAD SOURCE: heal,quicksave,melee,arrowToggle
```

`heal` (`KeyH`), `quicksave` (`KeyP`), `melee` (`KeyF`, the spear) and `arrowToggle` (`KeyX`, standard↔fire arrows) are keyboard-only. `arrowToggle` also has a mouse-wheel fallback in `player/bow.js updateBow` (a 100-unit wheel notch swaps type with a cooldown), so a pad user can reach it indirectly — but not via a button, and the other three have no path at all. The pad's remaining buttons are: D-pad (12–15, used for UI nav), face A/B/X/Y (jump/dodge/interact/crouch), LB/RB (focus/sprint), LT/RT (fire/aim), START (pause pulse).

There are exactly four unclaimed face/shoulder inputs that fit naturally and are not already load-bearing:

| Action | Proposed standard-mapping binding | Rationale |
| --- | --- | --- |
| `heal` | D-pad **Up** (12) | Single-use, low frequency; keeps the face buttons as movement/combat verbs. UP is currently only read for `uinavUp`, which is only consumed while a UI nav context is live — no conflict with gameplay. |
| `melee` | **X** is taken (interact). Use **Right Trigger click / RT** is fire. Use **LB double-modifier**? Too clever. Use **B**? B is dodge. | See below. |
| `arrowToggle` | — | See below. |
| `quicksave` | — | See below. |

The four standard-mapping buttons still free after the existing 10 mappings are: D-pad Up/Down/Left/Right (only Up/Down are used for UI nav, and only in menu contexts), and the START/Back/Select pair (9/8).

Resolution chosen (keeps face buttons semantic and avoids mode-dependent conflicts):

- `heal` → **D-pad Up** (12). Low-frequency consumable; conflicts only with UI nav Up, and UI nav is not polled while gameplay is active (`menus.js` only reads uinav* through the settings rebind UI; verify no runtime consumer reads `uinavUp` during play).
- `melee` → **Left Bumper held with Right Stick click** is over-engineered. Instead: **Right Stick press (button 11, "R3")** — a dedicated, unused standard-mapping input, semantically "secondary action", never used for locomotion or aim (right stick is analog look, its *click* is unused).
- `arrowToggle` → **Select/Back (button 8)**, unused, semantically "cycle loadout".
- `quicksave` → **D-pad Left (14)**, low frequency, unused in gameplay (D-pad Left/Right are not bound to any gameplay action today).

This requires no changes to existing mappings and no chord/modifier logic. If a later audit finds `uinavUp` is read during gameplay, `heal` moves to button 8 and `arrowToggle` to D-pad Up.

### Gap 2 — phantom Escape from a disconnected pad

`src/input/gamepad.js pollGamepads()`:

```js
if (!pad) {
  state.connected = false;
  prevHeld = [];
  return;                       // <-- state.edges / startEdge / nav NOT cleared
}
```

`state.edges`, `state.startEdge`, and `state.nav` are only assigned in the full-sample path below that early return. Meanwhile `core/input.js beginFrame()` does:

```js
pollGamepads();
if (getGamepadState().startEdge) this.pressedSet.add("Escape");
```

with no `connected` guard. If START went down on the last poll that found a pad and the next poll finds none, `startEdge` stays `true` **forever** (every subsequent disconnected poll returns early without clearing it), and every frame injects `pressedSet.add("Escape")`. `ui/menus.js updateMenus()` consumes `Input.pressed("Escape")` every frame, so the pause menu would toggle open/close continuously and the game would be unplayable until reload. This is a hard defect, not a cosmetic one; reproducing it needs a physical pad, so it is "confirmed by code path, requires hardware validation".

Fix in two places (defence in depth): clear the edge maps in the `!pad` branch, **and** guard the START pulse in `beginFrame()` on `state.connected`.

### Gap 3 — panel keys bypass the action layer

`ui/menus.js updateMenus()` polls raw codes:

```js
if (Input.pressed("KeyI")) { ... }
if (Input.pressed("Tab"))   { ... }
if (Input.pressed("KeyB"))  { ... }
if (Input.pressed("Escape")){ ... }
```

`DEFAULT_BINDINGS` has no entries for these, and `ui/settings.js CONTROL_ACTIONS` (the rebind rows) has none either, so there is no way to rebind them. A player who has bound `fire` to `KeyE` (a legal rebind) collides with the world-interact action and cannot move the panel keys out of the way. The same Escape pulse that gamepad START injects is also read as "pause", which is correct, but it means the raw path is load-bearing for two input sources.

Move these to actions `inventory` (`KeyI`), `skills` (`Tab`), `bestiary` (`KeyB`), `pause` (`Escape`) and read them via `Input.wasActionPressed(...)`. Note `pressed()` (raw) vs `wasActionPressed()` (action layer): the action layer already provides the same one-frame semantics via `_edgePending` + `_actionPrev`, including sub-frame taps, which the raw path also had. Behaviour is equivalent.

Escape is special: it is also the browser's own pointer-lock exit key, and `menus.js onLockChange` already handles the lock-exit → pause path. Keep the `Escape` action for the "Escape reaches the page" case (headless, lockBroken fallback) exactly as today; do not remove or re-interpret it.

### Persistence compatibility

`Input._loadBindings()` iterates saved entries and keeps only those whose action exists in `DEFAULT_BINDINGS` and whose value is a non-empty string. Adding new actions therefore requires **no** migration: old maps simply gain defaults for the new actions, and all existing overrides survive. `resetBindings()`/`resetBinding()` need no change.

## Control flow after the change

```text
keydown / mousedown  -> Input.keys / mouseButtons + _markActionEdges(code)  (unchanged)
gamepad poll         -> pollGamepads()  [now clears edges when pad absent]
                       -> _edgePending folded into _actionDown, _actionPrev compared
mousedown (START)    -> startEdge -> pressedSet.add("Escape")   [now guarded by connected]
beginFrame            -> _actionDown refreshed for ALL actions (incl. inventory/skills/bestiary/pause)
systems              -> Input.isAction(x) / Input.wasActionPressed(x)
menus.js             -> Input.wasActionPressed('inventory'|'skills'|'bestiary'|'pause')
endFrame              -> pressedSet/wheelDelta/_edgePending cleared, _actionPrev rolled
```

## Failure handling

- A new pad mapping whose predicate throws must not break `beginFrame`; keep the same defensive style as the existing `PAD_ACTIONS` predicates (pure property reads on the snapshot).
- Rebinding a panel action to a code already used by a gameplay action is allowed today (no conflict detection) and must remain allowed — adding conflict detection is out of scope, but the collision case is exactly why the panel keys needed to be rebindable in the first place.

## Alternatives considered

- **Chorded bindings** (e.g. hold LB + X for melee). Rejected: more state, more failure modes, and no need — four free standard inputs exist.
- **Expose face-button remapping per action** (a full pad remap UI). Rejected as disproportionate; keyboard/mouse rebinding plus sensible fixed pad defaults covers the gap.
- **Fix the phantom Escape only in `beginFrame`**. Rejected: leaving stale `state.edges`/`nav` is a latent trap for every future consumer. Fix both ends.

## Rollout / compatibility

No migration, no default keyboard change, no save-format change. The pad mappings are additive. Existing `ironwild-bindings` payloads load unchanged and gain defaults for the four new panel actions.

## Testing strategy

- Unit (`tests/unit/input-actions.test.js`, existing pattern — capture the `input.js` listeners and invoke them directly):
  - parity: every key in `DEFAULT_BINDINGS` (minus the `uinav*` UI-only group, which is exercised separately) has a `PAD_ACTIONS` entry; assert the four named actions are present;
  - gamepad snapshot: build a synthetic `navigator.getGamepads()` returning a standard-mapping pad, press the new buttons, assert the actions report held and then produce a single rising edge;
  - disconnect: START down, then `getGamepads()` returns `[]` → assert `startEdge === false`, `edges` empty, and no `Escape` in `pressedSet` on subsequent `beginFrame()` calls;
  - reconnect: no phantom edge for a button that is not down;
  - rebind: `setBinding('inventory', 'KeyJ')` persists, `getBindings()` reflects it, an unknown action is rejected, an empty code is rejected;
  - old saved map (JSON without the new keys) loads with defaults for the new actions and preserves existing overrides.
- E2E: extend `tests/e2e/input-rebind.spec.js` with a panel-rebind case (rebind `inventory`, reload, open the panel with the new key, assert the old key no longer opens it).

## Risks

- D-pad Up for `heal` could collide with UI nav if a runtime consumer reads `uinavUp` during play — mitigated by verifying that before implementation and by the fallback mapping noted above.
- Adding four entries to `DEFAULT_BINDINGS` grows the per-frame `_actionDown` refresh loop by four iterations. `beginFrame` already iterates every action each frame and `_effective()` is memoized, so this is negligible — but the E2E input specs should stay green to catch any regression in the frame-driven key polling.
