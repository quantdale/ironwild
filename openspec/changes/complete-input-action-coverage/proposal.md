## Why

The input layer has an action abstraction with rebinding and gamepad support, but it is only partially wired. On current `main`, `heal`, `quicksave`, `melee`, `arrowToggle`, and `map` have no `PAD_ACTIONS` entry. A gamepad-only player cannot use medicine, quicksave, the spear, switch arrow types, or open the frontier map. `map` is already an action; inventory, skills, and bestiary are still raw `KeyI` / `Tab` / `KeyB` polls. Separately, `input/gamepad.js` never resets its edge state when the pad disappears, which can leave a stuck `startEdge` that injects a phantom Escape into the frame loop.

## What Changes

- **Give the unmapped actions a gamepad source.** `heal`, `quicksave`, `melee`, `arrowToggle`, and the existing `map` action gain standard-mapping bindings. `PAD_BUTTONS` does not currently define Select (8) or R3 (11); add them. D-pad gameplay bindings must not fire while a panel, pause menu, or settings modal is open, because D-pad edges already feed UI navigation.
- **Reset gamepad edge state on disconnect.** When no pad is found, `startEdge` and the button/nav edge maps must be cleared, so a pad unplugged mid-poll cannot keep injecting an Escape keypress every frame.
- **Move panel intents into the action layer.** Inventory, skills, and bestiary toggles become named actions with default bindings and rebind rows, so panel keys participate in the same rebinding and persistence path as gameplay keys.
- **Add regression coverage** for full action parity, edge reset on disconnect, and the phantom-Escape scenario.
- No change to default keyboard/mouse behavior; existing players' bindings are unaffected.

## Capabilities

### New Capabilities
- `input-actions`: The observable contract of the input action layer — which gameplay and panel intents exist, that every gameplay intent is reachable from keyboard, mouse, and a standard-mapping gamepad, that rebinding covers panel intents, and that input edges are transient and cannot stick.

### Modified Capabilities
<!-- None: first specification of this behavior; openspec/specs/ is currently empty. -->

## Impact

- Affected code: `src/core/input.js` (`DEFAULT_BINDINGS`, `PAD_ACTIONS`, `beginFrame` START handling), `src/input/gamepad.js` (`pollGamepads` disconnect path, `PAD_BUTTONS`), `src/ui/menus.js` (`updateMenus` raw `Input.pressed` polls for KeyI/Tab/KeyB), `src/ui/settings.js` (`CONTROL_ACTIONS` rebind rows), `tests/unit/input-actions.test.js`, and `tests/e2e/input-rebind.spec.js`.
- `ironwild-bindings` (localStorage) gains new keys for panel actions; existing saved maps load unchanged and receive defaults for the new actions.
- Input handling is on the critical path; the change must not add per-frame work or dispatch cost.
