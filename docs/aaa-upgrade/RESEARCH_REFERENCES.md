# IRONWILD — Research References

This document records the external technical and production material used to shape the AAA-quality upgrade strategy. These are reference principles, not instructions to copy proprietary content, assets, characters, story, names, or implementation code from commercial games.

## 1. Three.js runtime and rendering

### Three.js documentation

- WebGLRenderer  
  https://threejs.org/docs/pages/WebGLRenderer.html

- WebGPURenderer  
  https://threejs.org/docs/pages/WebGPURenderer.html

- RenderPipeline  
  https://threejs.org/docs/pages/RenderPipeline.html

- EffectComposer  
  https://threejs.org/docs/pages/EffectComposer.html

- OutputPass  
  https://threejs.org/docs/pages/OutputPass.html

- Color management  
  https://threejs.org/manual/en/color-management.html

- Post-processing guide  
  https://threejs.org/manual/en/how-to-use-post-processing.html

- GLTFLoader  
  https://threejs.org/docs/pages/GLTFLoader.html

- KTX2Loader  
  https://threejs.org/docs/pages/KTX2Loader.html

- AnimationMixer  
  https://threejs.org/docs/pages/AnimationMixer.html

- AnimationAction  
  https://threejs.org/docs/pages/AnimationAction.html

- SkinnedMesh  
  https://threejs.org/docs/pages/SkinnedMesh.html

- LOD  
  https://threejs.org/docs/pages/LOD.html

- InstancedMesh  
  https://threejs.org/docs/pages/InstancedMesh.html

- BatchedMesh  
  https://threejs.org/docs/pages/BatchedMesh.html

- CSM  
  https://threejs.org/docs/pages/CSM.html

- PMREM/environment-lighting related docs  
  https://threejs.org/docs/pages/PMREMNode.html

- ClusteredLighting (WebGPU)  
  https://threejs.org/docs/pages/ClusteredLighting.html

- Optimizing many objects  
  https://threejs.org/manual/en/optimize-lots-of-objects.html

- Resource cleanup/disposal  
  https://threejs.org/manual/en/how-to-dispose-of-objects.html

### Why these matter to IRONWILD

These sources establish that the current project can remain on Three.js while gaining:

- production glTF assets;
- skeletal animation;
- modern PBR material workflows;
- compressed textures;
- LOD;
- instancing/batching;
- environment lighting;
- improved shadows;
- future WebGPU experimentation.

They also show why a WebGPU conversion is not merely replacing `WebGLRenderer`: the post-processing architecture differs from the existing EffectComposer path.

---

## 2. glTF, KTX2, and asset delivery

### Khronos glTF

- glTF runtime 3D asset delivery overview  
  https://www.khronos.org/gltf/

- glTF registry/specification  
  https://registry.khronos.org/glTF/

- Khronos glTF Validator  
  https://github.com/KhronosGroup/glTF-Validator

- glTF 2.0 ISO/IEC announcement  
  https://www.khronos.org/news/press/khronos-gltf-2.0-released-as-an-iso-iec-international-standard

### Khronos KTX

- KTX GPU texture container  
  https://www.khronos.org/ktx/

- KTX2/Basis announcement and rationale  
  https://www.khronos.org/news/press/khronos-ktx-2-0-textures-enable-compact-visually-rich-gltf-3d-assets

### Blender glTF workflow

- Blender glTF 2.0 documentation  
  https://docs.blender.org/manual/en/latest/addons/import_export/scene_gltf2.html

### Why these matter

The proposed content pipeline uses glTF/GLB as the runtime interchange format, automated validation, GPU-friendly texture compression, explicit LODs, and repeatable export rules. This is central to replacing procedural prototype meshes with scalable production assets.

---

## 3. WebGL performance and profiling

### Khronos

- EXT_disjoint_timer_query_webgl2  
  https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/

### MDN

- WebGL best practices  
  https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices

### Chrome DevTools

- Runtime performance analysis  
  https://developer.chrome.com/docs/devtools/performance

- Memory panel  
  https://developer.chrome.com/docs/devtools/memory/

### Why these matter

The master plan requires GPU/CPU measurement, p95/p99 frame-time analysis, draw-call/triangle tracking, memory soak tests, and profiling before optimization. These references support that approach.

---

## 4. Browser input and audio lifecycle

### Pointer Lock

- W3C Pointer Lock 2.0  
  https://www.w3.org/TR/pointerlock-2/

- MDN requestPointerLock  
  https://developer.mozilla.org/en-US/docs/Web/API/Element/requestPointerLock

### Web Audio

- W3C Web Audio API  
  https://www.w3.org/TR/webaudio/

- MDN Web Audio API  
  https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API

- MDN autoplay guidance  
  https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay

### Why these matter

IRONWILD is browser-native. Input capture and audio startup must obey browser user-activation policies. Production behavior needs explicit state machines and clean recovery rather than assuming native-game semantics.

---

## 5. Automated browser testing

### Playwright

- Main documentation  
  https://playwright.dev/

- Continuous integration  
  https://playwright.dev/docs/ci

- Visual comparisons  
  https://playwright.dev/docs/test-snapshots

- Trace viewer  
  https://playwright.dev/docs/trace-viewer

### GitHub Actions

- Building/testing Node.js  
  https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs

### Why these matter

The roadmap proposes:

- clean-install CI;
- deterministic browser smoke tests;
- console-error detection;
- visual regression in a pinned environment;
- save/continue coverage;
- gameplay test hooks;
- release gating.

---

## 6. Guerrilla / Horizon production references

These talks are useful because IRONWILD has a similar **design problem class**—machine creatures in large natural environments—not because IRONWILD should reproduce Horizon content.

### Machine animation

- Animation Bootcamp: Bringing Life to the Machines of Horizon Zero Dawn  
  https://www.gdcvault.com/play/1025040/Animation-Bootcamp-Bringing-Life-to

Key lesson:

Machine quality depends on animation style, workflow, AI integration, and polish—not simply higher polygon counts.

### Procedural world placement

- GPU-Based Run-Time Procedural Placement in Horizon Zero Dawn  
  https://gdcvault.com/play/1024120/GPU-Based-Run-Time-Procedural

Key lesson:

Procedural world systems are most valuable when they remain artist-controllable and amplify authored design rather than replacing it.

### Machine audio

- Giving a Voice to the Machines of Horizon Zero Dawn  
  https://www.gdcvault.com/play/1025479/Giving-a-Voice-to-the

Key lesson:

A machine roster needs scalable audio design, strong identity, functional combat readability, variation, and nuance.

### AI systems

- Beyond Killzone: Creating New AI Systems for Horizon Zero Dawn  
  https://www.gdcvault.com/play/1024912

Key lesson:

Open-world machine AI places major demands on navigation, animation, behavior architecture, and production/debug tooling.

### Vegetation

- Between Tech and Art: The Vegetation of Horizon Zero Dawn  
  https://www.gdcvault.com/play/1025530/

Key lesson:

High-quality vegetation is both an art problem and a rendering/culling/production problem.

### Machine texturing

- Taking a Procedural Approach to Texturing the Machines of Horizon Forbidden West  
  https://www.gdcvault.com/play/1029327/Taking-a-Procedural-Approach-to

Key lesson:

Reusable procedural material/texturing workflows improve both consistency and content throughput for complex mechanical assets.

### Volumetric weather

- The Real-Time Volumetric Superstorms of Horizon Forbidden West  
  https://www.gdcvault.com/play/1027688/The-Real-Time-Volumetric-Superstorms

Key lesson:

Premium volumetric weather relies on carefully optimized rendering strategies such as reduced-resolution raymarching and temporal techniques, not brute-force quality.

### Quest/level design

- Level Design Workshop: Balancing Action and RPG in Horizon Zero Dawn Quests  
  https://gdcvault.com/play/1025445/Level-Design-Workshop-Balancing-Action

Key lesson:

Quest quality comes from deliberate encounter and level composition; adding a quest data structure is not equivalent to building high-quality quest content.

---

## 7. Naughty Dog / The Last of Us Part II references

These references are used mainly for animation, melee feel, and VFX production lessons.

### Motion matching

- Motion Matching in The Last of Us Part II  
  https://www.gdcvault.com/play/1027118/Motion-Matching-in-The-Last

Key lesson:

Motion matching can produce exceptional transitions, but it is a major animation-content and runtime investment. IRONWILD should first build a strong conventional animation graph and sufficient clip library.

### Melee AI

- Melee AI in The Last of Us Part II  
  https://www.gdcvault.com/play/1027115/Melee-AI-in-The-Last

Key lesson:

Close combat exposes tiny timing, behavior, animation, and feedback inconsistencies. Premium feel requires the systems to agree on attack timing and response.

### Particle/VFX work

- Enhancement of Particle Simulation Using Screen Space Techniques in The Last of Us Part II  
  https://www.gdcvault.com/play/1027356/Enhancement-of-Particle-Simulation-Using

Key lesson:

High-end effects often mix artistic goals with clever performance approximations rather than relying on maximum physical simulation.

---

## 8. God of War references

Useful supporting references for combat, animation, cinematography, accessibility, and audio production.

- Evolving Combat in God of War for a New Perspective  
  https://www.gdcvault.com/play/1026085/Evolving-Combat-in-God-of

- Animation Bootcamp: God of War — Breathing New Life into a Hardened Spartan  
  https://www.gdcvault.com/play/1025836/Animation-Bootcamp-God-of-War

- Breaking Barriers: Combat Accessibility in God of War Ragnarok  
  https://www.gdcvault.com/play/1028971/Breaking-Barriers-Combat-Accessibility-in

- Shipping Greatness: Practical Lessons from Audio Production on God of War  
  https://gdcvault.com/play/1026374/Shipping-Greatness-Practical-Lessons-from

Key lessons:

- combat camera and control changes must be designed together;
- high-quality animation is a production pipeline, not just a runtime feature;
- accessibility belongs inside combat/control design rather than being bolted on at the end;
- premium audio requires content production plus tooling/mixing discipline.

---

## 9. General interpretation rules

When using these references during implementation:

1. Extract transferable engineering/design principles.
2. Do not copy proprietary assets, code, names, visual designs, characters, story, animations, or audio.
3. Prefer current official technical documentation over old blog snippets when APIs conflict.
4. Profile IRONWILD itself instead of assuming another game's budget applies.
5. Adapt techniques to the browser and the actual team size.
6. Treat ambitious AAA techniques as optional unless they solve a measured IRONWILD problem.
7. Optimize for coherent quality, not feature parity with a specific commercial title.

## 10. Strategic takeaway from the research

Across the references, the recurring pattern is consistent:

**AAA-looking results come from production pipelines, specialization, iteration, tools, content quality, and performance discipline.**

IRONWILD therefore gets more value from:

- a production asset pipeline;
- excellent animation;
- better combat feel;
- authored environments;
- strong AI/navigation;
- audio/VFX polish;
- measurable performance;
- reliable tooling;

than from simply adding more mechanics or another layer of post-processing.
