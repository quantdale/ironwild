// IRONWILD - unit coverage for the accessibility preference applier
// (src/ui/a11y.js) and the persistence round-trip of the preference it applies.
// Contract under test (openspec honor-accessibility-preferences):
//   - apply() drives the 'iw-reduce-flashing' body class from
//     G.settings.reduceFlashing, alongside the existing 'iw-high-contrast'
//   - the class updates live on 'settingsChanged' (WATCHED_KEYS path)
//   - window.__IW_A11Y.reduceFlashing always mirrors the setting
//   - the preference defaults to OFF and round-trips through localStorage
//     under the unchanged 'ironwild-settings' shape
// tests/setup.dom.js supplies the minimal body.classList stub this needs.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const SETTINGS_KEY = 'ironwild-settings';

async function loadA11yStack() {
  vi.resetModules();
  const [a11y, state, events] = await Promise.all([
    import('../../src/ui/a11y.js'),
    import('../../src/core/state.js'),
    import('../../src/core/events.js'),
  ]);
  return { ...a11y, G: state.G, bus: events.bus };
}

describe('a11y apply(): reduceFlashing -> body class + published state', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    delete window.__IW_A11Y;
    document.body.classList.remove('iw-reduce-flashing');
    document.body.classList.remove('iw-high-contrast');
  });

  it('toggles iw-reduce-flashing on the body for the preference value', async () => {
    const { createA11y, G, bus } = await loadA11yStack();
    G.settings.reduceFlashing = true;
    createA11y();
    expect(document.body.classList.contains('iw-reduce-flashing')).toBe(true);

    G.settings.reduceFlashing = false;
    bus.emit('settingsChanged', { key: 'reduceFlashing', value: false });
    expect(document.body.classList.contains('iw-reduce-flashing')).toBe(false);
  });

  it('applies the class live on settingsChanged without reinstalling', async () => {
    const { createA11y, G, bus } = await loadA11yStack();
    G.settings.reduceFlashing = true;
    createA11y();
    expect(document.body.classList.contains('iw-reduce-flashing')).toBe(true);

    G.settings.reduceFlashing = false;
    bus.emit('settingsChanged', { key: 'reduceFlashing', value: false });
    expect(document.body.classList.contains('iw-reduce-flashing')).toBe(false);

    G.settings.reduceFlashing = true;
    bus.emit('settingsChanged', { key: 'reduceFlashing', value: true });
    expect(document.body.classList.contains('iw-reduce-flashing')).toBe(true);
  });

  it('publishes window.__IW_A11Y.reduceFlashing matching the setting', async () => {
    const { createA11y, G, bus, getA11y } = await loadA11yStack();
    G.settings.reduceFlashing = true;
    createA11y();
    expect(window.__IW_A11Y.reduceFlashing).toBe(true);
    expect(getA11y().reduceFlashing).toBe(true);

    G.settings.reduceFlashing = false;
    bus.emit('settingsChanged', { key: 'reduceFlashing', value: false });
    expect(window.__IW_A11Y.reduceFlashing).toBe(false);
    expect(getA11y().reduceFlashing).toBe(false);
  });

  it('keeps the shipped default OFF: no setting -> no class, published false', async () => {
    const { createA11y, G } = await loadA11yStack();
    delete G.settings.reduceFlashing;
    createA11y();
    expect(document.body.classList.contains('iw-reduce-flashing')).toBe(false);
    expect(window.__IW_A11Y.reduceFlashing).toBe(false);
  });

  it('leaves the existing iw-high-contrast class behavior intact', async () => {
    const { createA11y, G } = await loadA11yStack();
    G.settings.highContrastCues = true;
    G.settings.reduceFlashing = false;
    createA11y();
    expect(document.body.classList.contains('iw-high-contrast')).toBe(true);
    expect(document.body.classList.contains('iw-reduce-flashing')).toBe(false);
  });

  it('degrades in a DOM-less context without throwing (state stays in getA11y)', async () => {
    const { createA11y, G, getA11y } = await loadA11yStack();
    const origDoc = globalThis.document;
    globalThis.document = {}; // no documentElement/body at all
    try {
      G.settings.reduceFlashing = true;
      expect(() => createA11y()).not.toThrow();
      // Existing failure contract: apply()'s try/catch keeps state in the
      // module snapshot when the DOM publish is impossible.
      expect(getA11y().reduceFlashing).toBe(true);
    } finally {
      globalThis.document = origDoc;
    }
  });
});

describe('reduceFlashing persistence round-trip (ironwild-settings)', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('loadSettings() restores the boolean from a saved object', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ reduceFlashing: true }));
    const { loadSettings } = await import('../../src/ui/settings.js');
    const { G } = await import('../../src/core/state.js');
    loadSettings();
    expect(G.settings.reduceFlashing).toBe(true);
  });

  it('fills the OFF default for fresh boots and pre-J saves', async () => {
    const { loadSettings } = await import('../../src/ui/settings.js');
    const { G } = await import('../../src/core/state.js');
    loadSettings(); // nothing saved at all
    expect(G.settings.reduceFlashing).toBe(false);

    vi.resetModules();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ sens: 1.2 })); // pre-J save
    const { loadSettings: reload } = await import('../../src/ui/settings.js');
    const { G: G2 } = await import('../../src/core/state.js');
    reload();
    expect(G2.settings.reduceFlashing).toBe(false);
    expect(G2.settings.sens).toBe(1.2);
  });

  it('keeps the persisted shape schema-free: the key rides the whole G.settings object', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ reduceFlashing: true }));
    const { loadSettings } = await import('../../src/ui/settings.js');
    const { G } = await import('../../src/core/state.js');
    loadSettings();
    // ui/settings.js persist() writes JSON.stringify(G.settings) verbatim -
    // round-tripping must not need a schema change for this key.
    const roundTripped = JSON.parse(JSON.stringify(G.settings));
    expect(roundTripped.reduceFlashing).toBe(true);
  });
});
