// IRONWILD - settings modal (v2, extended in v4, accessibility+controls in J).
// Owns G.settings persistence (localStorage key 'ironwild-settings') and the
// modal UI: master/music/sfx volume sliders, mouse sensitivity, invert-Y
// checkbox, quality select, colorblind weak-point cue toggle, difficulty
// select. Every change writes G.settings, persists the whole object, and
// emits 'settingsChanged' {key,value}; consumers apply values live (audio
// gains in audio.js, renderer/shadow quality in main.js, weak-point markers
// in ui/focus.js, spawn damage/hp scaling in machines/ai.js). The gear
// buttons on the start/pause screens (built by ui/menus.js) call openSettings().
// Wave J adds ACCESSIBILITY (camShakeScale/reduceFlashing/uiScale/
// highContrastCues/aimAssist/aimMode/crouchMode; applied by ui/a11y.js +
// input.js) and CONTROLS sections (click-to-rebind via Input.setBinding,
// persisted separately under localStorage 'ironwild-bindings').

import { bus } from '../core/events.js';
import { G } from '../core/state.js';
import { Input } from '../core/input.js';

const STORAGE_KEY = 'ironwild-settings';

// Slider defs drive both the DOM and the defensive-load clamping.
const SLIDERS = [
  { key: 'master', label: 'MASTER VOLUME', min: 0, max: 1, step: 0.05 },
  { key: 'music', label: 'MUSIC VOLUME', min: 0, max: 1, step: 0.05 },
  { key: 'sfx', label: 'SFX VOLUME', min: 0, max: 1, step: 0.05 },
  { key: 'sens', label: 'MOUSE SENSITIVITY', min: 0.3, max: 2, step: 0.05 },
];
const QUALITIES = ['high', 'medium', 'low'];
const DIFFICULTIES = ['normal', 'hardened'];

// Wave J a11y/controls settings. Defaults are merged defensively here (never
// in core/state.js) so old saves and fresh boots both end up complete.
const A11Y_DEFAULTS = {
  camShakeScale: 1,      // 0..1 multiplier on camera impact shake
  reduceFlashing: false, // damp HUD flash overlays (hit vignette, reticle kick)
  uiScale: 1,            // 0.85..1.3, exposed as --iw-ui-scale by ui/a11y.js
  highContrastCues: false,
  aimAssist: 0,          // 0..1 magnetism strength (consumers read >=0.01)
  aimMode: 'hold',       // 'hold' | 'toggle' - action layer in core/input.js
  crouchMode: 'toggle',  // 'hold' | 'toggle' (legacy KeyC feel is a toggle; input.js owns the latch)
};
const MODES = ['hold', 'toggle'];

// Keyboard-primary actions offered as rebind rows (aim/fire stay mouse-bound;
// their defaults live in core/input.js DEFAULT_BINDINGS).
const CONTROL_ACTIONS = [
  ['forward', 'MOVE FORWARD'],
  ['back', 'MOVE BACK'],
  ['left', 'STRAFE LEFT'],
  ['right', 'STRAFE RIGHT'],
  ['jump', 'JUMP'],
  ['dodge', 'DODGE'],
  ['sprint', 'SPRINT'],
  ['crouch', 'CROUCH'],
  ['interact', 'INTERACT'],
  ['focus', 'FOCUS SCAN'],
  ['heal', 'USE MEDICINE'],
  ['quicksave', 'QUICKSAVE'],
  ['melee', 'SPEAR MELEE'],
  ['arrowToggle', 'TOGGLE ARROW TYPE'],
];

let created = false;
let els = null;
let capturing = null; // action name while a rebind row waits for a keydown

/** Merge missing Wave J keys into G.settings (idempotent). */
function applyA11yDefaults() {
  for (const [key, value] of Object.entries(A11Y_DEFAULTS)) {
    if (G.settings[key] === undefined) G.settings[key] = value;
  }
}

/**
 * Merge saved settings over G.settings defaults. Called by main right after
 * renderer boot (before any UI exists). Unknown keys ignored, wrong-typed
 * values dropped, numbers clamped into their slider range.
 */
export function loadSettings() {
  applyA11yDefaults(); // Wave J keys exist even when nothing was saved yet
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch (err) {
    saved = null; // corrupt JSON or storage unavailable -> keep defaults
  }
  if (!saved || typeof saved !== 'object') return;
  for (const def of SLIDERS) {
    const v = saved[def.key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      G.settings[def.key] = Math.min(def.max, Math.max(def.min, v));
    }
  }
  if (typeof saved.invertY === 'boolean') G.settings.invertY = saved.invertY;
  if (typeof saved.colorblind === 'boolean') G.settings.colorblind = saved.colorblind;
  if (QUALITIES.includes(saved.quality)) G.settings.quality = saved.quality;
  if (DIFFICULTIES.includes(saved.difficulty)) G.settings.difficulty = saved.difficulty;

  // Wave J keys - lenient merge so pre-J saves load unchanged.
  if (typeof saved.camShakeScale === 'number' && Number.isFinite(saved.camShakeScale)) {
    G.settings.camShakeScale = Math.min(1, Math.max(0, saved.camShakeScale));
  }
  if (typeof saved.uiScale === 'number' && Number.isFinite(saved.uiScale)) {
    G.settings.uiScale = Math.min(1.3, Math.max(0.85, saved.uiScale));
  }
  if (typeof saved.aimAssist === 'number' && Number.isFinite(saved.aimAssist)) {
    G.settings.aimAssist = Math.min(1, Math.max(0, saved.aimAssist));
  }
  if (typeof saved.reduceFlashing === 'boolean') G.settings.reduceFlashing = saved.reduceFlashing;
  if (typeof saved.highContrastCues === 'boolean') G.settings.highContrastCues = saved.highContrastCues;
  if (MODES.includes(saved.aimMode)) G.settings.aimMode = saved.aimMode;
  if (MODES.includes(saved.crouchMode)) G.settings.crouchMode = saved.crouchMode;
}

export function createSettings() {
  if (created) return;
  created = true;
  applyA11yDefaults();
  injectStyles();
  buildDom();
  syncControls();

  // Rebind capture must see keys BEFORE the Escape-closes-modal handler below
  // (same phase, registration order): while a row is listening, Esc cancels
  // the capture instead of closing the modal, and the pressed key never leaks
  // into gameplay (capture-phase stopImmediatePropagation blocks Input too).
  window.addEventListener('keydown', (e) => {
    if (!capturing) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    const action = capturing;
    capturing = null;
    if (e.code !== 'Escape') {
      Input.setBinding(action, e.code);
      bus.emit('ui', { action: 'click' });
    }
    refreshControlRows();
  }, true);

  // A focus steal mid-capture would leave the row armed forever; disarm it.
  window.addEventListener('blur', () => {
    if (!capturing) return;
    capturing = null;
    refreshControlRows();
  });

  // Capture-phase Escape: close the modal and stop Input/menus from also
  // acting on the same keypress (e.g. resuming from the pause screen).
  window.addEventListener('keydown', (e) => {
    if (!isOpen() || e.code !== 'Escape') return;
    e.stopImmediatePropagation();
    closeSettings();
  }, true);
}

export function isOpen() {
  return created && !!els && !els.overlay.classList.contains('hidden');
}

export function openSettings() {
  if (!created) return;
  syncControls();
  els.overlay.classList.remove('hidden');
  // 'ui' action 'open' also makes systems/save.js snapshot progress.
  bus.emit('ui', { action: 'open' });
}

export function closeSettings() {
  if (!isOpen()) return;
  if (capturing) { capturing = null; refreshControlRows(); }
  els.overlay.classList.add('hidden');
  bus.emit('ui', { action: 'close' });
}

// ---------------------------------------------------------------- internals

function setValue(key, value) {
  G.settings[key] = value;
  persist();
  bus.emit('settingsChanged', { key, value });
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(G.settings));
  } catch (err) { /* storage unavailable - settings stay session-only */ }
}

/** Push current G.settings into every control. */
function syncControls() {
  if (!created) return;
  for (const def of SLIDERS) {
    const s = els.sliders[def.key];
    s.input.value = String(G.settings[def.key]);
    s.valueEl.textContent = formatValue(def.key, G.settings[def.key]);
  }
  els.invert.checked = !!G.settings.invertY;
  els.colorblind.checked = !!G.settings.colorblind;
  els.quality.value = G.settings.quality;
  els.difficulty.value = G.settings.difficulty;
  // Wave J a11y controls.
  els.camShake.value = String(G.settings.camShakeScale);
  els.reduceFlash.checked = !!G.settings.reduceFlashing;
  els.uiScale.input.value = String(G.settings.uiScale);
  els.uiScale.valueEl.textContent = formatValue('uiScale', G.settings.uiScale);
  els.highContrast.checked = !!G.settings.highContrastCues;
  els.aimAssist.input.value = String(G.settings.aimAssist);
  els.aimAssist.valueEl.textContent = formatValue('aimAssist', G.settings.aimAssist);
  els.aimMode.value = G.settings.aimMode;
  els.crouchMode.value = G.settings.crouchMode;
  refreshControlRows();
}

function formatValue(key, v) {
  if (key === 'sens') return v.toFixed(2);
  if (key === 'uiScale') return `${v.toFixed(2)}x`;
  return `${Math.round(v * 100)}%`;
}

/** Human-readable label for a KeyboardEvent.code binding. */
function fmtCode(code) {
  if (!code) return '-';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Arrow(\w+)$/.test(code)) return `ARROW ${code.slice(5)}`.toUpperCase();
  if (code === 'ControlLeft') return 'L-CTRL';
  if (code === 'ControlRight') return 'R-CTRL';
  if (code === 'ShiftLeft') return 'L-SHIFT';
  if (code === 'ShiftRight') return 'R-SHIFT';
  if (/^Mouse\d$/.test(code)) return `MOUSE ${code.slice(4)}`;
  return code.toUpperCase();
}

/** Re-read Input bindings into the CONTROLS rows (labels + capture state). */
function refreshControlRows() {
  if (!created || !els.controlRows) return;
  const bindings = Input.getBindings();
  for (const [action] of CONTROL_ACTIONS) {
    const row = els.controlRows[action];
    if (!row) continue;
    row.bindBtn.textContent = capturing === action
      ? 'PRESS KEY...'
      : fmtCode(bindings[action] && bindings[action][0]);
    row.bindBtn.classList.toggle('listening', capturing === action);
  }
}

function buildDom() {
  els = { sliders: {} };

  const rows = SLIDERS.map((def) => `
    <div class="iw-set-row">
      <span class="iw-set-label">${def.label}</span>
      <input type="range" class="iw-set-range" data-key="${def.key}"
             min="${def.min}" max="${def.max}" step="${def.step}">
      <span class="iw-set-val" data-val="${def.key}"></span>
    </div>`).join('');

  const controlRows = CONTROL_ACTIONS.map(([action, label]) => `
    <div class="iw-set-row">
      <span class="iw-set-label">${label}</span>
      <button type="button" class="iw-set-key" data-bind="${action}">-</button>
      <button type="button" class="iw-set-mini" data-reset="${action}" title="Reset to default">RESET</button>
    </div>`).join('');

  const overlay = document.createElement('div');
  overlay.className = 'iw-settings hidden';
  overlay.innerHTML = `
    <div class="iw-settings-panel">
      <div class="iw-panel-title">SETTINGS</div>
      ${rows}
      <div class="iw-set-row">
        <span class="iw-set-label">INVERT Y AXIS</span>
        <input type="checkbox" id="iw-set-inverty">
        <span class="iw-set-val"></span>
      </div>
      <div class="iw-set-row">
        <span class="iw-set-label">COLORBLIND WEAK-POINT CUE</span>
        <input type="checkbox" id="iw-set-colorblind">
        <span class="iw-set-val"></span>
      </div>
      <div class="iw-set-row">
        <span class="iw-set-label">QUALITY</span>
        <select id="iw-set-quality" class="iw-set-select">
          ${QUALITIES.map((q) => `<option value="${q}">${q.toUpperCase()}</option>`).join('')}
        </select>
        <span class="iw-set-val"></span>
      </div>
      <div class="iw-set-row">
        <span class="iw-set-label">DIFFICULTY</span>
        <select id="iw-set-difficulty" class="iw-set-select">
          ${DIFFICULTIES.map((d) => `<option value="${d}">${d.toUpperCase()}</option>`).join('')}
        </select>
        <span class="iw-set-val"></span>
      </div>
      <div class="iw-set-section">ACCESSIBILITY</div>
      <div class="iw-set-row">
        <span class="iw-set-label">CAMERA SHAKE</span>
        <select id="iw-set-camshake" class="iw-set-select">
          <option value="0">OFF</option><option value="0.5">HALF</option><option value="1">FULL</option>
        </select>
        <span class="iw-set-val"></span>
      </div>
      <div class="iw-set-row">
        <span class="iw-set-label">REDUCE FLASHING</span>
        <input type="checkbox" id="iw-set-flash">
        <span class="iw-set-val"></span>
      </div>
      <div class="iw-set-row">
        <span class="iw-set-label">UI SCALE</span>
        <input type="range" class="iw-set-range" data-range="uiScale"
               min="0.85" max="1.3" step="0.05">
        <span class="iw-set-val" data-rval="uiScale"></span>
      </div>
      <div class="iw-set-row">
        <span class="iw-set-label">HIGH CONTRAST CUES</span>
        <input type="checkbox" id="iw-set-hc">
        <span class="iw-set-val"></span>
      </div>
      <div class="iw-set-row">
        <span class="iw-set-label">AIM ASSIST</span>
        <input type="range" class="iw-set-range" data-range="aimAssist"
               min="0" max="1" step="0.05">
        <span class="iw-set-val" data-rval="aimAssist"></span>
      </div>
      <div class="iw-set-row">
        <span class="iw-set-label">AIM MODE</span>
        <select id="iw-set-aimmode" class="iw-set-select">
          ${MODES.map((m) => `<option value="${m}">${m.toUpperCase()}</option>`).join('')}
        </select>
        <span class="iw-set-val"></span>
      </div>
      <div class="iw-set-row">
        <span class="iw-set-label">CROUCH MODE</span>
        <select id="iw-set-crouchmode" class="iw-set-select">
          ${MODES.map((m) => `<option value="${m}">${m.toUpperCase()}</option>`).join('')}
        </select>
        <span class="iw-set-val"></span>
      </div>
      <div class="iw-set-section">CONTROLS - CLICK A KEY TO REBIND, ESC CANCELS</div>
      ${controlRows}
      <div class="iw-btnrow">
        <button class="iw-btn iw-small" id="iw-set-resetkeys">RESET ALL KEYS</button>
        <button class="iw-btn iw-small" id="iw-set-close">CLOSE</button>
      </div>
      <div class="iw-hint">[ESC] to close</div>
    </div>`;
  document.body.appendChild(overlay);
  els.overlay = overlay;

  for (const def of SLIDERS) {
    const input = overlay.querySelector(`[data-key="${def.key}"]`);
    const valueEl = overlay.querySelector(`[data-val="${def.key}"]`);
    input.addEventListener('input', () => {
      setValue(def.key, parseFloat(input.value));
      valueEl.textContent = formatValue(def.key, G.settings[def.key]);
    });
    els.sliders[def.key] = { input, valueEl };
  }

  els.invert = overlay.querySelector('#iw-set-inverty');
  els.invert.addEventListener('change', () => setValue('invertY', els.invert.checked));

  els.colorblind = overlay.querySelector('#iw-set-colorblind');
  els.colorblind.addEventListener('change', () => setValue('colorblind', els.colorblind.checked));

  els.quality = overlay.querySelector('#iw-set-quality');
  els.quality.addEventListener('change', () => setValue('quality', els.quality.value));

  els.difficulty = overlay.querySelector('#iw-set-difficulty');
  els.difficulty.addEventListener('change', () => setValue('difficulty', els.difficulty.value));

  // --- Wave J: accessibility controls -------------------------------------
  // Range helper mirrors the SLIDERS wiring but for keys living in their own
  // modal sections (kept out of SLIDERS so the top block stays untouched).
  const wireRange = (key) => {
    const input = overlay.querySelector(`[data-range="${key}"]`);
    const valueEl = overlay.querySelector(`[data-rval="${key}"]`);
    input.addEventListener('input', () => {
      setValue(key, parseFloat(input.value));
      valueEl.textContent = formatValue(key, G.settings[key]);
    });
    return { input, valueEl };
  };

  els.camShake = overlay.querySelector('#iw-set-camshake');
  els.camShake.addEventListener('change', () => setValue('camShakeScale', parseFloat(els.camShake.value)));

  els.reduceFlash = overlay.querySelector('#iw-set-flash');
  els.reduceFlash.addEventListener('change', () => setValue('reduceFlashing', els.reduceFlash.checked));

  els.uiScale = wireRange('uiScale');

  els.highContrast = overlay.querySelector('#iw-set-hc');
  els.highContrast.addEventListener('change', () => setValue('highContrastCues', els.highContrast.checked));

  els.aimAssist = wireRange('aimAssist');

  els.aimMode = overlay.querySelector('#iw-set-aimmode');
  els.aimMode.addEventListener('change', () => setValue('aimMode', els.aimMode.value));

  els.crouchMode = overlay.querySelector('#iw-set-crouchmode');
  els.crouchMode.addEventListener('change', () => setValue('crouchMode', els.crouchMode.value));

  // --- Wave J: rebind rows --------------------------------------------------
  els.controlRows = {};
  for (const [action] of CONTROL_ACTIONS) {
    const bindBtn = overlay.querySelector(`[data-bind="${action}"]`);
    const resetBtn = overlay.querySelector(`[data-reset="${action}"]`);
    bindBtn.addEventListener('click', () => {
      capturing = action; // next keydown is consumed by the capture listener
      refreshControlRows();
    });
    resetBtn.addEventListener('click', () => {
      Input.resetBinding(action);
      if (capturing === action) capturing = null;
      refreshControlRows();
      bus.emit('ui', { action: 'click' });
    });
    els.controlRows[action] = { bindBtn, resetBtn };
  }

  overlay.querySelector('#iw-set-resetkeys').addEventListener('click', () => {
    Input.resetBindings();
    if (capturing) capturing = null;
    refreshControlRows();
    bus.emit('ui', { action: 'click' });
  });

  overlay.querySelector('#iw-set-close').addEventListener('click', closeSettings);
  // Click on the dimmed backdrop (not the panel) also closes.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeSettings();
  });
}

function injectStyles() {
  if (document.getElementById('iw-settings-style')) return;
  const st = document.createElement('style');
  st.id = 'iw-settings-style';
  st.textContent = `
.iw-settings{position:fixed;inset:0;z-index:50;display:flex;align-items:center;
  justify-content:center;background:rgba(4,7,10,.72);
  font-family:'Segoe UI',system-ui,sans-serif;color:#dfe7ea;}
.iw-settings.hidden{display:none;}
.iw-settings-panel{background:rgba(10,14,18,.92);border:1px solid rgba(255,255,255,.15);
  padding:28px 36px;display:flex;flex-direction:column;align-items:center;gap:14px;
  min-width:440px;max-width:92vw;max-height:86vh;overflow-y:auto;}
.iw-set-row{display:grid;grid-template-columns:180px 1fr 64px;align-items:center;
  gap:14px;width:100%;font-size:12px;letter-spacing:.08em;}
.iw-set-label{color:rgba(223,231,234,.75);}
.iw-set-val{text-align:right;color:#59e3ff;font-weight:600;}
.iw-set-range{width:100%;accent-color:#59e3ff;cursor:pointer;}
.iw-set-row input[type="checkbox"]{justify-self:start;width:16px;height:16px;
  accent-color:#59e3ff;cursor:pointer;}
.iw-set-select{background:rgba(255,255,255,.06);border:1px solid rgba(89,227,255,.45);
  color:#dfe7ea;font-family:inherit;font-size:12px;padding:5px 8px;cursor:pointer;}
.iw-set-select option{background:#0a0e12;color:#dfe7ea;}
/* Wave J: section dividers + rebind rows. */
.iw-set-section{width:100%;margin-top:10px;padding-top:12px;
  border-top:1px solid rgba(255,255,255,.12);color:#59e3ff;font-size:11px;
  font-weight:700;letter-spacing:.14em;text-align:left;}
.iw-set-key{justify-self:start;background:rgba(255,255,255,.06);
  border:1px solid rgba(89,227,255,.45);color:#dfe7ea;font-family:inherit;
  font-size:12px;letter-spacing:.08em;padding:5px 10px;min-width:96px;cursor:pointer;}
.iw-set-key.listening{border-color:#ffd166;color:#ffd166;}
.iw-set-mini{background:none;border:none;color:rgba(223,231,234,.5);
  font-family:inherit;font-size:10px;letter-spacing:.08em;padding:0;
  text-align:right;cursor:pointer;}
.iw-set-mini:hover{color:#59e3ff;}
.iw-btnrow{display:flex;gap:12px;align-items:center;}
`;
  document.head.appendChild(st);
}
