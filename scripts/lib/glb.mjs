// Minimal dependency-free glTF-binary writer shared by IRONWILD's
// repository-generated assets (certification prop, hunter, machines).
// Supports: positions/normals/uvs/joints/weights, indices, animations
// (node TRS channels), embedded images, skins are NOT yet needed (the
// engine's authored convention is articulated node hierarchies).
export class GlbBuilder {
  constructor() {
    this.binChunks = [];
    this.binLength = 0;
    this.accessors = [];
    this.bufferViews = [];
  }

  #pushAligned(typedArr) {
    const pad = (4 - (this.binLength % 4)) % 4;
    if (pad) {
      this.binChunks.push(new Uint8Array(pad));
      this.binLength += pad;
    }
    const bytes = new Uint8Array(
      typedArr.buffer,
      typedArr.byteOffset,
      typedArr.byteLength,
    );
    this.binChunks.push(bytes);
    this.binLength += bytes.byteLength;
    return this.binLength - bytes.byteLength;
  }

  /**
   * Stage one attribute/index array. target: 34962 vertex | 34963 index |
   * null (animation samplers / non-GPU data). Returns accessor index.
   * min/max are computed for POSITION (required by spec) and SCALAR floats.
   */
  accessor(arr, componentType, type, count, target = 34962) {
    const view = {
      buffer: 0,
      byteOffset: this.#pushAligned(arr),
      byteLength: arr.byteLength,
    };
    if (target != null) view.target = target;
    const bvIndex = this.bufferViews.push(view) - 1;
    const acc = { bufferView: bvIndex, componentType, count, type };
    this.accessors.push(acc);
    const idx = this.accessors.length - 1;
    if (type === "VEC3" && componentType === 5126) {
      const mn = [Infinity, Infinity, Infinity];
      const mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < arr.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          if (arr[i + k] < mn[k]) mn[k] = arr[i + k];
          if (arr[i + k] > mx[k]) mx[k] = arr[i + k];
        }
      }
      acc.min = mn;
      acc.max = mx;
    } else if (type === "SCALAR" && componentType === 5126) {
      let mn = Infinity;
      let mx = -Infinity;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] < mn) mn = arr[i];
        if (arr[i] > mx) mx = arr[i];
      }
      acc.min = [mn];
      acc.max = [mx];
    }
    return idx;
  }

  /** Raw bufferView without an accessor (embedded images such as KTX2). */
  rawBufferView(typedArr) {
    return this.bufferViews.push({
      buffer: 0,
      byteOffset: this.#pushAligned(typedArr),
      byteLength: typedArr.byteLength,
    }) - 1;
  }

  /** Assemble and return the complete .glb Buffer. Mutates json minimally. */
  finish(json) {
    json.accessors = this.accessors;
    json.bufferViews = this.bufferViews;
    json.buffers = [{ byteLength: this.binLength }];
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
    const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + this.binLength;
    const out = new ArrayBuffer(total);
    const dv = new DataView(out);
    const u8 = new Uint8Array(out);
    dv.setUint32(0, 0x46546c67, true); // 'glTF'
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonBytes.length + jsonPad, true);
    dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
    u8.set(jsonBytes, 20);
    for (let i = 0; i < jsonPad; i++) u8[20 + jsonBytes.length + i] = 0x20;
    let o = 20 + jsonBytes.length + jsonPad;
    dv.setUint32(o, this.binLength, true);
    dv.setUint32(o + 4, 0x004e4942, true); // 'BIN\0'
    o += 8;
    for (const c of this.binChunks) {
      u8.set(c, o);
      o += c.byteLength;
    }
    return Buffer.from(out);
  }
}

export const F32 = (a) => new Float32Array(a);
export const U16 = (a) => new Uint16Array(a);

/** Quaternion (xyzw) from axis + angle radians. */
export function quatAxisAngle(x, y, z, angle) {
  const h = angle / 2;
  const s = Math.sin(h);
  return [x * s, y * s, z * s, Math.cos(h)];
}

/**
 * Build one animation channel set from sampled poses.
 *   sampler(t) -> { [boneName]: { r?: [xyzw], t?: [xyz] } }
 * Bones not mentioned in a sample hold their previous value (held keys).
 * times: evenly spaced sample times in seconds.
 */
export function buildAnimation(name, nodeByName, times, sampler, builder) {
  const channels = [];
  const samplers = [];
  const timeAcc = builder.accessor(
    F32(times),
    5126,
    "SCALAR",
    times.length,
    null,
  );
  // Collect every bone+path mentioned anywhere first.
  const tracks = new Map();
  for (const t of times) {
    const pose = sampler(t);
    for (const [bone, tr] of Object.entries(pose)) {
      if (!tracks.has(bone)) tracks.set(bone, {});
      if (tr.r) tracks.get(bone).r = true;
      if (tr.t) tracks.get(bone).t = true;
    }
  }
  for (const [bone, paths] of tracks) {
    const node = nodeByName[bone];
    if (!node) continue;
    for (const path of ["r", "t"]) {
      if (!paths[path]) continue;
      const values = [];
      let last = path === "r" ? [0, 0, 0, 1] : [0, 0, 0];
      for (const t of times) {
        const tr = sampler(t)[bone];
        if (tr && tr[path]) last = tr[path];
        values.push(...last);
      }
      const outAcc = builder.accessor(
        F32(values),
        5126,
        path === "r" ? "VEC4" : "VEC3",
        times.length,
        null,
      );
      samplers.push({ input: timeAcc, output: outAcc, interpolation: "LINEAR" });
      channels.push({
        sampler: samplers.length - 1,
        target: { node, path: path === "r" ? "rotation" : "translation" },
      });
    }
  }
  return { name, channels, samplers };
}
