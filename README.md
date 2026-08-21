# IRONWILD

An original open-world machine-hunting action prototype for the browser, built with
**Three.js 0.166** and **Vite 5**. All assets are procedural — no downloads, no external
files. Every name, design, and line of code is original.

![start](screenshots/ironwild-start.png)

## Run it

```bash
npm install       # once
npm run dev       # development server (http://localhost:5173)
npm run build     # production build to dist/
npm run preview   # serve the production build (http://localhost:4173)
```

Click the start screen to begin — the game grabs pointer lock for mouse-look.
Best played in Chrome/Edge/Firefox on desktop.

## How to play

You are a hunter in a valley reclaimed by wilderness and patrolled by animal-like
machines. Hunt them, break their glowing weak points, harvest resources, craft, and
grow your skills. Death is permanent per run — restart and try again.

| Input | Action |
|---|---|
| `W A S D` | Move |
| Mouse | Look |
| Hold LMB | Draw bow / release to loose |
| RMB (hold) | Aim (over-shoulder zoom) |
| Shift | Sprint |
| Space | Jump / swim up |
| Ctrl | Dodge roll (i-frames, costs stamina) |
| C | Crouch / sneak (concealed in tall grass) |
| F | Spear quick-melee (short-range swing, no ammo cost) |
| X | Toggle standard / fire arrows |
| E | Collect · interact · harvest (hold) |
| Q (hold) | Focus scan — slow motion, reveals machines & weak points through terrain |
| H | Use medicine (+45 HP) |
| I | Inventory & crafting |
| Tab | Skill tree |
| B | Bestiary |
| P | Quicksave |
| Esc | Pause |

### Machines

| Machine | Behavior | Weak points |
|---|---|---|
| **Skitter** | Fast quadruped scout; circles and leaps; alerts others | Optic ×2.5 |
| **Bramblehorn** | Deer-like grazer; flees, kicks if cornered; drops oil | Fuel sac ×2, back cell ×2 |
| **Rendclaw** | Raptor predator; chases and claws | Neck cable ×2.2 |
| **Ironmaw** | Heavy bruiser; telegraphed charge + spark bolts | Power core ×1.8 |
| **Duskwing** | Aerial dive-bomber; vulnerable while grounded | Wing membranes ×1.8 |
| **Bulwark** | Armored roller; front plate deflects arrows — flank it | Rear vents ×2.0 |
| **Vantage** | Peaceful tall scanner; focus-scan it to reveal the map (+2 skill points) | Uplink dish |
| **Mirefang** | Lake ambusher; lurks submerged (nostril tell) and lunges at swimmers | Eye ×2.2, belly seam ×1.6 |
| **the Monarch** | Colossal world-boss on a fixed far patrol loop; telegraphed AOE stomp + tail swipe, enrages every 25% hp lost | Chest furnace ×1.5, knee pistons ×1.8 |

Weak points take multiplied damage and **break** when depleted, staggering the machine
and changing behavior (blind scouts, crippled charges, grounded wings). ~15% of spawns
are **Alpha** variants: dark-red, tougher, harder-hitting, double loot. Downed machines
leave harvestable carcasses (hold E).

**Fire arrows** (craftable from oil) ignite machines — damage over time plus panic.
Arrows fly on a real ballistic arc — lead your targets and aim above for distance.

### World & progression

- **Biomes**: meadow, dense forest (NE), rocky highlands (S), lakeshore reeds.
- **Weather**: clear → breeze → rain → storms with lightning and thunder.
- **Contracts**: three rotating hunt/gather/scan contracts with rewards.
- **Day/night** (~8 min cycle), swim, crouch-stealth in tall grass, fall damage.
- **Crafting**: 5 arrows = 1 wood + 2 shards · fire arrows ×5 = 2 oil + 3 shards · medicine = 2 oil + 1 wood.
  Carcass harvest yields wood alongside shards/oil, so the economy has no hard ceiling.
- **Skills**: Heartier Frame, Steady Aim, Hunter-Killer, Scavenger, Second Wind, Deep Focus.
- **XP & levels**: kills, pickups, and scans grant XP; leveling up grants a skill point and a
  fanfare. A slim violet bar above the health meter tracks progress.
- **Contextual tips**: one-time on-screen hints teach focus-scan, medicine, stealth, fire
  arrows, storms, and contracts the first time each becomes relevant.
- **Bestiary** (key B): every species starts as "???"; scanning or fighting one reveals its
  name, killing it unlocks a one-line lore entry. Tracked and persisted independently of quests.
- **Hide armor**: carcass harvest also yields hide; spend it (+shards) in the inventory panel
  on two armor ranks that cut incoming damage 12%/22%.
- **Difficulty**: a Hardened mode (settings) scales every machine's outgoing damage and HP
  up at spawn — compounds with the Alpha variant roll for a harder run.
- **Accessibility**: a colorblind-safe weak-point cue (settings) draws a small pulsing
  white-on-black reticle over every unbroken weak point in range, all the time — not just
  during a focus scan, and independent of the glow color.
- **Save system**: autosave + P quicksave; Continue from the title screen. XP/level and the
  bestiary persist too; saves from earlier versions still load (missing fields default fresh).
- **Settings**: volume sliders, mouse sensitivity, invert-Y, quality preset, difficulty,
  colorblind cue (all persisted).
- **Minimap** with fog-of-war until you scan a Vantage.

### Rendering

A full post-processing pipeline (three.js `EffectComposer`) sits between the scene and the
screen: **GTAO** contact shadows (high quality only), **UnrealBloom** so every glowing weak
point/fire/lightning/sun-glow genuinely blooms instead of being a flat-shaded dot, a
screen-space **volumetric light shaft** pass (high quality only, see V6 below), **SMAA**
anti-aliasing, and a cinematic contrast/saturation/vignette/grain/chromatic-aberration grade,
finished by an `OutputPass` that applies the renderer's ACES filmic tone mapping exactly once.
The water plane gets a fresnel rim term (brighter at grazing angles) that samples the *live*
sky gradient and a sun glint, on top of its existing wave displacement and shoreline fade. All
of it is quality-scaled: `low` disables bloom/grain/aberration entirely, `medium` adds a
cheaper half-resolution bloom and reduced grain/aberration, `high` adds SMAA, GTAO and god
rays — the priciest passes.

V6 — a further fidelity pass aimed at a more cinematic, "AAA" look, added on top of V5's
pipeline: a screen-space **volumetric light shaft** pass (the classic radial-sample "god ray"
technique, aimed at the sun's live screen-space position every frame) so low sun angles
streak visibly through tree canopies and ruins instead of just brightening the sky; an
atmospheric **horizon haze** band in the sky dome shader (the horizon reads brighter/whiter
than a flat two-stop gradient, matching how real atmosphere scatters more light at grazing
elevation); a **sky-reflective water fresnel** that samples the live top/horizon sky colours
and adds a sun glint along the reflected view ray, so the lake tracks day/night/dusk/storm
without a second scene render; and a cinematic grade upgrade (animated film grain, edge
chromatic aberration) layered into the existing contrast/vignette pass. Verified live at each
step, including a real regression caught and fixed: an initial `THREE.Reflector`-based dynamic
water reflection was scrapped after it produced a double-tonemapped colour-wash artifact and
measured as the single most expensive pass in the pipeline (a second full-scene render) for a
marginal gain over the cheaper sky-fresnel approach that replaced it. The god-ray pass itself
had a real bug caught via a camera-angle sweep: projecting the sun far outside the visible
frame made the radial sampler clamp to a single edge pixel and wash the whole screen in that
pixel's colour (visible as a solid green cast) — fixed with an edge-distance fade before the
pass ships any shaft. FPS was sampled per quality tier on the same machine before and after:
`high` (now with god rays + the cinematic grade on top of V5's GTAO/SMAA/bloom) costs modestly
more than V5's `high`, while `medium`/`low` are unchanged since the new passes are gated off
below `high`.

## Project layout

```
index.html            entry page
src/main.js           boot + frame loop (system init order lives here)
src/core/             event bus, global state, input, math utils (shared foundation)
src/world/            terrain + biomes, sky/day-night, weather, props & pickups
src/player/           third-person controller (crouch/swim), camera rig, bow
src/combat/           arrow projectiles, status effects, hit FX
src/machines/         9 machine bodies (procedural) + AI state machine
src/systems/          save/load, hunt contracts, XP/leveling, bestiary
src/ui/               HUD, menus/settings, focus-scan overlay, minimap, colorblind cue
src/audio/            fully synthesized WebAudio SFX + adaptive music + ambience
ARCHITECTURE.md       v1 module contracts
ARCHITECTURE_V2.md    v2 upgrade contracts
ARCHITECTURE_V3.md    v3 upgrade contracts
docs/BALANCE.md       constants audit + applied balance fixes
screenshots/          captured during automated verification
```

## Verification

The game was verified end-to-end in a headless browser: boot, movement, mouse-look,
day/night cycle, bow ballistics (body + weak-point hits with correct multipliers),
part breaking, machine AI aggression and melee kills, player death/restart flow,
loot drops and collection, crafting, skill purchase, medicine use, dodge i-frames,
focus scan slow-motion, HUD bindings, and a clean production build.

V3 additions (spear melee, XP/leveling, Mirefang/Monarch, contextual tips, ACES tone
mapping) were integrated into the boot/frame-loop wiring in `src/main.js`, then verified
live: clean console on boot, spear swing animation channel firing on `F`, XP granting and
persisting through `G.xp`, and the XP bar/tips DOM elements present and rendering. A
follow-up balance audit (`docs/BALANCE.md`) flagged and fixed several correctness issues,
most notably that the Monarch boss fight was arithmetically unwinnable on a standard
(non-fire) arrow build — the quiver cap has been raised to close that gap.

V4 additions (bestiary, hide armor, difficulty modes, colorblind weak-point cue, a
three.js/app bundle split) were each verified live: a legacy (pre-v4) save loads cleanly
with new fields defaulting instead of erroring; a corrupted save falls back to a fresh
start instead of crashing; a real arrow/melee kill flows through to XP gain and a bestiary
unlock (not just a simulated bus event); armor upgrades deduct the correct hide/shard cost
and measurably reduce damage taken (verified 0%/12%/22% at each rank); Hardened difficulty's
damage/HP multiplier compounds correctly with the Alpha variant roll; and the colorblind
reticle appears over weak points and disappears when toggled off. The audit also caught and
fixed a real exploit: focus-scanning *any* machine (not just a Vantage) was granting the
map-reveal + 2 skill point reward meant to be Vantage-only.

V5 — a rendering pass toward higher visual fidelity — added the `EffectComposer` pipeline
(GTAO, bloom, SMAA, filmic grade/vignette) and the water fresnel term described above.
Verified live at each step: clean console boot with the full pipeline active; bloom
confirmed (via screenshot, day and night) to make weak points read as genuine glowing
beacons instead of flat-shaded dots; a real regression caught with a same-scene before/after
comparison — full-strength GTAO was blacking out thin distant silhouettes (duskwings in
flight) — and fixed by halving `blendIntensity`, re-verified to remove the artifact while
keeping a subtle, correct contact shadow near the player; and quality-tier scaling measured
directly (FPS sampled over 2s per tier) to confirm `low`/`medium` meaningfully cut render
cost rather than just changing a label.
#   i r o n w i l d  
 