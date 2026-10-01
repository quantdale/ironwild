## Purpose

Defines how the browser game's spatial cell streaming manager decides which registered world-content batches (instanced vegetation, rock, ground-cover meshes grouped into 60-unit grid cells) are visible to the renderer, guarantees the decision is reachable on the very first streaming pass for every cell, and keeps the exposed active/registered counters truthful.

## ADDED Requirements

### Requirement: Out-of-band cells reach the hidden state on the first streaming pass

The streaming manager SHALL be able to drive a registered cell from its initial registered-and-visible state directly to a hidden state during the first streaming evaluation, without requiring the cell to have first passed through the "active" state. A cell whose bounding region lies outside the deactivation radius at the first evaluation MUST end that pass hidden, and its registered records' visibility flags MUST be set to hidden.

#### Scenario: Freshly registered far cell is hidden on first evaluation
- **WHEN** a content batch is registered into a cell that is far from the streaming anchor, and the streaming manager performs its first evaluation
- **THEN** that batch's visibility is set to hidden within that first evaluation
- **AND** the batch remains hidden on subsequent evaluations while it stays out of band

#### Scenario: Near cell stays visible on first evaluation
- **WHEN** a content batch is registered into a cell within the activation radius and the streaming manager performs its first evaluation
- **THEN** that batch remains visible

#### Scenario: Deactivation is reachable for never-activated cells
- **WHEN** a cell has never been in band and the anchor moves far enough that the cell is now outside the deactivation radius
- **THEN** the cell's registered records are set to hidden (the manager does not require a prior "active" transition to hide them)

### Requirement: Visibility and active-state are consistent invariants

For every registered, non-retired cell record, the record's visible flag SHALL be true if and only if its cell is currently within the activation band. The manager SHALL evaluate the deactivation branch for every cell on every pass, not only for cells already marked active, so no cell can remain visible while out of band.

#### Scenario: Counter agrees with visibility
- **WHEN** the streaming manager reports its counters after one or more evaluations
- **THEN** the reported active count equals the number of registered, non-retired records whose visible flag is true
- **AND** the reported registered count equals the number of live (non-retired) records

#### Scenario: No permanently visible out-of-band cell
- **WHEN** a full pass runs with a single anchor
- **THEN** every cell outside the deactivation radius has its records hidden

### Requirement: Adoption is gradual, not an all-hidden flash

Before the manager has produced its first streaming decision, registered content SHALL remain visible (pre-streaming parity), so the title screen and the first rendered frame never show a world with no vegetation. Once streaming begins, the manager SHALL NOT on any single pass hide content that is within the activation band.

#### Scenario: Pre-first-decision parity
- **WHEN** content is registered and the manager has not yet run an evaluation
- **THEN** that content is visible

#### Scenario: Band content never flashes hidden
- **WHEN** the anchor is inside the activation band for a cell
- **THEN** the cell's records remain visible across consecutive evaluations

#### Scenario: Hysteresis prevents boundary flicker
- **WHEN** the anchor distance oscillates near the deactivate threshold
- **THEN** the cell does not toggle visibility on each evaluation (a separate, wider exit threshold governs hiding than entry)

### Requirement: Non-resident gameplay state is unaffected by streaming

Streaming SHALL affect only the visibility of the decorative/visual batches registered with the manager. Gameplay state that must remain resident (pickups, spawn anchors, concealment patches, machine records) SHALL NOT be routed through, or removed by, cell activation state.

#### Scenario: Registered batches are visibility-only
- **WHEN** a cell is activated or deactivated
- **THEN** its registered groups remain in the scene graph (no add/remove or reparenting) and only their visibility changes

### Requirement: Reported stats are safe to read at any time

The manager SHALL expose a live counter snapshot (registered, active, retired) that callers can read at any moment without triggering a side effect, and the snapshot SHALL reflect the current visible/registered/retired tallies.

#### Scenario: Stats read with no anchor
- **WHEN** the counter snapshot is read before any streaming evaluation has occurred
- **THEN** it reports the live registered, active, and retired tallies consistent with the visibility invariant
