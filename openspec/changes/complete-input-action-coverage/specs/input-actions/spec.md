## Purpose

Defines the input action layer's observable contract: which gameplay and panel intents exist, that every gameplay intent is reachable from keyboard, mouse, and a standard-mapping gamepad, that panel intents participate in rebinding and persistence, and that input edges are transient and cannot persist into later frames.

## ADDED Requirements

### Requirement: Every gameplay action is reachable from a gamepad

Every gameplay action that is reachable from keyboard and mouse SHALL also be reachable from a standard-mapping gamepad while a pad is connected. No gameplay action SHALL be keyboard-only.

#### Scenario: All gameplay actions have a pad source
- **WHEN** the defined movement, combat, consumable, quicksave, and map actions are compared with their gamepad sources
- **THEN** each of those actions has a gamepad source
- **AND** inventory, skills, and bestiary may remain keyboard-rebindable panel actions without a new pad binding
- **AND** pause remains reachable from the pad Start button

#### Scenario: Unmapped actions before the change are now mapped
- **WHEN** a player holds the gamepad input bound to healing, quicksaving, spear melee, arrow-type switching, or the frontier map during active play
- **THEN** the corresponding action is reported as held for that frame

#### Scenario: D-pad gameplay bindings yield to an open interface
- **WHEN** a panel, the pause menu, or the settings modal is open
- **THEN** D-pad gameplay actions are not reported as held
- **AND** D-pad UI navigation still reports its own edges

#### Scenario: Gamepad parity does not change keyboard defaults
- **WHEN** no gamepad is connected
- **THEN** keyboard and mouse bindings behave exactly as before

### Requirement: Panel intents participate in the action layer

Opening and closing the inventory, skill, and bestiary panels SHALL be driven by named actions in the action layer, with default bindings, so they can be rebound and persisted like gameplay actions.

#### Scenario: Panel opens via its action
- **WHEN** the default binding for the inventory action is pressed
- **THEN** the inventory panel toggles open

#### Scenario: Panel bindings are rebindable
- **WHEN** a panel action is rebound through the controls UI
- **THEN** the new binding opens that panel and the previous binding no longer does

#### Scenario: Panel bindings persist
- **WHEN** panel actions are rebound and the page is reloaded
- **THEN** the rebound panel bindings are restored

#### Scenario: Existing saves remain valid
- **WHEN** a binding map saved before panel actions existed is loaded
- **THEN** the panel actions receive their default bindings and all other saved bindings are preserved unchanged

### Requirement: Input edges cannot persist beyond their frame

An input edge (a rising transition such as a key press or a gamepad button down) SHALL be observable for at most the frame in which it occurred. Disconnecting input hardware SHALL clear any pending or stale edge state so that it cannot be re-reported in later frames.

#### Scenario: Key and mouse edges clear each frame
- **WHEN** an action is pressed
- **THEN** it is reported as a rising edge on that frame only and is not reported as a new rising edge on subsequent frames

#### Scenario: Disconnecting the gamepad clears stale edges
- **WHEN** a gamepad button went down and the pad is then disconnected
- **THEN** no edge from that button is reported on any subsequent frame while no pad is connected

#### Scenario: Reconnecting the gamepad does not replay old edges
- **WHEN** a gamepad is reconnected after being disconnected
- **THEN** no button is reported as newly pressed unless it is actually down at that moment and was up before

#### Scenario: No phantom menu toggling from a removed pad
- **WHEN** a gamepad that had its start/pause button pressed is disconnected
- **THEN** the pause menu is not toggled repeatedly on later frames

### Requirement: Rebinding is safe and bounded

Setting a binding SHALL accept a valid input code, SHALL reject an unknown action, and SHALL treat unavailable persistent storage as a non-fatal condition that leaves the binding active for the current session.

#### Scenario: Invalid code is rejected
- **WHEN** a binding is set to an empty or non-string code
- **THEN** the previous binding remains in effect

#### Scenario: Unknown action is rejected
- **WHEN** a binding is set for an action that does not exist
- **THEN** no binding is changed

#### Scenario: Storage failure keeps the session binding
- **WHEN** persistent storage is unavailable and a binding is changed
- **THEN** the new binding is in effect for the current session and the game continues normally
