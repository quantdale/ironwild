// IRONWILD pipeline-certification asset generator.
//
// Produces public/assets/env/wayshrine.glb - an ORIGINAL, repository-generated
// prop whose ONLY job is to certify the authored-asset path end to end:
//   PBR material -> KTX2 base-color texture (KHR_texture_basisu) -> named
//   sockets -> _lod0/_lod1/_lod2 children with monotonically decreasing
//   triangles -> one animation clip -> provenance sidecar -> AssetManager ->
//   visible in game -> telemetry counted.
//
// The texture ships as an uncompressed RGBA8 KTX2 container authored here
// with three's bundled ktx-parse writer: the runtime exercises the REAL
// KTX2Loader path (container parse -> GPU-format detection -> upload) without
// needing the Basis transcoder wasm. Block compression lands with real art.
//
// This is explicitly a PIPELINE PROOF asset, not a production-art claim.
//
// Usage: node scripts/create-cert-asset.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KTX2Container,
  KHR_DF_KHR_DESCRIPTORTYPE_BASICFORMAT,
  KHR_DF_MODEL_RGBSDA,
  KHR_DF_PRIMARIES_BT709,
  KHR_DF_TRANSFER_LINEAR,
  KHR_DF_FLAG_ALPHA_STRAIGHT,
  KHR_DF_CHANNEL_RGBSDA_RED,
  KHR_DF_CHANNEL_RGBSDA_GREEN,
  KHR_DF_CHANNEL_RGBSDA_BLUE,
  KHR_DF_CHANNEL_RGBSDA_ALPHA,
  VK_FORMAT_R8G8B8A8_UNORM,
  write as writeKtx2,
} from "three/examples/jsm/libs/ktx-parse.module.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "assets", "env");

// ---- tiny glTF/GLB writer ---------------------------------------------------

class Bin {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  push(typedArr) {
    // 4-byte alignment per spec.
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.chunks.push(new Uint8Array(pad));
      this.length += pad;
    }
    const bytes = new Uint8Array(
      typedArr.buffer,
      typedArr.byteOffset,
      typedArr.byteLength,
    );
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
    return this.length - bytes.byteLength; // offset
  }
}

function makeWriter() {
  const bin = new Bin();
  const accessors = [];
  const bufferViews = [];
  return {
    // target: 34962 ARRAY_BUFFER | 34963 ELEMENT_ARRAY_BUFFER | null
    // (null = no GPU role, e.g. animation sampler input/output - the property
    // must be OMITTED there, and min/max likewise when not meaningful).
    accessor(arr, componentType, type, count, target = 34962) {
      const view = {
        buffer: 0,
        byteOffset: bin.push(arr),
        byteLength: arr.byteLength,
      };
      if (target != null) view.target = target;
      const bv = bufferViews.push(view) - 1;
      const acc = {
        bufferView: bv,
        componentType,
        count,
        type,
      };
      accessors.push(acc);
      const accIdx = accessors.length - 1;
      if (type === "VEC3" && componentType === 5126) {
        const mn = [Infinity, Infinity, Infinity];
        const mx = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < arr.length; i += 3) {
          for (let k = 0; k < 3; k++) {
            if (arr[i + k] < mn[k]) mn[k] = arr[i + k];
            if (arr[i + k] > mx[k]) mx[k] = arr[i + k];
          }
        }
        accessors[accIdx].min = mn;
        accessors[accIdx].max = mx;
      } else if (type === "SCALAR" && componentType === 5126) {
        let mn = Infinity;
        let mx = -Infinity;
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] < mn) mn = arr[i];
          if (arr[i] > mx) mx = arr[i];
        }
        accessors[accIdx].min = [mn];
        accessors[accIdx].max = [mx];
      }
      return accIdx;
    },
    /** Raw bufferView without an accessor (embedded images). */
    rawBufferView(typedArr) {
      return bufferViews.push({
        buffer: 0,
        byteOffset: bin.push(typedArr),
        byteLength: typedArr.byteLength,
      }) - 1;
    },
    finish(json) {
      json.accessors = accessors;
      json.bufferViews = bufferViews;
      json.buffers = [{ byteLength: bin.length }];
      const enc = new TextEncoder();
      const jsonBytes = enc.encode(JSON.stringify(json));
      const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
      const total =
        12 + 8 + jsonBytes.length + jsonPad + 8 + bin.length;
      const out = new ArrayBuffer(total);
      const dv = new DataView(out);
      const u8 = new Uint8Array(out);
      dv.setUint32(0, 0x46546c67, true); // 'glTF'
      dv.setUint32(4, 2, true);
      dv.setUint32(8, total, true);
      dv.setUint32(12, jsonBytes.length + jsonPad, true);
      dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
      u8.set(jsonBytes, 20);
      // Spec: JSON chunk padding must be 0x20 (space), not zero bytes.
      for (let i = 0; i < jsonPad; i++) u8[20 + jsonBytes.length + i] = 0x20;
      let o = 20 + jsonBytes.length + jsonPad;
      dv.setUint32(o, bin.length, true);
      dv.setUint32(o + 4, 0x004e4942, true); // 'BIN\0'
      o += 8;
      for (const c of bin.chunks) {
        u8.set(c, o);
        o += c.byteLength;
      }
      return Buffer.from(out);
    },
  };
}

// ---- geometry ---------------------------------------------------------------

/** Tapered N-gon prism (no caps needed: base slab hides the bottom). */
function prism(radiusBottom, radiusTop, height, sides) {
  const pos = [];
  const nor = [];
  const idx = [];
  for (let i = 0; i <= sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    pos.push(c * radiusBottom, 0, s * radiusBottom);
    pos.push(c * radiusTop, height, s * radiusTop);
    nor.push(Math.cos(a + Math.PI / sides), 0, Math.sin(a + Math.PI / sides));
    nor.push(Math.cos(a + Math.PI / sides), 0, Math.sin(a + Math.PI / sides));
  }
  for (let i = 0; i < sides; i++) {
    const o = i * 2;
    idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
  }
  return { pos, nor, idx };
}

function boxGeo(sx, sy, sz) {
  // 12-tri box with outward normals (positions duplicated per face).
  const f = [
    [[0, 0, 1], [-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]],
    [[0, 0,-1], [1,-1,-1],[-1,-1,-1],[-1,1,-1],[1,1,-1]],
    [[1, 0, 0], [1,-1,1],[1,-1,-1],[1,1,-1],[1,1,1]],
    [[-1, 0, 0], [-1,-1,-1],[-1,-1,1],[-1,1,1],[-1,1,-1]],
    [[0, 1, 0], [-1,1,1],[1,1,1],[1,1,-1],[-1,1,-1]],
    [[0,-1, 0], [-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1]],
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

function octahedron(r) {
  const v = [
    [r,0,0],[-r,0,0],[0,r,0],[0,-r,0],[0,0,r],[0,0,-r],
  ];
  const quads = [
    [4,0,2],[4,2,1],[4,1,3],[4,3,0],
    [5,2,0],[5,1,2],[5,3,1],[5,0,3],
  ];
  const pos = [];
  const nor = [];
  const idx = [];
  quads.forEach((tri, ti) => {
    for (const vi of tri) {
      pos.push(...v[vi]);
      const l = Math.hypot(...v[vi]);
      nor.push(v[vi][0] / l, v[vi][1] / l, v[vi][2] / l);
    }
    const b = ti * 3;
    idx.push(b, b + 1, b + 2);
  });
  return { pos, nor, idx };
}

/** Octagonal ring (torus approximation): sides segments x tube quads. */
function ringGeo(radius, tube, seg, tubeSeg) {
  const pos = [];
  const nor = [];
  const idx = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    for (let j = 0; j <= tubeSeg; j++) {
      const b = (j / tubeSeg) * Math.PI * 2;
      const cx = Math.cos(a) * radius;
      const cz = Math.sin(a) * radius;
      const x = (radius + Math.cos(b) * tube) * Math.cos(a);
      const y = Math.sin(b) * tube;
      const z = (radius + Math.cos(b) * tube) * Math.sin(a);
      pos.push(x, y, z);
      const nx = x - cx;
      const ny = y;
      const nz = z - cz;
      const nl = Math.hypot(nx, ny, nz);
      nor.push(nx / nl, ny / nl, nz / nl);
    }
  }
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < tubeSeg; j++) {
      const o = i * (tubeSeg + 1) + j;
      const n = o + tubeSeg + 1;
      idx.push(o, n, o + 1, o + 1, n, n + 1);
    }
  }
  return { pos, nor, idx };
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

const triCount = (g) => g.idx.length / 3;

/** Planar top-down UV projection over the merged geometry's xz bounds. */
function addPlanarUVs(g) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < g.pos.length; i += 3) {
    if (g.pos[i] < minX) minX = g.pos[i];
    if (g.pos[i] > maxX) maxX = g.pos[i];
    if (g.pos[i + 2] < minZ) minZ = g.pos[i + 2];
    if (g.pos[i + 2] > maxZ) maxZ = g.pos[i + 2];
  }
  const sx = Math.max(1e-6, maxX - minX);
  const sz = Math.max(1e-6, maxZ - minZ);
  const uv = [];
  for (let i = 0; i < g.pos.length; i += 3) {
    uv.push((g.pos[i] - minX) / sx, (g.pos[i + 2] - minZ) / sz);
  }
  return { ...g, uv };
}

// ---- build the wayshrine ----------------------------------------------------

// lod0: full detail. lod1: fewer sides, no ring. lod2: coarse stump+shardless.
function bake(g, dx, dy, dz) {
  const pos = g.pos.slice();
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] += dx;
    pos[i + 1] += dy;
    pos[i + 2] += dz;
  }
  return { pos, nor: g.nor.slice(), idx: g.idx.slice() };
}
const lod0g = merge([
  bake(boxGeo(1.7, 0.34, 1.7), 0, 0.17, 0),
  bake(prism(0.42, 0.26, 2.3, 8), 0, 0.34, 0),
  bake(ringGeo(0.44, 0.05, 10, 4), 0, 2.64, 0),
]);
const lod1g = merge([
  bake(boxGeo(1.7, 0.34, 1.7), 0, 0.17, 0),
  bake(prism(0.42, 0.28, 2.3, 5), 0, 0.34, 0),
]);
const lod2g = merge([bake(prism(0.5, 0.34, 1.6, 4), 0, 0.2, 0)]);

// ---- KTX2 base-color texture (uncompressed RGBA8 container) -----------------

const TEX_SIZE = 64;
const texBytes = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
for (let y = 0; y < TEX_SIZE; y++) {
  for (let x = 0; x < TEX_SIZE; x++) {
    // Procedural waystone: banded stone with a cyan glyph cross.
    const band = Math.sin(y * 0.45) * 0.5 + 0.5;
    const grain = ((x * 7 + y * 13) % 17) / 17 * 0.08;
    let r = 0.62 + band * 0.1 + grain;
    let g = 0.6 + band * 0.1 + grain;
    let b = 0.56 + band * 0.1 + grain;
    const dx = Math.abs(x - TEX_SIZE / 2);
    const dy = Math.abs(y - TEX_SIZE / 2);
    if (Math.min(dx, dy) < 3 || (dx < 10 && dy < 10 && (x + y) % 9 < 2)) {
      r = 0.25; g = 0.75; b = 0.85; // emissive-looking glyph tint
    }
    const o = (y * TEX_SIZE + x) * 4;
    texBytes[o] = Math.round(Math.min(1, r) * 255);
    texBytes[o + 1] = Math.round(Math.min(1, g) * 255);
    texBytes[o + 2] = Math.round(Math.min(1, b) * 255);
    texBytes[o + 3] = 255;
  }
}

const ktx2Container = new KTX2Container();
ktx2Container.vkFormat = VK_FORMAT_R8G8B8A8_UNORM; // uncompressed: no transcoder
ktx2Container.typeSize = 4;
ktx2Container.pixelWidth = TEX_SIZE;
ktx2Container.pixelHeight = TEX_SIZE;
ktx2Container.faceCount = 1;
ktx2Container.levels = [
  {
    levelData: texBytes,
    uncompressedByteLength: texBytes.byteLength,
  },
];
ktx2Container.dataFormatDescriptor = [
  {
    vendorId: 0,
    descriptorType: KHR_DF_KHR_DESCRIPTORTYPE_BASICFORMAT,
    descriptorBlockSize: 16 + 4 * 16,
    versionNumber: 2,
    colorModel: KHR_DF_MODEL_RGBSDA,
    colorPrimaries: KHR_DF_PRIMARIES_BT709,
    transferFunction: KHR_DF_TRANSFER_LINEAR,
    flags: KHR_DF_FLAG_ALPHA_STRAIGHT,
    texelBlockDimension: [0, 0, 0, 0],
    bytesPlane: [4, 0, 0, 0, 0, 0, 0, 0],
    samples: [
      { bitOffset: 0, bitLength: 8, channelType: KHR_DF_CHANNEL_RGBSDA_RED, samplePosition: [0, 0, 0, 0], sampleLower: 0, sampleUpper: 255 },
      { bitOffset: 8, bitLength: 8, channelType: KHR_DF_CHANNEL_RGBSDA_GREEN, samplePosition: [0, 0, 0, 0], sampleLower: 0, sampleUpper: 255 },
      { bitOffset: 16, bitLength: 8, channelType: KHR_DF_CHANNEL_RGBSDA_BLUE, samplePosition: [0, 0, 0, 0], sampleLower: 0, sampleUpper: 255 },
      { bitOffset: 24, bitLength: 8, channelType: KHR_DF_CHANNEL_RGBSDA_ALPHA, samplePosition: [0, 0, 0, 0], sampleLower: 0, sampleUpper: 255 },
    ],
  },
];
ktx2Container.keyValue = {
  KTXwriter: "ironwild scripts/create-cert-asset.mjs (ktx-parse)",
};
const ktx2Bytes = writeKtx2(ktx2Container);

if (!(triCount(lod0g) > triCount(lod1g) && triCount(lod1g) > triCount(lod2g))) {
  throw new Error("LOD triangle counts are not monotonically decreasing");
}

// ---- assemble document ------------------------------------------------------

const w = makeWriter();
const F32 = (a) => new Float32Array(a);
const U16 = (a) => new Uint16Array(a);

function addPrim(g) {
  const withUV = addPlanarUVs(g);
  const pv = w.accessor(F32(withUV.pos), 5126, "VEC3", withUV.pos.length / 3);
  const nv = w.accessor(F32(withUV.nor), 5126, "VEC3", withUV.nor.length / 3);
  const tv = w.accessor(F32(withUV.uv), 5126, "VEC2", withUV.uv.length / 2);
  const iv = w.accessor(U16(withUV.idx), 5123, "SCALAR", withUV.idx.length, 34963);
  return {
    attributes: { POSITION: pv, NORMAL: nv, TEXCOORD_0: tv },
    indices: iv,
    material: 0,
  };
}

const json = {
  asset: {
    version: "2.0",
    generator: "ironwild scripts/create-cert-asset.mjs",
    copyright: "MIT (c) IRONWILD project",
  },
  scene: 0,
  scenes: [{ name: "wayshrine", nodes: [0] }],
  extensionsUsed: ["KHR_texture_basisu"], // optional: loaders without KTX2 fall back to factors
  materials: [
    {
      name: "m_ceramic",
      pbrMetallicRoughness: {
        baseColorFactor: [0.72, 0.7, 0.66, 1],
        baseColorTexture: { index: 0 }, // KTX2 (KHR_texture_basisu)
        metallicFactor: 0.15,
        roughnessFactor: 0.72,
      },
      doubleSided: false,
    },
  ],
  images: [
    {
      // Embedded uncompressed-RGBA8 KTX2 container (see texture section).
      mimeType: "image/ktx2",
      bufferView: -1, // filled after prims are staged
    },
  ],
  samplers: [{ magFilter: 9729, minFilter: 9729, wrapS: 33071, wrapT: 33071 }],
  textures: [
    { sampler: 0, extensions: { KHR_texture_basisu: { source: 0 } } },
  ],
  nodes: [],
  meshes: [],
  animations: [],
};

// Node layout:
// 0 root 'wayshrine'
//   1 'wayshrine_lod0' -> mesh 0
//   2 'wayshrine_lod1' -> mesh 1
//   3 'wayshrine_lod2' -> mesh 2
//   4 'socket_brazier' (empty)
//   5 'shard'          -> mesh 3 (animated)
//   6 'wp_core'        (empty weak-point volume)
json.meshes.push({ name: "wayshrine_lod0", primitives: [addPrim(lod0g)] });
json.meshes.push({ name: "wayshrine_lod1", primitives: [addPrim(lod1g)] });
json.meshes.push({ name: "wayshrine_lod2", primitives: [addPrim(lod2g)] });
json.meshes.push({ name: "wayshrine_shard", primitives: [addPrim(bake(octahedron(0.14), 0, 0, 0))] });

// Patch the embedded KTX2 image with its now-known bufferView.
json.images[0].bufferView = w.rawBufferView(ktx2Bytes);

json.nodes.push(
  { name: "wayshrine", children: [1, 2, 3, 4, 5, 6] },
  { name: "wayshrine_lod0", mesh: 0 },
  { name: "wayshrine_lod1", mesh: 1 },
  { name: "wayshrine_lod2", mesh: 2 },
  {
    name: "socket_brazier",
    translation: [0, 2.9, 0],
    rotation: [0, 0, 0, 1],
  },
  { name: "shard", translation: [0, 3.25, 0], rotation: [0, 0, 0, 1] },
  { name: "wp_core", translation: [0, 2.64, 0], rotation: [0, 0, 0, 1] },
);

// One clip proving the animation path: shard spins about Y over ~6s.
{
  const FPS = 12;
  const SEC = 6;
  const times = [];
  for (let t = 0; t <= SEC * FPS; t++) times.push(t / FPS);
  const quats = [];
  for (const t of times) {
    const half = (t / SEC) * Math.PI; // glTF quats are xyzw
    const s = Math.sin(half);
    quats.push(0, s, 0, Math.cos(half));
  }
  json.animations.push({
    name: "act_spin",
    channels: [{ sampler: 0, target: { node: 5, path: "rotation" } }],
    samplers: [
      {
        input: w.accessor(F32(times), 5126, "SCALAR", times.length, null),
        output: w.accessor(
          F32(quats),
          5126,
          "VEC4",
          quats.length / 4,
          null,
        ),
        interpolation: "LINEAR",
      },
    ],
  });
}

mkdirSync(OUT_DIR, { recursive: true });
const buf = w.finish(json);
writeFileSync(join(OUT_DIR, "wayshrine.glb"), buf);
writeFileSync(join(OUT_DIR, "wayshrine_tex.ktx2"), Buffer.from(ktx2Bytes));

const provenance = {
  id: "wayshrine",
  generatedBy: "scripts/create-cert-asset.mjs",
  authoredBy: "IRONWILD project (procedural, in-repo)",
  license: "MIT",
  modified: false,
  purpose: "pipeline certification - NOT production art",
  created: new Date().toISOString(),
};
writeFileSync(
  join(OUT_DIR, "wayshrine.provenance.json"),
  JSON.stringify(provenance, null, 2),
);

console.log(
  `wayshrine.glb written (${buf.length} bytes, tris lod0=${triCount(lod0g)} lod1=${triCount(lod1g)} lod2=${triCount(lod2g)})`,
);
