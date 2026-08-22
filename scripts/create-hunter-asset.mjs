// IRONWILD - repository-generated HUNTER asset (authored-placeholder tier).
//
// Produces public/assets/player/hunter.glb. ORIGINAL content, generated
// in-repo (MIT). This is NOT final production art: it is a credible authored
// placeholder that exercises the production pipeline for the player and -
// critically - mirrors the procedural rig's node names AND pivot transforms
// (legL/legR/torso/head/armL/armR/handL/handR), so the game's existing pose
// system drives the authored model unchanged through the rebind seam in
// src/player/player.js. A skinned/skeletal replacement can later occupy the
// same manifest slot without code surgery.
//
// Usage: node scripts/create-hunter-asset.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GlbBuilder, F32, U16 } from "./lib/glb.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "assets", "player");

// ---- primitives -------------------------------------------------------------

function box(sx, sy, sz) {
  const f = [
    [[0, 0, 1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
    [[0, 0, -1], [1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]],
    [[1, 0, 0], [1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]],
    [[-1, 0, 0], [-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]],
    [[0, 1, 0], [-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]],
    [[0, -1, 0], [-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]],
  ];
  const pos = [];
  const nor = [];
  const idx = [];
  f.forEach(([n, ...quad], fi) => {
    const b = fi * 4;
    for (const [x, y, z] of quad) {
      pos.push((x * sx) / 2, (y * sy) / 2, (z * sz) / 2);
      nor.push(...n);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  return { pos, nor, idx };
}

function prism(rb, rt, h, sides) {
  const pos = [];
  const nor = [];
  const idx = [];
  for (let i = 0; i <= sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    pos.push(Math.cos(a) * rb, 0, Math.sin(a) * rb);
    pos.push(Math.cos(a) * rt, h, Math.sin(a) * rt);
    const nx = Math.cos(a + Math.PI / sides);
    const nz = Math.sin(a + Math.PI / sides);
    nor.push(nx, 0, nz, nx, 0, nz);
  }
  for (let i = 0; i < sides; i++) {
    const o = i * 2;
    idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
  }
  return { pos, nor, idx };
}

function bake(g, dx = 0, dy = 0, dz = 0, rx = 0, _ry = 0, rz = 0) {
  // rotation order X then Z (only small tilts used here)
  const cx = Math.cos(rx); const sxr = Math.sin(rx);
  const cz = Math.cos(rz); const szr = Math.sin(rz);
  const pos = g.pos.slice();
  for (let i = 0; i < pos.length; i += 3) {
    let x = pos[i]; let y = pos[i + 1]; let z = pos[i + 2];
    let y2 = y * cx - z * sxr;
    let z2 = y * sxr + z * cx;
    let x2 = x * cz - y2 * szr;
    y2 = x * szr + y2 * cz;
    x = x2; z = z2;
    pos[i] = x + dx; pos[i + 1] = y2 + dy; pos[i + 2] = z + dz;
  }
  return { pos, nor: g.nor.slice(), idx: g.idx.slice() };
}

function merge(parts) {
  const pos = [];
  const nor = [];
  const idx = [];
  let off = 0;
  for (const g of parts) {
    for (const i of g.idx) idx.push(i + off);
    pos.push(...g.pos);
    nor.push(...g.nor);
    off += g.pos.length / 3;
  }
  return { pos, nor, idx };
}

// ---- document ---------------------------------------------------------------

const w = new GlbBuilder();

const MAT = {
  leatherDark: 0, leatherLight: 1, cloth: 2, skin: 3, glow: 4,
};

function meshNode(name, geo, matIdx, tx = 0, ty = 0, tz = 0) {
  const pv = w.accessor(F32(geo.pos), 5126, "VEC3", geo.pos.length / 3);
  const nv = w.accessor(F32(geo.nor), 5126, "VEC3", geo.nor.length / 3);
  json.meshes.push({
    name,
    primitives: [{
      attributes: { POSITION: pv, NORMAL: nv },
      indices: w.accessor(U16(geo.idx), 5123, "SCALAR", geo.idx.length, 34963),
      material: matIdx,
    }],
  });
  json.nodes.push({ name, mesh: json.meshes.length - 1, translation: [tx, ty, tz] });
  return json.nodes.length - 1;
}

function groupNode(name, translation, rotationQuat) {
  json.nodes.push({
    name,
    translation,
    ...(rotationQuat ? { rotation: rotationQuat } : {}),
    children: [], // stripped below when left empty
  });
  return json.nodes.length - 1;
}

/** Quaternion for a small Z-axis splay/tilt. */
const quatZ = (rz) => [0, 0, Math.sin(rz / 2), Math.cos(rz / 2)];
/** Small-angle XYZ→quaternion (all tilts here are <0.5 rad). */
const quatEuler = (rx, ry, rz) => {
  const hx = rx / 2, hy = ry / 2, hz = rz / 2;
  const cx = Math.cos(hx), sx = Math.sin(hx);
  const cy = Math.cos(hy), sy = Math.sin(hy);
  const cz = Math.cos(hz), sz = Math.sin(hz);
  return [
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
};

const json = {
  asset: {
    version: "2.0",
    generator: "ironwild scripts/create-hunter-asset.mjs",
    copyright: "MIT (c) IRONWILD project",
  },
  scene: 0,
  scenes: [{ name: "hunter", nodes: [] }],
  materials: [
    { name: "m_leather_dark", pbrMetallicRoughness: { baseColorFactor: [0.49, 0.34, 0.23, 1], metallicFactor: 0.02, roughnessFactor: 0.78 } },
    { name: "m_leather_light", pbrMetallicRoughness: { baseColorFactor: [0.63, 0.48, 0.31, 1], metallicFactor: 0.02, roughnessFactor: 0.72 } },
    { name: "m_cloth", pbrMetallicRoughness: { baseColorFactor: [0.36, 0.54, 0.48, 1], metallicFactor: 0.0, roughnessFactor: 0.9 } },
    { name: "m_skin", pbrMetallicRoughness: { baseColorFactor: [0.82, 0.64, 0.49, 1], metallicFactor: 0.0, roughnessFactor: 0.6 } },
    { name: "m_emissive_focus", pbrMetallicRoughness: { baseColorFactor: [0.35, 0.89, 1, 1], metallicFactor: 0.0, roughnessFactor: 0.4 }, emissiveFactor: [0.35, 0.89, 1.0] },
  ],
  nodes: [],
  meshes: [],
  animations: [],
};

// Root: 'hunter_body' sits under player.body and carries EVERYTHING.
const bodyRoot = groupNode("hunter_body", [0, 0, 0]);
json.scenes[0].nodes.push(bodyRoot);

// Pelvis + skirt flap (body-space, matching procedural placement).
json.nodes[bodyRoot].children.push(
  meshNode("pelvis", box(0.36, 0.20, 0.24), MAT.leatherDark, 0, 1.00, 0),
  meshNode("skirt", box(0.30, 0.24, 0.05), MAT.cloth, 0, 0.84, 0.13),
);

// Legs: pivots EXACTLY like makeLeg(): (±0.13, 0.96, 0).
for (const side of [-1, 1]) {
  const nm = side < 0 ? "legL" : "legR";
  const pivot = groupNode(nm, [0.13 * side, 0.96, 0]);
  json.nodes[pivot].children.push(
    meshNode(`${nm}_thigh`, box(0.15, 0.44, 0.17), MAT.leatherDark, 0, -0.24, 0),
    meshNode(`${nm}_shin`, box(0.125, 0.40, 0.145), MAT.leatherLight, 0, -0.62, 0),
    meshNode(`${nm}_boot`, box(0.14, 0.11, 0.26), MAT.leatherDark, 0, -0.88, -0.03),
  );
  json.nodes[bodyRoot].children.push(pivot);
}

// Torso: pivot (0, 1.06, 0) with head/arms/socket_back/quiver inside.
const torso = groupNode("torso", [0, 1.06, 0]);
json.nodes[torso].children.push(
  meshNode("chest", box(0.44, 0.52, 0.26), MAT.leatherLight, 0, 0.28, 0),
  meshNode("belt", box(0.46, 0.10, 0.28), MAT.leatherDark, 0, 0.02, 0),
  meshNode("strap", box(0.08, 0.50, 0.04), MAT.leatherDark, 0.10, 0.28, 0.14),
);

// Head: pivot (0, 0.60, 0) under torso.
const head = groupNode("head", [0, 0.60, 0]);
json.nodes[head].children.push(
  meshNode("skull", box(0.22, 0.24, 0.22), MAT.skin, 0, 0.10, 0),
  (() => {
    const n = meshNode("hood", bake(prism(0.21, 0.04, 0.40, 6), 0, 0.06, -0.03, -0.12), MAT.cloth, 0, 0.26, -0.03);
    void n;
    return n;
  })(),
  meshNode("brim", box(0.26, 0.05, 0.12), MAT.cloth, 0, 0.17, 0.10),
  meshNode("focus_glow", box(0.05, 0.05, 0.025), MAT.glow, 0.115, 0.12, 0.07),
);
json.nodes[torso].children.push(head);

// Arms: shoulders (±0.29, 0.48, 0), rest splay rot.z = ∓0.10 (side -1 -> -0.10).
// Hand grip group at (0, -0.84, 0) named handL/handR - REQUIRED by bow/spear.
for (const side of [-1, 1]) {
  const nm = side < 0 ? "armL" : "armR";
  const handNm = side < 0 ? "handL" : "handR";
  const sockNm = side < 0 ? "socket_hand_l" : "socket_hand_r";
  const shoulder = groupNode(nm, [0.29 * side, 0.48, 0], quatZ(0.10 * side));
  json.nodes[shoulder].children.push(
    meshNode(`${nm}_upper`, box(0.11, 0.40, 0.12), MAT.leatherLight, 0, -0.20, 0),
    meshNode(`${nm}_fore`, box(0.095, 0.34, 0.105), MAT.skin, 0, -0.55, 0),
    meshNode(`${nm}_handMesh`, box(0.09, 0.11, 0.10), MAT.skin, 0, -0.78, 0),
  );
  const hand = groupNode(handNm, [0, -0.84, 0]);
  const sock = groupNode(sockNm, [0, -0.03, 0.01]);
  json.nodes[hand].children.push(sock);
  json.nodes[shoulder].children.push(hand);
  json.nodes[torso].children.push(shoulder);
}

// Back socket carries the quiver visual (rotation baked on the socket node).
const socketBack = groupNode("socket_back", [0.07, 0.24, -0.20], quatEuler(0.35, 0, -0.15));
{
  const quiverParts = merge([
    bake(prism(0.07, 0.09, 0.42, 6), 0, 0, 0),
  ]);
  json.nodes[socketBack].children.push(meshNode("quiver", quiverParts, MAT.leatherDark, 0, 0, 0));
  for (let i = 0; i < 3; i++) {
    const stick = meshNode(
      `arrow${i}`,
      merge([
        bake(prism(0.018, 0.018, 0.46, 5)),
        bake(box(0.05, 0.09, 0.012), 0, 0.26, 0),
      ]),
      i === 1 ? MAT.cloth : MAT.leatherLight,
      -0.03 + i * 0.035, 0.30, (i - 1) * 0.02,
    );
    const halfA = ((i - 1) * 0.10) / 2;
    json.nodes[stick].rotation = [0, 0, Math.sin(halfA), Math.cos(halfA)];
    json.nodes[socketBack].children.push(stick);
  }
}
json.nodes[torso].children.push(socketBack);

// Hip socket (potion belt anchor).
const socketHips = groupNode("socket_hips", [-0.20, 0.92, 0.08]);
json.nodes[bodyRoot].children.push(socketHips);

json.nodes[bodyRoot].children.push(torso);

// Strip empty children arrays (glTF: nodes must not be empty entities) and
// any empty top-level collections (empty /animations is likewise invalid).
for (const n of json.nodes) {
  if (Array.isArray(n.children) && n.children.length === 0) delete n.children;
}
if (Array.isArray(json.animations) && json.animations.length === 0) {
  delete json.animations;
}

mkdirSync(OUT_DIR, { recursive: true });
const buf = w.finish(json);
writeFileSync(join(OUT_DIR, "hunter.glb"), buf);

writeFileSync(join(OUT_DIR, "hunter.provenance.json"), JSON.stringify({
  id: "hunter",
  generatedBy: "scripts/create-hunter-asset.mjs",
  authoredBy: "IRONWILD project (procedural, in-repo)",
  license: "MIT",
  modified: false,
  purpose: "authored placeholder - mirrors procedural rig conventions; skinned art pending",
  created: new Date().toISOString(),
}, null, 2));

console.log(`hunter.glb written (${buf.length} bytes, ${json.meshes.length} parts, ${json.nodes.filter((n) => n.name.startsWith('socket')).length} sockets)`);
