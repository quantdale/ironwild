## Purpose

Defines the contract of the in-game instrumentation and HUD threat display: that on-screen threat indicators cover every machine the world can contain, and that reported frame-time statistics, percentiles, and entity counts are honest observations rather than internal clamp values or fixed pool sizes.

## ADDED Requirements

### Requirement: Threat indicators cover every machine the world can contain

The HUD's directional threat indicators SHALL be able to display one indicator per aggro machine for any machine population the world can actually reach, and SHALL NOT silently drop indicators because a pool was sized from a different constant than the one that caps the population.

#### Scenario: Every simultaneously aggro machine gets an indicator
- **WHEN** the world contains its maximum population and every one of those machines is aggro
- **THEN** each aggro machine has a visible directional indicator

#### Scenario: Indicators beyond the initial pool are not silently dropped
- **WHEN** the number of currently aggro machines exceeds the number of indicator elements allocated at startup
- **THEN** additional indicators are allocated rather than the extra aggro machines being skipped
- **AND** a calm machine does not consume an indicator that an aggro machine needs

#### Scenario: Indicator count follows the real population cap
- **WHEN** the population cap used by machine spawning is compared against the allocated indicator count
- **THEN** the allocated count is at least the cap

#### Scenario: Empty and idle slots are hidden
- **WHEN** a machine is no longer aggro or has been disposed
- **THEN** its indicator is hidden rather than left visible at a stale position

### Requirement: Frame-time percentiles reflect real samples

Frame-time percentiles reported by the telemetry system SHALL be computed from the actual observed frame times. A sample MUST NOT be silently truncated to a ceiling before it enters the distribution, because that makes the reported tail equal to the ceiling and hides the regressions the metric exists to detect.

#### Scenario: A rendered hitch is reported at its true length
- **WHEN** a rendered frame takes 900 ms
- **THEN** the reported percentiles reflect 900 ms rather than a 250 ms ceiling

#### Scenario: True gaps are excluded, not truncated
- **WHEN** an inter-frame delta is non-finite, non-positive, or longer than the 2000 ms gap ceiling
- **THEN** that sample is excluded from the distribution
- **AND** it is not stored as 250 ms, as 2000 ms, or as its raw gap duration

#### Scenario: Exclusion is reported
- **WHEN** one or more samples have been excluded from the distribution
- **THEN** the report indicates how many were excluded

#### Scenario: A hitch does not saturate the tail at the old clamp
- **WHEN** a capture contains a 900 ms rendered frame and no sample above the gap ceiling
- **THEN** the reported p99 is not 250

### Requirement: Reported entity counts are live counts

Entity counts reported by the telemetry system SHALL reflect the entities currently active in the world, not the size of a fixed-capacity pool or the number of slots allocated for them.

#### Scenario: Arrow count is arrows in flight
- **WHEN** no arrows have been fired
- **THEN** the reported projectile count is zero, not the size of the projectile pool

#### Scenario: Counts change with the world
- **WHEN** arrows are fired and expire
- **THEN** the reported projectile count rises and falls with the live count

#### Scenario: Pool capacity is reported separately
- **WHEN** the report is consumed
- **THEN** pool capacity is available as its own field if it is useful, and is not conflated with the live count

### Requirement: The dev HUD presents the same truth as the report

The developer overlay SHALL present the same values as the machine-readable report, using wording that distinguishes measurements from derived or capped values.

#### Scenario: HUD matches the report
- **WHEN** the developer overlay is shown and the report is read
- **THEN** the frame-time, draw-call, and entity figures shown match the report values

#### Scenario: Excluded samples are visible on the HUD
- **WHEN** samples have been excluded from the distribution
- **THEN** the overlay indicates the exclusions

### Requirement: Telemetry degrades safely when a source is unavailable

The telemetry system SHALL continue to produce a report when any individual data source (renderer statistics, heap statistics, cell statistics, asset statistics, dynamic-resolution scale) is unavailable or throws, and SHALL represent that source as unavailable rather than as a zero measurement.

#### Scenario: Missing renderer statistics
- **WHEN** renderer statistics are unavailable
- **THEN** the report marks renderer statistics as unavailable rather than reporting zero draw calls

#### Scenario: Broken publisher does not break the report
- **WHEN** an external statistics publisher throws
- **THEN** the report is still produced with that source shown as unavailable
