// Makes a REPAIRED COPY of a body GLB for cutting only: caps the open boundary loops of one skinned mesh with hand-made triangles, so the cut planes
// that cross those holes find closed geometry. The original is never touched and the copy is not what ships.
//   node tools/cut-src-close.mjs <in.glb> <out.glb> --mesh <name> [--min-edges 28] [--tol 1e-5] [--report <file.json>]
// What it does, and only this:
//  - decompresses the source like cut-batch does (meshopt/quantisation undone, vertices in metres), so the copy is a plain source;
//  - on every primitive of the named mesh (node or mesh name), welds positions (--tol), finds the open boundary loops, and for each loop of at least
//    --min-edges edges appends an ear-clipped cap to the INDEX buffer. No vertex is added, moved or re-weighted: the copy has the same
//    positions, normals, UVs, joints and weights, byte for byte, plus extra triangles that reuse existing vertices (so no new skin weights are
//    invented: a cap vertex keeps the weights it already had);
//  - smaller loops (eye sockets, lash and brow card outlines, mouth) stay open; a loop that is not a simple ring is skipped and reported.
// The cap winding is the reverse of the loop's boundary edges, so every capped edge gets its opposite and the surface stays consistently oriented.
// Body sources are confidential: run this where they live (the VPS); only the tool and the report numbers are committed.
import { readFileSync, writeFileSync } from "node:fs";
import { decompressGlb, triangulateLoops, weldCluster } from "./cut-units.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const [inPath, outPath] = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const meshName = opt("--mesh"), minEdges = Number(opt("--min-edges", 28)), tol = Number(opt("--tol", 1e-5)), reportPath = opt("--report");
if (!inPath || !outPath || !meshName) { console.error("usage: cut-src-close.mjs <in.glb> <out.glb> --mesh <name> [--min-edges 28] [--tol 1e-5] [--report f.json]"); process.exit(2); }

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
const report = { mesh: meshName, min_edges: minEdges, tol, primitives: [] };

for (const mesh of targets) for (const prim of mesh.listPrimitives()) {
  const pos = prim.getAttribute("POSITION"), n = pos.getCount();
  const P = [], el = [0, 0, 0];
  for (let i = 0; i < n; i++) P.push(pos.getElement(i, [0, 0, 0]));
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
  // boundary edge u->v (no reverse): the cap needs v->u. capNext: from v to u.
  const capOut = new Map();
  for (const [k, c] of edge) {
    const u = Math.floor(k / K), v = k % K;
    if (c > (edge.get(v * K + u) || 0)) { if (!capOut.has(v)) capOut.set(v, []); capOut.get(v).push(u); }
  }
  // Walk the cap edges and cut the walk into simple rings: a welded boundary can pinch (a vertex with two outgoing cap edges), and every time the walk
  // comes back to a vertex already on its path, the rings between is one loop.
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
  const added = []; let area = 0, capped = 0, forced = 0;
  const stats = { forced: 0, bridgeFallback: 0 };
  for (const ring of loops) {
    if (ring.length < minEdges) continue;
    const pts = ring.map((w) => P[rep[w]]);
    let nrm = [0, 0, 0];
    for (let k = 0; k < pts.length; k++) { const c = cross(pts[k], pts[(k + 1) % pts.length]); nrm = [nrm[0] + c[0], nrm[1] + c[1], nrm[2] + c[2]]; }
    const nl = len(nrm); if (nl < 1e-12) { skipped.push(ring); continue; }
    nrm = nrm.map((x) => x / nl);
    const a = Math.abs(nrm[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const ux = cross(a, nrm), ul = len(ux), U = ux.map((x) => x / ul), V = cross(nrm, U);
    const c0 = pts[0];
    const flat = pts.map((p, k) => { const d = sub(p, c0); return { x: dot(d, U), y: dot(d, V), i: rep[ring[k]] }; });
    const tris = triangulateLoops(flat, [], stats);
    for (let t = 0; t < tris.length; t += 3) {
      const A = P[tris[t]], B = P[tris[t + 1]], C = P[tris[t + 2]];
      area += len(cross(sub(B, A), sub(C, A))) / 2;
      added.push(tris[t], tris[t + 1], tris[t + 2]);
    }
    capped++;
  }
  const where = (ring, capped) => { const c = [0, 1, 2].map((a) => Number((ring.reduce((s, w) => s + P[rep[w]][a], 0) / ring.length).toFixed(4))); return { edges: ring.length, centre: c, capped }; };
  const detail = loops.map((r) => where(r, r.length >= minEdges)).sort((a, b) => b.edges - a.edges);
  report.primitives.push({ loops: detail, vertices: n, triangles_before: idx.length / 3, boundary_loops: loops.length + skipped.length, capped_loops: capped, left_open_small: loops.filter((r) => r.length < minEdges).length, skipped_not_simple: skipped.length, cap_triangles: added.length / 3, cap_area_m2: Number(area.toFixed(6)), forced_ears: stats.forced, bridge_fallback: stats.bridgeFallback });
  if (added.length) {
    const Arr = idxAcc.getArray().constructor, max = Math.max(...added);
    const next = new (max > 65535 && Arr === Uint16Array ? Uint32Array : Arr)(idx.length + added.length);
    next.set(idx); next.set(added, idx.length);
    idxAcc.setArray(next);
  }
}

writeFileSync(outPath, await io.writeBinary(doc));
const text = JSON.stringify(report, null, 1);
if (reportPath) writeFileSync(reportPath, text + "\n");
console.log(text);
