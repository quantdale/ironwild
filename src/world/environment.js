// IRONWILD - sky dome, day/night cycle, sun/moon lighting, fog + water shimmer.
// Owns G.timeOfDay (0..1). updateEnvironment(dt) is called once per frame by
// main.js after gameplay systems.
// v3 additions: drifting flat-shaded cloud layer (wind-driven circling),
// underwater fog override + fullscreen blue tint div, water wave clock.

import * as THREE from 'three';
import { G, CONFIG } from '../core/state.js';
import { clamp, damp, lerp, smoothstep, makeRng } from '../core/utils.js';
import { updateWaterWaves, setWaterSkyUniforms } from './terrain.js';

const DAY_CYCLE = 480;      // real seconds for a full day/night cycle
const SKY_RADIUS = 760;     // dome radius (must stay under camera.far)
const STAR_COUNT = 600;
const SUN_DIST = 220;       // key-light orbit radius around the player
const SHADOW_BOX = 120;     // ortho shadow camera half-extent
const CLOUD_COUNT = 14;     // v3 drifting cloud blobs

// Palette (ARCHITECTURE.md visual style guide).
const COL = {
  dayTop: new THREE.Color(0x3f7fc4),
  dayHorizon: new THREE.Color(0xc4d3de),
  nightTop: new THREE.Color(0x131c2d),
  nightHorizon: new THREE.Color(0x2a3548),
  dusk: new THREE.Color(0xe8956b),
  fogDay: new THREE.Color(0xc4d3de),
  fogNight: new THREE.Color(0x2a3548),
  fogDusk: new THREE.Color(0xd6a685),
  sunDay: new THREE.Color(0xfff1d6),
  sunDusk: new THREE.Color(0xffab6e),
  moon: new THREE.Color(0x93a9cf),
  hemiSkyDay: new THREE.Color(0xbfd6e8),
  hemiSkyNight: new THREE.Color(0x26344d),
  hemiGroundDay: new THREE.Color(0x5c6b4a),
  hemiGroundNight: new THREE.Color(0x1c2330),
  waterA: new THREE.Color(0x3d6f7d), // contract water colour
  waterB: new THREE.Color(0x477e8c), // shimmer high end
  // v2 weather tints (rain denser/dimmer, storm more so).
  fogRain: new THREE.Color(0x8d99a3),
  fogStorm: new THREE.Color(0x59626c),
  skyRain: new THREE.Color(0x6d7a86),
  skyStorm: new THREE.Color(0x4a545e),
  // v3 underwater fog colour (contract #1d4a56) + cloud storm grey.
  waterDeep: new THREE.Color(0x1d4a56),
  cloudGrey: new THREE.Color(0x9aa4ad),
};

// Module state.
let inited = false;
let sunLight = null;        // shadow-casting key light (day)
let moonLight = null;       // dim fill light (night, no shadows)
let hemiLight = null;
let skyGroup = null, skyMat = null, starMat = null, moon = null, moonMat = null;
let waterMesh = null;
let foamMesh = null;        // shoreline foam ring (lives in terrain.js)
let wet = 0;                // smoothed 0..1 weather gloom factor

// v3 clouds: one merged-sphere blob mesh each, circling the world centre.
let cloudGroup = null;
let cloudMat = null;
const clouds = [];          // { mesh, ang, rad, h, speed, phase }

// v3 underwater state: damped 0..1 submersion factor + fullscreen tint div.
let underwaterF = 0;
let tintDiv = null;
let tintOpacity = -1;       // last written div opacity (skip redundant styles)

// Current normalized sun direction. Live shared vector: read via
// getSunDirection(), never mutate.
const sunDir = new THREE.Vector3(0.8, 0.6, 0.35).normalize();

// Scratch objects - reused every frame, no hot-loop allocations.
const _c1 = new THREE.Color();
const _v1 = new THREE.Vector3();
const _focus = new THREE.Vector3();
const Z_AXIS = new THREE.Vector3(0, 0, 1);

// ---- v3 clouds -------------------------------------------------------------

/** Concatenate translated sphere geometries into one flat-shaded blob mesh. */
function buildCloudBlob(rng) {
  const puffs = 4 + Math.floor(rng() * 4); // 4-7 spheres per blob
  const pieces = [];
  let total = 0;
  for (let i = 0; i < puffs; i++) {
    const r = 7 + rng() * 9;
    // toNonIndexed: SphereGeometry is indexed, and the merge below copies raw
    // attribute arrays - an index would be dropped, drawing lattice soup.
    const geo = new THREE.SphereGeometry(r, 7, 5).toNonIndexed();
    // Puffs spread along a loose horizontal ellipse; centre puff is tallest.
    const spread = (i - (puffs - 1) / 2) * (8 + rng() * 5);
    const lift = i === Math.floor(puffs / 2) ? r * 0.35 : rng() * r * 0.3;
    geo.translate(spread, lift, (rng() - 0.5) * 6);
    pieces.push(geo);
    total += geo.attributes.position.count;
  }
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  let off = 0;
  for (const g of pieces) {
    pos.set(g.attributes.position.array, off);
    nor.set(g.attributes.normal.array, off);
    off += g.attributes.position.array.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.computeBoundingSphere();
  return out;
}

/** Build the drifting cloud layer: ~14 white blobs at y 120-160, no shadows. */
function buildClouds() {
  cloudMat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    flatShading: true,
    transparent: true,
    opacity: 0.85,
    depthWrite: false, // overlapping translucent puffs blend instead of z-fighting
  });
  cloudGroup = new THREE.Group();
  const rng = makeRng(CONFIG.seed ^ 0xc10d5);
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const mesh = new THREE.Mesh(buildCloudBlob(rng), cloudMat);
    mesh.castShadow = false; // contract: clouds never cast
    mesh.receiveShadow = false;
    mesh.rotation.y = rng() * Math.PI * 2;
    clouds.push({
      mesh,
      ang: rng() * Math.PI * 2,
      rad: 140 + rng() * 190,   // orbit radius around the world centre
      h: 120 + rng() * 40,      // y 120-160 band
      speed: 0.7 + rng() * 0.7, // per-cloud speed multiplier
      phase: rng() * Math.PI * 2,
    });
    cloudGroup.add(mesh);
  }
  G.scene.add(cloudGroup);
}

/** Per-frame: slow wind-driven circling + gentle bob; storms grey the puffs. */
function updateClouds(dt) {
  if (!cloudGroup) return;
  const wind = G.weather ? G.weather.wind : 0.3;
  const spin = 0.006 + wind * 0.014; // rad/s base orbit, scaled by live wind
  for (let i = 0; i < clouds.length; i++) {
    const c = clouds[i];
    c.ang += spin * c.speed * dt;
    c.mesh.position.set(
      Math.cos(c.ang) * c.rad,
      c.h + Math.sin(G.elapsed * 0.11 + c.phase) * 2.5,
      Math.sin(c.ang) * c.rad,
    );
  }
  if (wet > 0.001) {
    _c1.setHex(0xffffff).lerp(COL.cloudGrey, wet * 0.55);
    cloudMat.color.copy(_c1);
  } else {
    cloudMat.color.setHex(0xffffff);
  }
}

// ---- v3 underwater ---------------------------------------------------------

/** Lazily create the fullscreen blue tint overlay (below all UI layers). */
function ensureTintDiv() {
  if (tintDiv || !document.body) return;
  tintDiv = document.createElement('div');
  tintDiv.id = 'ironwild-underwater';
  tintDiv.style.cssText =
    'position:fixed;inset:0;pointer-events:none;background:#1d4a56;' +
    'opacity:0;z-index:14;'; // under weather wash(15)/HUD(20): world effect only
  document.body.appendChild(tintDiv);
}

/**
 * Dense blue fog + tint while the camera is below the water surface. The
 * factor is damped so surfacing blends quickly instead of popping.
 */
function applyUnderwater(fog, dt) {
  const under = G.camera ? G.camera.position.y < CONFIG.waterLevel : false;
  underwaterF = damp(underwaterF, under ? 1 : 0, 10, dt);
  if (fog && underwaterF > 0.001) {
    fog.color.lerp(COL.waterDeep, underwaterF);
    fog.near = lerp(fog.near, 1, underwaterF);   // contract: near 1 / far 24
    fog.far = lerp(fog.far, 24, underwaterF);
  }
  if (tintDiv) {
    const target = Math.round(underwaterF * 38) / 100; // max 0.38 tint
    if (target !== tintOpacity) {
      tintOpacity = target;
      tintDiv.style.opacity = String(target);
    }
  }
}

/** Builds sky, lights and fog; snaps initial visuals. Safe to call once. */
export function createEnvironment() {
  if (!G.scene || inited) return;
  if (G.timeOfDay === undefined) G.timeOfDay = 0.35; // morning start
  if (G.renderer) G.renderer.shadowMap.enabled = true;

  // Sun key light with an ortho shadow box that follows the player.
  sunLight = new THREE.DirectionalLight(0xfff1d6, 1.3);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  const sc = sunLight.shadow.camera;
  sc.left = -SHADOW_BOX;
  sc.right = SHADOW_BOX;
  sc.top = SHADOW_BOX;
  sc.bottom = -SHADOW_BOX;
  sc.near = 20;
  sc.far = SUN_DIST * 2 + 80;
  sunLight.shadow.bias = -0.0006;
  sunLight.shadow.normalBias = 0.6;
  G.scene.add(sunLight, sunLight.target);

  // Moon fill light: crossfades in as the sun sets (no shadows, cheap).
  moonLight = new THREE.DirectionalLight(COL.moon.getHex(), 0);
  G.scene.add(moonLight, moonLight.target);

  hemiLight = new THREE.HemisphereLight(0xbfd6e8, 0x5c6b4a, 0.75);
  G.scene.add(hemiLight);

  // Sky group rides with the camera so the player never leaves the dome.
  skyGroup = new THREE.Group();

  // Gradient dome with a sun-glow term near the sun direction.
  skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: COL.dayTop.clone() },
      horizonColor: { value: COL.dayHorizon.clone() },
      glowColor: { value: COL.dusk.clone() },
      sunColor: { value: new THREE.Color(0xfff4e0) }, // v7 sun-disc core tint
      sunCore: { value: 1 }, // v7 0..1 sun-disc brightness (day-gated)
      sunDir: { value: sunDir }, // shared live vector
      glowStrength: { value: 0.85 },
      hazeColor: { value: COL.dayHorizon.clone().lerp(new THREE.Color(0xffffff), 0.55) },
      hazeStrength: { value: 0.6 },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform vec3 glowColor;
      uniform vec3 sunColor;
      uniform float sunCore;
      uniform vec3 sunDir;
      uniform float glowStrength;
      uniform vec3 hazeColor;
      uniform float hazeStrength;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float t = smoothstep(-0.08, 0.42, d.y);
        vec3 col = mix(horizonColor, topColor, t);
        // v6: atmospheric haze band right at the horizon - real skies read
        // brighter/whiter there than a plain two-stop gradient gives, since
        // the view ray crosses far more atmosphere at grazing elevation.
        float haze = pow(1.0 - clamp(t, 0.0, 1.0), 4.0);
        col = mix(col, hazeColor, haze * hazeStrength);
        float s = max(dot(d, normalize(sunDir)), 0.0);
        // Wide atmospheric scatter halo around the sun.
        col += glowColor * (pow(s, 20.0) * 0.5 + pow(s, 300.0) * 1.1) * glowStrength;
        // v7: the sun disc itself - a smooth analytic bright core plus a tight
        // inner halo, both purely angular so there is no geometry edge to ring.
        // Over-bright so the bloom pass turns it into a soft glare.
        float disc = pow(s, 6000.0) * 0.7 + pow(s, 1800.0) * 0.35;
        col += sunColor * disc * sunCore;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 24, 12), skyMat);
  dome.frustumCulled = false;
  skyGroup.add(dome);

  // Stars: fixed points on the upper dome, faded in by night factor.
  const rng = makeRng(CONFIG.seed ^ 0x51ab3f);
  const starPos = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    const y = 0.06 + rng() * 0.9;
    const th = rng() * Math.PI * 2;
    const rh = Math.sqrt(1 - y * y);
    starPos[i * 3] = Math.cos(th) * rh * SKY_RADIUS * 0.94;
    starPos[i * 3 + 1] = y * SKY_RADIUS * 0.94;
    starPos[i * 3 + 2] = Math.sin(th) * rh * SKY_RADIUS * 0.94;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  starMat = new THREE.PointsMaterial({
    color: 0xcfe0ff,
    size: 1.8,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false, // stars sit beyond fog.far - must ignore fog
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  skyGroup.add(stars);

  // Moon disc opposite the sun.
  moonMat = new THREE.MeshBasicMaterial({
    color: 0xdfe8f2,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
  });
  moon = new THREE.Mesh(new THREE.CircleGeometry(SKY_RADIUS * 0.032, 20), moonMat);
  moon.frustumCulled = false;
  skyGroup.add(moon);

  // v7: the visible sun lives in the dome shader itself (a smooth analytic
  // bright core, see the fragment shader's sunCore term) - a plane/disc mesh
  // additively blended over the bright sky always clipped into a hard ring,
  // whereas a smooth angular falloff on the dome has no edge for the bloom /
  // chromatic-aberration passes to fringe. sunGlow/sunCore uniforms drive it.

  G.scene.add(skyGroup);

  // Scene fog, lerped between day/night every update.
  G.scene.fog = new THREE.Fog(COL.fogDay.getHex(), 60, 420);

  // v3: drifting cloud layer + underwater tint overlay.
  buildClouds();
  ensureTintDiv();

  inited = true;
  updateEnvironment(0); // snap initial lighting/sky state
}

/** Advances the day cycle and refreshes sky/light/fog/water visuals. */
export function updateEnvironment(dt) {
  if (!inited || !G.scene) return;
  dt = clamp(dt, 0, 0.1); // safety clamp (main.js clamps raw dt too)

  // --- day/night clock: focus slow-mo barely affects it ---
  // main.js already scaled dt by G.timeScale; divide it back out so focus
  // dilates the clock by the residual factor once, not squared.
  const ts = Math.max(G.timeScale, 1e-4);
  G.timeOfDay = (G.timeOfDay + ((dt / ts) * (ts * 0.85 + 0.15)) / DAY_CYCLE) % 1;

  // --- v2 weather reaction (reads G.weather; world/weather.js owns writes) ---
  const wx = G.weather;
  const rainAmt = wx && wx.type === 'rain' ? clamp(wx.intensity, 0, 1) : 0;
  const stormAmt = wx && wx.type === 'storm' ? clamp(wx.intensity, 0, 1) : 0;
  // Smoothed gloom: rain pushes ~60% of full effect, storm the rest.
  wet = damp(wet, Math.max(rainAmt * 0.6, stormAmt), 1.2, dt);

  // Sun on a tilted circle; elevation follows the sine of the day phase.
  const ang = (G.timeOfDay - 0.25) * Math.PI * 2; // 0 at sunrise, pi/2 at noon
  const elev = Math.sin(ang);
  sunDir.set(Math.cos(ang), elev, 0.38).normalize();

  const day = smoothstep(-0.04, 0.16, elev);
  const night = smoothstep(0.04, -0.16, elev); // reversed edges -> 1 below horizon
  const dusk = 1 - smoothstep(0.03, 0.32, Math.abs(elev));

  // Lights track the player loosely (direct follow keeps shadows stable).
  _focus.set(0, 0, 0);
  if (G.player && G.player.pos) _focus.copy(G.player.pos);

  sunLight.position.copy(_focus).addScaledVector(sunDir, SUN_DIST);
  sunLight.color.copy(COL.sunDusk).lerp(COL.sunDay, smoothstep(0.06, 0.42, elev));
  sunLight.intensity = day * 1.35 * (1 - wet * 0.65); // rain/storm dim the key light
  sunLight.target.position.copy(_focus);
  sunLight.target.updateMatrixWorld();

  _v1.copy(sunDir).negate(); // moon sits opposite the sun
  moonLight.position.copy(_focus).addScaledVector(_v1, SUN_DIST);
  moonLight.intensity = night * 0.28 * (1 - wet * 0.4);
  moonLight.target.position.copy(_focus);
  moonLight.target.updateMatrixWorld();

  hemiLight.intensity = lerp(0.16, 0.8, day) * (1 - wet * 0.45); // hemisphere dims too
  hemiLight.color.copy(COL.hemiSkyNight).lerp(COL.hemiSkyDay, day);
  hemiLight.groundColor.copy(COL.hemiGroundNight).lerp(COL.hemiGroundDay, day);

  // Fog pulls in and darkens at night, warms at dusk; rain/storm pull it in
  // much harder and grey it out.
  const fog = G.scene.fog;
  if (fog) {
    fog.color.copy(COL.fogNight).lerp(COL.fogDay, day);
    fog.color.lerp(COL.fogDusk, dusk * 0.35);
    fog.near = lerp(30, 60, day);
    fog.far = lerp(240, 420, day);
    if (wet > 0.001) {
      _c1.copy(COL.fogRain).lerp(COL.fogStorm, clamp(stormAmt * 1.4, 0, 1));
      fog.color.lerp(_c1, wet * 0.7);
      fog.near = lerp(fog.near, 14, wet);
      fog.far = lerp(fog.far, 120, wet);
    }
  }

  // v3: submerged camera overrides everything with dense blue fog + tint.
  applyUnderwater(fog, dt);

  // Sky gradient + warm dusk band + sun glow.
  const u = skyMat.uniforms;
  u.topColor.value.copy(COL.nightTop).lerp(COL.dayTop, day);
  u.horizonColor.value.copy(COL.nightHorizon).lerp(COL.dayHorizon, day);
  u.horizonColor.value.lerp(COL.dusk, dusk * 0.85);
  u.glowColor.value.copy(COL.dusk).lerp(COL.sunDay, smoothstep(0.08, 0.4, elev));
  u.glowStrength.value = (day * 0.85 + dusk * 0.35) * (1 - wet);
  if (wet > 0.001) {
    _c1.copy(COL.skyRain).lerp(COL.skyStorm, clamp(stormAmt * 1.4, 0, 1));
    u.topColor.value.lerp(_c1, wet * 0.6);
    u.horizonColor.value.lerp(_c1, wet * 0.6);
  }
  // v6: horizon haze tracks the (already weather/dusk-adjusted) horizon
  // colour, lightened toward white; strongest by day, faint at night since
  // there is little light left to scatter across the horizon band.
  u.hazeColor.value.copy(u.horizonColor.value).lerp(_c1.setHex(0xffffff), 0.55);
  u.hazeStrength.value = (0.25 + day * 0.5 + dusk * 0.25) * (1 - wet * 0.5);

  if (G.camera) skyGroup.position.copy(G.camera.position);

  // Stars fade in with darkness; subtle global twinkle. Rain/storm hide them.
  starMat.opacity = night * (0.82 + 0.18 * Math.sin(G.elapsed * 1.7)) * (1 - wet);

  // Moon disc faces the dome centre (= camera).
  moon.position.copy(sunDir).multiplyScalar(-SKY_RADIUS * 0.9);
  _v1.copy(moon.position).normalize().negate();
  moon.quaternion.setFromUnitVectors(Z_AXIS, _v1);
  moonMat.opacity = night * 0.95 * (1 - wet);
  moon.visible = night > 0.02 && wet < 0.5;

  // v7: sun-disc core in the dome shader. Warms at dusk, fades below the
  // horizon and under weather. Kept just above the horizon so a rising/setting
  // sun still shows a defined disc through the scatter halo.
  u.sunColor.value.copy(COL.sunDusk).lerp(COL.sunDay, smoothstep(0.0, 0.4, elev));
  u.sunCore.value = smoothstep(-0.05, 0.1, elev) * (1 - wet);

  // Cheap water shimmer (mesh lives in terrain.js, found by name).
  if (!waterMesh) waterMesh = G.scene.getObjectByName('ironwild_water') || null;
  if (waterMesh && waterMesh.material) {
    const sh = Math.sin(G.elapsed * 1.3) * 0.5 + 0.5;
    waterMesh.material.opacity = 0.72 + sh * 0.06;
    waterMesh.material.color.copy(COL.waterA).lerp(COL.waterB, sh);
  }
  updateWaterWaves(G.elapsed); // v3: advance the GPU wave clock
  // v6: water fresnel/glint reads the live sky gradient + sun state so the
  // "reflection" tracks day/night/dusk/storm without a second scene render.
  setWaterSkyUniforms(u.topColor.value, u.horizonColor.value, sunDir, sunLight.color,
    clamp(day + dusk * 0.6, 0, 1)); // contract: 0..1 glint visibility

  // v3 clouds drift on the same clock (wind-scaled circling, storm greying).
  updateClouds(dt);

  // Shoreline foam ring (also terrain.js): advance its shader clock and let
  // the ribbon breathe against the sand.
  if (!foamMesh) foamMesh = G.scene.getObjectByName('ironwild_foam') || null;
  if (foamMesh && foamMesh.material && foamMesh.material.uniforms) {
    foamMesh.material.uniforms.uTime.value = G.elapsed;
    const breathe = 1 + Math.sin(G.elapsed * 0.9) * 0.01;
    foamMesh.scale.set(breathe, 1, breathe);
  }
}

/** Current normalized sun direction (live module vector - read, don't mutate). */
export function getSunDirection() {
  return sunDir;
}
