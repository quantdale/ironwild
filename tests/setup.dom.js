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

globalThis.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  hidden: false,
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
