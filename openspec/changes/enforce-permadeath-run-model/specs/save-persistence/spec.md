## Purpose

Defines when a run's progress is persisted, when it may be restored, that the end of a run permanently prevents that run from being restored, and that the persistence surface degrades safely when browser storage is unavailable.

## ADDED Requirements

### Requirement: A live run is saved and restorable

While a run is in progress and the player is alive, the run's progress SHALL be saved automatically and SHALL be restorable through the title screen's continue action.

#### Scenario: Progress is saved during play
- **WHEN** a run is in progress, the player is alive, and a save trigger occurs (manual quicksave, the automatic interval elapsing, the game being paused, or a panel being opened)
- **THEN** the run's current state is written to the save slot

#### Scenario: A saved run can be continued
- **WHEN** the player chooses to continue a saved run
- **THEN** the run resumes from the saved state, including position, health, inventory, skills, progression, and contracts

#### Scenario: Continue is offered only when a restorable run exists
- **WHEN** no restorable run exists
- **THEN** the continue action is not offered

### Requirement: The end of a run permanently prevents restoring that run

When a run ends in death, that run SHALL NOT be restorable through any supported flow, and the player SHALL begin a new run the next time play starts.

#### Scenario: A dead run cannot be continued
- **WHEN** a run has ended in death and the player returns to the start flow
- **THEN** the finished run is not offered for continuation
- **AND** starting play begins a new run

#### Scenario: Death cannot be undone by reloading
- **WHEN** the player dies and reloads the page or restarts from the death screen
- **THEN** the state prior to death is not restored
- **AND** the player is not returned to a full-health pre-death state

#### Scenario: Saving is not possible after death
- **WHEN** a run has ended
- **THEN** no further save of that run is written

#### Scenario: Repeated deaths do not resurrect earlier progress
- **WHEN** a player dies, starts a new run, and dies again
- **THEN** neither run is restorable

### Requirement: A new run starts from a clean state

A newly started run SHALL begin with the game's default starting state rather than any state carried over from a previous run.

#### Scenario: Inventory does not carry across runs
- **WHEN** a player starts a new run after a previous run ended
- **THEN** the new run begins with the default inventory

#### Scenario: Progression does not carry across runs
- **WHEN** a player starts a new run after a previous run ended
- **THEN** the new run begins with default progression and contract state

#### Scenario: A new run can be saved and continued
- **WHEN** a new run is in progress and is saved
- **THEN** that new run is restorable through the normal continue flow

### Requirement: Persistence degrades safely when storage is unavailable

If browser storage is unavailable or a write fails, the game SHALL continue to run, SHALL NOT lose the current session's state, and SHALL report the failure without throwing into gameplay.

#### Scenario: Unavailable storage does not break boot
- **WHEN** storage cannot be read at boot
- **THEN** the game starts normally with default state

#### Scenario: Failed write does not break play
- **WHEN** a save cannot be written
- **THEN** play continues and the failure is reported once without interrupting the frame loop

#### Scenario: Unreadable save does not start a broken run
- **WHEN** the save slot contains unreadable or invalid data
- **THEN** the continue flow does not start a run from that data

#### Scenario: Ending a run without storage does not throw
- **WHEN** a run ends in death and storage is unavailable
- **THEN** the death flow completes normally
