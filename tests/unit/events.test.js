// IRONWILD - unit tests for src/core/events.js (synchronous pub/sub bus).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { bus } from '../../src/core/events.js';

// Every subscription made through this helper is unwound after each test so
// the module-level listener Map never leaks between tests.
const registry = [];
function sub(type, fn) {
  const unsub = bus.on(type, fn);
  registry.push([type, fn]);
  return unsub;
}
afterEach(() => {
  while (registry.length) {
    const [type, fn] = registry.pop();
    bus.off(type, fn);
  }
});

describe('bus.on / bus.emit basics', () => {
  it('delivers the payload by reference to every listener', () => {
    const seen = [];
    sub('t1', (p) => seen.push(p));
    sub('t1', (p) => seen.push(p));
    const payload = { n: 42 };
    bus.emit('t1', payload);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(payload);
    expect(seen[1]).toBe(payload);
  });

  it('supports undefined payloads', () => {
    let calls = 0;
    let arg = 'sentinel';
    sub('t-undef', (p) => {
      calls++;
      arg = p;
    });
    bus.emit('t-undef');
    expect(calls).toBe(1);
    expect(arg).toBeUndefined();
  });

  it('calls listeners in insertion order', () => {
    const order = [];
    sub('t-order', () => order.push('a'));
    sub('t-order', () => order.push('b'));
    sub('t-order', () => order.push('c'));
    bus.emit('t-order');
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('emit with no listeners for the type is a no-op', () => {
    expect(() => bus.emit('nobody-listens', { x: 1 })).not.toThrow();
  });

  it('on returns an unsubscribe function that removes the listener', () => {
    const off = sub('t-unsub', () => {
      throw new Error('should not fire after unsubscribe');
    });
    off();
    expect(() => bus.emit('t-unsub')).not.toThrow();
  });

  it('unsubscribe function is safe to call twice', () => {
    let calls = 0;
    const off = sub('t-unsub2', () => calls++);
    off();
    expect(() => off()).not.toThrow();
    bus.emit('t-unsub2');
    expect(calls).toBe(0);
  });
});

describe('duplicate subscriptions', () => {
  it('dedupe identical fn references via Set semantics (called once)', () => {
    let calls = 0;
    const fn = () => calls++;
    const off1 = sub('t-dup', fn);
    const off2 = sub('t-dup', fn); // same reference -> stored once
    bus.emit('t-dup');
    expect(calls).toBe(1);
    // Either unsubscribe removes the single registration.
    off1();
    bus.emit('t-dup');
    expect(calls).toBe(1);
    expect(() => off2()).not.toThrow();
  });

  it('distinct fn references are both kept even if behaviorally equal', () => {
    let calls = 0;
    sub('t-dup2', () => calls++);
    sub('t-dup2', () => calls++);
    bus.emit('t-dup2');
    expect(calls).toBe(2);
  });
});

describe('bus.off', () => {
  it('removes only the given fn for the given type', () => {
    let aCalls = 0;
    let bCalls = 0;
    const a = () => aCalls++;
    const b = () => bCalls++;
    sub('t-off', a);
    sub('t-off', b);
    bus.off('t-off', a);
    bus.emit('t-off');
    expect(aCalls).toBe(0);
    expect(bCalls).toBe(1);
  });

  it('is safe for unknown types and unknown fns', () => {
    expect(() => bus.off('never-registered', () => {})).not.toThrow();
    expect(() => bus.off('t-off2', () => {})).not.toThrow(); // type exists pattern-free
  });
});

describe('mutation during emit', () => {
  it('a listener may unsubscribe itself mid-emit; later emits skip it', () => {
    let selfCalls = 0;
    let otherCalls = 0;
    const offSelf = sub('t-self', () => {
      selfCalls++;
      offSelf();
    });
    sub('t-self', () => otherCalls++);
    expect(() => bus.emit('t-self')).not.toThrow();
    // Snapshot iteration: the self-removing listener still completes its
    // call for THIS emit (current behavior), and later listeners run.
    expect(selfCalls).toBe(1);
    expect(otherCalls).toBe(1);
    bus.emit('t-self');
    expect(selfCalls).toBe(1); // gone after its one call
    expect(otherCalls).toBe(2);
  });

  it('a listener removed by an earlier listener still fires for the current emit (snapshot semantics), then stays removed', () => {
    let victimCalls = 0;
    const victim = () => victimCalls++;
    const remover = () => bus.off('t-snap', victim);
    sub('t-snap', remover);
    sub('t-snap', victim);
    expect(() => bus.emit('t-snap')).not.toThrow();
    expect(victimCalls).toBe(1); // current behavior: snapshot already taken
    bus.emit('t-snap');
    expect(victimCalls).toBe(1); // removed for subsequent emits
  });
});

describe('listener error isolation', () => {
  it('one throwing listener does not prevent later listeners from running', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let okCalls = 0;
      sub('t-err', () => {
        throw new Error('boom');
      });
      sub('t-err', () => okCalls++);
      expect(() => bus.emit('t-err', { k: 1 })).not.toThrow();
      expect(okCalls).toBe(1);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(String(errSpy.mock.calls[0][0])).toContain('t-err');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('every throwing listener is isolated independently (multiple bad listeners)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let good = 0;
      sub('t-err2', () => {
        throw new Error('e1');
      });
      sub('t-err2', () => good++);
      sub('t-err2', () => {
        throw new Error('e2');
      });
      expect(() => bus.emit('t-err2')).not.toThrow();
      expect(good).toBe(1);
      expect(errSpy).toHaveBeenCalledTimes(2);
    } finally {
      errSpy.mockRestore();
    }
  });
});
