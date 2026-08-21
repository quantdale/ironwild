// IRONWILD - production asset manifest (Wave B).
// Data-only registry of authored GLB assets. Final binaries do not exist yet;
// every entry declares its CANONICAL drop-in location so a finished GLB just
// needs to be copied to `ASSET_ROOT + <category>/<id>.glb` - no loader code
// changes. Until then systems/assets.js routes every miss to the procedural
// fallback (entry.fallback === 'procedural'); nothing here is fetched at boot
// because every entry is a url:null placeholder with preload:false - load()
// rejects fast without touching any loader until a real url is authored.
//
// Authoring rules (mirrored in ASSET_CONVENTIONS, enforced loosely by
// systems/assets.js at runtime):
//   - 1 unit = 1 m, Y-up, -Z forward (three.js native, no conversion).
//   - Attachment points are empty nodes named `socket_<part>`.
//   - Weak-point hit volumes are nodes tagged `wp_<part>`.
//   - LOD levels are direct children suffixed `_lod0/_lod1/_lod2`, or whole
//     files listed in `lods` (index == level).
//   - AnimationClips carry the exact names below; extra clips are allowed and
//     still exposed, but only these are referenced by gameplay code.
//   - Material names starting with an `m_<class>` tag drive impact SFX/VFX
//     classing downstream (see the 'impact' bus event material enum).

export const ASSET_ROOT = '/assets/';

export const ASSET_CONVENTIONS = {
  unit: '1u = 1m',
  upAxis: 'Y-up',
  forward: '-Z',
  socketPrefix: 'socket_',
  weakPointTag: 'wp_',
  lodSuffixes: ['_lod0', '_lod1', '_lod2'],
  // Canonical clip vocabulary. Locomotion = `loc_*`, actions = `act_*`,
  // reactions = `react_*`.
  clips: [
    'loc_idle', 'loc_walk_fwd', 'loc_run_fwd', 'loc_crouch_fwd', 'loc_swim_fwd',
    'act_bow_draw', 'act_bow_release', 'act_spear_thrust', 'act_dodge',
    'react_hit', 'react_death',
  ],
  // Material class tags -> 'impact' bus event material enum:
  //   m_steel->metal  m_ceramic->stone  m_rust->metal  m_rubber->soil
  //   m_emissive->metal (armored glow plates ring like steel).
  materialClasses: ['m_steel', 'm_ceramic', 'm_rust', 'm_rubber', 'm_emissive'],
};

/**
 * Look up a manifest entry by id across all categories. Returns the entry
 * object or undefined for unknown ids (callers decide how to fail).
 */
export function getEntry(id) {
  if (typeof id !== 'string' || !id) return undefined;
  for (const category of Object.values(ASSET_MANIFEST)) {
    if (category[id]) return category[id];
  }
  return undefined;
}

/**
 * The manifest. Field contract per entry:
 *   id          stable lookup key (== object key)
 *   url         canonical .glb path, or null while the binary is unauthored
 *   lods        per-level .glb urls (index == level) or null = single file
 *   clips       clip names gameplay expects to find (missing ones degrade,
 *               extras are still exposed via userData.clips)
 *   sockets     expected `socket_*` node names (missing ones tolerated)
 *   weakPoints  [{name, tag}] display name + `wp_*` node tag
 *   draco       true if the binary needs the DRACO decoder path
 *   fallback    'procedural' - what spawn code uses when load/instantiate fails
 *   preload     true to fetch during boot warmup (kept false until binaries ship)
 */
export const ASSET_MANIFEST = {
  machines: {
    skitter: {
      id: 'skitter',
      // url:null = binary not authored yet. The pipeline treats this as a
      // permanent placeholder state (never fetches, never marks failed); when
      // art lands, restore the canonical path 'machines/skitter.glb' below.
      // Keeping nulls here is what makes zero-asset boot deterministic.
      url: null, // ASSET_ROOT + 'machines/skitter.glb'
      lods: null,
      clips: ['loc_idle', 'loc_walk_fwd', 'loc_run_fwd', 'react_hit', 'react_death'],
      sockets: ['socket_jaw'],
      weakPoints: [{ name: 'eye', tag: 'wp_eye' }],
      draco: false,
      fallback: 'procedural',
      preload: false,
    },
    ironmaw: {
      id: 'ironmaw',
      // Unauthored placeholder - see skitter note above.
      url: null, // ASSET_ROOT + 'machines/ironmaw.glb'
      lods: null,
      clips: ['loc_idle', 'loc_walk_fwd', 'loc_run_fwd', 'react_hit', 'react_death'],
      sockets: ['socket_jaw', 'socket_spine'],
      weakPoints: [{ name: 'maw', tag: 'wp_maw' }, { name: 'radiator', tag: 'wp_radiator' }],
      draco: false,
      fallback: 'procedural',
      preload: false,
    },
    duskwing: {
      // Aerial machine: ground locomotion clips are expected-but-optional;
      // authored kit may replace them with flight cycles under the same names.
      id: 'duskwing',
      // Unauthored placeholder - see skitter note above.
      url: null, // ASSET_ROOT + 'machines/duskwing.glb'
      lods: null,
      clips: ['loc_idle', 'loc_walk_fwd', 'loc_run_fwd', 'react_hit', 'react_death'],
      sockets: ['socket_beak'],
      weakPoints: [{ name: 'chest', tag: 'wp_chest' }],
      draco: false,
      fallback: 'procedural',
      preload: false,
    },
  },
  player: {
    hunter: {
      id: 'hunter',
      // Unauthored placeholder - see skitter note above.
      url: null, // ASSET_ROOT + 'player/hunter.glb'
      lods: null,
      clips: [
        'loc_idle', 'loc_walk_fwd', 'loc_run_fwd', 'loc_crouch_fwd', 'loc_swim_fwd',
        'act_bow_draw', 'act_bow_release', 'act_spear_thrust', 'act_dodge',
        'react_hit', 'react_death',
      ],
      sockets: ['socket_hand_r', 'socket_hand_l', 'socket_back', 'socket_hips'],
      weakPoints: [], // player is not a shootable machine
      draco: false,
      fallback: 'procedural',
      preload: false,
    },
  },
  env: {
    ruin_kit: {
      // Static kit of modular ruin pieces; no animation, no sockets.
      id: 'ruin_kit',
      // Unauthored placeholder - see skitter note above.
      url: null, // ASSET_ROOT + 'env/ruin_kit.glb'
      lods: null,
      clips: [],
      sockets: [],
      weakPoints: [],
      draco: false,
      fallback: 'procedural',
      preload: false,
    },
  },
};
