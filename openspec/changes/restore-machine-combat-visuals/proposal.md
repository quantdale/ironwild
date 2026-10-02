## Why

Six of the world's seventeen machines (skitter, ironmaw, duskwing) now boot into the authored-asset path, where an animated rig *replaces* the procedural body — but the gameplay systems that drive attack telegraphs, hit reactions, death performance and weak-point **state** were never rewired to that path. Measured at runtime, two distinct defects result.

First, **the authored rig's own clips never play.** The skitter GLB ships `act_skitter_lunge`, `react_hit` and `react_death` clips; the AnimGraph loads and indexes them (they appear in `graph.clips.actions` / `.reactions`), yet sampling every running action during live combat shows only `loc_idle` ever playing. The animator's `playAttack` / `playHitReact` / `playDeath` API records **0 calls** across forced combat, because `machines/ai.js` and `machines/machines.js` never invoke it. The result: for three of nine species, attacks have no telegraph, damage has no flinch, and death has no performance.

Second, **weak-point state is invisible even though the weak point is not.** The authored rigs do render a visible emissive marker (the skitter's `eye_band`), so the earlier claim that weak points are wholly invisible was measured only against the hidden procedural group and is **not** accurate. The real defect is narrower and different: the gameplay weak-point contract still points at the *hidden* procedural geometry, while the authored marker is a separate, unbound object. Consequently the break feedback does nothing visible — breaking the skitter optic sets `wp.broken = true` and the authored `eye_band` emissive is **byte-identical before and after** (measured `0xFF6F59`, intensity 1.0), because the char/break loop (`machines.js applyHit`) and the glow-pulse loop both iterate the *procedural* material arrays (`wp._mats`, `_anim.glowMats`). A player shatters a weak point and the machine looks completely unchanged.

## What Changes

- **Drive attack, hit-reaction, and death performance from gameplay.** The animation layer's attack/reaction/death entry points must be invoked by the machine AI and damage code, so telegraphs, flinch, and death play for authored rigs exactly as they do for procedural ones. A missing clip must degrade to the procedural pose rather than to nothing.
- **Make weak-point *state* observable on authored rigs.** Breaking a weak point must produce a visible change on whatever mesh is actually being drawn, and the unbroken/weak glow must be readable. A broken weak point that still looks intact is a correctness defect, not a polish issue.
- **Bind authored weak-point nodes to the gameplay weak-point contract.** The `wp_*` nodes an authored asset already carries must drive hit detection (and break feedback) rather than leaving hidden procedural geometry as the sole hit volume, so gameplay state and rendered state cannot diverge.
- **Record the authored palette deviation instead of recoloring assets.** Procedural weak points use cyan `0x59e3ff`. The current skitter marker uses `0xFF6F59`. This change does not repaint authored assets. It records that deviation in the manifest or animator header, and it keeps the colorblind cue as the non-color identification path.
- **Keep a readable telegraph when the authored kit has no attack clip.** Skitter's manifest includes `act_skitter_lunge`. Ironmaw and duskwing currently ship locomotion plus `react_hit` / `react_death`, not attack clips. Hiding the procedural body must not leave those attacks with no visible anticipation.
- **Define the fallback contract:** the procedural body may be retired only when the authored rig can carry every gameplay-critical visual *and state*; otherwise the machine must stay (or return to) procedural.
- **Add regression coverage** proving weak-point state changes are visible, that combat triggers the animation layer for authored machines, and that authored clips actually reach a running state.

## Capabilities

### New Capabilities
- `machine-presentation`: The observable contract that every machine, regardless of whether it is procedural or asset-authored, presents visible weak points and plays attack, hit-reaction, and death performance tied to gameplay state.

### Modified Capabilities
<!-- None: first specification of this behavior; openspec/specs/ is currently empty. -->

## Impact

- Affected code: `src/anim/machineAnim.js` (`installAuthored`, the `playAttack` / `playHitReact` / `playDeath` / `playLocomotion` animator surface), `src/machines/ai.js` (per-type attack scripts: skitter/rendclaw/ironmaw/duskwing/bulwark/mirefang/monarch, `damagePlayer`, hit handling), `src/machines/machines.js` (`createMachine`, `registerWeakPoint`, `applyHit`, `killMachine`), and the authored assets in `public/assets/machines/` + their `wp_*` nodes in `src/assets/manifest.js`.
- Touches the frame-loop ordering in `src/main.js` (machines tick → animators tick) and the animator lifecycle handling in `updateMachines` (dispose on death).
- Observable effects: authored machines gain attack telegraphs, flinch and death beats, and their weak points become bound to the rig that is actually drawn, with break state that is visible.
- No public persistence or settings formats change. Existing procedural machines are unaffected.
