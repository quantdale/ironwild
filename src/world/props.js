// IRONWILD - static world props + resource pickups.
// Trees, rocks, stealth grass and ruins are InstancedMesh batches placed
// deterministically from CONFIG.seed. Pickups are small merged-geometry meshes
// registered into G.pickups; updateProps handles bob/spin, proximity prompts
// and KeyE collection. spawnPickup() is the loot-drop entry for machines.
// v3: flora richness - instanced flowers (two head colours), mushrooms and
// fallen logs, appended after the v2 builds so the shared RNG stream (and thus
// every existing placement) stays bit-identical.

import * as THREE from 'three';

import { heightAt, normalAt, biomeFactors } from './terrain.js';
import { bus } from '../core/events.js';
import { G, CONFIG } from '../core/state.js';
import { Input } from '../core/input.js';
import { smoothstep, makeRng, randRange } from '../core/utils.js';
// Wave D cell streaming: per-cell registration + batch splitting (same key
// space - CELL_SIZE floor grid - on both sides of that handshake).
import {
  CELL_SIZE, createCells, updateCells,
  register as registerCell,
} from './cells.js';
import { groupInstancesByCell } from './lod.js';

// ---- tuning ---------------------------------------------------------------
const TREE_COUNT = 230;  // v2: bigger pool so the NE forest reaches ~1.6x meadow density
const ROCK_COUNT = 150;  // v2: bigger pool so the S highlands get extra rocks/boulders
const GRASS_PATCHES = 46;
const BLADES_PER_PATCH = 60;
const GRASS_TOTAL = GRASS_PATCHES * BLADES_PER_PATCH;
const RUIN_SITES = 6;
const COLS_PER_SITE = 5;
const SLABS_PER_SITE = 4;
const PICKUP_COUNTS = { wood: 26, shards: 20, medicine: 8 };
const PROMPT_DIST = 2.4; // interaction range (xz distance)
const SWAY_BATCH = 96;   // grass blades re-composed per frame (round-robin)
const TREE_SWAY_BATCH = 8; // tree canopies re-composed per frame (round-robin)
const REED_COUNT = 150;  // v2 lakeshore reeds (recomposed whole, cheap batch)
const FLOWER_COUNT = 300;  // v3: two variants (white / yellow heads), halved on low quality
const MUSHROOM_COUNT = 80; // v3: red-capped forest-floor mushrooms, halved on low quality
const LOG_COUNT = 25;      // v3: fallen logs with a moss cap
// v7: dense decorative ground-cover grass tufts across the meadow. Purely
// visual (no gameplay/conceal role - that stays with the taller stealth
// grass). Animated entirely on the GPU via a vertex-shader wind so the whole
// carpet sways for the cost of one per-frame uniform, not a CPU recompose.
const GROUNDCOVER_COUNT = 14000; // halved on low quality (far tufts collapse, so cheap)
// Wave D: the two most numerous batches (ground cover + trees) are split into
// per-cell InstancedMeshes registered with world/cells.js so frustum+distance
// culling can skip whole cells - a giant globally-visible batch (the old
// single 14k-instance carpet) defeats culling by design, exactly the problem
// class this fixes. Placements are generated EXACTLY as before (same RNG
// stream, same math) and only regrouped afterwards, so the world stays
// bit-identical per seed; hidden zero-scale filler slots are simply dropped
// (they drew nothing before either).

const PROMPT_TEXT = {
  wood: '[E] Collect wood',
  shards: '[E] Collect shards',
  medicine: '[E] Collect medicine',
  oil: '[E] Collect oil',
};

// ---- module state ---------------------------------------------------------
let inited = false;
let grassMesh = null;
let swayCursor = 0;
let activePrompt = null; // prompt text currently shown, to avoid re-emits
const ruinSites = [];    // filled during build, used for placement clearance
const concealPatches = []; // stealth-grass centres {x, z, r}, consumed by isConcealed()

// shared pickup assets (one geometry + material per type)
const pickupGeo = {};
const pickupMat = {};

// grass sway scratch (filled once at build, mutated in place)
const bladePos = new Float32Array(GRASS_TOTAL * 3);
const bladePhase = new Float32Array(GRASS_TOTAL);
const bladeLean = new Float32Array(GRASS_TOTAL);
const bladeYaw = new Float32Array(GRASS_TOTAL);
const bladeH = new Float32Array(GRASS_TOTAL);

// tree canopy sway scratch (v2: wind-driven, recomposed round-robin)
// Wave D: the global cone meshes are gone - canopies live in per-cell batches
// now. `coneRoute[layer][treeIndex] = { mesh, idx }` addresses each existing
// canopy layer inside its cell-local buffer (absent layer = null, formerly a
// ZERO_MATRIX slot in a global buffer).
let coneRoute = null;
let treePlaced = 0;
let treeCursor = 0;
const treeX = new Float32Array(TREE_COUNT);
const treeY = new Float32Array(TREE_COUNT);
const treeZ = new Float32Array(TREE_COUNT);
const treeS = new Float32Array(TREE_COUNT);
const treeYawA = new Float32Array(TREE_COUNT);
const treeLeanXA = new Float32Array(TREE_COUNT);
const treeLeanZA = new Float32Array(TREE_COUNT);
const treePhase = new Float32Array(TREE_COUNT);
const treeCones = new Float32Array(TREE_COUNT); // canopy layers actually drawn

// reed sway scratch (v2 lakeshore reeds, whole batch recomposed per frame)
let reedMesh = null;
let reedPlaced = 0;
const reedPos = new Float32Array(REED_COUNT * 3);
const reedPhase = new Float32Array(REED_COUNT);
const reedLean = new Float32Array(REED_COUNT);
const reedYaw = new Float32Array(REED_COUNT);
const reedH = new Float32Array(REED_COUNT);

// scratch objects - reused, never allocated in hot paths
const _obj = new THREE.Object3D();
const _col = new THREE.Color();
const _colA = new THREE.Color();
const _colB = new THREE.Color();
const _FOREST_LEAF = new THREE.Color(0x3f6234);    // darker forest canopy/blade tint
const _HIGHLAND_BLADE = new THREE.Color(0x9a8f6e); // grey-brown highland grass tint
const _biome = { forest: 0, highland: 0 };         // biomeFactors() scratch (build time)
const _touchedCones = new Set(); // cell meshes touched by this frame's sway batch

// ---- helpers --------------------------------------------------------------

// Sway amplitude multiplier from live weather wind (neutral at clear-sky 0.3).
function windAmp() {
  const wind = G.weather ? G.weather.wind : 0.3;
  return 0.75 + wind * 0.85;
}

// Uniform point in a disc of radius maxR (sqrt trick), plus its radius.
function sampleDisc(rng, maxR) {
  const a = rng() * Math.PI * 2;
  const r = Math.sqrt(rng()) * maxR;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r, r };
}

function nearRuinSite(x, z, minDist) {
  for (const s of ruinSites) {
    const dx = x - s.x;
    const dz = z - s.z;
    if (dx * dx + dz * dz < minDist * minDist) return true;
  }
  return false;
}

// Jittered instance color around a base hex (mostly luminance noise).
function colorJitter(baseHex, jitter, rng) {
  _col.setHex(baseHex);
  const m = 1 + (rng() - 0.5) * jitter;
  _col.r *= m;
  _col.g *= m;
  _col.b *= m;
  return _col;
}

function makeInstanced(geo, mat, count, castShadow, dynamic) {
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false; // instances span the map; geometry bounds would cull wrongly
  if (dynamic) mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  G.scene.add(mesh);
  return mesh;
}

function flushInstances(...meshes) {
  for (const m of meshes) {
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
}

// Wave D: install staged placements ({m: Matrix4, c: Color|null}) as per-cell
// InstancedMesh batches and register each with the cell manager. Grouping uses
// lod.groupInstancesByCell (same 'cx,cz' key space as cells.cellKeyAt at
// CELL_SIZE); instance colours ride along via a matrix-identity map so bucket
// order can never desync. Unlike makeInstanced, frustumCulled stays ON: each
// cell mesh's instances are spatially tight, so its computed bounding sphere
// is valid for culling (that was false for global batches on purpose).
// pad grows the culling sphere slightly for batches whose matrices mutate
// after build (tree canopy sway drifts tips a fraction of a unit).
function installCellBatches(kind, geo, mat, items, castShadow, pad = 0) {
  const colorByMatrix = new Map();
  const indexByMatrix = new Map(); // staged order -> item index (route alignment)
  for (let i = 0; i < items.length; i++) {
    colorByMatrix.set(items[i].m, items[i].c);
    indexByMatrix.set(items[i].m, i);
  }
  const groups = groupInstancesByCell(items.map((it) => it.m), CELL_SIZE);
  const meshes = [];
  const route = new Array(items.length); // item index -> {mesh, local idx}
  for (const [key, mats] of groups) {
    const mesh = new THREE.InstancedMesh(geo, mat, mats.length);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = false;
    mesh.frustumCulled = true; // per-cell bounds are trustworthy now
    for (let j = 0; j < mats.length; j++) {
      mesh.setMatrixAt(j, mats[j]);
      const c = colorByMatrix.get(mats[j]);
      if (c) mesh.setColorAt(j, c);
      route[indexByMatrix.get(mats[j])] = { mesh, idx: j };
    }
    flushInstances(mesh);
    if (pad > 0 && mesh.computeBoundingSphere) {
      mesh.computeBoundingSphere();
      mesh.boundingSphere.radius += pad;
    }
    G.scene.add(mesh);
    registerCell(key, { group: mesh, kind });
    meshes.push(mesh);
  }
  return { meshes, route };
}

// Merge primitive parts ({geo,x,y,z,rx,ry,rz,sx,sy,sz,c?}) into one geometry
// so each pickup is a single draw call. Part geometries are throwaway locals.
// Optional part colour `c` (hex) bakes a vertex-colour attribute; when any
// part uses it, uncoloured parts bake white (multiplied by instanceColor).
function mergedGeometry(parts) {
  let total = 0;
  const pieces = [];
  let withColor = false;
  for (const p of parts) {
    if (p.c !== undefined) withColor = true;
  }
  for (const p of parts) {
    _obj.position.set(p.x, p.y, p.z);
    _obj.rotation.set(p.rx, p.ry, p.rz);
    _obj.scale.set(p.sx, p.sy, p.sz);
    _obj.updateMatrix();
    const g = p.geo.toNonIndexed();
    g.applyMatrix4(_obj.matrix);
    pieces.push({ g, c: p.c });
    total += g.attributes.position.count;
  }
  const cols = withColor ? new Float32Array(total * 3) : null;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  let off = 0;
  for (const { g, c } of pieces) {
    pos.set(g.attributes.position.array, off);
    nor.set(g.attributes.normal.array, off);
    if (cols) {
      _col.setHex(c === undefined ? 0xffffff : c);
      for (let i = 0; i < g.attributes.position.count; i++) {
        const o = off + i * 3;
        cols[o] = _col.r;
        cols[o + 1] = _col.g;
        cols[o + 2] = _col.b;
      }
    }
    off += g.attributes.position.array.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (cols) out.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return out;
}

// ---- pickup visuals -------------------------------------------------------

function buildPickupAssets() {
  // wood: small bundle of three branches
  const branch = (len, r0, r1) => new THREE.CylinderGeometry(r0, r1, len, 5);
  pickupGeo.wood = mergedGeometry([
    { geo: branch(0.85, 0.045, 0.055), x: 0, y: 0.05, z: 0, rx: 0, ry: 0, rz: Math.PI / 2, sx: 1, sy: 1, sz: 1 },
    { geo: branch(0.72, 0.04, 0.05), x: 0.03, y: 0.13, z: 0.05, rx: 0, ry: 0.7, rz: Math.PI / 2 + 0.14, sx: 1, sy: 1, sz: 1 },
    { geo: branch(0.66, 0.038, 0.05), x: -0.04, y: 0.21, z: -0.04, rx: 0, ry: -0.8, rz: Math.PI / 2 - 0.12, sx: 1, sy: 1, sz: 1 },
  ]);
  pickupMat.wood = new THREE.MeshLambertMaterial({ color: 0x6b4a2f, flatShading: true });

  // shards: glinting metal spike cluster
  const spike = new THREE.ConeGeometry(0.075, 0.5, 5);
  const shardParts = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const tilt = 0.3 + (i % 2) * 0.18;
    const h = 0.7 + (i % 3) * 0.22;
    shardParts.push({
      geo: spike,
      x: Math.sin(a) * 0.09, y: 0.1 + h * 0.32, z: Math.cos(a) * 0.09,
      rx: Math.cos(a) * tilt, ry: a, rz: -Math.sin(a) * tilt,
      sx: 1, sy: h, sz: 1,
    });
  }
  pickupGeo.shards = mergedGeometry(shardParts);
  pickupMat.shards = new THREE.MeshStandardMaterial({
    color: 0xb7c4cc, metalness: 0.7, roughness: 0.32, flatShading: true,
    emissive: 0x59e3ff, emissiveIntensity: 0.14,
  });

  // medicine: herb rosette with a faint glow
  const stem = new THREE.CylinderGeometry(0.018, 0.03, 0.34, 5);
  const leaf = new THREE.ConeGeometry(0.09, 0.26, 5);
  const bud = new THREE.SphereGeometry(0.055, 6, 5);
  const herbParts = [
    { geo: stem, x: 0, y: 0.17, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
    { geo: bud, x: 0, y: 0.37, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 0.8, sz: 1 },
  ];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.5;
    herbParts.push({
      geo: leaf,
      x: Math.sin(a) * 0.1, y: 0.13, z: Math.cos(a) * 0.1,
      rx: Math.cos(a) * 1.05, ry: a, rz: -Math.sin(a) * 1.05,
      sx: 1, sy: 1, sz: 0.45,
    });
  }
  pickupGeo.medicine = mergedGeometry(herbParts);
  pickupMat.medicine = new THREE.MeshLambertMaterial({
    color: 0x7fa653, flatShading: true, emissive: 0x2f8f4f, emissiveIntensity: 0.45,
  });

  // oil: small amber fuel canister (machine loot drop)
  const canBody = new THREE.CylinderGeometry(0.11, 0.13, 0.3, 7);
  const canNeck = new THREE.CylinderGeometry(0.045, 0.045, 0.12, 6);
  pickupGeo.oil = mergedGeometry([
    { geo: canBody, x: 0, y: 0.16, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
    { geo: canNeck, x: 0.06, y: 0.34, z: 0, rx: 0, ry: 0, rz: -0.55, sx: 1, sy: 1, sz: 1 },
  ]);
  pickupMat.oil = new THREE.MeshLambertMaterial({
    color: 0xc9862e, flatShading: true, emissive: 0x8a5210, emissiveIntensity: 0.35,
  });
}

// Shared creation path for seeded world pickups and runtime loot drops.
function createPickup(type, x, z, rand) {
  const geo = pickupGeo[type];
  const jx = x + (rand() - 0.5) * 0.8;
  const jz = z + (rand() - 0.5) * 0.8;
  const jy = heightAt(jx, jz);
  const mesh = new THREE.Mesh(geo, pickupMat[type]);
  mesh.position.set(jx, jy + 0.16, jz);
  mesh.castShadow = false;
  G.scene.add(mesh);
  const rec = {
    type,
    mesh,
    pos: new THREE.Vector3(jx, jy, jz),
    taken: false,
    phase: rand() * Math.PI * 2,
  };
  G.pickups.push(rec);
  return rec;
}

function buildPickups(rng) {
  for (const type of Object.keys(PICKUP_COUNTS)) {
    const target = PICKUP_COUNTS[type];
    let placed = 0;
    let guard = 0;
    while (placed < target && guard++ < target * 60) {
      const { x, z } = sampleDisc(rng, CONFIG.playRadius * 0.97);
      if (heightAt(x, z) < CONFIG.waterLevel + 0.8) continue;
      if (nearRuinSite(x, z, 6)) continue;
      createPickup(type, x + randRange(rng, -0.4, 0.4), z + randRange(rng, -0.4, 0.4), rng);
      placed++;
    }
  }
}

// ---- ruins ----------------------------------------------------------------

function buildRuins(rng) {
  // Six site centers spread around the ring, on usable ground.
  for (let i = 0; i < RUIN_SITES; i++) {
    const baseA = (i / RUIN_SITES) * Math.PI * 2 + randRange(rng, -0.4, 0.4);
    for (let tries = 0; tries < 60; tries++) {
      const r = randRange(rng, 55, 205);
      const x = Math.cos(baseA) * r;
      const z = Math.sin(baseA) * r;
      const y = heightAt(x, z);
      const slopeMin = tries < 30 ? 0.92 : 0.86; // relax late if the ring is rough
      if (y < CONFIG.waterLevel + 1.2 || normalAt(x, z).y < slopeMin) continue;
      let clash = false;
      for (const s of ruinSites) {
        const dx = x - s.x;
        const dz = z - s.z;
        if (dx * dx + dz * dz < 2025) clash = true; // keep sites 45 apart
      }
      if (!clash) {
        ruinSites.push({ x, z, y, yaw: rng() * Math.PI * 2 });
        break;
      }
    }
  }

  const stoneMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  const colMesh = makeInstanced(new THREE.CylinderGeometry(0.42, 0.5, 3.2, 8), stoneMat, RUIN_SITES * COLS_PER_SITE, true, false);
  const slabMesh = makeInstanced(new THREE.BoxGeometry(1.9, 0.32, 1.25), stoneMat, RUIN_SITES * SLABS_PER_SITE, true, false);
  const pillarMesh = makeInstanced(new THREE.BoxGeometry(0.55, 3.3, 0.6), stoneMat, RUIN_SITES * 2, true, false);
  const lintelMesh = makeInstanced(new THREE.BoxGeometry(2.9, 0.5, 0.75), stoneMat, RUIN_SITES, true, false);

  let ci = 0;
  let si = 0;
  let pi = 0;
  let li = 0;
  for (const site of ruinSites) {
    const cy = Math.cos(site.yaw);
    const sy = Math.sin(site.yaw);

    // Broken columns in a ring: random height, tilt and sink.
    for (let c = 0; c < COLS_PER_SITE; c++) {
      const a = (c / COLS_PER_SITE) * Math.PI * 2 + randRange(rng, -0.3, 0.3);
      const rad = 3.2 + randRange(rng, -0.5, 0.5);
      const x = site.x + Math.cos(a) * rad;
      const z = site.z + Math.sin(a) * rad;
      const gy = heightAt(x, z);
      const hScale = randRange(rng, 0.35, 1.0);
      _obj.position.set(x, gy + 1.6 * hScale - randRange(rng, 0, 0.3), z);
      _obj.rotation.set(randRange(rng, -0.07, 0.07), rng() * Math.PI * 2, randRange(rng, -0.07, 0.07));
      _obj.scale.set(1, hScale, 1);
      _obj.updateMatrix();
      colMesh.setMatrixAt(ci, _obj.matrix);
      colMesh.setColorAt(ci, colorJitter(0x7d7f82, 0.14, rng));
      ci++;
    }

    // Fallen slabs, some half-buried.
    for (let s = 0; s < SLABS_PER_SITE; s++) {
      const a = rng() * Math.PI * 2;
      const rad = randRange(rng, 1.5, 5.5);
      const x = site.x + Math.cos(a) * rad;
      const z = site.z + Math.sin(a) * rad;
      const gy = heightAt(x, z);
      _obj.position.set(x, gy + 0.16 - randRange(rng, 0, 0.12), z);
      _obj.rotation.set(randRange(rng, -0.12, 0.12), rng() * Math.PI * 2, randRange(rng, -0.12, 0.12));
      _obj.scale.setScalar(randRange(rng, 0.8, 1.3));
      _obj.updateMatrix();
      slabMesh.setMatrixAt(si, _obj.matrix);
      slabMesh.setColorAt(si, colorJitter(0x7d7f82, 0.14, rng));
      si++;
    }

    // One arch per site: two pillars + lintel, aligned to the site yaw.
    for (let side = -1; side <= 1; side += 2) {
      const x = site.x + cy * 1.05 * side;
      const z = site.z - sy * 1.05 * side;
      const gy = heightAt(x, z);
      _obj.position.set(x, gy + 1.57, z);
      _obj.rotation.set(randRange(rng, -0.03, 0.03), site.yaw, randRange(rng, -0.03, 0.03));
      _obj.scale.setScalar(1);
      _obj.updateMatrix();
      pillarMesh.setMatrixAt(pi, _obj.matrix);
      pillarMesh.setColorAt(pi, colorJitter(0x7d7f82, 0.1, rng));
      pi++;
    }
    _obj.position.set(site.x, heightAt(site.x, site.z) + 3.2, site.z);
    _obj.rotation.set(0, site.yaw, 0);
    _obj.scale.setScalar(1);
    _obj.updateMatrix();
    lintelMesh.setMatrixAt(li, _obj.matrix);
    lintelMesh.setColorAt(li, colorJitter(0x7d7f82, 0.1, rng));
    li++;
  }
  flushInstances(colMesh, slabMesh, pillarMesh, lintelMesh);
}

// ---- trees ----------------------------------------------------------------

function buildTrees(rng) {
  const barkMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  // v7: canopy uses vertex colours so a baked vertical gradient (dark shaded
  // underside -> brighter sun-kissed crown) reads as foliage volume rather
  // than a flat cone. The per-instance green tint multiplies this gradient.
  const leafMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true, vertexColors: true });
  const trunkGeo = new THREE.CylinderGeometry(0.13, 0.22, 1.7, 6);
  trunkGeo.translate(0, 0.85, 0); // base at origin
  const coneGeo = new THREE.ConeGeometry(1, 1, 7);
  coneGeo.translate(0, 0.5, 0);   // base at origin
  // Bake the dark->light vertical gradient into the cone (local y 0..1).
  {
    const cp = coneGeo.attributes.position;
    const cc = new Float32Array(cp.count * 3);
    for (let i = 0; i < cp.count; i++) {
      const g = 0.55 + cp.getY(i) * 0.65; // 0.55 at base -> ~1.2 at tip
      cc[i * 3] = g; cc[i * 3 + 1] = g; cc[i * 3 + 2] = g;
    }
    coneGeo.setAttribute('color', new THREE.BufferAttribute(cc, 3));
  }

  // Wave D: stage placements instead of writing straight into global meshes.
  // Everything below keeps the v2/v7 RNG stream and placement math untouched;
  // only the final write-out changed (per-cell batches instead of global ones).
  const trunkItems = [];
  const coneItems = [[], [], []];

  _colA.setHex(0x6a8f4f);
  _colB.setHex(0x8aa85c);

  let placed = 0;
  let guard = 0;
  while (placed < TREE_COUNT && guard++ < TREE_COUNT * 40) {
    const { x, z, r } = sampleDisc(rng, CONFIG.playRadius * 0.98);
    const t = r / CONFIG.playRadius;
    // Denser mid-radius, thin spawn clearing, thinning into the mountain ring.
    let w = smoothstep(0.03, 0.2, t) * (1 - 0.88 * smoothstep(0.72, 1.0, t));
    // v2 biomes: ~1.6x tree density inside the NE forest.
    biomeFactors(x, z, _biome);
    w *= 1 + 0.6 * _biome.forest;
    if (rng() > w) continue;
    const y = heightAt(x, z);
    if (y < CONFIG.waterLevel + 1.5) continue;
    if (normalAt(x, z).y < 0.84) continue; // gentle slope only
    if (nearRuinSite(x, z, 8)) continue;

    const s = randRange(rng, 0.8, 1.6);
    const yaw = rng() * Math.PI * 2;
    const leanX = randRange(rng, -0.03, 0.03);
    const leanZ = randRange(rng, -0.03, 0.03);
    const coneCount = rng() < 0.45 ? 2 : 3;
    const ff = _biome.forest; // still valid: no biomeFactors call since sampling

    _obj.position.set(x, y, z);
    _obj.rotation.set(leanX, yaw, leanZ);
    _obj.scale.setScalar(s);
    _obj.updateMatrix();
    trunkItems.push({ m: _obj.matrix.clone(), c: colorJitter(0x6b4a2f, 0.25, rng).clone() });

    for (let k = 0; k < 3; k++) {
      // Colour draws happen for EVERY layer exactly as before (RNG parity);
      // absent layers just aren't staged anymore - they were zero-scale filler.
      _col.lerpColors(_colA, _colB, rng()).multiplyScalar(randRange(rng, 0.75, 1.0));
      _col.lerp(_FOREST_LEAF, ff * 0.45); // forest canopy runs darker
      if (k < coneCount) {
        _obj.position.set(x, y + (1.15 + 0.78 * k) * s, z);
        _obj.rotation.set(leanX * 0.5, yaw, leanZ * 0.5);
        const cr = (1.35 - 0.36 * k) * s;
        const ch = (1.5 - 0.28 * k) * s;
        _obj.scale.set(cr, ch, cr);
        _obj.updateMatrix();
        // `tree` carries the owning tree slot: layers skip coneCount<3 trees,
        // so staged indices alone would misalign the sway routing tables.
        coneItems[k].push({ m: _obj.matrix.clone(), c: _col.clone(), tree: placed });
      }
    }

    // Record for wind-driven canopy sway (v2).
    treeX[placed] = x;
    treeY[placed] = y;
    treeZ[placed] = z;
    treeS[placed] = s;
    treeYawA[placed] = yaw;
    treeLeanXA[placed] = leanX;
    treeLeanZA[placed] = leanZ;
    treePhase[placed] = rng() * Math.PI * 2;
    treeCones[placed] = coneCount; // recorded for parity/debug; sway routes via coneRoute
    placed++;
  }
  treePlaced = placed;

  // Wave D: regroup staged placements into per-cell batches registered with
  // cells.js, and keep the per-tree routing tables the sway recompositor uses
  // to address instances inside cell-local buffers.
  installCellBatches('treeTrunk', trunkGeo, barkMat, trunkItems, true);
  const routes = [];
  for (let k = 0; k < 3; k++) {
    // pad: sway lean shifts canopy tips a fraction of a unit after the culling
    // sphere is computed - grow it so frustum tests stay conservative.
    const inst = installCellBatches(`treeCone${k}`, coneGeo, leafMat, coneItems[k], true, 0.5);
    // Re-index batch routing by TREE slot (staged items skip absent layers).
    const byTree = new Array(treePlaced).fill(null);
    for (let n = 0; n < coneItems[k].length; n++) {
      byTree[coneItems[k][n].tree] = inst.route[n];
    }
    routes.push(byTree);
  }
  coneRoute = routes;
}

// Recompose one tree's canopy cones with a wind-driven sway (trunk stays put).
// Wave D: instances are addressed through their per-cell batch routing; a
// layer a tree doesn't have has no route entry (it used to be a hidden
// zero-scale slot in the global buffer, recomposed pointlessly every pass).
function composeTreeCanopy(i, t) {
  const s = treeS[i];
  const sway = Math.sin(t * 1.1 + treePhase[i]) * 0.03 * windAmp();
  for (let k = 0; k < 3; k++) {
    const r = coneRoute ? coneRoute[k][i] : null;
    if (!r) continue;
    _obj.position.set(treeX[i], treeY[i] + (1.15 + 0.78 * k) * s, treeZ[i]);
    _obj.rotation.set(
      treeLeanXA[i] * 0.5 + sway,
      treeYawA[i],
      treeLeanZA[i] * 0.5 + sway * 0.8,
    );
    const cr = (1.35 - 0.36 * k) * s;
    const ch = (1.5 - 0.28 * k) * s;
    _obj.scale.set(cr, ch, cr);
    _obj.updateMatrix();
    r.mesh.setMatrixAt(r.idx, _obj.matrix);
    _touchedCones.add(r.mesh);
  }
}

// Round-robin canopy sway: a few trees per frame, matrices mutated in place.
// Only the cell batches actually touched this frame get flagged for upload.
function updateTreeSway(t) {
  if (!coneRoute || treePlaced === 0) return;
  _touchedCones.clear();
  const end = Math.min(treePlaced, treeCursor + TREE_SWAY_BATCH);
  for (let i = treeCursor; i < end; i++) composeTreeCanopy(i, t);
  if (end > treeCursor) {
    treeCursor = end === treePlaced ? 0 : end;
    for (const mesh of _touchedCones) mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---- rocks ----------------------------------------------------------------

function buildRocks(rng) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  const rockMesh = makeInstanced(new THREE.DodecahedronGeometry(1, 0), mat, ROCK_COUNT, false, false);
  let placed = 0;
  let guard = 0;
  while (placed < ROCK_COUNT && guard++ < ROCK_COUNT * 40) {
    const { x, z } = sampleDisc(rng, CONFIG.playRadius * 0.99);
    const y = heightAt(x, z);
    if (y < CONFIG.waterLevel + 0.4) continue;
    // v2 biomes: extra rocks and bigger boulders in the S highlands.
    biomeFactors(x, z, _biome);
    if (rng() > 1 + 1.1 * _biome.highland) continue;
    const s = randRange(rng, 0.35, 1.7) * (1 + _biome.highland * randRange(rng, 0.25, 0.85));
    _obj.position.set(x, y + s * 0.22, z); // partially sunk
    _obj.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
    _obj.scale.set(s * randRange(rng, 0.8, 1.3), s * randRange(rng, 0.55, 0.95), s * randRange(rng, 0.8, 1.3));
    _obj.updateMatrix();
    rockMesh.setMatrixAt(placed, _obj.matrix);
    rockMesh.setColorAt(placed, colorJitter(0x7d7f82, 0.3, rng));
    placed++;
  }
  flushInstances(rockMesh);
}

// ---- stealth grass --------------------------------------------------------

function composeBlade(i, t) {
  const gust = windAmp(); // v2: weather wind scales sway amplitude
  _obj.position.set(bladePos[i * 3], bladePos[i * 3 + 1], bladePos[i * 3 + 2]);
  _obj.rotation.set(
    bladeLean[i] + Math.sin(t * 1.7 + bladePhase[i]) * 0.06 * gust,
    bladeYaw[i],
    Math.cos(t * 1.3 + bladePhase[i]) * 0.045 * gust,
  );
  _obj.scale.set(1, bladeH[i], 1);
  _obj.updateMatrix();
  grassMesh.setMatrixAt(i, _obj.matrix);
}

function buildGrass(rng) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  const bladeGeo = new THREE.ConeGeometry(0.05, 1, 4);
  bladeGeo.translate(0, 0.5, 0); // base at origin so lean pivots at the root
  grassMesh = makeInstanced(bladeGeo, mat, GRASS_TOTAL, false, true);

  _colA.setHex(0x6a8f4f);
  _colB.setHex(0x8aa85c);

  let gi = 0;
  for (let p = 0; p < GRASS_PATCHES; p++) {
    let cx = 0;
    let cz = 0;
    let ok = false;
    for (let tries = 0; tries < 40; tries++) {
      const { x, z, r } = sampleDisc(rng, CONFIG.playRadius * 0.95);
      const t = r / CONFIG.playRadius;
      let w = smoothstep(0.05, 0.2, t) * (1 - 0.8 * smoothstep(0.8, 1.0, t));
      // v2 biomes: stealth grass runs sparser inside the NE forest.
      biomeFactors(x, z, _biome);
      w *= 1 - 0.55 * _biome.forest;
      if (rng() > w) continue;
      if (heightAt(x, z) < CONFIG.waterLevel + 0.6) continue;
      if (normalAt(x, z).y < 0.8) continue;
      if (nearRuinSite(x, z, 5)) continue;
      cx = x;
      cz = z;
      ok = true;
      break;
    }
    if (!ok) continue; // patch skipped; its blade slots stay zero-scaled
    concealPatches.push({ x: cx, z: cz, r: 2.1 }); // isConcealed() radius
    for (let b = 0; b < BLADES_PER_PATCH && gi < GRASS_TOTAL; b++, gi++) {
      const a = rng() * Math.PI * 2;
      const rad = Math.sqrt(rng()) * 1.7;
      const x = cx + Math.cos(a) * rad;
      const z = cz + Math.sin(a) * rad;
      bladePos[gi * 3] = x;
      bladePos[gi * 3 + 1] = heightAt(x, z) - 0.02;
      bladePos[gi * 3 + 2] = z;
      bladePhase[gi] = rng() * Math.PI * 2;
      bladeLean[gi] = randRange(rng, -0.16, 0.16);
      bladeYaw[gi] = rng() * Math.PI * 2;
      bladeH[gi] = randRange(rng, 0.65, 1.35);
      _col.lerpColors(_colA, _colB, rng()).multiplyScalar(randRange(rng, 0.8, 1.1));
      _col.lerp(_HIGHLAND_BLADE, _biome.highland * 0.65); // grey-brown in the S
      _col.lerp(_FOREST_LEAF, _biome.forest * 0.3);       // darker on the forest floor
      grassMesh.setColorAt(gi, _col);
    }
  }
  for (let i = 0; i < GRASS_TOTAL; i++) composeBlade(i, 0);
  flushInstances(grassMesh);
}

// Round-robin sway: recompose a small batch of blades each frame.
function updateGrassSway(t) {
  if (!grassMesh) return;
  const end = Math.min(GRASS_TOTAL, swayCursor + SWAY_BATCH);
  for (let i = swayCursor; i < end; i++) composeBlade(i, t);
  if (end > swayCursor) {
    swayCursor = end === GRASS_TOTAL ? 0 : end;
    grassMesh.instanceMatrix.needsUpdate = true;
  }
}

// ---- lakeshore reeds (v2) --------------------------------------------------

function composeReed(i, t) {
  const gust = windAmp();
  _obj.position.set(reedPos[i * 3], reedPos[i * 3 + 1], reedPos[i * 3 + 2]);
  _obj.rotation.set(
    reedLean[i] + Math.sin(t * 1.5 + reedPhase[i]) * 0.09 * gust,
    reedYaw[i],
    Math.cos(t * 1.1 + reedPhase[i]) * 0.07 * gust,
  );
  _obj.scale.set(1, reedH[i], 1);
  _obj.updateMatrix();
  reedMesh.setMatrixAt(i, _obj.matrix);
}

function buildReeds(rng) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  const stemGeo = new THREE.CylinderGeometry(0.018, 0.032, 1, 5);
  stemGeo.translate(0, 0.5, 0); // base at origin so bend pivots at the root
  const headGeo = new THREE.ConeGeometry(0.05, 0.24, 5);
  headGeo.translate(0, 0.9, 0); // cattail head near the tip
  const reedGeo = mergedGeometry([
    { geo: stemGeo, x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
    { geo: headGeo, x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
  ]);
  reedMesh = makeInstanced(reedGeo, mat, REED_COUNT, false, true);

  _colA.setHex(0x6d7c42); // reed green
  _colB.setHex(0x8a7448); // dry cattail brown

  let guard = 0;
  while (reedPlaced < REED_COUNT && guard++ < REED_COUNT * 60) {
    const { x, z } = sampleDisc(rng, CONFIG.playRadius * 0.99);
    const y = heightAt(x, z);
    // Waterline band only: roots in the shallows or on wet sand.
    if (y < CONFIG.waterLevel - 0.7 || y > CONFIG.waterLevel + 0.75) continue;
    if (nearRuinSite(x, z, 5)) continue;
    const a = rng() * Math.PI * 2;
    const rad = Math.sqrt(rng()) * 0.6;
    const bx = x + Math.cos(a) * rad;
    const bz = z + Math.sin(a) * rad;
    reedPos[reedPlaced * 3] = bx;
    reedPos[reedPlaced * 3 + 1] = heightAt(bx, bz) - 0.03;
    reedPos[reedPlaced * 3 + 2] = bz;
    reedPhase[reedPlaced] = rng() * Math.PI * 2;
    reedLean[reedPlaced] = randRange(rng, -0.12, 0.12);
    reedYaw[reedPlaced] = rng() * Math.PI * 2;
    reedH[reedPlaced] = randRange(rng, 0.8, 1.6);
    _col.lerpColors(_colA, _colB, rng()).multiplyScalar(randRange(rng, 0.85, 1.1));
    reedMesh.setColorAt(reedPlaced, _col);
    reedPlaced++;
  }
  for (let i = 0; i < reedPlaced; i++) composeReed(i, 0);
  flushInstances(reedMesh);
}

// Whole bed per frame: ~150 instances is a cheap batch and reads as one stand.
function updateReedSway(t) {
  if (!reedMesh || reedPlaced === 0) return;
  for (let i = 0; i < reedPlaced; i++) composeReed(i, t);
  reedMesh.instanceMatrix.needsUpdate = true;
}

// ---- v3 flora richness -----------------------------------------------------

let floraMat = null; // shared: white base + vertex colours x instance tint

// Flowers/mushrooms/logs are static batches - one material whose geometry
// carries per-part vertex colours (stem green, head/cap colour), multiplied
// per instance by a luminance jitter from instanceColor.
function getFloraMat() {
  if (!floraMat) {
    floraMat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      flatShading: true,
      vertexColors: true,
    });
  }
  return floraMat;
}

// One flower variant geometry: green stem + leaf, head baked in `headHex`.
function flowerGeometry(headHex) {
  return mergedGeometry([
    { geo: new THREE.CylinderGeometry(0.014, 0.022, 0.34, 5), x: 0, y: 0.17, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, c: 0x4f7a38 },
    { geo: new THREE.ConeGeometry(0.05, 0.16, 4), x: 0.055, y: 0.12, z: 0, rx: 0, ry: 0, rz: -1.15, sx: 1, sy: 1, sz: 0.5, c: 0x557f3c },
    { geo: new THREE.SphereGeometry(0.065, 6, 4), x: 0, y: 0.37, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 0.72, sz: 1, c: headHex },
  ]);
}

// Fill one variant's instance slots; returns instances actually placed.
function placeFlowerVariant(rng, mesh, count) {
  let placed = 0;
  let guard = 0;
  while (placed < count && guard++ < count * 60) {
    const { x, z } = sampleDisc(rng, CONFIG.playRadius * 0.97);
    const y = heightAt(x, z);
    if (y < CONFIG.waterLevel + 0.5 || y > 26) continue;
    if (normalAt(x, z).y < 0.82) continue;
    if (nearRuinSite(x, z, 4)) continue;
    biomeFactors(x, z, _biome);
    if (rng() > 1 - 0.5 * _biome.forest) continue; // thinner deep in the forest
    _obj.position.set(x, y - 0.01, z);
    _obj.rotation.set(0, rng() * Math.PI * 2, 0);
    _obj.scale.setScalar(randRange(rng, 0.8, 1.4));
    _obj.updateMatrix();
    mesh.setMatrixAt(placed, _obj.matrix);
    mesh.setColorAt(placed, colorJitter(0xffffff, 0.24, rng));
    placed++;
  }
  return placed;
}

// ~300 flowers across two head-colour variants (halved when quality is low).
function buildFlowers(rng, target) {
  const half = Math.ceil(target / 2);
  const white = makeInstanced(flowerGeometry(0xf3f1e2), getFloraMat(), half, false, false);
  const yellow = makeInstanced(flowerGeometry(0xe6c445), getFloraMat(), target - half, false, false);
  placeFlowerVariant(rng, white, half);
  placeFlowerVariant(rng, yellow, target - half);
  flushInstances(white, yellow);
}

// ~80 red-capped mushrooms, clustered on the forest floor.
function buildMushrooms(rng, target) {
  const geo = mergedGeometry([
    { geo: new THREE.CylinderGeometry(0.032, 0.046, 0.15, 6), x: 0, y: 0.075, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, c: 0xd8cdb2 },
    { geo: new THREE.SphereGeometry(0.105, 7, 5), x: 0, y: 0.155, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 0.62, sz: 1, c: 0xb23227 },
  ]);
  const mesh = makeInstanced(geo, getFloraMat(), target, false, false);
  let placed = 0;
  let guard = 0;
  while (placed < target && guard++ < target * 80) {
    const { x, z } = sampleDisc(rng, CONFIG.playRadius * 0.97);
    const y = heightAt(x, z);
    if (y < CONFIG.waterLevel + 0.4 || y > 26) continue;
    if (normalAt(x, z).y < 0.86) continue;
    if (nearRuinSite(x, z, 4)) continue;
    biomeFactors(x, z, _biome);
    if (rng() > 0.25 + 1.5 * _biome.forest) continue; // mostly the NE forest
    _obj.position.set(x, y - 0.01, z);
    _obj.rotation.set(0, rng() * Math.PI * 2, 0);
    _obj.scale.setScalar(randRange(rng, 0.7, 1.5));
    _obj.updateMatrix();
    mesh.setMatrixAt(placed, _obj.matrix);
    mesh.setColorAt(placed, colorJitter(0xffffff, 0.2, rng));
    placed++;
  }
  flushInstances(mesh);
}

// ~25 fallen logs: bark cylinder lying along X + two moss strips on top.
function buildLogs(rng, target) {
  const geo = mergedGeometry([
    { geo: new THREE.CylinderGeometry(0.19, 0.23, 2.2, 7), x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: Math.PI / 2, sx: 1, sy: 1, sz: 1, c: 0x5e4530 },
    { geo: new THREE.BoxGeometry(1.45, 0.06, 0.3), x: -0.18, y: 0.185, z: 0.02, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, c: 0x5f7a3c },
    { geo: new THREE.BoxGeometry(0.66, 0.05, 0.26), x: 0.62, y: 0.18, z: -0.03, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, c: 0x6b8746 },
  ]);
  const mesh = makeInstanced(geo, getFloraMat(), target, false, false); // no shadow: perf rules
  let placed = 0;
  let guard = 0;
  while (placed < target && guard++ < target * 80) {
    const { x, z } = sampleDisc(rng, CONFIG.playRadius * 0.96);
    const y = heightAt(x, z);
    if (y < CONFIG.waterLevel + 0.8 || y > 30) continue;
    if (normalAt(x, z).y < 0.86) continue;
    if (nearRuinSite(x, z, 6)) continue;
    biomeFactors(x, z, _biome);
    if (rng() > 0.35 + 1.2 * _biome.forest) continue; // forest-heavy, some meadow
    const s = randRange(rng, 0.8, 1.5);
    _obj.position.set(x, y + 0.17 * s, z); // radius ~0.21*s, sunk a touch
    _obj.rotation.set(
      randRange(rng, -0.05, 0.05),
      rng() * Math.PI * 2,
      randRange(rng, -0.05, 0.05),
    );
    _obj.scale.setScalar(s); // uniform: moss keeps its place on top
    _obj.updateMatrix();
    mesh.setMatrixAt(placed, _obj.matrix);
    mesh.setColorAt(placed, colorJitter(0xffffff, 0.18, rng));
    placed++;
  }
  flushInstances(mesh);
}

// ---- v7 ground-cover grass carpet ------------------------------------------

// Shared wind clock for the GPU-swayed ground cover (advanced in updateProps).
const groundcoverTime = { value: 0 };

// A single tuft: a fan of thin tapered blades, bases at the origin so the
// vertex wind (scaled by local height) bends only the tips.
function groundcoverTuftGeometry() {
  const parts = [];
  const blades = 6;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + 0.6;
    const lean = 0.14 + (i % 2) * 0.08;
    const h = 0.42 + (i % 3) * 0.07;
    parts.push({
      geo: new THREE.ConeGeometry(0.042, 1, 3),
      x: Math.sin(a) * 0.05, y: 0, z: Math.cos(a) * 0.05,
      rx: Math.cos(a) * lean, ry: a, rz: -Math.sin(a) * lean,
      sx: 1, sy: h, sz: 1,
      c: i % 2 === 0 ? 0x86ad5f : 0x97bd6b,
    });
  }
  const g = mergedGeometry(parts);
  // ConeGeometry base sits at y = -0.5*sy; shift so the tuft base is ~y=0
  // and its local y works directly as the wind-bend weight.
  g.translate(0, 0.5 * 0.42, 0);
  return g;
}

// Injects a cheap world-space wind into the standard material's vertex stage.
// Tip displacement grows with local height so roots stay planted.
function addGroundcoverWind(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGCTime = groundcoverTime;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uGCTime;',
      )
      .replace(
        '#include <begin_vertex>',
        [
          '#include <begin_vertex>',
          // instanceMatrix column 3 = this tuft\'s world position (good enough
          // to decorrelate neighbouring tufts\' phase).
          'vec3 iwRoot = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);',
          'float iwDist = distance(cameraPosition, iwRoot);',
          'float iwVis = 1.0 - smoothstep(48.0, 95.0, iwDist);',
          'float iwBend = max(position.y, 0.0);',
          'float iwW = sin(uGCTime * 1.6 + iwRoot.x * 0.5 + iwRoot.z * 0.4)',
          '          + 0.5 * sin(uGCTime * 2.7 + iwRoot.z * 0.7);',
          'transformed.y *= iwVis;',
          'transformed.x += iwW * iwBend * 0.28 * iwVis;',
          'transformed.z += iwW * iwBend * 0.16 * iwVis;',
        ].join('\n'),
      );
  };
}

function buildGroundcover(rng, target) {
  const mat = new THREE.MeshLambertMaterial({
    color: 0xffffff, flatShading: true, vertexColors: true,
  });
  addGroundcoverWind(mat);
  // Wave D: stage placements, then split into per-cell batches (see header).
  // The GPU wind shader keys off each instance's own world position, so it
  // behaves identically across cell-local buffers.
  const items = [];
  let placed = 0;
  let guard = 0;
  while (placed < target && guard++ < target * 20) {
    const { x, z, r } = sampleDisc(rng, CONFIG.playRadius * 0.98);
    const t = r / CONFIG.playRadius;
    // Thin the spawn clearing, fade out into the mountain ring.
    const w = smoothstep(0.02, 0.16, t) * (1 - 0.9 * smoothstep(0.72, 1.0, t));
    if (rng() > w) continue;
    const y = heightAt(x, z);
    if (y < CONFIG.waterLevel + 0.4 || y > 30) continue;
    if (normalAt(x, z).y < 0.8) continue;
    biomeFactors(x, z, _biome);
    // Sparse on bare highland rock, lush in meadow/forest floor.
    if (rng() > 1 - 0.5 * _biome.highland) continue;
    _obj.position.set(x, y - 0.02, z);
    _obj.rotation.set(0, rng() * Math.PI * 2, 0);
    _obj.scale.setScalar(randRange(rng, 0.7, 1.6));
    _obj.updateMatrix();
    // Green jitter, darker on the forest floor, drier/greyer on highland.
    _col.setHex(0xffffff).multiplyScalar(randRange(rng, 0.8, 1.12));
    _col.lerp(_FOREST_LEAF.clone().multiplyScalar(1.4), _biome.forest * 0.4);
    _col.lerp(_HIGHLAND_BLADE, _biome.highland * 0.5);
    items.push({ m: _obj.matrix.clone(), c: _col.clone() });
    placed++;
  }
  // Unfilled tail slots are dropped rather than zero-scaled: they drew nothing
  // before either, and per-cell buffers size themselves to real content.
  installCellBatches('groundcover', groundcoverTuftGeometry(), mat, items, false);
}

// ---- public API -----------------------------------------------------------

/**
 * True when (x,z) sits inside any stealth-grass patch radius (v2 sneak
 * mechanic; player.js consumes). Safe before createProps() - just false.
 */
export function isConcealed(x, z) {
  for (let i = 0; i < concealPatches.length; i++) {
    const p = concealPatches[i];
    const dx = x - p.x;
    const dz = z - p.z;
    if (dx * dx + dz * dz <= p.r * p.r) return true;
  }
  return false;
}

/** Build all static props + world pickups. Call once after G.scene is set. */
export function createProps() {
  if (inited) return;
  if (!G.scene) {
    console.error('[props] createProps called before G.scene was set');
    return;
  }
  inited = true;

  // Wave D: boot the cell manager before the builders so per-cell batches can
  // register (idempotent; also publishes window.__IW_PERF_CELLS).
  createCells();

  buildPickupAssets();

  // One streamed RNG keeps placement deterministic (offset from terrain seed use).
  const rng = makeRng(CONFIG.seed + 977);
  buildRuins(rng);
  buildTrees(rng);
  buildRocks(rng);
  buildGrass(rng);
  buildReeds(rng);
  buildPickups(rng);

  // v3 flora richness - appended AFTER every v1/v2 build so the shared RNG
  // stream (and therefore all existing placements) stays bit-identical.
  // Counts are read once here; main.js loads persisted settings before this.
  const lowQuality = G.settings && G.settings.quality === 'low';
  buildFlowers(rng, lowQuality ? FLOWER_COUNT / 2 : FLOWER_COUNT);
  buildMushrooms(rng, lowQuality ? MUSHROOM_COUNT / 2 : MUSHROOM_COUNT);
  buildLogs(rng, LOG_COUNT);
  // v7: dense GPU-swayed ground-cover carpet (decorative). Appended last so
  // the shared RNG stream leaves every earlier placement bit-identical.
  buildGroundcover(rng, lowQuality ? GROUNDCOVER_COUNT / 2 : GROUNDCOVER_COUNT);
}

/**
 * Per-frame: grass/tree/reed sway (wind-scaled), pickup bob/spin, proximity
 * prompt + KeyE collection. Runs inside the gameplay branch, so G.elapsed is
 * the scaled clock.
 */
export function updateProps(dt) {
  if (!inited) return;
  const t = G.elapsed;
  // Wave D: stream cell visibility around the player. Guards itself when the
  // cells manager or player aren't ready; until the first streamed pass every
  // registered batch stays visible (pre-streaming parity, see cells.js).
  if (G.player && G.player.pos) updateCells(G.player.pos, dt);
  updateGrassSway(t);
  updateTreeSway(t); // v2: wind-driven canopy sway
  updateReedSway(t); // v2: wind-driven reed sway
  // v7: ground-cover sways entirely on the GPU - just advance its wind clock,
  // scaled by live weather wind so gusts ripple the whole carpet at once.
  // Integrated (not elapsed*multiplier) so the shader phase rate tracks wind
  // smoothly instead of racing backward/forward as the multiplier changes.
  groundcoverTime.value += dt * (0.6 + windAmp() * 0.5);
  if (!G.player) return;

  // Gentle bob + spin for every live pickup (covers machine loot drops too).
  const pickups = G.pickups;
  for (let i = 0; i < pickups.length; i++) {
    const p = pickups[i];
    if (p.taken || !p.mesh) continue;
    const ph = p.phase !== undefined ? p.phase : p.pos.x * 1.7 + p.pos.z * 2.3;
    p.mesh.position.y = p.pos.y + 0.16 + Math.sin(t * 2 + ph) * 0.07;
    p.mesh.rotation.y = t * 1.15 + ph;
  }

  // Nearest untaken pickup within range drives the prompt (emit on change only).
  let best = null;
  let bestI = -1;
  let bestD2 = PROMPT_DIST * PROMPT_DIST;
  const px = G.player.pos.x;
  const pz = G.player.pos.z;
  for (let i = 0; i < pickups.length; i++) {
    const p = pickups[i];
    if (p.taken) continue;
    const dx = px - p.pos.x;
    const dz = pz - p.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = p;
      bestI = i;
    }
  }
  const want = best ? PROMPT_TEXT[best.type] : null;
  if (want !== activePrompt) {
    activePrompt = want;
    bus.emit('prompt', { text: want });
  }
  if (best && Input.pressed('KeyE')) {
    const amount = G.skills.scavenger ? 2 : 1;
    G.inventory[best.type] += amount;
    if (best.mesh.parent) G.scene.remove(best.mesh);
    pickups.splice(bestI, 1); // drop the record too - keeps per-frame scans bounded
    bus.emit('pickup', { type: best.type, amount });
    bus.emit('notify', { text: `+${amount} ${best.type}`, tone: 'good' });
    activePrompt = null;
    bus.emit('prompt', { text: null });
  }
}

/**
 * Drop a pickup (loot entry point for machines). Snaps to terrain, adds a
 * slight random offset, registers into G.pickups. Accepts both call shapes:
 * spawnPickup(type, {x, z}) and spawnPickup(type, x, y, z). Safe anytime
 * after createProps(). Returns the pickup record or null on bad input.
 */
export function spawnPickup(type, pos, yArg, zArg) {
  if (!inited || !G.scene) return null;
  if (!pickupGeo[type]) {
    console.warn(`[props] unknown pickup type "${type}"`);
    return null;
  }
  const x = typeof pos === 'number' ? pos : pos.x;
  const z = typeof pos === 'number' ? zArg : pos.z;
  return createPickup(type, x, z, Math.random);
}
