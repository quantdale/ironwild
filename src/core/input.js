// IRONWILD - keyboard + mouse input.
// Frame-scoped: main.js calls Input.beginFrame() once per frame BEFORE systems read it.

class InputManager {
  constructor() {
    this.keys = new Set();        // currently held KeyboardEvent.code values
    this.pressedSet = new Set();  // keys pressed since the last endFrame()
    this.mouseDX = 0;             // accumulated mouse movement since last consumeMouse()
    this.mouseDY = 0;
    this.wheelDelta = 0;
    this.locked = false;          // pointer lock active
    this.lockBroken = false;      // browser denied lock repeatedly -> fallback look
    this._element = null;
    this._onLockChange = null;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      // Don't swallow browser shortcuts for dev tools etc. - but let the
      // modifier keys themselves through: a Control keydown reports its own
      // ctrlKey=true, and ControlLeft is the dodge binding.
      const selfMod = /^(Control|Meta|Alt)(Left|Right)$/.test(e.code);
      if ((e.ctrlKey || e.metaKey || e.altKey) && !selfMod) return;
      this.keys.add(e.code);
      this.pressedSet.add(e.code);
      if (['Space', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); });

    // Track pointer-lock failures: after 2 rejections we stop demanding lock
    // and fall back to free-cursor look (kiosks / denied-permission browsers).
    let lockFails = 0;
    document.addEventListener('pointerlockerror', () => {
      if (++lockFails >= 2) this.lockBroken = true;
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    });
    window.addEventListener('wheel', (e) => { this.wheelDelta += e.deltaY; }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this._element;
      if (this.locked) {
        lockFails = 0;           // a real lock clears the failure streak...
        this.lockBroken = false; // ...so transient errors can't degrade the session
      } else {
        this.keys.clear();
      }
      if (this._onLockChange) this._onLockChange(this.locked);
    });
  }

  /** True while the key is held. */
  down(code) { return this.keys.has(code); }

  /** True only on the frame the key went down (consumed at endFrame). */
  pressed(code) { return this.pressedSet.has(code); }

  /** Read and clear accumulated mouse movement. Returns {dx, dy}. */
  consumeMouse() {
    const out = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0; this.mouseDY = 0;
    return out;
  }

  /** Read and clear accumulated wheel motion. Returns deltaY. */
  consumeWheel() {
    const d = this.wheelDelta;
    this.wheelDelta = 0;
    return d;
  }

  lockPointer(element) {
    this._element = element;
    if (document.pointerLockElement !== element) {
      element.requestPointerLock?.();
    }
  }

  unlockPointer() {
    if (document.pointerLockElement) document.exitPointerLock?.();
  }

  onLockChange(fn) { this._onLockChange = fn; }

  /**
   * Called at the START of each frame. Keydown events arrive between frames,
   * so pressedSet must NOT be cleared here — systems read it after this point.
   */
  beginFrame() {}

  /** Called at the END of each frame, after all systems have polled pressed(). */
  endFrame() {
    this.pressedSet.clear();
    this.wheelDelta = 0;
  }
}

export const Input = new InputManager();
