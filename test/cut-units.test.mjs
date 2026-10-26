// tools/cut-units.mjs on a small synthetic skinned body (boxes, strands and a hollow tube across the cut planes), plus the V3 106-rig bodies when
// their GLBs are on this machine (CUT_BODIES_DIR, default /root/bodies; licence: not in the repo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { cutGlb, weldReport, triangulateLoops, REGIONS, CAPS } from "../tools/cut-units.mjs";

const rigMap = JSON.parse(readFileSync(new URL("../data/rig-maps/mixamo-106.json", import.meta.url), "utf8"));
const FLOOR = 0.05; // the toes sit 5 cm above y = 0 in the synthetic GLB, like the real bodies sit above their measure row's floor

// ---------------------------------------------------------------- the synthetic body
const W = { // world bind-pose joint positions
  Hips: [0, 0.95, 0], Spine: [0, 1.05, 0], Spine1: [0, 1.17, 0], Spine2: [0, 1.3, 0], Neck: [0, 1.45, 0], Head: [0, 1.55, 0], HeadTop_End: [0, 1.75, 0],
  LeftShoulder: [0.05, 1.4, 0], LeftArm: [0.2, 1.4, 0], LeftForeArm: [0.45, 1.4, 0], LeftHand: [0.7, 1.4, 0],
  RightShoulder: [-0.05, 1.4, 0], RightArm: [-0.2, 1.4, 0], RightForeArm: [-0.45, 1.4, 0], RightHand: [-0.7, 1.4, 0],
  LeftUpLeg: [0.09, 0.9, 0], LeftLeg: [0.12, 0.47, 0], LeftFoot: [0.13, 0.14, 0], LeftToeBase: [0.15, FLOOR, 0.14],
  RightUpLeg: [-0.09, 0.9, 0], RightLeg: [-0.12, 0.47, 0], RightFoot: [-0.13, 0.14, 0], RightToeBase: [-0.15, FLOOR, 0.14],
};
const PARENT = { Spine: "Hips", Spine1: "Spine", Spine2: "Spine1", Neck: "Spine2", Head: "Neck", HeadTop_End: "Head", LeftShoulder: "Spine2", LeftArm: "LeftShoulder", LeftForeArm: "LeftArm", LeftHand: "LeftForeArm", RightShoulder: "Spine2", RightArm: "RightShoulder", RightForeArm: "RightArm", RightHand: "RightForeArm", LeftUpLeg: "Hips", LeftLeg: "LeftUpLeg", LeftFoot: "LeftLeg", LeftToeBase: "LeftFoot", RightUpLeg: "Hips", RightLeg: "RightUpLeg", RightFoot: "RightLeg", RightToeBase: "RightFoot" };
const NAMES = Object.keys(W);
const IDX = Object.fromEntries(NAMES.map((n, i) => [n, i]));

const chain = (pts, v) => { // pts: ascending [coordinate, joint]; linear blend of the two neighbours
  if (v <= pts[0][0]) return [[pts[0][1], 1]];
  if (v >= pts[pts.length - 1][0]) return [[pts[pts.length - 1][1], 1]];
  for (let i = 0; i + 1 < pts.length; i++) if (v <= pts[i + 1][0]) { const t = (v - pts[i][0]) / (pts[i + 1][0] - pts[i][0]); return [[pts[i][1], 1 - t], [pts[i + 1][1], t]]; }
};
const SPINE = [[0.95, "Hips"], [1.05, "Spine"], [1.17, "Spine1"], [1.3, "Spine2"], [1.45, "Neck"], [1.55, "Head"], [1.75, "HeadTop_End"]];
const legChain = (s) => [[0.05, s + "ToeBase"], [0.14, s + "Foot"], [0.47, s + "Leg"], [0.9, s + "UpLeg"]];
const wSpine = (p) => chain(SPINE, p[1]);
const wLeg = (s) => (p) => (p[1] > 0.9 ? [[s + "UpLeg", 0.6], ["Hips", 0.4]] : chain(legChain(s), p[1]));
const wArm = (s) => (p) => (Math.abs(p[0]) < 0.2 ? [[s + "Shoulder", 1]] : chain([[0.2, s + "Arm"], [0.45, s + "ForeArm"], [0.7, s + "Hand"]], Math.abs(p[0])));
const wHead = () => [["Head", 1]];

// a subdivided box: per-face vertices (own normals and UVs, so seams are real), outward CCW triangles
function box(c, h, n, weights) {
  const faces = [
    [[c[0] + h[0], c[1] - h[1], c[2] + h[2]], [0, 0, -2 * h[2]], [0, 2 * h[1], 0]],
    [[c[0] - h[0], c[1] - h[1], c[2] - h[2]], [0, 0, 2 * h[2]], [0, 2 * h[1], 0]],
    [[c[0] - h[0], c[1] + h[1], c[2] - h[2]], [0, 0, 2 * h[2]], [2 * h[0], 0, 0]],
    [[c[0] - h[0], c[1] - h[1], c[2] - h[2]], [2 * h[0], 0, 0], [0, 0, 2 * h[2]]],
    [[c[0] - h[0], c[1] - h[1], c[2] + h[2]], [2 * h[0], 0, 0], [0, 2 * h[1], 0]],
    [[c[0] - h[0], c[1] - h[1], c[2] - h[2]], [0, 2 * h[1], 0], [2 * h[0], 0, 0]],
  ];
  const m = { pos: [], nor: [], uv: [], wts: [], idx: [] };
  for (const [o, u, v] of faces) {
    const nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...nrm); nrm[0] /= l; nrm[1] /= l; nrm[2] /= l;
    const base = m.pos.length;
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      const p = [o[0] + u[0] * i / n + v[0] * j / n, o[1] + u[1] * i / n + v[1] * j / n, o[2] + u[2] * i / n + v[2] * j / n];
      m.pos.push(p); m.nor.push(nrm); m.uv.push([i / n, j / n]); m.wts.push(weights(p));
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = base + j * (n + 1) + i, b = a + 1, d = a + n + 1, e = d + 1;
      m.idx.push(a, b, e, a, e, d);
    }
  }
  return m;
}
// a hollow square tube (genus 1): outer and inner ring of 4k points, m levels, annular top and bottom
function tube(cx, cz, ho, hi, y0, y1, k, lv, weights) {
  const ring = (h) => { const r = []; for (let s = 0; s < 4; s++) for (let i = 0; i < k; i++) { const t = -h + 2 * h * i / k; r.push(s === 0 ? [h, t] : s === 1 ? [h - 2 * h * i / k, h] : s === 2 ? [-h, h - 2 * h * i / k] : [-h + 2 * h * i / k, -h]); } return r; };
  const O = ring(ho), I = ring(hi);
  const m = { pos: [], nor: [], uv: [], wts: [], idx: [] };
  const quad = (a, b, c, d, nI) => { // four points, intended outward normal; triangles wound to match it
    const base = m.pos.length;
    for (const p of [a, b, c, d]) { m.pos.push(p); m.nor.push(nI); m.uv.push([0, 0]); m.wts.push(weights(p)); }
    const cr = (p, q, r) => { const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]]; return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; };
    const d1 = cr(a, b, c), ok = d1[0] * nI[0] + d1[1] * nI[1] + d1[2] * nI[2] > 0;
    m.idx.push(...(ok ? [base, base + 1, base + 2, base, base + 2, base + 3] : [base, base + 2, base + 1, base, base + 3, base + 2]));
  };
  const P = (r, i, y) => [cx + r[i % r.length][0], y, cz + r[i % r.length][1]];
  for (const [ring_, inward] of [[O, false], [I, true]]) for (let i = 0; i < ring_.length; i++) for (let j = 0; j < lv; j++) {
    const ya = y0 + (y1 - y0) * j / lv, yb = y0 + (y1 - y0) * (j + 1) / lv;
    const mid = [(ring_[i][0] + ring_[(i + 1) % ring_.length][0]) / 2, (ring_[i][1] + ring_[(i + 1) % ring_.length][1]) / 2];
    const nl = Math.hypot(...mid), nn = [mid[0] / nl * (inward ? -1 : 1), 0, mid[1] / nl * (inward ? -1 : 1)];
    quad(P(ring_, i, ya), P(ring_, i + 1, ya), P(ring_, i + 1, yb), P(ring_, i, yb), nn);
  }
  for (let i = 0; i < O.length; i++) {
    quad(P(O, i, y1), P(O, i + 1, y1), P(I, i + 1, y1), P(I, i, y1), [0, 1, 0]);
    quad(P(O, i, y0), P(O, i + 1, y0), P(I, i + 1, y0), P(I, i, y0), [0, -1, 0]);
  }
  return m;
}

async function buildBody() {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("Scene");
  const armature = doc.createNode("Armature");
  scene.addChild(armature);
  const nodes = {};
  for (const n of NAMES) {
    const par = PARENT[n], pw = par ? W[par] : [0, 0, 0];
    nodes[n] = doc.createNode("mixamorig:" + n).setTranslation([W[n][0] - pw[0], W[n][1] - pw[1], W[n][2] - pw[2]]);
  }
  armature.addChild(nodes.Hips);
  for (const n of NAMES) if (PARENT[n]) nodes[PARENT[n]].addChild(nodes[n]);
  const ibm = new Float32Array(NAMES.length * 16);
  NAMES.forEach((n, i) => ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -W[n][0], -W[n][1], -W[n][2], 1], i * 16));
  const mkSkin = () => { const s = doc.createSkin("skin").setInverseBindMatrices(doc.createAccessor().setType("MAT4").setArray(ibm).setBuffer(buffer)); for (const n of NAMES) s.addJoint(nodes[n]); return s; };
  const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
  const matBody = doc.createMaterial("body"), matHorn = doc.createMaterial("horn"), matLash = doc.createMaterial("lash");
  const prim = (parts, material) => {
    const pos = [], nor = [], uv = [], jj = [], ww = [], idx = [];
    for (const m of parts) {
      const base = pos.length / 3;
      m.pos.forEach((p, i) => {
        pos.push(...p); nor.push(...m.nor[i]); uv.push(...m.uv[i]);
        const w = m.wts[i].slice(0, 4); while (w.length < 4) w.push(["Hips", 0]);
        jj.push(...w.map((e) => IDX[e[0]])); ww.push(...w.map((e) => e[1]));
      });
      for (const i of m.idx) idx.push(base + i);
    }
    return doc.createPrimitive().setMaterial(material)
      .setAttribute("POSITION", acc("VEC3", new Float32Array(pos))).setAttribute("NORMAL", acc("VEC3", new Float32Array(nor))).setAttribute("TEXCOORD_0", acc("VEC2", new Float32Array(uv)))
      .setAttribute("JOINTS_0", acc("VEC4", new Uint16Array(jj))).setAttribute("WEIGHTS_0", acc("VEC4", new Float32Array(ww))).setIndices(acc("SCALAR", new Uint32Array(idx)));
  };
  const bodyParts = [
    box([0, 1.35, 0], [0.1, 0.4, 0.08], 12, wSpine), // the column: hips to head top across the waist and neck planes
    box([0.07, 1.52, 0.1], [0.01, 0.13, 0.01], 3, wSpine), box([-0.07, 1.52, 0.1], [0.01, 0.13, 0.01], 3, wSpine), // two strands across the neck plane
    tube(0, -0.25, 0.06, 0.03, 1.3, 1.7, 3, 10, wSpine), // hollow tube across the neck plane: the cut has a hole
    box([0.09, 0.5, 0], [0.078, 0.5, 0.07], 10, wLeg("Left")), box([-0.09, 0.5, 0], [0.078, 0.5, 0.07], 10, wLeg("Right")), // legs across the hip planes
  ];
  const armParts = [box([0.435, 1.4, 0], [0.315, 0.05, 0.05], 12, wArm("Left")), box([-0.435, 1.4, 0], [0.315, 0.05, 0.05], 12, wArm("Right"))]; // arms across the shoulder planes
  const lashParts = [box([0, 1.62, 0.12], [0.03, 0.005, 0.005], 2, wHead)];
  const skin = mkSkin(), skin2 = mkSkin();
  const mesh = doc.createMesh("Body").addPrimitive(prim(bodyParts, matBody)).addPrimitive(prim(armParts, matHorn));
  scene.addChild(doc.createNode("Body").setMesh(mesh).setSkin(skin));
  scene.addChild(doc.createNode("Lashes").setMesh(doc.createMesh("Lashes").addPrimitive(prim(lashParts, matLash))).setSkin(skin2));
  const bytes = await new NodeIO().writeBinary(doc);
  const row = { id: "synthetic", joints: Object.fromEntries(Object.keys(rigMap.joints).map((r) => [r, [W[r][0], W[r][1] - FLOOR, W[r][2]]])) };
  return { bytes, row, source: { body: bodyParts, arm: armParts, lash: lashParts } };
}
const cut = async (b) => cutGlb(b.bytes, b.row, rigMap, { body: "synthetic", rig: "mixamo-106", source: "synthetic.glb" });

// ---------------------------------------------------------------- reading the output back
async function readOut(glb) {
  const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).readBinary(glb);
  const root = doc.getRoot();
  const skin = root.listSkins()[0];
  const joints = skin.listJoints().map((j) => j.getName().replace("mixamorig:", ""));
  const out = { doc, joints, skins: root.listSkins().length, meshes: {} };
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const prims = mesh.listPrimitives().map((p) => {
      const pa = p.getAttribute("POSITION"), ja = p.getAttribute("JOINTS_0"), wa = p.getAttribute("WEIGHTS_0"), na = p.getAttribute("NORMAL"), ua = p.getAttribute("TEXCOORD_0");
      const n = pa.getCount(), positions = new Float64Array(n * 3), jj = [], ww = [], nor = [], uv = [];
      for (let i = 0; i < n; i++) { positions.set(pa.getElement(i, [0, 0, 0]), i * 3); jj.push(ja.getElement(i, [0, 0, 0, 0])); ww.push(wa.getElement(i, [0, 0, 0, 0])); nor.push(na.getElement(i, [0, 0, 0])); uv.push(ua.getElement(i, [0, 0])); }
      const idx = []; const ia = p.getIndices(); for (let i = 0; i < ia.getCount(); i++) idx.push(ia.getScalar(i));
      return { positions, jj, ww, nor, uv, indices: idx, material: p.getMaterial() && p.getMaterial().getName(), skinned: !!node.getSkin() };
    });
    out.meshes[mesh.getName()] = { prims, node };
  }
  return out;
}
const areaOf = (positions, indices) => {
  let a = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const p = (k) => [positions[indices[t + k] * 3], positions[indices[t + k] * 3 + 1], positions[indices[t + k] * 3 + 2]];
    const A = p(0), B = p(1), C = p(2), u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    a += 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
  }
  return a;
};
const sourceArea = (parts) => parts.reduce((s, m) => s + areaOf(m.pos.flat().map(Math.fround), m.idx), 0); // the GLB stores float32
const OWN = { // bones on each region's own side of the cut, from the skeleton alone
  root: ["Hips"], upper_torso: ["Spine", "Spine1", "Spine2", "Neck", "LeftShoulder", "RightShoulder"], head: ["Head", "HeadTop_End"],
  arm_left: ["LeftArm", "LeftForeArm", "LeftHand"], arm_right: ["RightArm", "RightForeArm", "RightHand"],
  leg_left: ["LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase"], leg_right: ["RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"],
};
const regionOfCap = Object.fromEntries(CAPS.map((c) => [c.id, c.region]));

// ---------------------------------------------------------------- tests
let cached;
const run = async () => (cached ||= (async () => { const b = await buildBody(); const r = await cut(b); return { b, r, out: await readOut(r.glb) }; })());

test("manifest is valid against the contract", async () => {
  const { r } = await run();
  const m = r.manifest;
  assert.equal(m.schema, "cut-pieces/1");
  assert.equal(m.body, "synthetic"); assert.equal(m.rig, "mixamo-106"); assert.equal(m.source, "synthetic.glb");
  assert.deepEqual(m.regions.map((x) => x.id).sort(), ["arm_left", "arm_right", "head", "leg_left", "leg_right", "root", "upper_torso"]);
  for (const x of m.regions) assert.equal(x.mesh, "piece_" + x.id);
  assert.equal(m.regions.find((x) => x.id === "head").detached_by, "head");
  assert.equal(m.regions.find((x) => x.id === "upper_torso").detached_by, "torso_waist");
  assert.equal(m.regions.find((x) => x.id === "root").detached_by, null);
  assert.equal(m.caps.length, 12);
  const shown = { cap_neck_head: "head", cap_neck_torso: "head", cap_shoulder_left_arm: "arm_left", cap_shoulder_left_torso: "arm_left", cap_shoulder_right_arm: "arm_right", cap_shoulder_right_torso: "arm_right", cap_hip_left_leg: "leg_left", cap_hip_left_root: "leg_left", cap_hip_right_leg: "leg_right", cap_hip_right_root: "leg_right", cap_waist_torso: "torso_waist", cap_waist_root: "torso_waist" };
  for (const c of m.caps) { assert.equal(c.mesh, c.id); assert.equal(c.shown_when_cut, shown[c.id], c.id); assert.ok(m.regions.some((x) => x.id === c.region), c.id + " region"); }
  assert.deepEqual(m.caps.map((c) => c.id).sort(), Object.keys(shown).sort());
  for (const k of ["neck", "shoulder_left", "shoulder_right", "hip_left", "hip_right", "waist"]) {
    const p = m.planes[k];
    assert.ok(p, "plane " + k);
    assert.ok(p.point.length === 3 && p.point.every(Number.isFinite), k + " point");
    assert.ok(p.normal.length === 3 && Math.abs(Math.hypot(...p.normal) - 1) < 1e-5, k + " unit normal");
    assert.equal(typeof p.source, "string");
  }
  // the planes are in the measure row's frame (toes at y = 0): the neck plane is half way from Neck to Head, 5 cm below the GLB's world height
  assert.ok(Math.abs(m.planes.neck.point[1] - (1.5 - FLOOR)) < 1e-4, "neck plane height " + m.planes.neck.point);
  assert.ok(Math.abs(m.planes.waist.point[1] - (1.05 - FLOOR)) < 1e-4);
  const s = m.stats;
  for (const k of ["vertices_in", "vertices_out", "triangles_split", "orphan_weights"]) assert.ok(Number.isInteger(s[k]), k);
  assert.equal(typeof s.watertight, "boolean");
  assert.equal(s.watertight, true);
  assert.equal(s.orphan_weights, 0);
  assert.ok(s.vertices_out >= s.vertices_in && s.triangles_split > 0);
  assert.deepEqual(s.caps_missing, []);
});

test("one scene, one skin, seven skinned pieces and twelve skinned caps, original materials kept plus cap_flesh", async () => {
  const { out } = await run();
  assert.equal(out.skins, 1, "the eyelash mesh's second skin is merged into the one skin");
  assert.deepEqual(out.joints, NAMES, "skeleton unchanged: same joints in the same order");
  const want = [...REGIONS.map((r) => r.mesh), ...CAPS.map((c) => c.id)];
  assert.deepEqual(Object.keys(out.meshes).sort(), want.sort());
  for (const [name, m] of Object.entries(out.meshes)) { assert.ok(m.node.getSkin(), name + " is skinned"); assert.equal(m.prims.length >= 1, true); }
  for (const c of CAPS) assert.deepEqual([...new Set(out.meshes[c.id].prims.map((p) => p.material))], ["cap_flesh"]);
  const mats = (n) => new Set(out.meshes[n].prims.map((p) => p.material));
  assert.ok(mats("piece_head").has("lash"), "the eyelash mesh follows the head piece");
  assert.ok(mats("piece_head").has("body"));
  assert.ok(mats("piece_arm_left").has("horn") && mats("piece_arm_right").has("horn"), "the second material (a second primitive) is kept");
  assert.ok(!mats("piece_leg_left").has("lash"));
});

test("conservation: surface area, every source vertex lands in a piece, weights sum to one", async () => {
  const { b, r, out } = await run();
  const src = sourceArea([...b.source.body, ...b.source.arm, ...b.source.lash]);
  let got = 0;
  for (const R of REGIONS) for (const p of out.meshes[R.mesh].prims) got += areaOf(p.positions, p.indices);
  assert.ok(Math.abs(got - src) / src < 1e-9, `area ${got} vs ${src}`);
  // each source vertex away from every plane sits in exactly one piece (matched by position and normal; the box faces keep seams real)
  const f = Math.fround;
  const key = (p, n) => p.map((x) => Math.round(f(x) * 1e6)).join(",") + "|" + n.map((x) => Math.round(f(x) * 1e4)).join(",");
  const counts = new Map(), srcCounts = new Map();
  for (const R of REGIONS) for (const p of out.meshes[R.mesh].prims) for (let i = 0; i < p.nor.length; i++) { const k = key(Array.from(p.positions.slice(i * 3, i * 3 + 3)), p.nor[i]); counts.set(k, (counts.get(k) || 0) + 1); }
  const all = [...b.source.body, ...b.source.arm, ...b.source.lash];
  for (const m of all) m.pos.forEach((p, i) => { const k = key(p, m.nor[i]); srcCounts.set(k, (srcCounts.get(k) || 0) + 1); });
  const planes = Object.values(r.manifest.planes).map((pl) => ({ n: pl.normal, c: pl.normal[0] * (pl.point[0]) + pl.normal[1] * (pl.point[1] + FLOOR) + pl.normal[2] * pl.point[2] }));
  let checked = 0, onPlane = 0;
  for (const m of all) m.pos.forEach((p, i) => {
    const near = planes.some((pl) => Math.abs(pl.n[0] * p[0] + pl.n[1] * p[1] + pl.n[2] * p[2] - pl.c) < 1e-3);
    const k = key(p, m.nor[i]), c = counts.get(k) || 0;
    if (near) { onPlane++; assert.ok(c >= 1, "vertex near a plane is in at least one piece"); } else { checked++; assert.equal(c, srcCounts.get(k), "vertex " + p + " in exactly one piece (as many copies out as in)"); }
  });
  assert.ok(checked > 1000 && onPlane > 100, `${checked} interior and ${onPlane} plane-adjacent vertices checked`);
  for (const name of Object.keys(out.meshes)) for (const p of out.meshes[name].prims) for (const w of p.ww) assert.ok(Math.abs(w[0] + w[1] + w[2] + w[3] - 1) < 1e-5, name + " weights sum " + w);
  assert.ok(r.manifest.stats.vertices_out > r.manifest.stats.vertices_in, "splitting adds vertices");
});

test("every piece with its caps is watertight (each edge shared by exactly two triangles)", async () => {
  const { r, out } = await run();
  for (const R of REGIONS) {
    const parts = out.meshes[R.mesh].prims.map((p) => ({ positions: p.positions, indices: p.indices }));
    for (const c of CAPS) if (c.region === R.id) for (const p of out.meshes[c.id].prims) parts.push({ positions: p.positions, indices: p.indices });
    const rep = weldReport(parts, 1e-5);
    assert.equal(rep.boundary_edges, 0, `${R.id}: ${rep.boundary_edges} open edges at ${JSON.stringify(rep.boundary_sample)}`);
    assert.equal(rep.non_manifold_edges, 0, `${R.id}: non-manifold edges`);
    assert.equal(rep.degenerate, 0, `${R.id}: degenerate triangles`);
  }
  // and the pieces alone are open exactly where a cap goes
  const bare = weldReport(out.meshes.piece_head.prims.map((p) => ({ positions: p.positions, indices: p.indices })), 1e-5);
  assert.ok(bare.boundary_edges > 0);
  for (const k of Object.keys(r.manifest.stats.watertight_by_region)) assert.equal(r.manifest.stats.watertight_by_region[k].boundary_edges, 0, k);
});

test("no vertex of a piece or cap is bound to a bone across the cut", async () => {
  const { r, out } = await run();
  for (const R of REGIONS) {
    const allowed = new Set(OWN[R.id]);
    const meshes = [R.mesh, ...CAPS.filter((c) => c.region === R.id).map((c) => c.id)];
    for (const name of meshes) for (const p of out.meshes[name].prims) p.jj.forEach((j, i) => j.forEach((ji, k) => { if (p.ww[i][k] > 0) assert.ok(allowed.has(out.joints[ji]), `${name}: vertex ${i} on ${out.joints[ji]}, not on ${R.id}'s side`); }));
  }
  assert.equal(r.manifest.stats.orphan_weights, 0);
  assert.ok(r.manifest.stats.weights_rebound > 0, "the column's neck and waist vertices were re-bound");
  // the head piece carries Head weight where the source had Neck weight (re-bound, renormalised)
  const head = out.meshes.piece_head.prims[0];
  assert.ok(head.jj.every((j, i) => j.every((ji, k) => head.ww[i][k] === 0 || ["Head", "HeadTop_End"].includes(out.joints[ji]))));
});

test("caps face out of their piece, and the cut hole (hollow tube) and several loops are capped", async () => {
  const { r, out } = await run();
  const m = r.manifest;
  const centroid = (R) => { const c = [0, 0, 0]; let n = 0; for (const p of out.meshes[R.mesh].prims) for (let i = 0; i < p.positions.length; i += 3) { c[0] += p.positions[i]; c[1] += p.positions[i + 1]; c[2] += p.positions[i + 2]; n++; } return c.map((x) => x / n); };
  const planeOf = (id) => id.replace(/^cap_/, "").replace(/_(head|torso|arm|leg|root)$/, "");
  for (const c of m.caps) {
    const pl = m.planes[planeOf(c.id)];
    const cen = centroid(REGIONS.find((x) => x.id === c.region));
    const side = Math.sign(pl.normal[0] * (cen[0] - pl.point[0]) + pl.normal[1] * (cen[1] - (pl.point[1] + FLOOR)) + pl.normal[2] * (cen[2] - pl.point[2]));
    const outward = pl.normal.map((x) => -side * x);
    for (const p of out.meshes[c.id].prims) {
      for (let t = 0; t < p.indices.length; t += 3) {
        const q = (k) => Array.from(p.positions.slice(p.indices[t + k] * 3, p.indices[t + k] * 3 + 3));
        const A = q(0), B = q(1), C = q(2), u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        assert.ok(n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] > 0, `${c.id}: triangle ${t / 3} faces into its piece`);
      }
      for (const nn of p.nor) assert.ok(nn[0] * outward[0] + nn[1] * outward[1] + nn[2] * outward[2] > 0.999, c.id + " vertex normal");
    }
  }
  // the neck cap of the head piece: column 0.2 x 0.16 section (the neck plane is level here), two strands 0.02 x 0.02, the hollow tube's annulus
  const area = (id) => out.meshes[id].prims.reduce((s, p) => s + areaOf(p.positions, p.indices), 0);
  const want = 0.2 * 0.16 + 2 * 0.02 * 0.02 + (0.12 * 0.12 - 0.06 * 0.06);
  assert.ok(Math.abs(area("cap_neck_head") - want) < 1e-6, `cap_neck_head area ${area("cap_neck_head")} vs ${want}`);
  assert.ok(Math.abs(area("cap_neck_torso") - want) < 1e-6, "cap_neck_torso area");
  assert.ok(r.manifest.stats.cap_loops >= 8 && r.manifest.stats.cap_holes >= 1, `loops ${r.manifest.stats.cap_loops}, holes ${r.manifest.stats.cap_holes}`);
  assert.equal(r.manifest.stats.cap_inward_triangles, 0);
});

test("determinism: the same input gives the same bytes", async () => {
  const b = await buildBody();
  const a1 = await cut(b), a2 = await cut(b);
  assert.ok(Buffer.compare(Buffer.from(a1.glb), Buffer.from(a2.glb)) === 0, "glb bytes differ");
  assert.equal(JSON.stringify(a1.manifest), JSON.stringify(a2.manifest));
});

test("the CLI writes <body>.cut.glb and <body>.cut.manifest.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cut-units-"));
  const b = await buildBody();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "syn.glb"), b.bytes);
  writeFileSync(join(dir, "syn.measure.json"), JSON.stringify(b.row));
  const res = spawnSync(process.execPath, [new URL("../tools/cut-units.mjs", import.meta.url).pathname, join(dir, "syn.glb"), join(dir, "syn.measure.json"), new URL("../data/rig-maps/mixamo-106.json", import.meta.url).pathname, join(dir, "out"), "--body", "syn"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(join(dir, "out", "syn.cut.glb")) && existsSync(join(dir, "out", "syn.cut.manifest.json")));
  const m = JSON.parse(readFileSync(join(dir, "out", "syn.cut.manifest.json"), "utf8"));
  assert.equal(m.body, "syn"); assert.equal(m.rig, "mixamo-106"); assert.equal(m.source, "syn.glb");
  assert.match(res.stdout, /watertight true/);
});

test("a measure row that does not belong to the GLB is refused", async () => {
  const b = await buildBody();
  const row = JSON.parse(JSON.stringify(b.row));
  row.joints.Head[1] += 0.3;
  await assert.rejects(() => cutGlb(b.bytes, row, rigMap, {}), /does not match/);
});

test("ear clipping with a hole bridge covers the polygon exactly, using every vertex", () => {
  const sq = (h) => [[-h, -h], [h, -h], [h, h], [-h, h]];
  const pts = (poly, off) => poly.map(([x, y], i) => ({ x, y, i: off + i }));
  const outer = pts(sq(2), 0), hole = pts(sq(1).reverse(), 4);
  const tris = triangulateLoops(outer, [hole]);
  const P = [...outer, ...hole];
  let area = 0;
  for (let t = 0; t < tris.length; t += 3) { const a = P[tris[t]], b = P[tris[t + 1]], c = P[tris[t + 2]]; area += ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2; }
  assert.ok(Math.abs(area - (16 - 4)) < 1e-9, "area " + area);
  assert.equal(new Set(tris).size, 8, "every vertex used");
  // collinear boundary vertices are kept (a dropped vertex would leave a T-junction against the piece)
  const flat = pts([[0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [0, 1]], 0);
  const t2 = triangulateLoops(flat, []);
  assert.equal(new Set(t2).size, 6);
});

// ---------------------------------------------------------------- the real bodies (V3 rig/106-default GLBs), when present
const DIR = process.env.CUT_BODIES_DIR || "/root/bodies";
for (const name of ["minotaur-106", "psyche-106"]) {
  const file = join(DIR, name + ".glb");
  test(`${name}: cut stats, conservation, no orphan weights, caps, determinism`, { skip: existsSync(file) ? false : `${file} not on this machine` }, async () => {
    const row = JSON.parse(readFileSync(new URL(`../data/bodies/${name}.measure.json`, import.meta.url), "utf8"));
    const bytes = readFileSync(file);
    const r = await cutGlb(bytes, row, rigMap, { body: name, rig: "mixamo-106", source: name + ".glb" });
    const s = r.manifest.stats;
    console.log(name, JSON.stringify({ ...s, watertight_by_region: undefined, pieces: undefined, caps: undefined }));
    assert.equal(s.orphan_weights, 0);
    assert.deepEqual(s.caps_missing, []);
    assert.equal(r.manifest.caps.length, 12);
    const out = await readOut(r.glb);
    for (const nme of Object.keys(out.meshes)) for (const p of out.meshes[nme].prims) for (const w of p.ww) assert.ok(Math.abs(w[0] + w[1] + w[2] + w[3] - 1) < 1e-5);
    // no vertex bound across a cut: judged by bone names alone, independent of the tool's own ownership table (sockets and gear bones are skipped here;
    // the tool's orphan_weights covers them)
    const regionOfBone = (jn) => {
      const n = jn.replace("mixamorig:", ""), s = /^Left|_l(_|$)/.test(n) ? "left" : /^Right|_r(_|$)/.test(n) ? "right" : "";
      if (/^(Head|HeadTop_End|fk_hair)/.test(n)) return "head";
      if (/UpLeg|^(Left|Right)Leg$|Foot|Toe|thigh_twist|calf_twist/.test(n) && s) return "leg_" + s;
      if (/^(Left|Right)(Arm|ForeArm|Hand)|upperarm_twist|lowerarm_twist/.test(n) && s) return "arm_" + s;
      if (/^(Spine|Spine1|Spine2|Neck)$|Shoulder/.test(n)) return "upper_torso";
      if (n === "Hips") return "root";
      return null;
    };
    let checkedBones = 0;
    for (const R of REGIONS) for (const nme of [R.mesh, ...CAPS.filter((c) => c.region === R.id).map((c) => c.id)]) for (const p of out.meshes[nme].prims) p.jj.forEach((j, i) => j.forEach((ji, k) => {
      const e = p.ww[i][k] > 0 ? regionOfBone(out.joints[ji]) : null;
      if (e) { checkedBones++; assert.equal(e, R.id, `${nme} vertex ${i} is bound to ${out.joints[ji]}`); }
    }));
    assert.ok(checkedBones > 10000);
    // Caps close every cut but two known cases (docs/CUT-TOOL.md): a hairline slit in the source mesh at the neck (one open edge each side after the
    // gap is bridged), and the hair cards of Psyche's head, open surfaces that cross the neck plane.
    for (const [id, w] of Object.entries(s.watertight_by_region)) {
      const limit = id === "head" ? (name.startsWith("psyche") ? 400 : 2) : id === "upper_torso" ? 2 : 0;
      assert.ok(w.open_edges_at_cuts <= limit, `${name} ${id}: ${w.open_edges_at_cuts} open edges at the cuts (limit ${limit}), first at ${JSON.stringify(w.at_cuts)}`);
    }
    assert.equal(s.cap_inward_triangles <= 20, true, "cap triangles facing inward: " + s.cap_inward_triangles);
    const again = await cutGlb(bytes, row, rigMap, { body: name, rig: "mixamo-106", source: name + ".glb" });
    assert.ok(Buffer.compare(Buffer.from(r.glb), Buffer.from(again.glb)) === 0, "not deterministic");
  });
}
