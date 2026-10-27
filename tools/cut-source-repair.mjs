// Makes a CLEANED COPY of a body GLB for cutting only (docs/CUT-SOURCE-REPAIR.md). The original is never touched; the copy goes to a new file.
//   node tools/cut-source-repair.mjs <in.glb> <out.glb> --mesh CreatureBody[,Other] [--json]
// Works on triangle indices only: every vertex, normal, UV, joint and weight stays byte-identical (decompressGlb's plain float32 metres), so the
// skin, the joint set and the look of every kept triangle are unchanged. Two repairs, both on the named meshes and judged with the welder the
// validator uses (tools/cut-validate.mjs, WELD 1e-5, all meshes welded together):
//   1. over-used edges (more than two triangles on a welded edge): keep the best pair (opposite traversal first, then the flattest, then the
//      largest connected surface) and delete the other triangles of the named meshes. The surface they leave is open there; it is not capped or faked.
//   2. winding: flood-fill the surface over its two-triangle edges and flip the triangles that disagree with the seed (the seed is the largest
//      triangle of each connected surface, so the big body keeps the orientation it ships with).
// The report lists what was deleted and flipped (counts, area, bounding box) so the change can be judged against the original.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decompressGlb } from "./cut-units.mjs";

const WELD = 1e-5;
const KEY = 67108864;

function makeWelder(eps = WELD) {
  const cells = new Map(), reps = [];
  const hash = (x, y, z) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) | 0;
  const find = (x, y, z) => {
    const cx = Math.floor(x / eps), cy = Math.floor(y / eps), cz = Math.floor(z / eps);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const arr = cells.get(hash(cx + dx, cy + dy, cz + dz));
      if (!arr) continue;
      for (const id of arr) { const r = reps[id]; if (Math.abs(r[0] - x) <= eps && Math.abs(r[1] - y) <= eps && Math.abs(r[2] - z) <= eps) return id; }
    }
    return -1;
  };
  return {
    reps,
    id(x, y, z) {
      const f = find(x, y, z);
      if (f >= 0) return f;
      const id = reps.length; reps.push([x, y, z]);
      const h = hash(Math.floor(x / eps), Math.floor(y / eps), Math.floor(z / eps));
      (cells.get(h) || cells.set(h, []).get(h)).push(id);
      return id;
    },
  };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Defect counts of a triangle set, the way tools/cut-validate.mjs --self counts them.
function defects(tris, alive) {
  const edges = new Map();
  for (let t = 0; t < tris.length; t++) {
    if (!alive[t]) continue;
    const [a, b, c] = tris[t].w;
    if (a === b || b === c || a === c) continue;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = Math.min(u, v) * KEY + Math.max(u, v), e = edges.get(key) || { n: 0, dir: 0 };
      e.n++; e.dir += u < v ? 1 : -1; edges.set(key, e);
    }
  }
  let open = 0, over = 0, flipped = 0;
  for (const e of edges.values()) { if (e.n === 1) open++; else if (e.n > 2) over++; else if (e.dir !== 0) flipped++; }
  return { open, over, flipped };
}

export async function repairSource(glbBytes, meshNames) {
  const plain = await decompressGlb(glbBytes);
  const { NodeIO } = await import("@gltf-transform/core");
  const { ALL_EXTENSIONS } = await import("@gltf-transform/extensions");
  const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).readBinary(plain);
  const weld = makeWelder();
  const fix = new Set(meshNames);
  const tris = []; // { w: [a,b,c] welded ids, prim, i (index of the triangle in its primitive), fix, area, n }
  const prims = [];
  // like the validator: the skinned meshes only (weapons and props are not part of the cut), named by node
  for (const node of doc.getRoot().listNodes()) if (node.getMesh() && node.getSkin()) for (const prim of node.getMesh().listPrimitives()) {
    const pos = prim.getAttribute("POSITION"), idx = prim.getIndices();
    if (!pos || !idx) continue;
    const P = pos.getArray(), I = idx.getArray(), vid = new Int32Array(pos.getCount());
    for (let v = 0; v < vid.length; v++) vid[v] = weld.id(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
    const p = { prim, mesh: node.getName(), idx: Uint32Array.from(I), P, fix: fix.has(node.getName()) };
    prims.push(p);
    for (let t = 0; t + 2 < I.length; t += 3) {
      const q = [I[t], I[t + 1], I[t + 2]], w = q.map((v) => vid[v]);
      const [A, B, C] = q.map((v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
      const nrm = cross(sub(B, A), sub(C, A)), area = len(nrm) / 2;
      tris.push({ w, p, t, area, n: area > 0 ? nrm.map((x) => x / (2 * area)) : [0, 0, 0], v: q, A });
    }
  }
  const alive = new Uint8Array(tris.length).fill(1);
  const before = defects(tris, alive);

  // connected surfaces over two-triangle edges (size by area, for ranking)
  const edgeMap = () => {
    const m = new Map();
    for (let t = 0; t < tris.length; t++) {
      if (!alive[t]) continue;
      const [a, b, c] = tris[t].w;
      if (a === b || b === c || a === c) continue;
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const key = Math.min(u, v) * KEY + Math.max(u, v), e = m.get(key) || [];
        e.push([t, u < v ? 1 : -1]); m.set(key, e);
      }
    }
    return m;
  };
  let em = edgeMap();
  const compOf = new Int32Array(tris.length).fill(-1), compArea = [];
  for (let s = 0; s < tris.length; s++) {
    if (!alive[s] || compOf[s] >= 0) continue;
    const id = compArea.length; let area = 0; const stack = [s]; compOf[s] = id;
    while (stack.length) {
      const t = stack.pop(); area += tris[t].area; const [a, b, c] = tris[t].w;
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const e = em.get(Math.min(u, v) * KEY + Math.max(u, v));
        if (!e || e.length !== 2) continue;
        for (const [o] of e) if (compOf[o] < 0) { compOf[o] = id; stack.push(o); }
      }
    }
    compArea.push(area);
  }

  // 1. over-used edges
  const deleted = [];
  for (const [key, list] of [...em]) {
    const live = list.filter(([t]) => alive[t]);
    if (live.length <= 2) continue;
    const must = live.filter(([t]) => !tris[t].p.fix), free = live.filter(([t]) => tris[t].p.fix);
    let best = null, bestScore = -Infinity;
    const pairs = [];
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) pairs.push([live[i], live[j]]);
    for (const [x, y] of pairs) {
      const fixedLeft = [x, y].filter(([t]) => !tris[t].p.fix).length;
      if (fixedLeft < Math.min(2, must.length)) continue; // untouchable triangles stay
      const score = (x[1] !== y[1] ? 1000 : 0) + dot(tris[x[0]].n, tris[y[0]].n) * 10 + Math.log10(1e-9 + compArea[compOf[x[0]]] + compArea[compOf[y[0]]]);
      if (score > bestScore) { bestScore = score; best = [x[0], y[0]]; }
    }
    const keep = new Set(best || must.slice(0, 2).map(([t]) => t));
    for (const [t] of free) if (!keep.has(t)) { alive[t] = 0; deleted.push(t); }
  }

  // 2. winding, per connected surface of the named meshes
  em = edgeMap();
  const flip = new Uint8Array(tris.length), seen = new Uint8Array(tris.length);
  const order = [...tris.keys()].filter((t) => alive[t] && tris[t].p.fix).sort((a, b) => tris[b].area - tris[a].area);
  const flipped = [];
  const dirOf = (t, u, v) => { const [a, b, c] = tris[t].w; const f = flip[t]; // direction of u->v in triangle t after any flip: +1 when it runs a->b, b->c or c->a
    const fwd = (a === u && b === v) || (b === u && c === v) || (c === u && a === v); return f ? -(fwd ? 1 : -1) : (fwd ? 1 : -1); };
  for (const s of order) {
    if (seen[s]) continue;
    seen[s] = 1; const stack = [s], members = [s];
    while (stack.length) {
      const t = stack.pop(); const [a, b, c] = tris[t].w;
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const e = em.get(Math.min(u, v) * KEY + Math.max(u, v));
        if (!e || e.length !== 2) continue;
        for (const [o] of e) {
          if (o === t || seen[o] || !tris[o].p.fix) continue;
          seen[o] = 1;
          if (dirOf(t, u, v) === dirOf(o, u, v)) flip[o] = 1; // both traverse u->v the same way: o disagrees
          stack.push(o); members.push(o);
        }
      }
    }
    // the seed is arbitrary: keep the orientation the larger part of the surface already has (flip the smaller side)
    let fa = 0, ta = 0;
    for (const t of members) { ta += tris[t].area; if (flip[t]) fa += tris[t].area; }
    if (fa > ta / 2) for (const t of members) flip[t] ^= 1;
    for (const t of members) if (flip[t]) flipped.push(t);
  }

  // write the indices back
  const keepIdx = new Map(prims.map((p) => [p, []]));
  for (let t = 0; t < tris.length; t++) {
    if (!alive[t]) continue;
    const q = tris[t].v.slice(); if (flip[t]) [q[1], q[2]] = [q[2], q[1]];
    keepIdx.get(tris[t].p).push(...q);
  }
  for (const p of prims) {
    if (!p.fix) continue;
    const arr = keepIdx.get(p), old = p.prim.getIndices();
    old.setArray(Uint32Array.from(arr));
  }
  const after = defects(tris.map((t, i) => ({ ...t, w: flip[i] ? [t.w[0], t.w[2], t.w[1]] : t.w })), alive);
  const sum = (ts) => { let area = 0; const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; for (const t of ts) { area += tris[t].area; for (const v of tris[t].v) for (let k = 0; k < 3; k++) { const x = tris[t].p.P[v * 3 + k]; if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x; } } return { count: ts.length, area, min: lo, max: hi }; };
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  return { glb: await io.writeBinary(doc), report: { meshes: meshNames, before, after, deleted: sum(deleted), flipped: sum(flipped), total_triangles: tris.length, total_area: tris.reduce((s, t) => s + t.area, 0) } };
}

async function main() {
  const args = process.argv.slice(2), pos = [], opt = {};
  for (let i = 0; i < args.length; i++) { if (args[i] === "--mesh") opt.mesh = args[++i]; else if (args[i] === "--json") opt.json = true; else pos.push(args[i]); }
  if (pos.length !== 2 || !opt.mesh) { console.error("usage: node tools/cut-source-repair.mjs <in.glb> <out.glb> --mesh Name[,Name] [--json]"); process.exit(2); }
  if (pos[0] === pos[1]) { console.error("refusing to overwrite the input"); process.exit(2); }
  const { glb, report } = await repairSource(readFileSync(pos[0]), opt.mesh.split(","));
  writeFileSync(pos[1], glb);
  console.log(JSON.stringify(report, null, 1));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
