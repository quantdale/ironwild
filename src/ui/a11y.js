// IRONWILD - accessibility runtime (Wave J).
// Applies the a11y settings owned by ui/settings.js to the DOM and exposes
// them for consumers. Body classes driven here:
//   - 'iw-high-contrast' (highContrastCues): thicker achromatic weak-point/
//     reticle cues in ui/hud.js.
//   - 'iw-reduce-flashing' (reduceFlashing): disables the CSS-animated flashing
//     layers in ui/hud.js injectStyles() (low-hp vignette pulse #iw-vig,
//     grain translation #iw-grain, xp-bar pulse #iw-xpbar.pulse, contract-done
//     flash .iw-qslot.done) while keeping their static forms; the imperative
//     weather lightning flash reads the setting directly in world/weather.js.
// Also publishes --iw-ui-scale on <html> (uiScale) and window.__IW_A11Y =
// { camShakeScale, reduceFlashing, highContrast, uiScale } per the Perf-HUD
// publishing convention. shake/flash consumers (camera.js impact shake,
// world/weather.js lightning) read these; this module only publishes state
// and never crashes on missing settings or DOM.

import { bus } from '../core/events.js';
import { G } from '../core/state.js';

// Settings keys that re-trigger apply(); mirrors ui/settings.js ownership.
// 'reduceFlashing' drives the 'iw-reduce-flashing' body class below (and the
// weather flash clamp, which reads G.settings at strike time).
const WATCHED_KEYS = new Set([
  'camShakeScale', 'reduceFlashing', 'uiScale', 'highContrastCues',
]);

let created = false;
let current = {
  camShakeScale: 1,
  reduceFlashing: false,
  highContrast: false,
  uiScale: 1,
};

function clampNum(v, min, max, fallback) {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(max, Math.max(min, v))
    : fallback;
}

/** Re-read G.settings into `current` and push it to the DOM + window. */
function apply() {
  const s = G.settings || {};
  current = {
    camShakeScale: clampNum(s.camShakeScale, 0, 1, 1),
    reduceFlashing: !!s.reduceFlashing,
    highContrast: !!s.highContrastCues,
    uiScale: clampNum(s.uiScale, 0.85, 1.3, 1),
  };
  try {
    document.documentElement.style.setProperty('--iw-ui-scale', String(current.uiScale));
    if (document.body) {
      document.body.classList.toggle('iw-high-contrast', current.highContrast);
      document.body.classList.toggle('iw-reduce-flashing', current.reduceFlashing);
    }
    // Fresh object per publish so consumers can diff by identity safely.
    window.__IW_A11Y = { ...current };
  } catch (err) { /* headless/DOM-less contexts - state stays in `current` */ }
}

/** Install once at boot (after createSettings so saved values are loaded). */
export function createA11y() {
  if (created) return;
  created = true;
  apply();
  bus.on('settingsChanged', ({ key } = {}) => {
    if (!key || !WATCHED_KEYS.has(key)) return;
    apply();
  });
}

/**
 * Reserved per-frame tick (contract symmetry with the other systems): a11y is
 * fully event-driven via 'settingsChanged', so there is no per-frame work.
 */
export function updateA11y(_dt) {
  // event-driven: no per-frame work
}

/** Snapshot copy of the currently applied options. */
export function getA11y() {
  return { ...current };
}
