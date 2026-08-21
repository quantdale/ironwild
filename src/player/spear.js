// IRONWILD - hunting spear quick-melee (v3). KeyF swings the spear carried in
// the right hand ('handR' anchor on the player rig): 2.4u reach inside a
// +/-55 deg camera-forward cone, 26 body damage / 39 on weak-point contact,
// 0.8s cooldown, short forward lunge. Damage flows through machine.hit()
// exactly like arrows do, followed by the same 'machineHit'/'hitMarker'
// events so FX and audio react identically. The swing pose itself is driven
// through G.player.meleeT (0..1), consumed by player.js's animator.

import * as THREE from 'three';
import { G } from '../core/state.js';
import { bus } from '../core/events.js';
import { Input } from '../core/input.js';
import { clamp } from '../core/utils.js';
import { sfx } from '../audio/audio.js';

// Tuning (ARCHITECTURE_V3.md row melee-spear).
const MELEE_RANGE = 2.4;                          // sphere-center reach
const CONE_COS = Math.cos((55 * Math.PI) / 180);  // camera-forward half-angle
const DMG_BODY = 26;
const DMG_WEAK = 40;                              // flat bonus on weak-point contact
const COOLDOWN = 0.8;          // s between swings
const LUNGE_DIST = 1.2;        // forward lunge distance
const LUNGE_TIME = 0.15;       // s the lunge lasts
const SWING_TIME = 0.35;       // s of swing animation (meleeT ramp)
const CHEST_HEIGHT = 0.9;      // query origin above the feet

// Palette (ARCHITECTURE.md style guide).
const WOOD_COLOR = 0x6b4a2f;
const LEATHER_COLOR = 0x4a3220;
const HEAD_COLOR = 0x3a3f46;

// Module-scope temps - reused every frame, never reallocated in hot loops.
const _origin = new THREE.Vector3();   // chest-height query origin
const _fwd = new THREE.Vector3();      // camera forward this frame
const _toC = new THREE.Vector3();      // origin -> sphere center scratch
const _point = new THREE.Vector3();    // best contact center / impact point
const _lungeDir = new THREE.Vector3(0, 0, -1);
const _lunge = new THREE.Vector3();

let _installed = false;
let _attached = false;
let _spearRoot = null;

// Swing state: cooldown countdown, swing-anim clock, lunge clock (<0 = idle).
let _cdT = 0;
let _swingT = -1;
let _lungeT = -1;

/** Build the low-poly hunting spear: wood shaft, leather binding, steel head. */
function buildSpearMesh() {
  const woodMat = new THREE.MeshStandardMaterial({ color: WOOD_COLOR, flatShading: true });
  const leatherMat = new THREE.MeshStandardMaterial({ color: LEATHER_COLOR, flatShading: true });
  const headMat = new THREE.MeshStandardMaterial({ color: HEAD_COLOR, flatShading: true });

  _spearRoot = new THREE.Group();
  _spearRoot.name = 'spear';

  // Shaft lies along +Y in holder space; the holder maps +Y -> -Z so the
  // blade points forward out of the fist (-Z is facing in rig space).
  const holder = new THREE.Group();
  holder.rotation.x = -Math.PI / 2;
  _spearRoot.add(holder);

  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.024, 1.5, 6), woodMat);
  shaft.position.y = 0.30; // butt 0.45 below the grip, head base ~1.05 above
  holder.add(shaft);

  const bind = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.09, 6), leatherMat);
  bind.position.y = 0.79;
  holder.add(bind);

  const head = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.22, 6), headMat);
  head.position.y = 1.16; // tip reaches ~1.27 past the fist
  holder.add(head);

  const butt = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.06, 6), leatherMat);
  butt.position.y = -0.42;
  holder.add(butt);

  _spearRoot.traverse((o) => { if (o.isMesh) o.castShadow = true; });
}

/** Attach to the right-hand anchor once the player rig exists (bow pattern). */
function tryAttach() {
  if (_attached || !_spearRoot) return;
  const group = G.player && G.player.group;
  if (!group) return;
  const hand = group.getObjectByName('handR');
  if (hand) {
    hand.add(_spearRoot); // bone already carries the placement
  } else {
    _spearRoot.position.set(0.25, 1.3, 0.35); // fallback: right-side hip carry
    group.add(_spearRoot);
  }
  _attached = true;
}

/** Build the spear and install it on the player's right hand. Call once at boot. */
export function createSpear() {
  if (_installed) return;
  _installed = true;
  buildSpearMesh();
}

/**
 * Is the sphere center (held in _toC) within reach of _origin plus radius
 * slack, and inside the camera-forward cone? Returns the center distance,
 * or -1 when out of range/arc. Mutates _toC into an origin-relative vector.
 */
function contactDist(radius) {
  _toC.sub(_origin);
  const d = _toC.length();
  if (d > MELEE_RANGE + radius) return -1;
  if (d < 1e-5) return 0;
  if (_toC.dot(_fwd) / d < CONE_COS) return -1;
  return d;
}

/**
 * Resolve one swing against every alive machine: nearest qualifying weak
 * point first, else nearest body sphere (same priority order as arrows).
 * Each machine is struck at most once per swing. Damage goes through
 * machine.hit exactly like projectiles.js, then the same event pair follows
 * so FX/audio react identically. Returns true when any machine was struck.
 */
function applySwingHits() {
  const player = G.player;
  _origin.copy(player.pos);
  _origin.y += CHEST_HEIGHT;
  _fwd.copy(G.cam.forward); // unit length, refreshed by camera.js this frame

  let hitAny = false;

  for (let mi = 0; mi < G.machines.length; mi++) {
    const m = G.machines[mi];
    if (!m.alive) continue;

    let wp = null;        // chosen contact: weak point ref, or null for body
    let found = false;
    let bestD = Infinity;
    let radius = 0;

    const wps = m.weakPoints;
    if (wps) {
      for (let wi = 0; wi < wps.length; wi++) {
        const w = wps[wi];
        if (w.broken || !w.mesh) continue; // broken part -> falls through to body
        w.mesh.getWorldPosition(_toC);
        const d = contactDist(w.radius);
        if (d >= 0 && d < bestD) {
          bestD = d; wp = w; found = true; radius = w.radius;
          _point.copy(_toC).add(_origin);
        }
      }
    }

    if (!wp) {
      const bods = m.bodySpheres;
      if (bods) {
        for (let bi = 0; bi < bods.length; bi++) {
          const bs = bods[bi];
          _toC.copy(bs.localPos);
          m.group.localToWorld(_toC);
          const d = contactDist(bs.radius);
          if (d >= 0 && d < bestD) {
            bestD = d; wp = null; found = true; radius = bs.radius;
            _point.copy(_toC).add(_origin);
          }
        }
      }
    }

    if (!found) continue;

    // Impact point: push the center to the sphere surface toward the player
    // (mirrors the arrow FX projection in projectiles.js).
    _toC.copy(_point).sub(_origin);
    const dl = _toC.length();
    if (dl > 1e-5) _toC.multiplyScalar(-radius / dl);
    _point.add(_toC);

    const dmg = wp ? DMG_WEAK : DMG_BODY;
    const pt = _point.clone(); // single heap alloc per hit, shared by hit()+FX
    m.hit(dmg, pt, wp);        // wp===null -> plain body hit
    bus.emit('machineHit', {
      machine: m,
      point: pt,
      damage: dmg,
      weak: !!wp,
      partName: wp ? wp.name : null,
    });
    bus.emit('hitMarker', { weak: !!wp });
    if (wp) bus.emit('camShake', { amp: 0.35 }); // weak-point impacts jolt, like arrows
    hitAny = true;
  }

  return hitAny;
}

/** Trigger one swing: cooldown, whoosh, lunge vector, instant hit query. */
function startSwing(player) {
  _cdT = COOLDOWN;
  _swingT = 0;
  player.meleeT = 0;
  sfx('dodge'); // reused filtered-noise sweep reads as a melee whoosh

  // Lunge along the camera's horizontal forward.
  _lungeDir.set(G.cam.forward.x, 0, G.cam.forward.z);
  if (_lungeDir.lengthSq() < 1e-6) _lungeDir.set(0, 0, -1);
  _lungeDir.normalize();
  _lungeT = 0;

  const hitAny = applySwingHits();
  bus.emit('meleeSwing', { hit: hitAny });
}

/** Frame update; dt is already time-scaled by main.js (runs after bow step). */
export function updateSpear(dt) {
  tryAttach();

  const player = G.player;
  if (!player) return;
  if (!(dt > 0)) return; // paused/frozen frame: hold all swing state

  // Trigger: KeyF, gated on swimming / bow drawing / cooldown (row contract).
  if (
    !player.dead && G.started && !G.paused && !G.gameOver &&
    Input.pressed('KeyF') && _cdT <= 0 &&
    !player.swimming && !player.drawing
  ) {
    startSwing(player);
  }

  // Swing anim channel 0..1, consumed by player.js's arm/torso animator.
  if (_swingT >= 0) {
    _swingT += dt;
    if (_swingT >= SWING_TIME) {
      _swingT = -1;
      player.meleeT = 0;
    } else {
      player.meleeT = clamp(_swingT / SWING_TIME, 0, 1);
    }
  } else if (player.meleeT !== 0) {
    player.meleeT = 0; // keep the channel clean after death/pause edge cases
  }

  // Forward lunge: direct position advance (this step runs after player.update,
  // which re-snaps ground height next frame). Horizontal only, velocity untouched.
  if (_lungeT >= 0) {
    _lungeT += dt;
    if (_lungeT >= LUNGE_TIME) {
      _lungeT = -1;
    } else {
      _lunge.copy(_lungeDir).multiplyScalar((LUNGE_DIST / LUNGE_TIME) * dt);
      player.pos.add(_lunge);
    }
  }

  if (_cdT > 0) _cdT = Math.max(0, _cdT - dt);
}
