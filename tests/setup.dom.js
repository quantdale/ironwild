// Minimal browser-surface stubs so modules that touch window/localStorage at
// import time can load under vitest's node environment. Only what the tested
// modules actually reference - no DOM emulation, no canvas.
const listeners = [];

globalThis.window = {
  addEventListener: (type, fn) => listeners.push({ type, fn }),
  removeEventListener: (type, fn) => {
    const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
    if (i >= 0) listeners.splice(i, 1);
  },
  devicePixelRatio: 1,
};

// Minimal Set-backed classList: enough for ui/a11y.js to toggle its body
// classes ('iw-high-contrast', 'iw-reduce-flashing') and for tests to observe
// which classes it drives. Still no DOM emulation - just the one surface the
// preference applier needs.
function makeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c);
      else set.delete(c);
      return on;
    },
    contains: (c) => set.has(c),
  };
}

globalThis.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  hidden: false,
  // ui/a11y.js writes --iw-ui-scale on <html> before toggling body classes;
  // without a documentElement.style the try/catch would swallow the whole
  // apply() and the body-class assertions could never observe a toggle.
  documentElement: { style: { setProperty: () => {} } },
  body: { classList: makeClassList() },
};

// In-memory localStorage: same API surface the save/settings code uses.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};
