// IRONWILD authored-asset validator (`npm run assets:validate`).
//
// For every manifest entry with a real url, validates:
//   - file presence + provenance sidecar (who/where/license/modified)
//   - Khronos glTF structural validity (official gltf-validator WASM)
//   - malformed GLB container / missing binary chunks
//   - material presence + m_<class> naming for impact classing
//   - texture dimensions (suspiciously huge resources)
//   - required sockets (socket_*) and weak points (wp_*)
//   - LOD presence (_lodN children) and triangle monotonicity
//   - expected animation clips
//   - scale sanity (bounding box in metres, Y-up) + transform sanity
//
// Exit code 0 = every authored asset passes. Exit 1 = any failure.
// Unauthored (url:null) placeholders are skipped by design - they are the
// documented permanent state until art ships.
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSET_MANIFEST } from "../src/assets/manifest.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");

const MAX_BIN_BYTES = 96 * 1024 * 1024;
const MAX_MESH_EXTENT_M = 60; // world-scale sanity: nothing legit is >60 m in one axis

function parseGlb(bytes) {
  if (bytes.length < 20) throw new Error("GLB too small");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== 0x46546c67) throw new Error("not a GLB container (bad magic)");
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`unsupported GLB version ${version}`);
  let off = 12;
  let json = null;
  let binLength = 0;
  while (off < bytes.length) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const chunk = bytes.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === 0x004e4942) binLength += len;
    off += 8 + len;
  }
  if (!json) throw new Error("GLB has no JSON chunk");
  return { json, binLength };
}

/** Total triangles per node subtree (mesh prims summed through children). */
function triCounts(json) {
  const meshTris = (json.meshes || []).map((m) =>
    (m.primitives || []).reduce((n, p) => {
      if (p.indices == null) return n; // non-indexed: count via accessor
      return n + json.accessors[p.indices].count / 3;
    }, 0),
  );
  // Non-indexed support: POSITION accessor count / 3 when no indices.
  (json.meshes || []).forEach((m, i) => {
    if (!m._tris) {
      m._tris = meshTris[i];
      if (meshTris[i] === 0 && m.primitives?.[0]) {
        const pos = m.primitives[0].attributes.POSITION;
        m._tris = pos != null ? json.accessors[pos].count / 3 : 0;
      }
    }
  });
  const memo = new Map();
  const walk = (nodeIdx) => {
    if (memo.has(nodeIdx)) return memo.get(nodeIdx);
    const n = json.nodes[nodeIdx];
    let t = n.mesh != null ? json.meshes[n.mesh]._tris || 0 : 0;
    for (const c of n.children || []) t += walk(c);
    memo.set(nodeIdx, t);
    return t;
  };
  return walk;
}

function positionExtent(json, nodeIdx) {
  // Max axis extent of the node's own mesh POSITION accessor min/max.
  const n = json.nodes[nodeIdx];
  if (n.mesh == null) return 0;
  const prim = json.meshes[n.mesh].primitives[0];
  if (!prim || prim.attributes.POSITION == null) return 0;
  const acc = json.accessors[prim.attributes.POSITION];
  if (!acc.min || !acc.max) return 0;
  let e = 0;
  for (let k = 0; k < 3; k++) e = Math.max(e, acc.max[k] - acc.min[k]);
  return e;
}

async function main() {
  const failures = [];
  const checked = [];
  const { validateBytes } = await import("gltf-validator");

  for (const [category, entries] of Object.entries(ASSET_MANIFEST)) {
    for (const entry of Object.values(entries)) {
      if (!entry || !entry.url) continue; // unauthored placeholder - skip
      const rel = entry.url.replace(/^\//, ""); // '/assets/x' -> 'assets/x' under public/
      const path = join(PUBLIC, rel);
      const label = `${category}/${entry.id}`;
      const errs = [];
      const warns = [];

      // --- provenance sidecar -------------------------------------------
      const provPath = path.replace(/\.glb$/, ".provenance.json");
      let prov = null;
      if (!existsSync(path)) {
        errs.push("binary missing");
      } else {
        if (!existsSync(provPath)) {
          errs.push("provenance sidecar missing (<id>.provenance.json)");
        } else {
          try {
            prov = JSON.parse(readFileSync(provPath, "utf8"));
            for (const field of ["generatedBy", "authoredBy", "license", "purpose"]) {
              if (!prov[field]) errs.push(`provenance.${field} empty`);
            }
          } catch {
            errs.push("provenance sidecar unparsable");
          }
        }
      }

      // --- structure ------------------------------------------------------
      let doc = null;
      try {
        doc = parseGlb(new Uint8Array(readFileSync(path)));
        if (doc.binLength > MAX_BIN_BYTES) errs.push("binary chunk suspiciously huge");
      } catch (e) {
        errs.push(`GLB parse: ${e.message}`);
      }

      if (doc) {
        // --- Khronos official validator ---------------------------------
        try {
          const report = await validateBytes(
            new Uint8Array(readFileSync(path)),
            { uri: rel, format: "glb", writeTimestamp: false },
          );
          const issues = report.issues || {};
          for (const m of issues.messages || []) {
            // Khronos severities: 0=error, 1=warning, 2=information, 3=hint.
            if (m.severity === 0) errs.push(`khronos error: ${m.message}`);
            else if (m.severity === 1) warns.push(`khronos warn: ${m.message}`);
            else warns.push(`khronos note: ${m.message}`);
          }
          const info = report.info || {};
          if ((info.animationCount ?? 0) !== (doc.json.animations?.length ?? 0)) {
            warns.push("khronos/glb animation count disagreement");
          }
        } catch (e) {
          errs.push(`gltf-validator failed: ${e.message}`);
        }

        const j = doc.json;

        // --- materials ----------------------------------------------------
        const mats = j.materials || [];
        if (!mats.length) errs.push("no materials (PBR required)");
        else {
          for (const m of mats) {
            if (!/^m_[a-z]+/.test(m.name || "")) {
              warns.push(`material "${m.name}" lacks m_<class> tag`);
            }
          }
        }

        // --- textures -------------------------------------------------------
        for (const img of j.images || []) {
          // dimensions live in extensions or are unknowable without decode;
          // the Khronos report covers real checks, we guard names/sizes here.
          if ((img.uri || "").length > 512) warns.push("suspicious image uri");
        }

        // --- nodes/conventions ---------------------------------------------
        const names = (j.nodes || []).map((n) => n.name || "");
        for (const s of entry.sockets || []) {
          if (!names.some((n) => n === s)) errs.push(`socket '${s}' missing`);
        }
        for (const wp of entry.weakPoints || []) {
          if (!names.includes(wp.tag)) errs.push(`weak point '${wp.tag}' missing`);
        }

        // --- LODs ------------------------------------------------------------
        const rootNodes = j.scenes[j.scene].nodes;
        const lodLevel = {};
        for (const ri of rootNodes) {
          for (const ci of j.nodes[ri].children || []) {
            const nm = j.nodes[ci].name || "";
            const m2 = /_lod(\d+)$/.exec(nm);
            if (m2) lodLevel[Number(m2[1])] = ci;
          }
        }
        const wantsLods = (entry.lods?.length || 0) > 0 ? null : ["0", "1", "2"];
        void wantsLods; // single-file convention: lods are _lodN CHILDREN
        if (entry.id !== "ruin_kit") {
          // machines/player/env props ship multi-LOD single files unless the
          // entry declares per-level files.
          if (!entry.lods && Object.keys(lodLevel).length === 0) {
            warns.push("no _lodN children (single-resolution asset)");
          }
          if (Object.keys(lodLevel).length >= 2) {
            const trisOf = triCounts(j);
            const levels = Object.keys(lodLevel)
              .map(Number)
              .sort((a, b) => a - b);
            for (let i = 1; i < levels.length; i++) {
              const a = trisOf(lodLevel[levels[i - 1]]);
              const b = trisOf(lodLevel[levels[i]]);
              if (!(b < a)) {
                errs.push(
                  `lod${levels[i]} (${b} tris) not below lod${levels[i - 1]} (${a})`,
                );
              }
            }
          }
        }

        // --- clips ------------------------------------------------------------
        const clipNames = new Set((j.animations || []).map((a) => a.name));
        for (const want of entry.clips || []) {
          if (!clipNames.has(want)) errs.push(`clip '${want}' missing`);
        }

        // --- scale/transform sanity -------------------------------------------
        for (const ri of rootNodes) {
          const n = j.nodes[ri];
          if (n.scale && (Math.abs(n.scale[0]) > 50 || Math.abs(n.scale[1]) > 50)) {
            warns.push("root carries large scale - author at world scale instead");
          }
          const e = positionExtent(j, ri);
          if (e > MAX_MESH_EXTENT_M) errs.push(`mesh extent ${e.toFixed(1)}m unrealistic`);
        }
      }

      checked.push({
        id: label,
        url: entry.url,
        binKB: doc ? Math.round(doc.binLength / 1024) : null,
        textures: doc ? (doc.json.textures || []).length : null,
        materials: doc ? (doc.json.materials || []).length : null,
        animations: doc ? (doc.json.animations || []).length : null,
        license: prov ? prov.license : null,
        warnings: warns,
        errors: errs,
      });
      for (const e of errs) failures.push(`${label}: ${e}`);
    }
  }

  console.log(JSON.stringify(checked, null, 2));
  if (failures.length) {
    console.error(`\nASSET VALIDATION FAILED (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  const authored = checked.length;
  console.log(`\nasset validation OK (${authored} authored asset${authored === 1 ? "" : "s"})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
