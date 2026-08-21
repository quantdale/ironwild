// IRONWILD - settings modal (v2, extended in v4).
// Owns G.settings persistence (localStorage key 'ironwild-settings') and the
// modal UI: master/music/sfx volume sliders, mouse sensitivity, invert-Y
// checkbox, quality select, colorblind weak-point cue toggle, difficulty
// select. Every change writes G.settings, persists the whole object, and
// emits 'settingsChanged' {key,value}; consumers apply values live (audio
// gains in audio.js, renderer/shadow quality in main.js, weak-point markers
// in ui/focus.js, spawn damage/hp scaling in machines/ai.js). The gear
// buttons on the start/pause screens (built by ui/menus.js) call openSettings().

import { bus } from '../core/events.js';
import { G } from '../core/state.js';

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

let created = false;
let els = null;

/**
 * Merge saved settings over G.settings defaults. Called by main right after
 * renderer boot (before any UI exists). Unknown keys ignored, wrong-typed
 * values dropped, numbers clamped into their slider range.
 */
export function loadSettings() {
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
}

export function createSettings() {
  if (created) return;
  created = true;
  injectStyles();
  buildDom();
  syncControls();

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
}

function formatValue(key, v) {
  return key === 'sens' ? v.toFixed(2) : `${Math.round(v * 100)}%`;
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
      <button class="iw-btn iw-small" id="iw-set-close">CLOSE</button>
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
  min-width:440px;max-width:92vw;}
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
`;
  document.head.appendChild(st);
}
