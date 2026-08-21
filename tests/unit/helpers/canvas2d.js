// Shared test double for the canvas surface that combat FX modules touch
// (damage numbers, burn tick numbers, smoke/splat textures). The vitest
// setup file deliberately provides no DOM, so we swap document.createElement
// for one that hands out inert canvas objects with a recording 2d context.

/**
 * 2d context stub implementing exactly the methods the FX code calls.
 * fillText calls are recorded so tests can assert what was drawn.
 */
export function createRecordingCtx() {
  const fillTexts = [];
  const ctx = {
    canvas: null,
    font: '',
    textAlign: '',
    textBaseline: '',
    lineJoin: '',
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: '',
    clearRect() {},
    fillRect() {},
    strokeText() {},
    fillText(text) {
      fillTexts.push(String(text));
    },
    beginPath() {},
    arc() {},
    fill() {},
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  ctx.fillTexts = fillTexts;
  return ctx;
}

/**
 * Replace document.createElement with a canvas-aware fake.
 * Returns a restore function.
 */
export function installCanvasStub() {
  const orig = document.createElement;
  document.createElement = (tag) => {
    if (tag === 'canvas') {
      const ctx = createRecordingCtx();
      return {
        width: 0,
        height: 0,
        getContext: () => ctx,
      };
    }
    return typeof orig === 'function' ? orig.call(document, tag) : undefined;
  };
  return () => {
    document.createElement = orig;
  };
}
