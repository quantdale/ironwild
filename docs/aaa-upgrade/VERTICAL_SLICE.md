# IRONWILD — AAA-Like Vertical Slice Specification

The purpose of this slice is to prove that IRONWILD can achieve premium presentation, game feel, AI, content production, and browser performance **before** the whole game is converted.

The slice is a production gate, not a demo assembled from exceptions.

## 1. Target experience

A new player should be able to play approximately 10–15 minutes of polished gameplay containing:

1. a short traversal/exploration opening;
2. a Focus/observation moment;
3. a stealth approach;
4. a Skitter encounter;
5. an Ironmaw encounter emphasizing armor/components;
6. a Duskwing encounter emphasizing aerial threat;
7. a mixed encounter or authored climax;
8. loot/harvest/crafting/progression feedback;
9. save/continue proof.

The slice must feel like one coherent game, not several finished systems sitting beside prototype systems.

---

## 2. Included scope

### Player

Final-quality or near-final-quality:

- hunter model;
- PBR materials;
- rig;
- LODs;
- locomotion animations;
- crouch;
- jump/land;
- swim if water appears in the slice;
- bow draw/aim/release;
- spear attacks;
- dodge;
- hit reactions;
- death;
- aim offsets;
- foot IK;
- weapon alignment.

### Machines

Production assets for:

- Skitter;
- Ironmaw;
- Duskwing.

Each must include:

- final silhouette language;
- PBR materials;
- multiple LODs;
- rig;
- locomotion;
- alert/combat animations;
- complete attacks;
- weak points/components;
- damaged/broken states;
- hit/stagger/death;
- unique audio identity;
- VFX emitters;
- final collision/hit proxies.

### World

One polished biome containing:

- authored hero landmark/ruin;
- readable traversal routes;
- vegetation layers;
- terrain materials;
- ground clutter;
- environmental storytelling;
- stealth/concealment spaces;
- machine territory logic;
- resource placement;
- one strong vista;
- day/night/weather compatibility.

### Rendering

Required:

- production PBR pipeline;
- environment lighting/IBL;
- final-quality lighting direction;
- profiled shadow strategy;
- AO/contact detail;
- final bloom/exposure/grade baseline;
- atmosphere;
- water if visible;
- performance-aware vegetation;
- LOD/culling;
- dynamic resolution if required to meet targets.

### Combat

Required:

- polished bow feel;
- polished spear feel;
- synchronized attack hit windows;
- projectile impact feedback;
- weak-point feedback;
- component break feedback;
- armor behavior;
- status/burn behavior if retained in the slice;
- machine hit reactions;
- player damage reactions;
- readable telegraphs;
- meaningful camera feedback;
- polished combat audio.

### AI

Required:

- patrol;
- perception;
- investigate;
- alert;
- combat;
- target loss/reacquisition;
- navigation through representative terrain/ruins;
- stuck recovery;
- archetype-specific ability selection;
- stable death/loot state.

### UX/product

Required:

- title/start/continue;
- HUD;
- pause;
- inventory/crafting path needed by the slice;
- settings;
- readable tutorial/onboarding prompts;
- controller support if included in the production target at this milestone;
- basic accessibility options;
- save/continue.

### Audio

Required:

- user-gesture-safe startup;
- master/SFX/music settings;
- hunter movement;
- weapons;
- impacts;
- machine layers;
- ambience;
- weather used in slice;
- adaptive combat music;
- no duplicated loops across pause/restart.

---

## 3. Explicitly excluded from the slice

Do not delay certification for:

- every existing biome;
- every existing machine;
- new machine species;
- larger map;
- settlement system;
- large NPC/dialogue system;
- cinematic narrative pipeline;
- motion matching;
- WebGPU renderer conversion;
- giant quest campaign;
- full endgame economy;
- console release support.

These are later decisions.

---

## 4. Visual acceptance bar

The slice fails if any major on-screen system still reads as an obvious placeholder from the normal gameplay camera.

### Hunter

Pass when:

- silhouette is intentional;
- materials respond plausibly to scene lighting;
- equipment attaches correctly;
- locomotion matches movement speed;
- feet do not visibly skate in routine movement;
- weapon hands do not visibly detach during core attacks;
- transitions do not visibly snap under ordinary play.

### Machines

Pass when:

- each archetype is recognizable by silhouette alone;
- materials distinguish armor/internal/mechanical/weak-point surfaces;
- attacks visibly originate from the correct body component;
- hit reactions do not destroy animation continuity;
- component destruction changes the rendered machine correctly;
- LOD transitions are not distracting at normal play distances.

### Environment

Pass when:

- there is no obvious repeating procedural wallpaper near the player;
- foreground, midground, and background have distinct density/readability;
- lighting reinforces navigable space and encounter focus;
- biome material blending does not look tiled or abruptly patched;
- landmark composition provides orientation without HUD dependence.

### Effects

Pass when:

- impacts are material-appropriate;
- sparks/smoke/dust/fire communicate events without hiding targets;
- machine weak-point breaks are unmistakable;
- weather supports mood without making combat unreadable;
- post-processing is controlled rather than visibly gimmicky.

---

## 5. Gameplay acceptance bar

### Movement

Pass when:

- input response feels immediate;
- diagonal movement is consistent;
- acceleration/deceleration feel intentional;
- sprint/dodge/jump/crouch transitions obey clear rules;
- player cannot enter obvious contradictory action states;
- camera does not routinely clip terrain or geometry;
- losing pointer capture does not leave the game in a broken state.

### Bow

Pass when:

- draw timing is readable;
- release occurs when animation/gameplay agree;
- projectile trajectory is predictable;
- impacts occur once;
- weak-point hit result is immediately understandable;
- reticle feedback is useful but not noisy;
- aiming does not fight the camera.

### Spear

Pass when:

- attack anticipation is readable;
- damage only exists during intended active windows;
- recovery matters;
- hit reaction/hitstop feedback is coherent;
- player cannot unintentionally double-resolve one strike.

### Machine combat

Pass when:

- player can learn machine behavior through telegraphs;
- destroying a component can meaningfully alter combat;
- armor/weak-point interactions are tactically different;
- Skitter, Ironmaw, and Duskwing require meaningfully different responses.

---

## 6. AI acceptance bar

Each machine must pass deterministic/repeatable scenarios.

### Skitter

- patrols correctly;
- notices visual/noise cues;
- approaches without obvious oscillation;
- leap attack telegraphs and resolves correctly;
- recovers after missed/blocked paths;
- exits combat or reacquires target correctly;
- dies/harvests exactly once.

### Ironmaw

- maintains believable heavy movement;
- does not spin unrealistically while attacking;
- uses armor and attack range coherently;
- pathing through the authored encounter is stable;
- component breaks can alter ability/behavior where designed.

### Duskwing

- flight path does not intersect terrain/structures in normal scenarios;
- aerial attacks remain readable;
- target loss/reacquisition works at altitude;
- dive/ranged attack logic does not softlock;
- death transitions to a valid harvest/loot state if applicable.

---

## 7. Performance certification

Use `PERFORMANCE_BUDGETS.md`.

The slice cannot be certified on average FPS alone.

Minimum evidence:

- p50/p95/p99 frame times;
- draw calls;
- visible triangles;
- memory/heap stability;
- GPU pass timing where supported;
- dense-world benchmark;
- heavy-combat benchmark;
- 20-minute soak.

Any quality feature that materially breaks the target tier must be optimized, degraded by quality preset, or removed before certification.

---

## 8. Browser/product reliability certification

Required clean flows:

### Fresh start

1. page loads;
2. no application error spam;
3. Start is clicked;
4. audio unlock occurs legally from the gesture;
5. input capture succeeds or presents a valid fallback/retry;
6. gameplay starts;
7. no uncaught exception.

### Pause/resume

- input is released/restored safely;
- gameplay time does not accidentally continue behind pause;
- audio does not duplicate;
- menus do not click through;
- repeated cycles remain stable.

### Save/continue

- save created;
- page reloaded;
- Continue restores expected progression/state;
- malformed save is recovered/rejected safely;
- legacy test fixture migrates successfully.

### Death/restart

- no stale AI/projectile/audio state leaks into restarted run;
- pointer/input behavior is valid;
- persistent progression follows design rules.

---

## 9. Audio certification

Pass when:

- no autoplay-policy violation on clean boot;
- one AudioContext/engine lifecycle is maintained as designed;
- repeated Start/Resume does not create duplicate persistent loops;
- critical machine attack cues are audible in busy scenes;
- nearby/distant machine sounds spatialize believably;
- music transitions do not pop or layer incorrectly;
- settings apply live and persist.

---

## 10. Content-production certification

The slice is also a pipeline test.

Before scaling, prove that another production asset can be added using documented conventions without custom runtime surgery.

Required:

- documented Blender/export conventions;
- automated glTF validation;
- automated texture/LOD budget checks;
- required animation clip checks;
- standardized sockets/tags;
- repeatable asset optimization step;
- runtime asset manifest;
- license/provenance record.

If every machine still needs bespoke import code, the pipeline has not passed.

---

## 11. Test certification

At minimum, automated coverage should include:

- app boot;
- clean-console smoke flow;
- save migration/validation;
- core damage formulas;
- weak-point/component rules;
- status timing;
- crafting/resource invariants;
- Skitter state transition scenarios;
- Ironmaw state transition scenarios;
- Duskwing state transition scenarios;
- player action-gating invariants;
- one deterministic combat simulation;
- one browser save/continue flow;
- visual snapshots for selected deterministic scenes in a pinned environment.

---

## 12. Review capture set

For each vertical-slice candidate, capture consistent review evidence:

1. hunter close-up in neutral daylight;
2. hunter movement sequence;
3. Skitter close combat;
4. Ironmaw armor/component break;
5. Duskwing aerial attack;
6. ruin vista;
7. forest density scene;
8. sunrise/lake scene if available;
9. storm scene;
10. night scene;
11. focus scan;
12. HUD/inventory/settings;
13. performance HUD in dense forest;
14. performance HUD in heavy combat.

Use the same camera/time/weather seeds for before/after comparisons.

---

## 13. Certification checklist

The slice is approved only if all are true:

- [ ] Final-quality hunter presentation
- [ ] Skitter production quality
- [ ] Ironmaw production quality
- [ ] Duskwing production quality
- [ ] One authored-feeling biome
- [ ] One production landmark/ruin
- [ ] PBR/IBL/lighting pipeline stable
- [ ] LOD/culling stable
- [ ] Combat animation synchronized with gameplay
- [ ] Component/weak-point damage readable
- [ ] AI/navigation passes representative scenarios
- [ ] VFX library covers all core combat events
- [ ] Authored + synthesized audio blend works
- [ ] HUD/settings are product-quality
- [ ] Save/continue/migration works
- [ ] Pointer-lock/input lifecycle works
- [ ] Audio lifecycle works
- [ ] Automated regression suite passes
- [ ] Clean browser console
- [ ] Performance budgets pass
- [ ] Soak test shows no monotonic memory leak
- [ ] Asset pipeline can onboard another machine without bespoke runtime hacks

If this checklist does not pass, do not scale the entire roster/world yet.
