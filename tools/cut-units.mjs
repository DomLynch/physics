// Body GLB -> seven skinned cut regions + twelve cap meshes on the unchanged skeleton (docs/CUT-CONTRACT.md, docs/CUT-TOOL.md).
//   node tools/cut-units.mjs <body.glb> <body.measure.json> <rig-map.json> <out-dir> [--body name]
// writes <out-dir>/<body>.cut.glb and <out-dir>/<body>.cut.manifest.json.
// Needs @gltf-transform/core + /extensions + meshoptimizer (devDependencies; the package's runtime never loads this file).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- contract tables
export const REGIONS = [
  { id: "root", mesh: "piece_root", detached_by: null },
  { id: "upper_torso", mesh: "piece_upper_torso", detached_by: "torso_waist" },
  { id: "head", mesh: "piece_head", detached_by: "head" },
  { id: "arm_left", mesh: "piece_arm_left", detached_by: "arm_left" },
  { id: "arm_right", mesh: "piece_arm_right", detached_by: "arm_right" },
  { id: "leg_left", mesh: "piece_leg_left", detached_by: "leg_left" },
  { id: "leg_right", mesh: "piece_leg_right", detached_by: "leg_right" },
];
export const CAPS = [
  { id: "cap_neck_head", region: "head", plane: "neck", shown_when_cut: "head" },
  { id: "cap_neck_torso", region: "upper_torso", plane: "neck", shown_when_cut: "head" },
  { id: "cap_shoulder_left_arm", region: "arm_left", plane: "shoulder_left", shown_when_cut: "arm_left" },
  { id: "cap_shoulder_left_torso", region: "upper_torso", plane: "shoulder_left", shown_when_cut: "arm_left" },
  { id: "cap_shoulder_right_arm", region: "arm_right", plane: "shoulder_right", shown_when_cut: "arm_right" },
  { id: "cap_shoulder_right_torso", region: "upper_torso", plane: "shoulder_right", shown_when_cut: "arm_right" },
  { id: "cap_hip_left_leg", region: "leg_left", plane: "hip_left", shown_when_cut: "leg_left" },
  { id: "cap_hip_left_root", region: "root", plane: "hip_left", shown_when_cut: "leg_left" },
  { id: "cap_hip_right_leg", region: "leg_right", plane: "hip_right", shown_when_cut: "leg_right" },
  { id: "cap_hip_right_root", region: "root", plane: "hip_right", shown_when_cut: "leg_right" },
  { id: "cap_waist_torso", region: "upper_torso", plane: "waist", shown_when_cut: "torso_waist" },
  { id: "cap_waist_root", region: "root", plane: "waist", shown_when_cut: "torso_waist" },
];
// the bone that anchors each region: the nearest ancestor-or-self of a node among these decides which region owns the bone
const ANCHOR_ROLES = { Hips: "root", Spine: "upper_torso", Head: "head", LeftArm: "arm_left", RightArm: "arm_right", LeftUpLeg: "leg_left", RightUpLeg: "leg_right" };
const REGION_ANCHOR = { root: "Hips", upper_torso: "Spine", head: "Head", arm_left: "LeftArm", arm_right: "RightArm", leg_left: "LeftUpLeg", leg_right: "RightUpLeg" };
const FLESH = { name: "cap_flesh", color: [0.55, 0.1, 0.09, 1], roughness: 0.55 };

// ---------------------------------------------------------------- small vector helpers
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const posLess = (a, b) => a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];

// ---------------------------------------------------------------- planes
// A plane fn has d(p) = n.p - c with n unit, so d is the signed distance. Positive side = the outer unit (head / arm / leg / upper torso).
function makeFn(id, point, normal, source) {
  const n = norm(normal);
  return { id, n, c: dot(n, point), point, source, d: (p) => n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - dot(n, point) };
}
// apex: the crotch point (where the two inner thighs meet), or null for the contract's plain thigh-normal hip planes. With an apex each hip plane
// keeps its point (the UpLeg joint) and is turned about its line to the apex, as little as possible away from the thigh normal, so the two
// hip planes meet below the pelvis, no mesh sits in the wedge under both, and the legs need no wall between them.
export function buildPlanes(J, apex = null) {
  const need = ["Hips", "Spine", "Neck", "Head", "LeftArm", "LeftForeArm", "RightArm", "RightForeArm", "LeftUpLeg", "LeftLeg", "RightUpLeg", "RightLeg"];
  for (const r of need) if (!J[r]) throw new Error("measure row has no joint " + r);
  const fns = {};
  fns.neck = makeFn("neck", lerp3(J.Neck, J.Head, 0.5), sub(J.Head, J.Neck), "half way from the Neck joint to the Head joint, normal along Neck to Head");
  // the upper arm bone with its vertical part dropped: a plane square to a drooping arm tilts into the flank and gives the arm a slab of ribs
  const shoulderNormal = (A, B) => { const d = sub(B, A), h = [d[0], 0, d[2]]; return vlen(h) >= 0.5 * vlen(d) ? h : d; };
  const shSrc = "joint, normal along the upper arm bone with its vertical part dropped (a plane square to a drooping arm would cut into the flank)";
  fns.shoulder_left = makeFn("shoulder_left", J.LeftArm, shoulderNormal(J.LeftArm, J.LeftForeArm), "LeftArm " + shSrc);
  fns.shoulder_right = makeFn("shoulder_right", J.RightArm, shoulderNormal(J.RightArm, J.RightForeArm), "RightArm " + shSrc);
  const hipNormal = (H, K) => {
    const t = norm(sub(K, H));
    if (!apex) return t;
    const e = norm(sub(apex, H));
    const n = norm(sub(t, e.map((x) => x * dot(t, e))));
    return dot(n, t) > 0.3 ? n : t; // never turn the plane more than about 70 degrees from the thigh normal
  };
  const hipSrc = apex ? "UpLeg joint, normal along the thigh turned the least that puts the plane through the crotch apex" : "UpLeg joint, normal along the thigh";
  fns.hip_left = makeFn("hip_left", J.LeftUpLeg, hipNormal(J.LeftUpLeg, J.LeftLeg), "LeftUpLeg joint, " + hipSrc.replace("UpLeg joint, ", ""));
  fns.hip_right = makeFn("hip_right", J.RightUpLeg, hipNormal(J.RightUpLeg, J.RightLeg), "RightUpLeg joint, " + hipSrc.replace("UpLeg joint, ", ""));
  fns.waist = makeFn("waist", J.Spine, sub(J.Spine, J.Hips), "Spine joint, normal along Hips to Spine");
  // internal, not a cut: where the two hip half-spaces overlap below the crotch, the side with the larger distance wins (a wall only if mesh sits there)
  const bn = sub(fns.hip_left.n, fns.hip_right.n);
  const bp = lerp3(fns.hip_left.point, fns.hip_right.point, 0.5);
  fns.hip_split = makeFn("hip_split", bp, vlen(bn) > 1e-9 ? bn : sub(J.LeftUpLeg, J.RightUpLeg), "internal: bisector of the two hip planes, separates the legs where both hip half-spaces overlap (no cap of its own)");
  fns.hip_split.d = (p) => fns.hip_left.d(p) - fns.hip_right.d(p), fns.hip_split.exact = true;
  return fns;
}

// ---------------------------------------------------------------- weld analysis (exported: the tests use the same measure)
// meshes: [{ positions: ArrayLike<number> (xyz), indices: ArrayLike<number> }]. Welds points closer than tol (metres), counts directed edges.
// A closed oriented surface has every directed edge exactly once and its reverse exactly once.
export function weldReport(meshes, tol = 1e-5, collect = false) {
  const pts = [], base = [];
  for (const m of meshes) { base.push(pts.length); for (let i = 0; i < m.positions.length; i += 3) pts.push([m.positions[i], m.positions[i + 1], m.positions[i + 2]]); }
  const wid = weldCluster(pts, tol);
  const firstPos = [];
  for (let i = 0; i < pts.length; i++) if (firstPos[wid[i]] === undefined) firstPos[wid[i]] = pts[i];
  const edge = new Map();
  let degenerate = 0, tris = 0;
  meshes.forEach((m, mi) => {
    for (let t = 0; t + 2 < m.indices.length; t += 3) {
      const a = wid[base[mi] + m.indices[t]], b = wid[base[mi] + m.indices[t + 1]], c = wid[base[mi] + m.indices[t + 2]];
      tris++;
      if (a === b || b === c || c === a) degenerate++;
      for (const [u, v] of [[a, b], [b, c], [c, a]]) if (u !== v) edge.set(u * 4194304 + v, (edge.get(u * 4194304 + v) || 0) + 1);
    }
  });
  const ids = { size: firstPos.length };
  let boundary = 0, nonManifold = 0;
  const boundaryAt = [];
  for (const [k, cnt] of edge) {
    const u = Math.floor(k / 4194304), v = k % 4194304;
    const rev = edge.get(v * 4194304 + u) || 0;
    if (cnt > 1) nonManifold++;
    if (cnt > rev) { boundary += cnt - rev; if (collect || boundaryAt.length < 8) boundaryAt.push([firstPos[u], firstPos[v]]); }
  }
  return { boundary_list: collect ? boundaryAt : undefined, triangles: tris, vertices: ids.size, degenerate, boundary_edges: boundary, non_manifold_edges: nonManifold, watertight: boundary === 0 && nonManifold === 0, boundary_sample: boundaryAt };
}

// cluster points closer than tol (union-find over a spatial hash); returns a compact id per point, ids in order of first appearance
export function weldCluster(points, tol) {
  const n = points.length, parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const inv = 1 / tol, grid = new Map(), t2 = tol * tol;
  const key = (x, y, z) => (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  for (let i = 0; i < n; i++) {
    const p = points[i], cx = Math.floor(p[0] * inv), cy = Math.floor(p[1] * inv), cz = Math.floor(p[2] * inv);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = grid.get(key(cx + dx, cy + dy, cz + dz));
      if (!list) continue;
      for (const j of list) {
        const q = points[j];
        if ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2 <= t2) { const a = find(i), b = find(j); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); }
      }
    }
    const k = key(cx, cy, cz);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  const ids = new Int32Array(n), compact = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!compact.has(r)) compact.set(r, compact.size); ids[i] = compact.get(r); }
  return ids;
}

// ---------------------------------------------------------------- polygon triangulation (ear clipping with hole bridging)
// outer: CCW points [{x,y,i}], holes: CW rings. Returns flat [i,i,i,...] with CCW triangles; every input vertex is used (none dropped,
// so the cap's boundary edges match the piece's edges exactly). stats.forced counts ears clipped without passing the strict test.
const area2 = (a, b, c) => (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y); // < 0 convex (CCW polygon), >= 0 reflex or flat
const same2 = (a, b) => a.x === b.x && a.y === b.y;
function inTri(a, b, c, p) {
  return (c.x - p.x) * (a.y - p.y) - (a.x - p.x) * (c.y - p.y) >= 0 && (a.x - p.x) * (b.y - p.y) - (b.x - p.x) * (a.y - p.y) >= 0 && (b.x - p.x) * (c.y - p.y) - (c.x - p.x) * (b.y - p.y) >= 0;
}
function ring(pts, ccw) {
  let a = 0;
  for (let k = 0; k < pts.length; k++) { const p = pts[k], q = pts[(k + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
  const arr = (a > 0) === ccw ? pts : pts.slice().reverse();
  let first = null, last = null;
  for (const p of arr) { const n = { i: p.i, x: p.x, y: p.y, prev: null, next: null }; if (!first) first = n; else { last.next = n; n.prev = last; } last = n; }
  last.next = first; first.prev = last;
  return first;
}
function locallyInside(a, b) {
  return area2(a.prev, a, a.next) < 0 ? area2(a, b, a.next) >= 0 && area2(a, a.prev, b) >= 0 : area2(a, b, a.prev) < 0 || area2(a, a.next, b) < 0;
}
function findHoleBridge(hole, outer) {
  let p = outer, qx = -Infinity, m = null;
  const hx = hole.x, hy = hole.y;
  do {
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + (hy - p.y) * (p.next.x - p.x) / (p.next.y - p.y);
      if (x <= hx && x > qx) { qx = x; m = p.x < p.next.x ? p : p.next; if (x === hx) return m; }
    }
    p = p.next;
  } while (p !== outer);
  if (!m) return null;
  const stop = m, mx = m.x, my = m.y;
  let tanMin = Infinity;
  p = m;
  do {
    if (hx >= p.x && p.x >= mx && hx !== p.x && inTri({ x: hy < my ? hx : qx, y: hy }, { x: mx, y: my }, { x: hy < my ? qx : hx, y: hy }, p)) {
      const tan = Math.abs(hy - p.y) / (hx - p.x);
      if (locallyInside(p, hole) && (tan < tanMin || (tan === tanMin && p.x > m.x))) { m = p; tanMin = tan; }
    }
    p = p.next;
  } while (p !== stop);
  return m;
}
function splitPolygon(a, b) {
  const a2 = { i: a.i, x: a.x, y: a.y, prev: null, next: null }, b2 = { i: b.i, x: b.x, y: b.y, prev: null, next: null };
  const an = a.next, bp = b.prev;
  a.next = b; b.prev = a; a2.next = an; an.prev = a2; b2.next = a2; a2.prev = b2; bp.next = b2; b2.prev = bp;
  return b2;
}
export function triangulateLoops(outerPts, holePts, stats = { forced: 0, bridgeFallback: 0 }) {
  let outer = ring(outerPts, true);
  const holes = holePts.map((h) => {
    let n = ring(h, false), left = n, p = n;
    do { if (p.x < left.x || (p.x === left.x && p.y < left.y)) left = p; p = p.next; } while (p !== n);
    return left;
  }).sort((a, b) => a.x - b.x || a.y - b.y);
  for (const h of holes) {
    let m = findHoleBridge(h, outer);
    if (!m) { // no visible segment: join to the nearest outer vertex
      stats.bridgeFallback++;
      let best = Infinity, p = outer;
      do { const d = (p.x - h.x) ** 2 + (p.y - h.y) ** 2; if (d < best) { best = d; m = p; } p = p.next; } while (p !== outer);
    }
    splitPolygon(m, h);
  }
  let n = 0, p = outer;
  do { n++; p = p.next; } while (p !== outer);
  const tris = [];
  let ear = outer, fails = 0, mode = 0;
  const isEar = (e, md) => {
    const a = e.prev, c = e.next, ar = area2(a, e, c);
    if (md === 0 ? ar >= 0 : ar > 0) return false;
    for (let q = c.next; q !== a; q = q.next) {
      if (same2(q, a) || same2(q, e) || same2(q, c)) continue;
      if (inTri(a, e, c, q) && area2(q.prev, q, q.next) >= 0) return false;
    }
    return true;
  };
  while (n > 3) {
    if (mode === 3 || isEar(ear, mode)) {
      if (mode === 3) stats.forced++;
      tris.push(ear.prev.i, ear.i, ear.next.i);
      const nx = ear.next;
      ear.prev.next = nx; nx.prev = ear.prev;
      ear = nx; n--; fails = 0; mode = 0;
      continue;
    }
    ear = ear.next; fails++;
    if (fails >= n) {
      fails = 0; mode++;
      if (mode === 3) { // forced: the most convex vertex
        let best = ear, bv = Infinity, q = ear;
        do { const ar = area2(q.prev, q, q.next); if (ar < bv) { bv = ar; best = q; } q = q.next; } while (q !== ear);
        ear = best;
      }
    }
  }
  tris.push(ear.prev.i, ear.i, ear.next.i);
  return tris;
}

// ---------------------------------------------------------------- GLB io (gltf-transform; the V3 bodies are meshopt compressed)
async function gltfIO() {
  const { NodeIO } = await import("@gltf-transform/core");
  const { ALL_EXTENSIONS } = await import("@gltf-transform/extensions");
  const { MeshoptDecoder } = await import("meshoptimizer");
  await MeshoptDecoder.ready;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
}
const mul4 = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; }; // column-major a x b

// The source GLB with meshopt and quantisation undone: plain float32 vertex attributes, same vertex space, same nodes (for plain readers such as
// tools/cut-validate.mjs: `--source-out` writes it).
export async function decompressGlb(glbBytes) {
  const io = await gltfIO();
  const doc = await io.readBinary(glbBytes instanceof Uint8Array ? glbBytes : new Uint8Array(glbBytes));
  // like the cut output: vertices in metres (vertex space -> world baked in, inverse binds absorb the inverse), so source and cut compare directly
  const skin = doc.getRoot().listSkins()[0], ibm = skin && skin.getInverseBindMatrices();
  let Q = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (ibm) Q = mul4(skin.listJoints()[0].getWorldMatrix(), ibm.getElement(0, new Array(16)));
  const A = [Q[0], Q[4], Q[8], Q[1], Q[5], Q[9], Q[2], Q[6], Q[10]];
  const [a0, b0, c0, d0, e0, f0, g0, h0, i0] = A, det = a0 * (e0 * i0 - f0 * h0) - b0 * (d0 * i0 - f0 * g0) + c0 * (d0 * h0 - e0 * g0);
  const Ai = [(e0 * i0 - f0 * h0) / det, (c0 * h0 - b0 * i0) / det, (b0 * f0 - c0 * e0) / det, (f0 * g0 - d0 * i0) / det, (a0 * i0 - c0 * g0) / det, (c0 * d0 - a0 * f0) / det, (d0 * h0 - e0 * g0) / det, (b0 * g0 - a0 * h0) / det, (a0 * e0 - b0 * d0) / det];
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) for (const sem of prim.listSemantics()) {
    const a = prim.getAttribute(sem);
    if (/^JOINTS_/.test(sem)) continue;
    const n = a.getElementSize(), out = new Float32Array(a.getCount() * n), el = new Array(n).fill(0);
    for (let i = 0; i < a.getCount(); i++) {
      a.getElement(i, el);
      if (sem === "POSITION") out.set([A[0] * el[0] + A[1] * el[1] + A[2] * el[2] + Q[12], A[3] * el[0] + A[4] * el[1] + A[5] * el[2] + Q[13], A[6] * el[0] + A[7] * el[1] + A[8] * el[2] + Q[14]], i * n);
      else if (sem === "NORMAL") out.set(norm([Ai[0] * el[0] + Ai[3] * el[1] + Ai[6] * el[2], Ai[1] * el[0] + Ai[4] * el[1] + Ai[7] * el[2], Ai[2] * el[0] + Ai[5] * el[1] + Ai[8] * el[2]]), i * n);
      else out.set(el, i * n);
    }
    prim.setAttribute(sem, doc.createAccessor().setType(a.getType()).setArray(out).setBuffer(doc.getRoot().listBuffers()[0]));
  }
  if (ibm) {
    const t = [-(Ai[0] * Q[12] + Ai[1] * Q[13] + Ai[2] * Q[14]), -(Ai[3] * Q[12] + Ai[4] * Q[13] + Ai[5] * Q[14]), -(Ai[6] * Q[12] + Ai[7] * Q[13] + Ai[8] * Q[14])];
    const Qinv = [Ai[0], Ai[3], Ai[6], 0, Ai[1], Ai[4], Ai[7], 0, Ai[2], Ai[5], Ai[8], 0, t[0], t[1], t[2], 1];
    const arr = new Float32Array(ibm.getCount() * 16);
    for (let i = 0; i < ibm.getCount(); i++) arr.set(mul4(ibm.getElement(i, new Array(16)), Qinv), i * 16);
    ibm.setArray(arr);
  }
  for (const ext of doc.getRoot().listExtensionsUsed()) if (ext.extensionName === "EXT_meshopt_compression" || ext.extensionName === "KHR_mesh_quantization") ext.dispose();
  return io.writeBinary(doc);
}

// ---------------------------------------------------------------- the cutter
export async function cutGlb(glbBytes, row, rigMap, opts = {}) {
  const io = await gltfIO();
  const doc = await io.readBinary(glbBytes instanceof Uint8Array ? glbBytes : new Uint8Array(glbBytes));
  const root = doc.getRoot();
  const report = { notes: [] };

  // ---- skeleton, bone ownership
  const skinNodes = root.listNodes().filter((n) => n.getMesh() && n.getSkin());
  if (!skinNodes.length) throw new Error("no skinned mesh node in the GLB");
  const skin0 = skinNodes[0].getSkin();
  const joints = skin0.listJoints();
  const jIndex = new Map(joints.map((n, i) => [n, i]));
  const jointByName = new Map(joints.map((n, i) => [n.getName(), i]));
  const roleJoint = {};
  for (const [role, name] of Object.entries(rigMap.joints)) {
    if (!jointByName.has(name)) throw new Error(`rig map names ${name} for ${role}, but the skin has no such joint`);
    roleJoint[role] = jointByName.get(name);
  }
  // bind pose of every joint in world space (metres) = node world translation, the way tools/glb-measure.mjs reads it
  const bindPos = joints.map((n) => n.getWorldTranslation());
  // vertex space -> world: jointWorld x inverseBind is the same matrix Q for every joint (gltfpack bakes its position dequantisation into the
  // inverse binds, so the vertices of the quantised bodies are not in metres). Everything geometric below runs in world space.
  const ibm = skin0.getInverseBindMatrices();
  let Q = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (ibm) {
    const q = (i) => mul4(joints[i].getWorldMatrix(), ibm.getElement(i, new Array(16)));
    Q = q(roleJoint.Hips);
    for (const role of ["Head", "LeftToeBase", "RightHand"]) if (roleJoint[role] !== undefined) {
      const o = q(roleJoint[role]);
      for (let k = 0; k < 16; k++) if (Math.abs(o[k] - Q[k]) > 1e-4 * (1 + Math.abs(Q[k]))) throw new Error("joint world x inverse bind differs between joints: the skin is not at its bind pose");
    }
  }
  const A = [Q[0], Q[4], Q[8], Q[1], Q[5], Q[9], Q[2], Q[6], Q[10]]; // row-major 3x3 of vertex -> world
  const toWorld = (p) => [A[0] * p[0] + A[1] * p[1] + A[2] * p[2] + Q[12], A[3] * p[0] + A[4] * p[1] + A[5] * p[2] + Q[13], A[6] * p[0] + A[7] * p[1] + A[8] * p[2] + Q[14]];
  // The output is written in metres: vertices go to world and the inverse binds absorb Q^-1 (jointWorld x (IBM Q^-1) x (Q v) = jointWorld x IBM x v),
  // so the contract file is plain float32 in the units of the measure row, with no hidden dequantisation matrix.
  const Ai = (() => {
    const [a, b, c, d, e, f, g, h, i] = A, det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    return [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det, (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det, (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
  })();
  const normalToWorld = (n) => norm([Ai[0] * n[0] + Ai[3] * n[1] + Ai[6] * n[2], Ai[1] * n[0] + Ai[4] * n[1] + Ai[7] * n[2], Ai[2] * n[0] + Ai[5] * n[1] + Ai[8] * n[2]]); // A^-T n
  const tangentToWorld = (t) => [A[0] * t[0] + A[1] * t[1] + A[2] * t[2], A[3] * t[0] + A[4] * t[1] + A[5] * t[2], A[6] * t[0] + A[7] * t[1] + A[8] * t[2]];
  const Qinv = (() => { const t = [-(Ai[0] * Q[12] + Ai[1] * Q[13] + Ai[2] * Q[14]), -(Ai[3] * Q[12] + Ai[4] * Q[13] + Ai[5] * Q[14]), -(Ai[6] * Q[12] + Ai[7] * Q[13] + Ai[8] * Q[14])]; return [Ai[0], Ai[3], Ai[6], 0, Ai[1], Ai[4], Ai[7], 0, Ai[2], Ai[5], Ai[8], 0, t[0], t[1], t[2], 1]; })();
  const normalToVertex = (n) => norm([A[0] * n[0] + A[3] * n[1] + A[6] * n[2], A[1] * n[0] + A[4] * n[1] + A[7] * n[2], A[2] * n[0] + A[5] * n[1] + A[8] * n[2]]); // A^T n
  // the measure row is floor-lifted (tools/glb-measure.mjs): recover its offset from the 20 role joints
  const roles = Object.keys(rigMap.joints).filter((r) => row.joints[r]);
  const offs = roles.map((r) => sub(bindPos[roleJoint[r]], row.joints[r]));
  const med = (k) => offs.map((o) => o[k]).sort((a, b) => a - b)[Math.floor(offs.length / 2)];
  const offset = [med(0), med(1), med(2)];
  let resid = 0;
  for (const o of offs) resid = Math.max(resid, Math.abs(o[0] - offset[0]), Math.abs(o[1] - offset[1]), Math.abs(o[2] - offset[2]));
  if (resid > 2e-3) throw new Error(`measure row does not match the GLB skeleton (joint residual ${resid.toFixed(4)} m after the floor offset)`);
  const J = {};
  for (const r of Object.keys(row.joints)) J[r] = [row.joints[r][0] + offset[0], row.joints[r][1] + offset[1], row.joints[r][2] + offset[2]];

  const owner = joints.map((n) => { // region owning each joint: nearest ancestor-or-self that is an anchor
    for (let p = n; p; p = p.getParentNode()) for (const [role, region] of Object.entries(ANCHOR_ROLES)) if (jIndex.get(p) === roleJoint[role]) return region;
    return "root";
  });
  const nodeNeighbours = (n) => [n.getParentNode(), ...n.listChildren()].filter(Boolean);
  const nearCache = new Map();
  const nearOwned = (j, region) => { // the nearest joint (tree distance) owned by `region`
    const key = j * 8 + REGIONS.findIndex((r) => r.id === region);
    if (nearCache.has(key)) return nearCache.get(key);
    let level = [joints[j]];
    const seen = new Set(level);
    let found = null;
    while (level.length && found === null) {
      const hits = level.map((n) => jIndex.get(n)).filter((k) => k !== undefined && owner[k] === region).sort((a, b) => a - b);
      if (hits.length) { found = hits[0]; break; }
      const next = [];
      for (const n of level) for (const m of nodeNeighbours(n)) if (!seen.has(m)) { seen.add(m); next.push(m); }
      level = next;
    }
    if (found === null) found = roleJoint[REGION_ANCHOR[region]];
    nearCache.set(key, found);
    return found;
  };

  // ---- source vertices and triangles (all skinned primitives of all skinned mesh nodes)
  const V = { pos: [], raw: [], attr: {}, skin: [] }; // pos = world (metres, bind pose), raw = the vertex space the GLB stores
  const srcPrims = [], tris = [];
  let semantics = null;
  const oldMeshes = new Set(), oldSkins = new Set(), oldNodes = [];
  for (const node of skinNodes) {
    const skin = node.getSkin();
    const jmap = skin.listJoints().map((jn) => { if (!jIndex.has(jn)) throw new Error("a second skin binds a joint that is not in the first skin: " + jn.getName()); return jIndex.get(jn); });
    if (skin !== skin0) oldSkins.add(skin);
    oldNodes.push(node);
    const mesh = node.getMesh();
    oldMeshes.add(mesh);
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) throw new Error("only triangle primitives are supported");
      if (prim.listTargets().length) throw new Error("morph targets are not supported");
      if (prim.getAttribute("JOINTS_1")) throw new Error("JOINTS_1 (more than four influences per vertex) is not supported");
      const sems = prim.listSemantics().filter((s) => !/^(POSITION|JOINTS_0|WEIGHTS_0)$/.test(s)).sort();
      if (semantics === null) { semantics = sems; for (const s of sems) V.attr[s] = []; } else if (sems.join() !== semantics.join()) throw new Error("primitives carry different attribute sets: " + sems + " vs " + semantics);
      const pa = prim.getAttribute("POSITION"), ja = prim.getAttribute("JOINTS_0"), wa = prim.getAttribute("WEIGHTS_0");
      if (!ja || !wa) throw new Error("a primitive has no JOINTS_0 / WEIGHTS_0");
      const base = V.pos.length, n = pa.getCount();
      const sizes = Object.fromEntries(sems.map((s) => [s, prim.getAttribute(s).getElementSize()]));
      for (let i = 0; i < n; i++) {
        const rawp = pa.getElement(i, [0, 0, 0]);
        V.raw.push(rawp); V.pos.push(toWorld(rawp));
        for (const s of sems) V.attr[s].push(prim.getAttribute(s).getElement(i, new Array(sizes[s]).fill(0)));
        const jj = ja.getElement(i, [0, 0, 0, 0]), ww = wa.getElement(i, [0, 0, 0, 0]);
        const sp = [];
        for (let k = 0; k < 4; k++) if (ww[k] > 0) sp.push([jmap[jj[k]], ww[k]]);
        V.skin.push(sp);
      }
      const idx = prim.getIndices();
      const cnt = idx ? idx.getCount() : n;
      const pi = srcPrims.length;
      srcPrims.push({ material: prim.getMaterial(), name: mesh.getName() });
      for (let t = 0; t + 2 < cnt; t += 3) {
        const a = idx ? idx.getScalar(t) : t, b = idx ? idx.getScalar(t + 1) : t + 1, c = idx ? idx.getScalar(t + 2) : t + 2;
        tris.push([base + a, base + b, base + c, pi]);
      }
    }
  }
  const verticesIn = V.pos.length;
  // The bodies carry hairline cracks along their UV seams (duplicate vertices a few 0.01 mm apart, from the exporter's quantisation). Snap vertices
  // closer than 0.15 mm onto one position so a cut loop through a crack still closes; the surface moves by under 0.15 mm.
  const pre = weldCluster(V.pos, 1.5e-4), firstOf = new Map();
  let snapped = 0;
  for (let v = 0; v < verticesIn; v++) {
    const c = pre[v];
    if (!firstOf.has(c)) { firstOf.set(c, v); continue; }
    const r = firstOf.get(c);
    if (opts.snapCracks === true && (V.pos[v][0] !== V.pos[r][0] || V.pos[v][1] !== V.pos[r][1] || V.pos[v][2] !== V.pos[r][2])) { V.pos[v] = V.pos[r].slice(); V.raw[v] = V.raw[r].slice(); snapped++; }
  }
  report.crack_vertices_snapped = snapped;
  let ymin = Infinity, ymax = -Infinity;
  for (const p of V.pos) { ymin = Math.min(ymin, p[1]); ymax = Math.max(ymax, p[1]); }
  const eps = 5e-5 * (ymax - ymin); // a vertex this close to a plane counts as on it (0.09 mm on a 1.7 m body): no sliver triangles, boundary edges stay classifiable

  // what the source mesh already has open (hair cards, eye sockets, slits), for the report
  const srcPos = new Float64Array(verticesIn * 3), srcIdx = new Uint32Array(tris.length * 3);
  for (let v = 0; v < verticesIn; v++) srcPos.set(V.pos[v], v * 3);
  tris.forEach((t, i) => srcIdx.set([t[0], t[1], t[2]], i * 3));
  const srcRep = weldReport([{ positions: srcPos, indices: srcIdx }], 1e-5);

  // the crotch apex: where the two legs' inner surfaces reach the midline
  let apex = null;
  if (opts.crotchPlanes !== false) {
    // scan down from the hip joint: the crotch is the first height where the left leg's innermost vertex (bones say which vertices are left-leg)
    // and the right leg's reach the midline
    const xm = (J.LeftUpLeg[0] + J.RightUpLeg[0]) / 2, halfGap = Math.abs(J.LeftUpLeg[0] - J.RightUpLeg[0]) / 2;
    const yTop = Math.max(J.LeftUpLeg[1], J.RightUpLeg[1]), thigh = vlen(sub(J.LeftUpLeg, J.LeftLeg));
    const legs = [];
    for (let v = 0; v < verticesIn; v++) {
      let l = 0, r = 0, all = 0;
      for (const [j, w] of V.skin[v]) { all += w; if (owner[j] === "leg_left") l += w; else if (owner[j] === "leg_right") r += w; }
      if (all > 0 && (l / all >= 0.5 || r / all >= 0.5)) legs.push({ p: V.pos[v], left: l >= r });
    }
    for (let y = yTop; y >= yTop - 0.6 * thigh && !apex; y -= 0.005) {
      let lMin = Infinity, rMax = -Infinity, zs = 0, zn = 0;
      for (const { p, left } of legs) {
        if (Math.abs(p[1] - y) > 0.01) continue;
        if (left) { if (p[0] < lMin) lMin = p[0]; } else if (p[0] > rMax) rMax = p[0];
      }
      if (lMin <= xm + 0.2 * halfGap && rMax >= xm - 0.2 * halfGap) {
        for (const { p } of legs) if (Math.abs(p[1] - y) <= 0.01 && Math.abs(p[0] - xm) <= 0.3 * halfGap) { zs += p[2]; zn++; }
        apex = [xm, y - 0.002, zn ? zs / zn : (J.LeftUpLeg[2] + J.RightUpLeg[2]) / 2];
      }
    }
    if (apex) report.crotch_apex = apex.map(r6);
    else report.notes.push("no crotch apex found: hip planes are the plain thigh-normal planes");
  }
  const fns = buildPlanes(J, apex);

  // ---- split every triangle at the planes (decision tree of half-space clips); split vertices are shared through a cache
  const edgeCache = new Map();
  const dOf = (fn, v) => { const d = fn.d(V.pos[v]); return Math.abs(d) <= eps ? 0 : d; };
  const splitVertex = (a, b, fn) => {
    let lo = a, hi = b;
    // canonical order by position (ids break ties), so UV-seam duplicates of one edge produce bit-identical split points
    const eq = V.pos[a][0] === V.pos[b][0] && V.pos[a][1] === V.pos[b][1] && V.pos[a][2] === V.pos[b][2];
    if (eq ? b < a : posLess(V.pos[b], V.pos[a])) { lo = b; hi = a; }
    const key = lo + "_" + hi + "_" + fn.id;
    if (edgeCache.has(key)) return edgeCache.get(key);
    const dl = fn.d(V.pos[lo]), dh = fn.d(V.pos[hi]);
    const t = dl / (dl - dh);
    const id = V.pos.length;
    const p = lerp3(V.pos[lo], V.pos[hi], t);
    V.pos.push(p);
    V.raw.push(lerp3(V.raw[lo], V.raw[hi], t));
    for (const s of semantics) {
      const A = V.attr[s][lo], B = V.attr[s][hi];
      let o = A.map((x, k) => x + (B[k] - x) * t);
      if (s === "NORMAL") o = norm(o);
      else if (s === "TANGENT") { const u = norm(o.slice(0, 3)); o = [u[0], u[1], u[2], A[3]]; }
      V.attr[s].push(o);
    }
    const m = new Map();
    for (const [j, w] of V.skin[lo]) m.set(j, (m.get(j) || 0) + w * (1 - t));
    for (const [j, w] of V.skin[hi]) m.set(j, (m.get(j) || 0) + w * t);
    V.skin.push([...m.entries()].sort((x, y) => x[0] - y[0]));
    edgeCache.set(key, id);
    return id;
  };
  const splitPoly = (poly, fn) => {
    const d = poly.map((v) => dOf(fn, v));
    const hasPos = d.some((x) => x > 0), hasNeg = d.some((x) => x < 0);
    if (!hasNeg) return hasPos ? [poly, null] : [null, poly]; // all zero: coplanar with the cut, goes to the negative side
    if (!hasPos) return [null, poly];
    const pos = [], neg = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], da = d[i], db = d[(i + 1) % poly.length];
      if (da >= 0) pos.push(a);
      if (da <= 0) neg.push(a);
      if ((da > 0 && db < 0) || (da < 0 && db > 0)) { const m = splitVertex(a, b, fn); pos.push(m); neg.push(m); }
    }
    return [pos.length >= 3 ? pos : null, neg.length >= 3 ? neg : null];
  };
  // the arrangement: every triangle is cut at every plane it crosses (the hip bisector only inside the double hip half-space), each fragment
  // carries the sign bits of its cell
  const BIT = { neck: 1, shoulder_left: 2, shoulder_right: 4, hip_left: 8, hip_right: 16, waist: 32, hip_split: 64 };
  const sequence = [fns.neck, fns.shoulder_left, fns.shoulder_right, fns.hip_left, fns.hip_right, fns.waist];
  const homeOf = (bits) => bits & 1 ? "head" : bits & 2 ? "arm_left" : bits & 4 ? "arm_right" : (bits & 24) === 24 ? (bits & 64 ? "leg_left" : "leg_right") : bits & 8 ? "leg_left" : bits & 16 ? "leg_right" : bits & 32 ? "upper_torso" : "root";
  const feasible = (r, b) => r === "head" ? !!(b & 1) : r === "upper_torso" ? !(b & 1) && !!(b & 32) && !(b & 2) && !(b & 4) : r === "root" ? !(b & 56) :
    r === "arm_left" ? !!(b & 2) : r === "arm_right" ? !!(b & 4) : r === "leg_left" ? !!(b & 8) && (!(b & 16) || !!(b & 64)) : !!(b & 16) && (!(b & 8) || !(b & 64));
  const cellTris = []; // [a, b, c, prim, cell bits]
  let trianglesSplit = 0;
  // Hair (Physics Dev ruling, docs/CUT-CONTRACT.md): hair-card and eyelash materials belong to the head, so a severed head carries its hair whole.
  // Those triangles are not cut at any plane and go to piece_head, re-bound rigidly to the Head bone (manifest `plane_exempt`).
  const isHairMaterial = (name) => (Array.isArray(opts.hairMaterials) ? opts.hairMaterials.includes(name) : /hair|lash|brow/i.test(name || ""));
  const hairPrim = srcPrims.map((p) => !!p.material && isHairMaterial(p.material.getName()));
  const hairTris = [], hairVerts = new Set();
  for (const [a, b, c, pi] of tris) {
    if (hairPrim[pi]) { hairTris.push([a, b, c, pi]); hairVerts.add(a); hairVerts.add(b); hairVerts.add(c); continue; }
    let polys = [{ v: [a, b, c], bits: 0 }];
    for (const fn of sequence) {
      const nx = [];
      for (const P of polys) { const [p, n] = splitPoly(P.v, fn); if (p) nx.push({ v: p, bits: P.bits | BIT[fn.id] }); if (n) nx.push({ v: n, bits: P.bits }); }
      polys = nx;
    }
    polys = polys.flatMap((P) => {
      if ((P.bits & 24) !== 24) return [P];
      const [p, n] = splitPoly(P.v, fns.hip_split), o = [];
      if (p) o.push({ v: p, bits: P.bits | 64 }); if (n) o.push({ v: n, bits: P.bits });
      return o;
    });
    if (polys.length > 1 || polys[0].v.some((v) => v >= verticesIn)) trianglesSplit++;
    for (const P of polys) for (let k = 1; k + 1 < P.v.length; k++) cellTris.push([P.v[0], P.v[k], P.v[k + 1], pi, P.bits]);
  }
  if (opts.debug) {
    const seen = new Set();
    for (const t of cellTris) { seen.add(t[0]); seen.add(t[1]); seen.add(t[2]); }
    const lost = new Map();
    for (const t of tris) for (let k = 0; k < 3; k++) if (!seen.has(t[k]) && !hairVerts.has(t[k])) lost.set(t[k], t[3]);
    report.lostAfterSplit = { count: lost.size, sample: [...lost.entries()].slice(0, 5).map(([v, p]) => [v, p, V.pos[v].map(r6)]) };
  }
  // fragments = connected pieces (welded positions) of one cell. A fragment goes to the region its cell names, unless its bones say otherwise:
  // when the home region owns under 20 percent of the fragment's skin weight, the region owning most of it takes the fragment (a foot sticking
  // through the shoulder plane's far side, hair hanging below the neck plane, a tail across the hip bisector). Gear follows its bone.
  // welded vertex ids (the pre-weld above made seam duplicates bit-identical)
  const wcl = weldCluster(V.pos, 1e-5), weldId = (v) => wcl[v];
  const uf = new Map();
  const find = (x) => { let r = x; while (uf.get(r) !== r) r = uf.get(r); while (x !== r) { const nx = uf.get(x); uf.set(x, r); x = nx; } return r; };
  const unite = (x, y) => { const rx = find(x), ry = find(y); if (rx !== ry) uf.set(Math.max(rx, ry), Math.min(rx, ry)); };
  const keyOf = (t, v) => t[4] * 4194304 + weldId(v);
  for (const t of cellTris) { const ks = [t[0], t[1], t[2]].map((v) => keyOf(t, v)); for (const k of ks) if (!uf.has(k)) uf.set(k, k); unite(ks[0], ks[1]); unite(ks[0], ks[2]); }
  const fragVerts = new Map(); // fragment root -> Set of vertex ids
  const triFrag = cellTris.map((t) => find(keyOf(t, t[0])));
  cellTris.forEach((t, i) => { const f = triFrag[i]; if (!fragVerts.has(f)) fragVerts.set(f, new Set()); const s = fragVerts.get(f); s.add(t[0]); s.add(t[1]); s.add(t[2]); });
  const regionIdx = Object.fromEntries(REGIONS.map((r, i) => [r.id, i]));
  const fragRegion = new Map();
  const fragStats = { fragments: fragVerts.size, reassigned: 0, reassigned_triangles: 0 };
  const cellOfFrag = new Map();
  cellTris.forEach((t, i) => cellOfFrag.set(triFrag[i], t[4]));
  for (const [f, set] of [...fragVerts.entries()].sort((a, b) => a[0] - b[0])) {
    const home = homeOf(cellOfFrag.get(f));
    const score = new Array(REGIONS.length).fill(0);
    for (const v of set) for (const [j, w] of V.skin[v]) score[regionIdx[owner[j]]] += w;
    const total = score.reduce((s, x) => s + x, 0);
    let region = home;
    if (total > 0 && score[regionIdx[home]] / total < 0.2) {
      // only a region the cell's planes allow can take it (a piece's vertices stay on its side of every plane that bounds it)
      let best = -1;
      for (let k = 0; k < score.length; k++) if (feasible(REGIONS[k].id, cellOfFrag.get(f)) && score[k] > 0 && (best < 0 || score[k] > score[best])) best = k;
      if (best >= 0) region = REGIONS[best].id;
    }
    if (region !== home) {
      fragStats.reassigned++;
      if (opts.debug) {
        const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
        for (const v of set) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], V.pos[v][k]); hi[k] = Math.max(hi[k], V.pos[v][k]); }
        (report.reassigned ||= []).push({ home, region, vertices: set.size, bbox: [lo.map(r6), hi.map(r6)], shares: Object.fromEntries(REGIONS.map((r, k) => [r.id, r6(score[k] / total)])) });
      }
    }
    fragRegion.set(f, region);
  }
  const pieceTris = Object.fromEntries(REGIONS.map((r) => [r.id, []]));
  cellTris.forEach((t, i) => {
    const region = fragRegion.get(triFrag[i]);
    if (region !== homeOf(t[4])) fragStats.reassigned_triangles++;
    pieceTris[region].push([t[0], t[1], t[2], t[3]]);
  });

  // ---- bind weights to the bones of the piece's own side
  let weightsRebound = 0, weightsTruncated = 0, orphan = 0;
  const bindCache = new Map();
  const bindWeights = (v, region) => {
    // hair travels with the head as one rigid piece: Head bone only (renormalised weights of a single bone)
    if (region === "head" && hairVerts.has(v)) return { j: [roleJoint.Head, 0, 0, 0], w: [1, 0, 0, 0] };
    const key = v * 8 + REGIONS.findIndex((r) => r.id === region);
    if (bindCache.has(key)) return bindCache.get(key);
    const acc = new Map();
    for (const [j, w] of V.skin[v]) {
      if (!(w > 0)) continue;
      let t = j;
      if (owner[j] !== region) {
        t = nearOwned(j, region); weightsRebound++;
        if (opts.debug) { const k = `${region}: ${joints[j].getName().replace("mixamorig:", "")} -> ${joints[t].getName().replace("mixamorig:", "")}`; (report.rebinds ||= {})[k] = (report.rebinds[k] || 0) + 1; }
      }
      acc.set(t, (acc.get(t) || 0) + w);
    }
    let list = [...acc.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    if (list.length > 4) { weightsTruncated++; list = list.slice(0, 4); }
    if (!list.length) list = [[roleJoint[REGION_ANCHOR[region]], 1]];
    const sum = list.reduce((s, e) => s + e[1], 0);
    const jj = [0, 0, 0, 0], ww = [0, 0, 0, 0];
    list.forEach((e, k) => { jj[k] = e[0]; ww[k] = e[1] / sum; });
    for (let k = 0; k < 4; k++) if (ww[k] > 0 && owner[jj[k]] !== region) orphan++;
    const r = { j: jj, w: ww };
    bindCache.set(key, r);
    return r;
  };

  // ---- emit each piece: one primitive per source material
  const outPieces = {}; // region -> { prims: [{ pi, gv: [vertex ids], indices }], positionsAll }
  for (const R of REGIONS) {
    const byPrim = new Map();
    for (const [a, b, c, pi] of R.id === "head" ? pieceTris.head.concat(hairTris) : pieceTris[R.id]) {
      if (!byPrim.has(pi)) byPrim.set(pi, { pi, gv: [], map: new Map(), indices: [] });
      const P = byPrim.get(pi);
      for (const v of [a, b, c]) {
        if (!P.map.has(v)) { P.map.set(v, P.gv.length); P.gv.push(v); }
        P.indices.push(P.map.get(v));
      }
    }
    outPieces[R.id] = { prims: [...byPrim.values()].sort((x, y) => x.pi - y.pi) };
    if (!outPieces[R.id].prims.length) throw new Error("region " + R.id + " received no triangles: the cut planes do not fit this body");
  }

  // ---- caps: boundary edges of each piece that lie on a cut plane, chained into loops, triangulated (outer rings + holes)
  const capStats = { loops: 0, open_chains: 0, holes: 0, forced_ears: 0, bridge_fallbacks: 0, fallback_loops: 0, inward_triangles: 0, nonplanar_loops: 0, gaps_bridged: 0 };
  const capOf = new Map(CAPS.map((c) => [c.region + ":" + c.plane, c]));
  const capsOut = {}; // cap id -> { verts: [{v, region}], uv, tris }
  const planeOrder = ["neck", "shoulder_left", "shoulder_right", "hip_left", "hip_right", "waist", "hip_split"];
  for (const R of REGIONS) {
    const edges = new Map(); // directed welded edge -> { count, a, b }
    const W = weldId;
    const rep = new Map(); // welded id -> lowest vertex id
    for (const [a, b, c] of pieceTris[R.id]) for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const wu = W(u), wv = W(v);
      if (!rep.has(wu) || rep.get(wu) > u) rep.set(wu, u);
      if (!rep.has(wv) || rep.get(wv) > v) rep.set(wv, v);
      if (wu === wv) continue;
      const k = wu * 4194304 + wv;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
    const boundary = [];
    for (const [k, cnt] of edges) {
      const u = Math.floor(k / 4194304), v = k % 4194304;
      const rev = edges.get(v * 4194304 + u) || 0;
      if (cnt > rev) boundary.push([u, v]);
    }
    // centroid for the outward direction
    const used = new Set();
    for (const [a, b, c] of pieceTris[R.id]) { used.add(a); used.add(b); used.add(c); }
    const cen = [0, 0, 0];
    for (const v of used) for (let k = 0; k < 3; k++) cen[k] += V.pos[v][k] / used.size;
    // classify the boundary edges that lie on a cut plane; the others are native open edges of the source mesh (reported, not capped)
    const planeOf = new Map(); // directed welded edge -> plane id
    const planesOn = new Map(); // directed welded edge -> every cap plane of this region the edge lies on
    const capPlane = (pl) => (pl === "hip_split" ? (R.id === "leg_left" ? "hip_left" : R.id === "leg_right" ? "hip_right" : pl) : pl);
    const out = new Map();
    const edgeList = [];
    for (const [u, v] of boundary) {
      const pu = V.pos[rep.get(u)], pv = V.pos[rep.get(v)];
      const on = planeOrder.filter((id) => Math.abs(fns[id].d(pu)) <= 2 * eps && Math.abs(fns[id].d(pv)) <= 2 * eps);
      if (!on.length) continue;
      // an edge on the meeting line of two planes goes to the plane this region has a cap for
      const plane = on.find((id) => capOf.has(R.id + ":" + id)) || on.find((id) => id === "hip_split") || on[0];
      planeOf.set(u * 4194304 + v, plane);
      const capped = [...new Set(on.map(capPlane))].filter((p) => capOf.has(R.id + ":" + p));
      planesOn.set(u * 4194304 + v, capped.length ? capped : [capPlane(plane)]);
      edgeList.push([u, v]);
      if (!out.has(u)) out.set(u, []);
      out.get(u).push(v);
    }
    // A hairline hole in the source mesh that the plane crosses leaves a dead end and a start a fraction of a millimetre apart: bridge such gaps
    // (under 1 mm) with a straight edge so the loop closes. The hole itself stays open and is counted as a native open edge.
    {
      const bal = new Map(), inPlane = new Map();
      for (const [u, v] of edgeList) { bal.set(u, (bal.get(u) || 0) + 1); bal.set(v, (bal.get(v) || 0) - 1); inPlane.set(v, planeOf.get(u * 4194304 + v)); }
      const sinks = [...bal.entries()].filter(([, b]) => b < 0).map(([w]) => w).sort((a, b) => a - b);
      const sources = [...bal.entries()].filter(([, b]) => b > 0).map(([w]) => w).sort((a, b) => a - b);
      for (const s of sinks) {
        let best = -1, bd = 1e-3;
        for (const t of sources) { if (bal.get(t) <= 0) continue; const d = vlen(sub(V.pos[rep.get(s)], V.pos[rep.get(t)])); if (d < bd) { bd = d; best = t; } }
        if (best < 0) continue;
        planeOf.set(s * 4194304 + best, inPlane.get(s));
        edgeList.push([s, best]);
        if (!out.has(s)) out.set(s, []);
        out.get(s).push(best);
        bal.set(s, bal.get(s) + 1); bal.set(best, bal.get(best) - 1);
        capStats.gaps_bridged++;
      }
    }
    // chain all of them into loops
    const loops = [];
    for (const [u0, v0] of edgeList) {
      const list = out.get(u0);
      const ix = list.indexOf(v0);
      if (ix < 0) continue; // used already
      list.splice(ix, 1);
      const loop = [u0];
      let cur = v0, closed = false;
      for (let guard = 0; guard < 1e7; guard++) {
        if (cur === u0) { closed = true; break; }
        loop.push(cur);
        const nxt = out.get(cur);
        if (!nxt || !nxt.length) break;
        cur = nxt.shift();
      }
      if (closed && loop.length >= 3) loops.push(loop); else capStats.open_chains++;
    }
    const describe = (loop, closed) => {
      const len = {};
      const n = loop.length;
      for (let k = 0; k < (closed ? n : n - 1); k++) {
        const u = loop[k], v = loop[(k + 1) % n];
        const pl = capPlane(planeOf.get(u * 4194304 + v));
        len[pl] = (len[pl] || 0) + vlen(sub(V.pos[rep.get(u)], V.pos[rep.get(v)]));
      }
      const dom = Object.entries(len).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
      return { loop, len, dom };
    };
    // A loop that runs along two cap planes (the root's lower edge where the two hip planes meet) is cut at the two points where it changes plane
    // and each half is closed by the straight chord, so every cap is flat: a Lambda triangulated as one polygon would fold.
    const loopInfo = loops.flatMap((loop) => {
      const n = loop.length;
      const on = loop.map((u, k) => planesOn.get(u * 4194304 + loop[(k + 1) % n]) || [capPlane(planeOf.get(u * 4194304 + loop[(k + 1) % n]))]);
      // edges on the meeting line of two planes keep the plane of the edge before them; start from an edge on one plane only
      let st = on.findIndex((l) => l.length === 1);
      if (st < 0) return [describe(loop, true)];
      const seq = new Array(n);
      let cur = on[st][0];
      for (let j = 0; j < n; j++) { const k = (st + j) % n; if (!on[k].includes(cur)) cur = on[k][0]; seq[k] = cur; }
      const s = seq.findIndex((p, k) => p !== seq[(k + n - 1) % n]);
      if (s < 0) return [describe(loop, true)];
      const rot = loop.slice(s).concat(loop.slice(0, s)), rseq = seq.slice(s).concat(seq.slice(0, s));
      const runs = [];
      rseq.forEach((p, k) => { if (!runs.length || runs[runs.length - 1].plane !== p) runs.push({ plane: p, from: k, to: k }); else runs[runs.length - 1].to = k; });
      if (opts.debug) (report.runs ||= []).push({ region: R.id, n, runs: runs.map((r) => `${r.plane}:${r.to - r.from + 1}`) });
      if (runs.length === 2 && runs.every((r) => capOf.has(R.id + ":" + r.plane))) {
        return runs.map((r) => { const sub = []; for (let k = r.from; k <= r.to + 1; k++) sub.push(rot[k % n]); const d = describe(sub, false); d.dom = r.plane; return d; });
      }
      return [describe(loop, true)];
    });
    if (opts.debug) {
      const deg = new Map();
      for (const [u, v] of edgeList) { deg.set(u, (deg.get(u) || 0) + 1); deg.set(v, (deg.get(v) || 0) - 1); }
      const bad = [...deg.entries()].filter(([, d]) => d !== 0).map(([w, d]) => [d, V.pos[rep.get(w)].map(r6)]);
      const near = [];
      for (const [u, v] of boundary) {
        if (planeOf.has(u * 4194304 + v)) continue;
        const pu = V.pos[rep.get(u)], pv = V.pos[rep.get(v)];
        if (bad.some(([, p]) => vlen(sub(pu, p)) < 5e-4 || vlen(sub(pv, p)) < 5e-4)) near.push([pu.map(r6), pv.map(r6), planeOrder.map((id) => +fns[id].d(pu).toExponential(2)), planeOrder.map((id) => +fns[id].d(pv).toExponential(2))]);
      }
      (report.groups ||= []).push({ near, region: R.id, edges: edgeList.length, loops: loops.length, loops_by_plane: loopInfo.map((l) => l.dom + ":" + l.loop.length), unbalanced: bad.length, unbalancedSample: bad.slice(0, 4) });
    }
    const byDom = new Map();
    for (const li of loopInfo) { if (!byDom.has(li.dom)) byDom.set(li.dom, []); byDom.get(li.dom).push(li); }
    for (const [dom, infos] of byDom) {
      const fn = fns[dom];
      const nOut = dot(sub(cen, fn.point), fn.n) > 0 ? fn.n.map((x) => -x) : fn.n.slice();
      const u = norm(Math.abs(nOut[2]) < 0.9 ? cross(nOut, [0, 0, 1]) : cross(nOut, [1, 0, 0]));
      const vv = cross(nOut, u);
      const all = [];
      const rings = infos.map(({ loop }) => {
        const pts = loop.map((w) => { const p = V.pos[rep.get(w)]; return { x: dot(p, u), y: dot(p, vv), i: all.push(rep.get(w)) - 1 }; });
        let a = 0;
        for (let k = 0; k < pts.length; k++) { const p = pts[k], q = pts[(k + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
        let dev = 0; // how far the loop strays from the plane it is capped against
        for (const w of loop) dev = Math.max(dev, Math.abs(fn.d(V.pos[rep.get(w)])));
        if (dev > 10 * eps) capStats.nonplanar_loops++;
        return { pts, area: a / 2 };
      });
      // traversal of an outer ring is clockwise seen from the outside (area < 0); holes are counter-clockwise (area > 0)
      const outers = rings.filter((r) => r.area <= 0), holes = rings.filter((r) => r.area > 0);
      const owners = outers.map(() => []);
      const inPoly = (pt, poly) => { let c = false; for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) { const p = poly[a], q = poly[b]; if ((p.y > pt.y) !== (q.y > pt.y) && pt.x < (q.x - p.x) * (pt.y - p.y) / (q.y - p.y) + p.x) c = !c; } return c; };
      const orphanHoles = [];
      for (const h of holes) {
        let best = -1;
        outers.forEach((o, k) => { if (inPoly(h.pts[0], o.pts) && (best < 0 || Math.abs(o.area) < Math.abs(outers[best].area))) best = k; });
        if (best < 0) orphanHoles.push(h); else owners[best].push(h);
      }
      capStats.loops += infos.length;
      capStats.holes += holes.length - orphanHoles.length;
      const stats = { forced: 0, bridgeFallback: 0 };
      const capTris = [];
      outers.forEach((o, k) => capTris.push(...triangulateLoops(o.pts, owners[k].map((h) => h.pts), stats)));
      for (const h of orphanHoles) { // a hole with no ring around it: fill it as an outer ring of its own (flagged)
        capStats.fallback_loops++;
        capTris.push(...triangulateLoops(h.pts, [], stats));
      }
      capStats.forced_ears += stats.forced; capStats.bridge_fallbacks += stats.bridgeFallback;
      if (opts.debug && (stats.forced || stats.bridgeFallback)) (report.forced ||= []).push({ region: R.id, plane: dom, forced: stats.forced, rings: rings.map((r) => [r.pts.length, +r.area.toFixed(6)]), holes: holes.length, orphanHoles: orphanHoles.length });
      // the caps this group may feed: planes it lies on that this region has a cap for (a loop along two planes, the Lambda of the root's lower edge,
      // is triangulated once and shared out by the nearest plane)
      const planesHere = [...new Set(infos.flatMap((i) => Object.keys(i.len)).map((p) => (p === "hip_split" ? dom : p)))].filter((p) => capOf.has(R.id + ":" + p)).sort((a, b) => planeOrder.indexOf(a) - planeOrder.indexOf(b));
      let targets = planesHere.map((p) => capOf.get(R.id + ":" + p));
      if (!targets.length) { targets = [CAPS.find((c) => c.region === R.id)]; capStats.fallback_loops++; }
      let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
      for (const v of all) { umin = Math.min(umin, dot(V.pos[v], u)); umax = Math.max(umax, dot(V.pos[v], u)); vmin = Math.min(vmin, dot(V.pos[v], vv)); vmax = Math.max(vmax, dot(V.pos[v], vv)); }
      const S = Math.max(umax - umin, vmax - vmin) || 1;
      const locals = new Map();
      for (let t = 0; t < capTris.length; t += 3) {
        const ia = capTris[t], ib = capTris[t + 1], ic = capTris[t + 2];
        const a = V.pos[all[ia]], b = V.pos[all[ib]], c = V.pos[all[ic]];
        // Ear clipping winds every triangle of a simple loop to the outward normal. A loop that crosses itself (the plane cuts a folded or overlapping
        // layer of the source mesh) has regions of negative winding that no consistent triangulation can cover with outward triangles: those triangles
        // (folded slivers) are kept, so the cap stays closed and oriented with its piece, but each gets its own vertices carrying the normal of its
        // winding, so that every triangle's winding agrees with its stored normals (CUT-VALIDATE `caps`).
        const folded = dot(cross(sub(b, a), sub(c, a)), nOut) < -1e-14;
        if (folded) capStats.inward_triangles++;
        let cap = targets[0];
        if (targets.length > 1) {
          const cen3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
          let bd = Infinity;
          for (const tc of targets) { const d = Math.abs(fns[tc.plane].d(cen3)); if (d < bd - 1e-12) { bd = d; cap = tc; } }
        }
        const rec = capsOut[cap.id] || (capsOut[cap.id] = { cap, verts: [], uv: [], nrm: [], tris: [] });
        if (!locals.has(cap.id)) locals.set(cap.id, new Map());
        const lm = locals.get(cap.id);
        for (const gi of [ia, ib, ic]) {
          const v = all[gi], uv = [(dot(V.pos[v], u) - umin) / S, (dot(V.pos[v], vv) - vmin) / S];
          if (folded) { rec.tris.push(rec.verts.length); rec.verts.push(v); rec.uv.push(uv); rec.nrm.push(nOut.map((x) => -x)); continue; }
          if (!lm.has(gi)) { lm.set(gi, rec.verts.length); rec.verts.push(v); rec.uv.push(uv); rec.nrm.push(nOut); }
          rec.tris.push(lm.get(gi));
        }
      }
    }
  }

  // ---- build the output document
  const buffer = root.listBuffers()[0] || doc.createBuffer();
  const oldAcc = new Set();
  for (const m of oldMeshes) for (const p of m.listPrimitives()) { for (const s of p.listSemantics()) oldAcc.add(p.getAttribute(s)); if (p.getIndices()) oldAcc.add(p.getIndices()); }
  const parent = oldNodes[0].getParentNode();
  const scene = root.listScenes()[0];
  for (const n of oldNodes) n.dispose();
  for (const m of oldMeshes) { for (const p of m.listPrimitives()) p.dispose(); m.dispose(); }
  for (const s of oldSkins) s.dispose();
  for (const a of oldAcc) if (a.listParents().every((p) => p.propertyType === "Root")) a.dispose();
  for (const ext of root.listExtensionsUsed()) if (ext.extensionName === "EXT_meshopt_compression" || ext.extensionName === "KHR_mesh_quantization") ext.dispose();

  const mkAcc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const addNode = (name, mesh) => {
    const n = doc.createNode(name).setMesh(mesh).setSkin(skin0);
    if (parent) parent.addChild(n); else scene.addChild(n);
    return n;
  };
  const piecePos = {}, pieceIdx = {}, outStats = { pieces: {}, caps: {} };
  for (const R of REGIONS) {
    const mesh = doc.createMesh(R.mesh);
    const pp = [], ii = [];
    let vcount = 0, tcount = 0;
    for (const P of outPieces[R.id].prims) {
      const n = P.gv.length;
      const prim = doc.createPrimitive().setMaterial(srcPrims[P.pi].material);
      const pos = new Float32Array(n * 3), posW = new Float64Array(n * 3), jj = new Uint16Array(n * 4), ww = new Float32Array(n * 4);
      const att = Object.fromEntries(semantics.map((s) => [s, new Float32Array(n * V.attr[s][0].length)]));
      P.gv.forEach((v, k) => {
        pos.set(V.pos[v], k * 3); posW.set(V.pos[v], k * 3);
        const b = bindWeights(v, R.id);
        jj.set(b.j, k * 4); ww.set(b.w, k * 4);
        for (const s of semantics) {
          let val = V.attr[s][v];
          if (s === "NORMAL") val = normalToWorld(val); else if (s === "TANGENT") val = [...norm(tangentToWorld(val)), val[3]];
          att[s].set(val, k * val.length);
        }
      });
      prim.setAttribute("POSITION", mkAcc("VEC3", pos));
      for (const s of semantics) prim.setAttribute(s, mkAcc(["SCALAR", "VEC2", "VEC3", "VEC4"][V.attr[s][0].length - 1], att[s]));
      prim.setAttribute("JOINTS_0", mkAcc("VEC4", jj)).setAttribute("WEIGHTS_0", mkAcc("VEC4", ww));
      const idx = n < 65536 ? new Uint16Array(P.indices) : new Uint32Array(P.indices);
      prim.setIndices(mkAcc("SCALAR", idx));
      mesh.addPrimitive(prim);
      pp.push(posW); ii.push(idx);
      vcount += n; tcount += idx.length / 3;
    }
    addNode(R.mesh, mesh);
    piecePos[R.id] = pp; pieceIdx[R.id] = ii;
    outStats.pieces[R.id] = { vertices: vcount, triangles: tcount };
  }
  const flesh = doc.createMaterial(FLESH.name).setBaseColorFactor(FLESH.color).setRoughnessFactor(FLESH.roughness).setMetallicFactor(0);
  const capGeom = {};
  const capsMissing = [];
  for (const C of CAPS) {
    const rec = capsOut[C.id];
    if (!rec) { capsMissing.push(C.id); continue; }
    const n = rec.verts.length;
    const posW = new Float64Array(n * 3), pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2), jj = new Uint16Array(n * 4), ww = new Float32Array(n * 4);
    rec.verts.forEach((v, k) => {
      pos.set(V.pos[v], k * 3); posW.set(V.pos[v], k * 3); nor.set(rec.nrm[k], k * 3); uv.set(rec.uv[k], k * 2);
      const b = bindWeights(v, C.region);
      jj.set(b.j, k * 4); ww.set(b.w, k * 4);
    });
    const prim = doc.createPrimitive().setMaterial(flesh)
      .setAttribute("POSITION", mkAcc("VEC3", pos)).setAttribute("NORMAL", mkAcc("VEC3", nor)).setAttribute("TEXCOORD_0", mkAcc("VEC2", uv))
      .setAttribute("JOINTS_0", mkAcc("VEC4", jj)).setAttribute("WEIGHTS_0", mkAcc("VEC4", ww))
      .setIndices(mkAcc("SCALAR", n < 65536 ? new Uint16Array(rec.tris) : new Uint32Array(rec.tris)));
    addNode(C.id, doc.createMesh(C.id).addPrimitive(prim));
    capGeom[C.id] = { positions: posW, indices: rec.tris };
    outStats.caps[C.id] = { vertices: n, triangles: rec.tris.length / 3 };
  }
  if (ibm) { // inverse binds absorb Q^-1 (see above)
    const arr = new Float32Array(joints.length * 16);
    for (let i = 0; i < joints.length; i++) arr.set(mul4(ibm.getElement(i, new Array(16)), Qinv), i * 16);
    ibm.setArray(arr);
  }
  const glb = await io.writeBinary(doc);

  // ---- watertight check: every piece with the caps that belong to it
  const watertight = {};
  let allClosed = true, openTotal = 0, cutOpenTotal = 0, nativeTotal = 0, nonManifoldTotal = 0;
  const onAnyPlane = (p) => planeOrder.some((id) => Math.abs(fns[id].d(p)) <= 3 * eps);
  for (const R of REGIONS) {
    const parts = piecePos[R.id].map((p, k) => ({ positions: p, indices: pieceIdx[R.id][k] }));
    for (const C of CAPS) if (C.region === R.id && capGeom[C.id]) parts.push(capGeom[C.id]);
    const rep = weldReport(parts, 1e-5, true);
    // an open edge is "at a cut" when both its ends lie on a cut plane; the rest are open edges the source mesh already had (hair cards, eye sockets...)
    const atCut = rep.boundary_list.filter(([a, b]) => onAnyPlane(a) && onAnyPlane(b));
    watertight[R.id] = { boundary_edges: rep.boundary_edges, open_edges_at_cuts: atCut.length, open_edges_native: rep.boundary_edges - atCut.length, non_manifold_edges: rep.non_manifold_edges, degenerate_triangles: rep.degenerate, at_cuts: atCut.slice(0, 4).map((e) => ({ from: e[0].map(r6), planes: planeOrder.filter((id) => Math.abs(fns[id].d(e[0])) <= 3 * eps && Math.abs(fns[id].d(e[1])) <= 3 * eps) })) };
    if (!rep.watertight) allClosed = false;
    openTotal += rep.boundary_edges; cutOpenTotal += atCut.length; nativeTotal += rep.boundary_edges - atCut.length; nonManifoldTotal += rep.non_manifold_edges;
  }

  // ---- manifest
  const planes = {};
  for (const id of ["neck", "shoulder_left", "shoulder_right", "hip_left", "hip_right", "waist"]) {
    const f = fns[id];
    planes[id] = { point: sub(f.point, offset).map(r6), normal: f.n.map(r6), source: f.source };
  }
  // the internal hip bisector is not a cut: kept out of `planes` (readers match plane names loosely) and listed apart
  const internalPlanes = { hip_split: { point: sub(fns.hip_split.point, offset).map(r6), normal: fns.hip_split.n.map(r6), source: fns.hip_split.source } };
  let verticesOut = 0, capVerts = 0;
  for (const R of REGIONS) verticesOut += outStats.pieces[R.id].vertices;
  for (const k of Object.keys(outStats.caps)) capVerts += outStats.caps[k].vertices;
  const manifest = {
    schema: "cut-pieces/1",
    body: opts.body || row.id || "body",
    rig: opts.rig || "rig",
    source: opts.source || "body.glb",
    regions: REGIONS.map((r) => ({ id: r.id, mesh: r.mesh, detached_by: r.detached_by })),
    caps: CAPS.filter((c) => capGeom[c.id]).map((c) => ({ id: c.id, mesh: c.id, region: c.region, shown_when_cut: c.shown_when_cut })),
    planes,
    internal_planes: internalPlanes,
    plane_frame: { about: "plane points are in the measure row's coordinates (floor-lifted bind pose, metres); add bind_offset to get the GLB's bind-pose world space; vertex_to_world is the identity in the cut GLB (written in metres); source_vertex_to_world is the matrix the source GLB's stored vertex space needed", bind_offset: offset.map(r6), crotch_apex: apex ? sub(apex, offset).map(r6) : null, vertex_to_world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], source_vertex_to_world: Q.map((x) => Math.round(x * 1e9) / 1e9) },
    stats: {
      vertices_in: verticesIn,
      vertices_out: verticesOut,
      cap_vertices: capVerts,
      triangles_in: tris.length,
      triangles_out: REGIONS.reduce((s, r) => s + outStats.pieces[r.id].triangles, 0),
      triangles_split: trianglesSplit,
      split_vertices_created: V.pos.length - verticesIn,
      watertight: allClosed,
      watertight_at_cuts: cutOpenTotal === 0 && nonManifoldTotal === 0,
      open_edges: openTotal,
      open_edges_at_cuts: cutOpenTotal,
      open_edges_native: nativeTotal,
      source_open_edges: srcRep.boundary_edges,
      source_non_manifold_edges: srcRep.non_manifold_edges,
      non_manifold_edges: nonManifoldTotal,
      orphan_weights: orphan,
      hair_triangles: hairTris.length,
      hair_vertices: hairVerts.size,
      fragments: fragStats.fragments,
      fragments_reassigned_by_bones: fragStats.reassigned,
      triangles_reassigned_by_bones: fragStats.reassigned_triangles,
      weights_rebound: weightsRebound,
      weights_truncated_to_4: weightsTruncated,
      caps_missing: capsMissing,
      cap_loops: capStats.loops,
      cap_holes: capStats.holes,
      cap_open_chains: capStats.open_chains,
      cap_gaps_bridged: capStats.gaps_bridged,
      crack_vertices_snapped: report.crack_vertices_snapped,
      cap_fallback_loops: capStats.fallback_loops,
      cap_nonplanar_loops: capStats.nonplanar_loops,
      cap_forced_ears: capStats.forced_ears,
      cap_bridge_fallbacks: capStats.bridge_fallbacks,
      cap_inward_triangles: capStats.inward_triangles,
      pieces: outStats.pieces,
      caps: outStats.caps,
      watertight_by_region: watertight,
    },
  };
  const hairNames = [...new Set(hairTris.map((t) => srcPrims[t[3]].material.getName()))].sort();
  if (hairNames.length) {
    manifest.plane_exempt = { piece_head: hairNames };
    manifest.plane_exempt_reason = "hair, hair cards and eyelashes belong to the head: a severed head carries its hair whole, so these materials are not cut at any plane (they reach below the neck plane) and are bound rigidly to the Head bone; cut-validate skips the planes check for them only";
  }
  return { glb, manifest, report };
}

// ---------------------------------------------------------------- CLI
async function main() {
  const args = process.argv.slice(2);
  const bi = args.indexOf("--body");
  let bodyName = null;
  if (bi >= 0) { bodyName = args[bi + 1]; args.splice(bi, 2); }
  const [glbPath, rowPath, mapPath, outDir] = args;
  if (!outDir) { console.error("usage: node tools/cut-units.mjs <body.glb> <body.measure.json> <rig-map.json> <out-dir> [--body name]"); process.exit(2); }
  const row = JSON.parse(readFileSync(rowPath, "utf8"));
  const rigMap = JSON.parse(readFileSync(mapPath, "utf8"));
  const name = bodyName || row.id || basename(glbPath, ".glb");
  const debug = args.includes("--debug") || process.env.CUT_DEBUG === "1";
  const { glb, manifest, report } = await cutGlb(readFileSync(glbPath), row, rigMap, { body: name, rig: basename(mapPath, ".json"), source: basename(glbPath), debug });
  if (debug) console.log(JSON.stringify(report, null, 1));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, name + ".cut.glb"), glb);
  if (args.includes("--meshopt")) { // optional shipping copy: meshopt + quantised, NOT the contract file
    const { NodeIO } = await import("@gltf-transform/core");
    const { ALL_EXTENSIONS, EXTMeshoptCompression } = await import("@gltf-transform/extensions");
    const { MeshoptDecoder, MeshoptEncoder } = await import("meshoptimizer");
    await MeshoptDecoder.ready; await MeshoptEncoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });
    const d = await io.readBinary(glb);
    d.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
    writeFileSync(join(outDir, name + ".cut.min.glb"), await io.writeBinary(d));
  }
  const so = args.indexOf("--source-out");
  if (so >= 0) writeFileSync(args[so + 1], await decompressGlb(readFileSync(glbPath)));
  writeFileSync(join(outDir, name + ".cut.manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
  const s = manifest.stats;
  console.log(`${name}: vertices ${s.vertices_in} -> ${s.vertices_out} (+${s.cap_vertices} cap), triangles ${s.triangles_in} -> ${s.triangles_out}, split ${s.triangles_split}, watertight ${s.watertight} (open edges ${s.open_edges}: ${s.open_edges_at_cuts} at cuts, ${s.open_edges_native} native to the source; ${s.non_manifold_edges} non-manifold), orphan weights ${s.orphan_weights}, rebound ${s.weights_rebound}`);
  for (const [r, w] of Object.entries(s.watertight_by_region)) if (w.open_edges_at_cuts || w.non_manifold_edges) console.log(`  OPEN ${r}: ${w.open_edges_at_cuts} at cuts, ${w.non_manifold_edges} non-manifold, first at ${JSON.stringify(w.at_cuts.slice(0, 3))}`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e.stack || e); process.exit(1); });
