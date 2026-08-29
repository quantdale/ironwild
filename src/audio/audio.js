// IRONWILD - procedural WebAudio SFX + ambience + adaptive music. 100% synthesized:
// no asset files, no network fetches. Exports initAudio() (lazy unlock on first
// user gesture), sfx(name, opts) for direct one-shots (opts.pos -> equalpower
// panner around the player), updateAudio(dt) which drives ambience scheduling
// (drone day/night crossfade, birds, crickets, low-hp heartbeat), the v2
// threat-crossfaded music (calm pad / explore plucks / combat pulses) and the
// weather loops (rain bed + thunder booms), plus the v3 boss layer (war drums +
// detuned saw pad crossfaded by G.bossNear) and bus-driven victory sting /
// melee whoosh / level-up fanfare. Everything is guarded so calls before
// initAudio() no-op.
// Wave I additions: central voice registry with per-category caps + steal rules
// (getVoiceStats -> window.__IW_AUDIO_STATS), a pooled positional emitter API
// (emitAt -> emitters.js), surface-aware footsteps, 'impact' material layers,
// damaged-machine stress creaks, intensity-linked weather crossfades,
// hysteresis escalation tiers (calm/tense/combat/boss), an optional sample-bank
// fallback (setSampleBank) and per-machine-type audio identities.

import { bus } from '../core/events.js';
import { G, CONFIG } from '../core/state.js';
import { clamp, lerp, smoothstep } from '../core/utils.js';
import { biomeAt } from '../world/terrain.js';
import { createEmitters, updateEmitters, emitAt as emitterEmitAt, getEmitterStats } from './emitters.js';

const MAX_VOICES = 24; // hard cap on simultaneous one-shot voices
const EAR_RANGE = 60;  // positional falloff distance in world units

// Wave I voice management: per-category concurrency caps on top of the global
// MAX_VOICES ceiling. A saturated category steals its oldest lowest-priority
// voice instead of leaking into other categories (e.g. 10 UI clicks can no
// longer starve positional combat sounds).
const VOICE_CAPS = { ambience: 4, machine: 6, combat: 8, ui: 4 };
// Category lookup for every SYNTHS name; unlisted names fall back to 'combat'
// so unknown future synths are capped conservatively rather than uncapped.
const SFX_CATEGORY = {
  // machine family
  machineStep: 'machine', machineGrowl: 'machine', growl: 'machine',
  screech: 'machine', machineAlert: 'machine', machineDeath: 'machine',
  // ui / feedback family
  uiClick: 'ui', uiOpen: 'ui', uiClose: 'ui', pickup: 'ui', craft: 'ui',
  skillUp: 'ui', levelUp: 'ui', playerHeal: 'ui',
  // ambience family (heartbeat/birds/crickets/thunder register manually below)
  stepSoil: 'ambience', stepForest: 'ambience', stepStone: 'ambience',
  stepWater: 'ambience',
  stressCreak: 'machine', // damaged-machine beds share the machine budget
};
// Default steal priorities (0 = first stolen). One-shots may override via
// opts.priority; higher = more protective.
const DEFAULT_PRIO = { ambience: 1, machine: 3, combat: 4, ui: 2 };
// Coarse per-name tail lengths (seconds) for time-based registry expiry — the
// accounting slot frees even when a synth returns no single long source node.
// Values are upper bounds; real nodes usually end sooner via their envelopes.
const SYNTH_DUR = {
  bowDraw: 0.45, bowRelease: 0.3, arrowHitFlesh: 0.22, arrowHitMetal: 1.0,
  weakBreak: 0.6, machineStep: 0.25, machineGrowl: 0.9, growl: 1.2,
  machineAlert: 0.32, screech: 0.45, machineDeath: 1.3, playerHurt: 0.3,
  playerHeal: 0.55, pickup: 0.4, uiClick: 0.1, uiOpen: 0.3, uiClose: 0.28,
  craft: 0.62, skillUp: 0.68, dodge: 0.26, victorySting: 0.58,
  meleeWhoosh: 0.28, levelUp: 0.78,
  // Wave I additions
  stepSoil: 0.15, stepForest: 0.18, stepStone: 0.14, stepWater: 0.24,
  impactMetal: 0.5, impactStone: 0.18, impactSoil: 0.18, impactWood: 0.22,
  impactWater: 0.4, stressCreak: 0.85,
};

// Live one-shot registry: {cat, prio, t0, end, src, done}. Time-based expiry
// (end) drives pruning so batches of short tones (bird chirps, craft knocks)
// count as one voice without needing an onended hook on every node.
const voiceReg = [];
let voicesStolen = 0;   // cumulative steal counter (perf HUD diagnostics)

let ctx = null;         // AudioContext, created lazily by initAudio()
let master = null;      // master gain (0.5 * settings.master) -> destination
let busIn = null;       // entry point for all one-shot sfx (dry + reverb send)
let ambienceIn = null;  // entry point for ambience loops (skips reverb)
let noiseBuf = null;    // shared 1.5s white-noise buffer for bursts
let windBuf = null;     // 4s looped noise buffer for wind
let voices = 0;         // live one-shot voice count (registry-maintained)
let unlocked = false;   // set by the first real user gesture (hooks at EOF)
let _pitchScale = 1;    // machine-identity transpose factor (1 outside sfx())

// v2 volume stages + music/weather buses (created in initAudio)
let sfxGain = null;     // sfx volume stage; dry + reverb paths both pass through
let musicIn = null;     // music bus, governed by settings.music
let calmGain = null;    // calm-pad layer gain (proportional to 1 - threat)
let exploreGain = null; // explore pluck layer gain (peaks at mid threat)
let combatGain = null;  // combat pulse/drone layer gain (rises above threat 0.5)
let rainGain = null;    // rain noise-bed gain (follows G.weather.intensity)

// ambience state touched by updateAudio()
let windGain = null;
let padOscRoot = null, padOscDet = null, padOscFifth = null;
let lastDaylight = -1;
let nextBirdAt = 0;
let nextCricketAt = 0;
let nextBeatAt = -1;    // < 0 => heartbeat idle

// v2 music/weather state touched by updateAudio()
let droneOscA = null, droneOscB = null;               // combat tense drone
let lastCalmT = -1, lastExpT = -1, lastComT = -1;     // crossfade glide caches
let lastRainT = -1;                                   // rain bed glide cache
let nextPluckAt = 0, nextPulseAt = 0, pluckStep = 0;  // layer schedulers
let lastThunderAt = -99;                              // thunder min-gap clock
let lastHandledStrikeAt = -1;                         // < w.lastStrikeAt => boom due

// v3 boss layer state touched by updateAudio()
let bossGain = null;                  // boss music bus (war drums + detuned saw pad)
let lastBossT = -1;                   // boss crossfade glide cache
let nextDrumAt = 0;                   // war-drum lookahead scheduler

// Wave I state touched by updateAudio() / bus wiring
let combatTier = 'calm';              // escalation: calm|tense|combat|boss
let rainLPF = null;                   // rain bed brightness filter (intensity-linked)
let stormGain = null;                 // storm sub-rumble bed gain
let lastStormT = -1;                  // storm bed glide cache
const stressBeds = new Map();         // damaged machine -> next creak time
let stepAccum = 0;                    // stride driver: horizontal meters walked
let lastStepX = 0, lastStepZ = 0;     // stride driver: previous player pos
let lastBusStepAt = -99;              // audio clock of last 'footstep' bus event

// drone pad chords: day A-E (bright) vs night F-C (dark)
const CHORD_DAY = { root: 110.0, fifth: 164.81 };   // A2 / E3
const CHORD_NIGHT = { root: 87.31, fifth: 130.81 }; // F2 / C3

// ---------------------------------------------------------------- buffers --

function makeNoiseBuffer(dur) {
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** Stereo impulse response: white noise with exponential decay. */
function makeImpulse(dur, decay) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-decay * i / len);
  }
  return buf;
}

// ------------------------------------------------------------- voice utils --
// Both helpers take { t0, dur, vol, attack, attn, dest } plus type-specific
// fields, build an enveloped source -> (filter) -> gain chain, start/stop it,
// and return the source node so sfx() can hook onended for voice accounting.
// attn is the positional attenuation multiplier computed once per sfx call.

/** Enveloped oscillator voice. Extra: f0->f1 freq ramp (over glideT or dur),
 *  detune cents, lpf = inline lowpass frequency to soften raw waveforms.
 *  _pitchScale transposes both endpoints (Wave I machine-identity shaping;
 *  it is 1 everywhere except inside the synchronous sfx() identity window). */
function toneVoice(o) {
  const ps = _pitchScale;
  const t0 = o.t0 != null ? o.t0 : ctx.currentTime;
  const dur = o.dur != null ? o.dur : 0.2;
  const osc = ctx.createOscillator();
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(Math.max(1, o.f0 * ps), t0);
  if (o.f1 != null && o.f1 !== o.f0) {
    const gt = o.glideT != null ? o.glideT : dur;
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1 * ps), t0 + gt);
  }
  if (o.detune) osc.detune.value = o.detune;
  const g = ctx.createGain();
  const vol = Math.max(0.0001, (o.vol != null ? o.vol : 0.2) * (o.attn != null ? o.attn : 1));
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + (o.attack != null ? o.attack : 0.004));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  let head = osc;
  if (o.lpf) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = o.lpf;
    f.Q.value = 0.7;
    osc.connect(f);
    head = f;
  }
  head.connect(g);
  g.connect(o.dest || busIn);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
  return osc;
}

/** Enveloped filtered-noise voice cut from the shared buffer. Extra: filter
 *  type + f0->fMid (at fMidT)->f1 sweep, q, random offset for variety.
 *  _pitchScale shifts the whole formant sweep (identity shaping, see above). */
function noiseVoice(o) {
  const ps = _pitchScale;
  const t0 = o.t0 != null ? o.t0 : ctx.currentTime;
  const dur = o.dur != null ? o.dur : 0.2;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  if (dur > noiseBuf.duration) src.loop = true; // long beds wrap instead of truncating
  const off = o.offset != null ? o.offset : Math.random() * Math.max(0, noiseBuf.duration - dur - 0.1);
  const f = ctx.createBiquadFilter();
  f.type = o.filter || 'lowpass';
  f.frequency.setValueAtTime(Math.max(20, (o.f0 != null ? o.f0 : 1000) * ps), t0);
  if (o.fMid != null) {
    f.frequency.exponentialRampToValueAtTime(Math.max(20, o.fMid * ps), t0 + (o.fMidT != null ? o.fMidT : dur * 0.5));
  }
  if (o.f1 != null && o.f1 !== o.f0) {
    f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1 * ps), t0 + dur);
  }
  f.Q.value = o.q != null ? o.q : 0.8;
  const g = ctx.createGain();
  const vol = Math.max(0.0001, (o.vol != null ? o.vol : 0.2) * (o.attn != null ? o.attn : 1));
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + (o.attack != null ? o.attack : 0.004));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f);
  f.connect(g);
  g.connect(o.dest || busIn);
  src.start(t0, off);
  src.stop(t0 + dur + 0.03);
  return src;
}

// ------------------------------------------------------------------ synths --
// Each synth takes (opts, attn) and returns its longest-lived source node.

const SYNTHS = {
  // creaky bandpass-noise swell over 0.4s (filter rises then falls)
  bowDraw(o, a) {
    return noiseVoice({
      dur: 0.4, vol: 0.15, filter: 'bandpass',
      f0: 240, fMid: 560, fMidT: 0.24, f1: 310, q: 7,
      attack: 0.3, attn: a,
    });
  },

  // plucked-string twang: two detuned triangles with fast pitch settle + tick
  bowRelease(o, a) {
    const p = clamp(o && o.power != null ? o.power : 1, 0, 1);
    const f = 150 + 70 * p;
    const v = 0.26 + 0.16 * p;
    const o1 = toneVoice({ type: 'triangle', f0: f * 1.32, f1: f, glideT: 0.045, dur: 0.24, vol: v, attack: 0.003, attn: a });
    toneVoice({ type: 'triangle', f0: f * 1.36, f1: f * 1.03, glideT: 0.05, dur: 0.2, vol: v * 0.55, attack: 0.003, attn: a });
    noiseVoice({ dur: 0.03, vol: 0.13, filter: 'highpass', f0: 3200, q: 0.7, attack: 0.002, attn: a });
    return o1;
  },

  // lowpassed thud
  arrowHitFlesh(o, a) {
    const n = noiseVoice({ dur: 0.13, vol: 0.5, filter: 'lowpass', f0: 260, f1: 120, q: 0.9, attn: a });
    toneVoice({ f0: 130, f1: 52, dur: 0.12, vol: 0.34, attn: a });
    return n;
  },

  // inharmonic metal ping: 800/1350/2100 Hz partials, staggered decay
  arrowHitMetal(o, a) {
    const d = 0.9 + Math.random() * 0.2; // slight per-hit detune variety
    const p1 = toneVoice({ f0: 800 * d, dur: 0.45, vol: 0.26, attack: 0.002, attn: a });
    toneVoice({ f0: 1350 * d, dur: 0.32, vol: 0.18, attack: 0.002, attn: a });
    toneVoice({ f0: 2100 * d, dur: 0.22, vol: 0.11, attack: 0.002, attn: a });
    noiseVoice({ dur: 0.02, vol: 0.14, filter: 'highpass', f0: 4200, attack: 0.002, attn: a });
    return p1;
  },

  // bright glass shatter + sub boom
  weakBreak(o, a) {
    const t = ctx.currentTime;
    noiseVoice({ t0: t, dur: 0.38, vol: 0.42, filter: 'highpass', f0: 1700, q: 0.6, attack: 0.003, attn: a });
    for (let i = 0; i < 3; i++) {
      toneVoice({ t0: t + i * 0.045, f0: 2300 + Math.random() * 2900, dur: 0.09, vol: 0.07, attack: 0.002, attn: a });
    }
    return toneVoice({ f0: 74, f1: 36, dur: 0.5, vol: 0.5, attack: 0.005, attn: a });
  },

  // low thump; opts.size scales pitch down / volume up for bigger machines
  machineStep(o, a) {
    const s = clamp(o && o.size != null ? o.size : 1, 0.5, 2.5);
    const f = clamp(95 / Math.pow(s, 0.65), 42, 130);
    const v = clamp(s, 0.5, 1.5);
    const th = toneVoice({ f0: f * 1.3, f1: f, dur: 0.17, vol: 0.34 * v, attack: 0.004, attn: a });
    noiseVoice({ dur: 0.05, vol: 0.1 * v, filter: 'lowpass', f0: 320, attn: a });
    return th;
  },

  // LFO-amplitude-modulated saw growl through a lowpass, 0.8s
  machineGrowl(o, a) {
    const t = ctx.currentTime;
    const s = clamp(o && o.size != null ? o.size : 1, 0.5, 2.5);
    const f = clamp(76 / Math.pow(s, 0.5), 46, 84) + Math.random() * 5;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 340;
    lp.Q.value = 1.2;
    const am = ctx.createGain(); // tremolo stage: base 0.5 +/- 0.45
    am.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 8 + Math.random() * 3;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 0.45;
    lfo.connect(lfoAmt);
    lfoAmt.connect(am.gain);
    const env = ctx.createGain();
    const vol = Math.max(0.0001, 0.3 * clamp(s, 0.6, 1.6) * (a != null ? a : 1));
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(vol, t + 0.16);
    env.gain.setValueAtTime(vol, t + 0.55);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    osc.connect(lp);
    lp.connect(am);
    am.connect(env);
    env.connect(o.dest || busIn); // honor positional panner when provided
    osc.start(t);
    lfo.start(t);
    osc.stop(t + 0.83);
    lfo.stop(t + 0.83);
    return osc;
  },

  // enrage bellow: slower/deeper LFO-amplitude-modulated growl; opts.size
  // scales pitch down / volume up for bigger machines
  growl(o, a) {
    const t = ctx.currentTime;
    const s = clamp(o && o.size != null ? o.size : 2.2, 0.5, 2.5);
    const f = clamp(58 / Math.pow(s, 0.5), 34, 66) + Math.random() * 4;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    lp.Q.value = 1.4;
    const am = ctx.createGain(); // tremolo stage: base 0.5 +/- 0.45
    am.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 6 + Math.random() * 2;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 0.45;
    lfo.connect(lfoAmt);
    lfoAmt.connect(am.gain);
    const env = ctx.createGain();
    const vol = Math.max(0.0001, 0.36 * clamp(s, 0.6, 1.8) * (a != null ? a : 1));
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(vol, t + 0.12);
    env.gain.setValueAtTime(vol, t + 0.8);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    osc.connect(lp);
    lp.connect(am);
    am.connect(env);
    env.connect(o.dest || busIn); // honor positional panner when provided
    osc.start(t);
    lfo.start(t);
    osc.stop(t + 1.13);
    lfo.stop(t + 1.13);
    return osc;
  },

  // rising two-tone chirp (softened squares)
  machineAlert(o, a) {
    const t = ctx.currentTime;
    toneVoice({ t0: t, type: 'square', f0: 470, dur: 0.1, vol: 0.11, attack: 0.01, lpf: 1900, attn: a });
    return toneVoice({ t0: t + 0.115, type: 'square', f0: 705, dur: 0.15, vol: 0.11, attack: 0.01, lpf: 2100, attn: a });
  },

  // dive/hiss shriek: two detuned squares sweeping down together, ~0.4s
  screech(o, a) {
    const t = ctx.currentTime;
    const d = Math.random() * 40 - 20; // slight per-call detune variety
    const s1 = toneVoice({
      t0: t, type: 'square', f0: 1600 + d, f1: 700, glideT: 0.32,
      dur: 0.36, vol: 0.11, attack: 0.008, lpf: 4500, attn: a,
    });
    toneVoice({
      t0: t, type: 'square', f0: 1665 + d, f1: 735, glideT: 0.34,
      dur: 0.38, vol: 0.08, attack: 0.008, lpf: 4500, attn: a,
    });
    return s1;
  },

  // big boom: lowpass-swept noise + downward saw sweep + sub weight, ~1.2s
  machineDeath(o, a) {
    noiseVoice({ dur: 1.1, vol: 0.55, filter: 'lowpass', f0: 1500, f1: 90, q: 0.7, attack: 0.006, attn: a });
    toneVoice({ f0: 66, f1: 30, dur: 0.7, vol: 0.4, attack: 0.005, attn: a });
    return toneVoice({ type: 'sawtooth', f0: 150, f1: 27, dur: 1.2, vol: 0.26, attack: 0.01, lpf: 520, attn: a });
  },

  // dull thump + filtered saw grunt
  playerHurt(o, a) {
    toneVoice({ f0: 112, f1: 46, dur: 0.16, vol: 0.42, attack: 0.004, attn: a });
    return toneVoice({ type: 'sawtooth', f0: 150, f1: 88, dur: 0.22, vol: 0.14, attack: 0.02, lpf: 460, attn: a });
  },

  // warm soft major arpeggio A4-C#5-E5
  playerHeal(o, a) {
    const t = ctx.currentTime;
    let last = null;
    [440, 554.37, 659.26].forEach((f, i) => {
      last = toneVoice({ t0: t + i * 0.085, type: 'triangle', f0: f, dur: 0.34, vol: 0.13, attack: 0.012, lpf: 2400, attn: a });
    });
    return last;
  },

  // two-note chime; base note varies with resource type
  pickup(o, a) {
    const t = ctx.currentTime;
    const base = o && o.type === 'medicine' ? 1046.5 : o && o.type === 'shards' ? 880 : 784;
    toneVoice({ t0: t, f0: base, dur: 0.16, vol: 0.16, attack: 0.003, attn: a });
    return toneVoice({ t0: t + 0.09, f0: base * 1.5, dur: 0.24, vol: 0.13, attack: 0.003, attn: a });
  },

  uiClick(o, a) {
    return toneVoice({ f0: 1650, f1: 1050, dur: 0.035, vol: 0.12, attack: 0.002, attn: a });
  },

  uiOpen(o, a) {
    return noiseVoice({ dur: 0.22, vol: 0.2, filter: 'bandpass', f0: 320, f1: 1500, q: 1.1, attack: 0.05, attn: a });
  },

  uiClose(o, a) {
    return noiseVoice({ dur: 0.2, vol: 0.2, filter: 'bandpass', f0: 1400, f1: 260, q: 1.1, attack: 0.03, attn: a });
  },

  // three hammer knocks with slight pitch/volume falloff
  craft(o, a) {
    const t = ctx.currentTime;
    let last = null;
    for (let i = 0; i < 3; i++) {
      const t0 = t + i * 0.17;
      const v = 1 - i * 0.12;
      noiseVoice({ t0, dur: 0.06, vol: 0.34 * v, filter: 'lowpass', f0: 900 - i * 130, q: 1, attack: 0.002, attn: a });
      last = toneVoice({ t0, f0: 185 - i * 14, f1: 138, dur: 0.08, vol: 0.26 * v, attack: 0.002, attn: a });
    }
    return last;
  },

  // rising 4-note arp G4-B4-D5-G5
  skillUp(o, a) {
    const t = ctx.currentTime;
    let last = null;
    [392, 493.88, 587.33, 783.99].forEach((f, i) => {
      last = toneVoice({ t0: t + i * 0.09, type: 'triangle', f0: f, dur: 0.3, vol: 0.13, attack: 0.008, lpf: 2600, attn: a });
    });
    return last;
  },

  dodge(o, a) {
    return noiseVoice({ dur: 0.18, vol: 0.22, filter: 'bandpass', f0: 950, f1: 240, q: 1, attack: 0.02, attn: a });
  },

  // v3: bright brass-y triad burst for kill streaks >= 3 (+ high shimmer tail)
  victorySting(o, a) {
    const t = ctx.currentTime;
    let last = null;
    [440, 554.37, 659.26].forEach((f, i) => { // A4 C#5 E5 quick rise
      last = toneVoice({
        t0: t + i * 0.085, type: 'sawtooth', f0: f, dur: 0.3,
        vol: 0.13, attack: 0.006, lpf: 2900, attn: a,
      });
    });
    for (let i = 0; i < 4; i++) { // faint scattered sparkles over the tail
      toneVoice({
        t0: t + 0.2 + i * 0.07, f0: 2400 + Math.random() * 2200,
        dur: 0.12, vol: 0.035, attack: 0.003, attn: a,
      });
    }
    return last;
  },

  // v3: spear swing — bandpass noise whoosh sweep; landed hits add a thud layer
  meleeWhoosh(o, a) {
    const w = noiseVoice({
      dur: 0.22, vol: 0.24, filter: 'bandpass',
      f0: 380, fMid: 1500, fMidT: 0.09, f1: 260, q: 1.2,
      attack: 0.03, attn: a,
    });
    if (o && o.hit) {
      noiseVoice({ dur: 0.14, vol: 0.4, filter: 'lowpass', f0: 300, f1: 110, q: 0.9, attn: a });
      return toneVoice({ f0: 118, f1: 46, dur: 0.16, vol: 0.38, attack: 0.004, attn: a });
    }
    return w;
  },

  // v3: level-up fanfare — faster/brighter major arp than skillUp (C5 E5 G5 C6)
  levelUp(o, a) {
    const t = ctx.currentTime;
    let last = null;
    [523.25, 659.26, 783.99, 1046.5].forEach((f, i) => {
      last = toneVoice({
        t0: t + i * 0.07, type: 'sawtooth', f0: f, dur: i === 3 ? 0.6 : 0.24,
        vol: 0.13, attack: 0.005, lpf: 3400, attn: a,
      });
    });
    return last;
  },

  // ---- Wave I: surface-aware footsteps (stride driver + 'footstep' bus) ----

  // soil/meadow/shore: soft lowpass scuff; running tightens + loudens
  stepSoil(o, a) {
    const run = o && o.running ? 1.3 : 1;
    return noiseVoice({
      dur: 0.09, vol: 0.11 * run, filter: 'lowpass',
      f0: 430 + Math.random() * 120, f1: 160, q: 0.8, attack: 0.004, attn: a,
    });
  },

  // forest floor: softer attack plus faint leaf-litter shimmer on top
  stepForest(o, a) {
    const run = o && o.running ? 1.25 : 1;
    const n = noiseVoice({
      dur: 0.12, vol: 0.085 * run, filter: 'lowpass',
      f0: 340 + Math.random() * 80, f1: 130, q: 0.7, attack: 0.014, attn: a,
    });
    noiseVoice({ dur: 0.06, vol: 0.03 * run, filter: 'highpass', f0: 2400, q: 0.5, attack: 0.004, attn: a });
    return n;
  },

  // highland rock: harder two-part click (toe tick + heel knock)
  stepStone(o, a) {
    const run = o && o.running ? 1.3 : 1;
    noiseVoice({ dur: 0.04, vol: 0.07 * run, filter: 'highpass', f0: 1500, q: 0.7, attack: 0.002, attn: a });
    return toneVoice({ f0: 210 + Math.random() * 40, f1: 130, dur: 0.07, vol: 0.09 * run, attack: 0.002, lpf: 1800, attn: a });
  },

  // shallow water: splashy bandpass swish + one droplet sparkle
  stepWater(o, a) {
    const run = o && o.running ? 1.35 : 1;
    const n = noiseVoice({
      dur: 0.16, vol: 0.13 * run, filter: 'bandpass',
      f0: 700, fMid: 1900, fMidT: 0.05, f1: 500, q: 1.1, attack: 0.006, attn: a,
    });
    toneVoice({
      t0: ctx.currentTime + 0.07, f0: 1150 + Math.random() * 350, f1: 1700,
      dur: 0.06, vol: 0.03 * run, attack: 0.004, attn: a,
    });
    return n;
  },

  // ---- Wave I: impact material categories ('impact' bus payloads) ----------
  // Layered onto existing hit sounds by combat FX; opts.strength (default 1)
  // scales loudness and ring length.

  // metal: mid clang partials + bright transient (lower than arrowHitMetal)
  impactMetal(o, a) {
    const s = clamp(o && o.strength != null ? o.strength : 1, 0.2, 2);
    const d = Math.random() * 30 - 15; // per-hit detune variety
    const p = toneVoice({ f0: 520 + d, f1: 480 + d, dur: 0.34 / Math.sqrt(s), vol: 0.22 * s, attack: 0.002, attn: a });
    toneVoice({ f0: 1560 + d * 2, dur: 0.18, vol: 0.1 * s, attack: 0.002, attn: a });
    noiseVoice({ dur: 0.03, vol: 0.16 * s, filter: 'highpass', f0: 3000, q: 0.7, attack: 0.001, attn: a });
    return p;
  },

  // stone: dry crack burst over a dull body thump
  impactStone(o, a) {
    const s = clamp(o && o.strength != null ? o.strength : 1, 0.2, 2);
    noiseVoice({ dur: 0.09, vol: 0.26 * s, filter: 'bandpass', f0: 760, fMid: 320, fMidT: 0.05, q: 1.6, attack: 0.002, attn: a });
    return toneVoice({ f0: 150, f1: 62, dur: 0.13, vol: 0.24 * s, attack: 0.003, attn: a });
  },

  // soil: soft dirt thud, almost no ring
  impactSoil(o, a) {
    const s = clamp(o && o.strength != null ? o.strength : 1, 0.2, 2);
    return noiseVoice({ dur: 0.12, vol: 0.28 * s, filter: 'lowpass', f0: 260, f1: 90, q: 0.9, attack: 0.004, attn: a });
  },

  // wood: hollow double knock (boxy low-mid partials)
  impactWood(o, a) {
    const s = clamp(o && o.strength != null ? o.strength : 1, 0.2, 2);
    toneVoice({ f0: 196, f1: 148, dur: 0.07, vol: 0.22 * s, attack: 0.002, lpf: 900, attn: a });
    return toneVoice({ t0: ctx.currentTime + 0.055, f0: 172, f1: 128, dur: 0.09, vol: 0.18 * s, attack: 0.002, lpf: 850, attn: a });
  },

  // water: splash swell + scattered droplets + displacement thump
  impactWater(o, a) {
    const s = clamp(o && o.strength != null ? o.strength : 1, 0.2, 2);
    const n = noiseVoice({
      dur: 0.3, vol: 0.3 * s, filter: 'bandpass',
      f0: 520, fMid: 1600, fMidT: 0.06, f1: 380, q: 0.9, attack: 0.008, attn: a,
    });
    for (let i = 0; i < 3; i++) {
      toneVoice({
        t0: ctx.currentTime + 0.08 + i * 0.05, f0: 900 + Math.random() * 800,
        f1: 1500, dur: 0.05, vol: 0.035 * s, attack: 0.004, attn: a,
      });
    }
    toneVoice({ f0: 90, f1: 45, dur: 0.18, vol: 0.14 * s, attack: 0.005, attn: a });
    return n;
  },

  // damaged-machine metal-stress creak: slow groaning bandpass swell.
  // Scheduled periodically per tracked machine — deliberately NOT a persistent
  // loop node, so the pause/restart lifecycle keeps zero extra loops to manage.
  stressCreak(o, a) {
    const v = clamp(o && o.vol != null ? o.vol : 0.08, 0.02, 0.16);
    return noiseVoice({
      dur: 0.75, vol: v, filter: 'bandpass',
      f0: 310 + Math.random() * 90, fMid: 175, fMidT: 0.45, q: 6,
      attack: 0.28, attn: a,
    });
  },
};

// --------------------------------------------- sample bank (asset fallback) --
// Wave I: optional asset-backed layer. setSampleBank(map) registers AudioBuffers
// keyed by synth name; sfx() then plays the buffer instead of the synth when a
// matching entry exists. The bank starts null, so today every sound stays 100%
// synthesized — no loading code lives here (the asset pipeline owns fetching).

let sampleBank = null; // id -> AudioBuffer registered against THIS ctx

/** Register (or clear with null) named AudioBuffers used before synth fallback.
 *  Buffers created on a different context still play in practice, but re-set
 *  the bank after initAudio() if sample-accurate behavior matters. */
export function setSampleBank(bank) {
  sampleBank = bank && typeof bank === 'object' ? bank : null;
}

/** Play bank[id] if available, else run the synthesized fallback. Returns the
 *  source node (either kind) so sfx()'s voice accounting keeps working. */
function playSampleOrSynth(id, fallbackFn, opts, attn) {
  const buf = sampleBank ? sampleBank[id] : null;
  if (!ctx || !buf || !(buf.sampleRate > 0)) {
    return fallbackFn ? fallbackFn(opts, attn) : null;
  }
  try {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain(); // samples bypass tone/noise envelopes: flat stage
    g.gain.value = 0.9 * (attn != null ? attn : 1);
    src.connect(g);
    g.connect(opts.dest || busIn);
    src.start();
    return src;
  } catch (_err) {
    return fallbackFn ? fallbackFn(opts, attn) : null; // broken buffer -> synth
  }
}

// ------------------------------------------------ Wave I machine identities --
// Per-type presets layered over the shared machine synths so each chassis is
// recognizable by ear alone. pitch transposes helper voices inside sfx()'s
// synchronous window (module _pitchScale); layer adds a quiet character tail.
// Unknown types get no identity — existing sounds are untouched for them.

const MACHINE_VOICES = new Set([
  'machineStep', 'machineGrowl', 'growl', 'screech', 'machineAlert', 'machineDeath',
]);
const IDENTITY_RADIUS = 6; // world units to match an sfx pos to its machine

function chitterLayer(o, a) { // skitter: fast high ticks after vocalizations
  const t = ctx.currentTime;
  let last = null;
  for (let i = 0; i < 3; i++) {
    last = noiseVoice({
      t0: t + i * 0.045, dur: 0.03, vol: 0.05, filter: 'bandpass',
      f0: 2600 + Math.random() * 700, q: 5, attack: 0.003,
      dest: o.dest || busIn, attn: a,
    });
  }
  return last;
}

function hydraulicLayer(o, a) { // ironmaw: servo drop + pressure hiss
  const t = ctx.currentTime;
  toneVoice({
    t0: t, f0: 64, f1: 30, dur: 0.28, vol: 0.16, attack: 0.01,
    dest: o.dest || busIn, attn: a,
  });
  return noiseVoice({
    t0: t + 0.04, dur: 0.22, vol: 0.06, filter: 'lowpass',
    f0: 900, f1: 220, q: 1.4, dest: o.dest || busIn, attn: a,
  });
}

function shriekLayer(o, a) { // duskwing: airy rise-and-fall over screeches
  return noiseVoice({
    dur: 0.38, vol: 0.06, filter: 'bandpass',
    f0: 800, fMid: 2400, fMidT: 0.14, f1: 1100, q: 4, attack: 0.05,
    dest: o.dest || busIn, attn: a,
  });
}

function bellowsLayer(o, a) { // monarch: sub swell + faint inharmonic partial
  const t = ctx.currentTime;
  toneVoice({
    t0: t, f0: 34, f1: 26, dur: 0.6, vol: 0.15, attack: 0.12,
    dest: o.dest || busIn, attn: a,
  });
  return toneVoice({
    t0: t, f0: 92, f1: 88, dur: 0.55, vol: 0.045, attack: 0.1,
    dest: o.dest || busIn, attn: a,
  });
}

const MACHINE_IDENTITY = {
  skitter: { pitch: 1.32, layer: chitterLayer },   // higher-pitched chitter
  ironmaw: { pitch: 0.72, layer: hydraulicLayer }, // low hydraulic thuds
  duskwing: { pitch: 1.12, layer: shriekLayer },   // emphasized screech sweeps
  monarch: { pitch: 0.55, layer: bellowsLayer },   // sub-bellows drone weight
};

/** Nearest machine to pos (any life state — death roars fire at death). */
function machineIdentityFor(pos) {
  if (!pos || !G.machines || !G.machines.length) return null;
  let best = null;
  let bestD2 = IDENTITY_RADIUS * IDENTITY_RADIUS;
  for (const m of G.machines) {
    if (!m || !m.group || !m.group.position) continue;
    const p = m.group.position;
    const dx = p.x - pos.x, dy = p.y - pos.y, dz = p.z - pos.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 <= bestD2) { bestD2 = d2; best = m; }
  }
  return best ? MACHINE_IDENTITY[best.type] || null : null;
}

function playIdentityLayer(idn, name, opts, attn) {
  // skip per-step character tails on light chassis (too busy); heavy ironmaw/
  // monarch footfalls deserve their layer on every step
  if (name === 'machineStep' && (idn.layer === chitterLayer || idn.layer === shriekLayer)) return;
  idn.layer(opts, attn);
}

// --------------------------------------------------------------- ambience --

function heartbeatBeat(t0) {
  const grant = ambienceVoice(0.4, 2); // lub-dub counts against the amb cap
  if (!grant) return;
  // lub-dub pair routed dry (no reverb) for intimacy
  toneVoice({ t0, f0: 58, f1: 38, dur: 0.13, vol: 0.3, attack: 0.005, dest: ambienceIn });
  toneVoice({ t0: t0 + 0.17, f0: 52, f1: 34, dur: 0.11, vol: 0.2, attack: 0.005, dest: ambienceIn });
}

function birdChirp(t0) {
  const grant = ambienceVoice(0.5, 1);
  if (!grant) return;
  const notes = 2 + Math.floor(Math.random() * 3);
  const base = 2300 + Math.random() * 1400;
  for (let i = 0; i < notes; i++) {
    const f = base * (0.9 + Math.random() * 0.35);
    toneVoice({ t0: t0 + i * 0.075, f0: f, f1: f * 1.25, dur: 0.055, vol: 0.028, attack: 0.008, dest: ambienceIn });
  }
}

function crickets(t0) {
  const grant = ambienceVoice(0.4, 1);
  if (!grant) return;
  const reps = 5 + Math.floor(Math.random() * 3);
  for (let i = 0; i < reps; i++) {
    toneVoice({
      t0: t0 + i * 0.048, type: 'square', f0: 4300 + Math.random() * 300,
      dur: 0.022, vol: 0.014, attack: 0.004, lpf: 6000, dest: ambienceIn,
    });
  }
}

function startAmbience() {
  const t = ctx.currentTime;

  // wind: looped noise -> lowpass, slow LFO on gain + second LFO on cutoff
  const windSrc = ctx.createBufferSource();
  windSrc.buffer = windBuf;
  windSrc.loop = true;
  const windLP = ctx.createBiquadFilter();
  windLP.type = 'lowpass';
  windLP.frequency.value = 380;
  windLP.Q.value = 0.4;
  windGain = ctx.createGain();
  windGain.gain.value = 0.05;
  const gustLfo = ctx.createOscillator();
  gustLfo.frequency.value = 0.07;
  const gustAmt = ctx.createGain();
  gustAmt.gain.value = 0.028;
  gustLfo.connect(gustAmt);
  gustAmt.connect(windGain.gain);
  const filtLfo = ctx.createOscillator();
  filtLfo.frequency.value = 0.113;
  const filtAmt = ctx.createGain();
  filtAmt.gain.value = 140;
  filtLfo.connect(filtAmt);
  filtAmt.connect(windLP.frequency);
  windSrc.connect(windLP);
  windLP.connect(windGain);
  windGain.connect(ambienceIn);
  windSrc.start(t);
  gustLfo.start(t);
  filtLfo.start(t);

  // drone pad: 2 detuned triangles at chord root + quiet sine fifth, lowpassed
  const padLP = ctx.createBiquadFilter();
  padLP.type = 'lowpass';
  padLP.frequency.value = 720;
  const padOut = ctx.createGain();
  padOut.gain.value = 0.045;
  padLP.connect(padOut);
  padOut.connect(calmGain); // v2: calm music layer, threat-crossfaded
  padOscRoot = ctx.createOscillator();
  padOscRoot.type = 'triangle';
  padOscRoot.frequency.value = CHORD_DAY.root;
  padOscDet = ctx.createOscillator();
  padOscDet.type = 'triangle';
  padOscDet.frequency.value = CHORD_DAY.root;
  padOscDet.detune.value = 7;
  padOscFifth = ctx.createOscillator();
  padOscFifth.type = 'sine';
  padOscFifth.frequency.value = CHORD_DAY.fifth;
  const gRoot = ctx.createGain();
  gRoot.gain.value = 0.5;
  const gDet = ctx.createGain();
  gDet.gain.value = 0.4;
  const gFifth = ctx.createGain();
  gFifth.gain.value = 0.22;
  padOscRoot.connect(gRoot);
  padOscDet.connect(gDet);
  padOscFifth.connect(gFifth);
  gRoot.connect(padLP);
  gDet.connect(padLP);
  gFifth.connect(padLP);
  padOscRoot.start(t);
  padOscDet.start(t);
  padOscFifth.start(t);

  nextBirdAt = t + 2 + Math.random() * 3;
  nextCricketAt = t + 2 + Math.random() * 2;
}

/** v2 continuous loops: explore/combat music layers + rain noise bed.
 *  One-shots (plucks, pulses, thunder) are scheduled from updateAudio. */
function startV2Loops() {
  const t = ctx.currentTime;

  // explore layer: gain node only; plucks are scheduled one-shots into it
  exploreGain = ctx.createGain();
  exploreGain.gain.value = 0;
  exploreGain.connect(musicIn);

  // combat layer: scheduled percussive pulses + continuous tense drone
  combatGain = ctx.createGain();
  combatGain.gain.value = 0;
  combatGain.connect(musicIn);
  droneOscA = ctx.createOscillator();
  droneOscA.type = 'sawtooth';
  droneOscA.frequency.value = 55;
  droneOscB = ctx.createOscillator();
  droneOscB.type = 'sawtooth';
  droneOscB.frequency.value = 55.6; // slow beat against A = unease
  const droneLP = ctx.createBiquadFilter();
  droneLP.type = 'lowpass';
  droneLP.frequency.value = 260;
  droneLP.Q.value = 0.8;
  const droneMix = ctx.createGain();
  droneMix.gain.value = 0.07;
  droneOscA.connect(droneLP);
  droneOscB.connect(droneLP);
  droneLP.connect(droneMix);
  droneMix.connect(combatGain);
  droneOscA.start(t);
  droneOscB.start(t);

  // rain bed: looped noise band-limited to hiss, gain follows G.weather
  const rainSrc = ctx.createBufferSource();
  rainSrc.buffer = windBuf;
  rainSrc.loop = true;
  const rainHP = ctx.createBiquadFilter();
  rainHP.type = 'highpass';
  rainHP.frequency.value = 450;
  const rainLP = ctx.createBiquadFilter();
  rainLP.type = 'lowpass';
  rainLP.frequency.value = 7000;
  rainGain = ctx.createGain();
  rainGain.gain.value = 0;
  rainSrc.connect(rainHP);
  rainHP.connect(rainLP);
  rainLP.connect(rainGain);
  rainGain.connect(ambienceIn);
  rainSrc.start(t);
  rainLPF = rainLP; // kept for Wave I intensity-linked cutoff glides

  // Wave I storm bed: same looped noise through a deep lowpass -> sub rumble;
  // gain rides storm intensity via setTargetAtTime only (never stepped)
  const stormSrc = ctx.createBufferSource();
  stormSrc.buffer = windBuf;
  stormSrc.loop = true;
  const stormLP = ctx.createBiquadFilter();
  stormLP.type = 'lowpass';
  stormLP.frequency.value = 140;
  stormLP.Q.value = 0.6;
  stormGain = ctx.createGain();
  stormGain.gain.value = 0;
  stormSrc.connect(stormLP);
  stormLP.connect(stormGain);
  stormGain.connect(ambienceIn);
  stormSrc.start(t);

  nextPluckAt = t + 1;
  nextPulseAt = t + 1;
}

/** v3 continuous boss layer: detuned saw pad through a breathing lowpass.
 *  War-drum one-shots are scheduled from updateAudio while the layer is up. */
function startV3Loops() {
  const t = ctx.currentTime;

  bossGain = ctx.createGain();
  bossGain.gain.value = 0;
  bossGain.connect(musicIn);

  // choir-ish pad: three detuned saws (beating unison + fifth) -> lowpass
  const padLP = ctx.createBiquadFilter();
  padLP.type = 'lowpass';
  padLP.frequency.value = 320;
  padLP.Q.value = 0.9;
  const padMix = ctx.createGain();
  padMix.gain.value = 0.055;
  padLP.connect(padMix);
  padMix.connect(bossGain);
  const specs = [
    { f: 55, det: -7 },    // A1
    { f: 55, det: 6 },     // slow beat against the first = unease
    { f: 82.41, det: -5 }, // E2 fifth
  ];
  for (let i = 0; i < specs.length; i++) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = specs[i].f;
    o.detune.value = specs[i].det;
    o.connect(padLP);
    o.start(t);
  }
  // slow cutoff LFO gives the pad a breathing quality
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.09;
  const lfoAmt = ctx.createGain();
  lfoAmt.gain.value = 110;
  lfo.connect(lfoAmt);
  lfoAmt.connect(padLP.frequency);
  lfo.start(t);

  nextDrumAt = t + 0.5;
}

// ---------------------------------------------------- v2 music / weather --

/** Smooth a GainNode toward value via setTargetAtTime (click-free). */
function glideGain(node, value, tc) {
  node.gain.setTargetAtTime(Math.max(0.0001, value), ctx.currentTime, tc);
}

/** Equalpower PannerNode at a world position. The listener sits on the player
 *  (see updateListener), so absolute coords on both sides give correct panning. */
function makePanner(pos) {
  const p = ctx.createPanner();
  p.panningModel = 'equalpower';
  p.distanceModel = 'linear';
  p.refDistance = 1;
  p.maxDistance = EAR_RANGE;
  p.rolloffFactor = 0; // no extra distance gain; sfx() attn already handles it
  if (p.positionX) {
    p.positionX.value = pos.x;
    p.positionY.value = pos.y;
    p.positionZ.value = pos.z;
  } else if (p.setPosition) {
    p.setPosition(pos.x, pos.y, pos.z); // legacy fallback
  }
  return p;
}

/** Keep the WebAudio listener on the player, oriented along the camera. */
function updateListener() {
  const L = ctx.listener;
  const pp = G.player && G.player.pos ? G.player.pos : null;
  const x = pp ? pp.x : 0, y = pp ? pp.y : 0, z = pp ? pp.z : 0;
  const fwd = G.cam && G.cam.forward ? G.cam.forward : null;
  const fx = fwd ? fwd.x : 0, fy = fwd ? fwd.y : 0, fz = fwd ? fwd.z : -1;
  if (L.positionX) {
    L.positionX.value = x;
    L.positionY.value = y;
    L.positionZ.value = z;
    if (L.forwardX) {
      L.forwardX.value = fx;
      L.forwardY.value = fy;
      L.forwardZ.value = fz;
      L.upX.value = 0;
      L.upY.value = 1;
      L.upZ.value = 0;
    }
  } else if (L.setPosition) {
    L.setPosition(x, y, z);
    if (L.setOrientation) L.setOrientation(fx, fy, fz, 0, 1, 0);
  }
}

// explore-layer plucks: gentle pentatonic sequence matching the pad chords
const PLUCK_DAY = [220.0, 246.94, 277.18, 329.63, 440.0];   // A3 B3 C#4 E4 A4
const PLUCK_NIGHT = [174.61, 196.0, 220.0, 261.63, 349.23]; // F3 G3 A3 C4 F4
const PLUCK_PATTERN = [0, 2, 1, -1, 3, 2, 4, -1];           // -1 = rest

function pluckNote(t0) {
  const step = PLUCK_PATTERN[pluckStep % PLUCK_PATTERN.length];
  pluckStep++;
  if (step < 0) return;
  const scale = lastDaylight >= 0.5 ? PLUCK_DAY : PLUCK_NIGHT;
  toneVoice({
    t0, type: 'triangle', f0: scale[step % scale.length], dur: 0.6,
    vol: 0.055, attack: 0.008, lpf: 1700, dest: exploreGain,
  });
}

// combat-layer pulse: low kick-ish thump + grit tick
function combatPulse(t0) {
  toneVoice({ t0, f0: 74, f1: 38, dur: 0.22, vol: 0.2, attack: 0.004, dest: combatGain });
  noiseVoice({ t0, dur: 0.08, vol: 0.09, filter: 'lowpass', f0: 260, q: 1, dest: combatGain });
}

// v3 boss war drum: low membrane hit (pitch-dropping sine + skin-noise tick)
function warDrum(t0) {
  toneVoice({ t0, f0: 88, f1: 42, dur: 0.34, vol: 0.34, attack: 0.004, dest: bossGain });
  noiseVoice({ t0, dur: 0.06, vol: 0.12, filter: 'lowpass', f0: 500, q: 1, dest: bossGain });
}

/** Thunder for a logged lightning strike: big filtered noise burst + sub sweep,
 *  delayed by strike distance (sound covers ~340 m/s) and quieter the farther
 *  the bolt landed. */
function thunderBoom(dist) {
  const d = clamp(dist != null ? dist : 120, 0, 300);
  const t = ctx.currentTime + Math.max(0.12, d / 340);
  const v = clamp(0.65 - d / 500, 0.1, 0.55);
  if (!ambienceVoice(2.6, 3)) return; // amb cap: a skipped boom is fine
  noiseVoice({
    t0: t, dur: 2.4, vol: v, filter: 'lowpass',
    f0: 900, fMid: 220, fMidT: 0.5, f1: 55, q: 0.6, attack: 0.02,
    dest: ambienceIn,
  });
  toneVoice({ t0: t, f0: 62, f1: 22, dur: 2.0, vol: v * 0.9, attack: 0.01, dest: ambienceIn });
  if (d < 110) { // close strike: sharp crack transient on top
    noiseVoice({
      t0: t, dur: 0.14, vol: v * 0.5, filter: 'highpass',
      f0: 1500, q: 0.7, attack: 0.002, dest: ambienceIn,
    });
  }
}

// ------------------------------------------------------------------ public --

/** Create/resume the AudioContext and build the graph. Safe to call often;
 *  a no-op until the first user gesture sets `unlocked` (autoplay policy). */
export function initAudio() {
  if (!ctx && !unlocked) return;
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return;
  }
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return;
  try {
    ctx = new AC();
  } catch (err) {
    ctx = null;
    return;
  }

  const st = G.settings;
  master = ctx.createGain();
  master.gain.value = 0.5 * clamp(st.master, 0, 1);
  master.connect(ctx.destination);

  // sfx volume stage: dry + reverb paths both pass through it
  sfxGain = ctx.createGain();
  sfxGain.gain.value = clamp(st.sfx, 0, 1);
  sfxGain.connect(master);

  busIn = ctx.createGain();
  busIn.gain.value = 1;
  busIn.connect(sfxGain); // dry path

  // generated reverb: exponential-decay noise impulse, wet ~0.18
  const conv = ctx.createConvolver();
  conv.buffer = makeImpulse(1.6, 2.6);
  const wet = ctx.createGain();
  wet.gain.value = 0.18;
  busIn.connect(wet);
  wet.connect(conv);
  conv.connect(sfxGain);

  ambienceIn = ctx.createGain();
  ambienceIn.gain.value = 0.9;
  ambienceIn.connect(master); // ambience stays dry

  // music bus: calm pad + explore/combat layers, governed by settings.music
  musicIn = ctx.createGain();
  musicIn.gain.value = 0.9 * clamp(st.music, 0, 1);
  musicIn.connect(master);
  calmGain = ctx.createGain();
  calmGain.gain.value = 1;
  calmGain.connect(musicIn);

  noiseBuf = makeNoiseBuffer(1.5);
  windBuf = makeNoiseBuffer(4);
  startAmbience();
  startV2Loops();
  startV3Loops();
  // Wave I: positional emitter pool rides this context (idempotent inside;
  // re-created only if the ctx ever changes)
  createEmitters({ ctx, destination: busIn });

  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}

/** Positional attenuation relative to the player: 1 near, 0 at EAR_RANGE. */
function posAttenuation(pos) {
  if (!pos || !G.player || !G.player.pos) return 1;
  const pp = G.player.pos;
  const dx = pp.x - pos.x, dy = pp.y - pos.y, dz = pp.z - pos.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return clamp(1 - d / EAR_RANGE, 0, 1);
}

// ------------------------------------------------- Wave I surface footsteps --

/** Cheap surface classification under the player: water when wading at/below
 *  the waterline, else biome flavor (highland rock, forest litter, packed
 *  earth elsewhere). biomeAt is a pure (x,z) lookup — no geometry passes. */
function classifySurface() {
  const p = G.player;
  if (!p || !p.pos) return 'soil';
  if (p.pos.y <= CONFIG.waterLevel + 0.25) return 'water';
  let biome = 'meadow';
  try { biome = biomeAt(p.pos.x, p.pos.z) || 'meadow'; } catch (_err) { /* keep default */ }
  if (biome === 'highland') return 'stone';
  if (biome === 'forest') return 'forest';
  return 'soil'; // meadow + sandy shore both read as packed earth
}

const STEP_SYNTHS = { soil: 'stepSoil', forest: 'stepForest', stone: 'stepStone', water: 'stepWater' };

/** Play one footstep for the current surface (non-positional: it IS the player). */
function playFootstep(running) {
  sfx(STEP_SYNTHS[classifySurface()] || 'stepSoil', { running: !!running });
}

// ------------------------------------------------------------ voice pool --
// Central accounting for one-shot voices. Grants are capped globally
// (MAX_VOICES) and per category (VOICE_CAPS); a saturated category steals its
// oldest lowest-priority live voice. Time-based expiry keeps the registry in
// sync even when a synth returns no single long-lived source node.

/** Drop expired records; returns nothing. Cheap: list is tiny (<= ~24). */
function pruneVoices() {
  const now = ctx ? ctx.currentTime : 0;
  for (let i = voiceReg.length - 1; i >= 0; i--) {
    const r = voiceReg[i];
    if (!r.done && now >= r.end) finishVoice(r);
  }
}

/** Close out a record exactly once: unlink + stop any stolen source. */
function finishVoice(r) {
  if (r.done) return;
  r.done = true;
  const idx = voiceReg.indexOf(r);
  if (idx >= 0) voiceReg.splice(idx, 1);
  voices = Math.max(0, voices - 1);
  if (r.src && r.stolen) {
    // Stolen mid-flight: detach onended first so the natural stop doesn't
    // re-enter accounting, then hard-stop the source.
    try { r.src.onended = null; } catch (_e) { /* node already gone */ }
    try { r.src.stop(); } catch (_e) { /* already stopped */ }
  }
}

/**
 * Reserve a voice slot. Returns a record or null when denied (global cap hit,
 * or the category is saturated and every live voice outranks `prio`).
 * `src` may be attached later via grant.src = ... by the caller.
 */
function acquireVoice(cat, prio, dur) {
  pruneVoices();
  if (voices >= MAX_VOICES) return null;
  const cap = VOICE_CAPS[cat] != null ? VOICE_CAPS[cat] : MAX_VOICES;
  let used = 0;
  for (const r of voiceReg) if (r.cat === cat) used++;
  if (used >= cap) {
    // steal-oldest-lowest-priority within this category only
    let victim = null;
    for (const r of voiceReg) {
      if (r.cat !== cat || r.done) continue;
      if (r.prio < prio && (!victim || r.prio < victim.prio ||
          (r.prio === victim.prio && r.t0 < victim.t0))) victim = r;
    }
    if (!victim) return null;
    voicesStolen++;
    victim.stolen = true; // finishVoice hard-stops stolen sources
    finishVoice(victim);
  }
  const rec = {
    cat, prio, t0: ctx.currentTime,
    end: ctx.currentTime + Math.max(0.05, dur || 0.5),
    src: null, stolen: false, done: false,
  };
  voiceReg.push(rec);
  voices++;
  return rec;
}

/** Release a granted slot early (natural end or failed synth). */
function releaseVoiceRec(rec) {
  if (!rec) return;
  rec.stolen = false; // natural release: don't hard-stop the source
  finishVoice(rec);
}

/** Register an ambient tone batch (no single src node; time-expiring only). */
function ambienceVoice(dur, prio) {
  return acquireVoice('ambience', prio != null ? prio : DEFAULT_PRIO.ambience, dur);
}

/** Play a named one-shot. No-op before initAudio(); capped at MAX_VOICES and
 *  per-category voice caps (steal-oldest-lowest-priority); payload opts.pos
 *  attenuates volume by distance to G.player.pos and pans the voice through an
 *  equalpower PannerNode placed at that world position; opts.priority (0..9)
 *  protects the voice from category stealing. Sample-bank aware: a registered
 *  buffer with the synth's name plays instead of the synth (Wave I fallback
 *  path; the bank starts empty so behavior is synthesized-only until an asset
 *  pipeline calls setSampleBank). Machine voices get per-type pitch/filter
 *  identity shaping derived from the nearest machine to opts.pos. */
export function sfx(name, opts = {}) {
  if (!ctx) return;
  const fn = SYNTHS[name];
  if (!fn) return;
  pruneVoices();
  if (voices >= MAX_VOICES) return;
  const cat = SFX_CATEGORY[name] || 'combat';
  const prio = opts.priority != null ? clamp(opts.priority, 0, 9) : DEFAULT_PRIO[cat];
  const attn = posAttenuation(opts.pos);
  if (attn <= 0.02) return; // out of earshot
  const grant = acquireVoice(cat, prio, SYNTH_DUR[name]);
  if (!grant) return; // category saturated and nothing stealable
  // positional one-shots: manual attn stays authoritative, so the panner's own
  // distance model is neutralized (rolloff 0 => pure stereo panning)
  let panner = null;
  let voiceOpts = opts;
  if (opts.pos) {
    try {
      panner = makePanner(opts.pos);
      panner.connect(busIn);
      voiceOpts = Object.assign({}, opts, { dest: panner });
    } catch (err) {
      panner = null;
      voiceOpts = opts;
    }
  }
  // machine identity shaping: nearest machine wins; scale helper pitches and
  // add a character layer while the base synth runs (synchronous window, so a
  // module-level pitch scalar cannot interleave with other calls)
  const idn = MACHINE_VOICES.has(name) ? machineIdentityFor(opts.pos) : null;
  if (idn && idn.pitch !== 1) _pitchScale = idn.pitch;
  let src = null;
  try {
    src = playSampleOrSynth(name, fn, voiceOpts, attn);
  } catch (_err) {
    // audio must never break gameplay; src stays null (its init value)
  } finally {
    if (idn && idn.pitch !== 1) _pitchScale = 1;
  }
  if (src && idn) {
    try { playIdentityLayer(idn, name, voiceOpts, attn); } catch (_err) { /* cosmetic layer */ }
  }
  grant.src = src;
  if (src) {
    src.onended = () => {
      if (panner) {
        try { panner.disconnect(); } catch (_err) { /* already gone */ }
      }
      releaseVoiceRec(grant);
    };
  } else {
    if (panner) {
      try { panner.disconnect(); } catch (_err) { /* already gone */ }
    }
    releaseVoiceRec(grant);
  }
}

/** Per-frame ambience scheduling. Cheap; safe to call before initAudio().
 *  _dt is unused here (all timing runs off the audio clock). */
export function updateAudio(_dt) {
  if (!ctx) return;
  const t = ctx.currentTime;

  // daylight factor from G.timeOfDay ([0,1], 0.5 = noon; default day)
  const tod = clamp(typeof G.timeOfDay === 'number' ? G.timeOfDay : 0.5, 0, 1);
  const daylight = smoothstep(0.3, 0.42, tod) * (1 - smoothstep(0.58, 0.7, tod));

  // glide drone chord between night F-C and day A-E
  if (Math.abs(daylight - lastDaylight) > 0.003) {
    lastDaylight = daylight;
    const root = lerp(CHORD_NIGHT.root, CHORD_DAY.root, daylight);
    const fifth = lerp(CHORD_NIGHT.fifth, CHORD_DAY.fifth, daylight);
    padOscRoot.frequency.setTargetAtTime(root, t, 2.5);
    padOscDet.frequency.setTargetAtTime(root, t, 2.5);
    padOscFifth.frequency.setTargetAtTime(fifth, t, 2.5);
  }

  // v2: listener follows the player so positional one-shots pan correctly.
  // Wave I: emitters.js then refines ORIENTATION from G.camera when present
  // (see updateEmitters — position stays on the stable player-feet baseline).
  updateListener();
  updateEmitters(_dt);

  // Wave I adaptive escalation: calm -> tense -> combat (+ boss override) with
  // hysteresis, so a threat signal flickering near a threshold can no longer
  // stutter the layer gains every frame. Enter combat at threat >= 0.55 and
  // fall back to tense only at <= 0.35; tense brackets calm at 0.18/0.10.
  const active = G.started && !G.paused && !G.gameOver;
  const threat = clamp(G.threat || 0, 0, 1);
  if (!active) {
    combatTier = 'calm'; // pause/death resets escalation; gains duck below anyway
  } else if (G.bossNear) {
    combatTier = 'boss';
  } else if (combatTier === 'calm' && threat >= 0.18) {
    combatTier = 'tense';
  } else if (combatTier === 'tense' && threat >= 0.55) {
    combatTier = 'combat';
  } else if (combatTier === 'tense' && threat <= 0.1) {
    combatTier = 'calm';
  } else if (combatTier === 'combat' && threat <= 0.35) {
    combatTier = 'tense';
  } else if (combatTier === 'boss' && !G.bossNear) {
    combatTier = threat >= 0.55 ? 'combat' : 'tense';
  }
  const inCombat = combatTier === 'combat' || combatTier === 'boss';

  // v2: threat-driven music crossfade (calm pad / explore / combat), now tiered.
  // The old continuous curves were already smooth, so only the combat layer's
  // abrupt threshold crossing needed smoothing — done via the slower glide tc.
  const calmT = (1 - threat) * 1.5 * (inCombat ? 0.45 : 1); // duck pad under pulses
  const expT = inCombat ? 0 : smoothstep(0.15, 0.3, threat) * (1 - smoothstep(0.6, 0.85, threat));
  const comT = active && inCombat ? 1 : 0;
  if (Math.abs(calmT - lastCalmT) > 0.01) { lastCalmT = calmT; glideGain(calmGain, calmT, 0.6); }
  if (Math.abs(expT - lastExpT) > 0.01) { lastExpT = expT; glideGain(exploreGain, expT, 0.6); }
  if (Math.abs(comT - lastComT) > 0.01) { lastComT = comT; glideGain(combatGain, comT, 0.9); }

  // explore plucks / combat pulses: lookahead-scheduled only while audible
  if (active && exploreGain && exploreGain.gain.value > 0.02) {
    if (nextPluckAt < t - 0.25) nextPluckAt = t + 0.1; // resync after tab-hidden gaps
    while (nextPluckAt <= t + 0.12) {
      pluckNote(nextPluckAt);
      nextPluckAt += 0.44 + Math.random() * 0.1;
    }
  } else {
    nextPluckAt = t + 0.1;
  }
  if (active && combatGain && combatGain.gain.value > 0.02) {
    if (nextPulseAt < t - 0.25) nextPulseAt = t + 0.1;
    while (nextPulseAt <= t + 0.12) {
      combatPulse(nextPulseAt);
      nextPulseAt += 0.5;
    }
  } else {
    nextPulseAt = t + 0.1;
  }

  // v3: boss proximity layer — crossfade war drums + saw pad on G.bossNear
  const bossT = active && G.bossNear ? 0.9 : 0; // duck choir on pause/death
  if (bossGain && Math.abs(bossT - lastBossT) > 0.01) {
    lastBossT = bossT;
    glideGain(bossGain, bossT, 0.8); // smooth setTargetAtTime both ways
  }
  if (active && bossGain && bossGain.gain.value > 0.02) {
    if (nextDrumAt < t - 0.25) nextDrumAt = t + 0.1; // resync after tab-hidden gaps
    while (nextDrumAt <= t + 0.12) {
      warDrum(nextDrumAt);
      nextDrumAt += 0.9;
    }
  } else {
    nextDrumAt = t + 0.1;
  }

  // v2: weather loops — rain bed level + thunder booms off the strike log
  const w = G.weather;
  if (w && rainGain) {
    const rainy = w.type === 'rain' || w.type === 'storm';
    const rainT = rainy ? clamp(w.intensity, 0, 1) * 0.16 : 0;
    if (Math.abs(rainT - lastRainT) > 0.004) { lastRainT = rainT; glideGain(rainGain, rainT, 0.5); }
    // Wave I: intensity-linked crossfades only from here down — every change
    // rides setTargetAtTime so weather transitions never click or jump.
    // Rain brightness opens up with intensity (his -> downpour sheet).
    if (rainLPF) {
      rainLPF.frequency.setTargetAtTime(lerp(4500, 7500, clamp(w.intensity, 0, 1)), t, 0.8);
    }
    // Storm sub-rumble bed fades with storm intensity, out when not stormy.
    if (stormGain) {
      const stormT = w.type === 'storm' ? clamp(w.intensity, 0, 1) * 0.055 : 0;
      if (Math.abs(stormT - lastStormT) > 0.004) { lastStormT = stormT; glideGain(stormGain, stormT, 1.2); }
    }
    // Wind loudness tracks the live weather wind + gust field (the LFO wired
    // to this param at init only adds a small idle wobble on top).
    if (windGain) {
      const windT = 0.03 + clamp(w.wind, 0, 1) * 0.05 + (w.gust || 0) * 0.02;
      glideGain(windGain, windT, 0.6);
    }
    // weather.js logs each bolt (lastStrikeAt/lastStrikeDist); boom once per
    // entry, delayed/volume'd by distance, with a min-gap for clustered bolts
    if (typeof w.lastStrikeAt === 'number' && w.lastStrikeAt > lastHandledStrikeAt) {
      lastHandledStrikeAt = w.lastStrikeAt;
      if (t - lastThunderAt > 4) {
        lastThunderAt = t;
        thunderBoom(w.lastStrikeDist);
      }
    }
  }

  // day birds / night crickets
  if (daylight > 0.5 && t >= nextBirdAt) {
    birdChirp(t + 0.05);
    nextBirdAt = t + 2 + Math.random() * 3;
  }
  if (daylight < 0.2 && t >= nextCricketAt) {
    crickets(t + 0.05);
    nextCricketAt = t + 1.3 + Math.random() * 1.2;
  }

  // Wave I: surface-aware footsteps — distance-accumulator stride driver over
  // the player's horizontal motion. The player controller may ALSO emit the
  // 'footstep' bus event; when those arrive we back off for 0.45s so steps
  // never double up (event-driven wins, self-driver stays as fallback).
  const pStep = G.player;
  if (active && pStep && pStep.pos && !pStep.dead) {
    const dx = pStep.pos.x - lastStepX;
    const dz = pStep.pos.z - lastStepZ;
    lastStepX = pStep.pos.x;
    lastStepZ = pStep.pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 3) stepAccum += dist; // >3m/frame is a teleport, not a stride
    const running = !!pStep.sprinting;
    const strideLen = running ? 2.6 : 2.0; // walk ~6u/s -> ~3 steps/s
    if (stepAccum >= strideLen && t - lastBusStepAt > 0.45) {
      stepAccum = 0;
      playFootstep(running);
    }
  } else {
    stepAccum = 0;
    lastStepX = pStep && pStep.pos ? pStep.pos.x : lastStepX;
    lastStepZ = pStep && pStep.pos ? pStep.pos.z : lastStepZ;
  }

  // Wave I: damaged-machine metal-stress beds — periodic positional creaks per
  // tracked machine ('machineDamaged' registers; heal/death/disposal detaches).
  // Poll-based detach because machines expose no 'healed' event.
  if (active && stressBeds.size) {
    for (const [m, nextAt] of stressBeds) {
      const gone = !m || !m.group || !m.alive || !m.group.parent ||
        (typeof m.maxHp === 'number' && m.hp >= m.maxHp);
      if (gone) { stressBeds.delete(m); continue; }
      if (t < nextAt) continue;
      const frac = m.maxHp > 0 ? clamp(1 - m.hp / m.maxHp, 0, 1) : 0.5;
      sfx('stressCreak', {
        pos: m.group.position,
        priority: 2,
        vol: clamp(0.04 + frac * 0.09, 0.02, 0.16),
      });
      stressBeds.set(m, t + 2.2 + Math.random() * 2.6);
    }
  }

  // heartbeat while hp < 25% (two low thumps per second)
  const p = G.player;
  const low = G.started && !G.gameOver && !G.paused && p && !p.dead &&
    p.maxHp > 0 && p.hp / p.maxHp < 0.25;
  if (low) {
    if (nextBeatAt < 0) nextBeatAt = t + 0.15;
    // resync after tab-hidden gaps instead of stacking overdue beats
    if (nextBeatAt < t - 0.25) nextBeatAt = t + 0.05;
    while (nextBeatAt <= t + 0.12) {
      heartbeatBeat(nextBeatAt);
      nextBeatAt += 1.0;
    }
  } else {
    nextBeatAt = -1;
  }
}

// ------------------------------------------------------------- bus wiring --

bus.on('arrowFired', (p) => sfx('bowRelease', { power: p ? p.power : 1 }));
bus.on('machineHit', (p) => {
  if (!p) return;
  if (p.weak) sfx('arrowHitMetal', { pos: p.point });
  else sfx('arrowHitFlesh', { pos: p.point });
});
bus.on('partBroken', (p) => {
  const pos = p && p.machine && p.machine.group ? p.machine.group.position : null;
  sfx('weakBreak', { pos });
});
bus.on('machineDied', (p) => {
  const pos = p ? p.pos : null;
  sfx('machineDeath', { pos });
  sfx('machineGrowl', { pos, size: 1.7 }); // layered dying roar
});
bus.on('machineAlert', (p) => {
  const pos = p ? p.pos : null;
  sfx('machineAlert', { pos }); // AI spot/telegraph chirp (emitted by machines/ai.js)
});
bus.on('playerHit', () => sfx('playerHurt'));
bus.on('playerHealed', () => sfx('playerHeal'));
bus.on('pickup', (p) => sfx('pickup', { type: p ? p.type : null }));
bus.on('craft', () => sfx('craft'));
bus.on('skillUp', () => sfx('skillUp'));
bus.on('expeditionStarted', () => sfx('uiOpen'));
bus.on('expeditionCompleted', () => sfx('victorySting'));
bus.on('expeditionExpired', () => sfx('uiClose'));

// Wave I contract events -----------------------------------------------------

// Impact categories: material-appropriate knock/thud/splash layered onto the
// existing hit sounds (combat FX emits 'impact' alongside 'machineHit').
const IMPACT_SYNTHS = {
  metal: 'impactMetal', stone: 'impactStone', soil: 'impactSoil',
  wood: 'impactWood', water: 'impactWater',
};
bus.on('impact', (p) => {
  if (!p) return;
  const name = IMPACT_SYNTHS[p.material];
  if (!name) return;
  sfx(name, { pos: p.pos || null, strength: typeof p.strength === 'number' ? p.strength : 1 });
});

// Damaged-machine tracking for the positional metal-stress bed. Detach happens
// in updateAudio (heal/death/disposal) since machines expose no healed event.
bus.on('machineDamaged', (p) => {
  const m = p && p.machine;
  if (!m || !m.group) return;
  if (!stressBeds.has(m) && stressBeds.size >= 6) {
    stressBeds.delete(stressBeds.keys().next().value); // evict oldest tracked
  }
  stressBeds.set(m, ctx ? ctx.currentTime + 0.6 : 0); // first creak shortly after
});

// Controller-driven footsteps (contract event, no pos: it IS the player).
// Timestamp suppresses the local stride driver so steps never double up.
bus.on('footstep', (p) => {
  lastBusStepAt = ctx ? ctx.currentTime : 0;
  const surf = p && p.surface ? STEP_SYNTHS[p.surface] : null;
  sfx(surf || 'stepSoil', { running: !!(p && p.running) });
});

// v3: victory sting on kill streaks of 3+, spear melee whoosh/thud, level fanfare
bus.on('killStreak', (p) => {
  if (p && p.count >= 3) sfx('victorySting');
});
bus.on('meleeSwing', (p) => sfx('meleeWhoosh', { hit: !!(p && p.hit) }));
bus.on('levelUp', () => sfx('levelUp'));
bus.on('ui', (p) => {
  const act = p && p.action ? p.action : '';
  if (/open/i.test(act)) sfx('uiOpen');
  else if (/close/i.test(act)) sfx('uiClose');
  else sfx('uiClick'); // covers 'start' and any unknown action
});

// v2: live volume application — master/music/sfx adjust their GainNodes at once;
// sens/invertY/quality are not audio concerns and are ignored here.
bus.on('settingsChanged', (p) => {
  if (!ctx || !p) return;
  const v = typeof p.value === 'number' && isFinite(p.value)
    ? clamp(p.value, 0, 1)
    : null;
  if (v == null) return;
  if (p.key === 'master') glideGain(master, 0.5 * v, 0.03);
  else if (p.key === 'music') glideGain(musicIn, 0.9 * v, 0.03);
  else if (p.key === 'sfx') glideGain(sfxGain, v, 0.03);
});

// ------------------------------------------------------------ Wave I public --

/** Place a synthesized voice at a world position through the shared PannerNode
 *  pool (see emitters.js). synthFn receives { dest, pos, category, priority }
 *  and must return its longest-lived source node (or null). opts: {priority,
 *  ttl}. Returns the source node, or null before initAudio()/when saturated. */
export function emitAt(pos, category, synthFn, opts = {}) {
  return emitterEmitAt(pos, category, synthFn, opts);
}

/** Perf-HUD voice diagnostics: global + per-category occupancy vs caps,
 *  cumulative steals, and nested emitter-pool stats. */
export function getVoiceStats() {
  pruneVoices();
  const byCategory = { ambience: 0, machine: 0, combat: 0, ui: 0 };
  for (const r of voiceReg) if (byCategory[r.cat] != null) byCategory[r.cat]++;
  return {
    total: voices,
    max: MAX_VOICES,
    caps: Object.assign({}, VOICE_CAPS),
    byCategory,
    stolen: voicesStolen,
    emitters: getEmitterStats(),
    ready: !!ctx,
  };
}

// Perf HUD contract: publish the getter itself. Absence of window (tests/SSR)
// is tolerated everywhere — nothing may assume this property exists.
if (typeof window !== 'undefined') window.__IW_AUDIO_STATS = getVoiceStats;

// unlock hooks: browsers refuse to start an AudioContext created before a real
// user gesture, so the first pointerdown/keydown flips `unlocked` and builds
// the graph (boot-time initAudio() calls stay cheap no-ops until then).
// Listeners persist so a later suspend gets resumed too.
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => { unlocked = true; initAudio(); });
  window.addEventListener('keydown', () => { unlocked = true; initAudio(); });
  // returning to a visible tab can leave the context suspended/interrupted
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  });
}
