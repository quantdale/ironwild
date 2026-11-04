# Tasks — Complete input action coverage (input-actions)

## 0. Cross-change coordination (read before editing)

This change edits `src/ui/menus.js` (`updateMenus` panel polls) and `src/ui/settings.js` (`CONTROL_ACTIONS`). Sibling changes that also touch them:

- **`enforce-permadeath-run-model`** edits `menus.js buildDom()` (the Continue-button gate) in the same file. The functions differ, but both changes are in the same DOM-building module: **sequence the two, ideally as separate commits.**
- **`honor-accessibility-preferences`** edits `settings.js` (the REDUCE FLASHING label/description) and `src/ui/a11y.js`. Different section of `settings.js` from `CONTROL_ACTIONS`; low conflict, but sequence for safety.
- **`sync-project-documentation`** edits the `setPanelHtml` header comment in `menus.js`. Comment-only, but it is the same file — apply the doc change last.

`src/input/gamepad.js` is also touched by `retire-dead-scaffolding` (which deletes the unused `rumble()` helper). If that change lands first, the D-pad/button-index work here is unaffected; if it lands after, ensure it does not re-add `rumble`.

## 1. Gamepad parity for the five unmapped actions

- [ ] 1.1 In `src/input/gamepad.js`, add the missing `PAD_BUTTONS` entries `SELECT: 8` and `R3: 11`. D-pad indices 12–15 are already present. Do not assume Select or R3 already exist.
- [ ] 1.2 No current gameplay consumer reads `uinavUp`. Still suppress `heal`, `quicksave`, and `map` while a panel, the pause menu, or the settings modal is open. Do not suppress `melee` or `arrowToggle` with that rule.
- [ ] 1.3 In `src/core/input.js PAD_ACTIONS`, add `heal` → D-pad Up, `melee` → R3, `arrowToggle` → Select, `quicksave` → D-pad Left, and `map` → D-pad Right.
- [ ] 1.4 Confirm each new predicate is a pure read of the gamepad snapshot (`p.held[...]` / `p.nav[...]`) matching the existing predicate style, and that it is guarded by `p.connected` via the existing `_rawAction` path.
- [ ] 1.5 Re-run the parity check. After this change, `heal`, `quicksave`, `melee`, `arrowToggle`, and `map` must have `PAD_ACTIONS` entries. `uinav*` may remain edge-driven. `inventory`, `skills`, and `bestiary` are keyboard panel actions and are not required to gain pad bindings. `pause` stays reachable through the Start-to-Escape pulse rather than a new `PAD_ACTIONS` entry.

## 2. Clear stale gamepad edges on disconnect

- [ ] 2.1 In `src/input/gamepad.js pollGamepads()`, in the `!pad` early-return branch, also reset `state.edges = {}`, `state.startEdge = false`, and `state.nav` (`up`/`down`/`left`/`right` all `false`).
- [ ] 2.2 Consider also zeroing `state.held` and `state.values` in that branch so a disconnected pad cannot be read as holding buttons through any future consumer; verify this does not break the "pad reconnects" edge baseline (`prevHeld` is already cleared).
- [ ] 2.3 In `src/core/input.js beginFrame()`, guard the START-to-Escape pulse on the gamepad being connected: only inject `pressedSet.add("Escape")` when `getGamepadState().connected && getGamepadState().startEdge`.
- [ ] 2.4 Add a short comment at both sites explaining that a stale edge would otherwise inject Escape on every frame and rapidly toggle the pause menu, so a future refactor does not reintroduce it.
- [ ] 2.5 Do not change the `_lockAttempt` watchdog, the pointer-lock fallback classification, or the `onLockChange` contract.

## 3. Panel intents move into the action layer

- [ ] 3.1 In `src/core/input.js DEFAULT_BINDINGS`, add `inventory: ["KeyI"]`, `skills: ["Tab"]`, `bestiary: ["KeyB"]`, and `pause: ["Escape"]`.
- [ ] 3.2 Add matching `PAD_ACTIONS` entries where a sensible standard input exists for panel navigation (the `uinav*` group already covers confirm/cancel); do not invent pad bindings for panel toggles that the design did not specify — menu navigation on a pad is out of scope for this change.
- [ ] 3.3 In `src/ui/menus.js updateMenus()`, replace the raw `Input.pressed("KeyI" | "Tab" | "KeyB" | "Escape")` polls with `Input.wasActionPressed("inventory" | "skills" | "bestiary" | "pause")`, preserving the exact toggle/close/pause semantics and the ordering of the checks.
- [ ] 3.4 Preserve the settings-modal guard (`settings.isOpen()` early return) and the existing Escape reachability rules (the browser consumes Escape while pointer-locked; the action only fires when it actually reaches the page).
- [ ] 3.5 Verify no behavioral change for the existing `preventDefault` on `Tab` (the `window` keydown listener in `menus.js`) and `Space`/`Tab` in `core/input.js` still apply — a rebound `skills` action must not cause the browser to move focus.
- [ ] 3.6 In `src/ui/settings.js CONTROL_ACTIONS`, add rebind rows for `inventory`, `skills`, and `bestiary` so they appear in the CONTROLS section of the settings modal with their current labels.
- [ ] 3.7 Confirm `_loadBindings()` needs no migration: old saved maps simply gain defaults for the new actions. Add a test case asserting an old-format map loads with defaults for the new actions and preserves all existing overrides.

## 4. Unit coverage

- [ ] 4.1 Extend `tests/unit/input-actions.test.js` (existing pattern: `vi.resetModules()` + dynamic import, capture and invoke the registered listeners directly).
- [ ] 4.2 Parity test: assert `heal`, `quicksave`, `melee`, `arrowToggle`, and `map` have `PAD_ACTIONS` entries. Do not fail the test because `inventory`, `skills`, or `bestiary` lack pad entries.
- [ ] 4.3 Synthetic-pad test: stub `navigator.getGamepads()` with a connected standard-mapping pad, press the new buttons across polls, assert the action reports held and produces exactly one rising edge across the press, then releases.
- [ ] 4.4 Disconnect test: START down on a connected pad, then `getGamepads()` returns `[]`; assert `startEdge` is `false`, `edges` is empty, and repeated `beginFrame()` calls never add `Escape` to `pressedSet`.
- [ ] 4.5 Reconnect test: reconnect a pad with a button not down; assert no phantom rising edge is produced for that button.
- [ ] 4.6 Rebind tests: `setBinding('inventory', 'KeyJ')` persists and is reflected by `getBindings()`; an unknown action and an empty code are both rejected; a throwing `localStorage` leaves the session binding in effect without throwing.
- [ ] 4.7 Panel-action tests: default `KeyI`/`Tab`/`KeyB` produce a single rising edge per press through the action layer; after rebinding, the new code fires and the old does not.
- [ ] 4.8 Run the full unit suite and confirm no existing input assertion regressed.

## 5. E2E coverage

- [ ] 5.1 Extend `tests/e2e/input-rebind.spec.js` with a panel-rebind case: open settings, rebind `inventory` to an unused key, close, reload, assert the new key opens the inventory panel and the previous key no longer does.
- [ ] 5.2 Add a regression check that the pause flow still works via `Escape` in both the pointer-locked and free-cursor-fallback paths (extend the existing `pause-resume.spec.js` cycle rather than duplicating it).
- [ ] 5.3 Run the full Playwright suite; confirm the console stays clean (a pad-mock that leaks would surface here as an error/warning).

## 6. Verification

- [ ] 6.1 `npm run lint` clean.
- [ ] 6.2 `npm test` — existing suites plus the new input cases pass.
- [ ] 6.3 `npm run build` succeeds.
- [ ] 6.4 `npx playwright test` — full suite green.
- [ ] 6.5 Manual/hardware validation (cannot be automated here): with a physical gamepad, confirm the four new bindings fire the intended actions, and confirm that unplugging the pad mid-pause does not leave the pause menu toggling. Record the result in the PR description.

## 7. Documentation

- [ ] 7.1 Update the `README.md` controls table to note gamepad support for the four newly mapped actions.
- [ ] 7.2 Update the `src/core/input.js` header comment to state that every gameplay action has a keyboard, mouse, and standard-gamepad source, and that panel intents are actions too.
- [ ] 7.3 Update the `src/input/gamepad.js` header comment to document the edge-reset-on-disconnect invariant and why it exists.
