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

import { bus } from '../core/events.js';
import { G } from '../core/state.js';
import { clamp, lerp, smoothstep } from '../core/utils.js';

const MAX_VOICES = 24; // hard cap on simultaneous one-shot voices
const EAR_RANGE = 60;  // positional falloff distance in world units

let ctx = null;         // AudioContext, created lazily by initAudio()
let master = null;      // master gain (0.5 * settings.master) -> destination
let busIn = null;       // entry point for all one-shot sfx (dry + reverb send)
let ambienceIn = null;  // entry point for ambience loops (skips reverb)
let noiseBuf = null;    // shared 1.5s white-noise buffer for bursts
let windBuf = null;     // 4s looped noise buffer for wind
let voices = 0;         // live one-shot voice count
let unlocked = false;   // set by the first real user gesture (hooks at EOF)

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
 *  detune cents, lpf = inline lowpass frequency to soften raw waveforms. */
function toneVoice(o) {
  const t0 = o.t0 != null ? o.t0 : ctx.currentTime;
  const dur = o.dur != null ? o.dur : 0.2;
  const osc = ctx.createOscillator();
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(Math.max(1, o.f0), t0);
  if (o.f1 != null && o.f1 !== o.f0) {
    const gt = o.glideT != null ? o.glideT : dur;
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t0 + gt);
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
 *  type + f0->fMid (at fMidT)->f1 sweep, q, random offset for variety. */
function noiseVoice(o) {
  const t0 = o.t0 != null ? o.t0 : ctx.currentTime;
  const dur = o.dur != null ? o.dur : 0.2;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  if (dur > noiseBuf.duration) src.loop = true; // long beds wrap instead of truncating
  const off = o.offset != null ? o.offset : Math.random() * Math.max(0, noiseBuf.duration - dur - 0.1);
  const f = ctx.createBiquadFilter();
  f.type = o.filter || 'lowpass';
  f.frequency.setValueAtTime(Math.max(20, o.f0 != null ? o.f0 : 1000), t0);
  if (o.fMid != null) {
    f.frequency.exponentialRampToValueAtTime(Math.max(20, o.fMid), t0 + (o.fMidT != null ? o.fMidT : dur * 0.5));
  }
  if (o.f1 != null && o.f1 !== o.f0) {
    f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t0 + dur);
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
};

// --------------------------------------------------------------- ambience --

function heartbeatBeat(t0) {
  // lub-dub pair routed dry (no reverb) for intimacy
  toneVoice({ t0, f0: 58, f1: 38, dur: 0.13, vol: 0.3, attack: 0.005, dest: ambienceIn });
  toneVoice({ t0: t0 + 0.17, f0: 52, f1: 34, dur: 0.11, vol: 0.2, attack: 0.005, dest: ambienceIn });
}

function birdChirp(t0) {
  const notes = 2 + Math.floor(Math.random() * 3);
  const base = 2300 + Math.random() * 1400;
  for (let i = 0; i < notes; i++) {
    const f = base * (0.9 + Math.random() * 0.35);
    toneVoice({ t0: t0 + i * 0.075, f0: f, f1: f * 1.25, dur: 0.055, vol: 0.028, attack: 0.008, dest: ambienceIn });
  }
}

function crickets(t0) {
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

function releaseVoice() {
  voices = Math.max(0, voices - 1);
}

/** Play a named one-shot. No-op before initAudio(); capped at MAX_VOICES;
 *  payload opts.pos attenuates volume by distance to G.player.pos and pans
 *  the voice through an equalpower PannerNode placed at that world position. */
export function sfx(name, opts = {}) {
  if (!ctx) return;
  const fn = SYNTHS[name];
  if (!fn) return;
  if (voices >= MAX_VOICES) return;
  const attn = posAttenuation(opts.pos);
  if (attn <= 0.02) return; // out of earshot
  voices++;
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
  let src = null;
  try {
    src = fn(voiceOpts, attn);
  } catch (err) {
    // audio must never break gameplay
  }
  if (src) {
    src.onended = () => {
      if (panner) {
        try { panner.disconnect(); } catch (_err) { /* already gone */ }
      }
      releaseVoice();
    };
  } else {
    if (panner) {
      try { panner.disconnect(); } catch (_err) { /* already gone */ }
    }
    releaseVoice();
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

  // v2: listener follows the player so positional one-shots pan correctly
  updateListener();

  // v2: threat-driven music crossfade (calm pad / explore / combat)
  const active = G.started && !G.paused && !G.gameOver;
  const threat = clamp(G.threat || 0, 0, 1);
  const calmT = (1 - threat) * 1.5; // >1 base offsets the quieter music bus
  const expT = smoothstep(0.15, 0.3, threat) * (1 - smoothstep(0.6, 0.85, threat));
  const comT = active ? smoothstep(0.5, 0.8, threat) : 0; // duck drone on pause/death
  if (Math.abs(calmT - lastCalmT) > 0.01) { lastCalmT = calmT; glideGain(calmGain, calmT, 0.6); }
  if (Math.abs(expT - lastExpT) > 0.01) { lastExpT = expT; glideGain(exploreGain, expT, 0.6); }
  if (Math.abs(comT - lastComT) > 0.01) { lastComT = comT; glideGain(combatGain, comT, 0.6); }

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
