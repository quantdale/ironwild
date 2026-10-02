## Purpose

Defines what a player must be able to see and read on a machine in combat: every unbroken weak point is visibly marked, its **state changes are observable** when it breaks, attacks are telegraphed, damage is visibly acknowledged, and death is performed — with no difference in readability between procedural machines and machines using authored (asset) rigs.

## ADDED Requirements

### Requirement: Every unbroken weak point on a live machine is visible

A machine that is alive and has at least one unbroken weak point SHALL render at least one visible mesh at each such weak point, for every machine regardless of whether it uses a procedural body or an authored rig. A weak point that is invisible, fully transparent, or culled MUST NOT remain an active gameplay hit target.

#### Scenario: Authored machine exposes visible weak points
- **WHEN** a machine has upgraded to an authored rig and still has at least one unbroken weak point
- **THEN** each of its unbroken weak points has at least one visible mesh in the rendered scene
- **AND** that weak point is a live hit target

#### Scenario: Procedural machines are unchanged
- **WHEN** a machine uses a procedural body
- **THEN** its weak points are visible and hittable exactly as before

### Requirement: Weak-point state changes are visible

A weak point's gameplay state SHALL be reflected in what the player can see. In particular, when a weak point transitions to broken, the rendered representation of that weak point on the machine the player is looking at SHALL visibly change. A broken weak point that is still presented as an intact, unbroken, or fully-glowing part is a defect.

#### Scenario: Breaking an authored weak point is visible
- **WHEN** a weak point on an authored machine is broken
- **THEN** the machine's rendered weak point visibly changes
- **AND** the change is observable on the rig that is actually being drawn, not only on hidden geometry

#### Scenario: Breaking a procedural weak point remains visible
- **WHEN** a weak point on a procedural machine is broken
- **THEN** the existing char/darken feedback is preserved

#### Scenario: The visible weak point and the gameplay weak point are the same thing
- **WHEN** a weak point is broken or damaged
- **THEN** the visible representation that changes is the one the player is shooting at, and the hit volume and the rendered state cannot silently diverge

#### Scenario: Unbroken weak points remain distinguishable
- **WHEN** a machine has both broken and unbroken weak points
- **THEN** the player can tell them apart from what is rendered

### Requirement: Authored weak-point nodes drive gameplay hit detection

When an authored rig supplies its own weak-point marker nodes, the gameplay weak-point contract (hit sphere position, radius, damage multiplier, hit points, broken state) SHALL be driven by the authored rig's markers rather than by geometry that is not being rendered.

#### Scenario: Hit position follows the authored rig
- **WHEN** a weak point is defined by an authored marker node and the machine moves or animates
- **THEN** a projectile test against that weak point uses the authored marker's current world position

#### Scenario: Missing authored markers degrade safely
- **WHEN** an authored rig supplies no usable weak-point markers
- **THEN** the machine falls back to a presentation mode in which its weak points are visible, hittable, and visibly change when broken

### Requirement: Attacks are telegraphed before damage lands

A machine that is about to attack SHALL present a readable anticipation before its damaging window, and the presentation SHALL exist for both procedural and authored machines. When an authored rig has no matching attack animation, the machine SHALL fall back to a presentation in which the anticipation is still readable.

#### Scenario: Telegraph precedes the hit for authored machines
- **WHEN** an authored machine begins an attack
- **THEN** a visible anticipation is presented for the anticipation window before the damaging window
- **AND** the damaging window occurs within the attack's declared timing

#### Scenario: An available authored attack clip is actually played
- **WHEN** an authored machine has an attack animation available and begins that attack
- **THEN** that animation reaches a running state for the attack's window

#### Scenario: Missing attack animation still telegraphs
- **WHEN** an authored machine begins an attack for which no matching animation exists
- **THEN** a visible anticipation is still presented on the rig that is being drawn
- **AND** that anticipation does not depend on procedural meshes that have been hidden
- **AND** the declared anticipation/active/recovery timings still bound the attack

#### Scenario: An authored color deviation is recorded rather than guessed
- **WHEN** an authored weak-point marker does not use the procedural cyan weak-point color
- **THEN** the deviation is recorded with the asset definition
- **AND** a non-color cue can still identify the weak point

#### Scenario: Procedural telegraphs are unaffected
- **WHEN** a procedural machine begins an attack
- **THEN** its existing telegraph and damage timing behavior is unchanged

### Requirement: Damage and death are visually acknowledged

A machine that takes damage SHALL present a visible hit reaction, and a machine that dies SHALL present a visible death performance, for both presentation modes.

#### Scenario: Hit reaction is visible
- **WHEN** a machine takes resolved damage
- **THEN** a visible reaction is presented within the reaction window

#### Scenario: Death performance is visible
- **WHEN** a machine dies
- **THEN** a visible death performance is presented before the carcass fades

#### Scenario: Authored death completes and the record is released
- **WHEN** an authored machine's death performance finishes
- **THEN** the machine's animation resources are released exactly once and the machine record leaves the roster

### Requirement: Animation presentation failure never removes gameplay feedback

Any failure in the animation/asset presentation layer (missing asset, decode error, missing clip, convention violation) SHALL leave the machine in a state where its gameplay-critical visuals remain presented. Presentation failure MUST NOT remove weak points, telegraphs or hit reactions.

#### Scenario: Asset load failure keeps the machine readable
- **WHEN** an authored asset for a machine fails to load or decode
- **THEN** the machine remains fully presented, hittable, and responsive to weak-point state changes

#### Scenario: Convention violation keeps the machine readable
- **WHEN** an authored rig is missing required conventions
- **THEN** the machine is not left partially presented, and in particular is not left in a state where weak-point state changes are invisible

## REMOVED Requirements

<!-- None. -->
