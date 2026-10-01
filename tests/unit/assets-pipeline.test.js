// IRONWILD - unit tests for the Wave B asset pipeline (src/systems/assets.js)
// and the manifest placeholders (src/assets/manifest.js).
//
// Strategy: authored entries are backed by repository-generated binaries while
// ruin_kit remains a url:null placeholder. Most coverage still drives the
// public API against that mixed authored/fallback state.
// For paths behind a real URL (dedupe, failure bookkeeping, refcount eviction,
// convention resolution) the temporarily-authored-entry trick points one
// manifest entry at a fake path and __setLoaderForTests() swaps the network/
// decode layer for a counting fake - no three-loader mocks, no real files.
//
// Module state (cache/inflight/failedKeys/refs Maps) resets per test via
// vi.resetModules() + dynamic imports, mirroring tests/unit/status-burn.test.js.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';

// Manifest census: 3 machines + 1 player + 2 env (wayshrine + hunter
// authored, ruin_kit placeholder). Update when entries are added/removed.
const ENTRY_COUNT = 6;
const GRACE_MS = 30000; // mirrors GRACE_MS in systems/assets.js

async function loadFresh() {
  vi.resetModules();
  const mods = await Promise.all([
    import('../../src/assets/manifest.js'),
    import('../../src/systems/assets.js'),
  ]);
  return { manifest: mods[0], assets: mods[1] };
}

/** Point a manifest entry at a fake url so load() proceeds past the placeholder guard. */
function authorEntry(manifest, id, url = '/fake/assets/x.glb') {
  for (const category of Object.values(manifest.ASSET_MANIFEST)) {
    if (category[id]) {
      category[id].url = url;
      return category[id];
    }
  }
  throw new Error(`no manifest entry '${id}'`);
}

/**
 * Swap the pipeline's load layer for a counting fake. Returns the call log
 * ([{url, key}] per underlying load attempt) so dedupe/retry assertions read
 * directly off it.
 */
function installFakeLoader(assets, { gltf, failWith } = {}) {
  const calls = [];
  assets.__setLoaderForTests((url, key) => {
    calls.push({ url, key });
    if (failWith) return Promise.reject(failWith);
    return Promise.resolve(gltf);
  });
  return calls;
}

/** Fabricated loaded-glTF: Object3D scene + optional _lodN children + clips,
 * with dispose counters proving eviction frees GPU resources exactly once. */
function makeGltf({ lods = false, clips = [], sockets = false, weakPoints = false } = {}) {
  const scene = new THREE.Object3D();
  scene.name = 'assetRoot';
  const geo = new THREE.BufferGeometry();
  const mat = new THREE.MeshBasicMaterial();
  const geoDispose = vi.spyOn(geo, 'dispose');
  const matDispose = vi.spyOn(mat, 'dispose');
  scene.add(new THREE.Mesh(geo, mat));
  if (lods) {
    const lod0 = new THREE.Object3D();
    lod0.name = 'body_lod0';
    const lod1 = new THREE.Object3D();
    lod1.name = 'body_lod1';
    scene.add(lod0, lod1);
  }
  if (sockets) {
    const jaw = new THREE.Object3D();
    jaw.name = 'socket_jaw';
    scene.add(jaw);
  }
  if (weakPoints) {
    const eye = new THREE.Mesh(geo, mat);
    eye.name = 'wp_eye';
    scene.add(eye);
  }
  return { scene, animations: clips, disposes: { geoDispose, matDispose } };
}

describe('boot safety with zero authored assets (gap 3E)', () => {
  let warnSpy;
  let errSpy;
  beforeEach(() => {
    vi.resetModules();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errSpy.mockRestore();
    vi.useRealTimers();
  });

  it('initAssets fetches nothing for placeholders and reports authored/pending counts', async () => {
    const { manifest, assets } = await loadFresh();
    // Count expectations from the MANIFEST, not hardcoded: the pipeline must
    // report every authored url as 'available' and every url:null placeholder
    // as 'pending' - without touching the network for either.
    let authored = 0;
    const entries = Object.values(manifest.ASSET_MANIFEST).flatMap((cat) =>
      Object.values(cat),
    );
    for (const e of entries) if (e && e.url) authored++;
    const pending = entries.length - authored;
    expect(entries.length).toBe(ENTRY_COUNT);
    // No renderer: KTX2 detectSupport must be skipped entirely (feature-detect
    // order), so this doubles as the renderer-less boot check.
    const summary = assets.initAssets({});
    expect(summary).toEqual({ available: authored, pending });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    expect(assets.getStats()).toEqual({ cached: 0, loading: 0, failed: 0, refs: 0 });
  });

  it('initAssets tolerates being called with a renderer and with nothing', async () => {
    const { assets } = await loadFresh();
    expect(() => assets.initAssets()).not.toThrow();
    // Fake renderer object: detectSupport may reject it (caught -> KTX2 off),
    // but init itself must never throw - a broken asset subsystem cannot take
    // boot down with it.
    expect(() => assets.initAssets({ renderer: {} })).not.toThrow();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('load() on a url:null entry rejects fast, marks NOTHING broken, touches no loader', async () => {
    const { manifest, assets } = await loadFresh();
    const calls = installFakeLoader(assets, { gltf: makeGltf() });
    // 'ruin_kit' remains the only url:null placeholder (machines/hunter/
    // wayshrine ship).
    const entry = manifest.ASSET_MANIFEST.env.ruin_kit;

    await expect(assets.load('ruin_kit')).rejects.toThrow(/not authored yet/);
    expect(calls).toHaveLength(0); // never reached the network layer
    expect(entry.failed).toBeUndefined(); // placeholder != session failure
    expect(assets.getStats()).toEqual({ cached: 0, loading: 0, failed: 0, refs: 0 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('repeated unauthored attempts stay silent and side-effect free', async () => {
    const { manifest, assets } = await loadFresh();
    installFakeLoader(assets, { gltf: makeGltf() });
    for (let i = 0; i < 3; i++) {
      await expect(assets.load('ruin_kit')).rejects.toThrow(/not authored yet/);
      await expect(assets.instantiate('ruin_kit')).rejects.toThrow(/not authored yet/);
    }
    const entry = manifest.ASSET_MANIFEST.env.ruin_kit;
    expect(entry.failed).toBeUndefined();
    expect(assets.getStats().failed).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('preload() silently skips unauthored ids and still warns once on unknown ids', async () => {
    const { assets } = await loadFresh();
    const calls = installFakeLoader(assets, { gltf: makeGltf() });
    assets.preload(['ruin_kit', 'ghost']);
    await Promise.resolve(); // drain microtasks: any swallowed rejection lands here
    expect(calls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(1); // only the unknown-id warning
    expect(warnSpy.mock.calls[0][0]).toMatch(/preload skipped unknown id 'ghost'/);
    expect(assets.getStats().failed).toBe(0);
  });

  it('prefetch() never queues unauthored ids (idle drain stays inert)', async () => {
    const { assets } = await loadFresh();
    const calls = installFakeLoader(assets, { gltf: makeGltf() });
    vi.useFakeTimers();
    assets.prefetch(['ruin_kit']);
    await vi.advanceTimersByTimeAsync(200); // well past the 32ms drain cadence
    expect(calls).toHaveLength(0);
    expect(assets.getStats().cached).toBe(0);
  });

  it('unknown ids reject identically on load/instantiate', async () => {
    const { assets } = await loadFresh();
    installFakeLoader(assets, { gltf: makeGltf() });
    await expect(assets.load('nope')).rejects.toThrow(/unknown asset id 'nope'/);
    await expect(assets.instantiate('nope')).rejects.toThrow(/unknown asset id 'nope'/);
  });
});

describe('failure-path determinism (authored binary that fails to load)', () => {
  let warnSpy;
  beforeEach(() => {
    vi.resetModules();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('first failure warns EXACTLY once, flags the entry, counts in stats', async () => {
    const { manifest, assets } = await loadFresh();
    authorEntry(manifest, 'skitter');
    installFakeLoader(assets, { failWith: new Error('404 simulated') });

    await expect(assets.load('skitter')).rejects.toThrow('404 simulated');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/\[assets\] load failed: skitter/);
    expect(manifest.ASSET_MANIFEST.machines.skitter.failed).toBe(true);
    expect(assets.getStats()).toEqual({ cached: 0, loading: 0, failed: 1, refs: 0 });
  });

  it('subsequent load()s reject from failedKeys without retrying the network', async () => {
    const { manifest, assets } = await loadFresh();
    authorEntry(manifest, 'skitter');
    const calls = installFakeLoader(assets, { failWith: new Error('boom') });

    await expect(assets.load('skitter')).rejects.toThrow('boom');
    await expect(assets.load('skitter')).rejects.toThrow(/failed earlier this session/);
    await expect(assets.load('skitter')).rejects.toThrow(/failed earlier this session/);
    expect(calls).toHaveLength(1); // one attempt total: no retry storm
    expect(warnSpy).toHaveBeenCalledTimes(1); // and still only one warning
  });

  it('instantiate() and preload() after failure reject/skip without extra work', async () => {
    const { manifest, assets } = await loadFresh();
    authorEntry(manifest, 'skitter');
    const calls = installFakeLoader(assets, { failWith: new Error('boom') });
    await expect(assets.load('skitter')).rejects.toThrow('boom');

    await expect(assets.instantiate('skitter')).rejects.toThrow(/failed earlier/);
    assets.preload(['skitter']);
    assets.prefetch(['skitter']); // failedKeys guard drops it at enqueue time
    await new Promise((r) => setTimeout(r, 40)); // past prefetch drain cadence
    expect(calls).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(manifest.ASSET_MANIFEST.machines.skitter.failed).toBe(true);
  });

  it('a glTF without a usable scene takes the SAME failure path as network errors', async () => {
    const { manifest, assets } = await loadFresh();
    authorEntry(manifest, 'skitter');
    installFakeLoader(assets, { gltf: { animations: [] } }); // no .scene
    await expect(assets.load('skitter')).rejects.toThrow(/no scene/);
    // Regression pins for the unified-catch fix: validation throws used to
    // bypass failKey() AND leak the inflight entry forever.
    expect(manifest.ASSET_MANIFEST.machines.skitter.failed).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(assets.getStats()).toEqual({ cached: 0, loading: 0, failed: 1, refs: 0 });
  });
});

describe('load dedupe + caching', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.useRealTimers());

  it('concurrent load(id) calls dedupe to ONE underlying promise', async () => {
    const { manifest, assets } = await loadFresh();
    authorEntry(manifest, 'skitter');
    const gltf = makeGltf();
    const calls = installFakeLoader(assets, { gltf });

    const p1 = assets.load('skitter');
    expect(assets.getStats().loading).toBe(1);
    const p2 = assets.load('skitter');
    expect(p2).toBe(p1); // literally the same in-flight promise
    const [a, b] = await Promise.all([p1, p2]);
    expect(calls).toHaveLength(1);
    expect(a).toBe(b);
    expect(a).toBe(gltf);
    expect(assets.getStats()).toEqual({ cached: 1, loading: 0, failed: 0, refs: 0 });
  });

  it('post-resolution loads hit the cache instead of the loader', async () => {
    const { manifest, assets } = await loadFresh();
    authorEntry(manifest, 'hunter');
    const gltf = makeGltf();
    const calls = installFakeLoader(assets, { gltf });

    const first = await assets.load('hunter');
    const second = await assets.load('hunter');
    expect(calls).toHaveLength(1);
    expect(second).toBe(first);
  });
});

describe('refcount + grace-period eviction', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.useRealTimers());

  async function setupLoaded() {
    const { manifest, assets } = await loadFresh();
    authorEntry(manifest, 'skitter');
    const gltf = makeGltf();
    installFakeLoader(assets, { gltf });
    await assets.load('skitter');
    return { manifest, assets, gltf };
  }

  it('acquire/release arithmetic and double-release clamp at zero', async () => {
    const { assets } = await setupLoaded();
    expect(assets.acquire('skitter')).toBe(1);
    expect(assets.acquire('skitter')).toBe(2);
    expect(assets.release('skitter')).toBe(1);
    expect(assets.release('skitter')).toBe(0);
    expect(assets.release('skitter')).toBe(0); // clamped, never negative
    expect(assets.release('never-loaded')).toBe(0);
    expect(assets.getStats().refs).toBe(0);
  });

  it('refs hitting zero schedules ONE eviction; grace expiry disposes GPU once', async () => {
    const { assets, gltf } = await setupLoaded();
    vi.useFakeTimers();
    assets.acquire('skitter');
    assets.acquire('skitter');
    assets.release('skitter');
    assets.release('skitter');
    assets.release('skitter'); // double-release: timer already scheduled
    expect(assets.getStats().cached).toBe(1); // alive during the grace window

    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(assets.getStats().cached).toBe(1); // 1ms shy of eviction
    await vi.advanceTimersByTimeAsync(1);
    expect(assets.getStats().cached).toBe(0);

    // Clones share geometry/material with the evicted source: exactly one
    // dispose per resource, ever.
    expect(gltf.disposes.geoDispose).toHaveBeenCalledTimes(1);
    expect(gltf.disposes.matDispose).toHaveBeenCalledTimes(1);
  });

  it('re-acquiring during the grace window cancels eviction entirely', async () => {
    const { assets, gltf } = await setupLoaded();
    vi.useFakeTimers();
    assets.acquire('skitter');
    assets.release('skitter');
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1000);

    assets.acquire('skitter'); // rescue inside the window
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(assets.getStats().cached).toBe(1); // survived its original deadline
    expect(gltf.disposes.geoDispose).not.toHaveBeenCalled();

    // And the entry remains fully usable afterwards.
    assets.release('skitter');
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(assets.getStats().cached).toBe(0);
  });

  it('instantiate() still works after release-to-zero inside the grace window', async () => {
    const { manifest, assets } = await loadFresh();
    authorEntry(manifest, 'skitter');
    const gltf = makeGltf({
      sockets: true,
      weakPoints: true,
      clips: [new THREE.AnimationClip('react_hit', 1, [])],
    });
    installFakeLoader(assets, { gltf });
    await assets.load('skitter');

    assets.acquire('skitter');
    assets.release('skitter'); // refs 0: eviction armed, cache still warm
    const clone = await assets.instantiate('skitter');
    expect(clone.userData.assetId).toBe('skitter');
    expect(clone.userData.sockets.socket_jaw).toBeTruthy();
    expect(clone.userData.weakPoints).toHaveLength(1);
    expect(assets.getStats().cached).toBe(1); // grace window kept it resident
  });
});

describe('instantiate convention resolution (end-to-end through the seam)', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.useRealTimers());

  it('resolves sockets/weakPoints/clips onto clone.userData and prunes lods clone-locally', async () => {
    const { manifest, assets } = await loadFresh();
    authorEntry(manifest, 'skitter');
    const reactHit = new THREE.AnimationClip('react_hit', 1, []);
    const gltf = makeGltf({ lods: true, sockets: true, weakPoints: true, clips: [reactHit] });
    installFakeLoader(assets, { gltf });

    const clone = await assets.instantiate('skitter', { lod: 1 });
    expect(clone.userData.assetId).toBe('skitter');
    expect(clone.userData.lod).toBe(1);
    // Conventions resolved from the CLONE's hierarchy...
    expect(clone.userData.sockets.socket_jaw).toBeDefined();
    expect(clone.userData.sockets.socket_jaw).not.toBe(gltf.scene.children.find((c) => c.name === 'socket_jaw'));
    expect(clone.userData.weakPoints.map((w) => w.name)).toEqual(['wp_eye']);
    expect(clone.userData.clips.react_hit).toBe(reactHit);
    // ...with the requested _lodN kept and the others pruned clone-locally.
    expect(clone.children.map((c) => c.name)).toContain('body_lod1');
    expect(clone.children.map((c) => c.name)).not.toContain('body_lod0');
    // The cached source must be untouched: pruning never mutates the original.
    expect(gltf.scene.children.filter((c) => /_lod\d$/.test(c.name))).toHaveLength(2);
  });

  it('whole-file lod variants load under their own "<id>@lodN" cache key', async () => {
    const { manifest, assets } = await loadFresh();
    const entry = authorEntry(manifest, 'duskwing');
    entry.lods = ['/fake/duskwing_lod0.glb', '/fake/duskwing_lod1.glb'];
    const gltf = makeGltf();
    const calls = installFakeLoader(assets, { gltf });

    const clone = await assets.instantiate('duskwing', { lod: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ url: '/fake/duskwing_lod1.glb', key: 'duskwing@lod1' });
    expect(clone.userData.assetId).toBe('duskwing'); // metadata keyed by id
    // Both keys coexist independently in stats.
    await assets.load('duskwing');
    expect(calls).toHaveLength(2);
    expect(assets.getStats().cached).toBe(2);
  });
});

describe('exported pure convention helpers (collectMetadata / resolveLod)', () => {
  beforeEach(() => vi.resetModules());

  it('collectMetadata indexes socket_*/wp_* inclusively and clips by name', async () => {
    const { assets } = await loadFresh();
    const root = new THREE.Object3D();
    const jaw = new THREE.Object3D();
    jaw.name = 'socket_jaw';
    const spine = new THREE.Object3D();
    spine.name = 'socket_spine';
    const eye = new THREE.Mesh(new THREE.BufferGeometry());
    eye.name = 'wp_eye';
    const plain = new THREE.Mesh();
    plain.name = 'hull';
    root.add(jaw, spine, eye, plain);
    const clipA = new THREE.AnimationClip('loc_idle', 1, []);
    const clipB = new THREE.AnimationClip('act_bow_draw', 1, []);

    const meta = assets.collectMetadata(root, [clipA, clipB]);
    expect(meta.sockets).toEqual({ socket_jaw: jaw, socket_spine: spine });
    expect(meta.weakPoints).toHaveLength(1);
    expect(meta.weakPoints[0]).toEqual({ name: 'wp_eye', node: eye });
    expect(meta.clips).toEqual({ loc_idle: clipA, act_bow_draw: clipB });
  });

  it('duplicate socket names: last traversal occurrence wins (documented actual)', async () => {
    const { assets } = await loadFresh();
    const root = new THREE.Object3D();
    const first = new THREE.Object3D();
    first.name = 'socket_hand';
    const deep = new THREE.Object3D();
    deep.name = 'socket_hand';
    const holder = new THREE.Object3D();
    holder.add(deep);
    root.add(first, holder);
    const meta = assets.collectMetadata(root, []);
    expect(meta.sockets.socket_hand).toBe(deep);
  });

  it('duplicate clip names: indexClips is last-write-wins (unlike the anim graph)', async () => {
    const { assets } = await loadFresh();
    const v1 = new THREE.AnimationClip('react_death', 1, []);
    const v2 = new THREE.AnimationClip('react_death', 2, []);
    const meta = assets.collectMetadata(new THREE.Object3D(), [v1, v2]);
    expect(meta.clips.react_death).toBe(v2);
  });

  it('collectMetadata tolerates missing animations and an empty tree', async () => {
    const { assets } = await loadFresh();
    // Note: a null ROOT is not supported (traverse needs an Object3D);
    // instantiate() always passes a clone, so only the empty case is contract.
    const meta = assets.collectMetadata(new THREE.Object3D(), null);
    expect(meta).toEqual({ sockets: {}, weakPoints: [], clips: {} });
  });

  it('resolveLod keeps the exact level, falls back to lod0, or leaves singles alone', async () => {
    const { assets } = await loadFresh();
    const build = () => {
      const r = new THREE.Object3D();
      const l0 = new THREE.Object3D();
      l0.name = 'mesh_lod0';
      const l1 = new THREE.Object3D();
      l1.name = 'mesh_lod1';
      r.add(l0, l1);
      return { r, l0, l1 };
    };

    const a = build();
    expect(assets.resolveLod(a.r, 1)).toBe(1);
    expect(a.r.children).toEqual([a.l1]);

    const b = build();
    expect(assets.resolveLod(b.r, 2)).toBe(0); // missing level falls to lod0
    expect(b.r.children).toEqual([b.l0]);

    const c = build();
    expect(assets.resolveLod(c.r, -3)).toBe(0); // negatives clamp to lod0
    expect(assets.resolveLod(new THREE.Object3D(), 1)).toBeNull(); // no suffixed children
  });
});

