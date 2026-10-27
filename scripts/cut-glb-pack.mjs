// Lossy production packing for the Minotaur cut GLB (src/assets/minotaur-106.glb: piece_* and cap_* skinned meshes + 26 clips), used by
// optimizeGlb(raw, ext, { cut: true }) only. Every other file keeps the strict bit-exact path in optimize-glb.mjs.
// What the source keeps in git is the physics tool's float32 cut GLB (meshopt, filter NONE: 2.37 MB, 1.56 MB gzip). Here:
//   - attributes leave the interleaved 56-byte vertex and become one view per semantic (meshopt codes each column on its own);
//   - POSITION and TEXCOORD_0 stay float32 for the runtime (characters.ts, finisher-blood.ts read them as numbers) but go through the
//     EXPONENTIAL filter: the mantissa is cut to POSITION_BITS / UV_BITS, so the decoder returns the nearest representable float. The cut is a
//     pure function of the value, so a cap vertex equal to a piece vertex in the source is equal after decoding (caps stay welded to pieces);
//   - NORMAL is int8 normalized through the OCTAHEDRAL filter, JOINTS_0 uint8, WEIGHTS_0 uint8 normalized with each vertex summing to 255;
//   - indices are one TRIANGLES view (triangle order and winding kept);
//   - animation: times stay exact float32 (one view), translations go through EXPONENTIAL, rotations through QUATERNION (int16 normalized).
// The returned report states the measured worst errors; the caller (and test/cut-glb-pack.test.mjs) hold them to the bounds below.
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

export const BITS = { position: 16, uv: 14, translation: 14, rotation: 16, normal: 8 };
export const BOUNDS = { positionMetres: 1e-4, rotationRadians: 1e-4 };   // 0.1 mm on the 1.7 m body; 0.006 degrees on any bone (measured 0.00005 rad)
const CT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** Decodes every EXT_meshopt_compression view in place of the file: returns plain {d, bin} (one buffer, no meshopt, filters applied). */
export async function unpackMeshopt(d, bin) {
  await MeshoptDecoder.ready;
  const chunks = [], views = [];
  let offset = 0;
  const put = (bytes) => { const at = offset; chunks.push(bytes); offset += bytes.length; const pad = (4 - offset % 4) % 4; if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; } return at; };
  for (const v of d.bufferViews) {
    const e = v.extensions?.EXT_meshopt_compression;
    let bytes;
    if (e) {
      bytes = Buffer.alloc(e.count * e.byteStride);
      MeshoptDecoder.decodeGltfBuffer(bytes, e.count, e.byteStride, bin.subarray(e.byteOffset, e.byteOffset + e.byteLength), e.mode, e.filter || 'NONE');
    } else bytes = bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength);
    const next = { ...v, buffer: 0, byteOffset: put(bytes), byteLength: bytes.length };
    if (e) delete next.extensions;
    views.push(next);
  }
  const out = { ...d, bufferViews: views, buffers: [{ byteLength: offset }] };
  const drop = new Set(['EXT_meshopt_compression']);
  out.extensionsUsed = (d.extensionsUsed || []).filter((x) => !drop.has(x));
  out.extensionsRequired = (d.extensionsRequired || []).filter((x) => !drop.has(x));
  if (!out.extensionsRequired.length) delete out.extensionsRequired;
  return { d: out, bin: Buffer.concat(chunks) };
}

export function readAccessor(d, bin, a, normalize = true) {
  const v = d.bufferViews[a.bufferView], T = CT[a.componentType], w = WIDTH[a.type], es = T.BYTES_PER_ELEMENT;
  const stride = v.byteStride || w * es, base = (v.byteOffset || 0) + (a.byteOffset || 0);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength), out = new Float32Array(a.count * w);
  const get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[a.componentType];
  const max = a.componentType === 5120 ? 127 : a.componentType === 5122 ? 32767 : a.componentType === 5121 ? 255 : a.componentType === 5123 ? 65535 : 1;
  for (let i = 0; i < a.count; i++) for (let k = 0; k < w; k++) {
    const x = dv[get](base + i * stride + k * es, true);
    out[i * w + k] = normalize && a.normalized ? Math.max(x / max, -1) : x;
  }
  return out;
}

const u8 = (arr) => new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
/** Weights to uint8 whose four values sum to exactly 255 (the largest weights absorb the rounding). */
function weights8(w, out, at) {
  // largest remainder: floor each, hand the missing units to the biggest fractions (every weight within one unit of its source)
  const c = [0, 1, 2, 3].map((k) => Math.max(0, Math.min(1, w[k]))), q = c.map((x) => Math.floor(x * 255 + 1e-9)), total = Math.min(255, Math.round(c.reduce((n, x) => n + x, 0) * 255));
  let diff = total - q.reduce((n, x) => n + x, 0);
  for (const k of [0, 1, 2, 3].sort((p, r) => (c[r] * 255 - q[r]) - (c[p] * 255 - q[p]))) { if (diff <= 0) break; q[k]++; diff--; }
  for (let k = 0; k < 4; k++) out[at + k] = q[k];
}

/**
 * Re-packs geometry and animation of the plain (unpacked) GLB in d/bin. Mutates d.accessors and appends buffer views; returns
 * { prepared: Map(view index -> {enc, count, stride, mode, filter}), dropped: Set(old view indices), report }.
 */
export async function repackCut(d, bin, bits = BITS) {
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const prepared = new Map(), dropped = new Set(), report = { positionError: 0, uvError: 0, normalErrorDeg: 0, rotationError: 0, translationError: 0, bytes: {} };
  const addView = (name, raw, stride, mode, filter, target) => {
    const count = raw.length / stride, enc = MeshoptEncoder.encodeGltfBuffer(raw, count, stride, mode);
    const index = d.bufferViews.length;
    const view = { buffer: 0, byteOffset: 0, byteLength: raw.length };
    if (mode === 'ATTRIBUTES') view.byteStride = stride;
    if (target) view.target = target;
    d.bufferViews.push(view);
    prepared.set(index, { enc, count, stride, mode, filter });
    report.bytes[name] = enc.length;
    const decoded = Buffer.alloc(raw.length);
    MeshoptDecoder.decodeGltfBuffer(decoded, count, stride, enc, mode, filter);
    return { index, decoded };
  };
  const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

  // ---- geometry ----
  const prims = d.meshes.flatMap((m) => m.primitives);
  for (const p of prims) {
    assert(p.mode === undefined || p.mode === 4, 'cut pack: triangles only');
    assert(!p.targets && p.indices !== undefined, 'cut pack: no morph targets, indexed');
    for (const k of Object.keys(p.attributes)) assert(['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0'].includes(k), `cut pack: unexpected attribute ${k}`);
  }
  const collect = (semantic) => prims.map((p) => ({ p, a: d.accessors[p.attributes[semantic]] }));
  const old = new Set();
  for (const p of prims) { for (const ai of [...Object.values(p.attributes), p.indices]) { assert(!d.accessors[ai].sparse, 'cut pack: sparse'); old.add(d.accessors[ai].bufferView); } }
  const stack = (semantic, width, fill) => {   // per-primitive start offsets (in elements) into one column
    const rows = collect(semantic), starts = [];
    let total = 0;
    for (const r of rows) { starts.push(total); total += r.a.count; }
    return { rows, starts, total };
  };
  const retarget = (r, start, viewIndex, stride, patch) => {
    const a = r.a;
    a.bufferView = viewIndex; a.byteOffset = start * stride; Object.assign(a, patch);
    if (!patch.normalized) delete a.normalized;
  };

  {   // POSITION: float32 through EXPONENTIAL
    const { rows, starts, total } = stack('POSITION');
    const src = new Float32Array(total * 3);
    rows.forEach((r, i) => src.set(readAccessor(d, bin, r.a), starts[i] * 3));
    const filtered = MeshoptEncoder.encodeFilterExp(src, total, 12, bits.position, 'Separate');
    const { index, decoded } = addView('POSITION', filtered, 12, 'ATTRIBUTES', 'EXPONENTIAL', 34962);
    const got = new Float32Array(decoded.buffer, decoded.byteOffset, total * 3);
    for (let i = 0; i < src.length; i++) report.positionError = Math.max(report.positionError, Math.abs(got[i] - src[i]));
    rows.forEach((r, i) => {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let j = starts[i]; j < starts[i] + r.a.count; j++) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], got[j * 3 + k]); hi[k] = Math.max(hi[k], got[j * 3 + k]); }
      retarget(r, starts[i], index, 12, { min: lo, max: hi });
    });
  }
  {   // NORMAL: int8 octahedral
    const { rows, starts, total } = stack('NORMAL');
    const src = new Float32Array(total * 4);
    rows.forEach((r, i) => { const n = readAccessor(d, bin, r.a); for (let j = 0; j < r.a.count; j++) { const x = n[j * 3], y = n[j * 3 + 1], z = n[j * 3 + 2], l = Math.hypot(x, y, z) || 1, at = (starts[i] + j) * 4; src[at] = x / l; src[at + 1] = y / l; src[at + 2] = z / l; src[at + 3] = 1; } });
    const filtered = MeshoptEncoder.encodeFilterOct(src, total, 4, bits.normal);
    const { index, decoded } = addView('NORMAL', filtered, 4, 'ATTRIBUTES', 'OCTAHEDRAL', 34962);
    const got = new Int8Array(decoded.buffer, decoded.byteOffset, total * 4);
    for (let j = 0; j < total; j++) {
      const x = got[j * 4] / 127, y = got[j * 4 + 1] / 127, z = got[j * 4 + 2] / 127, l = Math.hypot(x, y, z) || 1;
      const dot = (x * src[j * 4] + y * src[j * 4 + 1] + z * src[j * 4 + 2]) / l;
      report.normalErrorDeg = Math.max(report.normalErrorDeg, Math.acos(Math.min(1, dot)) * 180 / Math.PI);
    }
    rows.forEach((r, i) => retarget(r, starts[i], index, 4, { componentType: 5120, normalized: true }));
    for (const r of rows) { delete r.a.min; delete r.a.max; }
  }
  {   // TEXCOORD_0: float32 through EXPONENTIAL
    const { rows, starts, total } = stack('TEXCOORD_0');
    const src = new Float32Array(total * 2);
    rows.forEach((r, i) => src.set(readAccessor(d, bin, r.a), starts[i] * 2));
    const filtered = MeshoptEncoder.encodeFilterExp(src, total, 8, bits.uv, 'Separate');
    const { index, decoded } = addView('TEXCOORD_0', filtered, 8, 'ATTRIBUTES', 'EXPONENTIAL', 34962);
    const got = new Float32Array(decoded.buffer, decoded.byteOffset, total * 2);
    for (let i = 0; i < src.length; i++) report.uvError = Math.max(report.uvError, Math.abs(got[i] - src[i]));
    rows.forEach((r, i) => retarget(r, starts[i], index, 8, {}));
  }
  {   // JOINTS_0: uint8
    const { rows, starts, total } = stack('JOINTS_0');
    const raw = new Uint8Array(total * 4);
    rows.forEach((r, i) => { const j = readAccessor(d, bin, r.a, false); for (let k = 0; k < j.length; k++) { assert(j[k] < 256, 'cut pack: joint index over 255'); raw[starts[i] * 4 + k] = j[k]; } });
    const { index } = addView('JOINTS_0', raw, 4, 'ATTRIBUTES', 'NONE', 34962);
    rows.forEach((r, i) => retarget(r, starts[i], index, 4, { componentType: 5121 }));
  }
  {   // WEIGHTS_0: uint8 normalized, sum 255
    const { rows, starts, total } = stack('WEIGHTS_0');
    const raw = new Uint8Array(total * 4);
    rows.forEach((r, i) => { const w = readAccessor(d, bin, r.a); for (let j = 0; j < r.a.count; j++) weights8(w.subarray(j * 4, j * 4 + 4), raw, (starts[i] + j) * 4); });
    const { index } = addView('WEIGHTS_0', raw, 4, 'ATTRIBUTES', 'NONE', 34962);
    rows.forEach((r, i) => retarget(r, starts[i], index, 4, { componentType: 5121, normalized: true }));
  }
  {   // indices: one TRIANGLES view
    const rows = prims.map((p) => ({ a: d.accessors[p.indices] })), starts = [];
    let total = 0;
    for (const r of rows) { assert(r.a.count % 3 === 0 && r.a.componentType === 5123, 'cut pack: uint16 triangle indices'); starts.push(total); total += r.a.count; }
    const raw = new Uint8Array(total * 2), out = new Uint16Array(raw.buffer);
    rows.forEach((r, i) => out.set(readAccessor(d, bin, r.a, false), starts[i]));
    const { index } = addView('indices', raw, 2, 'TRIANGLES', 'NONE', 34963);
    rows.forEach((r, i) => retarget(r, starts[i], index, 2, {}));
  }

  // ---- animation ----
  const tracks = { time: new Map(), translation: new Map(), rotation: new Map() };   // accessor index -> channel kind
  for (const an of d.animations || []) for (const ch of an.channels) {
    const s = an.samplers[ch.sampler];
    assert(ch.target.path === 'translation' || ch.target.path === 'rotation', `cut pack: animation path ${ch.target.path}`);
    assert(s.interpolation === undefined || s.interpolation === 'LINEAR', 'cut pack: LINEAR only');
    tracks.time.set(s.input, 1); tracks[ch.target.path].set(s.output, 1);
    old.add(d.accessors[s.input].bufferView); old.add(d.accessors[s.output].bufferView);
  }
  {   // times: exact float32, identical arrays stored once
    const ids = [...tracks.time.keys()], at = new Map(), parts = [], seen = new Map();
    let total = 0;
    for (const ai of ids) { const t = readAccessor(d, bin, d.accessors[ai]), key = Buffer.from(t.buffer).toString('hex'); if (!seen.has(key)) { seen.set(key, total); parts.push(t); total += t.length; } at.set(ai, seen.get(key)); }
    const all = new Float32Array(total); let o = 0; for (const t of parts) { all.set(t, o); o += t.length; }
    const { index } = addView('times', u8(all), 4, 'ATTRIBUTES', 'NONE');
    for (const ai of ids) { Object.assign(d.accessors[ai], { bufferView: index, byteOffset: at.get(ai) * 4 }); }
  }
  {   // translation: float32 through EXPONENTIAL (stride 12)
    const ids = [...tracks.translation.keys()];
    const src = new Float32Array(ids.reduce((n, ai) => n + d.accessors[ai].count * 3, 0)), at = new Map();
    let o = 0; for (const ai of ids) { at.set(ai, o); const t = readAccessor(d, bin, d.accessors[ai]); src.set(t, o); o += t.length; }
    const filtered = MeshoptEncoder.encodeFilterExp(src, src.length / 3, 12, bits.translation, 'Separate');
    const { index, decoded } = addView('translation', filtered, 12, 'ATTRIBUTES', 'EXPONENTIAL');
    const got = new Float32Array(decoded.buffer, decoded.byteOffset, src.length);
    for (let i = 0; i < src.length; i++) report.translationError = Math.max(report.translationError, Math.abs(got[i] - src[i]));
    for (const ai of ids) { const a = d.accessors[ai]; Object.assign(a, { bufferView: index, byteOffset: at.get(ai) * 4 }); delete a.min; delete a.max; }
  }
  {   // rotation: int16 normalized through QUATERNION (stride 8)
    const ids = [...tracks.rotation.keys()];
    const src = new Float32Array(ids.reduce((n, ai) => n + d.accessors[ai].count * 4, 0)), at = new Map();
    let o = 0; for (const ai of ids) { at.set(ai, o); const t = readAccessor(d, bin, d.accessors[ai]); for (let j = 0; j < t.length; j += 4) { const l = Math.hypot(t[j], t[j + 1], t[j + 2], t[j + 3]) || 1; for (let k = 0; k < 4; k++) src[o + j + k] = t[j + k] / l; } o += t.length; }
    const filtered = MeshoptEncoder.encodeFilterQuat(src, src.length / 4, 8, bits.rotation);
    const { index, decoded } = addView('rotation', filtered, 8, 'ATTRIBUTES', 'QUATERNION');
    const got = new Int16Array(decoded.buffer, decoded.byteOffset, src.length);
    for (let j = 0; j < src.length; j += 4) {
      // rotation angle between the two unit quaternions, from the chord (acos of a dot near 1 loses everything to float rounding)
      const g = [0, 1, 2, 3].map((k) => Math.max(got[j + k] / 32767, -1)), l = Math.hypot(...g);
      const sign = g[0] * src[j] + g[1] * src[j + 1] + g[2] * src[j + 2] + g[3] * src[j + 3] < 0 ? -1 : 1;
      report.rotationError = Math.max(report.rotationError, 4 * Math.asin(Math.min(1, Math.hypot(...g.map((x, k) => x / l * sign - src[j + k])) / 2)));
    }
    for (const ai of ids) { const a = d.accessors[ai]; Object.assign(a, { bufferView: index, byteOffset: at.get(ai) * 2, componentType: 5122, normalized: true }); delete a.min; delete a.max; }
  }

  if (process.env.CUT_PACK_REPORT) console.log(JSON.stringify(report));
  for (const i of old) dropped.add(i);
  d.extensionsUsed = [...new Set([...(d.extensionsUsed || []), 'KHR_mesh_quantization'])];
  d.extensionsRequired = [...new Set([...(d.extensionsRequired || []), 'KHR_mesh_quantization'])];
  return { prepared, dropped, report };
}

function assert(ok, message) { if (!ok) throw new Error(message); }
