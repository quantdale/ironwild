// IRONWILD - player avatar: procedural hunter body, third-person movement,
// stamina, dodge roll, crouch/sneak, swimming, fall damage, damage/health.
// Creates and owns G.player (contract in state.js). Limb pivots are kept in
// closures for the procedural animator.

import * as THREE from 'three';
import { bus } from '../core/events.js';
import { G, CONFIG } from '../core/state.js';
import { Input } from '../core/input.js';
import { clamp, damp, smoothstep } from '../core/utils.js';
import { heightAt } from '../world/terrain.js';
// Namespace import on purpose: world-v2 adds isConcealed(x, z) in parallel, so
// every use is guarded with a typeof check (falls back to "not concealed").
import * as propsNs from '../world/props.js';

const TWO_PI = Math.PI * 2;
const STAMINA_REGEN = 18;      // per second after delay
const STAMINA_DELAY = 0.8;     // seconds without spend before regen
const BASE_MAX_HP = 100;
const HEARTIER_HP = 30;        // G.skills.heartier bonus
const MEDICINE_HEAL = 45;      // KeyH consumable
const FLASH_TIME = 0.25;       // hit-flash duration
const ARMOR_REDUCTION = [0, 0.12, 0.22]; // v4: G.inventory.armor rank -> incoming dmg cut

// v2: crouch / sneak (KeyC toggle; dodge moved to ControlLeft only).
const CROUCH_SPEED_MULT = 0.5;
const CROUCH_NOISE_RADIUS = 3;   // tiny sneaking footstep noise
const CROUCH_NOISE_EVERY = 0.55; // s between sneak noise pings

// v2: swimming. Deep water = feet below surface by SWIM_ENTER_DEPTH; exit is
// shallower for hysteresis so the surface boundary does not flicker.
const SWIM_ENTER_DEPTH = 0.4;
const SWIM_EXIT_DEPTH = 0.15;
const SWIM_RISE_SPEED = 3.2;     // Space swim-up speed
const SWIM_SINK_SPEED = -1.1;    // gentle sink otherwise
const SWIM_DRIFT_MULT = 0.35;    // horizontal speed multiplier while swimming
const SWIM_STAMINA_DRAIN = 8;    // per second
const SWIM_DROWN_DPS = 5;        // hp/s once stamina is gone
const DROWN_HP_FLOOR_FRAC = 0.1; // drown-safe: hp never drops below this fraction

// v2: fall damage + landing recovery.
const FALL_DAMAGE_MIN_VY = 18;   // damaging landings start below this |vel.y|
const FALL_DAMAGE_SCALE = 3;     // hp per unit of vy past the threshold
const LAND_DIP_MIN_VY = 6;       // any landing harder than this dips the pose

// Scratch vectors - reused every frame, never reallocated in hot loops.
const _wish = new THREE.Vector3();
const _push = new THREE.Vector3();

/**
 * v7: inject a view-based fresnel rim light into a standard material. Adds a
 * sky-coloured glow along silhouette edges (where the surface faces away from
 * the camera), so a back-lit hunter still reads as a lit form instead of a
 * flat black cut-out. Cheap: one dot + pow in the fragment stage.
 */
function addRimLight(mat, colorHex, strength) {
  const rimColor = new THREE.Color(colorHex);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: rimColor };
    shader.uniforms.uRimStrength = { value: strength };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform vec3 uRimColor;\nuniform float uRimStrength;',
      )
      .replace(
        '#include <opaque_fragment>', // r154+ name (was output_fragment)
        [
          'float rimF = 1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);',
          'rimF = pow(rimF, 2.6);',
          'outgoingLight += uRimColor * rimF * uRimStrength;',
          '#include <opaque_fragment>',
        ].join('\n'),
      );
  };
}

/** Frame-rate independent damp across the shortest arc between angles. */
function dampAngle(cur, target, lambda, dt) {
  const d = ((target - cur + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
  return cur + d * (1 - Math.exp(-lambda * dt));
}

export function createPlayer() {
  // ------------------------------------------------------------- materials
  // v7: Standard (not Lambert) so leather/cloth pick up a little spec + a
  // sky-coloured fresnel rim light injected below - the rim keeps the hunter
  // reading as a lit form (not a black silhouette) when back-lit by the sun,
  // the single biggest lift for a third-person hero. Colours nudged a touch
  // warmer/lighter for the same reason.
  const matLeatherDark = new THREE.MeshStandardMaterial({ color: 0x7d573a, roughness: 0.78, metalness: 0.02, flatShading: true });
  const matLeatherLight = new THREE.MeshStandardMaterial({ color: 0xa07a50, roughness: 0.72, metalness: 0.02, flatShading: true });
  const matCloth = new THREE.MeshStandardMaterial({ color: 0x5b8a7b, roughness: 0.9, metalness: 0.0, flatShading: true });
  const matSkin = new THREE.MeshStandardMaterial({ color: 0xd0a37c, roughness: 0.6, metalness: 0.0, flatShading: true });
  const matGlow = new THREE.MeshStandardMaterial({
    color: 0x59e3ff, emissive: 0x59e3ff, emissiveIntensity: 0.9, flatShading: true,
  });
  const flashMats = [matLeatherDark, matLeatherLight, matCloth, matSkin]; // pulsed red on hit
  // Sky-coloured fresnel rim on every body material (not the glow device).
  for (const m of flashMats) addRimLight(m, 0xa6cdf0, 0.5);

  // ------------------------------------------------------------ build helpers
  const part = (parent, geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };

  // Shared limb geometries (left/right reuse the same buffers).
  const gThigh = new THREE.BoxGeometry(0.15, 0.44, 0.17);
  const gShin = new THREE.BoxGeometry(0.125, 0.40, 0.145);
  const gBoot = new THREE.BoxGeometry(0.14, 0.11, 0.26);
  const gUpperArm = new THREE.BoxGeometry(0.11, 0.40, 0.12);
  const gForearm = new THREE.BoxGeometry(0.095, 0.34, 0.105);
  const gHand = new THREE.BoxGeometry(0.09, 0.11, 0.10);

  // -------------------------------------------------------------- hierarchy
  const group = new THREE.Group(); // root: origin at feet, rotation.y = facing yaw
  const body = new THREE.Group();  // carries lean / dodge tumble / death collapse
  group.add(body);

  const HIP_Y = 0.96;

  // Pelvis + cloth skirt flap
  part(body, new THREE.BoxGeometry(0.36, 0.20, 0.24), matLeatherDark, 0, 1.00, 0);
  part(body, new THREE.BoxGeometry(0.30, 0.24, 0.05), matCloth, 0, 0.84, 0.13);

  // Legs (pivot groups at the hips)
  const makeLeg = (side) => {
    const leg = new THREE.Group();
    leg.position.set(0.13 * side, HIP_Y, 0);
    part(leg, gThigh, matLeatherDark, 0, -0.24, 0);
    part(leg, gShin, matLeatherLight, 0, -0.62, 0);
    part(leg, gBoot, matLeatherDark, 0, -0.88, -0.03);
    body.add(leg);
    return leg;
  };
  const legL = makeLeg(-1);
  const legR = makeLeg(1);

  // Torso
  const torso = new THREE.Group();
  torso.position.set(0, 1.06, 0);
  body.add(torso);
  part(torso, new THREE.BoxGeometry(0.44, 0.52, 0.26), matLeatherLight, 0, 0.28, 0);
  part(torso, new THREE.BoxGeometry(0.46, 0.10, 0.28), matLeatherDark, 0, 0.02, 0); // belt
  part(torso, new THREE.BoxGeometry(0.08, 0.50, 0.04), matLeatherDark, 0.10, 0.28, 0.14); // strap

  // Head + hood + focus device glow
  const head = new THREE.Group();
  head.position.set(0, 0.60, 0);
  torso.add(head);
  part(head, new THREE.BoxGeometry(0.22, 0.24, 0.22), matSkin, 0, 0.10, 0);
  const hood = new THREE.Mesh(new THREE.ConeGeometry(0.21, 0.40, 6), matCloth);
  hood.position.set(0, 0.26, -0.03);
  hood.rotation.x = -0.12;
  head.add(hood);
  part(head, new THREE.BoxGeometry(0.26, 0.05, 0.12), matCloth, 0, 0.17, 0.10); // brim
  part(head, new THREE.BoxGeometry(0.05, 0.05, 0.025), matGlow, 0.115, 0.12, 0.07); // focus device

  // Arms (pivot groups at the shoulders). Each ends in a hand group placed
  // exactly at the grip point: 'handL' is REQUIRED - the bow module attaches
  // there via getObjectByName('handL').
  const makeArm = (side, handName) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(0.29 * side, 0.48, 0);
    shoulder.rotation.z = 0.10 * side; // slight outward splay
    part(shoulder, gUpperArm, matLeatherLight, 0, -0.20, 0);
    part(shoulder, gForearm, matSkin, 0, -0.55, 0);
    part(shoulder, gHand, matSkin, 0, -0.78, 0);
    const hand = new THREE.Group();
    hand.name = handName;
    hand.position.set(0, -0.84, 0); // grip point, world y ~0.70 with arms down
    shoulder.add(hand);
    torso.add(shoulder);
    return shoulder;
  };
  const armL = makeArm(-1, 'handL');
  const armR = makeArm(1, 'handR');

  // Pose indirection: the per-frame pose code drives whatever groups these
  // names currently resolve to inside `body`. hunterView swaps in the
  // authored rig (same node names, same pivot transforms) and then calls
  // rebindPoseRefs() - the animation code below never changes.
  const pose = { torso, head, armL, armR, legL, legR };

  // Back quiver with a few arrow sticks
  const quiver = new THREE.Group();
  quiver.position.set(0.07, 1.30, -0.20);
  quiver.rotation.set(0.35, 0, -0.15);
  body.add(quiver);
  part(quiver, new THREE.CylinderGeometry(0.07, 0.09, 0.42, 6), matLeatherDark, 0, 0, 0);
  const gArrow = new THREE.CylinderGeometry(0.018, 0.018, 0.46, 5);
  const gFletch = new THREE.BoxGeometry(0.05, 0.09, 0.012);
  for (let i = 0; i < 3; i++) {
    const stick = part(quiver, gArrow, matLeatherLight, -0.03 + i * 0.035, 0.30, (i - 1) * 0.02);
    stick.rotation.z = (i - 1) * 0.10;
    part(stick, gFletch, matCloth, 0, 0.26, 0);
  }

  group.traverse((o) => { if (o.isMesh) o.castShadow = true; });

  // ------------------------------------------------------------------ state
  let phase = 0;        // walk-cycle phase
  let breatheT = 0;
  let lean = 0;         // smoothed forward lean from acceleration
  let strafeLean = 0;   // smoothed lateral (roll) lean, v2
  let landDip = 0;      // landing recovery dip magnitude, v2
  let crouchAmt = 0;    // smoothed 0..1 crouch blend, v2
  let prevSpeed = 0;
  let dodgeT = 0;
  let deathT = 0;
  let staminaIdle = 0;  // seconds since last stamina spend
  let flashT = 0;
  let noiseT = 0;       // footstep noise throttle (sprint + sneak)
  let drownWarned = false; // one toast per drowning episode
  const dodgeDir = new THREE.Vector3(0, 0, -1);

  const player = {
    group,
    pos: new THREE.Vector3(0, heightAt(0, 0), 0), // feet position
    vel: new THREE.Vector3(),
    yaw: 0,
    hp: 0,
    maxHp: 0,
    stamina: 100,
    maxStamina: 100,
    grounded: false,
    dodging: false,
    sprinting: false,
    aiming: false,
    drawing: false, // written by the bow module
    dead: false,
    crouched: false,   // v2: KeyC toggle
    crouchAmt: 0,      // v2: smoothed blend, camera reads for pivot lowering
    swimming: false,   // v2: deep-water mode (bow attacks gate on this via cam.aiming)
    concealed: false,  // v2: crouched inside stealth grass; machines/ai.js reads it
    meleeT: 0,         // v3: 0..1 spear swing channel (written by player/spear.js)
    update,
    takeDamage,
    heal,
  };

  const computeMaxHp = () => BASE_MAX_HP + (G.skills.heartier ? HEARTIER_HP : 0);
  player.maxHp = computeMaxHp();
  player.hp = player.maxHp;

  /** Camera-relative WASD intent into `out` (normalized, or zero vector). */
  function computeWish(out) {
    // 3C: action-layer reads - rebinding and the gamepad stick merge now drive
    // movement. Level semantics match the retired raw polls one-to-one under
    // default bindings (KeyW/S/D/A).
    const f = (Input.isAction('forward') ? 1 : 0) - (Input.isAction('back') ? 1 : 0);
    const s = (Input.isAction('right') ? 1 : 0) - (Input.isAction('left') ? 1 : 0);
    if (f === 0 && s === 0) return out.set(0, 0, 0);
    const yaw = G.cam.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw); // forward = -Z rotated by yaw
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);  // right = +X rotated by yaw
    return out.set(fx * f + rx * s, 0, fz * f + rz * s).normalize();
  }

  function takeDamage(amount, fromPos) {
    if (player.dodging || player.dead) return; // dodge grants invulnerability
    const rank = clamp(G.inventory.armor | 0, 0, ARMOR_REDUCTION.length - 1);
    const dealt = amount * (1 - ARMOR_REDUCTION[rank]);
    player.hp -= dealt;
    flashT = FLASH_TIME;
    if (fromPos) {
      _push.subVectors(player.pos, fromPos);
      _push.y = 0;
      if (_push.lengthSq() > 1e-6) {
        _push.normalize().multiplyScalar(4.5); // knockback nudge
        player.vel.x += _push.x;
        player.vel.z += _push.z;
      }
    }
    bus.emit('playerHit', { amount: dealt, hp: player.hp, pos: fromPos || null });
    if (player.hp <= 0) {
      player.hp = 0;
      player.dead = true;
      bus.emit('playerDied', {});
    }
  }

  function heal(amount) {
    player.hp = Math.min(player.maxHp, player.hp + amount);
    bus.emit('playerHealed', { hp: player.hp });
  }

  function update(dt) {
    // Live skill application (heartier can be bought mid-run).
    player.maxHp = computeMaxHp();
    if (player.hp > player.maxHp) player.hp = player.maxHp;
    player.aiming = G.cam.aiming;

    // --- medicine (rising edge via action layer so rebinds apply; KeyH) ---
    if (!player.dead && Input.wasActionPressed('heal') &&
        G.inventory.medicine > 0 && player.hp < player.maxHp) {
      G.inventory.medicine -= 1;
      heal(MEDICINE_HEAL);
      bus.emit('notify', { text: 'Used medicine', tone: 'good' });
    }

    const p = player.pos;
    const v = player.vel;
    const inWater = p.y < CONFIG.waterLevel;

    // --- crouch (default binding KeyC; dodge moved to ControlLeft only in v2).
    // 3C single-owner rule: input.js's action latch flips once per press while
    // crouchMode === 'toggle' (the fresh-boot default, matching this system's
    // legacy press-once-stays-crouched feel); with 'hold' the level tracks the
    // key directly. The player consumes a LEVEL here either way - no second
    // toggle lives anywhere, so rebinding C or using pad Y cannot double-flip,
    // and dead players keep their last pose exactly like the old !dead gate.
    if (!player.dead) {
      const crouched = Input.isAction('crouch');
      if (crouched !== player.crouched) {
        player.crouched = crouched;
        bus.emit('ui', { action: 'click' }); // same feedback the old toggle gave
      }
    }

    // --- swim mode: hysteresis around the surface so it never flickers ---
    const wasSwimming = player.swimming;
    if (player.swimming) {
      player.swimming = !player.dead && p.y < CONFIG.waterLevel - SWIM_EXIT_DEPTH;
    } else {
      player.swimming = !player.dead && p.y < CONFIG.waterLevel - SWIM_ENTER_DEPTH;
    }
    if (player.swimming && !wasSwimming && v.y < -7) {
      bus.emit('noise', { pos: p, radius: 10 }); // splash
    }

    // --- dodge trigger (rising edge via the action layer - default
    // ControlLeft, pad B merges in; still never while swimming). Edge-per-
    // frame equals the old pressed() poll for any humanly reachable tap. ---
    if (!player.dead && !player.dodging && !player.swimming &&
        Input.wasActionPressed('dodge')) {
      const cost = CONFIG.dodgeCost * (G.skills.secondWind ? 0.5 : 1);
      if (player.stamina >= cost) {
        player.stamina -= cost;
        staminaIdle = 0;
        computeWish(_wish);
        if (_wish.lengthSq() < 1e-6) {
          _wish.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw)); // facing fallback
        }
        dodgeDir.copy(_wish).normalize();
        player.dodging = true;
        dodgeT = 0;
        v.x = dodgeDir.x * CONFIG.dodgeSpeed;
        v.z = dodgeDir.z * CONFIG.dodgeSpeed;
      }
    }

    // --- dodge carry: fixed burst with mild ease-out ---
    if (player.dodging) {
      dodgeT += dt;
      const k = 1 - 0.4 * clamp(dodgeT / CONFIG.dodgeDuration, 0, 1);
      v.x = dodgeDir.x * CONFIG.dodgeSpeed * k;
      v.z = dodgeDir.z * CONFIG.dodgeSpeed * k;
      if (dodgeT >= CONFIG.dodgeDuration) player.dodging = false;
    }

    // --- locomotion target ---
    computeWish(_wish);
    const wantMove = _wish.lengthSq() > 1e-6;

    player.sprinting = false;
    // 3C: level read via the action layer (default ShiftLeft; pad RB merges).
    if (!player.dead && !player.dodging && !player.crouched && wantMove &&
        Input.isAction('sprint') && player.stamina > 0 && !inWater) {
      player.sprinting = true;
      player.stamina -= CONFIG.sprintCost * dt;
      staminaIdle = 0;
      noiseT -= dt;
      if (noiseT <= 0) { // pounding feet attract machines
        noiseT = 0.45;
        bus.emit('noise', { pos: p, radius: 20 });
      }
    } else if (!player.dead && player.crouched && !player.swimming &&
               wantMove && player.grounded) {
      // Sneaking footsteps: tiny noise pings so close machines can still hear.
      noiseT -= dt;
      if (noiseT <= 0) {
        noiseT = CROUCH_NOISE_EVERY;
        bus.emit('noise', { pos: p, radius: CROUCH_NOISE_RADIUS });
      }
    }
    if (player.stamina < 0) player.stamina = 0;

    // --- swimming stamina drain; dry stamina means drowning (hp floored) ---
    if (player.swimming && !player.dead) {
      player.stamina -= SWIM_STAMINA_DRAIN * dt;
      staminaIdle = 0; // no regen mid-swim
      if (player.stamina <= 0) {
        player.stamina = 0;
        const floor = player.maxHp * DROWN_HP_FLOOR_FRAC;
        if (player.hp > floor) player.hp = Math.max(floor, player.hp - SWIM_DROWN_DPS * dt);
        if (!drownWarned) {
          drownWarned = true;
          bus.emit('notify', { text: 'Exhausted - get out of the water!', tone: 'bad' });
        }
      }
    } else {
      drownWarned = false;
    }

    let speedTarget = player.sprinting ? CONFIG.playerSpeedSprint : CONFIG.playerSpeedWalk;
    if (player.swimming) speedTarget *= SWIM_DRIFT_MULT; // slow drift
    else if (inWater) speedTarget *= 0.5;                // wading (v1)
    else if (player.crouched) speedTarget *= CROUCH_SPEED_MULT;

    if (player.dodging) {
      // velocity fully owned by the dodge burst this frame
    } else if (player.dead) {
      v.x = damp(v.x, 0, 6, dt);
      v.z = damp(v.z, 0, 6, dt);
    } else {
      const lam = wantMove ? 10 : 12;
      v.x = damp(v.x, wantMove ? _wish.x * speedTarget : 0, lam, dt);
      v.z = damp(v.z, wantMove ? _wish.z * speedTarget : 0, lam, dt);
    }

    // --- vertical: swim buoyancy vs jump + gravity ---
    if (player.swimming) {
      // Space swims up; the rise carries through the swim-exit threshold so
      // momentum breaches into a small hop out of the water. Otherwise drift
      // down gently.
      // 3C: swim-up rides the jump action held down (default Space / pad A) -
      // level semantics identical to the old Input.down('Space') poll.
      const vyTarget = (!player.dead && Input.isAction('jump'))
        ? SWIM_RISE_SPEED
        : SWIM_SINK_SPEED;
      v.y = damp(v.y, vyTarget, 4, dt);
    } else {
      // 3C: jump keeps its one-shot feel as an action-layer rising edge
      // (default Space / pad A) instead of a raw pressed() poll.
      if (!player.dead && !player.dodging && !inWater &&
          Input.wasActionPressed('jump') && player.grounded) {
        v.y = CONFIG.playerJumpVel;
        player.grounded = false;
      }
      v.y -= CONFIG.gravity * dt;
    }

    // --- integrate + ground snap ---
    p.x += v.x * dt;
    p.y += v.y * dt;
    p.z += v.z * dt;
    const gy = heightAt(p.x, p.z);
    if (p.y <= gy) {
      if (!player.grounded && v.y < -14) bus.emit('noise', { pos: p, radius: 9 }); // hard landing
      // Fall damage on landings (never in water - swimming breaks the fall).
      if (!player.grounded && !wasSwimming && !player.swimming && v.y < -LAND_DIP_MIN_VY) {
        if (v.y < -FALL_DAMAGE_MIN_VY) {
          takeDamage((-v.y - FALL_DAMAGE_MIN_VY) * FALL_DAMAGE_SCALE);
        }
        landDip = clamp((-v.y - LAND_DIP_MIN_VY) * 0.02, 0.04, 0.3); // recovery dip
      }
      p.y = gy;
      v.y = 0;
      player.grounded = true;
    } else if (p.y > gy + 0.05) {
      player.grounded = false;
    }

    // --- soft world border: clamp radius, strip outward radial speed (slide) ---
    const rMax = CONFIG.playRadius + 25;
    const rLen = Math.hypot(p.x, p.z);
    if (rLen > rMax) {
      const rx = p.x / rLen, rz = p.z / rLen;
      p.x = rx * rMax;
      p.z = rz * rMax;
      const vd = v.x * rx + v.z * rz;
      if (vd > 0) { v.x -= vd * rx; v.z -= vd * rz; }
    }

    // --- stamina regen ---
    staminaIdle += dt;
    if (!player.dead && staminaIdle >= STAMINA_DELAY) {
      player.stamina = Math.min(player.maxStamina, player.stamina + STAMINA_REGEN * dt);
    }

    // --- facing: movement dir, or camera yaw while aiming ---
    const hSpeed = Math.hypot(v.x, v.z);
    if (!player.dead) {
      if (G.cam.aiming) {
        player.yaw = dampAngle(player.yaw, G.cam.yaw, 18, dt);
      } else if (hSpeed > 0.6) {
        player.yaw = dampAngle(player.yaw, Math.atan2(-v.x, -v.z), 12, dt);
      }
    }

    // --- stealth concealment: crouched inside stealth grass. machines/ai.js
    // reads G.player.concealed each frame to shrink sight range (unless aggro).
    player.concealed = !player.dead && player.crouched && !player.swimming &&
      typeof propsNs.isConcealed === 'function' &&
      propsNs.isConcealed(p.x, p.z) === true;

    // Smoothed crouch blend drives the pose + camera pivot height.
    crouchAmt = damp(crouchAmt, player.crouched && !player.swimming ? 1 : 0, 10, dt);
    player.crouchAmt = crouchAmt;

    group.position.copy(p);
    group.rotation.y = player.yaw;
    animate(dt, hSpeed, wantMove);

    // --- hit flash: brief red emissive pulse on body materials ---
    if (flashT > 0) {
      flashT -= dt;
      const k = Math.max(flashT, 0) / FLASH_TIME;
      for (let i = 0; i < flashMats.length; i++) {
        flashMats[i].emissive.setRGB(k, k * 0.06, k * 0.04);
      }
    }
  }

  // Procedural pose: walk cycle, air tuck, dodge tumble, death collapse,
  // breathing. Joint targets are damped; dodge/death body rotations are exact.
  function animate(dt, hSpeed, wantMove) {
    breatheT += dt;
    let lLeg = 0, rLeg = 0, lArm = 0, rArm = 0;
    let bodyRotX = 0, bodyY = 0;
    let torsoTwist = 0; // v3: spear swing yaw offset

    if (player.dead) {
      deathT += dt;
      const e = smoothstep(0, 0.6, deathT); // settles fast; updates may stop soon
      bodyRotX = 1.45 * e;                  // topple backward
      bodyY = -0.22 * e;                    // sink slightly
      lLeg = 0.25 * e; rLeg = 0.1 * e;
      lArm = -0.45 * e; rArm = -0.6 * e;
    } else if (player.dodging) {
      bodyRotX = -TWO_PI * clamp(dodgeT / CONFIG.dodgeDuration, 0, 1); // forward tumble
      lLeg = 0.95; rLeg = 0.95; lArm = -0.7; rArm = -0.7;              // tuck
    } else if (!player.grounded) {
      lLeg = 0.65; rLeg = 0.40; lArm = -0.5; rArm = -0.3;              // jump tuck
    } else if (wantMove && hSpeed > 0.4) {
      const amp = 0.35 + 0.55 * clamp(hSpeed / CONFIG.playerSpeedSprint, 0, 1);
      phase += dt * (4.5 + hSpeed * 1.35); // step frequency scales with speed
      const s1 = Math.sin(phase);
      lLeg = s1 * amp;
      rLeg = -s1 * amp;
      lArm = -s1 * amp * 0.75; // counter-swing vs same-side leg
      rArm = s1 * amp * 0.75;
    }

    // Aim pose (bow module only poses its own mesh, arms are driven here):
    // bow arm extended forward, string hand ready or pulled to the cheek.
    // v2: while drawing, both arms track the aim pitch so the hunter points
    // up/down with the crosshair.
    if (G.cam.aiming && !player.dead && !player.dodging) {
      lArm = 1.45;
      rArm = player.drawing ? -0.85 : 0.55;
      if (player.drawing) {
        const pitch = clamp(G.cam.pitch, -0.9, 0.9);
        lArm = clamp(lArm + pitch * 0.85, 0.9, 2.3);
        rArm += pitch * 0.30;
      }
    }

    // v3: spear quick-melee sweep - offsets on top of the base pose so the
    // swing blends with walking/aiming. Channel written by player/spear.js:
    // windup cocks the arm back and winds the torso, strike whips down-across,
    // recover settles back to zero.
    if (player.meleeT > 0 && !player.dead && !player.dodging) {
      const t = player.meleeT;
      let armOff, twist;
      if (t < 0.3) {
        const k = smoothstep(0, 1, t / 0.3);
        armOff = 1.05 * k;
        twist = -0.42 * k;
      } else if (t < 0.62) {
        const k = smoothstep(0, 1, (t - 0.3) / 0.32);
        armOff = 1.05 - 1.4 * k;
        twist = -0.42 + 0.95 * k;
      } else {
        const k = smoothstep(0, 1, (t - 0.62) / 0.38);
        armOff = -0.35 * (1 - k);
        twist = 0.53 * (1 - k);
      }
      rArm += armOff;
      torsoTwist = twist;
    }

    // v2: crouch blend - lower the body, bend the knees, hunch the torso.
    if (crouchAmt > 0.001) {
      bodyY -= crouchAmt * 0.42;
      lLeg += crouchAmt * 0.75;
      rLeg += crouchAmt * 0.75;
    }

    // v2: landing recovery dip - sink and unfold after a hard touchdown.
    if (landDip > 0.001) {
      if (!player.dead && !player.dodging) {
        bodyY -= landDip;
        lLeg += landDip * 0.9;
        rLeg += landDip * 0.9;
        lArm -= landDip * 0.4;
        rArm -= landDip * 0.4;
      }
      landDip = damp(landDip, 0, 7, dt);
    }

    // Lean into acceleration (smoothed horizontal accel estimate).
    const accel = dt > 1e-5 ? (hSpeed - prevSpeed) / dt : 0;
    prevSpeed = hSpeed;
    lean = damp(lean, clamp(accel * 0.03, -0.12, 0.30), 6, dt);
    if (!player.dead && !player.dodging) bodyRotX += lean;

    // v2: strafe lean - roll into lateral movement relative to facing.
    const latVel = player.vel.x * Math.cos(player.yaw) - player.vel.z * Math.sin(player.yaw);
    const rollTarget = (!player.dead && !player.dodging)
      ? clamp(-latVel * 0.05, -0.2, 0.2)
      : 0;
    strafeLean = damp(strafeLean, rollTarget, 8, dt);

    // Idle breathing bob; head tracks camera pitch a little while aiming.
    const breath = Math.sin(breatheT * 2.1);
    if (!player.dead && !player.dodging) bodyY += breath * 0.012;
    pose.torso.rotation.x = player.dead ? 0 : breath * 0.02 + lean * 0.4 + crouchAmt * 0.28;
    pose.torso.rotation.y = damp(pose.torso.rotation.y, torsoTwist, 20, dt); // v3 swing twist
    pose.head.rotation.x = player.dead
      ? 0
      : breath * 0.015 - 0.03 + (G.cam.aiming ? clamp(G.cam.pitch, -0.6, 0.6) * 0.55 : 0);

    const jl = 14; // joint damp lambda
    pose.legL.rotation.x = damp(pose.legL.rotation.x, lLeg, jl, dt);
    pose.legR.rotation.x = damp(pose.legR.rotation.x, rLeg, jl, dt);
    pose.armL.rotation.x = damp(pose.armL.rotation.x, lArm, jl, dt);
    pose.armR.rotation.x = damp(pose.armR.rotation.x, rArm, jl, dt);
    body.rotation.x = bodyRotX;
    body.rotation.z = strafeLean;
    body.position.y = bodyY;
  }

  G.player = player;
  G.scene.add(group);

  // --- authored-body seam (hunterView) ------------------------------------
  // Swaps the procedural body visuals for the manifest-authored rig (same
  // node names + pivots). Procedural children are kept for restore; pose
  // groups re-resolve by name so the animation code above keeps working.
  let proceduralChildren = null;
  player.rebindPoseRefs = () => {
    const find = (n) => group.getObjectByName(n);
    for (const key of ["torso", "head", "armL", "armR", "legL", "legR"]) {
      const found = find(key);
      if (found) pose[key] = found;
    }
  };
  player.useAuthoredBody = (authoredRoot) => {
    if (!authoredRoot || !authoredRoot.isObject3D) return false;
    if (!proceduralChildren) {
      proceduralChildren = body.children.slice();
      for (const c of proceduralChildren) body.remove(c);
    } else {
      for (const c of body.children.slice()) body.remove(c);
    }
    body.add(authoredRoot);
    // Re-attach any gameplay anchors that lived on the old hierarchy
    // (handL/handR exist in both rigs under identical names).
    player.rebindPoseRefs();
    return true;
  };
  player.restoreProceduralBody = () => {
    if (!proceduralChildren) return false;
    for (const c of body.children.slice()) body.remove(c);
    for (const c of proceduralChildren) body.add(c);
    player.rebindPoseRefs();
    return true;
  };

  return player;
}
