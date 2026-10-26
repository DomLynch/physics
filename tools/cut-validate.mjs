// Independent validator for cut pieces (docs/CUT-CONTRACT.md, docs/CUT-VALIDATE.md). Reads the GLB by hand (JSON chunk + BIN chunk, like tools/glb-measure.mjs); no dependency
// on the tool that made it.
//   node tools/cut-validate.mjs <body.cut.glb> <body.cut.manifest.json> [--source <body.glb>] [--json] [--hash] [--plane-offset x,y,z]
//   node tools/cut-validate.mjs <file.glb> --hash        (just the sha256 of the bytes, for determinism runs)
//   node tools/cut-validate.mjs <plain.glb> --self       (the open, over-used and flipped edges a surface already has: run on the plain source)
// With --source, watertight and orientation separate defects native to the source from defects the cut introduced (docs/CUT-VALIDATE.md).
// Exit code 1 on any failed check. Checks: structure, watertight, orientation, weights, bone_side, caps, conservation (needs --source), planes.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256HexBytes } from "../src/sha256.mjs";

export const WELD = 1e-5, PLANE_TOL = 1e-4, WEIGHT_TOL = 1e-3, AREA_TOL = 0.01, BBOX_TOL = 1e-4;
const SCHEMA = "cut-pieces/1";
const REGIONS = ["root", "upper_torso", "head", "arm_left", "arm_right", "leg_left", "leg_right"];
const REGION_UNIT = { root: null, upper_torso: "torso_waist", head: "head", arm_left: "arm_left", arm_right: "arm_right", leg_left: "leg_left", leg_right: "leg_right" };
// cap id -> [region it belongs to, unit that shows it]
const CAPS = {
  cap_neck_head: ["head", "head"], cap_neck_torso: ["upper_torso", "head"],
  cap_shoulder_left_arm: ["arm_left", "arm_left"], cap_shoulder_left_torso: ["upper_torso", "arm_left"],
  cap_shoulder_right_arm: ["arm_right", "arm_right"], cap_shoulder_right_torso: ["upper_torso", "arm_right"],
  cap_hip_left_leg: ["leg_left", "leg_left"], cap_hip_left_root: ["root", "leg_left"],
  cap_hip_right_leg: ["leg_right", "leg_right"], cap_hip_right_root: ["root", "leg_right"],
  cap_waist_torso: ["upper_torso", "torso_waist"], cap_waist_root: ["root", "torso_waist"],
};
// Which side of each plane a region lives on. Plane normals point toward the detaching piece (neck: toward the head, shoulder: out along the arm,
// hip: down the leg, waist: up the torso), so "+" is the piece that leaves and "-" the one that stays.
const CONSTRAINTS = {
  head: [["neck", "+"]],
  upper_torso: [["neck", "-"], ["waist", "+"], ["shoulder_left", "-"], ["shoulder_right", "-"]],
  root: [["waist", "-"], ["hip_left", "-"], ["hip_right", "-"]],
  arm_left: [["shoulder_left", "+"]], arm_right: [["shoulder_right", "+"]],
  leg_left: [["hip_left", "+"]], leg_right: [["hip_right", "+"]],
};
const PLANES = ["neck", "waist", "shoulder_left", "shoulder_right", "hip_left", "hip_right"];

// ---- GLB reader -------------------------------------------------------------------------------------------------------------------------------------------
export function parseGlb(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB (bad magic)");
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a && !json) json = JSON.parse(data.toString("utf8"));
    else if (type === 0x004e4942 && !bin) bin = data;
    off += 8 + len;
  }
  if (!json) throw new Error("GLB has no JSON chunk");
  return { json, bin: bin || Buffer.alloc(0) };
}
const COMP = { 5120: [1, "Int8", 127], 5121: [1, "Uint8", 255], 5122: [2, "Int16", 32767], 5123: [2, "Uint16", 65535], 5125: [4, "Uint32", 0], 5126: [4, "Float32", 0] };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
export function readAccessor(g, i) {
  const acc = g.json.accessors[i], n = NCOMP[acc.type], [size, name, max] = COMP[acc.componentType];
  const out = new Float64Array(acc.count * n);
  if (acc.bufferView === undefined) return { data: out, n, count: acc.count };
  const bv = g.json.bufferViews[acc.bufferView];
  const stride = bv.byteStride || size * n, base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const dv = new DataView(g.bin.buffer, g.bin.byteOffset, g.bin.byteLength), get = "get" + name;
  for (let k = 0; k < acc.count; k++) {
    for (let c = 0; c < n; c++) {
      let v = dv[get](base + k * stride + c * size, true);
      if (acc.normalized && max) v = Math.max(v / max, -1);
      out[k * n + c] = v;
    }
  }
  return { data: out, n, count: acc.count };
}

function nodeTree(json) {
  const nodes = json.nodes || [], parent = new Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => (n.children || []).forEach((c) => (parent[c] = i)));
  const mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
  const local = (n) => {
    if (n.matrix) return n.matrix;
    const [x, y, z, w] = n.rotation || [0, 0, 0, 1], [sx, sy, sz] = n.scale || [1, 1, 1], [tx, ty, tz] = n.translation || [0, 0, 0];
    return [
      (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
      2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
      2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
      tx, ty, tz, 1,
    ];
  };
  const world = new Array(nodes.length);
  const W = (i) => (world[i] ||= parent[i] < 0 ? local(nodes[i]) : mul(W(parent[i]), local(nodes[i])));
  const pos = (i) => { const m = W(i); return [m[12], m[13], m[14]]; };
  return { nodes, parent, pos };
}

// Every primitive of a mesh node, concatenated: positions, normals, uvs, joints, weights, triangle indices.
function extractMesh(g, nodeIndex) {
  const node = g.json.nodes[nodeIndex], mesh = g.json.meshes[node.mesh];
  const out = { name: node.name || mesh.name, meshName: mesh.name, node: nodeIndex, skin: node.skin, pos: [], nrm: [], uv: [], jn: [], wt: [], extra: 0, idx: [], nv: 0, notes: [], hasNrm: true, hasUv: true, prims: [] };
  for (const p of mesh.primitives) {
    if ((p.mode ?? 4) !== 4) { out.notes.push("primitive mode " + p.mode + " is not triangles"); continue; }
    if (p.attributes.POSITION === undefined) { out.notes.push("primitive without POSITION"); continue; }
    const P = readAccessor(g, p.attributes.POSITION), nv = P.count;
    out.prims.push({ material: p.material !== undefined && g.json.materials && g.json.materials[p.material] ? g.json.materials[p.material].name || null : null, v0: out.nv, v1: out.nv + nv });
    out.pos.push(P.data);
    if (p.attributes.NORMAL !== undefined) out.nrm.push(readAccessor(g, p.attributes.NORMAL).data); else { out.hasNrm = false; out.nrm.push(new Float64Array(nv * 3)); }
    if (p.attributes.TEXCOORD_0 !== undefined) out.uv.push(readAccessor(g, p.attributes.TEXCOORD_0).data); else { out.hasUv = false; out.uv.push(new Float64Array(nv * 2)); }
    out.jn.push(p.attributes.JOINTS_0 !== undefined ? readAccessor(g, p.attributes.JOINTS_0).data : new Float64Array(nv * 4));
    out.wt.push(p.attributes.WEIGHTS_0 !== undefined ? readAccessor(g, p.attributes.WEIGHTS_0).data : new Float64Array(nv * 4));
    if (p.attributes.JOINTS_1 !== undefined && p.attributes.WEIGHTS_1 !== undefined) {
      const w1 = readAccessor(g, p.attributes.WEIGHTS_1).data;
      for (const x of w1) if (x > 1e-6) out.extra++;
    }
    const ind = p.indices !== undefined ? readAccessor(g, p.indices).data : Float64Array.from({ length: nv }, (_, i) => i);
    for (const v of ind) out.idx.push(v + out.nv);
    out.nv += nv;
  }
  const cat = (arrs, n) => { const o = new Float64Array(out.nv * n); let k = 0; for (const a of arrs) { o.set(a, k); k += a.length; } return o; };
  out.pos = cat(out.pos, 3); out.nrm = cat(out.nrm, 3); out.uv = cat(out.uv, 2); out.jn = cat(out.jn, 4); out.wt = cat(out.wt, 4);
  return out;
}

// ---- geometry helpers ----------------------------------------------------------------------------------------------------------------------------------
function makeWelder(eps = WELD) {
  const cells = new Map(), reps = [];
  const hash = (x, y, z) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) | 0;
  const lookup = (x, y, z) => {
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
    find: lookup,
    id(x, y, z) {
      const f = lookup(x, y, z);
      if (f >= 0) return f;
      const id = reps.length;
      reps.push([x, y, z]);
      const h = hash(Math.floor(x / eps), Math.floor(y / eps), Math.floor(z / eps));
      (cells.get(h) || cells.set(h, []).get(h)).push(id);
      return id;
    },
  };
}
const triArea = (p, a, b, c) => {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
};
const fmt = (p) => "(" + p.map((x) => (Math.round(x * 1e4) / 1e4).toString()).join(", ") + ")";
const names = (arr, max = 6) => arr.slice(0, max).join(", ") + (arr.length > max ? ` and ${arr.length - max} more` : "");

// ---- edge defects, native versus introduced ---------------------------------------------------------------------------------------------------------
// Welds the meshes together by position and returns every edge defect: open (one triangle), over-used (more than two) and flipped (two triangles
// that traverse it the same way). `reps` holds the welded positions; a defect is a key lo * 67108864 + hi into them.
export const NATIVE_TOL = 5e-5, BRIDGE_MAX = 1e-3;
function edgeDefects(meshes) {
  const weld = makeWelder(), edges = new Map();
  let tris = 0, degenerate = 0, verts = 0;
  for (const m of meshes) {
    const vid = new Int32Array(m.nv);
    for (let v = 0; v < m.nv; v++) vid[v] = weld.id(m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]);
    verts += m.nv;
    for (let t = 0; t + 2 < m.idx.length; t += 3) {
      const a = vid[m.idx[t]], b = vid[m.idx[t + 1]], c = vid[m.idx[t + 2]];
      if (a === b || b === c || a === c) { degenerate++; continue; }
      tris++;
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const lo = Math.min(u, v), hi = Math.max(u, v), key = lo * 67108864 + hi, e = edges.get(key) || { n: 0, dir: 0 };
        e.n++; e.dir += u < v ? 1 : -1; edges.set(key, e);
      }
    }
  }
  const open = [], over = [], flipped = [];
  for (const [key, e] of edges) {
    if (e.n === 1) open.push(key); else if (e.n > 2) over.push(key); else if (e.dir !== 0) flipped.push(key);
  }
  const ends = (key) => { const lo = Math.floor(key / 67108864); return [weld.reps[lo], weld.reps[key - lo * 67108864]]; };
  return { weld, tris, degenerate, verts, open, over, flipped, ends, at: (key) => ends(key).map(fmt).join(" to ") };
}
// A set of segments with a lookup: `has(pa, pb)` is true when both points lie within NATIVE_TOL of one of them (the edge is on that segment: the cut
// may have split a source edge in two, so the halves are not at the same welded positions as the whole).
function segIndex(segs, cell = 0.05) {
  const grid = new Map();
  const ck = (x, y, z) => x + "," + y + "," + z;
  segs.forEach((s, id) => {
    const lo = [0, 1, 2].map((k) => Math.floor((Math.min(s[0][k], s[1][k]) - NATIVE_TOL) / cell)), hi = [0, 1, 2].map((k) => Math.floor((Math.max(s[0][k], s[1][k]) + NATIVE_TOL) / cell));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) { const k = ck(x, y, z); (grid.get(k) || grid.set(k, []).get(k)).push(id); }
  });
  const dseg = (p, s) => {
    const a = s[0], b = s[1], ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]], l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    const t = l2 > 0 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2)) : 0;
    return Math.hypot(ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]);
  };
  return {
    size: segs.length,
    has(pa, pb) {
      const list = grid.get(ck(Math.floor(pa[0] / cell), Math.floor(pa[1] / cell), Math.floor(pa[2] / cell)));
      if (!list) return false;
      for (const id of list) if (dseg(pa, segs[id]) <= NATIVE_TOL && dseg(pb, segs[id]) <= NATIVE_TOL) return true;
      return false;
    },
    hasPoint(p) {
      const list = grid.get(ck(Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)));
      return !!list && list.some((id) => dseg(p, segs[id]) <= NATIVE_TOL);
    },
  };
}
// The whole mesh surface of a GLB as one welded group: the numbers a source has before any cut (`--self`), and the defects the output may inherit.
export function surfaceReport(glbBuf) {
  const g = parseGlb(glbBuf);
  const meshes = (g.json.nodes || []).map((n, i) => (n.mesh !== undefined ? extractMesh(g, i) : null)).filter(Boolean);
  const d = edgeDefects(meshes);
  return {
    meshes: meshes.length, vertices: d.verts, triangles: d.tris, degenerate: d.degenerate, open_edges: d.open.length, over_used_edges: d.over.length, flipped_edges: d.flipped.length,
    index: { wt: segIndex([...d.open, ...d.over].map(d.ends)), flipped: segIndex(d.flipped.map(d.ends)) },
    sample: { open: d.open.slice(0, 3).map(d.at), over_used: d.over.slice(0, 3).map(d.at), flipped: d.flipped.slice(0, 3).map(d.at) },
  };
}

export function canonicalPlane(key) {
  const k = String(key).toLowerCase();
  if (k.includes("neck")) return "neck";
  if (k.includes("waist")) return "waist";
  for (const base of ["shoulder", "hip"]) {
    if (!k.includes(base)) continue;
    const rest = k.replace(base, "");
    if (/l/.test(rest) && !/r/.test(rest)) return base + "_left";
    if (/r/.test(rest)) return base + "_right";
  }
  return null;
}

// ---- the validator -------------------------------------------------------------------------------------------------------------------------------------
// opts: { source: Buffer, planeOffset: [x, y, z] }. Returns { ok, sha256, checks: [{ name, ok, skipped, summary, table, details }] }.
export function validate(glbBuf, manifest, opts = {}) {
  const g = parseGlb(glbBuf), json = g.json;
  const off = opts.planeOffset || [0, 0, 0];
  const checks = [];
  const add = (name, ok, summary, details = [], table = []) => { const c = { name, ok, summary, details, table }; checks.push(c); return c; };
  const tree = nodeTree(json);
  const skin = (json.skins || [])[0];
  const jointNames = skin ? skin.joints.map((j) => tree.nodes[j].name) : [];

  // meshes by name
  const byName = {};
  (json.nodes || []).forEach((n, i) => { if (n.mesh !== undefined) for (const nm of [n.name, json.meshes[n.mesh].name]) if (nm && !(nm in byName)) byName[nm] = i; });
  const cache = {};
  const getMesh = (name) => (name in byName ? (cache[name] ||= extractMesh(g, byName[name])) : null);

  // ---- 1 structure
  {
    const bad = [];
    if (!manifest || manifest.schema !== SCHEMA) bad.push(`manifest schema is ${JSON.stringify(manifest && manifest.schema)}, want "${SCHEMA}"`);
    if (!Array.isArray(json.skins) || json.skins.length !== 1) bad.push(`GLB has ${(json.skins || []).length} skins, want exactly 1`);
    const regs = {}, caps = {};
    for (const r of (manifest && manifest.regions) || []) regs[r.id] = r;
    for (const c of (manifest && manifest.caps) || []) caps[c.id] = c;
    for (const id of REGIONS) {
      const r = regs[id];
      if (!r) { bad.push(`manifest has no region "${id}"`); continue; }
      if (r.mesh !== "piece_" + id) bad.push(`region "${id}" names mesh ${JSON.stringify(r.mesh)}, want "piece_${id}"`);
      if (REGION_UNIT[id] && r.detached_by !== REGION_UNIT[id]) bad.push(`region "${id}" detached_by ${JSON.stringify(r.detached_by)}, want "${REGION_UNIT[id]}"`);
    }
    for (const [id, [region, unit]] of Object.entries(CAPS)) {
      const c = caps[id];
      if (!c) { bad.push(`manifest has no cap "${id}"`); continue; }
      if (c.mesh !== id) bad.push(`cap "${id}" names mesh ${JSON.stringify(c.mesh)}`);
      if (c.region !== region) bad.push(`cap "${id}" region ${JSON.stringify(c.region)}, want "${region}"`);
      if (c.shown_when_cut !== unit) bad.push(`cap "${id}" shown_when_cut ${JSON.stringify(c.shown_when_cut)}, want "${unit}"`);
    }
    for (const nm of [...REGIONS.map((r) => "piece_" + r), ...Object.keys(CAPS)]) {
      if (!(nm in byName)) { bad.push(`mesh "${nm}" is not in the GLB`); continue; }
      const n = json.nodes[byName[nm]];
      if (n.skin === undefined) bad.push(`mesh "${nm}" is not skinned`);
      else if (n.skin !== 0) bad.push(`mesh "${nm}" uses skin ${n.skin}, not the one skin`);
    }
    if (manifest && manifest.plane_exempt !== undefined) {
      const pe = manifest.plane_exempt;
      if (!pe || typeof pe !== "object" || Array.isArray(pe)) bad.push("plane_exempt must be an object mapping a piece mesh to a list of material names");
      else {
        if (typeof manifest.plane_exempt_reason !== "string" || !manifest.plane_exempt_reason.trim()) bad.push("plane_exempt needs a plane_exempt_reason (why these materials may leave their piece's side of a plane)");
        for (const [pieceName, mats] of Object.entries(pe)) {
          if (!REGIONS.some((r) => "piece_" + r === pieceName)) { bad.push(`plane_exempt names ${JSON.stringify(pieceName)}, which is not a piece mesh`); continue; }
          if (!Array.isArray(mats) || !mats.length || mats.some((m) => typeof m !== "string")) { bad.push(`plane_exempt.${pieceName} must be a non-empty list of material names`); continue; }
          const m = getMesh(pieceName), have = new Set(m ? m.prims.map((q) => q.material) : []);
          for (const mat of mats) if (!have.has(mat)) bad.push(`plane_exempt.${pieceName} names material ${JSON.stringify(mat)}, which the piece does not use`);
        }
      }
    }
    if (opts.source) {
      const sg = parseGlb(opts.source), st = nodeTree(sg.json), ss = (sg.json.skins || [])[0];
      if (!ss) bad.push("source GLB has no skin");
      else if (skin) {
        const sn = ss.joints.map((j) => st.nodes[j].name), pn = (t, j) => (t.parent[j] >= 0 ? t.nodes[t.parent[j]].name || "?" : null);
        const miss = sn.filter((x) => !jointNames.includes(x)), extra = jointNames.filter((x) => !sn.includes(x));
        if (miss.length) bad.push(`skeleton joints missing vs source: ${names(miss)}`);
        if (extra.length) bad.push(`skeleton joints not in source: ${names(extra)}`);
        const srcParent = {}; ss.joints.forEach((j) => (srcParent[st.nodes[j].name] = pn(st, j)));
        const moved = skin.joints.filter((j) => tree.nodes[j].name in srcParent && srcParent[tree.nodes[j].name] !== pn(tree, j)).map((j) => tree.nodes[j].name);
        if (moved.length) bad.push(`skeleton parents changed vs source: ${names(moved)}`);
      }
    }
    add("structure", !bad.length, bad.length ? `${bad.length} problem(s)` : `schema ${SCHEMA}, 7 pieces + 12 caps, one skin (${jointNames.length} joints)` + (opts.source ? ", skeleton matches source" : ""), bad);
  }

  // gather what exists
  const parts = []; // { id, kind, region, mesh }
  for (const id of REGIONS) { const m = getMesh("piece_" + id); if (m) parts.push({ id: "piece_" + id, kind: "piece", region: id, mesh: m }); }
  for (const [id, [region]] of Object.entries(CAPS)) {
    const reg = (manifest.caps || []).find((c) => c.id === id);
    const m = getMesh(id);
    if (m) parts.push({ id, kind: "cap", region: (reg && reg.region) || region, mesh: m });
  }

  // plane_exempt (manifest): materials of a piece that may lie across its planes (hair on the head piece). Honoured by the planes check, and by the cap
  // direction heuristic (the piece centroid is taken without them: hair hanging below the neck would drag the head's centroid under its own cap). Nothing
  // else is exempt: weights, bone_side, watertight, orientation and the cap checks apply to those vertices as to any other.
  const exemptMask = (p) => {
    const names = manifest && manifest.plane_exempt && Array.isArray(manifest.plane_exempt[p.id]) ? manifest.plane_exempt[p.id] : null;
    if (!names || p.kind !== "piece") return null;
    const mask = new Uint8Array(p.mesh.nv);
    for (const pr of p.mesh.prims) if (names.includes(pr.material)) mask.fill(1, pr.v0, pr.v1);
    return mask;
  };

  // ---- 2 watertight + orientation, per piece with its caps
  {
    // Native versus introduced: with --source, a defect that the source surface already has at the same place (an open edge, an over-used edge, a
    // flipped edge: the output edge lies on a source edge with that defect) is native and only reported; the check fails on defects the cut introduced.
    // Without --source every defect counts as introduced.
    const src = opts.source ? surfaceReport(opts.source) : null;
    const bad = [], badO = [], table = [], tot = { open: 0, over: 0, flipped: 0, nOpen: 0, nOver: 0, nFlipped: 0 };
    for (const region of REGIONS) {
      const group = parts.filter((p) => p.region === region);
      if (!group.some((p) => p.kind === "piece")) continue;
      const d = edgeDefects(group.map((p) => p.mesh));
      // An open edge also counts as native when it bridges a native gap: shorter than BRIDGE_MAX (the tool's gap limit) with both ends on source open
      // edges (the cap's closing chord across a hairline hole the source already had: its two sides stay open, native, and the chord has no piece edge to meet).
      const onSrc = (idx, key, bridge) => { if (!idx) return false; const [pa, pb] = d.ends(key); return idx.has(pa, pb) || (bridge && Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]) <= BRIDGE_MAX && idx.hasPoint(pa) && idx.hasPoint(pb)); };
      const split = (list, idx, bridge) => { const nat = [], intro = []; for (const k of list) (onSrc(idx, k, bridge) ? nat : intro).push(k); return { nat, intro }; };
      const open = split(d.open, src && src.index.wt, true), over = split(d.over, src && src.index.wt), flip = split(d.flipped, src && src.index.flipped);
      const nat = (x) => (src ? ` (${x.nat.length} native)` : "");
      table.push(`piece_${region}: ${group.length - 1} caps, ${d.verts} vertices, ${d.tris} triangles, ${d.open.length} open edges${nat(open)}, ${d.over.length} over-used edges${nat(over)}, ${d.flipped.length} flipped-winding edges${nat(flip)}` + (d.degenerate ? `, ${d.degenerate} degenerate triangles skipped` : ""));
      tot.open += d.open.length; tot.over += d.over.length; tot.flipped += d.flipped.length; tot.nOpen += open.nat.length; tot.nOver += over.nat.length; tot.nFlipped += flip.nat.length;
      if (open.intro.length) bad.push(`piece_${region}: ${open.intro.length} open edge(s)${src ? " introduced by the cut" : ""}; first: ` + open.intro.slice(0, 3).map(d.at).join("; "));
      if (over.intro.length) bad.push(`piece_${region}: ${over.intro.length} edge(s) used by more than two triangles${src ? " introduced by the cut" : ""}; first: ` + over.intro.slice(0, 3).map(d.at).join("; "));
      if (flip.intro.length) badO.push(`piece_${region}: ${flip.intro.length} edge(s) traversed in the same direction by both triangles (flipped winding)${src ? ", introduced by the cut" : ""}; first: ` + flip.intro.slice(0, 3).map(d.at).join("; "));
    }
    if (src) {
      table.push(`source surface: ${src.open_edges} open edges, ${src.over_used_edges} over-used edges, ${src.flipped_edges} flipped-winding edges (output edges lying on one of these are native)`);
    }
    const natW = tot.nOpen + tot.nOver;
    add("watertight", !bad.length, bad.length ? `${bad.length} piece(s) with open or over-used edges` + (src ? " introduced by the cut" : "") : src ? `every piece with its caps is closed except ${natW} edge(s) native to the source (${tot.nOpen} open, ${tot.nOver} over-used); none introduced` : "every piece with its caps is closed", bad, table);
    add("orientation", !badO.length, badO.length ? `${badO.length} piece(s) with inconsistent winding` + (src ? " introduced by the cut" : "") : src && tot.nFlipped ? `winding is consistent across every shared edge except ${tot.nFlipped} flipped edge(s) native to the source; none introduced` : "winding is consistent across every shared edge", badO);
  }

  // ---- 3 skin weights
  {
    const bad = [];
    for (const p of parts) {
      const m = p.mesh;
      let nan = 0, sum = 0, range = 0, worst = 0, maxInf = 0;
      for (let v = 0; v < m.nv; v++) {
        let s = 0, inf = 0, isNan = false;
        for (let k = 0; k < 4; k++) {
          const w = m.wt[v * 4 + k], j = m.jn[v * 4 + k];
          if (!Number.isFinite(w) || w < 0) isNan = true;
          else { s += w; if (w > 0) { inf++; if (skin && (j < 0 || j >= skin.joints.length)) range++; } }
        }
        if (isNan) { nan++; continue; }
        if (Math.abs(s - 1) > WEIGHT_TOL) { sum++; worst = Math.max(worst, Math.abs(s - 1)); }
        maxInf = Math.max(maxInf, inf);
      }
      if (nan) bad.push(`${p.id}: ${nan} vertices with NaN or negative weights`);
      if (sum) bad.push(`${p.id}: ${sum} vertices whose weights do not sum to 1 (worst off by ${worst.toFixed(4)})`);
      if (range) bad.push(`${p.id}: ${range} influences name a joint outside the skin`);
      if (m.extra) bad.push(`${p.id}: ${m.extra} weights in WEIGHTS_1 (more than 4 joints on a vertex)`);
      if (!m.nv) bad.push(`${p.id}: no vertices`);
    }
    add("weights", !bad.length, bad.length ? `${bad.length} problem(s)` : `all weights sum to 1 (within ${WEIGHT_TOL}), finite, at most 4 joints, ${parts.length} meshes`, bad);
  }

  // ---- planes from the manifest
  const planes = {};
  for (const [k, v] of Object.entries((manifest && manifest.planes) || {})) {
    const c = canonicalPlane(k);
    if (!c || !v || !Array.isArray(v.point) || !Array.isArray(v.normal)) continue;
    const len = Math.hypot(...v.normal);
    if (!(len > 0)) continue;
    planes[c] = { point: v.point.map((x, i) => x + off[i]), normal: v.normal.map((x) => x / len) };
  }
  const dist = (pl, x, y, z) => pl.normal[0] * (x - pl.point[0]) + pl.normal[1] * (y - pl.point[1]) + pl.normal[2] * (z - pl.point[2]);

  // ---- 4 bone side
  {
    const bad = [], inJoint = new Map();
    if (skin) skin.joints.forEach((n, i) => inJoint.set(n, i));
    const positive = {};
    const children = tree.nodes.map((n) => n.children || []);
    const desc = (n, into) => { into.add(n); for (const c of children[n]) desc(c, into); };
    const nearestJointAncestor = (n) => { let p = tree.parent[n]; while (p >= 0 && !inJoint.has(p)) p = tree.parent[p]; return p; };
    for (const pn of PLANES) {
      const pl = planes[pn];
      if (!pl || !skin) { bad.push(`cannot derive the sides of plane "${pn}": ${!skin ? "no skin" : "not in the manifest"}`); continue; }
      const side = (n) => { const q = tree.pos(n); return dist(pl, q[0], q[1], q[2]); };
      const set = new Set();
      for (const n of skin.joints) {
        const a = nearestJointAncestor(n);
        if (a >= 0 && side(a) < -PLANE_TOL && side(n) >= -PLANE_TOL) desc(n, set);
      }
      for (const n of [...set]) if (!inJoint.has(n)) set.delete(n);
      if (!set.size) bad.push(`no bone crosses plane "${pn}" in the skeleton tree`);
      positive[pn] = set;
    }
    const viol = {};
    for (const p of parts) {
      const cons = CONSTRAINTS[p.region];
      if (!cons || cons.some(([pn]) => !positive[pn])) continue;
      const m = p.mesh;
      for (let v = 0; v < m.nv; v++) for (let k = 0; k < 4; k++) {
        const w = m.wt[v * 4 + k];
        if (!(w > 1e-6)) continue;
        const jn = skin.joints[m.jn[v * 4 + k]];
        if (jn === undefined) continue;
        for (const [pn, sign] of cons) {
          if (positive[pn].has(jn) !== (sign === "+")) {
            const key = `${p.id} uses ${tree.nodes[jn].name} (across the ${pn} cut)`;
            const e = viol[key] || (viol[key] = { n: 0, max: 0 });
            e.n++; e.max = Math.max(e.max, w);
            break;
          }
        }
      }
    }
    for (const [k, e] of Object.entries(viol)) bad.push(`${k}: ${e.n} vertices, largest weight ${e.max.toFixed(3)}`);
    add("bone_side", !bad.length, bad.length ? `${bad.length} violation(s)` : "no vertex is bound to a bone on the other side of a cut", bad);
  }

  // ---- 5 caps
  {
    const bad = [];
    for (const p of parts.filter((q) => q.kind === "cap")) {
      const m = p.mesh, piece = parts.find((q) => q.kind === "piece" && q.region === p.region);
      if (!m.idx.length) { bad.push(`${p.id}: no triangles`); continue; }
      if (!m.hasUv) bad.push(`${p.id}: no TEXCOORD_0`);
      else if (m.uv.some((x) => !Number.isFinite(x))) bad.push(`${p.id}: NaN in TEXCOORD_0`);
      if (!m.hasNrm) { bad.push(`${p.id}: no NORMAL`); continue; }
      if (!piece) continue;
      const weld = makeWelder(), cen = [0, 0, 0], ex = exemptMask(piece);
      for (let v = 0; v < piece.mesh.nv; v++) if (!ex || !ex[v]) weld.id(piece.mesh.pos[v * 3], piece.mesh.pos[v * 3 + 1], piece.mesh.pos[v * 3 + 2]);
      for (const r of weld.reps) for (let k = 0; k < 3; k++) cen[k] += r[k] / weld.reps.length;
      const cc = [0, 0, 0], nm = [0, 0, 0];
      for (let v = 0; v < m.nv; v++) for (let k = 0; k < 3; k++) { cc[k] += m.pos[v * 3 + k] / m.nv; nm[k] += m.nrm[v * 3 + k] / m.nv; }
      const out = [cc[0] - cen[0], cc[1] - cen[1], cc[2] - cen[2]], d = nm[0] * out[0] + nm[1] * out[1] + nm[2] * out[2];
      if (!(d > 0)) bad.push(`${p.id}: normals face inward (mean normal dot outward vector ${d.toFixed(4)}; outward is from the ${p.region} centroid to the cap centroid)`);
      // winding must agree with the stored normals and with outward
      let wsum = [0, 0, 0], agree = 0, total = 0;
      for (let t = 0; t + 2 < m.idx.length; t += 3) {
        const [a, b, c] = [m.idx[t], m.idx[t + 1], m.idx[t + 2]], gn = triArea(m.pos, a, b, c);
        if (!(Math.hypot(...gn) > 1e-14)) continue;
        for (let k = 0; k < 3; k++) wsum[k] += gn[k];
        const avg = [0, 1, 2].map((k) => m.nrm[a * 3 + k] + m.nrm[b * 3 + k] + m.nrm[c * 3 + k]);
        total++; if (gn[0] * avg[0] + gn[1] * avg[1] + gn[2] * avg[2] > 0) agree++;
      }
      if (total && agree / total < 0.99) bad.push(`${p.id}: winding disagrees with the stored normals on ${total - agree} of ${total} triangles`);
      else if (total && wsum[0] * out[0] + wsum[1] * out[1] + wsum[2] * out[2] <= 0) bad.push(`${p.id}: winding faces inward`);
    }
    add("caps", !bad.length, bad.length ? `${bad.length} problem(s)` : "caps face outward, winding agrees with normals, UVs present", bad);
  }

  // ---- 6 conservation vs source
  if (!opts.source) add("conservation", true, "skipped (no --source)");
  else {
    const sg = parseGlb(opts.source), bad = [];
    const sm = (sg.json.nodes || []).map((n, i) => (n.mesh !== undefined ? extractMesh(sg, i) : null)).filter(Boolean);
    let srcArea = 0, pieceArea = 0;
    const sbox = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]], pbox = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
    const area = (m) => { let a = 0; for (let t = 0; t + 2 < m.idx.length; t += 3) a += 0.5 * Math.hypot(...triArea(m.pos, m.idx[t], m.idx[t + 1], m.idx[t + 2])); return a; };
    const grow = (box, m, used) => { for (let v = 0; v < m.nv; v++) { if (used && !used[v]) continue; for (let k = 0; k < 3; k++) { box[0][k] = Math.min(box[0][k], m.pos[v * 3 + k]); box[1][k] = Math.max(box[1][k], m.pos[v * 3 + k]); } } };
    const usedOf = (m) => { const u = new Uint8Array(m.nv); for (const i of m.idx) u[i] = 1; return u; };
    for (const m of sm) { srcArea += area(m); grow(sbox, m, usedOf(m)); }
    const pw = makeWelder();
    for (const p of parts.filter((q) => q.kind === "piece")) {
      pieceArea += area(p.mesh); grow(pbox, p.mesh, usedOf(p.mesh));
      for (let v = 0; v < p.mesh.nv; v++) pw.id(p.mesh.pos[v * 3], p.mesh.pos[v * 3 + 1], p.mesh.pos[v * 3 + 2]);
    }
    const rel = srcArea > 0 ? Math.abs(pieceArea - srcArea) / srcArea : 1;
    if (!(rel <= AREA_TOL)) bad.push(`piece triangle area ${pieceArea.toFixed(5)} vs source ${srcArea.toFixed(5)} (off by ${(rel * 100).toFixed(2)} percent, limit ${AREA_TOL * 100})`);
    for (let k = 0; k < 3; k++) for (let s = 0; s < 2; s++) {
      if (!(Math.abs(pbox[s][k] - sbox[s][k]) <= BBOX_TOL)) bad.push(`bounding box ${s ? "max" : "min"} ${"xyz"[k]}: pieces ${pbox[s][k]} vs source ${sbox[s][k]}`);
    }
    const sw = makeWelder();
    let missing = 0, total = 0;
    const firstMissing = [];
    for (const m of sm) { const u = usedOf(m); for (let v = 0; v < m.nv; v++) { if (!u[v]) continue; const x = m.pos[v * 3], y = m.pos[v * 3 + 1], z = m.pos[v * 3 + 2], before = sw.reps.length; if (sw.id(x, y, z) < before) continue; total++; if (pw.find(x, y, z) < 0) { missing++; if (firstMissing.length < 3) firstMissing.push(fmt([x, y, z])); } } }
    if (missing) bad.push(`${missing} of ${total} welded source vertices appear in no piece; first: ${firstMissing.join("; ")}`);
    add("conservation", !bad.length, bad.length ? `${bad.length} problem(s)` : `area ${pieceArea.toFixed(4)} vs ${srcArea.toFixed(4)} (${(rel * 100).toFixed(3)} percent), bounding box equal, ${total} source vertices all present`, bad);
  }

  // ---- 7 planes
  {
    const bad = [], exemptNote = [];
    for (const p of parts) {
      const cons = CONSTRAINTS[p.region];
      if (!cons) continue;
      const ex = exemptMask(p);
      if (ex) exemptNote.push(`${ex.reduce((s, x) => s + x, 0)} ${p.id} vertices (${manifest.plane_exempt[p.id].join(", ")})`);
      for (const [pn, sign] of cons) {
        const pl = planes[pn];
        if (!pl) { if (!bad.some((b) => b.startsWith(`plane "${pn}"`))) bad.push(`plane "${pn}" is not in the manifest`); continue; }
        let n = 0, worst = 0;
        for (let v = 0; v < p.mesh.nv; v++) {
          if (ex && ex[v]) continue;
          const d = dist(pl, p.mesh.pos[v * 3], p.mesh.pos[v * 3 + 1], p.mesh.pos[v * 3 + 2]) * (sign === "+" ? 1 : -1);
          if (d < -PLANE_TOL) { n++; worst = Math.max(worst, -d); }
        }
        if (n) bad.push(`${p.id}: ${n} vertices on the wrong side of the ${pn} plane (worst ${worst.toFixed(5)})`);
      }
    }
    add("planes", !bad.length, bad.length ? `${bad.length} violation(s)` : "every piece vertex is on its side of its planes (1e-4)" + (exemptNote.length ? `; plane_exempt (manifest): ${exemptNote.join("; ")} not checked` : ""), bad);
  }

  return { ok: checks.every((c) => c.ok), sha256: sha256HexBytes(glbBuf), checks };
}

// ---- CLI -----------------------------------------------------------------------------------------------------------------------------------------------
function main(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") flags.source = argv[++i];
    else if (a === "--plane-offset") flags.offset = argv[++i].split(",").map(Number);
    else if (a === "--json" || a === "--hash" || a === "--self") flags[a.slice(2)] = true;
    else if (a.startsWith("--")) { console.error("unknown flag " + a); return 2; }
    else pos.push(a);
  }
  if (!pos[0] || (!pos[1] && !flags.hash && !flags.self)) { console.error("usage: node tools/cut-validate.mjs <body.cut.glb> <body.cut.manifest.json> [--source <body.glb>] [--json] [--hash] [--plane-offset x,y,z]\n       node tools/cut-validate.mjs <plain.glb> --self"); return 2; }
  const glb = readFileSync(pos[0]);
  if (flags.self) { // the surface defects a GLB already has (run it on the plain source: what the cut inherits)
    const r = surfaceReport(glb);
    delete r.index;
    if (flags.json) console.log(JSON.stringify(r, null, 1));
    else console.log(`cut-validate --self ${pos[0]}\n  ${r.meshes} mesh(es), ${r.vertices} vertices, ${r.triangles} triangles (${r.degenerate} degenerate)\n  open edges ${r.open_edges}, over-used edges ${r.over_used_edges}, flipped-winding edges ${r.flipped_edges}`);
    return 0;
  }
  if (flags.hash && !pos[1]) { console.log(sha256HexBytes(glb) + "  " + pos[0]); return 0; }
  const manifest = JSON.parse(readFileSync(pos[1], "utf8"));
  const res = validate(glb, manifest, { source: flags.source ? readFileSync(flags.source) : null, planeOffset: flags.offset });
  if (flags.json) { console.log(JSON.stringify(res, null, 1)); return res.ok ? 0 : 1; }
  console.log(`cut-validate ${pos[0]}`);
  if (flags.hash) console.log(`sha256 ${res.sha256}`);
  res.checks.forEach((c, i) => {
    console.log(`${String(i + 1).padStart(2)} ${c.name.padEnd(13)} ${c.skipped || c.summary.startsWith("skipped") ? "SKIP" : c.ok ? "PASS" : "FAIL"}  ${c.summary}`);
    for (const t of c.table) console.log("      " + t);
    if (!c.ok) for (const d of c.details.slice(0, 25)) console.log("      - " + d);
    if (!c.ok && c.details.length > 25) console.log(`      ... ${c.details.length - 25} more`);
  });
  console.log(res.ok ? "RESULT: PASS" : "RESULT: FAIL (" + res.checks.filter((c) => !c.ok).map((c) => c.name).join(", ") + ")");
  return res.ok ? 0 : 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
