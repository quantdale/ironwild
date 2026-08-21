// IRONWILD - unit tests for src/core/state.js (CONFIG tuning + G shape).
// Read-only invariant checks: no test mutates G, so no reset bookkeeping.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CONFIG, G } from '../../src/core/state.js';

describe('CONFIG tuning invariants', () => {
  it('world bounds are coherent', () => {
    expect(CONFIG.worldSize).toBe(600);
    expect(CONFIG.playRadius).toBe(270);
    expect(CONFIG.playRadius).toBeLessThan(CONFIG.worldSize / 2);
  });

  it('water level is a small positive height', () => {
    expect(CONFIG.waterLevel).toBeGreaterThan(0);
    expect(CONFIG.waterLevel).toBeLessThan(10);
  });

  it('gravity and seed are sane', () => {
    expect(CONFIG.gravity).toBeGreaterThan(0);
    expect(Number.isInteger(CONFIG.seed)).toBe(true);
    expect(CONFIG.seed).toBeGreaterThan(0);
  });

  it('movement tuning is ordered and positive', () => {
    expect(CONFIG.playerSpeedSprint).toBeGreaterThan(CONFIG.playerSpeedWalk);
    expect(CONFIG.playerSpeedWalk).toBeGreaterThan(0);
    expect(CONFIG.playerJumpVel).toBeGreaterThan(0);
    expect(CONFIG.dodgeSpeed).toBeGreaterThan(0);
    expect(CONFIG.dodgeDuration).toBeGreaterThan(0);
    expect(CONFIG.dodgeCost).toBeGreaterThan(0);
    expect(CONFIG.sprintCost).toBeGreaterThan(0);
  });

  it('focus scan tuning is a strict slowdown factor with positive duration', () => {
    expect(CONFIG.focusTimeScale).toBeGreaterThan(0);
    expect(CONFIG.focusTimeScale).toBeLessThan(1);
    expect(CONFIG.focusDuration).toBeGreaterThan(0);
  });

  it('bow tuning is coherent (min power speed below max, positive draw time)', () => {
    expect(CONFIG.arrowBaseDamage).toBeGreaterThan(0);
    expect(CONFIG.arrowMinPowerSpeed).toBeLessThan(CONFIG.arrowMaxPowerSpeed);
    expect(CONFIG.drawTimeFull).toBeGreaterThan(0);
  });

  it('machine cap is positive', () => {
    expect(CONFIG.maxMachines).toBeGreaterThan(0);
  });
});

describe('G frame-flow defaults', () => {
  it('starts unpaused, unstarted, not over, at full time scale', () => {
    expect(G.timeScale).toBe(1);
    expect(G.elapsed).toBe(0);
    expect(G.paused).toBe(false);
    expect(G.started).toBe(false);
    expect(G.gameOver).toBe(false);
  });

  it('three.js wiring slots start empty (filled by main.js)', () => {
    expect(G.scene).toBeNull();
    expect(G.camera).toBeNull();
    expect(G.renderer).toBeNull();
  });
});

describe('G camera basis', () => {
  it('holds unit forward/right vectors pointing down -Z / +X', () => {
    expect(G.cam.forward).toBeInstanceOf(THREE.Vector3);
    expect(G.cam.right).toBeInstanceOf(THREE.Vector3);
    expect(G.cam.forward.x).toBeCloseTo(0);
    expect(G.cam.forward.y).toBeCloseTo(0);
    expect(G.cam.forward.z).toBeCloseTo(-1);
    expect(G.cam.right.x).toBeCloseTo(1);
    expect(G.cam.right.y).toBeCloseTo(0);
    expect(G.cam.right.z).toBeCloseTo(0);
    expect(G.cam.forward.length()).toBeCloseTo(1, 6);
    expect(G.cam.right.length()).toBeCloseTo(1, 6);
  });

  it('forward and right are orthogonal', () => {
    expect(G.cam.forward.dot(G.cam.right)).toBeCloseTo(0, 6);
  });

  it('aim scratch vectors and flags default sensibly', () => {
    expect(G.cam.aimOrigin).toBeInstanceOf(THREE.Vector3);
    expect(G.cam.aimDir).toBeInstanceOf(THREE.Vector3);
    expect(G.cam.aiming).toBe(false);
    expect(typeof G.cam.yaw).toBe('number');
    expect(typeof G.cam.pitch).toBe('number');
  });
});

describe('G entities', () => {
  it('has no player and empty entity arrays at boot', () => {
    expect(G.player).toBeNull();
    expect(Array.isArray(G.machines)).toBe(true);
    expect(G.machines).toHaveLength(0);
    expect(Array.isArray(G.arrows)).toBe(true);
    expect(G.arrows).toHaveLength(0);
    expect(Array.isArray(G.pickups)).toBe(true);
    expect(G.pickups).toHaveLength(0);
  });
});

describe('G inventory + progression', () => {
  it('starting kit matches the documented loadout', () => {
    const inv = G.inventory;
    expect(inv.shards).toBe(0);
    expect(inv.wood).toBe(8);
    expect(inv.oil).toBe(0);
    expect(inv.medicine).toBe(2);
    expect(inv.arrows).toBe(20);
    expect(inv.maxArrows).toBe(60);
    expect(inv.fireArrows).toBe(0);
    expect(inv.maxFireArrows).toBe(20);
    expect(inv.skillPoints).toBe(1);
    expect(inv.hide).toBe(0);
    expect(inv.armor).toBe(0);
  });

  it('inventory counts never exceed their caps and are non-negative', () => {
    const inv = G.inventory;
    for (const key of Object.keys(inv)) {
      expect(typeof inv[key]).toBe('number');
      expect(inv[key]).toBeGreaterThanOrEqual(0);
    }
    expect(inv.arrows).toBeLessThanOrEqual(inv.maxArrows);
    expect(inv.fireArrows).toBeLessThanOrEqual(inv.maxFireArrows);
  });

  it('arrow type starts standard and only allows known values', () => {
    expect(G.arrowType).toBe('standard');
    expect(['standard', 'fire']).toContain(G.arrowType);
  });

  it('xp starts at level 1 with a positive next-level threshold', () => {
    expect(G.xp).toEqual({ level: 1, cur: 0, next: 100 });
    expect(G.xp.next).toBeGreaterThan(0);
  });

  it('all six skills exist and start at rank 0 or 1', () => {
    const expected = [
      'heartier', 'steadyAim', 'hunterKiller', 'scavenger', 'secondWind', 'deepFocus',
    ];
    expect(Object.keys(G.skills).sort()).toEqual([...expected].sort());
    for (const rank of Object.values(G.skills)) {
      expect(rank === 0 || rank === 1).toBe(true);
    }
  });
});

describe('G settings + world flags', () => {
  it('audio volumes live in [0,1]', () => {
    for (const key of ['master', 'music', 'sfx']) {
      expect(G.settings[key]).toBeGreaterThanOrEqual(0);
      expect(G.settings[key]).toBeLessThanOrEqual(1);
    }
  });

  it('input/display settings have sane types and values', () => {
    expect(G.settings.sens).toBeGreaterThan(0);
    expect(typeof G.settings.invertY).toBe('boolean');
    expect(['high', 'medium', 'low']).toContain(G.settings.quality);
    expect(['normal', 'hardened']).toContain(G.settings.difficulty);
    expect(typeof G.settings.colorblind).toBe('boolean');
  });

  it('combat/weather/quest state starts neutral', () => {
    expect(G.threat).toBe(0);
    expect(G.weather).toEqual({ type: 'clear', intensity: 0, wind: 0.3 });
    expect(G.mapRevealed).toBe(false);
    expect(G.bossNear).toBe(false);
    expect(G.bestiary).toEqual({});
    expect(G.quests.slots).toHaveLength(3);
    expect(G.quests.slots.every((s) => s === null)).toBe(true);
    expect(G.quests.completed).toBe(0);
  });
});
