## Purpose

Defines species discovery and completion in the bestiary: that engaging a machine reveals its entry, that a confirmed kill completes the entry and reveals its lore, that each transition is announced at most once, and that discovery does not grant the rewards reserved for scanning.

## ADDED Requirements

### Requirement: Engaging a machine reveals its entry

When the player engages a machine in combat, that machine's species SHALL become revealed in the bestiary, without requiring the machine to be killed.

#### Scenario: Damaging a machine reveals its species
- **WHEN** the player lands a resolved hit on a machine
- **THEN** that machine's species entry becomes revealed
- **AND** the entry does not report the species as defeated

#### Scenario: Revealing through combat works for every species
- **WHEN** the player engages any machine species
- **THEN** that species entry becomes revealed, including species with no focus-scanning behavior

#### Scenario: A machine the player never engages stays unknown
- **WHEN** the player has not engaged a species
- **THEN** its entry remains undiscovered

### Requirement: A confirmed kill completes the entry and reveals lore

Killing a machine SHALL complete its bestiary entry, and the species lore SHALL be revealed only for completed entries.

#### Scenario: Killing completes the entry
- **WHEN** a machine is killed
- **THEN** its species entry is marked as both revealed and defeated
- **AND** the entry's lore is revealed

#### Scenario: Lore stays hidden for revealed-only entries
- **WHEN** a species is revealed but not yet defeated
- **THEN** its entry shows no lore

#### Scenario: Defeating implies revealing
- **WHEN** a species is marked as defeated
- **THEN** it is also marked as revealed

### Requirement: Each transition is announced once

A species transition SHALL be announced to the player at most once per transition kind, and repeated engagement with the same species SHALL NOT produce repeated announcements.

#### Scenario: Repeated engagement announces once
- **WHEN** the player damages the same species many times
- **THEN** the reveal announcement appears only on the first such transition

#### Scenario: Completion announces once
- **WHEN** the player kills multiple machines of the same species
- **THEN** the completion announcement appears only on the first kill

#### Scenario: Reveal and completion are tracked independently
- **WHEN** a species is revealed and later killed
- **THEN** both the reveal and the completion transitions are each announced exactly once

### Requirement: Discovery does not grant scanning rewards

Revealing a species through combat SHALL NOT grant the rewards that are reserved for focus-scanning, and SHALL NOT change any other progression or reward behavior.

#### Scenario: Combat reveal does not reveal the map
- **WHEN** a species is revealed by damaging a machine
- **THEN** the map is not revealed and no skill points are granted for that interaction

#### Scenario: Scanning rewards are unchanged
- **WHEN** a machine is focus-scanned
- **THEN** the scanning rewards behave exactly as before this change

#### Scenario: Discovery does not alter progression rewards
- **WHEN** a species is revealed through combat
- **THEN** experience, contract progress, and loot are unchanged relative to the same interaction before discovery existed

### Requirement: Discovery persists with the run

Revealed and completed states SHALL be persisted with the run and restored when the run is continued.

#### Scenario: Reveals survive a save and continue
- **WHEN** a species is revealed, the run is saved, and the run is continued
- **THEN** the species remains revealed

#### Scenario: Restored states are well-formed
- **WHEN** bestiary state is restored from a save
- **THEN** each restored species has both a revealed and a defeated state, defaulting safely when absent
