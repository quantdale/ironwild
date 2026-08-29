// IRONWILD - third-person camera rig.
// Owns pointer-lock mouse look (with a free-cursor fallback when the browser
// denies pointer lock), the orbit/aim rig, terrain collision, impact shake and
// the aim basis written into G.cam every frame (before player update).

import * as THREE from 'three';
import { G } from '../core/state.js';
import { Input } from '../core/input.js';
import { bus } from '../core/events.js';
import { clamp, damp } from '../core/utils.js';
import { heightAt } from '../world/terrain.js';

const MOUSE_SENS = 0.0022;
const PITCH_MIN = -1.2;
const PITCH_MAX = 1.35;
const PIVOT_HEIGHT = 1.55;     // pivot above feet position
const DIST_NORMAL = 4.3;       // boom length, exploration
const DIST_AIM = 2.4;          // boom length, aiming
const SHOULDER_SHIFT = 0.55;   // right-shoulder offset while aiming
const BOOM_LIFT = 0.35;        // camera rides above the pivot
const FOV_NORMAL = 62;
const FOV_AIM = 50;
const FOV_LAMBDA = 10;
const DRAW_FOV_KICK = 3.5;     // extra pull-in while the bow is drawn
const POS_LAMBDA = 14;         // position smoothing, exploration
const POS_LAMBDA_AIM = 22;     // snappier while aiming
const GROUND_MARGIN = 0.4;     // camera never dips below ground + this
const MARCH_STEPS = 8;         // collision samples along the boom
const SHAKE_UNITS = 0.28;      // max positional shake offset (m) at amp 1
const PIVOT_CROUCH_DROP = 0.5; // pivot lowers by this when fully crouched
const PAD_LOOK_SPEED = 3.0;    // v5: right-stick look rate (rad/s at full deflection)

/** v5 a11y: live camera-shake scale (0..1) from ui/a11y.js; absent = full shake. */
function shakeScale() {
  const a = typeof window !== 'undefined' ? window.__IW_A11Y : null;
  const s = a && typeof a.camShakeScale === 'number' ? a.camShakeScale : 1;
  return s < 0 ? 0 : s > 1 ? 1 : s;
}

// Module-scope temps - reused every frame, no per-frame allocations.
const _pivot = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _start = new THREE.Vector3();
const _target = new THREE.Vector3();
const _sample = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _smoothPos = new THREE.Vector3();
let _smoothInit = false;

// Right mouse button is tracked here (Input has no mouse-button API).
let _rmbDown = false;
let _installed = false;

// v2: free-cursor fallback deltas are accumulated by Input alongside
// pointer-lock deltas; this module consumes one authoritative stream.

// v2: impact shake from 'camShake' bus events (only this module applies it).
let _shakeAmp = 0;
let _shakeLeft = 0;
let _shakeDur = 0.25;
let _shakePhase = 0;

function onMouseDown(e) { if (e.button === 2) _rmbDown = true; }
function onMouseUp(e) { if (e.button === 2) _rmbDown = false; }
function onBlur() { _rmbDown = false; }
function onCamShake(payload) {
  const amp = payload && typeof payload.amp === 'number' ? payload.amp : 0;
  if (amp <= 0) return;
  _shakeAmp = Math.min(amp, 1);
  _shakeDur = payload && typeof payload.time === 'number' && payload.time > 0
    ? payload.time
    : 0.25;
  _shakeLeft = _shakeDur;
}

/** Install listeners once. Call at boot, before the first updateCamera. */
export function createCameraRig() {
  if (_installed) return;
  _installed = true;
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('blur', onBlur);
  bus.on('camShake', onCamShake);
  // The game owns the right mouse button - no browser context menu.
  window.addEventListener('contextmenu', (e) => e.preventDefault());
}

/** Per-frame camera update. Safe with dt = 0 (paused / render-only frames). */
export function updateCamera(dt) {
  const cam = G.cam;

  // --- mouse look ---
  // v2 control gate: pointer lock OR lock-broken fallback, so browsers that
  // deny requestPointerLock still get mouse look via free-cursor movement.
  const { dx: mdx, dy: mdy } = Input.consumeMouse();
  const control = G.started && !G.paused && (Input.locked || Input.lockBroken);
  if (control) {
    // Live settings from ui/settings.js: sensitivity + inverted Y.
    const sens = MOUSE_SENS * (G.settings ? G.settings.sens : 1);
    cam.yaw -= mdx * sens;
    const pitchDelta = mdy * sens * (G.settings && G.settings.invertY ? -1 : 1);
    cam.pitch = clamp(cam.pitch - pitchDelta, PITCH_MIN, PITCH_MAX);
  }
  // v5: gamepad right-stick look (Wave J input layer). Independent of pointer
  // lock - a pad must stay usable when the browser never granted lock. Axes
  // arrive in movementX/Y convention (right = +x, up = -y), so the pitch math
  // mirrors the mouse path exactly; PAD_LOOK_SPEED converts to rad/frame via dt.
  if (G.started && !G.paused && typeof Input.getLookAxes === 'function') {
    const look = Input.getLookAxes();
    if (look && (look.x !== 0 || look.y !== 0)) {
      const padRate = PAD_LOOK_SPEED * (G.settings ? G.settings.sens : 1) * dt;
      cam.yaw -= look.x * padRate;
      const pdy = look.y * padRate * (G.settings && G.settings.invertY ? -1 : 1);
      cam.pitch = clamp(cam.pitch - pdy, PITCH_MIN, PITCH_MAX);
    }
  }
  // v5: aim also engages from the action layer (gamepad RT / rebound keys),
  // not just the physical right mouse button. Swimming still suppresses it.
  const padAim = typeof Input.isAction === 'function' && Input.isAction('aim');
  cam.aiming = control && (_rmbDown || padAim) && !(G.player && G.player.swimming);

  // --- basis from yaw/pitch (yaw 0 faces -Z, positive pitch looks up) ---
  const cosP = Math.cos(cam.pitch);
  _forward.set(-Math.sin(cam.yaw) * cosP, Math.sin(cam.pitch), -Math.cos(cam.yaw) * cosP);
  _right.set(Math.cos(cam.yaw), 0, -Math.sin(cam.yaw));
  cam.forward.copy(_forward);
  cam.right.copy(_right);
  cam.aimDir.copy(_forward);

  if (!G.player || !G.camera) {
    // Pre-boot frames: park the camera at a sane vantage and bail.
    cam.aimOrigin.set(0, PIVOT_HEIGHT, 0);
    if (G.camera && !_smoothInit) {
      _smoothPos.set(0, 5, 8);
      G.camera.position.copy(_smoothPos);
      G.camera.rotation.order = 'YXZ';
      G.camera.rotation.set(cam.pitch, cam.yaw, 0);
      _smoothInit = true;
    }
    return;
  }

  // --- rig geometry ---
  const p = G.player.pos;
  // v2: pivot rides lower while crouched (smoothed blend from player.js).
  const pivotH = PIVOT_HEIGHT - PIVOT_CROUCH_DROP * (G.player.crouchAmt || 0);
  _pivot.set(p.x, p.y + pivotH, p.z);
  const shoulder = cam.aiming ? SHOULDER_SHIFT : 0;
  const dist = cam.aiming ? DIST_AIM : DIST_NORMAL;

  _desired.copy(_pivot)
    .addScaledVector(_right, shoulder)
    .addScaledVector(_forward, -dist);
  _desired.y += BOOM_LIFT;

  // --- terrain collision: march pivot -> desired, shorten on first hit ---
  _start.copy(_pivot).addScaledVector(_right, shoulder);
  let hitStep = MARCH_STEPS + 1;
  for (let i = 1; i <= MARCH_STEPS; i++) {
    const t = i / MARCH_STEPS;
    _sample.lerpVectors(_start, _desired, t);
    if (_sample.y < heightAt(_sample.x, _sample.z) + GROUND_MARGIN) {
      hitStep = i;
      break;
    }
  }
  _target.lerpVectors(_start, _desired, Math.min(hitStep - 1, MARCH_STEPS) / MARCH_STEPS);
  const minY = heightAt(_target.x, _target.z) + GROUND_MARGIN;
  if (_target.y < minY) _target.y = minY;

  // --- smooth position (snappier while aiming), never under the ground ---
  if (!_smoothInit) {
    _smoothPos.copy(_target);
    _smoothInit = true;
  }
  const lambda = cam.aiming ? POS_LAMBDA_AIM : POS_LAMBDA;
  _smoothPos.x = damp(_smoothPos.x, _target.x, lambda, dt);
  _smoothPos.y = damp(_smoothPos.y, _target.y, lambda, dt);
  _smoothPos.z = damp(_smoothPos.z, _target.z, lambda, dt);
  const smoothMinY = heightAt(_smoothPos.x, _smoothPos.z) + GROUND_MARGIN;
  if (_smoothPos.y < smoothMinY) _smoothPos.y = smoothMinY;
  G.camera.position.copy(_smoothPos);

  // --- v2: impact shake - decaying positional offset on top of the smoothed
  // position (never fed back into it), from 'camShake' bus events.
  if (_shakeLeft > 0) {
    _shakeLeft -= dt;
    const k = Math.max(_shakeLeft, 0) / _shakeDur; // linear amp decay
    // v5: scaled by the accessibility camShakeScale (0 disables entirely).
    const s = _shakeAmp * k * SHAKE_UNITS * shakeScale();
    _shakePhase += dt * 43;
    G.camera.position.x += Math.sin(_shakePhase * 1.7) * s;
    G.camera.position.y += Math.cos(_shakePhase * 2.3) * s * 0.8;
    G.camera.position.z += Math.sin(_shakePhase * 1.1) * s;
    const shakeMinY = heightAt(G.camera.position.x, G.camera.position.z) + GROUND_MARGIN;
    if (G.camera.position.y < shakeMinY) G.camera.position.y = shakeMinY;
  }

  // --- FOV: aim zoom + slight extra pull while the bow is drawn ---
  let fovTarget = cam.aiming ? FOV_AIM : FOV_NORMAL;
  if (cam.aiming && G.player.drawing) fovTarget -= DRAW_FOV_KICK;
  const fov = damp(G.camera.fov, fovTarget, FOV_LAMBDA, dt);
  if (Math.abs(fov - G.camera.fov) > 0.001) {
    G.camera.fov = fov;
    G.camera.updateProjectionMatrix();
  }

  // --- orientation straight from yaw/pitch (no lookAt jitter) ---
  G.camera.rotation.order = 'YXZ';
  G.camera.rotation.set(cam.pitch, cam.yaw, 0);

  cam.aimOrigin.copy(_pivot).addScaledVector(_right, shoulder);
}
