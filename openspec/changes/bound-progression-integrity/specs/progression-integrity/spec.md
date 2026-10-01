## Purpose

Defines that level progression is robust against restored or corrupted data: a single experience grant completes in bounded time and emits a bounded number of events, inconsistent progression state loaded from a save is repaired rather than deferred to the next grant, and legitimate grants that cross several thresholds still award every threshold crossed.

## ADDED Requirements

### Requirement: A single experience grant completes in bounded work

Applying an experience grant SHALL terminate within a bounded amount of work regardless of the accumulated experience present, and SHALL NOT emit an unbounded number of level-up notifications or events.

#### Scenario: Corrupted progression cannot stall a grant
- **WHEN** progression state holds an accumulated experience value far above the current level threshold
- **THEN** applying a grant completes within a bounded number of level-up steps
- **AND** the number of level-up notifications emitted is bounded

#### Scenario: A normal grant is unaffected
- **WHEN** accumulated experience is below the current level threshold
- **THEN** the grant behaves as before, with no additional work and no truncation

### Requirement: Restored progression state is made consistent on load

When progression state is loaded from a save, the loaded values SHALL be validated against the level curve. An inconsistent pair of accumulated experience and level threshold SHALL be repaired to a consistent state at load time, not left for the next grant to resolve.

#### Scenario: Excessive accumulated experience is clamped on load
- **WHEN** a save reports an accumulated experience value at or above the level threshold for the reported level
- **THEN** the restored progression is left in a state where accumulated experience is below the level threshold

#### Scenario: A consistent save is preserved exactly
- **WHEN** a save reports accumulated experience below the level threshold for its level
- **THEN** the restored progression matches the saved values exactly

#### Scenario: Non-finite values are rejected
- **WHEN** a save reports a non-finite or negative level, accumulated experience, or threshold
- **THEN** the restored progression falls back to safe defaults rather than adopting the invalid value

#### Scenario: The threshold is still derived, never trusted
- **WHEN** any save is loaded
- **THEN** the level threshold is derived from the level curve rather than taken from the save

### Requirement: Legitimate multi-level grants award every threshold

A grant that legitimately crosses more than one level threshold SHALL award a skill point and a level-up event for every threshold crossed, and SHALL be subject only to the same generous bound applied to all grants.

#### Scenario: A large legitimate grant levels up multiple times
- **WHEN** a single grant raises accumulated experience past several level thresholds
- **THEN** each crossed threshold produces one level increment and one skill point
- **AND** the remaining accumulated experience is correct

#### Scenario: A grant exactly at a threshold levels up
- **WHEN** a grant brings accumulated experience exactly to the level threshold
- **THEN** one level-up is awarded and the remaining accumulated experience is zero

#### Scenario: Normal gameplay progression is unchanged
- **WHEN** progression advances through ordinary play
- **THEN** the level curve, the number of thresholds crossed, and the resulting state are identical to the current behavior

## REMOVED Requirements

<!-- None. -->
