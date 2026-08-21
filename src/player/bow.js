// IRONWILD - recurve bow: procedural model, draw/release, sway, arrow spawning.
// The bow visual is attached to the player's left hand; firing reads the aim
// basis written by camera.js and delegates ballistics to combat/projectiles.js.
// v2: KeyX or mouse wheel toggles standard/fire arrows (fire consumes its own
// inventory pool).

import * as THREE from 'three';
import { G, CONFIG } from '../core/state.js';
import { bus } from '../core/events.js';
import { Input } from '../core/input.js';
import { clamp, lerp, smoothstep } from '../core/utils.js';
import { spawnArrow } from '../combat/projectiles.js';
import { sfx } from '../audio/audio.js';

const FIRE_THRESHOLD = 0.15;   // minimum draw fraction to loose an arrow
const MAX_PULL = 0.34;         // string travel at full draw (m)
const NOCK_REST_Z = 0.02;      // string nock offset from grip at rest
const SWAY_AMPLITUDE = 0.004;  // rad of aim wander at zero draw
const SWAY_FREQ = 3.1;         // rad/s of the sway oscillation
const CONVERGE_DIST = 45;      // crosshair convergence distance (m)
const NOTIFY_THROTTLE = 2.0;   // s between "Out of arrows" toasts
const WHEEL_NOTCH = 100;       // deltaY of wheel travel that counts as one notch
const WHEEL_COOLDOWN = 0.15;   // s between wheel-driven arrow-type swaps

// Palette (ARCHITECTURE.md style guide).
const WOOD_COLOR = 0x6b4a2f;
const LEATHER_COLOR = 0x4a3220;
const STRING_COLOR = 0xd9d2c0;
const HEAD_COLOR = 0x3a3f46;
const FLETCH_COLOR = 0x8a4b32;
const FLETCH_COLOR_FIRE = 0xff8c3b; // nocked arrow shows the selected type

// Limb segments: length / width / extra bend per segment (recurve curve).
const LIMB_SEGS = [
  { len: 0.17, w: 0.055, bend: 0.16 },
  { len: 0.17, w: 0.048, bend: 0.30 },
  { len: 0.15, w: 0.040, bend: 0.52 },
];
const LIMB_ROOT = 0.12;        // limbs start this far above/below grip center

// Module-scope temps - reused every frame, no per-frame allocations.
const _dir = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _converge = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

// Module state.
let _lmbDown = false;
let _prevLmb = false;
let _installed = false;
let _attached = false;
let _bowRoot = null;
let _stringTop = null;
let _stringBottom = null;
let _nockedArrow = null;
const _tipTop = new THREE.Vector3();    // string anchors in bow space
const _tipBottom = new THREE.Vector3();
let _drawT = 0;                // 0..1 draw fraction
let _drawing = false;          // true while the string is being pulled
let _lastNoAmmoAt = -Infinity;
let _wheelAccum = 0;           // wheel deltaY banked toward the next notch
let _lastWheelSwap = -Infinity;
let _nockedFletchMat = null;   // tinted to show the selected arrow type

function onMouseDown(e) { if (e.button === 0) _lmbDown = true; }
function onMouseUp(e) { if (e.button === 0) _lmbDown = false; }
function onBlur() { _lmbDown = false; }

/** Build the low-poly recurve bow and install input listeners. Call once at boot. */
export function createBow() {
  if (_installed) return;
  _installed = true;
  buildBowMesh();
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('blur', onBlur);
  // Contract (see updateBow): pausing mid-draw silently cancels the shot.
  // updateBow never runs while paused, so the cancel happens at the source.
  bus.on('ui', ({ action }) => {
    if (action === 'pause' && (_drawing || _drawT > 0)) {
      _drawT = 0;
      _drawing = false;
    }
  });
}

/** Per-frame draw/release logic + string/nock animation. dt is already time-scaled. */
export function updateBow(dt) {
  tryAttach();

  const player = G.player;
  const active = !!player && !player.dead && G.started && !G.paused && !G.gameOver;
  const aiming = active && G.cam.aiming;

  // v2: KeyX or mouse wheel swaps arrow type; switching INTO fire needs stock.
  if (active && Input.pressed('KeyX')) toggleArrowType();

  // Wheel cycling (active frames only): bank deltaY until a full notch
  // accrues, then swap. The cooldown keeps a fast flick to one swap per step;
  // the wheel listener is passive and never preventDefault'ed, so scrolling
  // neither fires/aims/draws nor touches pointer-lock look.
  if (active) {
    _wheelAccum += Input.consumeWheel();
    if (Math.abs(_wheelAccum) >= WHEEL_NOTCH && G.elapsed - _lastWheelSwap >= WHEEL_COOLDOWN) {
      _wheelAccum = 0;
      _lastWheelSwap = G.elapsed;
      toggleArrowType();
    }
  }

  // Fire arrows come out of their own pool; standard arrows still work as a
  // fallback when the fire pool runs dry mid-type.
  const hasArrows = G.inventory.arrows > 0;
  const hasFire = G.arrowType === 'fire' && G.inventory.fireArrows > 0;
  const hasAmmo = hasArrows || hasFire;

  const wantDraw = aiming && _lmbDown && hasAmmo;
  if (wantDraw) {
    if (!_drawing) sfx('bowDraw');
    const full = CONFIG.drawTimeFull * (G.skills.steadyAim ? 0.65 : 1);
    if (!Number.isFinite(dt)) dt = 0; // defensive: never let a bad frame poison the draw
    _drawT = clamp(_drawT + dt / full, 0, 1);
    _drawing = true;
  } else if (_drawing) {
    // Fire only on a real release (button up or aim dropped); pausing or
    // dying mid-draw silently cancels.
    if (active && (!_lmbDown || !aiming) && hasAmmo && _drawT > FIRE_THRESHOLD) {
      fire();
    }
    _drawT = 0;
    _drawing = false;
  }

  // Dry click with an empty quiver (both pools).
  if (aiming && _lmbDown && !_prevLmb && !hasAmmo) {
    if (G.elapsed - _lastNoAmmoAt >= NOTIFY_THROTTLE) {
      _lastNoAmmoAt = G.elapsed;
      sfx('uiClick');
      bus.emit('notify', { text: 'Out of arrows', tone: 'bad' });
    }
  }
  _prevLmb = _lmbDown;

  // Shared flags: camera FOV kick + HUD reticle read these.
  if (player) {
    player.drawing = _drawing;
    player.drawT = _drawT;
  }

  // String nock pulls back with draw; nocked arrow rides along.
  if (_attached) {
    const nockZ = NOCK_REST_Z + _drawT * MAX_PULL;
    setSegment(_stringTop, _tipTop.y, nockZ);
    setSegment(_stringBottom, _tipBottom.y, nockZ);
    _nockedArrow.visible = _drawing;
    if (_drawing) _nockedArrow.position.z = nockZ;
    if (_nockedFletchMat) {
      _nockedFletchMat.color.setHex(G.arrowType === 'fire' ? FLETCH_COLOR_FIRE : FLETCH_COLOR);
    }
  }
}

// --- internals ---------------------------------------------------------------

/** KeyX: toggle G.arrowType between 'standard' and 'fire'. Entering fire mode
 *  requires fireArrows > 0; leaving it is always allowed. HUD reads the field. */
function toggleArrowType() {
  if (G.arrowType === 'fire') {
    G.arrowType = 'standard';
    sfx('uiClick');
    bus.emit('notify', { text: 'Standard arrows', tone: 'info' });
  } else if (G.inventory.fireArrows > 0) {
    G.arrowType = 'fire';
    sfx('uiClick');
    bus.emit('notify', { text: 'Fire arrows', tone: 'good' });
  } else {
    sfx('uiClick');
    bus.emit('notify', { text: 'No fire arrows', tone: 'bad' });
  }
}

function fire() {
  const power = smoothstep(0, 1, _drawT);
  const steady = !!G.skills.steadyAim;

  // Converge the fire line with the crosshair: the arrow leaves from the
  // over-shoulder aimOrigin, so pointing it straight along cam.forward would
  // fly parallel to (not through) the on-screen reticle. Aim at a point far
  // along the camera ray instead — arrows land where the crosshair sits.
  _dir.copy(G.cam.aimDir);
  if (!steady) {
    // Sway shrinks to zero at full draw; two phase-shifted axes wobble.
    const amp = SWAY_AMPLITUDE * (1 - _drawT);
    _camUp.crossVectors(G.cam.right, G.cam.aimDir).normalize();
    _dir.addScaledVector(G.cam.right, Math.sin(G.elapsed * SWAY_FREQ) * amp);
    _dir.addScaledVector(_camUp, Math.cos(G.elapsed * SWAY_FREQ) * amp);
    _dir.normalize();
  }
  if (G.camera) {
    _converge.copy(G.camera.position).addScaledVector(_dir, CONVERGE_DIST);
    _dir.subVectors(_converge, G.cam.aimOrigin).normalize();
  }

  const speed = lerp(CONFIG.arrowMinPowerSpeed, CONFIG.arrowMaxPowerSpeed, power);
  const damage = CONFIG.arrowBaseDamage * (0.5 + 0.5 * power);

  // Consume from the fire pool when in fire mode with stock; otherwise a
  // standard arrow (also the silent fallback if the fire pool emptied).
  const useFire = G.arrowType === 'fire' && G.inventory.fireArrows > 0;

  // Spawn ON the camera ray (just past the near plane) so the arrow flies
  // exactly along the crosshair line — zero parallax at every range. The
  // aimOrigin-based line only converged at CONVERGE_DIST and drifted ~0.4u
  // off weak points at mid range.
  const origin = G.camera
    ? G.camera.position.clone().addScaledVector(_dir, 1.05)
    : G.cam.aimOrigin.clone();
  const dir = _dir.clone();
  spawnArrow({ origin, dir, speed, damage, fire: useFire, power });
  if (useFire) {
    G.inventory.fireArrows--;
    if (G.inventory.fireArrows <= 0) {
      G.arrowType = 'standard'; // pool dry -> drop back to standard
      bus.emit('notify', { text: 'Out of fire arrows', tone: 'bad' });
    }
  } else {
    G.inventory.arrows--;
  }
  bus.emit('arrowFired', { origin, dir, power });
  sfx('bowRelease');
}

function tryAttach() {
  if (_attached || !_bowRoot) return;
  const group = G.player && G.player.group;
  if (!group) return;
  const hand = group.getObjectByName('handL');
  if (hand) {
    hand.add(_bowRoot); // bone already carries the placement
  } else {
    _bowRoot.position.set(0.25, 1.3, 0.35);
    group.add(_bowRoot);
  }
  _attached = true;
}

/**
 * Stretch a unit-height cylinder between a limb tip and the nock point.
 * Tips are x=0 in bow space and share one z (symmetric recurve), so only
 * tipY varies between the two strands.
 */
function setSegment(mesh, tipY, nockZ) {
  const tipZ = _tipTop.z;
  _mid.set(0, tipY * 0.5, (nockZ + tipZ) * 0.5);
  mesh.position.copy(_mid);
  _seg.set(0, -tipY, nockZ - tipZ);
  mesh.scale.y = Math.max(_seg.length(), 0.001);
  _seg.normalize();
  mesh.quaternion.setFromUnitVectors(_up, _seg);
}

function buildBowMesh() {
  const woodMat = new THREE.MeshStandardMaterial({ color: WOOD_COLOR, flatShading: true });
  const leatherMat = new THREE.MeshStandardMaterial({ color: LEATHER_COLOR, flatShading: true });
  const stringMat = new THREE.MeshBasicMaterial({ color: STRING_COLOR });
  const headMat = new THREE.MeshStandardMaterial({ color: HEAD_COLOR, flatShading: true });
  const fletchMat = new THREE.MeshStandardMaterial({ color: FLETCH_COLOR, flatShading: true });

  _bowRoot = new THREE.Group();
  _bowRoot.name = 'bow';

  // Leather-wrapped grip.
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.26, 0.05), leatherMat);
  _bowRoot.add(grip);

  // Limbs: three angled box segments each, curving back toward the archer.
  // Returns the tip position in bow-root space via outTip.
  const makeLimb = (sign, outTip) => {
    const limb = new THREE.Group();
    let y = 0, z = 0, bend = 0;
    for (const s of LIMB_SEGS) {
      const dirY = Math.cos(bend), dirZ = Math.sin(bend);
      const seg = new THREE.Mesh(new THREE.BoxGeometry(s.w, s.len, 0.032), woodMat);
      seg.rotation.x = bend; // local +Y -> (0, cos b, sin b)
      seg.position.set(0, y + dirY * s.len * 0.5, z + dirZ * s.len * 0.5);
      limb.add(seg);
      y += dirY * s.len;
      z += dirZ * s.len;
      bend += s.bend;
    }
    limb.position.y = sign * LIMB_ROOT;
    if (sign < 0) limb.rotation.z = Math.PI; // mirror downward, keep +Z curve
    outTip.set(0, sign * (LIMB_ROOT + y), z);
    return limb;
  };
  _bowRoot.add(makeLimb(1, _tipTop));
  _bowRoot.add(makeLimb(-1, _tipBottom));

  // String: two thin cylinders stretched tip -> nock each frame.
  const stringGeo = new THREE.CylinderGeometry(0.0065, 0.0065, 1, 5);
  _stringTop = new THREE.Mesh(stringGeo, stringMat);
  _stringBottom = new THREE.Mesh(stringGeo, stringMat);
  _bowRoot.add(_stringTop, _stringBottom);
  setSegment(_stringTop, _tipTop.y, NOCK_REST_Z);
  setSegment(_stringBottom, _tipBottom.y, NOCK_REST_Z);

  // Nocked arrow (visible only while drawing): tail sits on the nock point.
  _nockedArrow = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.6, 6), woodMat);
  shaft.rotation.x = Math.PI / 2; // lie along Z, tip toward -Z
  shaft.position.z = -0.3;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.09, 6), headMat);
  head.rotation.x = -Math.PI / 2;
  head.position.z = -0.345;
  const finH = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.05, 0.08), fletchMat);
  finH.position.z = -0.07;
  const finV = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.002, 0.08), fletchMat);
  finV.position.z = -0.07;
  _nockedArrow.add(shaft, head, finH, finV);
  _nockedArrow.visible = false;
  _bowRoot.add(_nockedArrow);
  _nockedFletchMat = fletchMat;
}
