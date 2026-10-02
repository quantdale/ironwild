# world-streaming Specification

## Purpose
Defines how the browser game's spatial cell streaming manager decides which registered world-content batches (instanced vegetation, rock, ground-cover meshes grouped into 60-unit grid cells) are visible to the renderer, guarantees the decision is reachable on the very first streaming pass for every cell, and keeps the exposed active/registered counters truthful.

## Requirements

### Requirement: Out-of-band cells reach the hidden state on the first streaming pass

The streaming manager SHALL be able to drive a registered cell from its initial registered-and-visible state directly to a hidden state during the first streaming evaluation, without requiring the cell to have first passed through the "active" state. A cell outside the entry radius on that first evaluation SHALL end the pass hidden. The wider exit radius governs only cells that have already been shown.

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

### Requirement: Visibility follows entry and exit hysteresis

The manager SHALL keep distinct entry and exit radii. On a cell's first evaluation against a valid anchor, records SHALL be shown only when the anchor is within the entry radius and SHALL be hidden otherwise, including when the cell has never been marked active. After that evaluation, a shown cell SHALL remain shown until the anchor passes the wider exit radius, and a hidden cell SHALL remain hidden until the anchor enters the entry radius. Hiding SHALL NOT require a prior active transition.

#### Scenario: Counter agrees with visibility
- **WHEN** the streaming manager reports its counters
- **THEN** the reported active count equals the number of registered, non-retired records whose visible flag is true
- **AND** the reported registered count equals the number of live (non-retired) records
- **AND** before the first evaluation, pre-streaming parity leaves registered content visible and the active count agrees with that shown count

#### Scenario: No permanently visible cell beyond the exit radius
- **WHEN** a full pass runs with a single valid anchor
- **THEN** every cell outside the exit radius has its records hidden

#### Scenario: The hysteresis band does not collapse to one radius
- **WHEN** a cell has already been evaluated and the anchor then sits between the entry radius and the wider exit radius
- **THEN** a cell that was visible stays visible
- **AND** a cell that was hidden stays hidden

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
