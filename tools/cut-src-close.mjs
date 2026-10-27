// Makes a REPAIRED COPY of a body GLB for cutting only: closes the open boundary loops of one skinned mesh, so the cut planes that cross those holes
// find closed geometry. The original is never touched and the copy is not what ships.
//   node tools/cut-src-close.mjs <in.glb> <out.glb> --mesh <name> [--min-edges 10] [--fill pole|flat] [--tol 1e-5] [--report <file.json>]
// What it does, and only this:
//  - decompresses the source like cut-batch does (meshopt/quantisation undone, vertices in metres), so the copy is a plain source;
//  - on every primitive of the named mesh (node or mesh name), welds positions (--tol), finds the open boundary loops (a pinched boundary is split
//    into simple rings), and closes every ring of at least --min-edges edges. Smaller rings stay open. Original vertices are never moved or
//    re-weighted: the copy's first N vertices, indices and every attribute are the original's, byte for byte; the repair only appends.
//  - --fill pole (default): one new vertex per loop, a "pole" a little below the hole (the loop's centre pushed against the mean vertex normal, by the
//    loop's middle standard deviation), and a fan of triangles from each loop edge to it. The cap is a shallow tent under the hole, so it stays
//    inside the body instead of bridging across a concave back as a flat sheet. The pole takes the loop's summed skin weights (top 4 joints,
//    renormalised), its mean normal, and the UVs and any other attribute of the loop vertex nearest the centre.
//  - --fill flat: no new vertex, ear-clipped flat patch on the loop's best-fit plane (a loop that wraps a curve shows up as a sheet; kept for tests).
// The cap winding is the reverse of the loop's boundary edges, so every capped edge gets its opposite and the surface stays consistently oriented.
// Body sources are confidential: run this where they live (the VPS); only the tool and the report numbers are committed.
import { readFileSync, writeFileSync } from "node:fs";
import { decompressGlb, triangulateLoops, weldCluster } from "./cut-units.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const [inPath, outPath] = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const meshName = opt("--mesh"), minEdges = Number(opt("--min-edges", 10)), tol = Number(opt("--tol", 1e-5)), reportPath = opt("--report"), fill = opt("--fill", "pole"), depthK = Number(opt("--depth", 1));
if (!inPath || !outPath || !meshName || !["pole", "flat"].includes(fill)) { console.error("usage: cut-src-close.mjs <in.glb> <out.glb> --mesh <name> [--min-edges 10] [--fill pole|flat] [--tol 1e-5] [--report f.json]"); process.exit(2); }

const { NodeIO } = await import("@gltf-transform/core");
const { ALL_EXTENSIONS } = await import("@gltf-transform/extensions");
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.readBinary(new Uint8Array(await decompressGlb(readFileSync(inPath))));
const root = doc.getRoot();

const targets = new Set();
for (const node of root.listNodes()) if (node.getMesh() && (node.getName() === meshName || node.getMesh().getName() === meshName)) targets.add(node.getMesh());
if (!targets.size) throw new Error(`no mesh or node named ${meshName}`);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a); return l > 1e-12 ? a.map((x) => x / l) : [0, 0, 1]; };
const report = { mesh: meshName, min_edges: minEdges, fill, depth: depthK, tol, primitives: [] };

// eigenvalues of a symmetric 3x3 (Jacobi), ascending
function eig3(m) {
  const a = m.map((r) => r.slice());
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-24) break;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(a[p][q]) < 1e-30) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const kp = a[k][p], kq = a[k][q]; a[k][p] = c * kp - s * kq; a[k][q] = s * kp + c * kq; }
      for (let k = 0; k < 3; k++) { const pk = a[p][k], qk = a[q][k]; a[p][k] = c * pk - s * qk; a[q][k] = s * pk + c * qk; }
    }
  }
  return [a[0][0], a[1][1], a[2][2]].sort((x, y) => x - y);
}

for (const mesh of targets) for (const prim of mesh.listPrimitives()) {
  const pos = prim.getAttribute("POSITION"), n = pos.getCount();
  const P = [];
  for (let i = 0; i < n; i++) P.push(pos.getElement(i, [0, 0, 0]));
  const nrmAcc = prim.getAttribute("NORMAL"), N = nrmAcc ? P.map((_, i) => nrmAcc.getElement(i, [0, 0, 0])) : null;
  const idxAcc = prim.getIndices();
  if (!idxAcc) throw new Error("primitive has no index buffer");
  const idx = Array.from(idxAcc.getArray());
  const wid = weldCluster(P, tol), rep = [];
  for (let i = 0; i < n; i++) if (rep[wid[i]] === undefined) rep[wid[i]] = i;
  const K = 4194304, edge = new Map();
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const w = [wid[idx[t]], wid[idx[t + 1]], wid[idx[t + 2]]];
    for (let e = 0; e < 3; e++) { const u = w[e], v = w[(e + 1) % 3]; if (u !== v) edge.set(u * K + v, (edge.get(u * K + v) || 0) + 1); }
  }
  // boundary edge u->v (no reverse): the cap needs v->u. capOut: from v to u.
  const capOut = new Map();
  for (const [k, c] of edge) {
    const u = Math.floor(k / K), v = k % K;
    if (c > (edge.get(v * K + u) || 0)) { if (!capOut.has(v)) capOut.set(v, []); capOut.get(v).push(u); }
  }
  // Walk the cap edges and cut the walk into simple rings: a welded boundary can pinch (a vertex with two outgoing cap edges), and every time the walk
  // comes back to a vertex already on its path, the ring between is one loop.
  const usedEdge = new Set(), loops = [], skipped = [];
  for (const s of capOut.keys()) {
    for (;;) {
      if (!capOut.get(s).some((u) => !usedEdge.has(s * K + u))) break;
      const path = [s], at = new Map([[s, 0]]);
      for (;;) {
        const cur = path[path.length - 1], nx = capOut.get(cur)?.find((u) => !usedEdge.has(cur * K + u));
        if (nx === undefined) { if (path.length > 1) skipped.push(path.slice()); break; }
        usedEdge.add(cur * K + nx);
        if (at.has(nx)) {
          const j = at.get(nx);
          loops.push(path.slice(j));
          for (const w of path.slice(j + 1)) at.delete(w);
          path.length = j + 1;
        } else { at.set(nx, path.length); path.push(nx); }
      }
    }
  }
  const added = [], poles = []; // poles: { pos, normal, loop: [original vertex index] }
  let area = 0, capped = 0;
  const stats = { forced: 0, bridgeFallback: 0 };
  const tri = (a, b, c, PA, PB, PC) => { area += len(cross(sub(PB, PA), sub(PC, PA))) / 2; added.push(a, b, c); };
  for (const ring of loops) {
    if (ring.length < minEdges) continue;
    const ids = ring.map((w) => rep[w]), pts = ids.map((i) => P[i]);
    if (fill === "pole") {
      const c = [0, 1, 2].map((a) => pts.reduce((s, p) => s + p[a], 0) / pts.length);
      const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (const p of pts) { const d = sub(p, c); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += d[i] * d[j] / pts.length; }
      let nrm = [0, 0, 0];
      if (N) for (const i of ids) nrm = [nrm[0] + N[i][0], nrm[1] + N[i][1], nrm[2] + N[i][2]];
      else for (let k = 0; k < pts.length; k++) { const x = cross(pts[k], pts[(k + 1) % pts.length]); nrm = [nrm[0] + x[0], nrm[1] + x[1], nrm[2] + x[2]]; }
      nrm = unit(nrm);
      const depth = depthK * Math.sqrt(Math.max(eig3(cov)[1], 0));
      const apex = [c[0] - nrm[0] * depth, c[1] - nrm[1] * depth, c[2] - nrm[2] * depth];
      const pi = n + poles.length;
      poles.push({ pos: apex, normal: nrm, loop: ids, centre: c });
      P.push(apex);
      for (let k = 0; k < ids.length; k++) { const a = ids[k], b = ids[(k + 1) % ids.length]; tri(a, b, pi, P[a], P[b], apex); }
    } else {
      let nrm = [0, 0, 0];
      for (let k = 0; k < pts.length; k++) { const x = cross(pts[k], pts[(k + 1) % pts.length]); nrm = [nrm[0] + x[0], nrm[1] + x[1], nrm[2] + x[2]]; }
      if (len(nrm) < 1e-12) { skipped.push(ring); continue; }
      nrm = unit(nrm);
      const ux = cross(Math.abs(nrm[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], nrm), U = unit(ux), V = cross(nrm, U), c0 = pts[0];
      const flat = pts.map((p, k) => { const d = sub(p, c0); return { x: dot(d, U), y: dot(d, V), i: ids[k] }; });
      const tris = triangulateLoops(flat, [], stats);
      for (let t = 0; t < tris.length; t += 3) tri(tris[t], tris[t + 1], tris[t + 2], P[tris[t]], P[tris[t + 1]], P[tris[t + 2]]);
    }
    capped++;
  }
  const where = (ring, cap) => { const c = [0, 1, 2].map((a) => Number((ring.reduce((s, w) => s + P[rep[w]][a], 0) / ring.length).toFixed(4))); return { edges: ring.length, centre: c, capped: cap }; };
  const detail = loops.map((r) => where(r, r.length >= minEdges)).sort((a, b) => b.edges - a.edges);
  report.primitives.push({ loops: detail, vertices: n, vertices_added: poles.length, triangles_before: idx.length / 3, boundary_loops: loops.length + skipped.length, capped_loops: capped, left_open_small: loops.filter((r) => r.length < minEdges).length, skipped_not_simple: skipped.length, cap_triangles: added.length / 3, cap_area_m2: Number(area.toFixed(6)), forced_ears: stats.forced, bridge_fallback: stats.bridgeFallback });

  if (poles.length) {
    // append the poles to every vertex attribute (raw typed arrays; a weight or joint set is rebuilt from the loop's summed weights)
    const sems = prim.listSemantics(), jointSets = sems.filter((s) => /^JOINTS_\d+$/.test(s)).sort();
    const weightFor = (pole) => { // top-4 joints by summed weight over the loop
      const sum = new Map();
      for (const js of jointSets) {
        const J = prim.getAttribute(js), W = prim.getAttribute(js.replace("JOINTS", "WEIGHTS"));
        for (const i of pole.loop) { const j = J.getElement(i, [0, 0, 0, 0]), w = W.getElement(i, [0, 0, 0, 0]); for (let s = 0; s < 4; s++) if (w[s] > 0) sum.set(j[s], (sum.get(j[s]) || 0) + w[s]); }
      }
      const top = [...sum].sort((a, b) => b[1] - a[1]).slice(0, 4), tot = top.reduce((s, x) => s + x[1], 0) || 1;
      return { joints: [0, 1, 2, 3].map((s) => (top[s] ? top[s][0] : 0)), weights: [0, 1, 2, 3].map((s) => (top[s] ? top[s][1] / tot : 0)) };
    };
    const wf = poles.map(weightFor);
    const nearest = poles.map((p) => p.loop.reduce((b, i) => (len(sub(P[i], p.centre)) < len(sub(P[b], p.centre)) ? i : b), p.loop[0]));
    for (const sem of sems) {
      const acc = prim.getAttribute(sem), size = acc.getElementSize(), old = acc.getArray(), norm = acc.getNormalized();
      const max = norm ? (old instanceof Uint8Array ? 255 : old instanceof Uint16Array ? 65535 : old instanceof Int8Array ? 127 : 32767) : 1;
      const out = new old.constructor((n + poles.length) * size);
      out.set(old);
      poles.forEach((p, k) => {
        const base = (n + k) * size;
        if (sem === "POSITION") out.set(p.pos, base);
        else if (sem === "NORMAL") out.set(p.normal, base);
        else if (/^JOINTS_\d+$/.test(sem)) out.set(sem === jointSets[0] ? wf[k].joints : new Array(size).fill(0), base);
        else if (/^WEIGHTS_\d+$/.test(sem)) out.set(sem === jointSets[0].replace("JOINTS", "WEIGHTS") ? wf[k].weights.map((w) => (old instanceof Float32Array ? w : Math.round(w * max))) : new Array(size).fill(0), base);
        else out.set(old.subarray(nearest[k] * size, nearest[k] * size + size), base);
      });
      // a quantised weight set must still sum to 1: put the rounding remainder on the largest weight
      if (/^WEIGHTS_0$/.test(sem) && norm) poles.forEach((_, k) => { const b = (n + k) * size; let s = 0, m = 0; for (let c = 0; c < size; c++) { s += out[b + c]; if (out[b + c] > out[b + m]) m = c; } out[b + m] += max - s; });
      acc.setArray(out);
    }
  }
  if (added.length) {
    const Arr = idxAcc.getArray().constructor, top = n + poles.length;
    const next = new (top > 65535 && Arr === Uint16Array ? Uint32Array : Arr)(idx.length + added.length);
    next.set(idx); next.set(added, idx.length);
    idxAcc.setArray(next);
  }
}

writeFileSync(outPath, await io.writeBinary(doc));
const text = JSON.stringify(report, null, 1);
if (reportPath) writeFileSync(reportPath, text + "\n");
console.log(text);
