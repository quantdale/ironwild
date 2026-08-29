// Deterministic contracts for the bounded expedition layer.
import { describe, expect, it } from 'vitest';
import {
  EXPEDITION_MAX_ACTIVE,
  EXPEDITION_TYPES,
  anchorFor,
  createExpeditionState,
  eventDistance,
  getExpeditionTuning,
  interactionForType,
  normalizeExpeditionState,
  rewardForType,
} from '../../src/systems/expedition.js';

describe('expedition state normalization', () => {
  it('creates one inactive event slot with a delayed first dispatch', () => {
    expect(createExpeditionState()).toEqual({
      active: null,
      completed: 0,
      nextId: 1,
      cooldown: 8,
    });
  });

  it('drops malformed active records and clamps scheduler counters', () => {
    expect(normalizeExpeditionState({
      completed: -10,
      nextId: 0,
      cooldown: 999,
      active: { type: 'not-real', x: 0, z: 0 },
    })).toEqual({
      active: null,
      completed: 0,
      nextId: 1,
      cooldown: 14,
    });
  });

  it('accepts a valid event but strips unsafe fields and repairs its id', () => {
    const state = normalizeExpeditionState({
      completed: 4.9,
      nextId: 2,
      cooldown: 4,
      active: {
        id: 12.8,
        type: 'survey',
        x: 12,
        z: -20,
        label: 'A'.repeat(100),
        radius: 99,
        maxTime: 200,
        timeLeft: 250,
        mesh: { injected: true },
      },
    });
    expect(state.completed).toBe(4);
    expect(state.nextId).toBe(13);
    expect(state.cooldown).toBe(4);
    expect(state.active).toEqual({
      id: 12,
      type: 'survey',
      x: 12,
      z: -20,
      label: 'A'.repeat(40),
      radius: 8,
      maxTime: 150,
      timeLeft: 150,
      progress: 0,
    });
  });

  it('rejects non-finite and out-of-world coordinates', () => {
    expect(normalizeExpeditionState({ active: { type: 'signal', x: NaN, z: 0 } }).active).toBeNull();
    expect(normalizeExpeditionState({ active: { type: 'signal', x: 999, z: 0 } }).active).toBeNull();
  });
});

describe('expedition tuning', () => {
  it('has one active event and deterministic anchors inside the play radius', () => {
    const tuning = getExpeditionTuning();
    expect(EXPEDITION_MAX_ACTIVE).toBe(1);
    expect(tuning.maxActive).toBe(1);
    expect(tuning.anchors.length).toBeGreaterThan(3);
    for (let i = 0; i < 12; i++) {
      const a = anchorFor(i, i + 1);
      expect(Number.isFinite(a.x)).toBe(true);
      expect(Number.isFinite(a.z)).toBe(true);
    }
    expect(anchorFor(5, 8)).toEqual(anchorFor(5, 8));
    expect(EXPEDITION_TYPES).toContain('salvage');
    expect(EXPEDITION_TYPES).toContain('survey');
    expect(EXPEDITION_TYPES).toContain('signal');
  });

  it('defines distinct interaction contracts for each event type', () => {
    expect(interactionForType('salvage')).toEqual({ action: 'interact', hold: 0, label: '[E] SECURE SITE' });
    expect(interactionForType('survey')).toEqual({ action: 'interact', hold: 2.5, label: '[HOLD E] SURVEY SITE' });
    expect(interactionForType('signal')).toEqual({ action: 'focus', hold: 3.5, label: '[HOLD Q] RELIGHT RELAY' });
    expect(interactionForType('unknown')).toBeNull();
  });
  it('exposes copies of bounded rewards', () => {
    const reward = rewardForType('salvage');
    expect(reward).toEqual({ shards: 12, oil: 2, xp: 35 });
    reward.shards = 999999;
    expect(rewardForType('salvage').shards).toBe(12);
    expect(rewardForType('unknown')).toBeNull();
  });

  it('calculates planar distance without allocating a vector', () => {
    expect(eventDistance({ x: 3, z: 4 }, { x: 0, z: 0 })).toBe(25);
    expect(eventDistance(null, { x: 0, z: 0 })).toBe(Infinity);
  });
});
