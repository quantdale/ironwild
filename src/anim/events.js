// IRONWILD - Wave E animation runtime: clip timeline events + attack windows.
// Authored clips carry no metadata in three.js, so timing metadata lives
// alongside the Action: attachEvents() fires named beats on the bus as the
// playhead crosses them, attachAttackWindows()/activeWindowProgress() expose
// the anticipation/active/recovery contract consumed by combat + VFX + audio.

import { bus } from '../core/events.js';

const WINDOWS = new WeakMap(); // AnimationAction -> {anticipation, active, recovery}

/**
 * Attach timeline events to an AnimationAction.
 *   defs: [{ t: seconds-from-clip-start, name: string, data?: any }, ...]
 * Returns a controller with update() that must be called once per frame AFTER
 * the owning mixer advanced, and reset() to re-arm after a manual restart.
 * Events fire on the bus as:
 *   'animEvent' { name, data, source }   // source = clip name string
 * Loop-aware: a playhead wrap (LoopRepeat) fires the tail of the previous loop
 * before the head of the new one, so no beat is skipped at the seam. Beats are
 * fired strictly-forward (`last < t <= now`), so double update() calls in one
 * frame cannot duplicate them.
 */
export function attachEvents(action, defs) {
  const list = (Array.isArray(defs) ? defs : [])
    .filter((d) => d && typeof d.t === 'number' && typeof d.name === 'string')
    .sort((a, b) => a.t - b.t);
  let last = action && action.time ? action.time : 0;

  function fireRange(from, to) {
    let source = null;
    for (const d of list) {
      if (d.t <= from || d.t > to) continue;
      if (source === null) {
        try { source = action.getClip().name; } catch { source = 'unknown'; }
      }
      bus.emit('animEvent', { name: d.name, data: d.data, source });
    }
  }

  return {
    /** Sample the playhead; call once per frame after mixer.update(). */
    update() {
      if (!action || !list.length) return;
      const t = action.time;
      if (t === last) return;
      if (t < last) {
        // Wrapped or externally restarted: drain the old loop's tail first.
        fireRange(last, Infinity);
        fireRange(-Infinity, t);
      } else {
        fireRange(last, t);
      }
      last = t;
    },

    /** Re-arm tracking from the current playhead (drops pending beats). */
    reset() {
      last = action ? action.time : 0;
    },
  };
}

/**
 * Declare the attack-window contract for an Action:
 *   { anticipation, active, recovery } - all seconds, all >= 0.
 * Combat reads the live window with activeWindowProgress(); VFX/audio can key
 * off the same numbers instead of hardcoding per-machine timings.
 */
export function attachAttackWindows(action, { anticipation = 0, active = 0, recovery = 0 } = {}) {
  const meta = {
    anticipation: Math.max(0, Number(anticipation) || 0),
    active: Math.max(0, Number(active) || 0),
    recovery: Math.max(0, Number(recovery) || 0),
  };
  WINDOWS.set(action, meta);
  return meta;
}

/**
 * Progress through the ACTIVE damage window of an attack action:
 *   -1            outside the window (or no windows attached)
 *   0..1          inside, 0 at window start, 1 at window end
 * Assumes forward playback of a LoopOnce attack; looping attacks would need a
 * modulo over clip duration, which no roster attack uses today.
 */
export function activeWindowProgress(action) {
  const w = WINDOWS.get(action);
  if (!w || w.active <= 0) return -1;
  const start = w.anticipation;
  const end = start + w.active;
  const t = action ? action.time : -1;
  if (t < start || t > end) return -1;
  return (t - start) / w.active;
}

/**
 * Clip naming convention parser.
 *   'act_spear_thrust' -> { kind:'act', family:'spear', move:'thrust' }
 *   'loc_walk'         -> { kind:'loc',  family:'walk', move:null }
 *   'react_hit_light'  -> { kind:'react',family:'hit',  move:'light' }
 * Unknown prefixes yield kind:null (the unknown head token is consumed;
 * family receives the NEXT token) so callers can still bucket custom names
 * without throwing.
 */
export function parseClipName(raw) {
  const parts = String(raw || '').split('_');
  const head = parts.shift().toLowerCase();
  const kind = head === 'loc' || head === 'act' || head === 'react' ? head : null;
  const family = parts.length ? parts.shift() : null;
  const move = parts.length ? parts.join('_') : null;
  return { kind, family, move };
}
