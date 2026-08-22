// IRONWILD - repository-generated IRONMAW + DUSKWING machine assets
// (authored-placeholder tier). ORIGINAL content (MIT).
//   ironmaw : mass/armor problem - ponderous gait, layered plating,
//             maw weak point, spine/radiator mounts.
//   duskwing: aerial problem - hover/cruise/fast-flight cycles under the
//             loc_* names (documented convention), banking flaps, beak mount.
// Clips cover what the AnimGraph consumes today (loc_*/react_*); act_* attack
// clips land with the playAttack AI wiring.
//
// Usage: node scripts/create-machines-assets.mjs [ironmaw|duskwing|both]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GlbBuilder, F32, U16 } from "./lib/glb.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "assets", "machines");
const WHICH = process.argv[2] || "both";

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
const q = (rx = 0, ry = 0, rz = 0) => {
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

class MachineDoc {
  constructor(name, materials) {
    this.w = new GlbBuilder();
    this.json = {
      asset: {
        version: "2.0",
        generator: `ironwild scripts/create-machines-assets.mjs (${name})`,
        copyright: "MIT (c) IRONWILD project",
      },
      scene: 0,
      scenes: [{ name, nodes: [] }],
      materials,
      nodes: [],
      meshes: [],
      animations: [],
    };
    this.nodeByName = {};
  }
  meshNode(name, geo, matIdx, t = [0, 0, 0]) {
    const pv = this.w.accessor(F32(geo.pos), 5126, "VEC3", geo.pos.length / 3);
    const nv = this.w.accessor(F32(geo.nor), 5126, "VEC3", geo.nor.length / 3);
    this.json.meshes.push({
      name,
      primitives: [{
        attributes: { POSITION: pv, NORMAL: nv },
        indices: this.w.accessor(U16(geo.idx), 5123, "SCALAR", geo.idx.length, 34963),
        material: matIdx,
      }],
    });
    this.json.nodes.push({ name, mesh: this.json.meshes.length - 1, translation: t, children: [] });
    return this.json.nodes.length - 1;
  }
  groupNode(name, t = [0, 0, 0]) {
    this.json.nodes.push({ name, translation: t, children: [] });
    return this.json.nodes.length - 1;
  }
  index() {
    this.json.nodes.forEach((n, i) => { if (n.name) this.nodeByName[n.name] = i; });
  }
  clip(name, duration, fps, fn) {
    this.index();
    const times = [];
    for (let t = 0; t <= duration; t += 1 / fps) times.push(+t.toFixed(5));
    if (times[times.length - 1] !== duration) times.push(duration);
    const tracks = new Map();
    const samples = times.map((t) => fn(t, duration));
    for (const pose of samples) {
      for (const [bone, tr] of Object.entries(pose)) {
        if (!tracks.has(bone)) tracks.set(bone, new Set());
        if (tr.r) tracks.get(bone).add("r");
        if (tr.t) tracks.get(bone).add("t");
      }
    }
    const timeAcc = this.w.accessor(F32(times), 5126, "SCALAR", times.length, null);
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
          else if (!last && path === "t") last = this.json.nodes[this.nodeByName[bone]].translation.slice();
          else if (!last) last = [0, 0, 0, 1];
          values.push(...last);
        }
        const outAcc = this.w.accessor(F32(values), 5126, path === "r" ? "VEC4" : "VEC3", times.length, null);
        samplers.push({ input: timeAcc, output: outAcc, interpolation: "LINEAR" });
        channels.push({
          sampler: samplers.length - 1,
          target: { node: this.nodeByName[bone], path: path === "r" ? "rotation" : "translation" },
        });
      }
    }
    this.json.animations.push({ name, channels, samplers });
  }
  stripAndWrite(outFile, provenance) {
    for (const n of this.json.nodes) {
      if (Array.isArray(n.children) && n.children.length === 0) delete n.children;
    }
    mkdirSync(OUT_DIR, { recursive: true });
    const buf = this.w.finish(this.json);
    writeFileSync(join(OUT_DIR, outFile), buf);
    writeFileSync(join(OUT_DIR, outFile.replace(/\.glb$/, ".provenance.json")),
      JSON.stringify(provenance, null, 2));
    console.log(`${outFile} written (${buf.length} bytes, ${this.json.animations.map((a) => a.name).join(", ")})`);
  }
}

// ---- IRONMAW ----------------------------------------------------------------

function buildIronmaw() {
  const d = new MachineDoc("ironmaw", [
    { name: "m_steel_hull", pbrMetallicRoughness: { baseColorFactor: [0.30, 0.32, 0.34, 1], metallicFactor: 0.7, roughnessFactor: 0.5 } },
    { name: "m_rust_trim", pbrMetallicRoughness: { baseColorFactor: [0.45, 0.26, 0.17, 1], metallicFactor: 0.3, roughnessFactor: 0.9 } },
    { name: "m_emissive_vent", pbrMetallicRoughness: { baseColorFactor: [1, 0.42, 0.08, 1], metallicFactor: 0, roughnessFactor: 0.5 }, emissiveFactor: [1.0, 0.42, 0.08] },
    { name: "m_ceramic_plate", pbrMetallicRoughness: { baseColorFactor: [0.55, 0.53, 0.48, 1], metallicFactor: 0.15, roughnessFactor: 0.7 } },
  ]);
  const HULL = 0, RUST = 1, VENT = 2, PLATE = 3;
  const root = d.groupNode("ironmaw_body", [0, 1.05, 0]);
  d.json.scenes[0].nodes.push(root);

  // Mass: stacked armor slabs, sloped front cowling.
  d.json.nodes[root].children.push(
    d.meshNode("hull_core", bake(box(1.7, 0.75, 2.3)), HULL),
    d.meshNode("hull_upper", bake(box(1.45, 0.45, 1.7), 0, 0.58, -0.12), PLATE),
    d.meshNode("cowling", bake(box(1.30, 0.62, 0.55), 0, 0.10, 1.02), PLATE),
    d.meshNode("vent_L", bake(box(0.16, 0.30, 1.10), -0.78, 0.52, -0.10), VENT),
    d.meshNode("vent_R", bake(box(0.16, 0.30, 1.10), 0.78, 0.52, -0.10), VENT),
  );

  // Maw assembly: hinged jaw plates + weak point + jaw socket.
  const mawN = d.groupNode("head_maw", [0, 0.10, 1.28]);
  d.json.nodes[mawN].children.push(
    d.meshNode("jaw_top", bake(box(1.05, 0.20, 0.60), 0, 0.14, 0.18), RUST),
    d.meshNode("jaw_bot", bake(box(1.00, 0.18, 0.56), 0, -0.14, 0.16), RUST),
    (() => d.groupNode("wp_maw", [0, 0, 0.42]))(),
    d.groupNode("socket_jaw", [0, -0.24, 0.30]),
  );
  d.json.nodes[root].children.push(mawN);

  // Radiator ridge: secondary weak point + spine mount between the vents.
  d.json.nodes[root].children.push(
    (() => d.groupNode("wp_radiator", [0, 0.86, -0.12]))(),
    d.groupNode("socket_spine", [0, 0.92, -0.55]),
    d.meshNode("radiator_fin_a", bake(box(0.06, 0.34, 0.80), -0.70, 0.88, -0.12), VENT),
    d.meshNode("radiator_fin_b", bake(box(0.06, 0.34, 0.80), 0.70, 0.88, -0.12), VENT),
  );

  // Four columnar legs: hip pivots carry the gait.
  const LX = 0.72, FZ = 0.82, BZ = -0.80;
  for (const [nm, lx, lz] of [["legFL", -LX, FZ], ["legFR", LX, FZ], ["legBL", -LX, BZ], ["legBR", LX, BZ]]) {
    const p = d.groupNode(nm, [lx, -0.30, lz]);
    d.json.nodes[p].children.push(
      d.meshNode(`${nm}_limb`, bake(box(0.30, 0.85, 0.36), 0, -0.42, 0), HULL),
      d.meshNode(`${nm}_foot`, bake(box(0.44, 0.16, 0.58), 0, -0.92, 0.04), RUST),
    );
    d.json.nodes[root].children.push(p);
  }

  // Clips: heavy breathing, ponderous walk, charging run, shudder, collapse.
  d.clip("loc_idle", 3.6, 10, (t) => ({
    ironmaw_body: { t: [0, 1.05 + Math.sin(t / 3.6 * 6.283) * 0.03, 0] },
    head_maw: { r: q(Math.sin(t / 3.6 * 6.283) * 0.02, Math.sin(t * 0.8) * 0.10, 0) },
  }));
  d.clip("loc_walk_fwd", 1.6, 12, (t) => {
    const ph = t / 1.6 * 6.283;
    const s = (p2) => Math.sin(ph + p2) * 0.30;
    return {
      ironmaw_body: { t: [0, 1.05 + Math.abs(Math.cos(ph)) * 0.045, 0] },
      legFL: { r: q(s(0)) }, legBR: { r: q(s(0)) },
      legFR: { r: q(s(Math.PI)) }, legBL: { r: q(s(Math.PI)) },
      head_maw: { r: q(s(0) * 0.25, 0, 0) },
    };
  });
  d.clip("loc_run_fwd", 1.0, 14, (t) => {
    const ph = t / 1.0 * 6.283;
    const s = (p2) => Math.sin(ph + p2) * 0.52;
    return {
      ironmaw_body: {
        r: q(Math.sin(ph) * 0.05, 0, 0),
        t: [0, 1.09 + Math.abs(Math.cos(ph)) * 0.07, 0],
      },
      legFL: { r: q(s(0)) }, legBR: { r: q(s(0)) },
      legFR: { r: q(s(Math.PI)) }, legBL: { r: q(s(Math.PI)) },
      head_maw: { r: q(-0.10 + s(0) * 0.3, 0, 0) },
    };
  });
  d.clip("react_hit", 0.5, 20, (t, D2) => {
    const k = 1 - t / D2;
    return { ironmaw_body: { r: q(0.04 * k, 0, Math.sin(t * 50) * 0.05 * k) } };
  });
  d.clip("react_death", 1.6, 16, (t, D2) => {
    const k = Math.min(1, t / (D2 * 0.7));
    const e = k * k * (3 - 2 * k);
    return {
      ironmaw_body: {
        r: q(e * 0.55, 0, 0),
        t: [0, 1.05 - e * 0.55, 0],
      },
      head_maw: { r: q(e * 0.5, 0, 0) },
      legFL: { r: q(e * -0.7) }, legFR: { r: q(e * -0.7) },
      legBL: { r: q(e * 0.9) }, legBR: { r: q(e * 0.9) },
    };
  });

  d.stripAndWrite("ironmaw.glb", {
    id: "ironmaw",
    generatedBy: "scripts/create-machines-assets.mjs",
    authoredBy: "IRONWILD project (procedural, in-repo)",
    license: "MIT",
    modified: false,
    purpose: "authored placeholder - mass/armor archetype through the animator path",
    created: new Date().toISOString(),
  });
}

// ---- DUSKWING ---------------------------------------------------------------

function buildDuskwing() {
  const d = new MachineDoc("duskwing", [
    { name: "m_steel_airframe", pbrMetallicRoughness: { baseColorFactor: [0.20, 0.23, 0.27, 1], metallicFactor: 0.6, roughnessFactor: 0.45 } },
    { name: "m_rust_panel", pbrMetallicRoughness: { baseColorFactor: [0.40, 0.24, 0.16, 1], metallicFactor: 0.3, roughnessFactor: 0.8 } },
    { name: "m_emissive_scan", pbrMetallicRoughness: { baseColorFactor: [0.4, 0.95, 1, 1], metallicFactor: 0, roughnessFactor: 0.4 }, emissiveFactor: [0.4, 0.95, 1.0] },
  ]);
  const HULL = 0, PANEL = 1, SCAN = 2;
  // NOTE: root sits at the body centre; the game positions machines on terrain.
  // Hover height comes from the aerial AI, not the asset origin.
  const root = d.groupNode("duskwing_body", [0, 0, 0]);
  d.json.scenes[0].nodes.push(root);

  d.json.nodes[root].children.push(
    d.meshNode("fuselage", bake(box(0.44, 0.34, 1.60)), HULL),
    d.meshNode("canopy", bake(box(0.30, 0.16, 0.55), 0, 0.22, 0.30), PANEL),
    d.meshNode("chest_plate", bake(box(0.46, 0.20, 0.40), 0, -0.06, 0.42), PANEL),
    (() => {
      const n = d.groupNode("head_beak", [0, 0.04, 0.86]);
      d.json.nodes[n].children.push(
        d.meshNode("crest", bake(box(0.20, 0.10, 0.30)), HULL),
        d.meshNode("beak_scan", bake(box(0.08, 0.06, 0.34), 0, -0.01, 0.28), SCAN),
        d.groupNode("socket_beak", [0, -0.06, 0.34]),
      );
      return n;
    })(),
    (() => d.groupNode("wp_chest", [0, -0.20, 0.42]))(),
  );

  // Wings: flap about the Z axis at the shoulder roots.
  for (const side of [-1, 1]) {
    const nm = side < 0 ? "wingL" : "wingR";
    const p = d.groupNode(nm, [0.22 * side, 0.10, -0.05]);
    d.json.nodes[p].children.push(
      d.meshNode(`${nm}_inner`, bake(box(0.85, 0.07, 0.60), 0.42 * side, 0, 0), HULL),
      d.meshNode(`${nm}_tip`, bake(box(0.55, 0.05, 0.34), 1.10 * side, 0, -0.10), PANEL),
    );
    d.json.nodes[root].children.push(p);
  }

  // Tail fan + landing struts (tucked).
  const tail = d.groupNode("tail", [0, 0.06, -0.78]);
  d.json.nodes[tail].children.push(
    d.meshNode("tail_fan", bake(box(0.05, 0.42, 0.34)), PANEL),
    d.meshNode("tail_rod", bake(box(0.08, 0.08, 0.40)), HULL),
  );
  d.json.nodes[root].children.push(tail);
  d.json.nodes[root].children.push(
    d.meshNode("strut_L", bake(box(0.06, 0.30, 0.10), -0.16, -0.28, 0.20), HULL),
    d.meshNode("strut_R", bake(box(0.06, 0.30, 0.10), 0.16, -0.28, 0.20), HULL),
  );

  // Clips: hover (idle), cruise, fast flight, shudder, spiral-down death.
  d.clip("loc_idle", 2.6, 12, (t) => {
    const ph = t / 2.6 * 6.283;
    const flap = Math.sin(ph * 2) * 0.22;
    return {
      duskwing_body: { t: [0, Math.sin(ph * 2) * 0.08, 0] },
      wingL: { r: q(0, 0, flap) },
      wingR: { r: q(0, 0, -flap) },
      head_beak: { r: q(Math.sin(t * 1.3) * 0.06, Math.sin(t * 0.9) * 0.2, 0) },
      tail: { r: q(-flap * 0.4, 0, 0) },
    };
  });
  d.clip("loc_walk_fwd", 1.1, 14, (t) => {
    const ph = t / 1.1 * 6.283;
    const flap = Math.sin(ph * 2) * 0.38;
    return {
      duskwing_body: {
        r: q(Math.sin(ph) * 0.06, 0, 0),
        t: [0, Math.sin(ph * 2) * 0.05, 0],
      },
      wingL: { r: q(0, 0, flap) },
      wingR: { r: q(0, 0, -flap) },
      tail: { r: q(-flap * 0.5, 0, 0) },
    };
  });
  d.clip("loc_run_fwd", 0.7, 16, (t) => {
    const ph = t / 0.7 * 6.283;
    const flap = Math.sin(ph) * 0.55 - 0.10;
    return {
      duskwing_body: { r: q(0.14, 0, Math.sin(ph) * 0.05) },
      wingL: { r: q(0, 0, flap) },
      wingR: { r: q(0, 0, -flap) },
      tail: { r: q(0.25 - flap * 0.3, 0, 0) },
      head_beak: { r: q(-0.08, 0, 0) },
    };
  });
  d.clip("react_hit", 0.4, 20, (t, D2) => {
    const k = 1 - t / D2;
    return { duskwing_body: { r: q(0.08 * k, 0, Math.sin(t * 55) * 0.10 * k) } };
  });
  d.clip("react_death", 1.5, 16, (t, D2) => {
    const k = Math.min(1, t / D2);
    const e = k * k;
    return {
      duskwing_body: {
        r: q(e * 0.9, e * 1.6, e * 0.8),
        t: [0, -e * 0.35, -e * 0.25],
      },
      wingL: { r: q(0, 0, -e * 0.9) },
      wingR: { r: q(0, 0, e * 0.9) },
      tail: { r: q(e * 0.6, 0, 0) },
    };
  });

  d.stripAndWrite("duskwing.glb", {
    id: "duskwing",
    generatedBy: "scripts/create-machines-assets.mjs",
    authoredBy: "IRONWILD project (procedural, in-repo)",
    license: "MIT",
    modified: false,
    purpose: "authored placeholder - aerial archetype; loc_* carry hover/cruise/fast flight",
    created: new Date().toISOString(),
  });
}

if (WHICH === "ironmaw" || WHICH === "both") buildIronmaw();
if (WHICH === "duskwing" || WHICH === "both") buildDuskwing();
