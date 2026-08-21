# IRONWILD — AAA-Quality Upgrade Master Plan

Status: Strategic production plan  
Scope: Graphics, mechanics, features, content, performance, tooling, and production quality  
Target architecture: Three.js/Vite browser game unless migration triggers are met  
Reference bar: modern premium third-person action games, especially machine-hunting/open-world titles, without copying protected IP

## 1. Executive decision

IRONWILD should not attempt to become “AAA” by adding more post-processing or more features to the current prototype. The largest quality gap is production value: authored models, PBR materials, rigging, animation, VFX, lighting art, audio content, environment dressing, encounter design, input feel, and polish.

The correct strategy is:

1. harden the production foundation;
2. establish measurable performance and quality gates;
3. build a real asset/animation pipeline;
4. produce one uncompromising vertical slice;
5. prove combat, AI, world art, audio, UX, and performance together;
6. only then scale the remaining game content.

The current Three.js/WebGL architecture remains viable for an AAA-like browser game if scope is controlled and content is aggressively optimized. Do not migrate engines simply because AAA games commonly use Unreal or proprietary engines. Migration should occur only after objective technical triggers are met.

## 2. What “AAA-like” means for IRONWILD

Literal AAA production typically implies hundreds of specialists, multi-year production, extensive outsourcing, large animation libraries, cinematic pipelines, specialized tools, QA, localization, accessibility, audio production, content authoring, and substantial budgets.

For IRONWILD, the achievable goal is **AAA-like presentation and game feel within a constrained browser-scale product**:

- premium art direction;
- authored hero-quality player and machine assets;
- believable skeletal animation and hit reactions;
- responsive movement/combat/camera;
- sophisticated machine behavior;
- polished VFX and audio feedback;
- dense, intentional environments rather than a huge empty map;
- robust progression, UX, accessibility, save behavior, and settings;
- stable frame pacing and clean browser behavior;
- a production pipeline that allows quality to scale without collapsing maintainability.

## 3. Current strengths to preserve

IRONWILD already has valuable foundations:

- deterministic world/terrain generation;
- multiple machine archetypes;
- bow and spear combat;
- weak points and status effects;
- dodge/stamina systems;
- stealth and concealment concepts;
- swimming;
- weather and day/night;
- quests/contracts;
- crafting and progression;
- bestiary;
- boss content;
- save/continue;
- settings/accessibility concepts;
- adaptive/synthesized audio concepts;
- quality tiers;
- a substantial post-processing stack.

Do not throw these away in a speculative rewrite. Productionize them incrementally.

## 4. Core diagnosis

### 4.1 Graphics

The renderer is no longer the primary bottleneck to perceived quality. The current visual ceiling is dominated by prototype-grade source content and limited art direction.

Highest-impact visual upgrades:

1. authored hunter model and machines;
2. glTF/GLB asset pipeline;
3. metallic/roughness PBR materials;
4. normal/AO/roughness/metallic/emissive texture workflows;
5. skeletal animation;
6. animation blending and IK;
7. image-based lighting;
8. improved shadow strategy;
9. environment art kits and authored landmarks;
10. production VFX;
11. richer weather/atmosphere;
12. LOD/HLOD and spatial streaming;
13. deliberate color grading and visual identity.

### 4.2 Mechanics

IRONWILD already has enough mechanics to support a premium vertical slice. The next leap should be **depth and feel**, not feature count.

Prioritize:

- movement responsiveness;
- animation-driven combat timing;
- better aiming and camera behavior;
- stronger hit confirmation;
- machine reactions and breakable parts;
- readable attack telegraphs;
- better AI state transitions;
- navigation and obstacle handling;
- encounter composition;
- richer stealth/perception;
- strong difficulty tuning.

### 4.3 Features

Do not immediately add towns, dialogue trees, dozens of NPCs, mounts, huge quest chains, or a much larger map.

First bring existing systems to product quality:

- progression;
- crafting;
- loot economy;
- contracts;
- bestiary;
- skill tree;
- settings;
- accessibility;
- input remapping;
- controller support;
- map/navigation;
- onboarding/tutorials;
- save migration/recovery;
- audio mixing;
- visual feedback.

## 5. Recommended visual identity

IRONWILD should look intentionally its own rather than a generic sci-fi nature prototype.

### “Industrial wilderness” direction

Core contrast:

**beautiful living biomes vs. exposed mechanical brutality**.

Visual pillars:

- weathered steel, oxidized surfaces, ceramic armor, braided cables, hydraulic elements;
- strong silhouette language for each machine role;
- machine emissives reserved for gameplay-readable energy/weak-point states;
- vegetation that appears to reclaim industrial remnants;
- atmospheric haze, moisture, dust, pollen, rain, sparks, steam, and particulate life;
- grounded colors with selective high-energy accents;
- world landmarks built from ancient industrial infrastructure overtaken by nature;
- restrained post-processing; image quality should come from lighting/materials/assets first.

Machine design should communicate behavior before combat begins:

- agile machines: low mass, narrow silhouettes, exposed joints;
- tanks: broad armor, low center of gravity, protected cores;
- aerial machines: lightweight panels, articulated flight surfaces;
- aquatic machines: hydrodynamic forms and submerged sensor structures;
- boss machines: recognizable layered armor and phase-specific destructible zones.

## 6. Rendering roadmap

### Tier 1 — Highest ROI in existing WebGL/Three.js

Implement first:

- production glTF loading;
- KTX2/Basis texture compression;
- Meshopt/Draco where beneficial;
- PMREM-based environment lighting;
- improved PBR materials;
- material libraries;
- CSM or another profiled shadow strategy on High;
- spatially chunked vegetation;
- LOD for actors and foliage;
- impostors/billboards for distant vegetation;
- dynamic resolution scaling;
- half/quarter-resolution expensive effects;
- performance telemetry;
- deterministic benchmark scenes;
- art-directable exposure/bloom/grade/weather parameters.

### Tier 2 — Ambitious browser upgrades

After the vertical slice is stable:

- depth-aware volumetric light shafts;
- temporal accumulation/upscaling for volumetrics;
- improved cloud/storm rendering;
- more sophisticated water;
- GPU-driven particle systems;
- improved screen-space effects where justified;
- renderer abstraction to allow WebGPU experiments;
- WebGPU/TSL prototype on the same vertical slice;
- clustered lighting experiments if scene design actually benefits.

### Tier 3 — Engine-migration territory

Consider migration only if IRONWILD’s product scope changes to require several of the following simultaneously:

- very large seamless worlds with heavy streaming;
- dense NPC populations and sophisticated navmesh tooling;
- large cinematic/narrative pipeline;
- extensive mocap and cinematic sequencing;
- highly advanced destruction/physics;
- sophisticated world-building editor requirements;
- console/desktop native release as a primary product;
- large art/design team blocked by lack of editor tooling;
- renderer requirements that cannot be met within performance budgets on the web.

## 7. Objective engine migration triggers

Remain on Three.js unless one or more hard triggers are repeatedly proven:

1. The target vertical slice cannot meet its visual bar within frame-time budgets after a dedicated optimization pass.
2. Content production is materially slower because the team lacks world/animation/AI authoring tools that would take longer to build than migration.
3. Required graphics features cannot be implemented or approximated acceptably in WebGL/WebGPU.
4. Native console/desktop shipping becomes a core business requirement.
5. Browser memory/download constraints prevent the intended asset scale.
6. The world expands enough that streaming/nav/editor requirements dominate engineering effort.

If migration occurs, port a vertical slice first. Never rewrite the full game before proving the destination architecture.

## 8. Gameplay target architecture

Move from prototype coupling toward explicit systems:

```text
Input devices
  -> action abstraction
  -> fixed-step simulation
      -> player controller
      -> combat/abilities
      -> AI/perception/navigation
      -> world/encounters
      -> progression/economy
  -> presentation interpolation
      -> animation graph
      -> rendering
      -> VFX
      -> audio
      -> HUD
```

Introduce a `GameContext` or equivalent dependency boundary over time. Do not perform a one-shot ECS rewrite.

## 9. Player movement and traversal

Target feel:

- low input latency;
- responsive acceleration/deceleration;
- reliable slopes/steps/terrain interaction;
- consistent dodge rules;
- camera-assisted orientation without stealing control;
- animation that matches actual movement velocity;
- smooth transitions between run, sprint, crouch, jump, landing, swim, aim, and combat;
- contextual IK for feet and weapons.

Potential later traversal additions, only after fundamentals are excellent:

- mantle/vault;
- contextual climb points;
- slide;
- grapple-like traversal only if it supports world design rather than feature inflation.

## 10. Combat upgrade plan

Combat should become the flagship gameplay system.

### Bow

Improve:

- draw animation and timing;
- projectile feel and trail readability;
- aim offsets;
- reticle feedback;
- hit confirmation;
- weak-point feedback;
- elemental/status variants;
- impact materials and particles;
- sound layering;
- camera recoil/settling;
- optional aim assistance/accessibility.

### Spear/melee

Improve:

- anticipation, active, and recovery phases;
- animation-driven hit windows;
- directional/target-aware attacks;
- stagger/armor interactions;
- readable machine counters;
- hitstop or subtle time dilation where appropriate;
- strong camera/audio/VFX impact response;
- cancel rules that are explicit and testable.

### Machine damage model

Move toward layered machine combat:

- armor plates;
- destructible weapons/components;
- exposed weak points;
- status vulnerabilities;
- breakable resource containers;
- behavior changes after components are destroyed;
- visual damaged states;
- meaningful tactical choices beyond raw HP depletion.

## 11. Machine AI upgrade plan

Preserve archetype identity while improving architecture.

Recommended hierarchy:

```text
Perception
  -> Blackboard
  -> High-level state
     Patrol
     Investigate
     Alert
     Combat
     Flee
     Disabled
     Dead
  -> Archetype combat state
  -> Ability selector
  -> Navigation/steering
  -> Animation/attack executor
```

Required improvements:

- shared perception model;
- visual cones and LOS;
- hearing/noise events;
- threat memory;
- investigation behavior;
- target loss/reacquisition;
- navmesh/grid navigation for authored spaces;
- local steering/avoidance;
- aerial and aquatic navigation layers;
- staggered AI decision ticks;
- distance-based AI update rates;
- herd/group coordination where appropriate;
- debug visualization for states, paths, perception, and transitions.

## 12. Animation strategy

Use Three.js `AnimationMixer` as the low-level playback layer and build a game-specific animation graph above it.

Hunter layers:

- base locomotion;
- crouch/swim variants;
- upper-body weapon layer;
- dodge/hit/death overrides;
- additive aim/look/breathing;
- foot IK;
- weapon-hand IK.

Each machine should expose standardized bones/sockets:

- weak points;
- weapons;
- VFX emitters;
- audio emitters;
- hit proxies;
- attachment points.

Attack assets should contain timing metadata:

- anticipation;
- active window;
- recovery;
- movement/root-motion curve if used;
- damage event;
- audio event;
- VFX event;
- camera event where appropriate.

Do not implement motion matching until a large enough animation library exists to justify it.

## 13. World and content strategy

Do not increase map size yet.

Increase **density, authorship, and meaning**:

- machine territories;
- hunting grounds;
- landmarks;
- ruins;
- elevation-based sightlines;
- stealth spaces;
- resource logic;
- encounter compositions;
- environmental storytelling;
- biome transitions;
- weather-driven mood;
- traversal routes.

Use procedural generation as an artist multiplier, not an art-direction substitute.

Recommended model:

- procedural macro terrain and biome distribution;
- deterministic resource/machine seeds;
- authored hero locations;
- rule-based set dressing around authored anchors;
- spatial cells for visibility and streaming;
- biome-specific prop/material kits.

## 14. Features to deepen before expanding scope

### Progression

- data-driven XP curves;
- clearer domain/skill identity;
- meaningful skill upgrades rather than passive percentage inflation;
- unlock pacing simulations;
- balance tests.

### Crafting/economy

- deterministic resource accounting;
- meaningful machine-part drops;
- recipes tied to tactical play;
- anti-duplication safeguards;
- executable economy simulations.

### Bestiary

Turn it into a gameplay tool:

- discovered machine behaviors;
- breakable components;
- vulnerabilities/resistances;
- loot tables;
- tactical notes;
- scan progression;
- strong machine illustrations/renders later.

### Map/navigation

Add after the vertical slice establishes world language:

- map regions;
- machine sites;
- discovered landmarks;
- quest markers with restraint;
- waypoint routing only where it helps;
- optional compass/HUD reduction modes.

### Accessibility

Target production-grade options:

- remappable inputs;
- controller support;
- hold/toggle choices;
- aim assistance;
- subtitle/caption controls if dialogue is added;
- UI scaling;
- high-contrast interaction/weak-point modes;
- reduced camera shake;
- reduced flashing;
- color alternatives;
- difficulty assists separated from difficulty presets.

## 15. Audio strategy

Preserve synthesis as an IRONWILD signature layer, especially for machine electronics, focus-tech tones, and procedural accents. Add authored content around it.

Production audio needs:

- layered machine movement;
- servo/motor/metal impacts;
- unique machine vocal identities;
- footsteps by surface;
- bow/spear recordings;
- body/armor impact sets;
- weather beds;
- wildlife;
- environmental ambience;
- adaptive music stems;
- boss layers;
- spatial attenuation;
- voice priority/stealing;
- simple occlusion/reverb zones.

Immediate engineering requirement: audio initialization must be user-gesture-safe and idempotent.

## 16. UX and HUD

Design a unified visual language rather than independently styled overlays.

Principles:

- combat information only when needed;
- weak points readable through world visuals, not HUD alone;
- consistent typography and spacing;
- responsive layouts;
- controller navigation;
- strong settings discoverability;
- clean pause state;
- accessible color and scale options;
- avoid permanent clutter.

## 17. Production foundations required before expensive art conversion

Before scaling art production:

- clean repository generated artifacts;
- `.gitignore` hygiene;
- repeatable `npm ci` flow;
- lint/type-check/static checks;
- deterministic unit tests;
- system/integration tests;
- browser E2E;
- visual regression in a pinned environment;
- save migration fixtures;
- asset validation;
- performance instrumentation;
- benchmark scenes;
- clean-console standard;
- CI quality gate.

## 18. Production asset pipeline

Recommended runtime format: glTF/GLB.

Pipeline:

```text
Concept/style guide
 -> high-poly/source model
 -> retopology
 -> UVs
 -> normal/AO/curvature bake
 -> PBR texturing
 -> rig/skin
 -> animation
 -> GLB export
 -> glTF validation
 -> mesh optimization
 -> KTX2/Basis texture build
 -> LOD validation
 -> runtime manifest
 -> browser asset loading
```

Every asset category needs hard conventions for scale, axes, bones, material names, texture classes, LODs, sockets, and licenses/provenance.

## 19. Performance philosophy

Profile before optimizing.

Measure:

- p50/p95/p99 frame time;
- CPU simulation time;
- render submission time;
- GPU pass timings where available;
- draw calls;
- visible triangles;
- texture/GPU residency;
- JS heap behavior;
- long tasks;
- loading time;
- asset decode time;
- soak-test memory growth.

Do not accept “it feels smooth on my machine” as a performance gate.

## 20. Vertical slice recommendation

Build a 10–15 minute final-quality slice containing:

- final-quality hunter;
- Skitter;
- Ironmaw;
- Duskwing;
- one polished biome;
- one authored ruin/landmark;
- one stealth approach;
- one mixed-machine encounter;
- complete bow/spear combat;
- weak-point/component destruction;
- final-quality lighting/materials/VFX/audio;
- production HUD/settings;
- save/continue;
- accessibility basics;
- performance instrumentation.

Why these machines:

- Skitter validates agile ground animation and AI;
- Ironmaw validates heavy mass, armor, melee, and reaction design;
- Duskwing validates aerial navigation, silhouettes, projectile/air combat, and camera/readability challenges.

After those pass the target bar, convert Monarch next to validate boss-scale production.

## 21. Priority ladder

### P0 — Production foundation

- repository hygiene;
- CI;
- automated tests;
- performance telemetry;
- clean audio lifecycle;
- action-based input/pointer-lock state machine;
- save schema/migration/backup;
- dependency modernization with regression coverage.

### P1 — Vertical slice quality

- glTF/PBR pipeline;
- final hunter;
- animation graph/IK;
- three production machines;
- renderer/lighting upgrades;
- chunked world + LOD;
- combat/camera polish;
- AI/navigation refactor;
- machine animation synchronization;
- VFX library;
- authored audio layer.

### P2 — Full current-game conversion

- remaining machine roster;
- Monarch production pass;
- environment art across biomes;
- expanded VFX/audio;
- controller/remapping/accessibility;
- progression/economy data pipeline;
- map/navigation UX;
- onboarding/tutorial polish.

### P3 — Strategic R&D

- WebGPU/TSL renderer prototype;
- clustered lighting if justified;
- motion matching research;
- more advanced volumetric weather;
- larger content scope only after existing content is final-quality.

## 22. Anti-goals

Do **not** do these yet:

- add many new machine species;
- enlarge the map;
- rewrite everything into ECS;
- rewrite the renderer to WebGPU immediately;
- migrate engines without measured triggers;
- implement motion matching before animation content exists;
- hide low-quality assets under bloom/chromatic aberration/grain;
- create a complex narrative/NPC pipeline before core combat and world production quality are proven;
- optimize arbitrary micro-code without profiling;
- scale asset production before the vertical-slice import/LOD/material/animation rules stabilize.

## 23. Definition of success

IRONWILD reaches the intended target when a player can enter the vertical slice and experience a coherent premium game where:

- assets no longer look procedural/prototype-grade;
- movement and camera feel deliberate;
- bow and spear combat feel responsive and impactful;
- machines visibly communicate intent and damage;
- AI navigates and reacts credibly;
- the biome feels authored and alive;
- lighting/materials/weather form one visual language;
- VFX and audio reinforce every meaningful action;
- HUD is clear and restrained;
- save/input/audio behavior is robust;
- performance remains inside measured budgets;
- development can safely scale through automated gates.

Only after that proof should the whole game be expanded toward the same standard.

## 24. Supporting documents

See:

- `VERTICAL_SLICE.md` — exact target slice and acceptance criteria;
- `ROADMAP.md` — phased implementation program and dependencies;
- `PERFORMANCE_BUDGETS.md` — measurable browser performance contracts;
- `RESEARCH_REFERENCES.md` — technical and production references used to shape this strategy.
