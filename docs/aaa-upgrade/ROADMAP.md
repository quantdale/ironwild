# IRONWILD — AAA Upgrade Execution Roadmap

This roadmap converts the master strategy into an implementation sequence. It is intentionally dependency-driven: expensive art/content production must not outrun the runtime, asset, testing, and performance pipelines that will support it.

## Program rules

1. Every phase must leave the game buildable and playable.
2. Performance is a merge criterion, not a cleanup task at the end.
3. New systems require regression coverage where deterministic testing is practical.
4. Content scaling waits for vertical-slice proof.
5. Preserve working gameplay while strangling out prototype architecture incrementally.
6. Prefer measurable acceptance criteria to subjective “looks better” claims.
7. Do not enlarge scope to compensate for lack of polish.

---

## Phase 0 — Baseline and production hardening

### Objective

Make IRONWILD safe to change rapidly.

### Workstreams

#### Repository hygiene

- untrack dependency/build/test artifacts that should not be source-controlled;
- establish `.gitignore` rules;
- keep only intentional documentation screenshots;
- normalize README/documentation encoding;
- document canonical local setup.

#### Quality gates

Add reliable commands for:

- clean install;
- lint/static analysis;
- unit tests;
- deterministic integration/simulation tests;
- production build;
- browser E2E;
- asset validation once assets are introduced.

#### Browser lifecycle fixes

- user-gesture-safe WebAudio initialization;
- idempotent audio graph startup;
- pointer-lock request state machine;
- clean pause/resume behavior;
- clear fallback or recovery UX;
- zero avoidable console errors/warnings.

#### Save hardening

- explicit schema version;
- migration pipeline;
- validation;
- malformed-save fallback;
- last-known-good backup;
- legacy fixture tests.

### Deliverables

- reliable CI;
- clean browser startup;
- deterministic test harness foundation;
- baseline performance captures.

### Exit criteria

- fresh clone can install/build/test without committed dependencies;
- no application errors on clean start;
- Start/Continue unlock audio correctly;
- pointer lock can acquire, release, fail, and recover cleanly;
- corrupted save cannot break application boot;
- baseline benchmark scenes are reproducible.

### Complexity

Medium

### Expected impact

Very high engineering leverage; low immediate screenshot impact.

---

## Phase 1 — Performance telemetry and benchmark harness

### Objective

Make every later graphics/content decision measurable.

### Implement

- developer performance HUD;
- frame-time sampling;
- p50/p95/p99 reporting;
- `renderer.info` capture;
- visible triangle and draw-call tracking;
- JS heap sampling where available;
- GPU timer-query instrumentation when supported;
- benchmark scenario loader/test hooks;
- deterministic time/weather/machine spawn controls;
- long-duration soak test.

### Benchmark scenarios

1. spawn meadow;
2. dense forest traverse;
3. lake/sunrise;
4. heavy storm;
5. six-machine combat;
6. focus scan;
7. Monarch encounter;
8. 20-minute traversal soak.

### Exit criteria

- benchmark runs produce repeatable reports;
- quality tiers can be compared quantitatively;
- performance regressions can be tied to commits/features.

### Complexity

Medium

### Expected impact

Indirect but critical.

---

## Phase 2 — Asset pipeline foundation

### Objective

Replace procedural final visuals with a scalable production-content pipeline.

### Runtime work

- GLTFLoader integration;
- KTX2 loader/transcoder integration;
- Meshopt support;
- optional Draco only where measured trade-offs are favorable;
- centralized AssetManager;
- explicit preload/prefetch/disposal lifecycle;
- asset manifests;
- loading/error states;
- dev-time validation.

### DCC/content conventions

Define before mass production:

- meter scale;
- axis/forward conventions;
- bone naming;
- sockets;
- weak-point tags;
- material naming;
- texture classes;
- LOD suffixes;
- animation clip naming;
- export presets;
- license/provenance metadata.

### Asset CI

Validate:

- glTF correctness;
- required clips;
- texture dimensions/formats;
- material count;
- triangle budgets;
- LOD monotonicity;
- required sockets;
- invalid transforms;
- unexpected giant files.

### Exit criteria

One production-quality test machine can be exported, validated, loaded, animated, LOD-switched, disposed, and performance-measured without manual runtime hacks.

### Complexity

High

### Expected impact

Critical foundation for all visual improvement.

---

## Phase 3 — Visual identity and rendering productionization

### Objective

Make final assets render with a deliberate, recognizable art direction.

### Workstreams

#### PBR and environment lighting

- PMREM/IBL;
- standardized metallic/roughness materials;
- normal/detail normal support;
- packed material maps where useful;
- emissive gameplay cues;
- material library for steel, ceramic, rubber/cables, rust, stone, soil, foliage, water, leather/cloth.

#### Shadows

Profile:

- current directional shadows;
- CSM on High;
- simpler Medium/Low strategies;
- shadow caster distance and LOD;
- vegetation shadow budgets.

#### Atmosphere

- depth-aware haze;
- improved sun/sky transitions;
- art-directable weather parameters;
- replace fragile radial light shafts with a reduced-resolution depth-aware approach if performance allows;
- reserve true volumetric cloud/storm work for later if needed.

#### Post processing

- externalize tuning values;
- LUT-based grade or equivalent art-directable pipeline;
- restrain chromatic aberration/grain;
- dynamic resolution;
- independent render scale from UI resolution;
- verify color management/tone mapping order.

### Exit criteria

- final test asset looks correct across day/night/weather;
- High/Medium/Low show meaningful quality/cost differences;
- no pass exceeds its assigned performance budget without explicit approval;
- visual identity is consistent enough to define a style bible.

### Complexity

High

### Expected impact

Very high.

---

## Phase 4 — Hunter production pass

### Objective

Replace the continuously visible player representation with production-quality character presentation and feel.

### Art

- final hunter model;
- optimized topology;
- PBR textures;
- equipment meshes;
- LODs;
- rig;
- weapon sockets.

### Animation

Required baseline clips:

- idle variants;
- walk/run/sprint;
- strafe/turn support as needed;
- crouch locomotion;
- jump/air/land;
- swim;
- bow draw/aim/release;
- spear attacks;
- dodge;
- hit reactions;
- death;
- interactions/heal.

### Runtime animation graph

- locomotion blend logic;
- action layer;
- dodge/hit/death overrides;
- additive aim offsets;
- foot IK;
- weapon-hand alignment;
- animation event system.

### Controller/camera polish

- tune acceleration and responsiveness;
- camera collision;
- aim transition;
- camera shoulder/offset rules;
- FOV and sprint behavior;
- camera shake/recoil accessibility controls;
- robust terrain transitions.

### Exit criteria

The hunter can traverse, aim, shoot, melee, dodge, crouch, swim, take damage, and die without visible prototype animation or major foot/weapon sliding in the vertical-slice biome.

### Complexity

Very high

### Expected impact

Critical.

---

## Phase 5 — Combat production pass

### Objective

Turn the existing mechanical loop into premium game feel.

### Bow

- final draw/release timing;
- aim offsets;
- arrow trails;
- projectile VFX;
- material-specific impacts;
- audio layering;
- weak-point response;
- optional aim assist;
- clear elemental/status readability.

### Spear

- animation-timed active windows;
- anticipation/recovery;
- stagger logic;
- hitstop/time-dilation experiments;
- impact response;
- explicit cancel rules.

### Machine component system

Unify:

- armor;
- weak points;
- destructible components;
- breakable weapons;
- component loot;
- status vulnerabilities;
- behavior changes caused by destroyed parts;
- damaged visual states.

### Exit criteria

- attack visuals match actual damage timing;
- one projectile cannot accidentally multi-hit;
- component breaks are deterministic and visible;
- combat remains readable during heavy VFX;
- tests cover damage/status/component invariants.

### Complexity

High

### Expected impact

Very high.

---

## Phase 6 — Machine production pipeline: Skitter, Ironmaw, Duskwing

### Objective

Prove that the production workflow works across materially different enemy archetypes.

### For every machine

Deliver:

- concept/silhouette pass;
- LOD0/1/2 at minimum;
- PBR texture set;
- standardized skeleton/socket scheme;
- locomotion clips;
- alert/combat clips;
- attacks;
- hit/stagger/death;
- weak-point/component visuals;
- VFX emitters;
- audio emitters;
- final hit proxies;
- data-driven ability metadata.

### Skitter proves

- agile quadruped locomotion;
- fast turns;
- leap attacks;
- readable small-machine weak points.

### Ironmaw proves

- heavy mass;
- armor layering;
- strong melee telegraphs;
- large hit reactions;
- destructible protection.

### Duskwing proves

- aerial navigation;
- flight animation;
- dive/ranged attacks;
- camera/aim readability against flying targets.

### Exit criteria

All three machines feel visually unrelated in role but clearly belong to the same world and production pipeline.

### Complexity

Very high

### Expected impact

Critical.

---

## Phase 7 — AI, perception, and navigation refactor

### Objective

Make machine behavior scalable, debuggable, and believable in authored environments.

### Architecture

Separate:

- perception;
- blackboard/memory;
- high-level state;
- archetype combat logic;
- ability selection;
- navigation;
- steering;
- animation/attack execution.

### Navigation

Introduce an authored-space navigation representation:

- navmesh or tiled navigation grid;
- local obstacle avoidance;
- stuck recovery;
- distinct ground/aerial/aquatic layers.

### Performance

- stagger perception ticks;
- spatial indexing;
- distance-based think rates;
- avoid every-machine-every-frame expensive LOS tests.

### Debug tools

Visualize:

- state;
- target;
- threat;
- vision/hearing;
- path;
- chosen ability;
- cooldowns;
- last transition and reason.

### Exit criteria

- representative machines navigate the final ruin/biome without recurring stuck states;
- deterministic AI scenarios exist for key transitions;
- archetype-specific identity survives the refactor;
- CPU budget remains within target during six-machine combat.

### Complexity

Very high

### Expected impact

High.

---

## Phase 8 — World art, vegetation, and streaming

### Objective

Convert the current procedural world into an authored-feeling place without sacrificing browser performance.

### Spatial structure

- divide world into cells;
- localize vegetation instance batches;
- restore usable frustum/distance culling;
- implement active rings;
- load/prefetch/dispose visual resources by proximity;
- keep lightweight gameplay/collision representation resident.

### Vegetation

Near:

- richer geometry;
- wind;
- selected shadows.

Mid:

- reduced geometry;
- cheaper wind;
- little/no dynamic shadowing.

Far:

- simplified cluster/impostor;
- aggressive culling.

### World art

Build:

- one polished biome kit;
- hero landmark;
- ruin kit;
- machine-site kit;
- terrain blend materials;
- decals;
- rocks/ground clutter;
- biome-specific foliage;
- environmental storytelling props.

### Exit criteria

- vertical slice feels authored from common gameplay camera distances;
- no obvious endless procedural repetition near the player;
- cells stream/cull without hitching;
- dense-forest benchmark remains within budget.

### Complexity

Very high

### Expected impact

Critical.

---

## Phase 9 — VFX and weather production pass

### Objective

Build a coherent effect language instead of isolated particles.

### Core effect library

- arrow impacts by material;
- weak-point hit/break;
- armor break;
- sparks;
- smoke;
- dust;
- dirt kick-up;
- steam;
- machine fluid/oil;
- fire/burn;
- status effects;
- dodge/foot movement effects;
- death/destruction effects;
- rain interaction;
- lightning;
- environmental pollen/debris.

### Rules

- effects must preserve target readability;
- near/mid/far LODs;
- pooled emitters;
- hard particle budgets;
- reduced-resolution or GPU approaches only where justified.

### Exit criteria

No important combat event relies on HUD text alone; action, damage, status, and component destruction are readable through world-space presentation.

### Complexity

High

### Expected impact

Very high.

---

## Phase 10 — Audio production pass

### Objective

Move from prototype synthesis to layered premium audio while preserving a synthesized machine identity.

### Implement

- authored footsteps;
- weapon recordings/layers;
- impact libraries;
- machine servo/motor/body layers;
- unique machine vocalizations;
- environment beds;
- wildlife;
- weather;
- adaptive music stems;
- combat escalation;
- boss layers;
- voice priorities;
- stealing/culling;
- occlusion zones;
- simple reverb/environment sends.

### Exit criteria

- machine identity is recognizable with the screen hidden;
- high-priority combat tells cannot be starved by ambience;
- audio settings work live and persist;
- no duplicated persistent loops after pause/resume/restart.

### Complexity

High

### Expected impact

Very high.

---

## Phase 11 — UI/UX, controller, accessibility

### Objective

Make the game feel like a finished product rather than a collection of debug-style overlays.

### Implement

- unified visual design system;
- responsive layouts;
- gamepad action mappings;
- remapping;
- focus navigation;
- UI scaling;
- reduced camera shake;
- aim assists;
- toggle/hold options;
- high-contrast gameplay cues;
- color alternatives;
- reduced flashing where appropriate;
- clean onboarding;
- contextual tutorial prompts;
- restrained HUD modes.

### Exit criteria

The complete vertical slice can be played with keyboard/mouse and controller without using developer controls.

### Complexity

Medium–High

### Expected impact

High.

---

## Phase 12 — Vertical-slice certification

No broader content conversion begins until all gates in `VERTICAL_SLICE.md` pass.

Required areas:

- final hunter;
- final Skitter/Ironmaw/Duskwing;
- final biome/ruin;
- production lighting/materials;
- complete combat presentation;
- AI/navigation;
- audio;
- VFX;
- HUD/settings/accessibility basics;
- save/continue;
- clean console;
- performance budget;
- soak test;
- cross-browser smoke coverage.

---

## Phase 13 — Monarch production proof

### Objective

Validate boss-scale constraints before converting the entire roster.

Prove:

- larger skeleton and animation set;
- multi-phase component logic;
- attack telegraphs;
- boss music/VFX;
- phase transitions;
- LOD and shadow cost;
- persistence/no-respawn rules;
- rewards;
- encounter camera/readability.

---

## Phase 14 — Full current-roster conversion

Convert remaining machines only after the first four production assets have stabilized all conventions.

For each machine, require:

- unique silhouette;
- role clarity;
- final LODs;
- final materials;
- final rig/animation;
- final ability synchronization;
- component/weak-point logic;
- final audio identity;
- final VFX identity;
- benchmark cost report;
- AI regression scenarios.

---

## Phase 15 — Full world conversion

Expand the proven art kit across existing biomes.

Prioritize:

- distinct biome composition;
- landmark hierarchy;
- machine ecology/territories;
- meaningful resource distribution;
- strong routes and sightlines;
- authored encounters;
- environmental storytelling.

Do not enlarge the world until current space feels dense, coherent, and intentionally designed.

---

## Phase 16 — Systems depth and product completion

After presentation and combat quality are proven, deepen:

- quests/contracts;
- progression;
- skill tree;
- economy;
- crafting;
- bestiary;
- map/navigation;
- tutorials;
- accessibility;
- optional narrative/NPC content if the product direction truly requires it.

Use data-driven definitions and executable balance simulations.

---

## Phase 17 — WebGPU R&D gate

Prototype the same certified vertical slice using Three.js WebGPURenderer/TSL only after WebGL2 performance and visual budgets are stable.

Compare:

- fidelity;
- frame time;
- browser coverage;
- shader authoring cost;
- post-processing architecture;
- maintenance complexity;
- ability to implement desired future features.

Adopt only with a clear measured win.

---

## Phase 18 — Release hardening

- long soak tests;
- save migration matrix;
- cross-browser matrix;
- quality-tier verification;
- accessibility pass;
- loading/retry/failure states;
- asset license audit;
- memory leak hunt;
- visual regression stabilization;
- performance regression lock;
- documentation cleanup;
- production build/deployment verification.

---

# Rough priority/effort matrix

| Initiative | Priority | Effort | Player impact |
|---|---:|---:|---:|
| CI/tests/repo hardening | P0 | Medium | Indirect/critical |
| Performance telemetry | P0 | Medium | Indirect/critical |
| Audio/input/save lifecycle | P0 | Medium | High reliability |
| Asset pipeline | P1 | High | Critical |
| Hunter production pass | P1 | Very High | Critical |
| 3-machine slice | P1 | Very High | Critical |
| Rendering/lighting | P1 | High | Very High |
| Combat/camera polish | P1 | High | Very High |
| AI/navigation | P1 | Very High | High |
| World art/LOD/streaming | P1 | Very High | Critical |
| VFX | P1 | High | Very High |
| Authored audio | P1/P2 | High | Very High |
| UX/controller/accessibility | P2 | Medium–High | High |
| Remaining roster | P2 | Very High | Very High |
| Full world conversion | P2 | Very High | Critical |
| Progression/content depth | P2 | High | High |
| WebGPU prototype | P3 | High | Strategic |
| Motion matching | P3 | Very High | Optional |
| Larger map/new species | Deferred | Unbounded | Do not build yet |

# Recommended parallelization after foundations

Once Phase 0–2 contracts are stable, work can proceed in coordinated parallel tracks:

- Track A: hunter + animation runtime;
- Track B: machine asset pipeline;
- Track C: rendering/lighting;
- Track D: AI/navigation;
- Track E: world art/streaming;
- Track F: combat/VFX;
- Track G: audio;
- Track H: UI/accessibility/testing.

One integration owner must continuously protect performance, animation contracts, asset conventions, and the vertical-slice acceptance bar.
