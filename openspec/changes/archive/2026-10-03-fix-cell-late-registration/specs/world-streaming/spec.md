## ADDED Requirements

### Requirement: Late registration adopts the evaluated cell's visibility

When a record is registered into a cell the manager has already evaluated (`streamed === true`), the record SHALL adopt that cell's current visibility state instead of defaulting to shown. A late registration into a cell outside the active band SHALL be hidden immediately, so no batch registered anywhere SHALL remain visible while its cell is outside the exit radius. A late registration into a cell that has never been evaluated SHALL keep pre-streaming parity (visible) until that cell's first evaluation.

#### Scenario: Late registration into a hidden cell is hidden immediately
- **WHEN** a batch is registered into a cell that a prior pass already evaluated as out of band
- **THEN** the new record's visibility is hidden immediately
- **AND** the reported active count does not increase
- **AND** the record joins its cell's band state on later passes (shown when the anchor enters the entry radius)

#### Scenario: Late registration into a never-evaluated cell keeps parity
- **WHEN** a batch is registered into a cell the manager has never evaluated
- **THEN** the record stays visible until the first pass evaluates that cell
- **AND** if that first pass finds the cell out of band, the record is hidden then
