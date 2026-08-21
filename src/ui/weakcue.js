// IRONWILD - colorblind-safe weak-point cue (v4). Every weak point already
// glows cyan against a dark body, but that is still a single-hue cue; players
// who can't rely on color at all get nothing extra to go on in normal combat
// (focus scan's text labels are the only color-independent cue, and those
// only appear while scanning). When G.settings.colorblind is on, this draws
// a small pulsing white-on-black reticle - shape + achromatic contrast, not
// color - above every unbroken weak point on any alive machine within sight
// range, all the time, not just during a scan.

import * as THREE from 'three';
import { G, CONFIG } from '../core/state.js';

const MAX_MARKERS = 48;   // generous: up to ~3 weak points x 16 machines
const RANGE_SQ = 45 * 45; // matches ai.js's SIGHT_DIST-ish scale
const PULSE_SPEED = 3.2;
const BASE_SCALE = 0.42;
const PULSE_AMP = 0.08;

let pool = [];
let mat = null;
let tex = null;
let root = null;

function makeReticleTexture() {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 64;
  const c = cv.getContext('2d');
  // Black halo first so the white reticle reads on any background/lighting.
  c.strokeStyle = '#000000';
  c.lineWidth = 7;
  drawReticle(c);
  c.strokeStyle = '#f4fbff';
  c.lineWidth = 3.5;
  drawReticle(c);
  return new THREE.CanvasTexture(cv);
}

function drawReticle(c) {
  c.beginPath();
  c.arc(32, 32, 20, 0, Math.PI * 2);
  c.stroke();
  for (const [x1, y1, x2, y2] of [[32, 6, 32, 16], [32, 48, 32, 58], [6, 32, 16, 32], [48, 32, 58, 32]]) {
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();
  }
}

function ensurePool() {
  if (pool.length || !G.scene) return;
  tex = makeReticleTexture();
  mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, opacity: 0.85 });
  root = new THREE.Group();
  root.name = 'iw-weakcue';
  G.scene.add(root);
  for (let i = 0; i < MAX_MARKERS; i++) {
    const s = new THREE.Sprite(mat);
    s.scale.set(BASE_SCALE, BASE_SCALE, 1);
    s.renderOrder = 998; // under focus.js's scan labels, above ordinary geometry
    s.visible = false;
    root.add(s);
    pool.push(s);
  }
}

/** Idempotent; called once at boot alongside the other ui/* modules. */
export function createWeakCue() {
  ensurePool();
}

const _v = new THREE.Vector3();

export function updateWeakCue() {
  if (!G.settings.colorblind) {
    if (pool.length && pool[0].visible) for (const s of pool) s.visible = false;
    return;
  }
  ensurePool();
  if (!pool.length) return;

  const pp = G.player && G.player.pos;
  const scale = BASE_SCALE + Math.sin(G.elapsed * PULSE_SPEED) * PULSE_AMP;
  let mi = 0;
  for (const m of G.machines) {
    if (mi >= pool.length) break;
    if (!m || !m.alive || !m.group) continue;
    if (pp && m.group.position.distanceToSquared(pp) > RANGE_SQ) continue;
    const wps = m.weakPoints;
    if (!wps) continue;
    for (let i = 0; i < wps.length && mi < pool.length; i++) {
      const wp = wps[i];
      if (wp.broken || !wp.mesh) continue;
      wp.mesh.getWorldPosition(_v);
      const s = pool[mi++];
      s.position.set(_v.x, _v.y + 0.32, _v.z);
      s.scale.set(scale, scale, 1);
      s.visible = true;
    }
  }
  for (; mi < pool.length; mi++) pool[mi].visible = false;
}
