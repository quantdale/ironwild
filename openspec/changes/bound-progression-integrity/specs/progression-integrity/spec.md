## Purpose

Defines that level progression is robust against restored or corrupted data: a single experience grant completes in bounded time and emits a bounded number of events, inconsistent progression state loaded from a save is repaired rather than deferred to the next grant, and legitimate grants that cross several thresholds still award every threshold crossed.

## ADDED Requirements

### Requirement: A single experience grant completes in bounded work

Applying an experience grant SHALL terminate within a bounded amount of work regardless of the accumulated experience present, and SHALL NOT emit an unbounded number of level-up notifications or events.

#### Scenario: Inconsistent progression cannot stall a grant
- **WHEN** progression state holds accumulated experience at or above the current level threshold
- **THEN** applying a grant completes within a bounded number of level-up steps
- **AND** the number of level-up notifications emitted is bounded

#### Scenario: Normal gameplay is not truncated
- **WHEN** progression state is consistent and a grant is applied
- **THEN** the grant is not truncated by the bound

#### Scenario: Level advancement stays within the supported range
- **WHEN** progression reaches the maximum supported level
- **THEN** the level does not advance beyond that range during ordinary play

#### Scenario: A normal grant is unaffected
- **WHEN** accumulated experience is below the current level threshold
- **THEN** the grant behaves as before, with no additional work and no truncation

### Requirement: Progression invariants hold at every entry point

Progression state SHALL satisfy the relationship `cur < next` after being established at boot, not only when restored from a save. A boot sequence, a partial restore, or any future path that establishes progression state SHALL NOT be able to leave accumulated experience at or above the level threshold.

#### Scenario: Boot establishes the relationship
- **WHEN** progression state is initialized at boot with individually valid but mutually inconsistent values
- **THEN** the initialized state has accumulated experience below the level threshold

#### Scenario: Restored progression is made consistent on load
- **WHEN** progression state is loaded from a save
- **THEN** the restored progression has accumulated experience below the level threshold
- **AND** the level threshold is derived from the level curve rather than taken from the save
- **AND** the level is within the supported range

#### Scenario: Non-finite values are rejected
- **WHEN** a save reports a non-finite or negative level, accumulated experience, or threshold
- **THEN** the restored progression falls back to safe defaults rather than adopting the invalid value

#### Scenario: A consistent save is preserved exactly
- **WHEN** a save reports accumulated experience below the level threshold for its level
- **THEN** the restored progression matches the saved values exactly

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
