// M4 calibration sample from the 106-rig clips baked in a body GLB (V3 src/assets/{psyche,minotaur}-106.glb): hand-end speed per swing, with the clip's own label.
//   node tools/clip-swings.mjs <body.glb> <rig-map.json> [out.json] [--start 2.0] [--gap 0.15] [--window 3] [--snap 0.3] [--hz 60]
// Same method as tools/tip-speed.mjs: hand end speed = backward difference over --window ticks (3 ticks at 60 Hz = 0.05 s), a swing = one run above --start m/s
// (runs closer than --gap s joined), its value the PEAK of the run, a run whose speed three ticks before the peak was under --snap x peak is a pose snap and is
// counted apart. Differences: the clips are sampled at --hz from the GLB's own tracks (linear / slerp, like three.js), so the hips (root motion) move the hand
// as in the fight dump; light / heavy come from the clip label (CLASSES below), not from the run duration; the hand end is the first-joint child of the hand
// (the middle finger knuckle, hand pivot + hand length in the 65 rig chain). Only Mixamo-library melee clips are read; other clips (locomotion, deaths, kicks) are listed as skipped.
// Source GLBs are read locally and never leave the machine: the output json holds only numbers and clip names.
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i < 0 ? d : args.splice(i, 2)[1]; };
const startV = Number(opt("start", 2.0)), gapS = Number(opt("gap", 0.15)), win = Number(opt("window", 3)), snapRise = Number(opt("snap", 0.3)), hz = Number(opt("hz", 60));
const [glbFile, mapFile, outFile] = args;
if (!glbFile || !mapFile) { console.error("usage: node tools/clip-swings.mjs <body.glb> <rig-map.json> [out.json] [--start m/s] [--gap s] [--window ticks] [--snap x] [--hz n]"); process.exit(1); }

// clip label -> swing class. Labels are the V3 clip names; the hero and the foe share them. Special swings are measured but kept apart.
export const CLASSES = {
  Attack: "light", Riposte: "light", Cut_Outward: "light", Cut_OutwardMirror: "light", Stab: "light",
  Heavy: "heavy", Heavy_Gladius: "heavy",
  Skill_WitchArm: "special", Skill_Pommel: "special",
};

const buf = readFileSync(glbFile);
const jl = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jl).toString("utf8"));
const binOff = 20 + jl + 8;
const map = JSON.parse(readFileSync(mapFile, "utf8")).joints;

// the clips are EXT_meshopt_compression bufferViews (the GLB's BIN chunk is buffer 0): decode with the decoder three.js ships, cached per view
await MeshoptDecoder.ready;
const mo = {};
const viewBytes = (bi) => {
  const bv = json.bufferViews[bi], ext = bv.extensions?.EXT_meshopt_compression;
  if (!ext) return buf.subarray(binOff + (bv.byteOffset || 0), binOff + (bv.byteOffset || 0) + bv.byteLength);
  if (mo[bi]) return mo[bi];
  const out = new Uint8Array(ext.count * ext.byteStride);
  MeshoptDecoder.decodeGltfBuffer(out, ext.count, ext.byteStride, buf.subarray(binOff + (ext.byteOffset || 0), binOff + (ext.byteOffset || 0) + ext.byteLength), ext.mode, ext.filter || "NONE");
  return (mo[bi] = out);
};
const acc = (i) => {
  const a = json.accessors[i], n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type], bytes = viewBytes(a.bufferView);
  const out = new Float32Array(a.count * n), size = a.componentType === 5126 ? 4 : 2, dv = new DataView(bytes.buffer, bytes.byteOffset + (a.byteOffset || 0), a.count * n * size);
  if (a.componentType !== 5126 && !(a.componentType === 5122 && a.normalized)) throw new Error("accessor component type " + a.componentType + " not handled");
  // float32, or int16 normalized (the QUATERNION filter writes rotations that way)
  for (let k = 0; k < out.length; k++) out[k] = size === 4 ? dv.getFloat32(k * 4, true) : Math.max(dv.getInt16(k * 2, true) / 32767, -1);
  return { data: out, n, count: a.count };
};

const nodes = json.nodes, parent = new Array(nodes.length).fill(-1);
nodes.forEach((nd, i) => (nd.children || []).forEach((c) => (parent[c] = i)));
const byName = (nm) => nodes.findIndex((nd) => nd.name === nm || nd.name === nm.replace(":", ""));
const mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
const compose = (t, q, s) => {
  const [x, y, z, w] = q, [sx, sy, sz] = s;
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
};
const restLocal = (i) => { const nd = nodes[i]; return nd.matrix ? nd.matrix : compose(nd.translation || [0, 0, 0], nd.rotation || [0, 0, 0, 1], nd.scale || [1, 1, 1]); };

// chain root -> joint (ancestors first), so only the nodes a hand end depends on are posed
const chain = (i) => { const c = []; for (let k = i; k >= 0; k = parent[k]) c.unshift(k); return c; };
const handEndNode = (side) => {
  const h = byName(map[side + "Hand"]), kids = (nodes[h].children || []).map((c) => nodes[c].name || "");
  const mid = (nodes[h].children || []).find((c) => /Middle1$/.test(nodes[c].name || ""));
  if (mid === undefined) throw new Error(`no ${side}Hand Middle1 child among ${kids.join(", ")}`);
  return mid;
};
const ends = { Left: handEndNode("Left"), Right: handEndNode("Right") };
const arms = { Left: byName(map.LeftArm), Right: byName(map.RightArm) };

const lerp = (a, b, f) => a + (b - a) * f;
function sampleTrack(tr, t) {
  const { times, vals, n } = tr, last = times.length - 1;
  if (t <= times[0]) return Array.from(vals.subarray(0, n));
  if (t >= times[last]) return Array.from(vals.subarray(last * n, last * n + n));
  let k = 0; while (times[k + 1] < t) k++;
  const f = (t - times[k]) / (times[k + 1] - times[k]), a = vals.subarray(k * n, k * n + n), b = vals.subarray((k + 1) * n, (k + 1) * n + n);
  if (n === 3) return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb = d < 0 ? [-b[0], -b[1], -b[2], -b[3]] : [b[0], b[1], b[2], b[3]]; d = Math.abs(d);
  let wa, wb;
  if (d > 0.9995) { wa = 1 - f; wb = f; } else { const th = Math.acos(d), s = Math.sin(th); wa = Math.sin((1 - f) * th) / s; wb = Math.sin(f * th) / s; }
  const q = [0, 1, 2, 3].map((j) => wa * a[j] + wb * bb[j]), l = Math.hypot(...q);
  return q.map((x) => x / l);
}

function handPositions(anim) {
  const tracks = {}; // node -> { translation, rotation, scale }
  for (const ch of anim.channels) {
    const sm = anim.samplers[ch.sampler], node = ch.target.node, path = ch.target.path;
    if ((sm.interpolation || "LINEAR") !== "LINEAR") throw new Error(`clip ${anim.name}: ${sm.interpolation} sampler on node ${node}; only LINEAR is sampled`);
    if (path === "weights") continue;
    const tIn = acc(sm.input), tOut = acc(sm.output);
    (tracks[node] ||= {})[path] = { times: tIn.data, vals: tOut.data, n: tOut.n };
  }
  const dur = Math.max(...anim.samplers.map((s) => acc(s.input).data.at(-1)));
  const ticks = Math.floor(dur * hz) + 1, out = { Left: [], Right: [] }, armsPos = { Left: [], Right: [] };
  const needed = new Set([...Object.values(ends), ...Object.values(arms)].flatMap(chain));
  const order = [...needed].sort((a, b) => chain(a).length - chain(b).length);
  for (let k = 0; k < ticks; k++) {
    const t = k / hz, world = {};
    for (const i of order) {
      const tr = tracks[i] || {}, nd = nodes[i];
      const T = tr.translation ? sampleTrack(tr.translation, t) : nd.translation || [0, 0, 0];
      const Q = tr.rotation ? sampleTrack(tr.rotation, t) : nd.rotation || [0, 0, 0, 1];
      const S = tr.scale ? sampleTrack(tr.scale, t) : nd.scale || [1, 1, 1];
      const L = nd.matrix && !tr.translation && !tr.rotation && !tr.scale ? nd.matrix : compose(T, Q, S);
      world[i] = parent[i] >= 0 && world[parent[i]] ? mul(world[parent[i]], L) : parent[i] >= 0 ? mul(chainWorldRest(parent[i]), L) : L;
    }
    for (const s of ["Left", "Right"]) {
      const m = world[ends[s]]; out[s].push([m[12], m[13], m[14]]);
      const a = world[arms[s]]; armsPos[s].push([a[12], a[13], a[14]]);
    }
  }
  return { hands: out, ticks, dur };
}
const restWorldCache = {};
function chainWorldRest(i) {
  if (restWorldCache[i]) return restWorldCache[i];
  const L = restLocal(i);
  return (restWorldCache[i] = parent[i] >= 0 ? mul(chainWorldRest(parent[i]), L) : L);
}

// arm reach at bind: shoulder (arm joint) to hand end, per side
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const bindPos = (i) => { const m = chainWorldRest(i); return [m[12], m[13], m[14]]; };
const armReach = {};
for (const s of ["Left", "Right"]) armReach[s] = dist(bindPos(arms[s]), bindPos(ends[s]));
armReach.mean = (armReach.Left + armReach.Right) / 2;

const quant = (a, f) => { const s = [...a].sort((x, y) => x - y); if (!s.length) return null; const k = (s.length - 1) * f, lo = Math.floor(k); return s[lo] + (s[Math.min(s.length - 1, lo + 1)] - s[lo]) * (k - lo); };
const swings = [], skipped = [];
for (const anim of json.animations) {
  const cls = CLASSES[anim.name];
  if (!cls) { skipped.push(anim.name); continue; }
  const { hands } = handPositions(anim);
  for (const side of ["Left", "Right"]) {
    const P = hands[side];
    const sp = P.map((_, t) => { const t0 = Math.max(0, t - win); return t === t0 ? 0 : dist(P[t0], P[t]) / ((t - t0) / hz); });
    const runs = []; let cur = null;
    sp.forEach((v, t) => { if (v >= startV) { if (cur && t - cur.end <= gapS * hz) cur.end = t; else { cur = { start: t, end: t }; runs.push(cur); } } });
    for (const r of runs) {
      let peak = 0, pk = r.start;
      for (let t = r.start; t <= r.end; t++) if (sp[t] > peak) { peak = sp[t]; pk = t; }
      swings.push({ clip: anim.name, class: cls, side, start_s: +(r.start / hz).toFixed(3), dur_s: +((r.end - r.start + 1) / hz).toFixed(3), peak_m_s: +peak.toFixed(3), snap: sp[Math.max(0, pk - 3)] < snapRise * peak });
    }
  }
}
const good = swings.filter((s) => !s.snap);
const table = (rows) => { const v = rows.map((s) => s.peak_m_s); return { n: rows.length, p10: quant(v, 0.1), p50: quant(v, 0.5), p90: quant(v, 0.9), p99: quant(v, 0.99), max: v.length ? Math.max(...v) : null }; };
const out = {
  schema: "clip-swings/1", body: basename(glbFile, ".glb"), tick_hz: hz, tip: "hand end (the hand's Middle1 child joint)", arm_reach_m: armReach,
  start_m_s: startV, gap_s: gapS, window_ticks: win, snap_rise: snapRise, classes_by_clip: CLASSES, skipped_clips: skipped,
  classes: { all: table(good.filter((s) => s.class !== "special")), light: table(good.filter((s) => s.class === "light")), heavy: table(good.filter((s) => s.class === "heavy")), special: table(good.filter((s) => s.class === "special")) },
  snaps_excluded: swings.filter((s) => s.snap).length, swings,
};
if (outFile) writeFileSync(outFile, JSON.stringify(out, null, 1) + "\n");
const r2 = (x) => (x === null ? "-" : x.toFixed(2));
console.log(`${out.body}: arm reach L ${armReach.Left.toFixed(4)} R ${armReach.Right.toFixed(4)}; swings ${good.length} (+${out.snaps_excluded} snaps); skipped ${skipped.length} clips`);
for (const [k, t] of Object.entries(out.classes)) console.log(k.padEnd(8), String(t.n).padStart(3), ["p10", "p50", "p90", "p99", "max"].map((q) => r2(t[q]).padStart(7)).join(""));
for (const s of swings) console.log(" ", s.clip.padEnd(18), s.side.padEnd(5), String(s.start_s).padStart(6), String(s.dur_s).padStart(6), s.peak_m_s.toFixed(2).padStart(7), s.snap ? "SNAP" : s.class);
