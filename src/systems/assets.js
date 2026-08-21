// IRONWILD - centralized asset pipeline (Wave B infrastructure).
// Single gateway for authored GLB content (see src/assets/manifest.js for the
// registry + authoring conventions). Nothing in the game consumes this yet -
// it exists so final binaries drop into /assets/<category>/<id>.glb later and
// spawn code flips from procedural fallbacks to instantiate() with zero new
// loader code.
//
// Contract highlights:
//   - load(id) -> Promise<glTF>, deduped in-flight, cached, never re-fetched
//     after a failure this session. Failure = console.warn ONCE +
//     entry.failed=true; callers keep their procedural fallback.
//   - instantiate(id, {lod}) -> Promise<Object3D> clone of the cached scene
//     with conventions resolved onto clone.userData:
//       sockets    { 'socket_x' -> Object3D }
//       weakPoints [ { name:'wp_x', node:Object3D } ]
//       clips      { clipName -> AnimationClip }
//   - acquire(id)/release(id) ref-count live clones; at zero refs the cache
//     entry is evicted after a grace period and its GPU resources disposed
//     once. Clones SHARE geometry/material/textures with the cached source,
//     so eviction is the ONLY place that disposes - never dispose a clone.
//   - initAssets({renderer}) wires loaders; safe to skip: base GLTF loading
//     works renderer-less, only KTX2 compressed textures need detectSupport.
//   - No bus events, no G access, no per-frame update: pure infrastructure.

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { ASSET_ROOT, ASSET_MANIFEST, getEntry } from '../assets/manifest.js';

// Re-exported so gameplay code needs only one import site for manifest lookups.
export { getEntry };

// --- tuning -----------------------------------------------------------------

const GRACE_MS = 30000;        // refs==0 dwell time before GPU eviction
const IDLE_TIMEOUT_MS = 2000;  // requestIdleCallback starvation guard
const LOD_RE = /_lod(\d+)$/i;  // node-name LOD suffix convention

// --- module state -----------------------------------------------------------

let lastRenderer = null;       // remembered so late load() calls upgrade KTX2 too

let baseLoader = null;         // GLTFLoader without DRACO wiring
let dracoGltfLoader = null;    // second GLTFLoader wired for draco:true entries
let dracoLoader = null;        // shared DRACOLoader instance
let ktx2Loader = null;
let ktx2Done = false;          // detectSupport attempted (success OR failure)

const cache = new Map();       // key -> { entry, gltf }
const inflight = new Map();    // key -> Promise<gltf>
const failedKeys = new Set();  // keys that failed this session (no retry loop)
const warned = new Set();      // warn-once registry
const refs = new Map();        // id -> live clone count
const evictTimers = new Map(); // id -> pending eviction timeout handle

// Disposal bookkeeping: one binary can be cached under several keys ('<id>'
// and '<id>@lod1'), so WeakSets prevent double-disposing shared resources.
const disposedGeometries = new WeakSet();
const disposedMaterials = new WeakSet();
const disposedTextures = new WeakSet();

// prefetch queue: sequential, low priority, drained on browser idle time.
const queue = [];
const queued = new Set();
let draining = false;

// --- internals: loaders -----------------------------------------------------

function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(msg);
}

/** Base GLTFLoader, built lazily and reused. Meshopt ships in-bundle (offline). */
function ensureBaseLoader() {
  if (baseLoader) return baseLoader;
  try {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder); // bundled decoder: always available
    baseLoader = loader;
  } catch (err) {
    warnOnce('gltf', `[assets] GLTFLoader unavailable: ${(err && err.message) || err}`);
  }
  return baseLoader;
}

/**
 * KTX2 transcoder support. Needs a renderer for GPU-format detection; without
 * one we simply stay uncompressed-only. A missing/failed transcoder surfaces
 * later as a per-asset load failure (handled by the normal failure contract).
 */
function ensureKtx2(renderer) {
  if (ktx2Done || !renderer) return;
  ktx2Done = true;
  try {
    ktx2Loader = new KTX2Loader()
      .setTranscoderPath(ASSET_ROOT + 'vendor/basis/')
      .detectSupport(renderer);
    // Patch loaders that may already exist (load() before initAssets()).
    if (baseLoader) baseLoader.setKTX2Loader(ktx2Loader);
    if (dracoGltfLoader) dracoGltfLoader.setKTX2Loader(ktx2Loader);
  } catch (err) {
    warnOnce('ktx2', `[assets] KTX2 detectSupport failed, compressed textures off: ${(err && err.message) || err}`);
    ktx2Loader = null;
  }
}

/**
 * DRACO pipeline, built lazily on the first draco:true entry. Deliberately a
 * SEPARATE GLTFLoader: entries without draco:true never touch the decoder
 * path, even if their binary carries stray Draco extensions.
 */
function ensureDracoPipeline() {
  if (dracoGltfLoader) return dracoGltfLoader;
  const base = ensureBaseLoader();
  if (!base) return null;
  try {
    if (!dracoLoader) {
      dracoLoader = new DRACOLoader().setDecoderPath(ASSET_ROOT + 'vendor/draco/');
    }
    dracoGltfLoader = new GLTFLoader()
      .setDRACOLoader(dracoLoader)
      .setMeshoptDecoder(MeshoptDecoder);
    if (ktx2Loader) dracoGltfLoader.setKTX2Loader(ktx2Loader);
  } catch (err) {
    warnOnce('draco', `[assets] DRACOLoader unavailable: ${(err && err.message) || err}`);
    dracoGltfLoader = null;
  }
  return dracoGltfLoader;
}

// --- internals: load core ---------------------------------------------------

function toArray(value) {
  return Array.isArray(value) ? value : [value];
}

/** Shared failure path: flag + warn once per key, then reject upstream. */
function failKey(key, entry, cause) {
  failedKeys.add(key);
  if (entry) entry.failed = true; // callers read this to keep procedural fallback
  warnOnce('fail:' + key, `[assets] load failed: ${key} (${(cause && cause.message) || cause})`);
}

/** Cache/dedupe/failure wrapper around one URL. Resolves the raw glTF object. */
function loadKeyed(key, url, entry) {
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit.gltf);
  const running = inflight.get(key);
  if (running) return running;
  if (failedKeys.has(key)) {
    return Promise.reject(new Error(`[assets] '${key}' failed earlier this session`));
  }

  const loader = entry.draco ? ensureDracoPipeline() : ensureBaseLoader();
  if (!loader) {
    failKey(key, entry, 'loader unavailable');
    return Promise.reject(new Error(`[assets] '${key}': loader unavailable`));
  }

  const promise = loader.loadAsync(url).then((gltf) => {
    const scene = gltf.scene || (Array.isArray(gltf.scenes) && gltf.scenes[0]);
    if (!scene || !scene.isObject3D) throw new Error('glTF has no scene');
    cache.set(key, { entry, gltf });
    inflight.delete(key);
    return gltf;
  }, (err) => {
    inflight.delete(key);
    failKey(key, entry, err);
    throw err instanceof Error ? err : new Error(String(err));
  });
  inflight.set(key, promise);
  return promise;
}

// --- public API -------------------------------------------------------------

/** Load (and cache) the glTF for a manifest id. Rejects on unknown/unauthored. */
export function load(id) {
  const entry = getEntry(id);
  if (!entry) return Promise.reject(new Error(`[assets] unknown asset id '${id}'`));
  if (!entry.url) {
    failKey(id, entry, 'not authored yet (manifest url is null)');
    return Promise.reject(new Error(`[assets] '${id}' is not authored yet`));
  }
  return loadKeyed(id, entry.url, entry);
}

/** Fire-and-forget warmup. Errors are already warned+flagged inside load(). */
export function preload(ids) {
  for (const id of toArray(ids)) {
    if (typeof id !== 'string' || !id) continue;
    if (!getEntry(id)) {
      warnOnce('unknown:' + id, `[assets] preload skipped unknown id '${id}'`);
      continue;
    }
    load(id).catch(() => {});
  }
}

/**
 * Queue ids for background loading. Sequential (one network decode at a time),
 * scheduled through requestIdleCallback when present so gameplay frames are
 * never blocked; setTimeout fallback keeps the queue moving elsewhere.
 */
export function prefetch(ids) {
  for (const id of toArray(ids)) {
    if (typeof id !== 'string' || !id) continue;
    if (queued.has(id) || cache.has(id) || inflight.has(id) || failedKeys.has(id)) continue;
    queued.add(id);
    queue.push(id);
  }
  scheduleDrain();
}

function scheduleDrain() {
  if (draining || !queue.length) return;
  draining = true;
  const pump = () => {
    const id = queue.shift();
    queued.delete(id);
    if (getEntry(id)) load(id).catch(() => {}); // re-validate: id was queued earlier
    if (!queue.length) {
      draining = false;
      return;
    }
    idle(pump);
  };
  idle(pump);
}

/** Low-priority scheduler: browser idle time when present, timer otherwise. */
function idle(fn) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(fn, { timeout: IDLE_TIMEOUT_MS });
  } else {
    setTimeout(fn, 32);
  }
}

function isSkinned(root) {
  let skinned = false;
  root.traverse((obj) => {
    if (obj.isSkinnedMesh || obj.isBone) skinned = true;
  });
  return skinned;
}

/** Keep only the requested `_lodN` child (falls back to lod0 / first present). */
function pruneLods(root, want) {
  const levels = [];
  for (const child of root.children) {
    const m = child.name.match(LOD_RE);
    if (m) levels.push({ node: child, level: Number(m[1]) });
  }
  if (!levels.length) return; // single-resolution asset
  let pick = levels.find((l) => l.level === want);
  if (!pick) pick = levels.find((l) => l.level === 0) || levels[0];
  for (const l of levels) {
    if (l.node !== pick.node) root.remove(l.node); // clone-local: cache copy untouched
  }
}

function collectByPrefix(root, prefix) {
  const map = {};
  root.traverse((obj) => { // traverse includes root itself
    if (obj.name && obj.name.startsWith(prefix)) map[obj.name] = obj;
  });
  return map;
}

function collectWeakPoints(root) {
  const list = [];
  root.traverse((obj) => {
    if (obj.name && obj.name.startsWith('wp_')) list.push({ name: obj.name, node: obj });
  });
  return list;
}

function indexClips(animations) {
  const map = {};
  for (const clip of animations || []) {
    if (clip && clip.name) map[clip.name] = clip;
  }
  return map;
}

/**
 * Clone a cached asset with conventions resolved. lod picks `_lodN` children
 * inside the file, or a whole-file variant when entry.lods[lod] is authored.
 * Does NOT auto-acquire: call acquire(id) for each long-lived clone (the grace
 * period covers the usual preload->instantiate gap).
 */
export async function instantiate(id, opts) {
  const options = opts || {};
  const lod = Number.isFinite(options.lod) ? Math.max(0, Math.floor(options.lod)) : 0;

  const entry = getEntry(id);
  if (!entry) throw new Error(`[assets] unknown asset id '${id}'`);

  let key = id;
  if (lod > 0 && Array.isArray(entry.lods) && entry.lods[lod]) {
    key = `${id}@lod${lod}`; // whole-file LOD variant shares the entry metadata
    await loadKeyed(key, entry.lods[lod], entry);
  } else {
    await load(id);
  }

  const record = cache.get(key);
  if (!record || !record.gltf || !record.gltf.scene) {
    throw new Error(`[assets] '${key}' missing from cache`);
  }
  const source = record.gltf.scene;

  // Rigged assets need SkeletonUtils.clone (bind-matrix-safe); static ones are
  // fine with a plain deep clone. A partial rig export must not lose the spawn,
  // so a failed skin clone degrades to a static clone.
  let clone;
  if (isSkinned(source)) {
    try {
      clone = SkeletonUtils.clone(source);
    } catch (err) {
      warnOnce('clone:' + key, `[assets] skinned clone failed for '${key}', using static clone: ${(err && err.message) || err}`);
      clone = source.clone(true);
    }
  } else {
    clone = source.clone(true);
  }

  Object.assign(clone.userData, source.userData); // authoring metadata rides along
  pruneLods(clone, lod);
  clone.userData.assetId = id;
  clone.userData.lod = lod;
  clone.userData.sockets = collectByPrefix(clone, 'socket_');
  clone.userData.weakPoints = collectWeakPoints(clone);
  clone.userData.clips = indexClips(record.gltf.animations);
  return clone;
}

/** Count one more live clone of `id`; cancels any pending eviction. */
export function acquire(id) {
  cancelEviction(id);
  const n = (refs.get(id) || 0) + 1;
  refs.set(id, n);
  return n;
}

/** Drop one live clone of `id`; at zero the cache entry becomes evictable. */
export function release(id) {
  const n = Math.max(0, (refs.get(id) || 0) - 1);
  refs.set(id, n);
  if (n === 0) scheduleEviction(id);
  return n;
}

function cancelEviction(id) {
  const t = evictTimers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    evictTimers.delete(id);
  }
}

function scheduleEviction(id) {
  if (evictTimers.has(id) || !cache.has(id)) return;
  evictTimers.set(id, setTimeout(() => {
    evictTimers.delete(id);
    if ((refs.get(id) || 0) > 0) return; // re-acquired during the grace window
    const record = cache.get(id);
    if (!record) return;
    cache.delete(id);
    // Clones share geometry/material/textures with this cached source, so
    // disposing it once frees every dead clone's GPU side too.
    disposeDeep(record.gltf.scene);
  }, GRACE_MS));
}

function isShared(res) {
  return !!(res && res.userData && res.userData.sharedLibrary);
}

/**
 * Dispose GPU resources once per unique resource. Resources flagged
 * userData.sharedLibrary (multi-asset libraries) are never touched here.
 */
function disposeDeep(root) {
  if (!root || !root.isObject3D) return;
  root.traverse((obj) => {
    if (obj.geometry && !isShared(obj.geometry) && !disposedGeometries.has(obj.geometry)) {
      disposedGeometries.add(obj.geometry);
      obj.geometry.dispose();
    }
    const materials = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
    for (const mat of materials) {
      if (!mat || isShared(mat) || disposedMaterials.has(mat)) continue;
      disposedMaterials.add(mat);
      for (const value of Object.values(mat)) {
        if (value && value.isTexture && !isShared(value) && !disposedTextures.has(value)) {
          disposedTextures.add(value);
          value.dispose();
        }
      }
      mat.dispose();
    }
  });
}

/**
 * Boot-time setup. Never throws: a broken asset subsystem must not take the
 * game down with it. Returns { available, pending } - counts of manifest
 * entries still loadable this session and loads currently in flight.
 */
export function initAssets(options) {
  const out = { available: 0, pending: 0 };
  try {
    const renderer = options && options.renderer ? options.renderer : null;
    if (renderer) lastRenderer = renderer;
    ensureBaseLoader();
    ensureKtx2(lastRenderer);
    validateManifest();
    let available = 0;
    for (const category of Object.values(ASSET_MANIFEST)) {
      for (const entry of Object.values(category)) {
        if (entry && entry.url && !entry.failed && !failedKeys.has(entry.id)) available++;
      }
    }
    out.available = available;
    out.pending = inflight.size;
  } catch (err) {
    console.error('[assets] initAssets failed:', (err && err.message) || err);
  }
  return out;
}

/** Coerce every manifest entry to the documented field contract in place. */
function validateManifest() {
  for (const category of Object.values(ASSET_MANIFEST)) {
    for (const entry of Object.values(category)) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.id !== 'string' || !entry.id) entry.id = '(unnamed)';
      if (entry.url !== null && typeof entry.url !== 'string') entry.url = null;
      if (!Array.isArray(entry.lods)) entry.lods = null;
      if (!Array.isArray(entry.clips)) entry.clips = [];
      if (!Array.isArray(entry.sockets)) entry.sockets = [];
      if (!Array.isArray(entry.weakPoints)) entry.weakPoints = [];
      if (typeof entry.draco !== 'boolean') entry.draco = false;
      if (typeof entry.fallback !== 'string') entry.fallback = 'procedural';
      entry.preload = !!entry.preload;
    }
  }
}

/** Telemetry snapshot: {cached, loading, failed, refs} (refs = total count). */
export function getStats() {
  let totalRefs = 0;
  for (const n of refs.values()) totalRefs += n;
  return { cached: cache.size, loading: inflight.size, failed: failedKeys.size, refs: totalRefs };
}
