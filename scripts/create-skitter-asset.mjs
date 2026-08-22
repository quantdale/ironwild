// IRONWILD - repository-generated SKITTER machine asset (authored-placeholder
// tier). ORIGINAL content (MIT). Articulated quadruped rig following the
// machine animator conventions: clips named loc_*/act_*/react_* drive the
// AnimGraph; 'wp_eye' + 'socket_jaw' satisfy the manifest conventions.
// This is a credible authored placeholder, NOT final production art.
//
// Usage: node scripts/create-skitter-asset.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GlbBuilder, F32, U16 } from "./lib/glb.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "assets", "machines");

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

function bake(g, dx = 0, dy = 0, dz = 0) {
  const pos = g.pos.slice();
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] += dx;
    pos[i + 1] += dy;
    pos[i + 2] += dz;
  }
  return { pos, nor: g.nor.slice(), idx: g.idx.slice() };
}

const w = new GlbBuilder();
const json = {
  asset: {
    version: "2.0",
    generator: "ironwild scripts/create-skitter-asset.mjs",
    copyright: "MIT (c) IRONWILD project",
  },
  scene: 0,
  scenes: [{ name: "skitter", nodes: [] }],
  materials: [
    { name: "m_steel", pbrMetallicRoughness: { baseColorFactor: [0.23, 0.26, 0.29, 1], metallicFactor: 0.65, roughnessFactor: 0.55 } },
    { name: "m_rust", pbrMetallicRoughness: { baseColorFactor: [0.54, 0.30, 0.19, 1], metallicFactor: 0.35, roughnessFactor: 0.85 } },
    { name: "m_emissive", pbrMetallicRoughness: { baseColorFactor: [1, 0.16, 0.1, 1], metallicFactor: 0, roughnessFactor: 0.4 }, emissiveFactor: [1.0, 0.16, 0.1] },
  ],
  nodes: [],
  meshes: [],
  animations: [],
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
  json.nodes.push({ name, mesh: json.meshes.length - 1, translation: [tx, ty, tz], children: [] });
  return json.nodes.length - 1;
}
function groupNode(name, t = [0, 0, 0]) {
  json.nodes.push({ name, translation: t, children: [] });
  return json.nodes.length - 1;
}

// ---- rig --------------------------------------------------------------------
// Root at the chassis centre, ~0.55u off the ground (feet reach y=0).
const rootN = groupNode("skitter_body", [0, 0.55, 0]);
json.scenes[0].nodes.push(rootN);

json.nodes[rootN].children.push(
  // Chassis: low wedge silhouette (two stacked boxes read as armour plating).
  meshNode("chassis_top", bake(box(0.62, 0.16, 1.05), 0, 0.10, 0), 0),
  meshNode("chassis_low", bake(box(0.70, 0.12, 0.80), 0, -0.04, -0.05), 0),
  meshNode("plate_f", bake(box(0.50, 0.10, 0.22), 0, 0.06, 0.52), 1),
);

// Sensor head with the WEAK POINT eye.
const headN = groupNode("head", [0, 0.16, 0.48]);
json.nodes[headN].children.push(
  meshNode("skull", bake(box(0.30, 0.20, 0.34)), 0),
  meshNode("eye_band", bake(box(0.24, 0.06, 0.06), 0, 0.03, 0.17), 2),
  (() => {
    const n = groupNode("wp_eye", [0, 0.03, 0.20]);
    return n;
  })(),
  groupNode("socket_jaw", [0, -0.08, 0.18]),
);
json.nodes[rootN].children.push(headN);

// Legs: hip pivots under the chassis; single rigid limb + foot per leg.
const LEG_X = 0.34;
const LEG_FZ = 0.38;
const LEG_BZ = -0.36;
const legNames = [
  ["legFL", -LEG_X, LEG_FZ],
  ["legFR", LEG_X, LEG_FZ],
  ["legBL", -LEG_X, LEG_BZ],
  ["legBR", LEG_X, LEG_BZ],
];
for (const [nm, lx, lz] of legNames) {
  const pivot = groupNode(nm, [lx, -0.02, lz]);
  json.nodes[pivot].children.push(
    meshNode(`${nm}_limb`, bake(box(0.09, 0.42, 0.11), 0, -0.21, 0), 1),
    meshNode(`${nm}_foot`, bake(box(0.13, 0.07, 0.20), 0, -0.455, 0.03), 0),
  );
  json.nodes[rootN].children.push(pivot);
}

// Rear sensor tail stub.
const tailN = groupNode("tail", [0, 0.14, -0.52]);
json.nodes[tailN].children.push(meshNode("tail_rod", bake(box(0.06, 0.06, 0.28)), 1));
json.nodes[rootN].children.push(tailN);

for (const n of json.nodes) {
  if (Array.isArray(n.children) && n.children.length === 0) delete n.children;
}

// ---- animation --------------------------------------------------------------
const TAU = Math.PI * 2;
const q = (rx = 0, ry = 0, rz = 0) => {
  const hx = rx / 2, hy = ry / 2, hz = rz / 2;
  const cx = Math.cos(hx), sxx = Math.sin(hx);
  const cy = Math.cos(hy), sy = Math.sin(hy);
  const cz = Math.cos(hz), sz = Math.sin(hz);
  return [
    sxx * cy * cz - cx * sy * sz,
    cx * sy * cz + sxx * cy * sz,
    cx * cy * sz + sxx * sy * cz,
    cx * cy * cz - sxx * sy * sz,
  ];
};
const nodeByName = {};
json.nodes.forEach((n, i) => { if (n.name) nodeByName[n.name] = i; });

/** Sampled clip builder: sampler(t) -> { bone: { r?, t? } }. */
function clip(name, duration, fps, fn) {
  const times = [];
  for (let t = 0; t <= duration; t += 1 / fps) times.push(+t.toFixed(5));
  if (times[times.length - 1] !== duration) times.push(duration);
  const tracks = new Map();
  const samples = times.map((t) => {
    const pose = fn(t, duration);
    for (const [bone, tr] of Object.entries(pose)) {
      if (!tracks.has(bone)) tracks.set(bone, new Set());
      if (tr.r) tracks.get(bone).add("r");
      if (tr.t) tracks.get(bone).add("t");
    }
    return pose;
  });
  const timeAcc = w.accessor(F32(times), 5126, "SCALAR", times.length, null);
  const samplers = [];
  const channels = [];
  for (const [bone, paths] of tracks) {
    for (const path of paths) {
      const values = [];
      let last = path === "r" ? [0, 0, 0, 1] : null;
      for (const pose of samples) {
        const tr = pose[bone];
        const v = tr && tr[path];
        if (v) last = v;
        else if (!last && path === "t") last = json.nodes[nodeByName[bone]].translation.slice();
        else if (!last) last = [0, 0, 0, 1];
        values.push(...last);
      }
      const outAcc = w.accessor(F32(values), 5126, path === "r" ? "VEC4" : "VEC3", times.length, null);
      samplers.push({ input: timeAcc, output: outAcc, interpolation: "LINEAR" });
      channels.push({
        sampler: samplers.length - 1,
        target: { node: nodeByName[bone], path: path === "r" ? "rotation" : "translation" },
      });
    }
  }
  json.animations.push({ name, channels, samplers });
}

// loc_idle: breathing bob + slow head scan.
clip("loc_idle", 3.2, 10, (t) => {
  const p = t / 3.2 * TAU;
  const pose = {};
  pose.skitter_body = { t: [0, 0.55 + Math.sin(p) * 0.015, 0] };
  pose.head = { r: q(Math.sin(p * 0.5) * 0.03, Math.sin(t * 1.1) * 0.35, 0) };
  return pose;
});

// loc_walk_fwd: diagonal pairs, two footfalls per cycle.
clip("loc_walk_fwd", 1.0, 14, (t) => {
  const ph = t / 1.0 * TAU;
  const swing = (phase) => Math.sin(ph + phase) * 0.45;
  const pose = {};
  pose.skitter_body = {
    r: q(Math.sin(ph * 2) * 0.02, 0, Math.sin(ph) * 0.03),
    t: [0, 0.55 + Math.abs(Math.cos(ph)) * 0.03, 0],
  };
  pose.legFL = { r: q(swing(0)) };
  pose.legBR = { r: q(swing(0)) };
  pose.legFR = { r: q(swing(Math.PI)) };
  pose.legBL = { r: q(swing(Math.PI)) };
  pose.head = { r: q(-swing(0) * 0.12, 0, 0) };
  return pose;
});

// loc_run_fwd: gallop-ish - paired rear drive, front reach, airborne top.
clip("loc_run_fwd", 0.62, 16, (t) => {
  const ph = t / 0.62 * TAU;
  const pose = {};
  pose.skitter_body = {
    r: q(Math.sin(ph) * 0.10, 0, 0),
    t: [0, 0.585 + Math.max(0, Math.sin(ph)) * 0.09, 0],
  };
  pose.legFL = { r: q(Math.sin(ph + 0.4) * 0.85) };
  pose.legFR = { r: q(Math.sin(ph + 0.4) * 0.85) };
  pose.legBL = { r: q(Math.sin(ph + Math.PI) * 0.95) };
  pose.legBR = { r: q(Math.sin(ph + Math.PI) * 0.95) };
  pose.head = { r: q(0.12 + Math.sin(ph) * 0.06, 0, 0) };
  return pose;
});

// act_skitter_lunge: coil -> spring arc -> recover (proportional windows).
clip("act_skitter_lunge", 0.9, 18, (t, D) => {
  const pose = {};
  const coil = Math.min(1, t / (D * 0.35));
  const strike = t >= D * 0.35 ? Math.min(1, (t - D * 0.35) / (D * 0.2)) : 0;
  const settle = t >= D * 0.55 ? Math.min(1, (t - D * 0.55) / (D * 0.45)) : 0;
  const legAng = (-0.85 * coil) + (1.75 * strike) + (-0.90 * settle);
  const pitch = (-0.22 * coil) + (0.30 * strike) + (-0.08 * settle);
  pose.skitter_body = {
    r: q(pitch, 0, 0),
    t: [0, 0.55 - 0.10 * coil + 0.16 * strike - 0.06 * settle, 0],
  };
  pose.legBL = { r: q(legAng) };
  pose.legBR = { r: q(legAng) };
  pose.legFL = { r: q(0.5 * coil - 0.7 * strike + 0.2 * settle) };
  pose.legFR = { r: q(0.5 * coil - 0.7 * strike + 0.2 * settle) };
  pose.head = { r: q(-pitch * 0.7, 0, 0) };
  pose.tail = { r: q(0.4 * coil - 0.3 * strike, 0, 0) };
  return pose;
});

// react_hit: sharp shudder.
clip("react_hit", 0.42, 20, (t, D) => {
  const k = 1 - t / D;
  const pose = {};
  pose.skitter_body = { r: q(0.10 * k, 0, Math.sin(t * 60) * 0.09 * k) };
  pose.head = { r: q(-0.12 * k, 0, 0) };
  return pose;
});

// react_death: tip onto its side and power down.
clip("react_death", 1.3, 16, (t, D) => {
  const k = Math.min(1, t / (D * 0.75));
  const ease = k * k * (3 - 2 * k);
  const pose = {};
  pose.skitter_body = {
    r: q(ease * 0.2, 0, ease * 2.75),
    t: [0, 0.55 - ease * 0.22, 0],
  };
  pose.legFL = { r: q(ease * 0.6) };
  pose.legFR = { r: q(ease * -0.4) };
  pose.legBL = { r: q(ease * 0.8) };
  pose.legBR = { r: q(ease * -0.5) };
  pose.tail = { r: q(ease * 0.5, 0, 0) };
  return pose;
});

if (json.animations.length === 0) delete json.animations;

mkdirSync(OUT_DIR, { recursive: true });
const buf = w.finish(json);
writeFileSync(join(OUT_DIR, "skitter.glb"), buf);
writeFileSync(join(OUT_DIR, "skitter.provenance.json"), JSON.stringify({
  id: "skitter",
  generatedBy: "scripts/create-skitter-asset.mjs",
  authoredBy: "IRONWILD project (procedural, in-repo)",
  license: "MIT",
  modified: false,
  purpose: "authored placeholder - first machine through the authored animator path",
  created: new Date().toISOString(),
}, null, 2));
console.log(`skitter.glb written (${buf.length} bytes, ${json.animations.map((a) => a.name).join(", ")})`);
