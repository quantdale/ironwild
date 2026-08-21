# IRONWILD — Architecture Contract

An original open-world "machine hunting" action prototype in the spirit of post-wilderness
robo-fauna games. Browser game built with **Three.js 0.166** + **Vite 5**, all assets procedural
(no external files, no network fetches at runtime). Everything is original: names, designs, story.

Run: `npm run dev` (dev server) / `npm run build` (production). Entry: `index.html` → `src/main.js`.

## File ownership (each file has exactly ONE owner; never edit others' files)

| Owner | Files |
|---|---|
| core (pre-written, do not modify) | `src/core/events.js`, `src/core/state.js`, `src/core/input.js`, `src/core/utils.js` |
| world-terrain | `src/world/terrain.js`, `src/world/environment.js` |
| world-props | `src/world/props.js` |
| player-body | `src/player/player.js` |
| player-camera-bow | `src/player/camera.js`, `src/player/bow.js` |
| combat | `src/combat/projectiles.js`, `src/combat/damage.js` |
| machines | `src/machines/machines.js`, `src/machines/ai.js` |
| ui | `src/ui/hud.js`, `src/ui/menus.js`, `src/ui/focus.js` |
| audio | `src/audio/audio.js` |
| integrator | `src/main.js` |

## Shared modules (already written — import, don't re-implement)

```js
import { bus } from '../core/events.js';   // .on(type,fn) .off(type,fn) .emit(type,payload)
import { G, CONFIG } from '../core/state.js';
import { Input } from '../core/input.js';  // .down(code) .pressed(code) .consumeMouse() .consumeWheel() .lockPointer(el) .unlockPointer() .locked .onLockChange(fn)
import { clamp, lerp, smoothstep, damp, makeRng, randRange, hash2, valueNoise2, fbm2 } from '../core/utils.js';
```

Event types (see `events.js` header comment for payload shapes): `noise, arrowFired, machineHit,
partBroken, machineDied, playerHit, playerHealed, playerDied, pickup, notify, prompt, hitMarker,
ui, craft, skillUp`.

## Global state (`G`) — key fields

- `G.scene, G.camera, G.renderer` — set by main.js before any system init.
- `G.timeScale` — focus scan sets `CONFIG.focusTimeScale`; **all gameplay updates must use
  `dt * G.timeScale`** (UI animations may use raw dt).
- `G.elapsed` — scaled gameplay time accumulator.
- `G.paused` — true while menus open or pointer unlocked; systems should skip gameplay updates.
- `G.started` / `G.gameOver`.
- `G.cam` — refreshed each frame by camera.js BEFORE player update:
  `{ yaw, pitch, forward, right, aimOrigin, aimDir, aiming }`.
- `G.player` — see contract in `state.js`. Feet-position `pos`; hp/stamina; `takeDamage(amount, fromPos?)`,
  `heal(amount)`; flags `grounded, dodging, sprinting, aiming, drawing, dead`.
- `G.machines[]` — machine objects (contract in `state.js`): `{ group, type, name, hp, maxHp,
  alive, aggro, weakPoints:[{name, mesh, localPos, radius, multiplier, hp, broken}],
  bodySpheres:[{localPos, radius}], hit(damage, point, weakPoint|null), update(dt), dispose() }`.
  Weak-point meshes must be actual children of `group` so world position is derivable.
- `G.arrows[]`, `G.pickups[]` (`{ type:'wood'|'shards'|'medicine', mesh, pos, taken }`).
- `G.inventory` `{ shards, wood, oil, medicine, arrows, maxArrows, skillPoints }`, `G.skills`.

## Terrain contract

`src/world/terrain.js` exports:
- `terrainHeight(x, z)` — pure deterministic function (uses `fbm2`/`hash2`). MUST be the single
  source of truth; geometry vertices are generated from it.
- `heightAt(x, z)` — alias of `terrainHeight`.
- `normalAt(x, z)` — finite-difference normal.
- `createTerrain()` — builds and adds ground mesh + water plane to `G.scene`; returns `{ groundMesh, waterMesh }`.
- Water level is `CONFIG.waterLevel`. A basin lake region must exist near `(0, -60)` area.
- Ring of mountains beyond `CONFIG.playRadius` (raise heights smoothly past it) acts as natural border.

## Frame update order (main.js calls these in this exact order)

```
Input.beginFrame()                        // no-op; kept for symmetry
if (!G.paused && G.started && !G.gameOver):
  dt = clock.getDelta() * G.timeScale   (clamp raw dt to 0.05 first)
  updateCamera(dt)        // src/player/camera.js — writes G.cam
  player.update(dt)       // movement, gravity via heightAt, KeyH medicine
  bow.update(dt)          // draw/release → spawnArrow(...) (crosshair-converged)
  updateMachines(dt)      // machines/ai.js — iterates G.machines
  updateProjectiles(dt)   // combat/projectiles.js
  updateDamageFX(dt)      // combat/damage.js — pooled hit FX
  updateProps(dt)         // world/props.js — pickup proximity/prompts
  updateEnvironment(dt)   // world/environment.js — day/night (may use unscaled dt*0.2 blend)
else:
  still call updateCamera(dt) with dt=0-safe path OR render-only mode
updateHUD(dt); updateFocus(dt); updateMenus(); audio auto via bus
Input.endFrame()                          // clears one-shot pressed() keys AFTER all systems polled
```

NOTE: keydown events arrive between frames, so `Input.pressed()` state must only be
cleared at END of frame (`Input.endFrame()`), never at the start.

## Debug hook

`main.js` exposes `window.__IW = { G, Input, bus }` for console inspection and
automated testing.

## Cross-module API expectations

- `player/bow.js` imports `spawnArrow` from `../combat/projectiles.js`:
  `spawnArrow({ origin:Vector3, dir:Vector3, speed:number, damage:number })`.
- `combat/projectiles.js` collision-tests arrows against every machine in `G.machines`:
  weak points first (sphere at weakPoint world pos, radius), then body spheres. On hit it calls
  `machine.hit(damage * wp.multiplier, point, wp)` (or `machine.hit(damage, point, null)`),
  emits `machineHit` + `hitMarker`, and removes/sticks the arrow.
- `machines/ai.js` exports `updateMachines(dt)` and `spawnMachine(type, x, z)`; `machines.js`
  exports `createMachine(type, x, z)` building meshes + weakPoints. AI handles perception
  (distance < sightRange && within FOV cone, or `noise` events), FSM
  `dormant→patrol→suspicious→attack→(flee|dead)`, melee/ranged attacks calling
  `G.player.takeDamage(...)`, death FX + loot drops (adds to `G.pickups` via props helper or plain
  pickup objects) and emits `machineDied`.
- `world/props.js` exports `createProps()` and `updateProps(dt)`; places trees/rocks/ruins/stealth-grass
  (instanced), plus resource pickups registered into `G.pickups` with interaction prompts via `bus.emit('prompt', ...)`
  when player is near and `<KeyE>` pressed → collect (respect `G.skills.scavenger` doubling),
  emit `pickup` + `notify`. Pickup types: `'wood' | 'shards' | 'medicine' | 'oil'`.
  Also exports `spawnPickup(type, pos)` for machine loot drops — accepts both call shapes:
  `spawnPickup(type, {x, z})` and `spawnPickup(type, x, y, z)`; snaps to terrain.
- `ui/focus.js`: hold `KeyQ` to scan if focus meter available: sets `G.timeScale = CONFIG.focusTimeScale`,
  adds depthTest=false wireframe outline clones over machines + floating weak-point labels (canvas sprites),
  drains focus meter; release restores `timeScale=1`. Exposes `getFocusFraction()` for HUD.
- `ui/hud.js`: DOM overlay (absolutely positioned divs over canvas): health, stamina, focus bar,
  ammo count, compass strip (from `G.cam.yaw`), crosshair (changes while `G.cam.aiming`),
  hit markers, toast notifications (`notify`), interaction prompt (`prompt`), resource counters.
- `ui/menus.js`: start screen (click → `G.started=true`, pointer lock), pause on Esc/unlock,
  inventory+crafting panel (`KeyI`), skill tree (`Tab`), death screen (`playerDied` → restart button
  reloads page). While any panel open: `G.paused=true`, pointer unlocked. Crafting recipes:
  arrows ×5 = 1 wood + 2 shards; medicine = 2 oil + 1 wood. Skill spend costs 1 point each.
- `player/player.js`: also owns the `KeyH` medicine consumable (+45 HP, consumes
  `G.inventory.medicine`, only when hurt and alive).
- `audio/audio.js`: WebAudio synthesized SFX (no asset files): bow draw/stretch, release twang,
  arrow impact flesh/metal variants, machine footsteps/growls (bus-driven), UI clicks, ambient wind +
  drone pad loop, day/night ambience shift. Unlock AudioContext on first user gesture. Listen to bus events;
  also export `sfx(name)` for direct calls.

## Machine roster (original designs, primitive-built, flat-shaded)

| type | name | behavior |
|---|---|---|
| `skitter` | Skitter | small fast quadruped scout; patrol; alerts others; leap melee |
| `bramblehorn` | Bramblehorn | deer-like grazer; flees when attacked; may kick; drops oil+shards |
| `rendclaw` | Rendclaw | raptor predator; aggressive chase + claw combo |
| `ironmaw` | Ironmaw | heavy bruiser mini-boss; slow charge attack, spark ranged bolt |

Each machine: 1–3 glowing weak points (emissive material, e.g. eye / power cell on back / belly fuel sac).
Weak point hp ~ 40–90; breaking it (`partBroken`) detaches/darkens part, staggers machine, extra damage event.
Body hp: skitter 60, bramblehorn 80, rendclaw 140, ironmaw 320.

## Visual style guide

Low-poly stylized nature, flat shading (`flatShading: true`), warm palette:
sky day `#87b5d9` → dusk `#e8956b`; fog `#c4d3de` day / `#2a3548` night; grass `#6a8f4f`/`#8aa85c`;
rock `#7d7f82`; water `#3d6f7d` (transparent 0.75); wood `#6b4a2f`; machines dark gunmetal `#3a3f46`
with rust `#8a4b32` accents and cyan glow `#59e3ff` weak points. Sun directional light w/ shadows
(2048 map, camera box ~120), hemisphere light. Fog always on. Pixel ratio capped at 1.5.

## Performance rules

- InstancedMesh for vegetation/rocks/grass. Total machines ≤ CONFIG.maxMachines.
- No per-frame allocations in hot loops (reuse temp Vector3s declared at module scope).
- Shadow casters limited: machines + player + trees only; grass/rocks don't cast.
- Geometry segment counts modest (terrain 128×128 max, primitives ≤ 24 segments).

## Definition of done (every agent)

1. All owned files implemented fully — no TODOs, no stubs, no placeholder returns.
2. `node --check src/<file>.js` passes for each owned file (package.json is `"type":"module"`).
3. Imports resolve to exactly the paths above; only three.js + own core imports used.
4. Code comments in English, concise; match existing core-file style.
