// IRONWILD - LOD + batching utilities (Wave D).
// Small, dependency-light helpers shared by the world-streaming work:
//   - DistanceLOD: per-object distance tiers with hysteresis.
//   - foliageTierDensity: quality -> {near, mid, far} density multipliers.
//   - makeBillboardImpostor: generated canvas sprite for distant stand-ins.
//   - groupInstancesByCell: split a global instance batch into per-cell groups
//     whose keys match cells.cellKeyAt() at the same cell size, so batches can
//     be registered with the cell manager and culled per cell.

import * as THREE from 'three';

// Out-of-tier slack: a level is re-entered only once the distance falls back
// below 1.15x its switch-out point, which stops boundary flicker when the
// camera hovers at exactly a tier distance.
const HYSTERESIS = 1.15;

/**
 * Per-object distance LOD. Levels: [{dist, apply(obj)}] sorted ascending;
 * level i holds while d <= dist(i) (going out) and re-takes at d < dist(i)*1.15
 * (coming back). The last level may omit `dist` (= Infinity, never outgrows).
 * apply() fires only on tier CHANGES; update() itself is one squared-distance
 * compare chain against cached thresholds - no sqrt, no allocation.
 *
 *   const lod = new DistanceLOD([
 *     { dist: 60, apply: (o) => { o.visible = true; } },
 *     { dist: 140, apply: (o) => { swapInImpostor(o); } },
 *     { apply: (o) => { o.visible = false; } },          // farthest bucket
 *   ], mesh);
 *   // per frame: lod.update(anchorPos)
 */
export class DistanceLOD {
  constructor(levels, obj = null) {
    this.levels = (levels || []).slice().sort((a, b) => {
      const da = a.dist === undefined ? Infinity : a.dist;
      const db = b.dist === undefined ? Infinity : b.dist;
      return da - db;
    });
    this.obj = obj;
    this.index = 0;      // current tier (0 = closest / highest detail)
    this._applied = false; // force the first update() to emit apply()
    // Cached squared switch thresholds: out of tier i past dist[i] (raw),
    // back into tier i under dist[i]*HYSTERESIS.
    this._out2 = this.levels.map((l) => (l.dist === undefined ? Infinity : l.dist * l.dist));
    this._back2 = this.levels.map((l) => {
      const back = l.dist === undefined ? Infinity : l.dist * HYSTERESIS;
      return back * back;
    });
  }

  /** Re-target the helper at another object; next update() re-applies tier 0..n. */
  bind(obj) {
    this.obj = obj;
    this._applied = false;
  }

  /** Cheap per-frame step from an anchor position (player or camera). */
  update(pos) {
    const o = this.obj;
    if (!o || !pos || this.levels.length === 0) return;
    const p = o.position || pos; // bare records without .position measure zero
    const dx = pos.x - p.x;
    const dy = pos.y - (p.y !== undefined ? p.y : pos.y);
    const dz = pos.z - p.z;
    const d2 = dx * dx + dy * dy + dz * dz;

    let i = this.index;
    // Step outward past each raw threshold until we find the holding tier.
    while (i < this.levels.length - 1 && d2 > this._out2[i]) i++;
    // Step inward through re-entry thresholds (hysteresis-widened).
    while (i > 0 && d2 < this._back2[i - 1]) i--;

    if (i !== this.index || !this._applied) {
      this.index = i;
      this._applied = true;
      const lvl = this.levels[i];
      if (lvl && lvl.apply) lvl.apply(o);
    }
  }
}

// Quality -> vegetation density multiplier per distance band. Multipliers are
// relative to the full (high-quality) placement count for each band. Low keeps
// half of the near band and tapers harder far out where distant tufts collapse
// into fog/shader fade anyway; unknown quality strings fall back to high.
const FOLIAGE_TIERS = {
  high: { near: 1, mid: 1, far: 1 },
  medium: { near: 1, mid: 0.75, far: 0.5 },
  low: { near: 0.5, mid: 0.35, far: 0.2 },
};

/** Density multipliers {near, mid, far} for a G.settings.quality string. */
export function foliageTierDensity(quality) {
  const t = FOLIAGE_TIERS[quality] || FOLIAGE_TIERS.high;
  return { near: t.near, mid: t.mid, far: t.far }; // copy: callers may scale freely
}

/**
 * Distant stand-in sprite: a soft blobby canopy silhouette baked onto a small
 * canvas texture. Intended as the cheap tier in a DistanceLOD chain (swap a
 * real mesh group for this beyond some radius). Returns a THREE.Sprite scaled
 * to `size` world units; caller positions/parents it.
 */
export function makeBillboardImpostor(colorHex, size = 4) {
  const px = 64; // texture resolution - plenty for a blurred blob at range
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');

  const hex = `#${(Number(colorHex) & 0xffffff).toString(16).padStart(6, '0')}`;
  // Three overlapping radial blobs give a lumpy canopy read; a darker base
  // band fakes ground shading so the impostor doesn't float visually.
  const blob = (x, y, r, alpha) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, hex);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = alpha;
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  blob(px * 0.32, px * 0.42, px * 0.30, 0.9);
  blob(px * 0.68, px * 0.40, px * 0.28, 0.85);
  blob(px * 0.50, px * 0.62, px * 0.34, 0.95);
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace; // match renderer output colour space
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false, // soft edges must not punch holes in things behind
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(size, size, 1);
  return sprite;
}

/**
 * Split a flat array of placement matrices into per-cell buckets keyed by
 * 'cx,cz' over an unbounded floor grid of `cellSize` - the SAME key space as
 * cells.cellKeyAt() at that size, so results register straight into the cell
 * manager. Insertion order is preserved within every bucket (stable grouping),
 * so parallel per-instance attributes (instance colours etc.) can be grouped
 * with an identity map keyed on the same matrix objects. Matrices are not
 * copied or mutated; non-finite translations land in an inert 'NaN,NaN' key.
 */
export function groupInstancesByCell(matrices, cellSize) {
  const map = new Map();
  if (!matrices || !(cellSize > 0)) return map;
  for (const m of matrices) {
    const x = m.elements[12];
    const z = m.elements[14];
    const key = `${Math.floor(x / cellSize)},${Math.floor(z / cellSize)}`;
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push(m);
  }
  return map;
}
