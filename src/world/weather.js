// IRONWILD - weather system: deterministic clear->breeze->rain->storm cycle,
// recycled rain particle sheet following the player, storm lightning (screen
// flash + dedicated flash light) and smooth wind gusts. Owns G.weather
// ({type,intensity,wind,gust} + strike log for audio-v2 thunder); terrain/
// props/environment only READ it. Rain/thunder SFX live in audio/audio.js -
// this module emits no sound events.

import * as THREE from 'three';
import { G, CONFIG } from '../core/state.js';
import { bus } from '../core/events.js';
import { clamp, lerp, smoothstep, damp, makeRng, randRange, valueNoise2, fbm2 } from '../core/utils.js';
import { heightAt } from './terrain.js';

// --- tuning -----------------------------------------------------------------

const LOOP_LEN = 360;        // seconds for one full weather loop (~6 min)
const MAX_RAIN = 900;        // hard cap from ARCHITECTURE_V2 performance rules
const RAIN_RADIUS = 26;      // horizontal half-extent of the sheet around player
const RAIN_ABOVE = 18;       // spawn height band above local ground
const FALL_MIN = 17, FALL_MAX = 25;   // per-drop fall speed range (u/s)
const WIND_DRIFT = 9;        // max lateral drift at wind = 1 (u/s)

// Deterministic phase table. 'breeze' keeps type 'clear' (contract types are
// clear|rain|storm only) - it just raises wind so grass/trees sway.
const PHASES = [
  { name: 'clear',    dur: 90, type: 'clear', intensity: 0, wind: 0.18 },
  { name: 'breeze',   dur: 60, type: 'clear', intensity: 0, wind: 0.50 },
  { name: 'rain',     dur: 110, type: 'rain', intensity: 1, wind: 0.55 },
  { name: 'storm',    dur: 70, type: 'storm', intensity: 1, wind: 0.88 },
  { name: 'clearing', dur: 30, type: 'rain', intensity: 0, wind: 0.35 },
];
let phaseStarts = null; // cumulative phase start times, filled in createWeather

const COL_RAIN = new THREE.Color(0xaebfd4); // pale grey-blue, matches fog day

// --- module state -----------------------------------------------------------

let inited = false;
let points = null;           // the single recycled THREE.Points cloud
let geometry = null;
let material = null;
let speeds = null;           // per-drop fall speed
let floors = null;           // per-drop kill height (terrain/water at spawn)
let activeCount = 0;

// NOTE: environment.js absolutely re-writes sun/moon/hemi intensities every
// frame AFTER weather updates, so bumping the scene sun here would be clobbered
// before render. The visible lightning spike therefore comes from our own white
// flash light, aimed from the bolt's own bearing.

let flashDiv = null;         // fullscreen white lightning flash
let flashStyle = null;       // injected <style>
let flashLevel = 0;          // 0..1 current screen flash amount
let flashLight = null;       // our own white directional light (see NOTE above)

let clockT = 0;              // position in the weather loop [0, LOOP_LEN)
let gustT = 0;               // unbounded gust-field time (clockT wraps; the noise must not)
let nextStrikeIn = 0;        // countdown to next lightning bolt (storm only)
const rng = makeRng(CONFIG.seed ^ 0x57eaf00d);

// Scratch - reused every frame, no hot-loop allocations.
const _p = new THREE.Vector3();   // player/camera anchor this frame
const _windDir = new THREE.Vector3(0.78, 0, 0.63).normalize();

/** Builds the rain cloud, flash overlay and flash light. Safe to call once. */
export function createWeather() {
  if (!G.scene || inited) return;

  // Deterministic schedule: start early in the opening clear spell and seed
  // the contract fields so frame 0 is a calm, sunny day.
  clockT = LOOP_LEN * 0.05;
  G.weather.type = 'clear';
  G.weather.intensity = 0;
  G.weather.wind = 0.3;
  G.weather.lastStrikeAt = -999; // no strikes yet (audio-v2 reads this)
  G.weather.lastStrikeDist = 0;
  G.weather.gust = 0;          // live gust strength 0..1 (audio-v2 wind bed)

  // Cumulative phase start times.
  phaseStarts = [];
  let acc = 0;
  for (const ph of PHASES) { phaseStarts.push(acc); acc += ph.dur; }

  // --- rain points cloud ----------------------------------------------------
  const positions = new Float32Array(MAX_RAIN * 3);
  const seeds = new Float32Array(MAX_RAIN);
  speeds = new Float32Array(MAX_RAIN);
  floors = new Float32Array(MAX_RAIN);
  // Park all drops far below the world until intensity activates them.
  for (let i = 0; i < MAX_RAIN; i++) {
    positions[i * 3 + 1] = -1000;
    seeds[i] = rng();
    speeds[i] = lerp(FALL_MIN, FALL_MAX, rng());
    floors[i] = -1000;
  }
  geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setDrawRange(0, 0);

  // Streak-ish sprites: tall thin sliver shaded inside a point sprite.
  material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: COL_RAIN },
      uOpacity: { value: 0 },
    },
    vertexShader: /* glsl */`
      attribute float aSeed;
      varying float vFade;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = max(-mv.z, 0.001);
        gl_PointSize = clamp((150.0 + aSeed * 90.0) / d, 2.0, 26.0);
        vFade = smoothstep(75.0, 34.0, d); // fade out with distance
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vFade;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float streak = max(0.0, 1.0 - abs(p.x) * 4.0) * max(0.0, 1.0 - p.y * p.y);
        float a = streak * vFade * uOpacity;
        if (a < 0.012) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
  });
  points = new THREE.Points(geometry, material);
  points.frustumCulled = false; // rides with the player; bounds would go stale
  points.visible = false;
  G.scene.add(points);

  // --- lightning flash light + screen flash ---------------------------------
  flashLight = new THREE.DirectionalLight(0xeaf2ff, 0);
  G.scene.add(flashLight, flashLight.target);

  flashStyle = document.createElement('style');
  flashStyle.textContent =
    '#iw-lightning{position:fixed;inset:0;background:#fff;opacity:0;' +
    'pointer-events:none;z-index:15;}'; // under HUD(20)/menus(30): world washes, UI stays readable
  document.head.appendChild(flashStyle);
  flashDiv = document.createElement('div');
  flashDiv.id = 'iw-lightning';
  document.body.appendChild(flashDiv);

  inited = true;
}

/** Release scene/DOM resources (debug / teardown). */
export function disposeWeather() {
  if (!inited) return;
  if (points) { G.scene.remove(points); points = null; }
  if (geometry) { geometry.dispose(); geometry = null; }
  if (material) { material.dispose(); material = null; }
  if (flashLight) { G.scene.remove(flashLight, flashLight.target); flashLight = null; }
  if (flashDiv) { flashDiv.remove(); flashDiv = null; }
  if (flashStyle) { flashStyle.remove(); flashStyle = null; }
  inited = false;
}

/** Respawn drop i inside the disc around the anchor at a fresh height band. */
function respawnDrop(i, positions) {
  const ang = rng() * Math.PI * 2;
  const rad = Math.sqrt(rng()) * RAIN_RADIUS;
  const x = _p.x + Math.cos(ang) * rad;
  const z = _p.z + Math.sin(ang) * rad;
  const ground = Math.max(heightAt(x, z), CONFIG.waterLevel);
  floors[i] = ground;
  positions[i * 3] = x;
  positions[i * 3 + 1] = ground + RAIN_ABOVE + rng() * 10;
  positions[i * 3 + 2] = z;
}

/** Fire one lightning bolt near the player. */
function strike() {
  const ang = rng() * Math.PI * 2;
  const dist = randRange(rng, 60, 240);
  const sx = _p.x + Math.cos(ang) * dist;
  const sz = _p.z + Math.sin(ang) * dist;

  // Screen flash: peak now, exponential ~120 ms fade handled in update.
  flashLevel = randRange(rng, 0.5, 0.85);

  // Flash light shines from the bolt's bearing down onto the player.
  const gy = Math.max(heightAt(sx, sz), CONFIG.waterLevel);
  flashLight.position.set(sx, gy + 130, sz);
  flashLight.target.position.copy(_p);
  flashLight.target.updateMatrixWorld();
  flashLight.intensity = randRange(rng, 5, 9);

  // Log for audio-v2: delayed distance-based thunder reads these.
  G.weather.lastStrikeAt = G.elapsed;
  G.weather.lastStrikeDist = dist;

  // Near misses shake the camera a little (camera.js owns the offset).
  if (dist < 110) bus.emit('camShake', { amp: 0.32 * (1 - dist / 110) });
}

/** Advance the weather cycle, rain simulation and lightning. */
export function updateWeather(dt) {
  if (!inited || !G.scene) return;
  dt = clamp(dt, 0, 0.1);

  // --- phase scheduling (deterministic) -------------------------------------
  clockT = (clockT + dt) % LOOP_LEN;
  let pi = PHASES.length - 1;
  for (let i = 0; i < PHASES.length; i++) {
    if (clockT >= phaseStarts[i]) pi = i;
  }
  const phase = PHASES[pi];
  const t = (clockT - phaseStarts[pi]) / phase.dur; // 0..1 within phase

  // Intensity envelope per phase: ramp in during rain, fade out while clearing.
  let targetI = phase.intensity;
  if (phase.name === 'rain') targetI *= smoothstep(0, 0.25, t);
  else if (phase.name === 'clearing') targetI = 1 - smoothstep(0, 0.8, t);

  // Wind: layered value-noise gust field over unbounded gustT (clockT wraps
  // every loop and would pop the noise lattice). A slow 3-octave fbm swell
  // carries the gust, a faster single octave layers short flutter on top.
  gustT += dt;
  const swell = fbm2(gustT * 0.05, 4.27, 3, 2, 0.5, CONFIG.seed + 77) * 2 - 1;
  const flutter = valueNoise2(gustT * 0.9, 9.13, CONFIG.seed + 91) * 2 - 1;
  const gust = swell * 0.72 + flutter * 0.28;
  const targetW = clamp(phase.wind + gust * 0.22, 0, 1);

  // Smooth everything so phase edges never pop.
  const w = G.weather;
  w.intensity = damp(w.intensity, targetI, 0.9, dt);
  w.wind = damp(w.wind, targetW, 1.4, dt);
  w.gust = clamp(gust, 0, 1); // live gust strength 0..1 for sfx consumers
  w.type = w.intensity <= 0.02 ? 'clear' : phase.type;

  // Anchor the sheet on the player (camera before the game starts).
  if (G.player && G.player.pos) _p.copy(G.player.pos);
  else if (G.camera) _p.copy(G.camera.position);

  // --- rain simulation -------------------------------------------------------
  const want = Math.round(MAX_RAIN * clamp(w.intensity * 1.15, 0, 1));
  points.visible = want > 0;
  material.uniforms.uOpacity.value = clamp(w.intensity * 1.3, 0, 1);
  if (activeCount !== want) {
    // Newly activated drops need a valid spawn; deactivated ones leave draw range.
    const positions = geometry.attributes.position.array;
    for (let i = activeCount; i < want; i++) respawnDrop(i, positions);
    activeCount = want;
    geometry.setDrawRange(0, activeCount);
  }

  if (activeCount > 0) {
    const attr = geometry.attributes.position;
    const arr = attr.array;
    const driftX = _windDir.x * w.wind * WIND_DRIFT;
    const driftZ = _windDir.z * w.wind * WIND_DRIFT;
    for (let i = 0; i < activeCount; i++) {
      const j = i * 3;
      arr[j] += driftX * dt;
      arr[j + 1] -= speeds[i] * dt;
      arr[j + 2] += driftZ * dt;
      const dx = arr[j] - _p.x, dz = arr[j + 2] - _p.z;
      // Recycle on ground contact or when the player walked away from it.
      if (arr[j + 1] < floors[i] || dx * dx + dz * dz > (RAIN_RADIUS + 14) * (RAIN_RADIUS + 14)) {
        respawnDrop(i, arr);
      }
    }
    attr.needsUpdate = true;
  }

  // --- lightning (storm phase only) ------------------------------------------
  if (phase.name === 'storm') {
    nextStrikeIn -= dt;
    if (nextStrikeIn <= 0) {
      strike();
      nextStrikeIn = randRange(rng, 2.5, 9);
    }
  } else {
    nextStrikeIn = randRange(rng, 1.5, 4); // armed fresh on storm entry
  }

  // --- flash decays -----------------------------------------------------------
  if (flashLevel > 0.001) {
    flashLevel *= Math.exp(-dt * 11); // ~120 ms perceived fade
    flashDiv.style.opacity = flashLevel.toFixed(3);
  } else if (flashLevel !== 0) {
    flashLevel = 0;
    flashDiv.style.opacity = '0';
  }
  if (flashLight.intensity > 0.001) {
    flashLight.intensity *= Math.exp(-dt * 16);
  } else if (flashLight.intensity !== 0) {
    flashLight.intensity = 0;
  }
}
