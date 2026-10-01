# Design — Restore machine combat visuals (machine-presentation)

## Current-state analysis

### Two presentation modes exist, but only one is fully driven

Every machine record carries an animator (`src/anim/machineAnim.js: attachMachineAnimator`) created in `machines/ai.js: finishSpawn`. The animator has two modes:

- **procedural** — the default. `machines.js` builds the body from primitives and `updateMachine()` drives pose channels each frame: `a.crouch` (leap telegraph), `a.rear` (kick/stomp telegraph), `a.roar` (charge telegraph), `a.lean` (swipe), `a.jaw.rotation.x` (bite), `a.grinder` spin, `a.tail`/`a.antennae` sway, `a.rollSpin` (bulwark tumble), weak-point `glowMats` pulse, hull `emissive` flinch, part-break char (`wp._mats`), and the tip-over/fade in `updateDeath()`.
- **authored** — opted into when the manifest entry for the type has a real URL (`machines.js: assetId: getEntry(type)?.url ? type : null`) and `window.__IW_ASSETS.instantiate()` resolves. `installAuthored()` then **sets `visible = false` on every procedural mesh** and grafts the GLB root in.

Three machine types now have real authored GLBs (`public/assets/machines/{skitter,ironmaw,duskwing}.glb`, wired in `src/assets/manifest.js`), so on a normal run the majority of those species enter authored mode. The E2E spec `tests/e2e/asset-pipeline.spec.js` explicitly asserts this upgrade happens for all three.

### The wiring gap

So the authored machines keep a live, high-multiplier hit volume on the hidden procedural group, and the authored rig's own marker (`eye_band` on skitter) is a **separate, unbound object**. The authored rigs do carry marker nodes — `wp_eye` (skitter), `wp_maw` / `wp_radiator` (ironmaw), `wp_chest` (duskwing), surfaced by `assets.js collectWeakPoints()` into `clone.userData.weakPoints` — but `machines.js registerWeakPoint` is never re-run against them, so the gameplay contract is not bound to the rig that is actually drawn.

```text
$ grep -rn "playAttack\|playHitReact\|playDeath" src/     # only machineAnim.js itself
src/anim/machineAnim.js:151:    playAttack(attackName) {
src/anim/machineAnim.js:        playHitReact(strength = 1) {
src/anim/machineAnim.js:        playDeath() {
```

`machines/ai.js` never calls them. The attack scripts (`skitterAttack`, `rendclawAttack`, `ironmawAttack`, `duskwingAttack`, `bulwarkAttack`, `monarchTick`, `mirefangTick`) drive the procedural channels directly; `machines.js applyHit` sets `a.flinch`; `killMachine` sets `a.deathT`. All of that lands on invisible geometry once authored.

`main.js` calls `updateMachineAnimators(dt)` after the machines step, which only advances the locomotion graph (`updateAnimator` in machineAnim.js returns early unless `mode === 'authored'`, and only feeds `graph.update(dt, {speed, grounded: true})`).

### Measured consequences (headless probe, production build)

**Correction to an earlier reading.** A first probe traversed `wp.mesh` (the *procedural* group, hidden by `installAuthored`) and reported `visMeshes: 0`, which was over-generalized into "weak points are entirely invisible". That is wrong: the authored rigs ship their own visible emissive markers. A second probe enumerated the **authored root** and found the skitter renders 14 visible meshes including `eye_band` with `emissive 0xFF6F59` at intensity 1.0, sitting 0.464u from the gameplay hit volume. The weak point is visible; the defect is that its *state* is not.

**Finding A — the authored rig's attack/reaction clips never play.** The skitter GLB ships `act_skitter_lunge`, `react_hit` and `react_death`; the AnimGraph loads them (they appear in `graph.clips.actions` and `graph.clips.reactions`). Sampling every running mixer action during live combat:

```
availableClips: ["skitter_lunge", "hit", "death"]
observedRunning: ["loc_idle"]
```

Only the idle locomotion clip ever runs. `machines/ai.js` never calls `playAttack`; `machines.js applyHit` / `killMachine` never call `playHitReact` / `playDeath`:

```
$ grep -rn "playAttack\|playHitReact\|playDeath" src/
src/anim/machineAnim.js:151:    playAttack(attackName) {      # definition only
```

So attacks have no telegraph, hits no flinch, and death no performance — while the clips that would provide all three sit loaded and idle.

**Finding B — weak-point break state is invisible.** The gameplay contract (`wp.mesh`, `wp._mats`) still points at the hidden procedural geometry, and every state feedback loop iterates those procedural material arrays:

- `machines.js applyHit()` break block iterates `wp._mats` (`[glowMat, ...traversed]`) — procedural materials on hidden meshes.
- `machines.js updateMachine()` glow pulse iterates `a.glowMats` — also procedural.

Measured through the real `machine.hit()` path on an authored skitter:

```
before: { eye: [{ hex: 16740185 (0xFF6F59), i: 1 }], wpBroken: false, hp: 40 }
after:  { eye: [{ hex: 16740185 (0xFF6F59), i: 1 }], wpBroken: true  }
```

The weak point is marked broken and the rendered emissive is **byte-identical**. The player shatters a ×2.5-damage optic and the machine looks untouched. Because `wp.mesh` is a *hidden group* whose children are the procedural meshes, `wp.broken` becoming true also stops further weak-point damage — so the game correctly stops rewarding the shot while giving no feedback that it landed or mattered.

**Finding C — palette divergence.** The canonical weak-point colour is cyan `0x59e3ff` (`ARCHITECTURE.md` style guide, `machines.js glowMat()`, `ui/weakcue.js`, focus labels). The authored skitter marker renders `0xFF6F59` — a red-orange. Minor on its own, but it means the authored path silently diverges from the documented "cyan glow = weak point" language that the colour-blind cue and focus-scan labels are built around.

## Root cause

The authored-asset upgrade was implemented as a *visual swap* (`installAuthored` hides procedural meshes) but the *gameplay-driven animation contract* (`playAttack` / `playHitReact` / `playDeath`, and the weak-point rebinding) was never connected. The upgrade path is therefore only half-built: it can install a rig but cannot express the game's combat vocabulary through it.

## Intended architecture

Keep the existing two-mode design and the existing animator API — it is a reasonable seam. Close the four gaps:

Four gaps, in priority order:

1. **Drive attack/reaction/death from gameplay.** Each per-type attack entry in `ai.js` calls `m.animator.playAttack('<move>')` when it enters its anticipation phase; `machines.js applyHit` and `killMachine` call `playHitReact` / `playDeath`. This is the highest-impact fix because the clips already exist and load — only the call sites are missing, so it is a small, low-risk change that restores telegraph, flinch and death for three species.
2. **Bind weak points to the drawn rig.** When `installAuthored` succeeds and the authored root exposes `wp_*` markers, repoint the machine's weak-point entries at those nodes (keep hp/multiplier/name from `machines.js registerWeakPoint` so balance is unchanged), so break feedback and the hit volume act on the mesh the player sees.
3. **Route break/glow feedback to the bound material.** The char loop in `applyHit` and the pulse loop in `updateMachine` must operate on whatever material is actually attached to the (now rebound) weak point, not unconditionally on the procedural arrays. Without this, binding alone still leaves break feedback invisible.
4. **Align the authored palette or document the deviation** so the cyan weak-point language holds (or the deviation is deliberate and recorded).

## Control flow after the change

```text
spawnMachine() -> createMachine() -> attachMachineAnimator()
   |                                   |
   |                          (async) instantiate(manifest url)
   |                                   v
   |                          installAuthored()
   |                             |- rebind weak points to wp_* nodes
   |                             |- if no markers -> keep procedural (do not hide)
   |                             '- else hide procedural meshes, graft authored root
   v
frame: tickMachine(m) -> attack script -> m.animator.playAttack('lunge'|'dash'|...)
   |                     m._anim.crouch/rear/roar/lean (procedural channels, unchanged)
   v
frame: updateMachineAnimators(dt) -> advance graph, drain timeline events
applyHit() -> m.animator.playHitReact(strength) + m._anim.flinch (unchanged)
killMachine() -> m.animator.playDeath() + machineDied (unchanged)
```

## Data-flow / state changes

- `machine.weakPoints[i].mesh` may now reference an authored marker node instead of a procedural group. All existing readers (`projectiles.js`, `spear.js`, `focus.js`, `weakcue.js`, `bow.js computeAssistAdjust`) already go through `wp.mesh.getWorldPosition()` and `wp.broken`, so they are agnostic. **Constraint: a weak point node's world position must be meaningful while attached, and its `visible` state must be respected by the new guarantee.**
- No persistence, settings, or event-payload changes.

## Failure handling

- Asset load/decode failure: already handled — `attachMachineAnimator` catches and stays procedural.
- Authored rig with no `loc_*`/`act_*`/`react_*` clips: `createAnimGraph` returns a mixer-less graph; `installAuthored` currently returns `false` in that case, which is the correct behavior and must be preserved.
- Authored rig missing `wp_*` markers: fall back to procedural presentation (do not hide).
- Animator throw during a frame: already isolated in `updateMachineAnimators` per-machine try/catch; the new `playAttack`/`playHitReact`/`playDeath` call sites must be wrapped the same way so a broken rig cannot break the AI step.

## Alternatives considered

- **Un-hide procedural meshes alongside the authored rig.** Rejected: double geometry, double draw cost, and visual z-fighting on silhouettes; it also papers over the missing weak-point binding.
- **Remove authored machine assets from the manifest until art is production-ready.** Rejected: the pipeline certification is an explicit, tested deliverable (`asset-pipeline.spec.js`, `create-*-asset.mjs` provenance sidecars) and the fix belongs in the runtime, not in deleting the content.
- **Rewrite `ai.js` attack scripts to be clip-driven.** Rejected as too large a change; the synthesized `ATTACK_WINDOWS` table in `machineAnim.js` already encodes the AI timings, so a thin call from the existing script is sufficient and preserves the AI's damage authority.

## Rollout / compatibility

Incremental, no migration. Procedural machines (the other six species) keep their current behavior because the new call sites are no-ops in procedural mode. Roll out behind nothing — the change is required for correctness, not an experiment. Keep the existing E2E assertions passing (the upgrade to authored mode must still happen, per `asset-pipeline.spec.js`).

## Testing strategy

- Unit: `machine-animator.test.js` already covers `playAttack` metadata in procedural mode. Add cases asserting `installAuthored` refuses to hide the procedural body when the rig has no weak-point markers, and that weak points rebind to authored nodes when markers exist.
- New integration-style unit: a small harness that constructs a machine, forces it into a hit, and asserts `playHitReact` was called (call-counting wrapper, mirroring the runtime probe).
- E2E: extend `asset-pipeline.spec.js` with a **state-feedback** assertion — for each authored machine, break a weak point through the real `machine.hit()` path and assert the rendered marker actually changes (emissive/colour/visibility), plus a combat assertion that an authored machine's mixer leaves `loc_idle` and enters an attack state after aggro + close range. A bare "a visible weak-point mesh exists" assertion is NOT sufficient: it already passes today and would not have caught this defect.

## Risks

- Calling `playAttack` could double-animate a machine if a future authored clip also drives the same channels as the procedural pose. Mitigation: in authored mode the procedural channels are already inert (meshes hidden); in procedural mode `playAttack` plays nothing. Keep this single-source rule in code comments.
- Rebinding weak points to authored nodes changes hit geometry. Mitigation: preserve the procedural radius/hp/multiplier unless the manifest explicitly declares a radius; add an E2E assertion that a weak-point shot still registers on an authored machine.
