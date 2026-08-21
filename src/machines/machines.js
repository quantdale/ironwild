// IRONWILD - machine bodies (procedural primitives) + damage / death / loot.
// Builds the nine roster machines (four v1 + v2 duskwing/bulwark/vantage
// + v3 mirefang/monarch); the brain driving them lives in ai.js.

import * as THREE from 'three';
import { bus } from '../core/events.js';
import { G, CONFIG } from '../core/state.js';
import { clamp, damp, smoothstep, randRange } from '../core/utils.js';
import { heightAt } from '../world/terrain.js';
import { spawnPickup } from '../world/props.js';
import { sfx } from '../audio/audio.js';

// Shared unit geometries, scaled per part. Cached at module scope and never
// disposed, so machine dispose() only releases materials.
const GEO_BOX = new THREE.BoxGeometry(1, 1, 1);
const GEO_CYL = new THREE.CylinderGeometry(1, 1, 1, 10);
const GEO_SPH = new THREE.SphereGeometry(1, 10, 8);
const GEO_CONE = new THREE.ConeGeometry(1, 1, 8);
const GEO_CIRCLE = new THREE.CircleGeometry(1, 20);

const SCRAP_MAT = new THREE.MeshStandardMaterial({
  color: 0x22262b, flatShading: true, roughness: 0.9, metalness: 0.4,
});

/** Seconds a carcass sticks around after the death tip-over (v2 harvest window). */
export const CARCASS_LIFE = 25;

const _v1 = new THREE.Vector3();

// ---------------------------------------------------------------- helpers --

function stdMat(hex) {
  return new THREE.MeshStandardMaterial({ color: hex, flatShading: true, roughness: 0.85, metalness: 0.3 });
}
function glowMat() {
  return new THREE.MeshStandardMaterial({
    color: 0x10333c, emissive: 0x59e3ff, emissiveIntensity: 1.6,
    flatShading: true, roughness: 0.35, metalness: 0.1,
  });
}
function makeMaterials() {
  // Fresh instances per machine so damage flashes / fades never leak across.
  return { hull: stdMat(0x3a3f46), rust: stdMat(0x8a4b32), joint: stdMat(0x23262b), glow: glowMat };
}

function addPart(parent, geo, mat, sx, sy, sz, x, y, z, rx = 0, ry = 0, rz = 0) {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.set(sx, sy, sz);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  parent.add(mesh);
  return mesh;
}
const addBox = (p, mat, sx, sy, sz, x, y, z, rx = 0, ry = 0, rz = 0) =>
  addPart(p, GEO_BOX, mat, sx, sy, sz, x, y, z, rx, ry, rz);

/** Simple piston leg: pivot group at the hip, cylinder hanging down, optional foot. */
function addLeg(parent, mats, r, len, x, y, z, footSize = 0) {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);
  parent.add(pivot);
  addPart(pivot, GEO_CYL, mats.joint, r, len, r, 0, -len / 2, 0);
  if (footSize > 0) addBox(pivot, mats.joint, footSize, 0.08, footSize * 1.25, 0, -len, 0.04);
  return pivot;
}

/** Two-segment raptor leg: hip pivot -> thigh -> knee pivot -> shin + foot + claws. */
function addRaptorLeg(parent, mats, x, y, z) {
  const hip = new THREE.Group();
  hip.position.set(x, y, z);
  parent.add(hip);
  addBox(hip, mats.hull, 0.17, 0.46, 0.22, 0, -0.23, 0.02);
  const knee = new THREE.Group();
  knee.position.set(0, -0.46, 0);
  hip.add(knee);
  addPart(knee, GEO_CYL, mats.joint, 0.06, 0.54, 0.06, 0, -0.27, 0);
  addBox(knee, mats.joint, 0.17, 0.06, 0.3, 0, -0.55, 0.06);
  addPart(knee, GEO_CONE, mats.rust, 0.03, 0.14, 0.03, 0.05, -0.6, 0.17, -1.2, 0, 0);
  addPart(knee, GEO_CONE, mats.rust, 0.03, 0.14, 0.03, -0.05, -0.6, 0.17, -1.2, 0, 0);
  return { hip, knee };
}

function addBodySphere(m, x, y, z, r) {
  m.bodySpheres.push({ localPos: new THREE.Vector3(x, y, z), radius: r });
}

/** Register a glowing weak point; `mat` is its dedicated (per-machine) glow material. */
function registerWeakPoint(m, name, mesh, x, y, z, radius, multiplier, hp, mat) {
  const wp = {
    name, mesh, localPos: new THREE.Vector3(x, y, z),
    radius, multiplier, hp, maxHp: hp, broken: false, _mats: [mat],
  };
  mesh.traverse((o) => {
    if (o.isMesh && o.material && !wp._mats.includes(o.material)) wp._mats.push(o.material);
  });
  m.weakPoints.push(wp);
  m._anim.glowMats.push(mat);
  return wp;
}

// ------------------------------------------------------------- body plans --
// All machines face +Z (head at positive z); legs attach to the root group so
// body bob / crouch never moves the feet.

function buildSkitter(m, mats) {
  const g = m.group;
  const body = new THREE.Group();
  g.add(body);
  m._anim.body = body;
  m._anim.crouchDrop = 0.18; // leap telegraph squats the body

  // torso + plating
  addBox(body, mats.hull, 0.62, 0.5, 1.15, 0, 0.72, 0);
  addBox(body, mats.rust, 0.5, 0.09, 0.72, 0, 1.0, -0.08);
  addBox(body, mats.rust, 0.64, 0.1, 0.2, 0, 0.62, -0.5);

  // head + snout + antenna
  addBox(body, mats.hull, 0.34, 0.3, 0.42, 0, 0.84, 0.68);
  addBox(body, mats.joint, 0.2, 0.16, 0.22, 0, 0.78, 0.94);
  addPart(body, GEO_CYL, mats.joint, 0.015, 0.34, 0.015, 0.14, 1.16, 0.3, 0.15, 0, -0.2);

  // sensor eye (weak point 'optic')
  const eye = new THREE.Group();
  eye.position.set(0, 0.97, 0.87);
  body.add(eye);
  addPart(eye, GEO_CYL, mats.joint, 0.11, 0.07, 0.11, 0, 0, 0, Math.PI / 2, 0, 0);
  const lensMat = mats.glow();
  addPart(eye, GEO_SPH, lensMat, 0.115, 0.115, 0.07, 0, 0, 0.045);
  registerWeakPoint(m, 'optic', eye, 0, 0.97, 0.87, 0.28, 2.5, 40, lensMat);

  // tail stub
  addBox(body, mats.joint, 0.12, 0.1, 0.24, 0, 0.8, -0.66);

  // four legs, diagonal pairs
  const defs = [[-0.26, 0.4], [0.26, 0.4], [-0.26, -0.4], [0.26, -0.4]];
  const offs = [0, Math.PI, Math.PI, 0];
  defs.forEach(([lx, lz], i) => {
    const pivot = addLeg(g, mats, 0.06, 0.62, lx, 0.62, lz, 0.1);
    m._anim.legs.push({ pivot, amp: 0.55, offset: offs[i] });
  });

  addBodySphere(m, 0, 0.75, 0, 0.48);
  addBodySphere(m, 0, 0.88, 0.6, 0.3);
}

function buildBramblehorn(m, mats) {
  const g = m.group;
  const body = new THREE.Group();
  g.add(body);
  m._anim.body = body;

  // slim torso + plating
  addBox(body, mats.hull, 0.55, 0.55, 1.35, 0, 1.08, 0);
  addBox(body, mats.rust, 0.45, 0.08, 1.0, 0, 1.39, -0.05);
  addBox(body, mats.rust, 0.5, 0.12, 0.5, 0, 0.83, 0.35);

  // long neck + head + snout + ears
  addBox(body, mats.hull, 0.24, 0.72, 0.26, 0, 1.55, 0.56, -0.45, 0, 0);
  addBox(body, mats.hull, 0.27, 0.28, 0.5, 0, 1.93, 0.79);
  addBox(body, mats.joint, 0.16, 0.17, 0.32, 0, 1.88, 1.08);
  addBox(body, mats.joint, 0.06, 0.14, 0.1, 0.12, 2.08, 0.72);
  addBox(body, mats.joint, 0.06, 0.14, 0.1, -0.12, 2.08, 0.72);

  // antler branches
  for (const s of [1, -1]) {
    addPart(body, GEO_CYL, mats.joint, 0.025, 0.5, 0.025, s * 0.13, 2.28, 0.62, -0.5, 0, s * 0.45);
    addPart(body, GEO_CYL, mats.joint, 0.018, 0.26, 0.018, s * 0.26, 2.42, 0.52, -0.9, 0, s * 0.9);
    addPart(body, GEO_CYL, mats.joint, 0.018, 0.22, 0.018, s * 0.3, 2.3, 0.74, -0.2, 0, s * 1.1);
    addPart(body, GEO_CYL, mats.joint, 0.016, 0.2, 0.016, s * 0.05, 2.5, 0.68, -1.3, 0, s * 0.2);
  }

  // tail nub
  addPart(body, GEO_CONE, mats.joint, 0.07, 0.3, 0.07, 0, 1.22, -0.76, 1.9, 0, 0);

  // fuel sac under the belly (weak point 'fuelsac')
  const sacMat = mats.glow();
  const sac = addPart(body, GEO_SPH, sacMat, 0.3, 0.26, 0.38, 0, 0.74, 0.12);
  registerWeakPoint(m, 'fuelsac', sac, 0, 0.74, 0.12, 0.4, 2, 50, sacMat);

  // power cell on the back (weak point 'cell')
  const cellMat = mats.glow();
  const cell = new THREE.Group();
  cell.position.set(0, 1.47, -0.22);
  body.add(cell);
  addBox(cell, mats.rust, 0.36, 0.06, 0.5, 0, -0.06, 0);
  addPart(cell, GEO_BOX, cellMat, 0.28, 0.2, 0.4, 0, 0.08, 0);
  registerWeakPoint(m, 'cell', cell, 0, 1.47, -0.22, 0.3, 2, 45, cellMat);

  // four long slender legs
  const defs = [[-0.2, 0.48], [0.2, 0.48], [-0.2, -0.48], [0.2, -0.48]];
  const offs = [0, Math.PI, Math.PI, 0];
  defs.forEach(([lx, lz], i) => {
    const pivot = addLeg(g, mats, 0.05, 0.95, lx, 0.95, lz, 0.09);
    m._anim.legs.push({ pivot, amp: 0.5, offset: offs[i] });
  });

  addBodySphere(m, 0, 1.1, 0.32, 0.42);
  addBodySphere(m, 0, 1.1, -0.35, 0.4);
  addBodySphere(m, 0, 1.9, 0.78, 0.26);
}

function buildRendclaw(m, mats) {
  const g = m.group;
  const body = new THREE.Group();
  g.add(body);
  m._anim.body = body;

  // horizontal torso + chest + spine strips
  addBox(body, mats.hull, 0.6, 0.55, 1.45, 0, 1.05, 0);
  addBox(body, mats.hull, 0.5, 0.48, 0.55, 0, 1.1, 0.5);
  addBox(body, mats.rust, 0.62, 0.08, 0.5, 0, 1.36, 0.1);
  addBox(body, mats.rust, 0.62, 0.08, 0.3, 0, 1.36, -0.45);

  // tail
  addBox(body, mats.joint, 0.3, 0.22, 0.75, 0, 1.14, -1.0, 0.12, 0, 0);
  addBox(body, mats.joint, 0.18, 0.13, 0.65, 0, 1.26, -1.6, 0.18, 0, 0);
  addPart(body, GEO_CONE, mats.rust, 0.09, 0.3, 0.09, 0, 1.36, -1.98, 1.75, 0, 0);

  // neck + head + upper snout
  addBox(body, mats.hull, 0.26, 0.34, 0.4, 0, 1.32, 0.78, -0.5, 0, 0);
  addBox(body, mats.hull, 0.3, 0.26, 0.55, 0, 1.52, 1.02);
  addBox(body, mats.joint, 0.2, 0.12, 0.42, 0, 1.5, 1.32);

  // hinged lower jaw (opens during attacks)
  const jaw = new THREE.Group();
  jaw.position.set(0, 1.4, 1.08);
  body.add(jaw);
  addBox(jaw, mats.joint, 0.17, 0.07, 0.44, 0, -0.02, 0.2);
  addPart(jaw, GEO_CONE, mats.rust, 0.025, 0.1, 0.025, 0.06, 0.04, 0.4, 1.5, 0, 0);
  addPart(jaw, GEO_CONE, mats.rust, 0.025, 0.1, 0.025, -0.06, 0.04, 0.4, 1.5, 0, 0);
  m._anim.jaw = jaw;

  // decorative eye lenses
  const eyeMat = mats.glow();
  addPart(body, GEO_SPH, eyeMat, 0.05, 0.05, 0.04, 0.1, 1.58, 1.2);
  addPart(body, GEO_SPH, eyeMat, 0.05, 0.05, 0.04, -0.1, 1.58, 1.2);

  // exposed neck cable (weak point 'neckcord')
  const cordMat = mats.glow();
  const cord = new THREE.Group();
  cord.position.set(0, 1.34, 0.86);
  body.add(cord);
  addPart(cord, GEO_CYL, cordMat, 0.05, 0.5, 0.05, 0, 0.05, 0.1, 0.9, 0, 0);
  addPart(cord, GEO_CYL, mats.joint, 0.075, 0.05, 0.075, 0, 0.24, -0.1, 0.4, 0, 0);
  addPart(cord, GEO_CYL, mats.joint, 0.075, 0.05, 0.075, 0, -0.12, 0.22, 0.4, 0, 0);
  registerWeakPoint(m, 'neckcord', cord, 0, 1.34, 0.86, 0.32, 2.2, 60, cordMat);

  // small clawed arms
  for (const s of [1, -1]) {
    addBox(body, mats.joint, 0.09, 0.09, 0.34, s * 0.32, 1.12, 0.62);
    addPart(body, GEO_CONE, mats.rust, 0.03, 0.14, 0.03, s * 0.32, 1.1, 0.84, 1.5, 0, 0);
  }

  // two strong legs (hip + knee)
  for (const s of [1, -1]) {
    const { hip, knee } = addRaptorLeg(g, mats, s * 0.24, 1.0, 0.12);
    m._anim.legs.push({ pivot: hip, amp: 0.6, offset: s > 0 ? 0 : Math.PI });
    m._anim.knees.push({ knee, base: 0.2, amp: 0.5 });
  }

  addBodySphere(m, 0, 1.1, 0.15, 0.5);
  addBodySphere(m, 0, 1.15, 0.6, 0.36);
  addBodySphere(m, 0, 1.12, -0.6, 0.32);
  addBodySphere(m, 0, 1.5, 1.05, 0.28);
}

function buildIronmaw(m, mats) {
  const g = m.group;
  const body = new THREE.Group();
  g.add(body);
  m._anim.body = body;

  // wide chassis + top deck + sloped face plate
  addBox(body, mats.hull, 1.5, 0.95, 1.95, 0, 1.05, 0);
  addBox(body, mats.rust, 1.3, 0.16, 1.4, 0, 1.6, -0.12);
  addBox(body, mats.hull, 1.34, 0.72, 0.22, 0, 1.18, 1.0, 0.28, 0, 0);

  // shoulder plates + exhaust stacks
  addBox(body, mats.rust, 0.5, 0.38, 0.85, 0.86, 1.58, 0.12, 0, 0, -0.14);
  addBox(body, mats.rust, 0.5, 0.38, 0.85, -0.86, 1.58, 0.12, 0, 0, 0.14);
  addPart(body, GEO_CYL, mats.joint, 0.08, 0.42, 0.08, 0.5, 1.88, 0.55);
  addPart(body, GEO_CYL, mats.joint, 0.08, 0.42, 0.08, -0.5, 1.88, 0.55);

  // mouth grinder (spins while aggro)
  const grinder = new THREE.Group();
  grinder.position.set(0, 0.82, 1.14);
  body.add(grinder);
  addPart(grinder, GEO_CYL, mats.joint, 0.34, 0.16, 0.34, 0, 0, 0, Math.PI / 2, 0, 0);
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    addBox(grinder, mats.rust, 0.09, 0.1, 0.08, Math.cos(ang) * 0.36, Math.sin(ang) * 0.36, 0);
  }
  m._anim.grinder = grinder;

  // jaw plates flanking the grinder
  addBox(body, mats.joint, 0.26, 0.44, 0.55, 0.5, 0.95, 1.02, 0, 0.25, 0);
  addBox(body, mats.joint, 0.26, 0.44, 0.55, -0.5, 0.95, 1.02, 0, -0.25, 0);

  // back power core (weak point 'core')
  const coreMat = mats.glow();
  const core = new THREE.Group();
  core.position.set(0, 1.86, -0.38);
  body.add(core);
  addBox(core, mats.rust, 0.9, 0.12, 0.9, 0, -0.32, 0);
  addPart(core, GEO_CYL, mats.joint, 0.46, 0.08, 0.46, 0, -0.22, 0);
  addPart(core, GEO_SPH, coreMat, 0.4, 0.4, 0.4, 0, 0.05, 0);
  registerWeakPoint(m, 'core', core, 0, 1.86, -0.38, 0.5, 1.8, 90, coreMat);

  // four stubby legs
  const defs = [[-0.6, 0.7], [0.6, 0.7], [-0.6, -0.7], [0.6, -0.7]];
  const offs = [0, Math.PI, Math.PI, 0];
  defs.forEach(([lx, lz], i) => {
    const pivot = addLeg(g, mats, 0.16, 0.6, lx, 0.6, lz, 0.24);
    m._anim.legs.push({ pivot, amp: 0.35, offset: offs[i] });
  });

  addBodySphere(m, 0, 1.05, 0, 1.0);
  addBodySphere(m, 0, 1.1, 0.85, 0.7);
  addBodySphere(m, 0, 1.05, -0.85, 0.7);
}

function buildDuskwing(m, mats) {
  const g = m.group;
  const body = new THREE.Group();
  g.add(body);
  m._anim.body = body;

  // torso + chest plate + spine strip
  addBox(body, mats.hull, 0.46, 0.42, 1.05, 0, 0.62, 0);
  addBox(body, mats.rust, 0.38, 0.08, 0.6, 0, 0.86, 0.12);
  addBox(body, mats.rust, 0.3, 0.06, 0.34, 0, 0.56, -0.42);

  // head + beak + crest fin
  addBox(body, mats.hull, 0.26, 0.24, 0.36, 0, 0.78, 0.66);
  addPart(body, GEO_CONE, mats.joint, 0.07, 0.34, 0.07, 0, 0.74, 0.94, 1.5, 0, 0);
  addBox(body, mats.rust, 0.05, 0.16, 0.22, 0, 0.98, 0.58, -0.3, 0, 0);

  // tail fan
  addBox(body, mats.joint, 0.3, 0.05, 0.5, 0, 0.68, -0.72, 0.18, 0, 0);
  addBox(body, mats.rust, 0.34, 0.04, 0.3, 0, 0.74, -0.98, 0.3, 0, 0);

  // tucked talons
  for (const s of [1, -1]) {
    addPart(body, GEO_CYL, mats.joint, 0.05, 0.3, 0.05, s * 0.16, 0.36, 0.1, 0.5, 0, 0);
    addPart(body, GEO_CONE, mats.rust, 0.03, 0.12, 0.03, s * 0.16, 0.2, 0.2, 2.2, 0, 0);
  }

  // wings: shoulder pivots double as flap joints (driven by the gait code).
  // The OUTER membrane panel of each wing is the weak point; the inner panel
  // is plain plating so body shots near the torso don't read as wing hits.
  for (const s of [1, -1]) {
    const wing = new THREE.Group();
    wing.position.set(s * 0.34, 0.78, 0.02);
    body.add(wing);
    addPart(wing, GEO_BOX, mats.hull, 0.95, 0.07, 0.09, s * 0.45, 0.02, 0.16); // leading spar
    addPart(wing, GEO_BOX, mats.rust, 0.6, 0.04, 0.36, s * 0.32, 0, -0.04);    // inner membrane plating
    const memMat = mats.glow();
    const membrane = new THREE.Group();
    membrane.position.set(s * 1.02, 0, -0.14);
    membrane.rotation.y = s * 0.2;
    wing.add(membrane);
    addPart(membrane, GEO_BOX, memMat, 0.62, 0.04, 0.34, 0, 0, 0);
    addPart(membrane, GEO_BOX, mats.joint, 0.55, 0.05, 0.07, 0, 0.01, -0.19);
    registerWeakPoint(m, s > 0 ? 'wingR' : 'wingL', membrane, s * 1.36, 0.78, -0.12, 0.45, 1.8, 45, memMat);
    m._anim.legs.push({ pivot: wing, amp: 0.65, offset: s > 0 ? 0 : Math.PI }); // flap with gait phase
  }

  addBodySphere(m, 0, 0.64, 0, 0.42);
  addBodySphere(m, 0, 0.7, 0.5, 0.3);
  addBodySphere(m, 0, 0.8, 0.72, 0.24);

  // dive telegraph shadow (world-space disc under the marked splash point;
  // grown/hidden by ai.js, removed on dispose)
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x05070a, transparent: true, opacity: 0, depthWrite: false,
  });
  const shadow = new THREE.Mesh(GEO_CIRCLE, shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.renderOrder = 1;
  shadow.visible = false;
  if (G.scene) G.scene.add(shadow);
  m._anim.shadowMesh = shadow;
  m._anim.shadowMat = shadowMat;
}

function buildBulwark(m, mats) {
  const g = m.group;
  const body = new THREE.Group();
  g.add(body);
  m._anim.body = body;

  // pill hull: lying cylinder + rounded caps
  addPart(body, GEO_CYL, mats.hull, 0.78, 1.7, 0.78, 0, 0.95, 0, Math.PI / 2, 0, 0);
  addPart(body, GEO_SPH, mats.hull, 0.78, 0.78, 0.78, 0, 0.95, 0.85);
  addPart(body, GEO_SPH, mats.hull, 0.78, 0.78, 0.78, 0, 0.95, -0.85);
  // top deck plates
  addBox(body, mats.rust, 0.9, 0.1, 1.5, 0, 1.76, 0);
  addBox(body, mats.rust, 0.7, 0.08, 0.5, 0, 1.5, 0.4);

  // FRONT ARMOR CONE - visually distinct darker plate; arrows striking inside
  // its +/-60 deg cone deflect harmlessly (see applyHit).
  addPart(body, GEO_CONE, mats.joint, 0.72, 0.9, 0.72, 0, 0.98, 1.55, 1.5, 0, 0);
  addBox(body, mats.joint, 1.3, 0.85, 0.18, 0, 0.98, 1.12, 0.12, 0, 0);
  addPart(body, GEO_CYL, mats.joint, 0.1, 0.5, 0.1, 0.45, 1.3, 1.05, 0.9, 0, 0);
  addPart(body, GEO_CYL, mats.joint, 0.1, 0.5, 0.1, -0.45, 1.3, 1.05, 0.9, 0, 0);
  addBox(body, mats.glow(), 0.5, 0.06, 0.06, 0, 1.28, 1.24); // sensor slit (decorative)

  // REAR EXHAUST VENTS (weak point 'vents' - the only way in)
  const ventMat = mats.glow();
  const vents = new THREE.Group();
  vents.position.set(0, 1.1, -1.28);
  body.add(vents);
  for (let i = 0; i < 3; i++) {
    addBox(vents, mats.joint, 0.62, 0.16, 0.1, 0, -0.18 + i * 0.18, 0);
    addPart(vents, GEO_BOX, ventMat, 0.5, 0.07, 0.06, 0, -0.18 + i * 0.18, -0.06);
  }
  registerWeakPoint(m, 'vents', vents, 0, 1.1, -1.28, 0.6, 2.0, 55, ventMat);

  // four stubby legs
  const defs = [[-0.5, 0.45], [0.5, 0.45], [-0.5, -0.45], [0.5, -0.45]];
  const offs = [0, Math.PI, Math.PI, 0];
  defs.forEach(([lx, lz], i) => {
    const pivot = addLeg(g, mats, 0.13, 0.55, lx, 0.55, lz, 0.2);
    m._anim.legs.push({ pivot, amp: 0.4, offset: offs[i] });
  });

  addBodySphere(m, 0, 0.95, 0, 0.95);
  addBodySphere(m, 0, 0.98, 0.8, 0.7);
  addBodySphere(m, 0, 0.98, -0.8, 0.7);
}

function buildVantage(m, mats) {
  const g = m.group;
  const body = new THREE.Group();
  g.add(body);
  m._anim.body = body;

  // torso + back panels + tail counterweight
  addBox(body, mats.hull, 0.6, 0.6, 1.15, 0, 2.5, 0);
  addBox(body, mats.rust, 0.5, 0.08, 0.9, 0, 2.84, -0.05);
  addBox(body, mats.rust, 0.52, 0.14, 0.4, 0, 2.28, 0.3);
  addBox(body, mats.joint, 0.2, 0.24, 0.5, 0, 2.56, -0.78);

  // long segmented neck + head + snout + ear fins
  addBox(body, mats.hull, 0.2, 0.9, 0.22, 0, 3.2, 0.5, -0.35, 0, 0);
  addBox(body, mats.hull, 0.18, 0.8, 0.2, 0, 4.0, 0.72, -0.25, 0, 0);
  addBox(body, mats.hull, 0.22, 0.26, 0.42, 0, 4.5, 0.86);
  addBox(body, mats.joint, 0.14, 0.14, 0.26, 0, 4.46, 1.12);
  addBox(body, mats.joint, 0.05, 0.18, 0.12, 0.12, 4.72, 0.82);
  addBox(body, mats.joint, 0.05, 0.18, 0.12, -0.12, 4.72, 0.82);

  // scanning dish (weak point 'uplink')
  const dishMat = mats.glow();
  const dish = new THREE.Group();
  dish.position.set(0, 4.62, 0.7);
  body.add(dish);
  addPart(dish, GEO_CYL, mats.joint, 0.2, 0.06, 0.2, 0, 0.06, 0, 0.5, 0, 0);
  addPart(dish, GEO_SPH, dishMat, 0.11, 0.11, 0.11, 0, 0.12, 0.04);
  registerWeakPoint(m, 'uplink', dish, 0, 4.62, 0.7, 0.34, 2, 50, dishMat);

  // side sensor strips (decorative)
  addBox(body, mats.glow(), 0.04, 0.3, 0.5, 0.32, 2.6, 0.05);
  addBox(body, mats.glow(), 0.04, 0.3, 0.5, -0.32, 2.6, 0.05);

  // four very long slender legs
  const defs = [[-0.22, 0.42], [0.22, 0.42], [-0.22, -0.42], [0.22, -0.42]];
  const offs = [0, Math.PI, Math.PI, 0];
  defs.forEach(([lx, lz], i) => {
    const pivot = addLeg(g, mats, 0.055, 2.2, lx, 2.2, lz, 0.11);
    m._anim.legs.push({ pivot, amp: 0.35, offset: offs[i] });
  });

  addBodySphere(m, 0, 2.5, 0, 0.55);
  addBodySphere(m, 0, 3.6, 0.55, 0.3);
  addBodySphere(m, 0, 4.55, 0.85, 0.3);
}

function buildMirefang(m, mats) {
  const g = m.group;
  const body = new THREE.Group();
  g.add(body);
  m._anim.body = body;

  // low flat torso + stepped spine scutes + rear hip fairing
  addBox(body, mats.hull, 1.05, 0.52, 2.2, 0, 0.6, -0.05);
  addBox(body, mats.rust, 0.72, 0.08, 0.5, 0, 0.9, 0.45);
  addBox(body, mats.rust, 0.8, 0.08, 0.55, 0, 0.92, -0.05);
  addBox(body, mats.rust, 0.72, 0.08, 0.5, 0, 0.9, -0.55);
  addBox(body, mats.rust, 1.12, 0.14, 0.4, 0, 0.76, -0.85);

  // skull + long snout with hanging teeth
  addBox(body, mats.hull, 0.6, 0.3, 0.55, 0, 0.66, 1.25);
  addBox(body, mats.joint, 0.34, 0.16, 0.85, 0, 0.58, 1.9);
  for (const s of [1, -1]) {
    addPart(body, GEO_CONE, mats.rust, 0.02, 0.09, 0.02, s * 0.19, 0.47, 1.65, Math.PI, 0, 0);
    addPart(body, GEO_CONE, mats.rust, 0.02, 0.11, 0.02, s * 0.19, 0.46, 1.95, Math.PI, 0, 0);
  }

  // brow ridges sit on the body so the 'eye' weak point holds only its own
  // glow material (breaking it must not char shared machine materials)
  addBox(body, mats.joint, 0.16, 0.06, 0.16, 0.17, 0.92, 1.21);
  addBox(body, mats.joint, 0.16, 0.06, 0.16, -0.17, 0.92, 1.21);

  // twin eye lenses (weak point 'eye')
  const eyeMat = mats.glow();
  const eye = new THREE.Group();
  eye.position.set(0, 0.84, 1.18);
  body.add(eye);
  addPart(eye, GEO_SPH, eyeMat, 0.09, 0.07, 0.09, 0.17, 0.02, 0.05);
  addPart(eye, GEO_SPH, eyeMat, 0.09, 0.07, 0.09, -0.17, 0.02, 0.05);
  registerWeakPoint(m, 'eye', eye, 0, 0.84, 1.18, 0.34, 2.2, 35, eyeMat);

  // nostril glows at the snout tip: the only part that breaks the surface
  // while dormant-submerged (ai.js reads _anim.nostrilMats)
  const nostrilMat = mats.glow();
  addPart(body, GEO_SPH, nostrilMat, 0.045, 0.035, 0.045, 0.08, 0.68, 2.26);
  addPart(body, GEO_SPH, nostrilMat, 0.045, 0.035, 0.045, -0.08, 0.68, 2.26);
  m._anim.nostrilMats = [nostrilMat];

  // hinged lower jaw (opens during ambush bites; generic jaw channel drives it)
  const jaw = new THREE.Group();
  jaw.position.set(0, 0.54, 1.38);
  body.add(jaw);
  addBox(jaw, mats.joint, 0.28, 0.07, 0.95, 0, -0.04, 0.42);
  for (const s of [1, -1]) {
    addPart(jaw, GEO_CONE, mats.rust, 0.02, 0.08, 0.02, s * 0.1, 0.03, 0.25);
    addPart(jaw, GEO_CONE, mats.rust, 0.02, 0.1, 0.02, s * 0.1, 0.03, 0.6);
  }
  m._anim.jaw = jaw;

  // paddle tail (idle sway via _anim.tail)
  const tail = new THREE.Group();
  tail.position.set(0, 0.62, -1.05);
  body.add(tail);
  addBox(tail, mats.joint, 0.44, 0.32, 0.6, 0, -0.04, -0.3);
  addBox(tail, mats.joint, 0.28, 0.22, 0.55, 0, -0.05, -0.82);
  addBox(tail, mats.rust, 0.07, 0.5, 0.45, 0, 0.02, -1.25);
  addBox(tail, mats.joint, 0.05, 0.28, 0.2, 0, 0.05, -1.55);
  m._anim.tail = tail;

  // glowing belly seam plates (weak point 'bellyseam')
  const seamMat = mats.glow();
  const seam = new THREE.Group();
  seam.position.set(0, 0.31, -0.05);
  body.add(seam);
  for (let i = 0; i < 4; i++) {
    addPart(seam, GEO_BOX, seamMat, 0.66, 0.05, 0.34, 0, 0, 0.62 - i * 0.44);
  }
  registerWeakPoint(m, 'bellyseam', seam, 0, 0.31, -0.05, 0.55, 1.6, 50, seamMat);

  // four stubby legs
  const defs = [[-0.5, 0.62], [0.5, 0.62], [-0.5, -0.68], [0.5, -0.68]];
  const offs = [0, Math.PI, Math.PI, 0];
  defs.forEach(([lx, lz], i) => {
    const pivot = addLeg(g, mats, 0.09, 0.46, lx, 0.46, lz, 0.17);
    m._anim.legs.push({ pivot, amp: 0.35, offset: offs[i] });
  });

  addBodySphere(m, 0, 0.6, 0.35, 0.5);
  addBodySphere(m, 0, 0.6, -0.5, 0.5);
  addBodySphere(m, 0, 0.58, 1.25, 0.38);
  addBodySphere(m, 0, 0.56, 1.9, 0.28);
}

function buildMonarch(m, mats) {
  const g = m.group;
  const body = new THREE.Group();
  g.add(body);
  m._anim.body = body;

  // colossal hips + torso + top deck
  addBox(body, mats.hull, 2.2, 1.6, 1.8, 0, 4.75, -0.7);
  addBox(body, mats.hull, 2.6, 2.3, 2.1, 0, 5.7, 0.2);
  addBox(body, mats.rust, 2.1, 0.16, 1.5, 0, 6.93, 0.15);

  // dorsal plates down the spine
  addBox(body, mats.rust, 0.55, 0.55, 0.22, 0, 7.1, 0.55, -0.25, 0, 0);
  addBox(body, mats.rust, 0.6, 0.6, 0.22, 0, 7.15, -0.05, -0.05, 0, 0);
  addBox(body, mats.rust, 0.6, 0.55, 0.22, 0, 7.1, -0.65, 0.15, 0, 0);

  // chest furnace (weak point 'furnace'); collar/rim get dedicated material
  // instances so breaking it never chars the shared hull/rust/joint mats
  const furnMat = mats.glow();
  const collarMat = stdMat(0x8a4b32);
  const rimMat = stdMat(0x23262b);
  const furnace = new THREE.Group();
  furnace.position.set(0, 5.6, 1.32);
  body.add(furnace);
  addBox(furnace, collarMat, 1.5, 1.5, 0.3, 0, 0, -0.08);
  addPart(furnace, GEO_CYL, rimMat, 0.62, 0.24, 0.62, 0, 0, 0.08, Math.PI / 2, 0, 0);
  addPart(furnace, GEO_SPH, furnMat, 0.5, 0.5, 0.42, 0, 0, 0.16);
  registerWeakPoint(m, 'furnace', furnace, 0, 5.6, 1.45, 0.95, 1.5, 220, furnMat);

  // neck + head + crest + snout (~9u to the head top)
  addBox(body, mats.hull, 1.0, 1.5, 0.9, 0, 7.35, 0.75, -0.35, 0, 0);
  addBox(body, mats.hull, 0.8, 1.2, 0.75, 0, 8.25, 1.15, -0.2, 0, 0);
  addBox(body, mats.hull, 0.85, 0.7, 1.4, 0, 8.85, 1.75);
  addBox(body, mats.rust, 0.5, 0.12, 1.0, 0, 9.24, 1.8);
  addBox(body, mats.joint, 0.55, 0.4, 0.9, 0, 8.75, 2.6);

  // hinged lower jaw
  const jaw = new THREE.Group();
  jaw.position.set(0, 8.62, 1.55);
  body.add(jaw);
  addBox(jaw, mats.joint, 0.45, 0.16, 1.15, 0, -0.06, 0.62);
  for (const s of [1, -1]) {
    addPart(jaw, GEO_CONE, mats.rust, 0.045, 0.16, 0.045, s * 0.15, 0.05, 0.35);
    addPart(jaw, GEO_CONE, mats.rust, 0.045, 0.18, 0.045, s * 0.15, 0.05, 0.8);
  }
  m._anim.jaw = jaw;

  // crown of antennae with glowing tips (idle sway via _anim.antennae,
  // flared by the existing roar channel)
  const crown = new THREE.Group();
  crown.position.set(0, 9.18, 1.5);
  body.add(crown);
  const tipMat = mats.glow();
  const crownDefs = [
    { rz: -0.55, rx: -0.45, len: 1.15 },
    { rz: -0.28, rx: -0.2, len: 1.5 },
    { rz: 0, rx: -0.05, len: 1.7 },
    { rz: 0.28, rx: -0.2, len: 1.5 },
    { rz: 0.55, rx: -0.45, len: 1.15 },
  ];
  for (const d of crownDefs) {
    const ant = new THREE.Group();
    ant.position.set(d.rz * 0.35, 0.05, -0.1);
    ant.rotation.set(d.rx, 0, d.rz);
    crown.add(ant);
    addPart(ant, GEO_CYL, mats.joint, 0.035, d.len, 0.035, 0, d.len / 2, 0);
    addPart(ant, GEO_SPH, tipMat, 0.075, 0.075, 0.075, 0, d.len, 0);
  }
  m._anim.antennae = crown;

  // small clawed arms
  for (const s of [1, -1]) {
    addBox(body, mats.joint, 0.28, 0.28, 0.9, s * 1.45, 5.2, 0.85);
    addPart(body, GEO_CONE, mats.rust, 0.09, 0.4, 0.09, s * 1.45, 5.05, 1.45, 1.5, 0, 0);
  }

  // sweeping tail (idle sway / AI tail-swipe via _anim.tail + _anim.tailSway)
  const tail = new THREE.Group();
  tail.position.set(0, 5.0, -1.5);
  body.add(tail);
  addBox(tail, mats.hull, 1.5, 1.3, 1.7, 0, 0.1, -0.8, 0.06, 0, 0);
  addBox(tail, mats.joint, 1.0, 0.85, 1.6, 0, -0.15, -2.2, 0.1, 0, 0);
  addBox(tail, mats.joint, 0.6, 0.5, 1.5, 0, -0.45, -3.6, 0.14, 0, 0);
  addPart(tail, GEO_CONE, mats.rust, 0.22, 1.2, 0.22, 0, -0.7, -4.85, 1.85, 0, 0);
  m._anim.tail = tail;

  // two colossal legs; each knee carries a glowing piston weak point
  // ('kneeL'/'kneeR') with per-side materials so breaks stay independent
  for (const s of [1, -1]) {
    addBox(body, mats.rust, 1.0, 0.5, 1.3, s * 1.15, 4.5, -0.5, 0, 0, s * -0.12); // hip cowl
    const hip = new THREE.Group();
    hip.position.set(s * 1.15, 4.3, -0.55);
    g.add(hip);
    addBox(hip, mats.hull, 0.95, 2.3, 1.15, 0, -1.05, 0.1); // thigh
    const knee = new THREE.Group();
    knee.position.set(0, -2.15, 0.1);
    hip.add(knee);
    addPart(knee, GEO_CYL, mats.joint, 0.3, 1.85, 0.3, 0, -0.92, 0); // shin
    addBox(knee, mats.joint, 1.25, 0.3, 1.7, 0, -2.0, 0.25); // foot
    for (const t of [-0.4, 0, 0.4]) {
      addPart(knee, GEO_CONE, mats.rust, 0.13, 0.5, 0.13, t, -2.05, 1.15, 1.75, 0, 0);
    }
    const pisMat = mats.glow();
    const housMat = stdMat(0x23262b);
    const piston = new THREE.Group();
    piston.position.set(0, 0.1, 0.42); // front of the knee joint
    knee.add(piston);
    addPart(piston, GEO_CYL, housMat, 0.14, 0.7, 0.14, 0, 0.25, 0);
    addPart(piston, GEO_CYL, pisMat, 0.09, 0.6, 0.09, 0, -0.35, 0);
    addPart(piston, GEO_CYL, housMat, 0.18, 0.12, 0.18, 0, -0.62, 0);
    registerWeakPoint(m, s > 0 ? 'kneeR' : 'kneeL', piston, s * 1.15, 2.1, 0, 0.55, 1.8, 70, pisMat);
    m._anim.legs.push({ pivot: hip, amp: 0.4, offset: s > 0 ? 0 : Math.PI });
    m._anim.knees.push({ knee, base: 0.15, amp: 0.3 });
  }

  addBodySphere(m, 0, 5.7, 0.2, 1.55);
  addBodySphere(m, 0, 5.9, 1.0, 1.1);
  addBodySphere(m, 0, 4.75, -0.7, 1.25);
  addBodySphere(m, 0, 7.4, 0.8, 0.75);
  addBodySphere(m, 0, 8.3, 1.2, 0.6);
  addBodySphere(m, 0, 8.85, 1.8, 0.6);
  addBodySphere(m, 0, 8.75, 2.6, 0.4);
  addBodySphere(m, 0, 5.1, -2.3, 0.95);
  addBodySphere(m, 0, 4.7, -3.7, 0.6);
  addBodySphere(m, 1.15, 3.2, -0.45, 0.85);
  addBodySphere(m, -1.15, 3.2, -0.45, 0.85);
}

const ROSTER = {
  skitter: { name: 'Skitter', hp: 60, radius: 0.55, maxSpeed: 6.0, build: buildSkitter },
  bramblehorn: { name: 'Bramblehorn', hp: 80, radius: 0.75, maxSpeed: 8.5, build: buildBramblehorn },
  rendclaw: { name: 'Rendclaw', hp: 140, radius: 0.75, maxSpeed: 7.5, build: buildRendclaw },
  ironmaw: { name: 'Ironmaw', hp: 320, radius: 1.35, maxSpeed: 3.2, build: buildIronmaw },
  duskwing: { name: 'Duskwing', hp: 110, radius: 0.8, maxSpeed: 9.0, build: buildDuskwing },
  bulwark: { name: 'Bulwark', hp: 280, radius: 1.15, maxSpeed: 3.0, build: buildBulwark },
  vantage: { name: 'Vantage', hp: 160, radius: 1.0, maxSpeed: 2.0, build: buildVantage },
  mirefang: { name: 'Mirefang', hp: 110, radius: 1.2, maxSpeed: 4.5, build: buildMirefang },
  monarch: { name: 'the Monarch', hp: 1000, radius: 3.2, maxSpeed: 2.4, build: buildMonarch },
};

// ------------------------------------------------------------ damage/loot --

const LOOT = {
  skitter: [['shards', 2]],
  bramblehorn: [['oil', 2], ['shards', 3]],
  rendclaw: [['shards', 6], ['oil', 1]],
  ironmaw: [['shards', 10], ['oil', 3]],
  duskwing: [['shards', 4], ['oil', 2]],
  bulwark: [['shards', 7], ['oil', 3]],
  vantage: [['shards', 6], ['oil', 2]],
  mirefang: [['shards', 5], ['oil', 2]],
  monarch: [['shards', 40], ['oil', 12], ['medicine', 3]],
};

function dropLoot(m) {
  const table = LOOT[m.type];
  const mult = m.alpha ? 2 : 1; // alpha variants drop double loot
  const p = m.group.position;
  for (let i = 0; i < table.length; i++) {
    const [kind, count] = table[i];
    for (let j = 0; j < count * mult; j++) {
      // deterministic pseudo-scatter so drops never stack in one spot
      const ang = (i * 31 + j * 57) * 0.61 + p.x;
      const r = 0.8 + ((i * 13 + j * 29) % 10) * 0.16;
      const lx = p.x + Math.cos(ang) * r;
      const lz = p.z + Math.sin(ang) * r;
      spawnPickup(kind, lx, heightAt(lx, lz) + 0.35, lz);
    }
  }
}

function dropScrapChunk(m, wp) {
  const mesh = new THREE.Mesh(GEO_BOX, SCRAP_MAT);
  mesh.scale.set(0.2, 0.12, 0.16);
  mesh.castShadow = true;
  wp.mesh.getWorldPosition(_v1);
  mesh.position.copy(_v1);
  if (G.scene) G.scene.add(mesh);
  m._anim.scraps.push({
    mesh,
    vel: new THREE.Vector3(
      randRange(Math.random, -1.6, 1.6),
      randRange(Math.random, 2.5, 4.2),
      randRange(Math.random, -1.6, 1.6),
    ),
    life: 9,
  });
}

function updateScraps(m, dt) {
  const scraps = m._anim.scraps;
  for (let i = scraps.length - 1; i >= 0; i--) {
    const s = scraps[i];
    s.life -= dt;
    if (s.life <= 0) {
      s.mesh.removeFromParent();
      scraps.splice(i, 1);
      continue;
    }
    if (s.vel.lengthSq() > 0.0001) {
      s.vel.y -= CONFIG.gravity * 0.7 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.x += dt * 4;
      s.mesh.rotation.z += dt * 3;
      const gy = heightAt(s.mesh.position.x, s.mesh.position.z) + 0.06;
      if (s.mesh.position.y <= gy) {
        s.mesh.position.y = gy;
        s.vel.set(0, 0, 0);
      }
    }
  }
}

function killMachine(m) {
  if (!m.alive) return;
  m.alive = false;
  m.aggro = false;
  m.moveSpeed = 0;
  const a = m._anim;
  a.deathT = 0;
  a.deadTime = 0;
  a.fadeT = -1;
  a.harvested = false;
  a.side = Math.random() < 0.5 ? -1 : 1;
  a.deathY = m.group.position.y;
  if (a.shadowMesh) a.shadowMesh.visible = false; // dive marker dies with the bird
  bus.emit('machineDied', { machine: m, pos: m.group.position.clone() });
  dropLoot(m);
}

// --------------------------------------------------- bulwark deflect sparks -
// Tiny local burst pool (combat/damage.js owns the combat hit FX); used only
// for arrows bouncing off the bulwark's front armor cone.

const DEFLECT_POOL = 2;
const DEFLECT_PARTICLES = 12;
const DEFLECT_DUR = 0.35;
const deflects = [];
let deflectCursor = 0;

function spawnDeflectSparks(pos) {
  if (!G.scene) return;
  if (!deflects.length) {
    for (let i = 0; i < DEFLECT_POOL; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(DEFLECT_PARTICLES * 3), 3)
          .setUsage(THREE.DynamicDrawUsage),
      );
      const mat = new THREE.PointsMaterial({
        color: 0xffd27a, size: 0.09, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      pts.visible = false;
      G.scene.add(pts);
      deflects.push({ pts, vels: new Float32Array(DEFLECT_PARTICLES * 3), t: 0, active: false });
    }
  }
  const s = deflects[deflectCursor];
  deflectCursor = (deflectCursor + 1) % DEFLECT_POOL;
  s.active = true;
  s.t = 0;
  s.pts.visible = true;
  s.pts.material.opacity = 1;
  const arr = s.pts.geometry.attributes.position.array;
  const vel = s.vels;
  for (let i = 0; i < DEFLECT_PARTICLES; i++) {
    const j = i * 3;
    arr[j] = pos.x;
    arr[j + 1] = pos.y;
    arr[j + 2] = pos.z;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    const sp = 2.5 + Math.random() * 4.5;
    vel[j] = Math.sin(ph) * Math.cos(th) * sp;
    vel[j + 1] = Math.abs(Math.cos(ph)) * sp * 0.8 + 1.2;
    vel[j + 2] = Math.sin(ph) * Math.sin(th) * sp;
  }
  s.pts.geometry.attributes.position.needsUpdate = true;
}

/** Advance deflect bursts; called once per frame from ai.js updateMachines. */
export function updateDeflectFX(dt) {
  for (let i = 0; i < deflects.length; i++) {
    const s = deflects[i];
    if (!s.active) continue;
    s.t += dt;
    const k = s.t / DEFLECT_DUR;
    if (k >= 1) {
      s.active = false;
      s.pts.visible = false;
      continue;
    }
    const arr = s.pts.geometry.attributes.position.array;
    const vel = s.vels;
    for (let j = 0; j < arr.length; j += 3) {
      vel[j + 1] -= CONFIG.gravity * 0.6 * dt;
      arr[j] += vel[j] * dt;
      arr[j + 1] += vel[j + 1] * dt;
      arr[j + 2] += vel[j + 2] * dt;
    }
    s.pts.geometry.attributes.position.needsUpdate = true;
    s.pts.material.opacity = 1 - k;
  }
}

// ------------------------------------------------------- corpse harvest UI --
// Progress ring sprite shown while the player holds E on a carcass. Drawn to
// a canvas texture (DOM-free), throttled to whole 1/36th steps.

let hRing = null; // { spr, ctx, tex, lastQ }

function ensureHarvestRing() {
  if (hRing || !G.scene) return;
  const cv = document.createElement('canvas');
  cv.width = 96;
  cv.height = 96;
  const ctx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const spr = new THREE.Sprite(mat);
  spr.scale.set(1.1, 1.1, 1);
  spr.renderOrder = 40;
  spr.visible = false;
  G.scene.add(spr);
  hRing = { spr, ctx, tex, lastQ: -1 };
}

/** Show the harvest progress ring at `pos` (raised by the caller). */
export function showHarvestRing(pos, frac) {
  ensureHarvestRing();
  if (!hRing) return;
  const q = clamp(frac, 0, 1);
  const qi = Math.round(q * 36);
  if (qi !== hRing.lastQ) {
    hRing.lastQ = qi;
    const c = hRing.ctx;
    c.clearRect(0, 0, 96, 96);
    c.lineWidth = 9;
    c.strokeStyle = 'rgba(10,14,18,0.75)';
    c.beginPath();
    c.arc(48, 48, 36, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = '#59e3ff';
    c.beginPath();
    c.arc(48, 48, 36, -Math.PI / 2, -Math.PI / 2 + q * Math.PI * 2);
    c.stroke();
    hRing.tex.needsUpdate = true;
  }
  hRing.spr.position.copy(pos);
  hRing.spr.visible = true;
}

export function hideHarvestRing() {
  if (hRing) {
    hRing.spr.visible = false;
    hRing.lastQ = -1;
  }
}

// ------------------------------------------------------------ hit handling --

function applyHit(m, damage, point, wp) {
  if (!m.alive) return;
  // Bulwark front armor cone: strikes within +/-60 deg of facing deflect
  // with a spark shower and zero damage - flank it for the rear vents.
  if (m.type === 'bulwark' && point && isFrontConeHit(m, point)) {
    spawnDeflectSparks(point);
    sfx('arrowHitMetal', { pos: point });
    m.hitFlag = true; // it notices being shot at, but takes nothing
    return false;
  }
  if (wp && !wp.broken) {
    wp.hp -= damage;
    if (wp.hp <= 0) {
      wp.broken = true;
      for (const mat of wp._mats) {
        mat.emissiveIntensity = 0.05;
        mat.emissive.setHex(0x000000);
        mat.color.setHex(0x181818); // charred
        mat.userData.broken = true;
      }
      dropScrapChunk(m, wp);
      m.staggerTimer = 1.2;
      bus.emit('partBroken', { machine: m, partName: wp.name });
    }
  }
  m.hp -= damage;
  m._anim.flinch = 0.25;
  m.hitFlag = true; // consumed by ai.js -> aggro
  if (m.hp <= 0) killMachine(m);
  return true;
}

/** True when `point` lies within the bulwark's +/-60 deg front armor cone. */
function isFrontConeHit(m, point) {
  const dx = point.x - m.group.position.x;
  const dz = point.z - m.group.position.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 0.0001) return true;
  const dot = (Math.sin(m.group.rotation.y) * dx + Math.cos(m.group.rotation.y) * dz) / len;
  return dot > 0.5; // cos(60 deg)
}

/**
 * v2 alpha variant: dark-red tint, "Alpha " name prefix, +60% hp, +25% damage.
 * Called by ai.js right after createMachine; loot doubling lives in dropLoot.
 */
const ALPHA_TINT = new THREE.Color(0x6e1f24);
export function applyAlphaVariant(m) {
  m.alpha = true;
  m.name = `Alpha ${m.name}`;
  m.maxHp = Math.round(m.maxHp * 1.6);
  m.hp = m.maxHp;
  m.damageMul = 1.25;
  for (const mat of m._anim.materials) {
    if (!mat.color) continue;
    if (mat.emissive && mat.emissive.getHex() !== 0x000000) continue; // weak points stay cyan
    mat.color.lerp(ALPHA_TINT, 0.55);
  }
}

// ----------------------------------------------------------------- update --

function updateDeath(m, dt) {
  const a = m._anim;
  if (a.deathT < 1) {
    a.deathT = Math.min(1, a.deathT + dt / 1.1);
    const e = smoothstep(0, 1, a.deathT);
    m.group.rotation.z = a.side * e * Math.PI * 0.5; // tip over sideways
    // settle onto the terrain (airborne kills fall to earth as they tip)
    const gy = heightAt(m.group.position.x, m.group.position.z);
    m.group.position.y = a.deathY - (a.deathY - gy) * e - 0.2 * e;
  }
  a.deadTime += dt;
  // v2: carcass persists for the harvest window, then fades out
  if (a.deadTime > CARCASS_LIFE) {
    if (a.fadeT < 0) {
      a.fadeT = 0;
      for (const mat of a.materials) {
        mat.transparent = true;
        mat.needsUpdate = true;
      }
    }
    a.fadeT += dt / 1.5;
    const op = clamp(1 - a.fadeT, 0, 1);
    for (const mat of a.materials) mat.opacity = op;
    if (a.fadeT >= 1) m.dispose();
  }
}

function updateMachine(m, dt) {
  const a = m._anim;
  updateScraps(m, dt);
  if (!m.alive) {
    updateDeath(m, dt);
    return;
  }

  if (m.staggerTimer > 0) m.staggerTimer = Math.max(0, m.staggerTimer - dt);
  if (a.flinch > 0) a.flinch = Math.max(0, a.flinch - dt);
  a.boltGlow = Math.max(0, a.boltGlow - dt * 2.5);

  // procedural gait driven by the speed the AI reports
  const spd = Math.abs(m.moveSpeed);
  const f = clamp(spd / m.maxSpeed, 0, 1);
  a.phase += dt * (2.0 + spd * 2.1);
  const swing = Math.sin(a.phase);
  for (const leg of a.legs) leg.pivot.rotation.x = Math.sin(a.phase + leg.offset) * leg.amp * f;
  for (const k of a.knees) k.knee.rotation.x = k.base + Math.max(0, -swing) * k.amp * f;

  // body pose: bob + crouch + flinch + stagger wobble + rear/lean/roar channels
  const bob = Math.abs(Math.cos(a.phase)) * 0.045 * f;
  let px = 0;
  let py = a.bodyBaseY + bob - a.crouchDrop * a.crouch;
  let rx = 0;
  let ry = a.lean * 0.5;
  let rz = 0;
  if (a.flinch > 0) rx -= (a.flinch / 0.25) * 0.3;
  if (m.staggerTimer > 0) {
    const s = clamp(m.staggerTimer / 1.2, 0, 1);
    rz += Math.sin(G.elapsed * 27) * 0.1 * s;
    rx += Math.sin(G.elapsed * 19) * 0.05 * s;
  }
  rx -= a.rear * 0.55;
  if (a.roar > 0) {
    px = Math.sin(G.elapsed * 42) * 0.05 * a.roar;
    py += 0.05 * a.roar;
  }
  // bulwark roll charge: tumble the pill body while ai.js reports rollSpin
  if (a.rollSpin) {
    a.rollAccum += a.rollSpin * dt;
    rx += a.rollAccum;
  } else {
    a.rollAccum = 0;
  }
  a.body.position.set(px, py, 0);
  a.body.rotation.set(rx, ry, rz);

  // hull flash while flinching
  a.hullMat.emissive.setHex(a.flinch > 0 ? 0x5a2317 : 0x000000);

  // weak point glow pulse (skip broken parts)
  for (let i = 0; i < a.glowMats.length; i++) {
    const gm = a.glowMats[i];
    if (!gm.userData.broken) {
      gm.emissiveIntensity = 1.6 + Math.sin(G.elapsed * 3.1 + i * 1.9) * 0.3 + a.boltGlow * 1.2;
    }
  }

  // jaw: AI override, else idle/aggro pose
  if (a.jaw) {
    const target = m.jawTarget != null ? m.jawTarget : (m.aggro ? 0.3 : 0.05);
    a.jaw.rotation.x = damp(a.jaw.rotation.x, target, 8, dt);
  }

  // grinder spins up while aggro
  if (a.grinder) {
    a.grindSpin = damp(a.grindSpin, m.aggro ? 1 : 0, 3, dt);
    a.grinder.rotation.z += dt * 11 * a.grindSpin;
  }

  // v3: tail + antenna idle sway keeps mirefang/monarch rendering sanely
  // before ai.js drives them; AI overrides the tail via a.tailSway
  // (jawTarget-style: null = automatic idle sway)
  if (a.tail) {
    a.tail.rotation.y = a.tailSway != null
      ? a.tailSway
      : Math.sin(G.elapsed * 1.6 + a.phase * 0.3) * 0.14;
  }
  if (a.antennae) {
    const flare = 1 + a.roar * 4; // enrage roar flares the crown
    a.antennae.rotation.z = Math.sin(G.elapsed * 1.1) * 0.05 * flare;
    a.antennae.rotation.x = Math.cos(G.elapsed * 0.9) * 0.04 * flare;
  }
  // v3: monarch stomp telegraph - lift one leg by index (no-op at -1)
  if (a.stompLeg >= 0 && a.stompLeg < a.legs.length) {
    a.legs[a.stompLeg].pivot.rotation.x = -a.stompRaise * 0.9;
  }
}

function disposeMachine(m) {
  if (m._disposed) return;
  m._disposed = true;
  for (const s of m._anim.scraps) s.mesh.removeFromParent();
  if (m._anim.shadowMesh) m._anim.shadowMesh.removeFromParent(); // duskwing dive marker
  m.group.removeFromParent();
  for (const mat of m._anim.materials) mat.dispose(); // geometries are shared caches
  const i = G.machines.indexOf(m);
  if (i >= 0) G.machines.splice(i, 1);
}

function enableShadows(root) {
  root.traverse((o) => {
    if (o.isMesh && o.material && o.material.emissive && o.material.emissive.getHex() === 0) {
      o.castShadow = true;
    }
  });
}

// ------------------------------------------------------------------ export --

/**
 * Build a machine of `type` at world (x, z), snapped to terrain.
 * Fulfills the machine contract from state.js plus AI-facing extras:
 * moveSpeed, staggerTimer, radius, maxSpeed, jawTarget, hitFlag, _anim, _ai.
 */
export function createMachine(type, x, z) {
  const def = ROSTER[type];
  if (!def) throw new Error(`createMachine: unknown type "${type}"`);
  const mats = makeMaterials();
  const m = {
    group: new THREE.Group(),
    type,
    name: def.name,
    hp: def.hp,
    maxHp: def.hp,
    alive: true,
    aggro: false,
    weakPoints: [],
    bodySpheres: [],
    radius: def.radius,
    maxSpeed: def.maxSpeed,
    moveSpeed: 0,      // planar speed set by the AI each frame; drives the gait
    staggerTimer: 0,
    jawTarget: null,   // AI override for jaw opening (null = automatic)
    hitFlag: false,    // set by hit(), consumed by the AI to trigger aggro
    alpha: false,      // v2: alpha variant flag (set via applyAlphaVariant)
    damageMul: 1,      // v2: outgoing damage multiplier (alpha = 1.25)
    _disposed: false,
    _anim: {
      body: null, bodyBaseY: 0, phase: 0, flinch: 0,
      legs: [], knees: [],
      crouch: 0, crouchDrop: 0, rear: 0, lean: 0, roar: 0, boltGlow: 0,
      jaw: null, grinder: null, grindSpin: 0,
      rollSpin: 0, rollAccum: 0,   // v2: bulwark roll tumble channel
      shadowMesh: null, shadowMat: null, // v2: duskwing dive telegraph disc
      tail: null, tailSway: null,  // v3: tail group + AI yaw override (null = auto sway)
      antennae: null,              // v3: monarch antenna crown group (idle sway)
      stompLeg: -1, stompRaise: 0, // v3: monarch stomp telegraph (raised leg index, 0..1)
      nostrilMats: null,           // v3: mirefang nostril glow materials (surface tell)
      harvested: false,            // v2: corpse already harvested
      hullMat: mats.hull, glowMats: [], materials: [], scraps: [],
      deathT: 0, deadTime: 0, fadeT: -1, side: 1, deathY: 0,
    },
  };
  def.build(m, mats);
  enableShadows(m.group);
  // collect every material once for fading on death
  const seen = new Set();
  m.group.traverse((o) => {
    if (o.isMesh && o.material && !seen.has(o.material)) {
      seen.add(o.material);
      m._anim.materials.push(o.material);
    }
  });
  m.group.position.set(x, heightAt(x, z), z);
  if (G.scene) G.scene.add(m.group);
  m.hit = (damage, point, weakPoint) => applyHit(m, damage, point, weakPoint);
  m.update = (dt) => updateMachine(m, dt);
  m.dispose = () => disposeMachine(m);
  return m;
}
