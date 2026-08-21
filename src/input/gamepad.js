// IRONWILD - gamepad polling (Wave J input layer).
// Self-contained snapshot of the most recently connected standard-mapped pad,
// read once per frame by core/input.js (Input.beginFrame -> pollGamepads) and
// merged into the action layer. Fully feature-detected: browsers/devices
// without Gamepad or vibration support simply no-op - a broken gamepad path
// must never crash boot. No imports: this module knows nothing about Input.

// Radial deadzone for both sticks; magnitudes at or below it read exactly zero
// and the remainder is rescaled 0..1 so gentle pushes stay usable.
const DEADZONE = 0.18;
// Analog trigger thresholds (standard mapping exposes LT/RT as buttons 6/7
// with .value ramps, not binary presses).
export const RT_AIM_THRESHOLD = 0.4; // aim (analog, per Wave J spec)
export const LT_FIRE_THRESHOLD = 0.5;

// W3C standard-gamepad indices consumed by core/input.js.
export const PAD_BUTTONS = {
  A: 0, B: 1, X: 2, Y: 3,          // A jump / B dodge / X interact / Y crouch
  LB: 4, RB: 5,                    // focus / sprint
  LT: 6, RT: 7,                    // fire+melee / aim (analog values)
  START: 9,                        // pause-equivalent pulse
  DPAD_UP: 12, DPAD_DOWN: 13, DPAD_LEFT: 14, DPAD_RIGHT: 15, // ui nav edges
};

const state = {
  connected: false,
  id: '',
  move: { x: 0, y: 0 },  // left stick, radial-deadzoned; up = -y
  look: { x: 0, y: 0 },  // right stick, radial-deadzoned; up = -y
  held: [],              // per standard index: pressed right now
  values: [],            // per standard index: analog value 0..1 (triggers ramp)
  edges: {},             // PAD_BUTTONS name -> true only on the poll it went down
  startEdge: false,      // START went down on this poll (Escape pulse in input.js)
  nav: { up: false, down: false, left: false, right: false }, // dpad edges
};

// Previous poll's held[] - edges are current && !previous, recomputed every
// poll so no separate end-of-frame clearing pass is needed.
let prevHeld = [];

/** Radial deadzone + rescale; returns [x, y]. */
function deadzone(x, y) {
  const mag = Math.hypot(x, y);
  if (!(mag > DEADZONE)) return [0, 0]; // NaN-safe: NaN fails the compare
  const scaled = Math.min(1, (mag - DEADZONE) / (1 - DEADZONE)) / mag;
  return [x * scaled, y * scaled];
}

/**
 * Sample navigator.getGamepads() and refresh the shared state object. Called
 * once per frame from Input.beginFrame; edges are valid for that whole frame.
 */
export function pollGamepads() {
  let pad = null;
  try {
    const pads = typeof navigator.getGamepads === 'function'
      ? navigator.getGamepads() : null;
    if (pads) {
      // Prefer an explicit 'standard' mapping; fall back to the first live pad.
      for (const p of pads) {
        if (p && p.connected) { pad = p; if (p.mapping === 'standard') break; }
      }
    }
  } catch (err) {
    pad = null; // getGamepads can throw in hardened privacy modes - stay inert
  }

  if (!pad) {
    state.connected = false;
    prevHeld = [];
    return;
  }
  state.connected = true;
  state.id = String(pad.id || '');

  const held = [];
  const values = [];
  const count = Math.max(pad.buttons ? pad.buttons.length : 0, 16);
  for (let i = 0; i < count; i++) {
    const btn = pad.buttons && pad.buttons[i];
    held[i] = !!(btn && (btn.pressed || btn.value > 0.5));
    values[i] = btn ? (typeof btn.value === 'number' ? btn.value : (btn.pressed ? 1 : 0)) : 0;
  }
  state.held = held;
  state.values = values;

  const axes = pad.axes || [];
  const mx = deadzone(axes[0] || 0, axes[1] || 0);
  const lx = deadzone(axes[2] || 0, axes[3] || 0);
  state.move.x = mx[0]; state.move.y = mx[1];
  state.look.x = lx[0]; state.look.y = lx[1];

  // Rising edges for the mapped buttons (one frame wide by construction).
  state.edges = {};
  for (const name of Object.keys(PAD_BUTTONS)) {
    const idx = PAD_BUTTONS[name];
    state.edges[name] = !!held[idx] && !prevHeld[idx];
  }
  state.startEdge = !!state.edges.START;
  state.nav.up = !!state.edges.DPAD_UP;
  state.nav.down = !!state.edges.DPAD_DOWN;
  state.nav.left = !!state.edges.DPAD_LEFT;
  state.nav.right = !!state.edges.DPAD_RIGHT;

  prevHeld = held;
}

/** Live snapshot reference for core/input.js merges. Read-only by convention. */
export function getGamepadState() {
  return state;
}

/**
 * Fire-and-forget rumble via the dual-rumble actuator. Intensity 0..1 scales
 * both motors (weak motor gets half weight, matching common feel practice).
 * Returns true if an effect was actually dispatched. Silent no-op (false)
 * when no capable pad exists - callers must treat rumble as best-effort.
 */
export function rumble(intensity = 1, durationMs = 120) {
  const mag = Math.max(0, Math.min(1, Number(intensity) || 0));
  const dur = Math.max(0, Math.min(2000, Math.round(Number(durationMs) || 0)));
  if (mag <= 0 || dur <= 0) return false;
  try {
    const pads = typeof navigator.getGamepads === 'function'
      ? navigator.getGamepads() : null;
    if (!pads) return false;
    for (const p of pads) {
      const act = p && p.vibrationActuator;
      if (act && typeof act.playEffect === 'function') {
        act.playEffect('dual-rumble', {
          startDelay: 0,
          duration: dur,
          weakMagnitude: mag * 0.6,
          strongMagnitude: mag,
        });
        return true;
      }
    }
  } catch (err) {
    return false; // vibration permission/impl quirks - never propagate
  }
  return false;
}
