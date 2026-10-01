## Purpose

Defines the contract that every user-facing accessibility preference offered in the settings panel is actually applied to the running game, and specifically that requesting reduced flashing suppresses or bounds the game's flashing and pulsing screen effects while preserving the non-flashing parts of the same visual layers.

## ADDED Requirements

### Requirement: No offered accessibility preference is inert

Every accessibility preference the settings panel offers SHALL change observable behavior in the running game when it is changed. A preference that is persisted and republished but never consumed is a defect, not a no-op.

#### Scenario: Each offered preference is consumed
- **WHEN** the set of accessibility preferences offered in the settings panel is compared against the set of preferences that change observable game behavior
- **THEN** every offered preference is consumed by at least one applied effect

#### Scenario: Toggling a preference changes the game immediately
- **WHEN** an accessibility preference is changed in the settings panel
- **THEN** its effect is observable in the running game without a reload

### Requirement: Reduced flashing suppresses pulsing HUD effects

When reduced flashing is enabled, the HUD's flashing or pulsing screen effects SHALL be suppressed or replaced with a static equivalent, and SHALL remain suppressed for as long as the preference is enabled.

#### Scenario: Low-health vignette does not pulse
- **WHEN** reduced flashing is enabled and the player's health falls below the low-health threshold
- **THEN** the low-health overlay is shown in a static, non-animated form and does not pulse

#### Scenario: Film grain does not animate
- **WHEN** reduced flashing is enabled
- **THEN** the grain overlay is static (its texture may remain) and does not translate frame to frame

#### Scenario: Progression pulse does not animate
- **WHEN** reduced flashing is enabled and a progression gain occurs
- **THEN** the progression bar's gain feedback is presented without an animated flash

#### Scenario: Static layers are preserved
- **WHEN** reduced flashing is enabled
- **THEN** the non-animated parts of the affected layers (the cinematic vignette and grain texture) remain visible

#### Scenario: Disabling restores the animated behavior
- **WHEN** reduced flashing is disabled again
- **THEN** the affected effects animate as they did before

### Requirement: Reduced flashing bounds full-screen weather flashes

When reduced flashing is enabled, the full-screen lightning flash SHALL be bounded to a level that does not strobe, while remaining visible enough to convey the strike.

#### Scenario: Lightning flash is reduced, not removed
- **WHEN** reduced flashing is enabled and a lightning strike occurs
- **THEN** the full-screen flash is presented at a bounded, non-strobing intensity and the strike is still perceptible

#### Scenario: Full-intensity flash when the preference is off
- **WHEN** reduced flashing is disabled and a lightning strike occurs
- **THEN** the flash behaves exactly as it does today

### Requirement: Accessibility preferences persist and apply on boot

Accessibility preferences SHALL be persisted with the other settings and re-applied during boot, so a preference chosen in a previous session is in effect before gameplay begins.

#### Scenario: Preference survives a reload
- **WHEN** reduced flashing is enabled, the page is reloaded, and the game boots
- **THEN** reduced flashing is in effect from boot, before any flashing effect can occur

#### Scenario: Boot applies preferences in the presence of a saved value
- **WHEN** a saved settings object contains accessibility preferences
- **THEN** those preferences are applied during boot without a settings-panel interaction

#### Scenario: Default when nothing is saved
- **WHEN** no settings have been saved
- **THEN** the shipped defaults apply and flashing effects behave as they do today
