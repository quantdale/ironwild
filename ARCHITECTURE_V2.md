# IRONWILD — V2 Addendum (extends ARCHITECTURE.md)

V2 upgrade wave. All v1 contracts still hold. New/changed contracts below.
**Rule zero: do not regress verified v1 behavior.** Every file keeps its owner;
new files are listed with their single owner.

## New shared state (`G`, in core/state.js — already written)

- `G.settings` `{ master, music, sfx, sens, invertY, quality }` — persisted by ui/settings.js
  to localStorage key `ironwild-settings`; applied live on `'settingsChanged'`.
- `G.threat` 0..1 — written every frame by machines/ai.js (any aggro machine within 40u → →1).
- `G.weather` `{ type:'clear'|'rain'|'storm', intensity:0..1, wind:0..1 }` — written by world/weather.js.
- `G.mapRevealed` — set true once a Vantage is focus-scanned; minimap fog lifts.
- `G.quests` `{ slots:[null,null,null], completed }` — owned by systems/quests.js.
- `G.inventory.fireArrows` / `maxFireArrows`; `G.arrowType` `'standard'|'fire'` (KeyX toggle).

## New events (see core/events.js header)

`machineScanned {machine}` · `camShake {amp,time?}` · `settingsChanged {key,value}` ·
`questUpdate {quest}` · `gameSaved {manual}` · `killStreak {count}`

## New modules + ownership

| Owner | Files | Scope |
|---|---|---|
| world-v2 | `src/world/terrain.js`, `src/world/props.js`, `src/world/environment.js` | **Biomes** (meadow / dense forest NE / rocky highlands S / lakeshore reeds) via vertex-color paint + prop distribution; export `biomeAt(x,z)` from terrain.js. Shoreline sand band + animated foam ring at water edge. Tree/grass sway reads `G.weather.wind`. Sky reacts to weather (fog denser, light dimmer when raining). |
| weather | `src/world/weather.js` (NEW) | Exports `createWeather()`, `updateWeather(dt)`. Rain/storm cycle over ~6 min per phase; rain = instanced particle sheet following player + splash sfx via bus-driven audio; storm adds lightning: random directional-light intensity spike + white screen flash div + delayed thunder sfx (distance-based). Writes `G.weather`. Wind gusts modulate `G.weather.wind`. |
| player-v2 | `src/player/player.js`, `src/player/camera.js` | **Crouch/sneak**: KeyC toggles crouch (dodge is now ControlLeft ONLY). Crouched: speed ×0.5, footstep noise radius tiny, and if inside stealth grass (import `isConcealed(x,z)` from props.js) machine sight range ×0.35 unless already aggro. **Swim**: deep water (surface −1.2 below feet) → swim mode: Space rises, slow drift, stamina drain, no attacks. **Fall damage**: landing with vel.y < −18 → damage ∝ impact. Anim polish: strafe lean, landing recovery dip, left-arm raises toward aim pitch while drawing. **Camera**: control gate becomes `(Input.locked || Input.lockBroken)` so lock-denied browsers still play; apply `G.settings.sens` + `invertY`; consume `'camShake'` events as decaying positional offset. |
| combat-v2 | `src/player/bow.js`, `src/combat/projectiles.js`, `src/combat/damage.js`, `src/combat/status.js` (NEW) | **Fire arrows**: crafted (5 fire = 2 oil + 3 shards, cap maxFireArrows); KeyX toggles `G.arrowType` if fireArrows>0 (HUD shows type); fire arrow: impact dmg ×0.8 but applies **burn** via status.js: 12 dps × 4 s, refreshes, small orange tick numbers, machine panic (flee-briefly flag machines read). Arrow trail: fading line ribbon. Impact FX upgrades: oil-splatter decal sprite, sparks colored by part, `'camShake'` emit on weak hits. |
| machines-v2 | `src/machines/machines.js`, `src/machines/ai.js` | **3 new machines**: `duskwing` (aerial — circles 12u above, dive attack w/ ground-shadow telegraph + screech, grounded+stunned 2.5 s after diving or losing a wing), `bulwark` (armored roller — front cone deflects arrows w/ spark, must flank rear vents; roll charge telegraphed), `vantage` (peaceful tall scanner — walks fixed loop, never fights; focus-scanning it emits `machineScanned` → map reveal + 2 skill points once). **Part-behavioral effects**: skitter optic→no alert calls & erratic wander; rendclaw neckcord→lunge dmg halved; ironmaw core→charge disabled, speed −30%; bramblehorn fuelsac→flee speed −40%; bulwark vents→roll disabled; duskwing wing→forced grounding. **Alpha variants**: ~15% spawn (seeded rng), dark-red tint, +60% hp, +25% dmg, double loot, name prefix "Alpha". **Corpse harvest**: carcass persists 25 s; standing near shows prompt, holding E 1.2 s yields bonus shards/oil (progress ring drawn by machines module DOM-free via canvas sprite). **Threat**: ai writes `G.threat` each frame. |
| ui-v2a | `src/ui/hud.js`, `src/ui/focus.js` | HUD polish: hit-direction indicator arc around crosshair (from `'playerHit'` payload pos), kill banner ("RENDCLAW DOWN") on `'machineDied'`, low-hp desaturation overlay, subtle CSS vignette+grain. Focus v2: tags persist 8 s after release (faint outlines remain through walls while tagged); scanning a Vantage emits `machineScanned`. |
| ui-v2b | `src/ui/menus.js`, `src/ui/settings.js` (NEW) | Settings modal (gear button on start + pause screens): sliders for master/music/sfx volume, mouse sens, invert-Y checkbox, quality select (high/medium/low → pixelRatio 1.5/1.25/1 + shadow map 2048/1024/off via renderer read of G.settings.quality applied by main integrator). Persist localStorage `ironwild-settings`, load on boot, emit `'settingsChanged'`. Controls list updated (C = crouch, X = arrow type, P = quicksave). Continue button on start screen when `save.hasSave()` (import from systems/save.js); click → `save.loadGame()` then start. Inventory panel: fire-arrow section + craft row (5 fire = 2 oil + 3 shards). |
| systems-v2 | `src/systems/save.js`, `src/systems/quests.js` (NEW) | **save.js**: exports `initSave()`, `hasSave()`, `saveGame(manual=false)`, `loadGame()`, `clearSave()`. Serializes pos/hp/stamina/inventory/skills/timeOfDay/mapRevealed/quests into localStorage `ironwild-save`. Auto-save every 90 s + when pause opens; KeyP manual quicksave toast. Load restores fields; machines respawn fresh. Emits `'gameSaved'`. **quests.js**: exports `createQuests()`, `updateQuests(dt)`. Up to 3 active hunt-contracts generated deterministically (types: hunt N of machine-type · gather N resource · scan the Vantage). Listens `machineDied`/`pickup`/`machineScanned`; progress tracked per slot; completion → rewards (skillPoints/shards/medicine) + toast + `'questUpdate'`; auto-refill empty slots after 20 s. Self-contained tracker DOM block top-left under objective hint. |
| minimap | `src/ui/minimap.js` (NEW) | Exports `createMinimap()`, `updateMinimap(dt)`. Circular canvas top-right under resources: prebaked terrain swatch (heightAt grid sampled once to offscreen canvas, biome-tinted), north-up, player-centered arrow, machine dots (red aggro / grey calm), pickup dots, quest target markers. Before reveal: only 60 u radius visible (rest fogged); after `G.mapRevealed`: full map. |
| audio-v2 | `src/audio/audio.js` | Music: 3 layers (calm pad existing drone · explore pluck-seq layer · combat percussive layer) crossfaded by `G.threat`. Weather loops: rain noise bed + thunder booms (delay ∝ distance) driven by `G.weather`. Positional: machineStep/growl/death/alert route through PannerNode (equalpower) using opts.pos. Live volume application on `'settingsChanged'` (master/music/sfx gains). |
| integrator-v2 | `src/main.js` | LAST. Init order additions: `loadSettings()` right after renderer boot → createTerrain/Environment/**Weather**/Props/Player/CameraRig/Bow/DamageFX/**StatusFX**/populateWorld/**Quests**/**Save**/HUD/Menus/**Settings**/**Minimap**/Focus/Audio. Loop order: camera → player → bow → machines → projectiles → damageFX → **status** → props → **weather** → environment → focus → HUD(rawDt) → menus → **minimap** → **quests** → audio(rawDt) → **save.tick(rawDt)**. Apply `G.settings.quality` to renderer/shadow settings on `'settingsChanged'`. Adapt call names to ACTUAL exports; never edit other modules. |

## Cross-module API notes

- `props.isConcealed(x,z)` — true when (x,z) inside any stealth-grass patch radius (player-v2 consumes).
- `machines/ai.js` sets `G.threat` (0..1) every frame; audio-v2 + hud read it.
- `combat/status.js` exports `applyBurn(machine, seconds)` + `updateStatusFX(dt)`; projectiles calls applyBurn on fire hits; main calls updateStatusFX.
- `systems/save.js` API consumed by menus (Continue) only through its exports — no direct G surgery outside save.js.
- `weather.js` owns `G.weather`; terrain/props/environment READ it, never write.
- Camera shake contract: any module may `bus.emit('camShake',{amp:0..1})`; ONLY camera.js applies it.

## Performance rules (unchanged + additions)

- Rain particles: single Points cloud ≤ 900 pts recycled around player. Lightning flash: one fullscreen div opacity tween, no post-processing pass.
- Minimap redraws at 10 Hz max (dirty flag), not every frame.
- Status burn: per-machine scalar timer, no allocations.
- Quality 'low': shadows off, pixelRatio 1, grass sway batch halved.

## Definition of done (every agent)

1. Owned files fully implemented — no TODOs/stubs/placeholders; v1 behaviors preserved.
2. `node --check <file>` passes for each owned file.
3. Imports resolve exactly as documented; only three.js + core + documented cross-imports.
4. Report: files written, exact exports, contract assumptions.
