// IRONWILD - global game state + tuning constants.
// One mutable singleton shared by all systems. Systems read/write G.* directly;
// anything cross-module lives here. Per-module internals stay in their own files.

import * as THREE from 'three';

export const CONFIG = {
  worldSize: 600,        // full terrain extent in world units (square)
  playRadius: 270,       // soft playable radius; mountains ring beyond this
  waterLevel: 1.6,       // y of the lake surface
  gravity: 24,
  seed: 1337,            // deterministic terrain/prop placement
  maxMachines: 14,
  playerSpeedWalk: 6.0,
  playerSpeedSprint: 10.5,
  playerJumpVel: 9.0,
  dodgeSpeed: 14,
  dodgeDuration: 0.38,
  dodgeCost: 25,         // stamina
  sprintCost: 12,        // stamina per second
  focusDuration: 6.0,    // seconds of scan mode per full meter
  focusTimeScale: 0.35,  // world time multiplier while scanning
  arrowBaseDamage: 22,
  arrowMaxPowerSpeed: 62, // m/s at full draw
  arrowMinPowerSpeed: 24,
  drawTimeFull: 0.85,     // seconds to full draw
};

/**
 * Global state. Filled in by main.js at boot:
 *   G.scene / G.camera / G.renderer / G.canvas
 * Player object contract (created by src/player/player.js):
 *   { group, pos (feet), vel, yaw, hp, maxHp, stamina, maxStamina,
 *     grounded, dodging, sprinting, aiming, dead,
 *     takeDamage(amount, fromPos?), heal(amount) }
 * Machine object contract (created by src/machines/machines.js):
 *   { group, type, name, hp, maxHp, alive, aggro, weakPoints:[{name, mesh, localPos,
 *     radius, multiplier, hp, broken}], bodySpheres:[{localPos, radius}],
 *     hit(damage, point, weakPoint|null), update(dt), dispose() }
 */
export const G = {
  // three.js core (set by main.js)
  scene: null,
  camera: null,
  renderer: null,

  // frame flow
  timeScale: 1,          // focus scan lowers this; ALL gameplay dt must multiply by it
  elapsed: 0,            // scaled gameplay time (seconds)
  paused: false,         // menus open / tab hidden
  started: false,        // start screen dismissed
  gameOver: false,

  // camera basis, refreshed every frame by src/player/camera.js BEFORE player update
  cam: {
    yaw: 0,
    pitch: 0.18,
    forward: new THREE.Vector3(0, 0, -1),
    right: new THREE.Vector3(1, 0, 0),
    aimOrigin: new THREE.Vector3(), // eye position for aiming
    aimDir: new THREE.Vector3(0, 0, -1),
    aiming: false,
  },

  // entities
  player: null,
  machines: [],
  arrows: [],            // live projectile records owned by combat/projectiles.js
  pickups: [],           // { type:'wood'|'shards'|'medicine', mesh, pos, taken }

  // progression
  inventory: {
    shards: 0,           // metal shards - currency/ammo crafting
    wood: 8,             // branches - arrow shafts
    oil: 0,              // machine oil - medicine + fire arrows
    medicine: 2,         // heals 45 hp, key H
    arrows: 20,
    maxArrows: 60,
    fireArrows: 0,       // v2: ignite on hit (burn damage over time)
    maxFireArrows: 20,
    skillPoints: 1,
    hide: 0,             // v4: carcass-harvest resource, spent on armor tiers
    armor: 0,            // v4: 0..2 hide-armor rank (player/player.js damage reduction)
  },
  arrowType: 'standard', // 'standard' | 'fire' (toggled with KeyX in bow)

  // ---- v3 additions -----------------------------------------------------
  xp: { level: 1, cur: 0, next: 100 }, // systems/xp.js owns; kills/gathers grant XP
  bossNear: false,                     // true while the Monarch is within 80u (music layer reads this)

  // ---- v4 additions -------------------------------------------------------
  bestiary: {},          // systems/bestiary.js owns; type -> {seen, killed}

  skills: {
    // id -> rank (0 or 1). Owned by ui/menus.js definitions.
    heartier: 0,         // +30 max hp
    steadyAim: 0,        // -35% sway, faster full draw
    hunterKiller: 0,     // +30% weak-point damage
    scavenger: 0,        // double resource drops
    secondWind: 0,       // dodge costs half stamina
    deepFocus: 0,        // +50% focus duration
  },

  // ---- v2 additions -----------------------------------------------------
  settings: {            // mirrored to localStorage by ui/settings.js
    master: 0.8, music: 0.6, sfx: 0.9,
    sens: 1.0, invertY: false,
    quality: 'high',     // 'high' | 'medium' | 'low'
    difficulty: 'normal', // v4: 'normal' | 'hardened' (machines/ai.js finishSpawn)
    colorblind: false,   // v4: adds a shape-based weak-point cue independent of glow color
  },
  threat: 0,             // 0..1 combat intensity, written by machines/ai.js each frame
  weather: { type: 'clear', intensity: 0, wind: 0.3 }, // written by world/weather.js
  mapRevealed: false,    // true after scanning a Vantage (minimap fog lifts)
  quests: { slots: [null, null, null], completed: 0 }, // owned by systems/quests.js
  expedition: { active: null, completed: 0, nextId: 1, cooldown: 8 }, // systems/expedition.js
};
