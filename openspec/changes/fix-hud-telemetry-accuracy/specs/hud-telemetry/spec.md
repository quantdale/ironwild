## Purpose

Defines the contract of the in-game instrumentation and HUD threat display: that on-screen threat indicators cover every machine the world can contain, and that reported frame-time statistics, percentiles, and entity counts are honest observations rather than internal clamp values or fixed pool sizes.

## ADDED Requirements

### Requirement: Threat indicators cover every machine the world can contain

The HUD's directional threat indicators SHALL be able to display one indicator per aggro machine for any machine population the world can actually reach, and SHALL NOT silently drop indicators because a pool was sized from a different constant than the one that caps the population.

#### Scenario: Every aggro machine gets an indicator
- **WHEN** the world contains the maximum number of machines and more than that number are aggro
- **THEN** each aggro machine has a visible directional indicator

#### Scenario: Indicators beyond the pool size are not silently dropped
- **WHEN** the number of aggro machines exceeds the number of allocated indicator elements
- **THEN** additional indicators are allocated rather than the machines being skipped

#### Scenario: Indicator count follows the real population cap
- **WHEN** the population cap used by machine spawning is compared against the allocated indicator count
- **THEN** the allocated count is at least the cap

#### Scenario: Empty and idle slots are hidden
- **WHEN** a machine is no longer aggro or has been disposed
- **THEN** its indicator is hidden rather than left visible at a stale position

### Requirement: Frame-time percentiles reflect real samples

Frame-time percentiles reported by the telemetry system SHALL be computed from the actual observed frame times. A sample MUST NOT be silently truncated to a ceiling before it enters the distribution, because that makes the reported tail equal to the ceiling and hides the regressions the metric exists to detect.

#### Scenario: A long frame is reported at its true length
- **WHEN** a frame takes longer than any clamp value currently applied before sampling
- **THEN** the reported percentiles reflect that frame's true duration rather than a capped value

#### Scenario: Tab-resume gaps are excluded, not truncated
- **WHEN** the tab is hidden and later resumed, producing one very large inter-frame delta
- **THEN** that gap sample is excluded from the distribution entirely
- **AND** it is not represented as a frame of some capped duration

#### Scenario: Exclusion is reported
- **WHEN** one or more samples have been excluded from the distribution
- **THEN** the report indicates how many were excluded

#### Scenario: Distribution is not saturated
- **WHEN** a capture is run under a condition that produces genuine multi-second stalls
- **THEN** the reported p99 differs from any internal ceiling value

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
