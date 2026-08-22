// IRONWILD - authored landmark placement (pipeline certification wave).
//
// Spawns manifest-authored env landmarks into the live world through the
// AssetManager bridge (systems/assets.js): network fetch -> GLTF decode ->
// convention resolution -> scene graph -> animation. The first entry is the
// repository-generated 'wayshrine' certification prop - deliberately PIPELINE
// PROOF, not production art.
//
// Contract:
//   - createLandmarks(): idempotent boot; kicks async loads, never throws,
//     never blocks boot. Load failures warn once inside assets.js and leave
//     the world without the landmark (decorative-only by design).
//   - updateLandmarks(dt): ticks AnimationMixers for arrived landmarks.
//   - disposeLandmarks(): releases refs + disposes mixers (page teardown).
import * as THREE from 'three';
import { getEntry, acquire, release, instantiate, getStats } from '../systems/assets.js';
import { heightAt } from './terrain.js';
import { G } from '../core/state.js';

// Scenic anchor: visible from the player start, clear of machine spawn rings.
const LANDMARKS = [
  { id: 'wayshrine', x: 10, z: -14, rotY: 0.6 },
];

const live = []; // { id, root, mixer }

let inited = false;

export function createLandmarks() {
  if (inited) return;
  inited = true;
  // Telemetry publisher (perf.js reads this like __IW_PERF_CELLS).
  if (typeof window !== 'undefined') {
    window.__IW_PERF_ASSETS = getStats;
  }

  for (const spec of LANDMARKS) {
    const entry = getEntry(spec.id);
    if (!entry || !entry.url) continue; // unauthored: procedural world only
    instantiate(spec.id, { lod: 0 })
      .then((root) => {
        if (!G.scene) return;
        acquire(spec.id);
        root.position.set(spec.x, heightAt(spec.x, spec.z), spec.z);
        root.rotation.y = spec.rotY;

        let mixer = null;
        const clips = root.userData.clips || {};
        const spin = clips['act_spin'];
        if (spin) {
          mixer = new THREE.AnimationMixer(root);
          mixer.clipAction(spin).play();
        }
        live.push({ id: spec.id, root, mixer });
        G.scene.add(root);
      })
      .catch(() => { /* warned+flagged inside assets.js; decorative skip */ });
  }
}

/** Per-frame mixer tick (raw dt: decorative spin survives pause dilation). */
export function updateLandmarks(dt) {
  for (const l of live) {
    if (l.mixer) l.mixer.update(dt);
  }
}

export function disposeLandmarks() {
  for (const l of live) {
    if (l.mixer) l.mixer.stopAllAction();
    l.root.removeFromParent();
    release(l.id);
  }
  live.length = 0;
}
