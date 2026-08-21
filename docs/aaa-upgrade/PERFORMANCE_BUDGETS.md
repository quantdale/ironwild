# IRONWILD — Performance Budgets and Benchmark Contract

These are **initial engineering budgets**, not claims about current measured performance. Baseline values must be captured on controlled hardware before implementation work uses them for comparison.

The purpose of these budgets is to prevent visual/content upgrades from silently destroying frame pacing and browser viability.

## 1. Primary target

Target experience for the production High preset:

- 60 Hz display target;
- 1920×1080 reference output on the selected mid-tier discrete-GPU machine;
- dynamic render scale permitted if necessary, while UI remains native-resolution;
- stable frame pacing prioritized over peak FPS.

## 2. Initial frame budgets

| Metric | Initial target |
|---|---:|
| Frame time p50 | ≤ 14 ms |
| Frame time p95 | ≤ 16.7 ms |
| Frame time p99 | ≤ 24 ms |
| Main-thread simulation + render submission p95 | ≤ 6 ms |
| GPU frame p95 | ≤ 12 ms |
| Post-processing GPU budget | ≤ 4 ms |
| Repeated long tasks during gameplay | none > 25 ms as a normal pattern |

Treat p95/p99 as the primary stability signal. Average FPS alone is insufficient.

## 3. Scene-complexity planning budgets

These must be tuned after real captures.

| Metric | Typical scene | Stress/boss scene |
|---|---:|---:|
| Draw calls | ≤ 700 | ≤ 1,000 |
| Visible triangles | ≤ 2.5 M | ≤ 4 M |
| Dynamic high-cost shadow casters | aggressively bounded | explicitly reviewed |
| Transparent overdraw | bounded by effect/foliage LOD | no uncontrolled full-screen stacking |

Individual asset triangle guidance is secondary to total scene cost.

Initial near-camera planning ranges:

- hunter LOD0: roughly 70k–120k visible triangles;
- ordinary machine LOD0: roughly 30k–80k;
- hero/boss LOD0: up to roughly 150k–200k only if profiled and justified.

These are starting constraints, not universal truths. Material count, skinning cost, shadows, overdraw, and number of simultaneous actors can matter more than raw triangles.

## 4. Memory/residency planning budgets

Initial planned GPU-visible asset residency targets:

- High: ≤ ~1.25 GB;
- Medium: ≤ ~750 MB;
- Low: ≤ ~450 MB.

Browser memory behavior varies and does not expose perfect GPU accounting, so track proxies:

- renderer texture/geometry counts;
- loaded asset manifests;
- estimated decoded texture sizes;
- JS heap;
- resource lifecycle logs;
- browser process memory in controlled manual profiling.

No benchmark/soak run should show monotonic heap/resource growth after warm-up.

## 5. Loading targets

Targets depend on hosting/network strategy, but the product should be designed for staged availability rather than downloading the entire future game before Start.

Track:

- HTML/JS boot time;
- time to interactive title screen;
- Start-to-playable latency;
- first biome critical asset transfer size;
- asset decode/transcode time;
- shader compilation stutter;
- cell/encounter prefetch latency.

Preferred behavior:

1. title/start UI becomes usable quickly;
2. critical hunter/core assets load first;
3. immediate gameplay cell preloads before entering play;
4. neighboring world content prefetches opportunistically;
5. distant visual resources are disposable/reloadable.

## 6. Quality preset contract

### High

Goal: intended art direction.

Candidates:

- full PBR materials;
- full selected post stack;
- CSM or highest-quality profiled shadow mode;
- highest vegetation density/LOD;
- best volumetric settings;
- highest useful render scale;
- richer particles;
- farther LOD ranges.

### Medium

Goal: preserve artistic identity with substantial cost reduction.

Reduce:

- shadow cascades/range/resolution;
- volumetric sample count/resolution;
- vegetation density/range;
- particle density;
- water/reflection quality;
- render scale if required;
- far actor/environment LOD distance.

### Low

Goal: maintain readability and gameplay on constrained hardware.

Reduce/disable:

- expensive volumetrics;
- costly AO variants;
- most distant dynamic shadows;
- dense decorative vegetation;
- expensive transparent effects;
- high particle counts;
- far geometry detail;
- high render scale.

Do not make Low visually broken or mechanically harder because weak points/telegraphs disappear.

## 7. Dynamic resolution

Dynamic resolution should:

- scale only the 3D render targets;
- preserve crisp DOM/UI resolution;
- use a moving frame-time window;
- apply hysteresis;
- change slowly enough to avoid visible pumping;
- operate inside a bounded range such as ~70–100% initially;
- never conceal pathological CPU bottlenecks.

Track current render scale in the developer HUD and benchmark output.

## 8. Vegetation budget strategy

Global giant instance batches reduce draw calls but can waste vertex processing/culling opportunities.

Use spatial vegetation cells with active rings.

### Near ring

Approximate concept: 0–45 world meters.

Allow:

- highest foliage LOD;
- richer wind;
- selected shadows;
- interactable vegetation where required.

### Mid ring

Approximate: 45–90 m.

Use:

- reduced mesh complexity;
- cheaper wind;
- minimal shadows.

### Far ring

Approximate: 90–180 m.

Use:

- cheap geometry/impostors;
- no expensive per-instance animation;
- aggressive distance culling.

Exact distances must be tuned for the game's camera/FOV/world scale.

## 9. Animation/AI CPU budgets

Do not run every behavior decision every render frame.

Recommended architecture:

- player/gameplay-critical movement: fixed simulation step;
- nearby combat locomotion/collision: fixed step;
- AI perception/decision: staggered ~5–10 Hz depending on distance/importance;
- distant AI: lower-frequency state updates;
- animation mixer updates: visible/relevant actors only where practical;
- LOS queries: spatially filtered and staggered.

Benchmark specifically:

- six active machines;
- mixed archetypes;
- Monarch boss;
- focus scan/time scaling;
- multiple projectiles/status effects.

## 10. Rendering-pass budgets

Track GPU time per pass when timer queries are available.

At minimum break down:

- scene geometry;
- shadows;
- AO;
- atmosphere/volumetrics;
- water/transparents;
- bloom;
- AA;
- grade/output.

Rules:

- expensive effects should support lower internal resolution;
- quality tiers must materially alter their cost;
- no single decorative full-screen effect should consume a disproportionate share of the 16.7 ms frame budget;
- avoid synchronous GPU queries in normal gameplay.

## 11. Benchmark scenarios

### B1 — Spawn meadow

Measures:

- baseline terrain;
- normal vegetation;
- hunter animation;
- normal lighting/post.

### B2 — Dense forest traverse

Measures:

- foliage culling;
- draw calls;
- shadow pressure;
- wind cost;
- traversal streaming.

### B3 — Lake/sunrise

Measures:

- water;
- sun shafts/volumetrics;
- IBL/reflection pressure;
- atmosphere.

### B4 — Heavy storm

Measures:

- weather particles;
- storm atmosphere/clouds;
- lightning;
- audio concurrency;
- dynamic lighting spikes.

### B5 — Six-machine combat

Measures:

- AI;
- animation;
- projectiles;
- hit VFX;
- machine audio;
- combat HUD;
- CPU/GPU overlap.

### B6 — Focus scan

Measures:

- overlay/post effects;
- scan visualization;
- time-scale behavior;
- target highlighting.

### B7 — Monarch

Measures:

- hero asset LOD0;
- boss animation;
- large shadows;
- phase VFX;
- AI;
- music/audio layers.

### B8 — 20-minute traversal soak

Measures:

- asset disposal/reload;
- JS heap;
- renderer memory counters;
- event/listener leaks;
- persistent audio leaks;
- streaming stability.

## 12. Benchmark hardware tiers

Use controlled reference machines rather than random developer hardware.

### Tier L — constrained/integrated

Purpose: Low-preset viability and failure-mode discovery.

### Tier M — minimum discrete target

Purpose: required product floor if discrete GPU is part of the intended audience.

### Tier T — primary target discrete GPU

Purpose: High-preset 60 Hz certification.

Exact hardware models should be selected and recorded separately once the intended audience is fixed.

## 13. Browser matrix

At minimum regularly exercise:

- Chromium-based browser;
- Firefox;
- WebKit/Safari path where supported by available hardware/CI.

Do not assume pointer lock, audio policies, shader compilation, texture formats, and WebGL driver behavior are identical across browsers.

## 14. Instrumentation requirements

Developer HUD/report should expose:

- instantaneous FPS;
- frame time rolling graph;
- p50/p95/p99 over capture window;
- simulation/update ms;
- render submission ms;
- draw calls;
- triangles;
- textures/geometries/programs from renderer info;
- active machines;
- active projectiles;
- active particles;
- loaded world cells;
- current quality preset;
- current render scale;
- optional GPU pass timings.

Benchmark reports should include:

- commit SHA;
- browser/version;
- OS;
- CPU;
- GPU;
- resolution;
- quality preset;
- scene seed;
- benchmark duration;
- metrics.

## 15. Regression rules

A change should be investigated when, under controlled conditions, it causes approximately:

- >5% repeated p95 frame-time regression;
- >10% draw-call or visible-triangle increase without corresponding visual/content justification;
- new long-task spikes;
- monotonic memory growth;
- major increase in first-playable loading size/time;
- unexpected quality-tier cost convergence.

The exact CI blocking threshold can be tightened once benchmark variance is known.

## 16. Performance optimization order

When a benchmark fails:

1. determine CPU vs GPU vs loading/memory bottleneck;
2. find the largest contributors;
3. reduce invisible/useless work;
4. improve culling/LOD/batching;
5. reduce expensive pass resolution/sample count;
6. reduce material/shadow complexity;
7. reduce asset complexity only where needed;
8. use dynamic resolution as a controlled final lever, not as a substitute for fixing pathological work.

## 17. Vertical-slice performance definition of done

The slice passes when:

- the target machine satisfies p95/p99 goals across representative scenes;
- no recurring catastrophic frame spikes occur in combat/traversal;
- dense vegetation stays inside budget;
- six-machine combat stays inside CPU/GPU budget;
- Monarch stress test is acceptable;
- 20-minute soak shows no monotonic leak;
- Medium/Low provide real cost savings;
- visual/gameplay readability remains intact at lower presets;
- performance measurements are reproducible and attached to the candidate release/commit.
