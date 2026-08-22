// IRONWILD - authored hunter view (production-pass seam).
//
// Loads the manifest-authored hunter rig and swaps it in as the player's
// visual body. The authored GLB mirrors the procedural hierarchy's node
// names and pivot transforms exactly (see scripts/create-hunter-asset.mjs),
// so the existing pose system animates it unchanged; weapons re-attach to
// the identically named handL/handR anchors via requestReattach hooks.
//
// Contract: every failure path keeps the procedural body - a missing or
// broken asset can only ever cost visual fidelity, never gameplay.
import { getEntry, instantiate, acquire, release } from '../systems/assets.js';
// Same-chunk statics (main.js already ships them); the earlier dynamic
// imports here only produced Vite mixed-import warnings.
import { requestReattach as reattachBow } from './bow.js';
import { requestReattach as reattachSpear } from './spear.js';
import { G } from '../core/state.js';

let attempted = false;
let active = false;

export function createHunterView() {
  if (attempted) return;
  attempted = true;
  const entry = getEntry('hunter');
  if (!entry || !entry.url) return; // unauthored: procedural hunter stands

  instantiate('hunter')
    .then((clone) => {
      const authoredRoot =
        clone.getObjectByName('hunter_body') ||
        (clone.userData.assetId === 'hunter' ? clone : null);
      if (!authoredRoot || !G.player || !G.player.useAuthoredBody) {
        return; // unexpected shape: keep procedural (already warned upstream)
      }
      acquire('hunter');
      // The manifest id rides the CLONE ROOT; we graft only its 'hunter_body'
      // subtree into the player, so carry the tag onto the grafted node.
      authoredRoot.userData.assetId = 'hunter';
      authoredRoot.traverse((o) => {
        if (o.isMesh) o.castShadow = true;
      });
      if (G.player.useAuthoredBody(authoredRoot)) {
        active = true;
        // Weapons re-resolve their hand anchors on the swapped rig.
        reattachBow();
        reattachSpear();
      }
    })
    .catch(() => { /* load failure already warned+flagged inside assets.js */ });
}

/** True once the authored rig is the live visual body. */
export function isAuthoredActive() {
  return active;
}

/** Page teardown: drop the ref so eviction can reclaim GPU resources. */
export function disposeHunterView() {
  if (active) release('hunter');
  active = false;
}
