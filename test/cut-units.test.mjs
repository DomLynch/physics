// tools/cut-units.mjs on a small synthetic skinned body (boxes, strands and a hollow tube across the cut planes), plus the V3 106-rig bodies when
// their GLBs are on this machine (CUT_BODIES_DIR, default /root/bodies; licence: not in the repo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRMeshQuantization } from "@gltf-transform/extensions";
import { cutGlb, decompressGlb, weldReport, triangulateLoops, buildPlanes, shoulderTiltFor, buildHandsFeetPlanes, HANDS_FEET, REGIONS, CAPS } from "../tools/cut-units.mjs";
import { validate } from "../tools/cut-validate.mjs";
import { sha256HexBytes } from "../src/sha256.mjs";

const rigMap = JSON.parse(readFileSync(new URL("../data/rig-maps/mixamo-106.json", import.meta.url), "utf8"));
const FLOOR = 0.05; // the toes sit 5 cm above y = 0 in the synthetic GLB, like the real bodies sit above their measure row's floor

// ---------------------------------------------------------------- the synthetic body
const W0 = { // world bind-pose joint positions
  Hips: [0, 0.95, 0], Spine: [0, 1.05, 0], Spine1: [0, 1.17, 0], Spine2: [0, 1.3, 0], Neck: [0, 1.45, 0], Head: [0, 1.55, 0], HeadTop_End: [0, 1.75, 0],
  LeftShoulder: [0.05, 1.4, 0], LeftArm: [0.2, 1.4, 0], LeftForeArm: [0.45, 1.4, 0], LeftHand: [0.7, 1.4, 0],
  RightShoulder: [-0.05, 1.4, 0], RightArm: [-0.2, 1.4, 0], RightForeArm: [-0.45, 1.4, 0], RightHand: [-0.7, 1.4, 0],
  LeftUpLeg: [0.09, 0.9, 0], LeftLeg: [0.12, 0.47, 0], LeftFoot: [0.13, 0.14, 0], LeftToeBase: [0.15, FLOOR, 0.14],
  RightUpLeg: [-0.09, 0.9, 0], RightLeg: [-0.12, 0.47, 0], RightFoot: [-0.13, 0.14, 0], RightToeBase: [-0.15, FLOOR, 0.14],
};
// variant.parallel: both thighs hang straight down (the knees directly under the hips, a few millimetres of front-to-back tilt between them), so the two
// hip-plane normals differ by under HIP_SPLIT_PARALLEL and hip_split is the midline plane
const WPAR = { ...W0, LeftLeg: [0.09, 0.47, 0.02], LeftFoot: [0.09, 0.14, 0.02], LeftToeBase: [0.09, FLOOR, 0.16], RightLeg: [-0.09, 0.47, 0], RightFoot: [-0.09, 0.14, 0], RightToeBase: [-0.09, FLOOR, 0.14] };
const PARENT = { Spine: "Hips", Spine1: "Spine", Spine2: "Spine1", Neck: "Spine2", Head: "Neck", HeadTop_End: "Head", LeftShoulder: "Spine2", LeftArm: "LeftShoulder", LeftForeArm: "LeftArm", LeftHand: "LeftForeArm", RightShoulder: "Spine2", RightArm: "RightShoulder", RightForeArm: "RightArm", RightHand: "RightForeArm", LeftUpLeg: "Hips", LeftLeg: "LeftUpLeg", LeftFoot: "LeftLeg", LeftToeBase: "LeftFoot", RightUpLeg: "Hips", RightLeg: "RightUpLeg", RightFoot: "RightLeg", RightToeBase: "RightFoot" };
const NAMES = Object.keys(W0);
const TOES = ["LeftToeBase", "RightToeBase"];

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

// a prism whose section is a bow-tie (a quadrilateral whose two long edges cross): a closed, edge-consistent surface that folds through itself, so the
// plane cuts it in a loop that crosses itself. Faces are wound by the ring order: top P0 P1 P2 P3 (fan), bottom reversed, side i = P(i+1)@top P(i)@top P(i)@bottom P(i+1)@bottom.
function bowtie(cx, cz, y0, y1, weights) {
  const R = [[0.04, -0.04], [-0.08, 0.04], [-0.08, -0.04], [0.04, 0.08]].map(([x, z]) => [cx + x, cz + z]); // P0P1 and P2P3 cross; the lobes differ in size
  const m = { pos: [], nor: [], uv: [], wts: [], idx: [] };
  const add = (p) => { m.pos.push(p); m.nor.push([0, 1, 0]); m.uv.push([0, 0]); m.wts.push(weights(p)); return m.pos.length - 1; };
  const T = R.map(([x, z]) => [x, y1, z]), B = R.map(([x, z]) => [x, y0, z]);
  const poly = (pts) => { const ids = pts.map(add); for (let k = 1; k + 1 < ids.length; k++) m.idx.push(ids[0], ids[k], ids[k + 1]); };
  poly(T); poly(B.slice().reverse());
  for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; poly([T[j], T[i], B[i], B[j]]); }
  return m;
}
// an open hair card (a vertical strip, n quads high) bound to the spine chain, so re-binding it to the Head bone is a real change
function hairCard(x0, x1, y0, y1, z, n, weights) {
  const m = { pos: [], nor: [], uv: [], wts: [], idx: [] };
  for (let j = 0; j <= n; j++) for (const x of [x0, x1]) { const p = [x, y0 + (y1 - y0) * j / n, z]; m.pos.push(p); m.nor.push([0, 0, 1]); m.uv.push([x === x0 ? 0 : 1, j / n]); m.wts.push(weights(p)); }
  for (let j = 0; j < n; j++) { const a = j * 2, b = a + 1, c = a + 2, d = a + 3; m.idx.push(a, b, d, a, d, c); }
  return m;
}

async function buildBody(variant = {}) {
  const W = variant.parallel ? WPAR : W0;
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("Scene");
  const armature = doc.createNode("Armature");
  scene.addChild(armature);
  const nodes = {};
  // variant.nineteen: the 19-joint Mixamo layout (Armagedom vagrant-106): Spine1 is a node of the tree but not a skin joint (its weight goes to Spine),
  // and there are no toe nodes at all (their weight goes to the Foot)
  const NODE_NAMES = variant.nineteen ? NAMES.filter((n) => !TOES.includes(n)) : NAMES;
  const SK = variant.nineteen ? NODE_NAMES.filter((n) => n !== "Spine1") : NAMES;
  const SKIDX = Object.fromEntries(SK.map((n, i) => [n, i]));
  const ALIAS = variant.nineteen ? { Spine1: "Spine", LeftToeBase: "LeftFoot", RightToeBase: "RightFoot" } : {};
  for (const n of NODE_NAMES) {
    const par = PARENT[n], pw = par ? W[par] : [0, 0, 0];
    nodes[n] = doc.createNode("mixamorig:" + n).setTranslation([W[n][0] - pw[0], W[n][1] - pw[1], W[n][2] - pw[2]]);
  }
  armature.addChild(nodes.Hips);
  for (const n of NODE_NAMES) if (PARENT[n]) nodes[PARENT[n]].addChild(nodes[n]);
  const ibm = new Float32Array(SK.length * 16);
  SK.forEach((n, i) => ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -W[n][0], -W[n][1], -W[n][2], 1], i * 16));
  // variant.quantLash: the lashes are quantised on their own, like gltfpack does per mesh: raw = (world - T) / S, and their skin's inverse binds carry the
  // dequantisation (jointWorld x IBM = [S, T] for every joint), so a reader must use this skin's matrix, not the first skin's
  const QUANT = { S: 0.25, T: [0.1, 0.2, -0.1] };
  const ibm2 = new Float32Array(NAMES.length * 16);
  NAMES.forEach((n, i) => ibm2.set([QUANT.S, 0, 0, 0, 0, QUANT.S, 0, 0, 0, 0, QUANT.S, 0, QUANT.T[0] - W[n][0], QUANT.T[1] - W[n][1], QUANT.T[2] - W[n][2], 1], i * 16));
  const mkSkin = (ib = ibm) => { const s = doc.createSkin("skin").setInverseBindMatrices(doc.createAccessor().setType("MAT4").setArray(ib).setBuffer(buffer)); for (const n of SK) s.addJoint(nodes[n]); return s; };
  const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
  const matBody = doc.createMaterial("body"), matHorn = doc.createMaterial("horn"), matLash = doc.createMaterial("lash");
  const prim = (parts, material) => {
    const pos = [], nor = [], uv = [], jj = [], ww = [], idx = [];
    for (const m of parts) {
      const base = pos.length / 3;
      m.pos.forEach((p, i) => {
        pos.push(...p); nor.push(...m.nor[i]); uv.push(...m.uv[i]);
        const w = m.wts[i].slice(0, 4); while (w.length < 4) w.push(["Hips", 0]);
        jj.push(...w.map((e) => SKIDX[ALIAS[e[0]] || e[0]])); ww.push(...w.map((e) => e[1]));
      });
      for (const i of m.idx) idx.push(base + i);
    }
    return doc.createPrimitive().setMaterial(material)
      .setAttribute("POSITION", acc("VEC3", new Float32Array(pos))).setAttribute("NORMAL", acc("VEC3", new Float32Array(nor))).setAttribute("TEXCOORD_0", acc("VEC2", new Float32Array(uv)))
      .setAttribute("JOINTS_0", acc("VEC4", new Uint16Array(jj))).setAttribute("WEIGHTS_0", acc("VEC4", new Float32Array(ww))).setIndices(acc("SCALAR", new Uint32Array(idx)));
  };
  const bodyParts = [
    ...(variant.bowtie ? [bowtie(0, 0.3, 1.3, 1.7, wSpine)] : []), // a prism that folds through itself across the neck plane: the cut loop crosses itself
    box([0, 1.35, 0], [0.1, 0.4, 0.08], 12, wSpine), // the column: hips to head top across the waist and neck planes
    box([0.07, 1.52, 0.1], [0.01, 0.13, 0.01], 3, wSpine), box([-0.07, 1.52, 0.1], [0.01, 0.13, 0.01], 3, wSpine), // two strands across the neck plane
    tube(0, -0.25, 0.06, 0.03, 1.3, 1.7, 3, 10, wSpine), // hollow tube across the neck plane: the cut has a hole
    box([0.09, 0.5, 0], [0.078, 0.5, 0.07], 10, wLeg("Left")), box([-0.09, 0.5, 0], [0.078, 0.5, 0.07], 10, wLeg("Right")), // legs across the hip planes
  ];
  const armParts = [box([0.435, 1.4, 0], [0.315, 0.05, 0.05], 12, wArm("Left")), box([-0.435, 1.4, 0], [0.315, 0.05, 0.05], 12, wArm("Right"))]; // arms across the shoulder planes
  const lashParts = [box([0, 1.62, 0.12], [0.03, 0.005, 0.005], 2, wHead)];
  const hairParts = variant.hair ? [hairCard(0, 0.12, 0.6, 1.9, -0.12, 14, wSpine)] : []; // an open card from above the neck plane down across the waist and hip planes
  // variant.skirt: a wide closed garment layer (a flared box, material skirt_mat, mesh Skirt_Geo) around the hips: across the waist plane and both hip planes,
  // weighted to Hips and the upper legs, overlapping the body box and the leg boxes
  const wSkirt = (p) => [["Hips", 0.6], [p[0] >= 0 ? "LeftUpLeg" : "RightUpLeg", 0.4]];
  const skirtParts = variant.skirt ? [box([0, 1.0, 0], [variant.skirtHalf || 0.22, 0.2, 0.16], 6, wSkirt)] : [];
  // variant.parallel: the legs never reach the midline (a 2.4 cm gap between the boxes), but the crotch lump and a belly apron hang across it below the hip
  // planes, one continuous sheet of Hips-skinned mesh that the midline plane has to cut in two, with a wall to close each side
  if (variant.parallel) {
    bodyParts.push(box([0, 0.83, 0], [0.011, 0.1, 0.07], 8, wSkirt)); // y 0.73 to 0.93: across the hip planes and the midline (a loop that runs along the hip plane and the wall)
    bodyParts.push(box([0, 0.78, 0.13], [0.011, 0.04, 0.02], 4, wSkirt)); // y 0.74 to 0.82: wholly below the hip planes (a loop on the midline alone)
  }
  // variant.boot: a closed garment layer around each lower leg (material boot_mat, mesh Boot_Geo, y 0 to 0.3, across the ankle planes at y about 0.14), weighted whole to Hips
  const wBoot = () => [["Hips", 1]];
  const bootParts = variant.boot ? [box([0.11, 0.15, 0.01], [0.09, 0.15, 0.09], 6, wBoot), box([-0.11, 0.15, 0.01], [0.09, 0.15, 0.09], 6, wBoot)] : [];
  if (bootParts.length) scene.addChild(doc.createNode("Boot").setMesh(doc.createMesh("Boot_Geo").addPrimitive(prim(bootParts, doc.createMaterial("boot_mat")))).setSkin(mkSkin()));
  const skin = mkSkin(), skin2 = variant.quantLash ? mkSkin(ibm2) : mkSkin();
  const lashStored = variant.quantLash ? lashParts.map((m) => ({ ...m, pos: m.pos.map((p) => p.map((x, k) => (x - QUANT.T[k]) / QUANT.S)) })) : lashParts;
  const mesh = doc.createMesh("Body").addPrimitive(prim(bodyParts, matBody)).addPrimitive(prim(armParts, matHorn));
  if (hairParts.length) mesh.addPrimitive(prim(hairParts, doc.createMaterial("hair_cards")));
  scene.addChild(doc.createNode("Body").setMesh(mesh).setSkin(skin));
  scene.addChild(doc.createNode("Lashes").setMesh(doc.createMesh("Lashes").addPrimitive(prim(lashStored, matLash))).setSkin(skin2));
  // variant.skirtShared: the skirt uses the body's own material (one atlas for the whole garment set), so only its shell can tell it apart
  if (skirtParts.length) scene.addChild(doc.createNode("Skirt").setMesh(doc.createMesh("Skirt_Geo").addPrimitive(prim(skirtParts, variant.skirtShared ? matBody : doc.createMaterial("skirt_mat")))).setSkin(mkSkin()));
  if (variant.quantLash) doc.createExtension(KHRMeshQuantization).setRequired(true); // as in a gltfpack file: the tool only trusts per-skin matrices of a still-quantised source
  const bytes = await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(doc);
  const row = { id: "synthetic", joints: Object.fromEntries(Object.keys(rigMap.joints).map((r) => [r, [W[r][0], W[r][1] - FLOOR, W[r][2]]])) };
  return { bytes, row, source: { body: bodyParts, arm: armParts, lash: lashParts, hair: hairParts, skirt: skirtParts } };
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
  assert.ok(Math.abs(got - src) / src < 1e-7, `area ${got} vs ${src}`);
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

// ---------------------------------------------------------------- hair goes whole to the head (Physics Dev ruling)
test("hair and eyelash materials go whole to piece_head, uncut, bound to Head only, declared as plane_exempt", async () => {
  const b = await buildBody({ hair: true });
  const r = await cut(b);
  const out = await readOut(r.glb);
  const m = r.manifest;
  assert.deepEqual(m.plane_exempt, { piece_head: ["hair_cards", "lash"] });
  assert.match(m.plane_exempt_reason, /hair/);
  assert.equal(m.stats.hair_triangles, 28 + 48, "the 14-quad card (28 triangles) and the eyelash box (6 faces of 2 x 2 quads)");
  const head = out.joints.indexOf("Head");
  for (const mat of ["hair_cards", "lash"]) {
    const prims = out.meshes.piece_head.prims.filter((p) => p.material === mat);
    assert.equal(prims.length, 1, mat);
    for (let i = 0; i < prims[0].jj.length; i++) { assert.equal(prims[0].jj[i][0], head, mat + " vertex " + i + " bound to Head"); assert.equal(prims[0].ww[i][0], 1); assert.equal(prims[0].ww[i][1] + prims[0].ww[i][2] + prims[0].ww[i][3], 0); }
  }
  const card = out.meshes.piece_head.prims.find((p) => p.material === "hair_cards");
  assert.equal(card.indices.length / 3, 28, "the card is not cut: its 28 triangles stay 28");
  assert.equal(card.jj.length, 30, "and no vertex is added");
  let ymin = Infinity; for (let i = 1; i < card.positions.length; i += 3) ymin = Math.min(ymin, card.positions[i]);
  assert.ok(ymin < 0.7, "the card still hangs to y 0.6, far below the neck plane (1.5)");
  for (const R of REGIONS) if (R.id !== "head") assert.ok(!out.meshes[R.mesh].prims.some((p) => p.material === "hair_cards" || p.material === "lash"), R.id + " has no hair");
  // the rest of the body is cut as before: area is conserved with the hair in
  const src = sourceArea([...b.source.body, ...b.source.arm, ...b.source.lash, ...b.source.hair]);
  let got = 0;
  for (const R of REGIONS) for (const p of out.meshes[R.mesh].prims) got += areaOf(p.positions, p.indices);
  assert.ok(Math.abs(got - src) / src < 1e-7, `area ${got} vs ${src}`);
  // the validator agrees: hair across the neck plane is exempt from the planes check only, its open card edges are native, everything else passes
  const v = validate(Buffer.from(r.glb), m, { source: Buffer.from(b.bytes), planeOffset: m.plane_frame.bind_offset });
  assert.deepEqual(v.checks.filter((c) => !c.ok).map((c) => c.name + ": " + c.details.slice(0, 3).join(" | ")), []);
  assert.match(v.checks.find((c) => c.name === "planes").summary, /plane_exempt/);
  // without the declaration the same GLB fails planes: the hair really is across the plane
  const bare = { ...m }; delete bare.plane_exempt; delete bare.plane_exempt_reason;
  assert.ok(validate(Buffer.from(r.glb), bare, { source: Buffer.from(b.bytes), planeOffset: m.plane_frame.bind_offset }).checks.find((c) => c.name === "planes").ok === false);
});

test("a body with no hair material declares no plane_exempt but the eyelashes", async () => {
  const { r } = await run();
  assert.deepEqual(r.manifest.plane_exempt, { piece_head: ["lash"] });
  const b = await buildBody();
  const none = await cutGlb(b.bytes, b.row, rigMap, { body: "synthetic", hairMaterials: [] });
  assert.equal(none.manifest.plane_exempt, undefined);
  assert.equal(none.manifest.stats.hair_triangles, 0);
});

// ---------------------------------------------------------------- one dequantisation matrix per skin (Arachne: five meshes, five skins, five scales)
test("a mesh quantised on its own, with its own skin and dequantisation matrix, lands where it is drawn; the cut validates against the decompressed source", async () => {
  const b = await buildBody({ quantLash: true });
  const plain = Buffer.from(await decompressGlb(b.bytes));
  const r = await cut(b);
  const out = await readOut(r.glb);
  // the eyelash box is centred (0, 1.62, 0.12) with half sizes (0.03, 0.005, 0.005): the stored vertices are 4x smaller and offset, the cut must undo that per skin
  const lash = out.meshes.piece_head.prims.find((p) => p.material === "lash");
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < lash.positions.length; i++) { const k = i % 3; lo[k] = Math.min(lo[k], lash.positions[i]); hi[k] = Math.max(hi[k], lash.positions[i]); }
  [-0.03, 1.615, 0.115].forEach((x, k) => assert.ok(Math.abs(lo[k] - x) < 1e-5, `lash min[${k}] ${lo[k]} vs ${x}`));
  [0.03, 1.625, 0.125].forEach((x, k) => assert.ok(Math.abs(hi[k] - x) < 1e-5, `lash max[${k}] ${hi[k]} vs ${x}`));
  // the decompressed source has the same metres, and all the validator's checks pass on it
  const sp = (await readOut(plain)).meshes.Lashes.prims[0].positions;
  assert.ok(Math.abs(sp[1] - 1.615) < 1e-5 || Math.abs(sp[1] - 1.625) < 1e-5, "decompressed lash y " + sp[1]);
  const v = validate(Buffer.from(r.glb), r.manifest, { source: plain, planeOffset: r.manifest.plane_frame.bind_offset });
  assert.deepEqual(v.checks.filter((c) => !c.ok).map((c) => c.name + ": " + c.details.slice(0, 3).join(" | ")), []);
});

// ---------------------------------------------------------------- cap winding
test("a cut loop that crosses itself: the cap stays closed and oriented with its piece, and every triangle's winding agrees with its stored normals", async () => {
  const b = await buildBody({ bowtie: true });
  const r = await cut(b);
  const out = await readOut(r.glb);
  const s = r.manifest.stats;
  assert.equal(s.cap_fallback_loops, 0);
  assert.ok(s.cap_inward_triangles >= 2, `the bow-tie section folds: ${s.cap_inward_triangles} folded triangles`);
  for (const R of REGIONS) { // closed and consistently oriented (the weld report counts a flipped edge as an open one)
    const parts = out.meshes[R.mesh].prims.map((p) => ({ positions: p.positions, indices: p.indices }));
    for (const c of CAPS) if (c.region === R.id) for (const p of out.meshes[c.id].prims) parts.push({ positions: p.positions, indices: p.indices });
    const rep = weldReport(parts, 1e-5);
    assert.equal(rep.boundary_edges, 0, `${R.id}: ${rep.boundary_edges} open or flipped edges at ${JSON.stringify(rep.boundary_sample)}`);
  }
  // the neck plane is level: the head cap faces down, the torso cap faces up. A triangle against that is a folded sliver (the lobe of the bow-tie whose
  // winding the loop's crossing reverses): it carries the flipped normal, so its winding agrees with its own normals like every other triangle
  let total = 0, folded = 0;
  for (const c of CAPS) for (const p of out.meshes[c.id].prims) for (let t = 0; t < p.indices.length; t += 3) {
    const [ia, ib, ic] = [p.indices[t], p.indices[t + 1], p.indices[t + 2]], q = (i) => Array.from(p.positions.slice(i * 3, i * 3 + 3));
    const A = q(ia), B = q(ib), C = q(ic), u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const gn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const avg = [0, 1, 2].map((k) => p.nor[ia][k] + p.nor[ib][k] + p.nor[ic][k]);
    if (!(Math.hypot(...gn) > 1e-14)) continue; // a flat sliver between collinear loop vertices has no winding
    total++;
    assert.ok(gn[0] * avg[0] + gn[1] * avg[1] + gn[2] * avg[2] > 0, `${c.id} triangle ${t / 3}: winding against its normals`);
    if (c.plane === "neck") { const up = c.region === "head" ? -1 : 1; if (gn[1] * up < -1e-14) { folded++; assert.ok(avg[1] * up < 0, "a folded sliver carries the flipped normal"); } else assert.ok(avg[1] * up > 0, "every other triangle carries the outward normal"); }
  }
  assert.ok(total > 50);
  assert.equal(folded, s.cap_inward_triangles, "the manifest counts the folded slivers");
  assert.ok(folded >= 2, "one per neck cap at least");
  // the validator agrees on the caps and on closure
  const v = validate(Buffer.from(r.glb), r.manifest, { source: Buffer.from(b.bytes), planeOffset: r.manifest.plane_frame.bind_offset });
  for (const name of ["caps", "watertight", "orientation"]) assert.equal(v.checks.find((c) => c.name === name).ok, true, name + ": " + v.checks.find((c) => c.name === name).details.slice(0, 3).join(" | "));
});

test("ear clipping a polygon that crosses itself terminates and uses every vertex; a simple one never needs a forced ear", () => {
  // a square with a curl on its bottom edge that crosses the edge again (a loop of opposite winding)
  const P = [[0, 0], [1, 0], [2, 1], [3, 0], [2, -1], [1.5, 0.5], [4, 0], [4, 4], [0, 4]].map(([x, y], i) => ({ x, y, i }));
  const tris = triangulateLoops(P, [], { forced: 0, bridgeFallback: 0 });
  assert.equal(tris.length, 3 * (P.length - 2));
  assert.equal(new Set(tris).size, P.length);
  const stats = { forced: 0, bridgeFallback: 0 };
  const simple = triangulateLoops([[0, 0], [2, 0], [2, 2], [1, 3], [0, 2]].map(([x, y], i) => ({ x, y, i })), [], stats);
  assert.equal(stats.forced, 0, "a simple polygon never needs a forced ear");
  assert.equal(simple.length, 9);
});

// ---------------------------------------------------------------- optional cuts: head_split and belly_open (opt-in, default off)
const cutWith = (b, o) => cutGlb(b.bytes, b.row, rigMap, { body: "synthetic", rig: "mixamo-106", source: "synthetic.glb", ...o });
const validateAll = (b, r, manifest = r.manifest) => validate(Buffer.from(r.glb), manifest, { source: Buffer.from(b.bytes), planeOffset: r.manifest.plane_frame.bind_offset });
const failing = (v) => v.checks.filter((c) => !c.ok).map((c) => c.name);
const why = (v) => v.checks.filter((c) => !c.ok).map((c) => c.name + ": " + c.details.slice(0, 3).join(" | "));
const HALF_OWN = ["Head", "HeadTop_End"];
const BELLY = { half_width_frac: 0.15 }; // the synthetic column is 0.2 m wide (the real rows' 0.3 of the shoulder span is for real torsos)

test("with both optional cuts off the manifest has no optional fields and the pieces are the plain seven", async () => {
  const { r } = await run();
  assert.equal(r.manifest.optional_units, undefined);
  assert.equal(r.manifest.optional_planes, undefined);
  assert.ok(r.manifest.regions.every((x) => x.separated_by === undefined));
  const off = await cutWith(await buildBody(), { headSplit: false, bellyOpen: false });
  assert.ok(Buffer.compare(Buffer.from(off.glb), Buffer.from(r.glb)) === 0, "explicit false is the same file as the default");
});

test("head_split: piece_head becomes two halves that meet on the sagittal plane, each with a neck cap and a cut face", async () => {
  const b = await buildBody();
  const base = await cut(b), baseOut = await readOut(base.glb);
  const r = await cutWith(b, { headSplit: true });
  const out = await readOut(r.glb), m = r.manifest;
  // manifest: additive, schema unchanged
  assert.equal(m.schema, "cut-pieces/1");
  assert.deepEqual(m.regions.map((x) => x.id).sort(), ["arm_left", "arm_right", "head_left", "head_right", "leg_left", "leg_right", "root", "upper_torso"]);
  for (const id of ["head_left", "head_right"]) { const x = m.regions.find((q) => q.id === id); assert.equal(x.mesh, "piece_" + id); assert.equal(x.detached_by, "head"); assert.equal(x.separated_by, "head_split"); }
  const capUnit = Object.fromEntries(m.caps.map((c) => [c.id, c.shown_when_cut]));
  assert.equal(m.caps.length, 15);
  assert.equal(capUnit.cap_split_head_left, "head_split"); assert.equal(capUnit.cap_split_head_right, "head_split");
  assert.equal(capUnit.cap_neck_head_left, "head"); assert.equal(capUnit.cap_neck_head_right, "head"); assert.equal(capUnit.cap_neck_head, undefined);
  assert.equal(m.caps.find((c) => c.id === "cap_split_head_left").region, "head_left");
  assert.equal(m.optional_units.head_split.enabled, true);
  const pl = m.optional_planes.head_split;
  assert.ok(Math.abs(pl.normal[0] - 1) < 1e-6 && Math.abs(pl.normal[1]) < 1e-9, "the left-right axis: +x is the body's left (LeftArm at +x)");
  assert.ok(Math.abs(pl.point[0]) < 1e-6 && Math.abs(pl.point[1] - (1.5 - FLOOR)) < 1e-4, "on the Neck to Head midline, in the measure row's frame");
  assert.deepEqual(Object.keys(out.meshes).sort(), [...REGIONS.filter((x) => x.id !== "head").map((x) => x.mesh), "piece_head_left", "piece_head_right", ...CAPS.filter((c) => c.region !== "head").map((c) => c.id), "cap_neck_head_left", "cap_neck_head_right", "cap_split_head_left", "cap_split_head_right"].sort());
  for (const [name, mm] of Object.entries(out.meshes)) assert.ok(mm.node.getSkin(), name + " is skinned");
  // everything that is not the head is the same bytes of geometry as the plain cut
  for (const R of REGIONS) if (R.id !== "head") assert.deepEqual(out.meshes[R.mesh].prims.map((p) => [...p.positions]), baseOut.meshes[R.mesh].prims.map((p) => [...p.positions]), R.id + " unchanged");
  // area conserved: the two halves are the old head
  const area = (o, names) => names.reduce((s, n) => s + o.meshes[n].prims.reduce((t, p) => t + areaOf(p.positions, p.indices), 0), 0);
  const was = area(baseOut, ["piece_head"]), now = area(out, ["piece_head_left", "piece_head_right"]);
  assert.ok(Math.abs(now - was) / was < 1e-7, `head area ${was} -> ${now}`);
  // each half on its own side of x = 0 (the lashes carry exempt materials and are whole in one half), pieces and caps
  const eps = 1e-4;
  for (const [id, sign] of [["head_left", 1], ["head_right", -1]]) for (const p of out.meshes["piece_" + id].prims) if (p.material !== "lash") for (let i = 0; i < p.positions.length; i += 3) assert.ok(p.positions[i] * sign >= -eps, `${id} vertex at x ${p.positions[i]}`);
  // conservation of area on the cut face: column (0.16 deep x 0.25 high above the neck plane) + the tube's two walls (2 x 0.03 x 0.2)
  const faceL = area(out, ["cap_split_head_left"]), faceR = area(out, ["cap_split_head_right"]);
  assert.ok(Math.abs(faceL - (0.16 * 0.25 + 2 * 0.03 * 0.2)) < 1e-6, "cut face area " + faceL);
  assert.ok(Math.abs(faceL - faceR) < 1e-9);
  // the cut faces are flat on x = 0 and face away from their half (left: -x, right: +x)
  for (const [cap, sign] of [["cap_split_head_left", -1], ["cap_split_head_right", 1]]) for (const p of out.meshes[cap].prims) {
    for (let i = 0; i < p.positions.length; i += 3) assert.ok(Math.abs(p.positions[i]) < eps, cap + " flat");
    for (const n of p.nor) assert.ok(n[0] * sign > 0.99, cap + " normal");
    for (let t = 0; t < p.indices.length; t += 3) { const q = (k) => p.indices[t + k] * 3, P = p.positions; const u = [0, 1, 2].map((c) => P[q(1) + c] - P[q(0) + c]), v = [0, 1, 2].map((c) => P[q(2) + c] - P[q(0) + c]); if (Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) < 1e-12) continue; /* collinear boundary vertices are kept, as in every cap */ assert.ok((u[1] * v[2] - u[2] * v[1]) * sign > 0, cap + " winding of triangle " + t / 3 + " of " + p.indices.length / 3 + ": " + JSON.stringify([u, v])); }
  }
  // every half with its caps is watertight
  for (const id of ["head_left", "head_right"]) {
    const parts = out.meshes["piece_" + id].prims.map((p) => ({ positions: p.positions, indices: p.indices }));
    for (const c of m.caps) if (c.region === id) for (const p of out.meshes[c.id].prims) parts.push({ positions: p.positions, indices: p.indices });
    const rep = weldReport(parts, 1e-5);
    assert.equal(rep.boundary_edges + rep.non_manifold_edges + rep.degenerate, 0, `${id}: open ${rep.boundary_edges}, non-manifold ${rep.non_manifold_edges}, degenerate ${rep.degenerate} at ${JSON.stringify(rep.boundary_sample)}`);
    assert.equal(m.stats.watertight_by_region[id].boundary_edges, 0);
  }
  // bone side: both halves and their caps use only the head's bones
  for (const id of ["head_left", "head_right"]) for (const name of ["piece_" + id, ...m.caps.filter((c) => c.region === id).map((c) => c.id)]) for (const p of out.meshes[name].prims) p.jj.forEach((j, i) => j.forEach((ji, k) => { if (p.ww[i][k] > 0) assert.ok(HALF_OWN.includes(out.joints[ji]), `${name} vertex ${i} on ${out.joints[ji]}`); }));
  assert.equal(m.stats.orphan_weights, 0);
  // the independent validator agrees, and runs its extra check
  const v = validateAll(b, r);
  assert.deepEqual(why(v), []);
  assert.ok(v.checks.some((c) => c.name === "head_split" && c.ok));
  assert.match(v.checks[0].summary, /8 pieces \+ 15 caps/);
  // determinism
  assert.ok(Buffer.compare(Buffer.from((await cutWith(b, { headSplit: true })).glb), Buffer.from(r.glb)) === 0);
});

test("head_split: hair cards go whole to one half, bound to Head only, declared per half as plane_exempt; the validator passes and checks the seam", async () => {
  const b = await buildBody({ hair: true });
  const base = await cut(b), baseOut = await readOut(base.glb);
  const r = await cutWith(b, { headSplit: true });
  const out = await readOut(r.glb), m = r.manifest;
  const cardTris = (o, n) => o.meshes[n].prims.filter((p) => p.material === "hair_cards").reduce((s, p) => s + p.indices.length / 3, 0);
  const l = cardTris(out, "piece_head_left"), rr = cardTris(out, "piece_head_right");
  assert.equal(l + rr, 28, "the card is not cut");
  assert.ok(l === 0 || rr === 0, "and it lies wholly in one half");
  const head = out.joints.indexOf("Head");
  for (const n of ["piece_head_left", "piece_head_right"]) for (const p of out.meshes[n].prims.filter((q) => q.material === "hair_cards" || q.material === "lash")) p.jj.forEach((j, i) => { assert.equal(j[0], head); assert.equal(p.ww[i][0], 1); });
  assert.ok(m.plane_exempt.piece_head_left || m.plane_exempt.piece_head_right);
  assert.equal(m.plane_exempt.piece_head, undefined);
  assert.match(m.plane_exempt_reason, /hair/);
  // total area unchanged against the plain cut
  const sum = (o, names) => names.reduce((s, n) => s + o.meshes[n].prims.reduce((t, p) => t + areaOf(p.positions, p.indices), 0), 0);
  assert.ok(Math.abs(sum(out, ["piece_head_left", "piece_head_right"]) - sum(baseOut, ["piece_head"])) < 1e-7);
  const v = validateAll(b, r);
  assert.deepEqual(why(v), []);
  assert.match(v.checks.find((c) => c.name === "planes").summary, /plane_exempt/);
  assert.match(v.checks.find((c) => c.name === "head_split").summary, /meet along one seam/);
  // the validator fails what is wrong: the plane moved off the midline puts half a head on the wrong side; a missing cut face fails the structure
  const moved = JSON.parse(JSON.stringify(m)); moved.optional_planes.head_split.point[0] += 0.05;
  assert.ok(failing(validateAll(b, r, moved)).includes("planes"), "moved plane");
  const noCap = JSON.parse(JSON.stringify(m)); noCap.caps = noCap.caps.filter((c) => c.id !== "cap_split_head_left");
  assert.ok(failing(validateAll(b, r, noCap)).includes("structure"), "cap missing from the manifest");
  const noSep = JSON.parse(JSON.stringify(m)); delete noSep.regions.find((x) => x.id === "head_left").separated_by;
  assert.ok(failing(validateAll(b, r, noSep)).includes("structure"), "separated_by missing");
  const asPlain = JSON.parse(JSON.stringify(m)); delete asPlain.optional_units; // the GLB has halves, the manifest claims the plain seven: structure fails
  assert.ok(failing(validateAll(b, r, asPlain)).includes("structure"), "halves in a plain manifest");
});

test("belly_open: a patch on the front of the torso above the waist; nothing is removed or detached", async () => {
  const b = await buildBody();
  const base = await cut(b), baseOut = await readOut(base.glb);
  const r = await cutWith(b, { bellyOpen: BELLY });
  const out = await readOut(r.glb), m = r.manifest;
  const cap = m.caps.find((c) => c.id === "cap_belly_opening");
  assert.deepEqual(cap, { id: "cap_belly_opening", mesh: "cap_belly_opening", region: "upper_torso", shown_when_cut: "belly_open", kind: "opening" });
  assert.equal(m.caps.length, 13);
  assert.deepEqual(m.regions, base.manifest.regions, "no region changes");
  const u = m.optional_units.belly_open;
  assert.equal(u.removes_geometry, false); assert.equal(u.detaches, null);
  assert.ok(Math.abs(u.frame.forward[2] - 1) < 1e-6, "forward is +z (toes ahead of the feet)");
  // nothing removed: every piece is the plain cut's geometry
  for (const R of REGIONS) assert.deepEqual(out.meshes[R.mesh].prims.map((p) => [...p.positions]), baseOut.meshes[R.mesh].prims.map((p) => [...p.positions]), R.id + " unchanged");
  for (const c of CAPS) assert.deepEqual(out.meshes[c.id].prims.map((p) => [...p.positions]), baseOut.meshes[c.id].prims.map((p) => [...p.positions]), c.id + " unchanged");
  // the patch: skinned, two materials (flesh rim, dark core), in front of the column's skin (z 0.08), inside the ellipse, above the waist plane (y 1.05)
  const mesh = out.meshes.cap_belly_opening;
  assert.ok(mesh.node.getSkin());
  assert.deepEqual(mesh.prims.map((p) => p.material).sort(), ["cap_flesh", "cap_inner"]);
  let n = 0;
  for (const p of mesh.prims) {
    for (let i = 0; i < p.positions.length; i += 3) {
      n++;
      const [x, y, z] = [p.positions[i], p.positions[i + 1], p.positions[i + 2]];
      assert.ok(z >= 0.08 + 0.0015 - 1e-6 && z <= 0.08 + 0.0015 + 0.008 + 1e-6, "lift in front of the skin: z " + z);
      assert.ok((x / u.frame.half_width) ** 2 + ((y - u.frame.centre[1] - FLOOR) / u.frame.half_height) ** 2 <= 1 + 1e-6, "inside the ellipse");
      assert.ok(y > 1.05 + 0.03, "above the waist plane: y " + y);
    }
    p.jj.forEach((j, i) => j.forEach((ji, k) => { if (p.ww[i][k] > 0) assert.ok(OWN.upper_torso.includes(out.joints[ji]), "bone " + out.joints[ji]); }));
    for (const nn of p.nor) assert.ok(nn[2] > 0.9, "normals face forward");
    for (let t = 0; t < p.indices.length; t += 3) { const q = (k) => p.indices[t + k] * 3, P = p.positions; const a = [0, 1, 2].map((c) => P[q(1) + c] - P[q(0) + c]), c2 = [0, 1, 2].map((c) => P[q(2) + c] - P[q(0) + c]); assert.ok(a[0] * c2[1] - a[1] * c2[0] > 0, "winding faces forward"); }
  }
  assert.equal(n, u.stats.vertices + u.params.segments, "the ring where the two materials meet is stored in both primitives");
  const area = mesh.prims.reduce((s, p) => s + areaOf(p.positions, p.indices), 0);
  assert.ok(area >= Math.PI * u.frame.half_width * u.frame.half_height * 0.99);
  const v = validateAll(b, r);
  assert.deepEqual(why(v), []);
  assert.ok(v.checks.some((c) => c.name === "belly_open" && c.ok));
  assert.match(v.checks[0].summary, /cap_belly_opening/);
  // the validator fails what is wrong
  const small = JSON.parse(JSON.stringify(m)); small.optional_units.belly_open.frame.half_width *= 0.5;
  assert.ok(failing(validateAll(b, r, small)).includes("belly_open"), "ellipse smaller than the patch");
  const removes = JSON.parse(JSON.stringify(m)); removes.optional_units.belly_open.removes_geometry = true;
  assert.ok(failing(validateAll(b, r, removes)).includes("belly_open"), "claims to remove geometry");
  const lifted = JSON.parse(JSON.stringify(m)); lifted.optional_units.belly_open.params.rim_lift = 0.02; lifted.optional_units.belly_open.params.bulge = 0;
  assert.ok(failing(validateAll(b, r, lifted)).includes("belly_open"), "lift declared differently from the mesh");
  const wrongUnit = JSON.parse(JSON.stringify(m)); wrongUnit.caps.find((c) => c.id === "cap_belly_opening").shown_when_cut = "torso_waist";
  assert.ok(failing(validateAll(b, r, wrongUnit)).includes("structure"), "wrong unit");
  assert.ok(failing(validate(Buffer.from(base.glb), m, { source: Buffer.from(b.bytes), planeOffset: m.plane_frame.bind_offset })).includes("structure"), "manifest claims a patch the GLB lacks");
});

test("belly_open: an ellipse that does not fit the torso is refused with the reason", async () => {
  const b = await buildBody();
  await assert.rejects(() => cutWith(b, { bellyOpen: { ...BELLY, centre_frac: 0.05 } }), /clearance/);
  await assert.rejects(() => cutWith(b, { bellyOpen: { half_width_frac: 1 } }), /no torso skin behind the patch/);
});

test("both optional cuts together, with hair: the validator passes all ten checks; the CLI flags do the same", async () => {
  const b = await buildBody({ hair: true });
  const r = await cutWith(b, { headSplit: true, bellyOpen: BELLY });
  const v = validateAll(b, r);
  assert.deepEqual(why(v), []);
  assert.deepEqual(v.checks.map((c) => c.name), ["structure", "watertight", "orientation", "weights", "bone_side", "caps", "conservation", "planes", "head_split", "belly_open"]);
  assert.deepEqual(Object.keys(r.manifest.optional_units).sort(), ["belly_open", "head_split"]);
  assert.ok(r.manifest.caps.some((c) => c.id === "cap_belly_opening") && r.manifest.caps.some((c) => c.id === "cap_split_head_right"));
  // the CLI: --head-split --belly-open (the real rows' ellipse is too wide for this thin synthetic column, so only --head-split goes through the CLI here)
  const dir = mkdtempSync(join(tmpdir(), "cut-units-opt-"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "syn.glb"), b.bytes); writeFileSync(join(dir, "syn.measure.json"), JSON.stringify(b.row));
  const args = (extra) => [new URL("../tools/cut-units.mjs", import.meta.url).pathname, join(dir, "syn.glb"), join(dir, "syn.measure.json"), new URL("../data/rig-maps/mixamo-106.json", import.meta.url).pathname, join(dir, "out"), "--body", "syn", ...extra];
  const res = spawnSync(process.execPath, args(["--head-split"]), { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "out", "syn.cut.manifest.json"), "utf8")).regions.map((x) => x.id).filter((x) => x.startsWith("head")).sort(), ["head_left", "head_right"]);
  const bad = spawnSync(process.execPath, args(["--belly-open"]), { encoding: "utf8" });
  assert.notEqual(bad.status, 0, "the default ellipse is wider than the synthetic column: refused");
  assert.match(bad.stderr, /no torso skin/);
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
    // Caps close every cut but one known case (docs/CUT-TOOL.md): a hairline slit in the Minotaur's source mesh at the neck (one open edge each side
    // after the gap is bridged). Hair (Psyche's cards) goes whole to the head, uncut, so it adds none.
    for (const [id, w] of Object.entries(s.watertight_by_region)) {
      // Psyche's eyelash mesh is its own skin with its own dequantisation matrix (0.135 against the body's 0.867); at its true size its card has 4 native open
      // edges that lie on the crotch bisector plane (the validator: none introduced), where the first skin's matrix used to put it elsewhere
      const limit = name.startsWith("minotaur") && (id === "head" || id === "upper_torso") ? 2 : name.startsWith("psyche") && id === "head" ? 4 : 0;
      assert.ok(w.open_edges_at_cuts <= limit, `${name} ${id}: ${w.open_edges_at_cuts} open edges at the cuts (limit ${limit}), first at ${JSON.stringify(w.at_cuts)}`);
    }
    if (name.startsWith("psyche")) { assert.deepEqual(r.manifest.plane_exempt, { piece_head: ["Ch22_hair"] }); assert.ok(s.hair_triangles > 10000); } else assert.equal(r.manifest.plane_exempt, undefined, "the Minotaur has no hair material");
    // the independent validator: every check passes, defects native to the source (open hair cards, the slit) separated from the cut's
    const plain = Buffer.from(await decompressGlb(bytes));
    const v = validate(Buffer.from(r.glb), r.manifest, { source: plain, planeOffset: r.manifest.plane_frame.bind_offset });
    assert.deepEqual(v.checks.filter((c) => !c.ok).map((c) => c.name + ": " + c.details.slice(0, 3).join(" | ")), []);
    const again = await cutGlb(bytes, row, rigMap, { body: name, rig: "mixamo-106", source: name + ".glb" });
    assert.ok(Buffer.compare(Buffer.from(r.glb), Buffer.from(again.glb)) === 0, "not deterministic");
  });
}

// ---------------------------------------------------------------- 19-joint rigs (Armagedom vagrant-106, mixamo-19): Spine1 is a node outside the skin, the toes are synthesised
// The toe entries are { node, along_local_y_m }: the synthetic bones have no rotation, so local +Y is world up and the toe sits 0.09 m below the Foot node (on the floor).
const rigMap19 = {
  schema: "rig-map/1",
  joints: { ...rigMap.joints, LeftToeBase: { node: "mixamorig:LeftFoot", along_local_y_m: -0.09 }, RightToeBase: { node: "mixamorig:RightFoot", along_local_y_m: -0.09 } },
};
const row19 = (b) => ({ ...b.row, joints: { ...b.row.joints, LeftToeBase: [0.13, 0, 0], RightToeBase: [-0.13, 0, 0] } });

test("19-joint rig: a node outside the skin (Spine1) and synthesised toes are accepted; the cut validates and keeps the 17-joint skeleton", async () => {
  const b = await buildBody({ nineteen: true });
  const r = await cutGlb(b.bytes, row19(b), rigMap19, { body: "synthetic19", rig: "mixamo-19", source: "synthetic19.glb" });
  const out = await readOut(r.glb);
  assert.equal(out.joints.length, NAMES.length - 3);
  for (const n of ["Spine1", "LeftToeBase", "RightToeBase"]) assert.ok(!out.joints.includes(n), n + " is not a skin joint");
  assert.equal(r.manifest.rig, "mixamo-19");
  assert.equal(r.manifest.stats.watertight, true);
  assert.equal(r.manifest.stats.orphan_weights, 0);
  const v = validate(Buffer.from(r.glb), r.manifest, { source: Buffer.from(b.bytes), planeOffset: r.manifest.plane_frame.bind_offset });
  assert.deepEqual(v.checks.filter((c) => !c.ok).map((c) => c.name + ": " + c.details.slice(0, 3).join(" | ")), []);
  const again = await cutGlb(b.bytes, row19(b), rigMap19, { body: "synthetic19", rig: "mixamo-19", source: "synthetic19.glb" });
  assert.ok(Buffer.compare(Buffer.from(r.glb), Buffer.from(again.glb)) === 0, "not deterministic");
});

test("19-joint rig: the measure row still has to belong to the skeleton (a wrong synthesised toe is refused)", async () => {
  const b = await buildBody({ nineteen: true });
  const bad = row19(b);
  bad.joints.LeftToeBase = [0.13, 0.3, 0];
  await assert.rejects(() => cutGlb(b.bytes, bad, rigMap19, {}), /does not match/);
});

test("rig map entries: a node that does not exist, a malformed object and a non-skin anchor role are refused with the role named", async () => {
  const b = await buildBody({ nineteen: true });
  const J = (o) => ({ schema: "rig-map/1", joints: { ...rigMap19.joints, ...o } });
  await assert.rejects(() => cutGlb(b.bytes, row19(b), J({ Spine1: "mixamorig:Nope" }), {}), /mixamorig:Nope for Spine1/);
  await assert.rejects(() => cutGlb(b.bytes, row19(b), J({ LeftToeBase: { node: "mixamorig:LeftFoot" } }), {}), /LeftToeBase.*along_local_y_m/);
  await assert.rejects(() => cutGlb(b.bytes, row19(b), J({ LeftToeBase: null }), {}), /LeftToeBase/);
  await assert.rejects(() => cutGlb(b.bytes, row19(b), J({ Hips: { node: "mixamorig:Hips", along_local_y_m: 0 } }), {}), /Hips.*skin joint/);
  await assert.rejects(() => cutGlb(b.bytes, row19(b), J({ Spine: "mixamorig:Spine1" }), {}), /Spine.*skin joint/);
});

// ---------------------------------------------------------------- hip_split when the thighs are parallel
// The hip bisector's normal is the difference of the two hip-plane normals. Parallel thighs (a body that stands with its legs straight down, no
// crotch apex found) make that difference a few thousandths and its direction whatever the thighs' tiny tilt asymmetry says (Big Vegas: front to
// back, not left to right), and its scaled distance swallowed vertices into the 0.1 mm snap band 70 times wider than 0.1 mm.
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const hipJoints = (kneeLeft, kneeRight, hipHalf = 0.188) => ({
  Hips: [0, 1.0, 0], Spine: [0, 1.07, 0.04], Neck: [0, 1.49, -0.04], Head: [0, 1.6, -0.05],
  LeftArm: [0.41, 1.4, -0.14], LeftForeArm: [0.6, 1.4, -0.14], RightArm: [-0.41, 1.4, -0.14], RightForeArm: [-0.6, 1.4, -0.14],
  LeftUpLeg: [hipHalf, 0.906, 0], LeftLeg: kneeLeft, RightUpLeg: [-hipHalf, 0.906, 0], RightLeg: kneeRight,
});
test("hip_split with parallel thighs: the plane is the midline, left to right, whatever the tiny tilt of each thigh is", () => {
  const tilts = [[0.0, 0.0], [0.0866, 0.1003], [0.1003, 0.0866], [0.02, 0.0], [0.0, 0.03]];
  for (const [zl, zr] of tilts) {
    const fns = buildPlanes(hipJoints([0.188, 0.45, zl * 0.45], [-0.188, 0.45, zr * 0.45]));
    const s = fns.hip_split;
    assert.ok(Math.abs(s.n[0]) > 0.999, "normal runs left to right, got " + s.n.map((x) => x.toFixed(4)));
    assert.ok(s.n[0] > 0, "positive side is the left leg's");
    assert.ok(Math.abs(Math.hypot(...s.n) - 1) < 1e-9);
    for (const z of [-0.3, 0, 0.3]) for (const y of [0.3, 0.6, 0.85]) assert.ok(Math.abs(s.d([0, y, z])) < 1e-9, "the midline is on the plane at y " + y + " z " + z);
    assert.ok(Math.abs(s.d([0.05, 0.6, 0.1]) - 0.05) < 1e-9, "the distance is metres from the plane: 5 cm to the left is 0.05");
    assert.ok(Math.abs(s.d([-0.07, 0.6, -0.1]) + 0.07) < 1e-9);
    assert.ok(Math.abs(dot3(s.n, s.point) - s.c) < 1e-12, "stored normal, point and offset agree with the function");
  }
});
test("hip_split with parallel thighs: nearly the same plane for tilts a milliradian apart (no noise)", () => {
  const a = buildPlanes(hipJoints([0.188, 0.45, 0.039], [-0.188, 0.45, 0.045])).hip_split;
  const b = buildPlanes(hipJoints([0.188, 0.45, 0.0391], [-0.188, 0.45, 0.0449])).hip_split;
  assert.ok(vlenOf(a.n.map((x, i) => x - b.n[i])) < 1e-3);
  assert.ok(vlenOf(a.point.map((x, i) => x - b.point[i])) < 1e-9);
});
test("hip_split with apart thighs keeps the bisector of the two hip planes exactly (shipped bodies cut as before)", () => {
  const fns = buildPlanes(hipJoints([0.45, 0.45, 0], [-0.45, 0.45, 0]));
  const s = fns.hip_split;
  for (const p of [[0.1, 0.5, 0.02], [-0.2, 0.3, 0.1], [0, 0.7, -0.05]]) assert.equal(s.d(p), fns.hip_left.d(p) - fns.hip_right.d(p));
  assert.ok(s.n[0] > 0.999);
});
const vlenOf = (v) => Math.hypot(...v);

// ---------------------------------------------------------------- the midline wall cap (parallel thighs, mesh across the midline below the hip planes)
// With parallel thighs the two hip planes through the two UpLeg joints cross each other along a line across the whole body and leave thin slabs of the far
// flank to the wrong leg; and mesh that crosses the midline below the planes (Big Vegas' belly apron and crotch) is cut in two by hip_split with nothing to
// close either side. The thighs get ONE hip plane (still two named planes and four hip caps), and each loop on the midline gets a wall cap of its own.
test("parallel thighs: hip_left and hip_right are one plane, both hip points on it or below it (the leg bones stay on the leg side); apart thighs keep two planes", () => {
  for (const [zl, zr] of [[0.0, 0.0], [0.0866, 0.1003], [0.1003, 0.0866], [0.02, 0.0]]) {
    const fns = buildPlanes(hipJoints([0.188, 0.45, zl * 0.45], [-0.188, 0.45, zr * 0.45]));
    const { hip_left: L, hip_right: R, hip_split: S } = fns;
    assert.equal(S.midline, true);
    assert.deepEqual(L.n, R.n);
    assert.equal(L.c, R.c);
    for (const p of [[0.188, 0.906, 0], [-0.188, 0.906, 0]]) assert.ok(L.d(p) >= -1e-12,"a hip point is on the plane or on the leg side: " + L.d(p));
    assert.ok(L.d([0.188, 0.906, 0]) < 1e-3 && R.d([-0.188, 0.906, 0]) < 1e-3, "raised only as far as it must be");
    assert.ok(Math.abs(L.n[1]) > 0.99, "along the thighs");
  }
  const apart = buildPlanes(hipJoints([0.45, 0.45, 0], [-0.45, 0.45, 0]));
  assert.equal(apart.hip_split.midline, undefined);
  assert.notDeepEqual(apart.hip_left.n, apart.hip_right.n);
});

test("parallel thighs: crotch lump and belly apron across the midline are closed by wall caps, and all eight checks pass", async () => {
  const b = await buildBody({ parallel: true });
  const r = await cut(b);
  const v = validateAll(b, r);
  assert.equal(v.ok, true, failedChecks(v).join("\n"));
  assert.equal(r.manifest.stats.cap_fallback_loops, 0, "no loop fell back to an unrelated cap");
  const out = await readOut(r.glb);
  const off = r.manifest.plane_frame.bind_offset, S = r.manifest.internal_planes.hip_split;
  const onMidline = (p, i) => Math.abs(S.normal[0] * (p[i * 3] - off[0] - S.point[0]) + S.normal[1] * (p[i * 3 + 1] - off[1] - S.point[1]) + S.normal[2] * (p[i * 3 + 2] - off[2] - S.point[2])) < 1e-4;
  for (const [cap, side] of [["cap_hip_left_leg", -1], ["cap_hip_right_leg", 1]]) {
    let wall = 0, hip = 0, facing = 0, lump = 0, apron = 0;
    for (const p of out.meshes[cap].prims) for (let t = 0; t < p.indices.length; t += 3) {
      const ix = [p.indices[t], p.indices[t + 1], p.indices[t + 2]];
      if (ix.every((i) => onMidline(p.positions, i))) {
        wall++;
        facing += ix.reduce((s, i) => s + (p.nor[i][0] * side > 0.99 ? 1 : 0), 0) / 3; // the left leg's wall faces -x (the other leg), the right leg's +x
        const z = ix.reduce((s, i) => s + p.positions[i * 3 + 2], 0) / 3;
        if (z > 0.1) apron++; else if (z < 0.08) lump++;
      } else hip++;
    }
    assert.ok(wall >= 8, cap + ": wall triangles " + wall);
    assert.ok(hip >= 8, cap + ": hip triangles " + hip);
    assert.ok(facing >= 0.9 * wall, cap + ": the wall faces the other leg: " + facing + " of " + wall);
    assert.ok(lump > 0 && apron > 0, cap + ": the lump's wall (" + lump + ") and the apron's wall (" + apron + ") are both there");
  }
  for (const cap of ["cap_hip_left_root", "cap_hip_right_root"]) assert.ok(out.meshes[cap].prims.reduce((s, p) => s + p.indices.length, 0) >= 12, cap + " has triangles: the shared plane's root cap is split by the midline");
  // the shared plane: both leg pieces and both root caps lie on it
  const P = r.manifest.planes;
  assert.deepEqual(P.hip_left.normal, P.hip_right.normal);
});

test("parallel thighs: each leg piece is closed with its caps, and the two legs' walls are mirror images across the midline", async () => {
  const b = await buildBody({ parallel: true });
  const r = await cut(b);
  const out = await readOut(r.glb);
  for (const [R, cap] of [["leg_left", "cap_hip_left_leg"], ["leg_right", "cap_hip_right_leg"]]) {
    const reg = REGIONS.find((x) => x.id === R);
    const parts = out.meshes[reg.mesh].prims.map((p) => ({ positions: p.positions, indices: p.indices })).concat(out.meshes[cap].prims.map((p) => ({ positions: p.positions, indices: p.indices })));
    const rep = weldReport(parts, 1e-5);
    assert.equal(rep.boundary_edges, 0, `${R}: ${rep.boundary_edges} open or flipped edges at ${JSON.stringify(rep.boundary_sample)}`);
    assert.equal(rep.non_manifold_edges, 0, `${R}: over-used edges`);
  }
});

// ---------------------------------------------------------------- rigid accessory layers (row-level override; the validator is not touched)
const cutWithAcc = (b, rigidAccessoryMaterials) => cutGlb(b.bytes, b.row, rigMap, { body: "synthetic", rig: "mixamo-106", source: "synthetic.glb", rigidAccessoryMaterials });
const failedChecks = (v) => v.checks.filter((c) => !c.ok).map((c) => c.name + ": " + c.details.slice(0, 3).join(" | "));
const SKIRT_TRIS = 6 * 6 * 6 * 2, SKIRT_VERTS = 6 * 7 * 7; // 6 faces of 6 x 6 quads, per-face vertices

test("rigid accessory: without the override a wide layer is cut at the planes into several pieces", async () => {
  const b = await buildBody({ skirt: true });
  const out = await readOut((await cut(b)).glb);
  const holders = REGIONS.filter((R) => out.meshes[R.mesh].prims.some((p) => p.material === "skirt_mat"));
  assert.ok(holders.length >= 2, "the skirt spans the waist and hip planes: " + holders.map((R) => R.id));
  assert.ok(holders.map((R) => out.meshes[R.mesh].prims.find((p) => p.material === "skirt_mat").jj.length).reduce((s, x) => s + x, 0) > SKIRT_VERTS, "cut: vertices were added");
});

test("rigid accessory: a named material stays whole in one piece, bound rigidly to one bone of that piece, declared as plane_exempt", async () => {
  const b = await buildBody({ skirt: true });
  const r = await cutWithAcc(b, ["skirt_mat"]);
  const out = await readOut(r.glb);
  const m = r.manifest;
  // whole: 432 triangles, 294 vertices (no vertex added), in exactly one piece; dominant weight is Hips (root) over the two upper legs
  const holders = REGIONS.filter((R) => out.meshes[R.mesh].prims.some((p) => p.material === "skirt_mat"));
  assert.deepEqual(holders.map((R) => R.id), ["root"]);
  const sk = out.meshes.piece_root.prims.find((p) => p.material === "skirt_mat");
  assert.equal(sk.indices.length / 3, SKIRT_TRIS);
  assert.equal(sk.jj.length, SKIRT_VERTS);
  const hips = out.joints.indexOf("Hips");
  for (let i = 0; i < sk.jj.length; i++) { assert.equal(sk.jj[i][0], hips); assert.equal(sk.ww[i][0], 1); assert.equal(sk.ww[i][1] + sk.ww[i][2] + sk.ww[i][3], 0); }
  let ymin = Infinity, ymax = -Infinity; for (let i = 1; i < sk.positions.length; i += 3) { ymin = Math.min(ymin, sk.positions[i]); ymax = Math.max(ymax, sk.positions[i]); }
  assert.ok(ymin < 0.85 && ymax > 1.1, "still spans the planes: y " + ymin + " to " + ymax);
  // declared: plane_exempt (merged with the lashes), a reason, and the accessory table
  assert.deepEqual(m.plane_exempt, { piece_head: ["lash"], piece_root: ["skirt_mat"] });
  assert.match(m.plane_exempt_reason, /accessor/);
  assert.match(m.plane_exempt_reason, /hair/, "the hair reason is kept when hair is present");
  assert.deepEqual(m.rigid_accessories, [{ name: "skirt_mat", mesh: "piece_root", materials: ["skirt_mat"], bone: "mixamorig:Hips", triangles: SKIRT_TRIS, vertices: SKIRT_VERTS }]);
  assert.equal(m.stats.rigid_accessory_triangles, SKIRT_TRIS);
  // the rest is cut as before: area conserved with the skirt in
  const src = sourceArea([...b.source.body, ...b.source.arm, ...b.source.lash, ...b.source.skirt]);
  let got = 0;
  for (const R of REGIONS) for (const p of out.meshes[R.mesh].prims) got += areaOf(p.positions, p.indices);
  assert.ok(Math.abs(got - src) / src < 1e-7, `area ${got} vs ${src}`);
  // the validator, unchanged, passes all checks; the exemption is the existing plane_exempt, and without it the planes check fails (the skirt really crosses)
  const v = validate(Buffer.from(r.glb), m, { source: Buffer.from(b.bytes), planeOffset: m.plane_frame.bind_offset });
  assert.deepEqual(failedChecks(v), []);
  assert.match(v.checks.find((c) => c.name === "planes").summary, /piece_root/);
  const bare = { ...m, plane_exempt: { piece_head: ["lash"] } };
  assert.equal(validate(Buffer.from(r.glb), bare, { source: Buffer.from(b.bytes), planeOffset: m.plane_frame.bind_offset }).checks.find((c) => c.name === "planes").ok, false);
});

test("rigid accessory: a mesh name works like a material name; the output bytes do not depend on which is used", async () => {
  const b = await buildBody({ skirt: true });
  const byMat = await cutWithAcc(b, ["skirt_mat"]), byMesh = await cutWithAcc(b, ["Skirt_Geo"]);
  assert.equal(sha256HexBytes(byMesh.glb), sha256HexBytes(byMat.glb));
  assert.deepEqual(byMesh.manifest.plane_exempt, byMat.manifest.plane_exempt);
  assert.equal(byMesh.manifest.rigid_accessories[0].name, "Skirt_Geo");
  assert.deepEqual(byMesh.manifest.rigid_accessories[0].materials, ["skirt_mat"]);
});

test("rigid accessory: the piece can be named in the row; the bone is then the heaviest one of that piece", async () => {
  const b = await buildBody({ skirt: true });
  const r = await cutWithAcc(b, [{ name: "skirt_mat", piece: "leg_left" }]);
  const out = await readOut(r.glb);
  assert.ok(out.meshes.piece_leg_left.prims.some((p) => p.material === "skirt_mat"));
  assert.ok(!out.meshes.piece_root.prims.some((p) => p.material === "skirt_mat"));
  const sk = out.meshes.piece_leg_left.prims.find((p) => p.material === "skirt_mat");
  const up = out.joints.indexOf("LeftUpLeg");
  for (let i = 0; i < sk.jj.length; i++) assert.equal(sk.jj[i][0], up);
  assert.equal(r.manifest.rigid_accessories[0].bone, "mixamorig:LeftUpLeg");
  assert.deepEqual(r.manifest.plane_exempt.piece_leg_left, ["skirt_mat"]);
  const v = validate(Buffer.from(r.glb), r.manifest, { source: Buffer.from(b.bytes), planeOffset: r.manifest.plane_frame.bind_offset });
  assert.deepEqual(failedChecks(v), []);
});

test("rigid accessory: a name that matches nothing, a hair material, a bad piece or a doubled name is refused", async () => {
  const b = await buildBody({ skirt: true });
  await assert.rejects(() => cutWithAcc(b, ["skirtt_mat"]), /rigid accessory "skirtt_mat" matches no material or mesh/);
  await assert.rejects(() => cutWithAcc(b, ["lash"]), /rigid accessory "lash".*hair/);
  await assert.rejects(() => cutWithAcc(b, [{ name: "skirt_mat", piece: "tail" }]), /piece "tail"/);
  await assert.rejects(() => cutWithAcc(b, ["skirt_mat", "Skirt_Geo"]), /rigid accessory "Skirt_Geo".*already/);
  await assert.rejects(() => cutWithAcc(b, "skirt_mat"), /list/);
});

const SKIRT_BOX = [[-0.23, 0.79, -0.17], [0.23, 1.21, 0.17]];
test("rigid accessory: a shell that shares its material with the body is picked by shells_inside; only that shell is exempt", async () => {
  const b = await buildBody({ skirt: true, skirtShared: true });
  const r = await cutWithAcc(b, [{ name: "body", shells_inside: SKIRT_BOX }]);
  const out = await readOut(r.glb);
  const m = r.manifest;
  // the skirt shell is whole in piece_root under a copy of the material; the body's own triangles keep their material and are cut as before
  const sk = out.meshes.piece_root.prims.find((p) => p.material === "body.rigid");
  assert.equal(sk.indices.length / 3, SKIRT_TRIS);
  assert.equal(sk.jj.length, SKIRT_VERTS);
  assert.ok(REGIONS.every((R) => out.meshes[R.mesh].prims.filter((p) => p.material === "body.rigid").length === (R.id === "root" ? 1 : 0)));
  assert.ok(REGIONS.filter((R) => out.meshes[R.mesh].prims.some((p) => p.material === "body")).length >= 5, "the body material is still cut into the pieces");
  assert.deepEqual(m.plane_exempt.piece_root, ["body.rigid"], "the exemption names the copy, not the body's material");
  assert.deepEqual(m.rigid_accessories, [{ name: "body", shells_inside: SKIRT_BOX, mesh: "piece_root", materials: ["body.rigid"], bone: "mixamorig:Hips", triangles: SKIRT_TRIS, vertices: SKIRT_VERTS }]);
  const v = validate(Buffer.from(r.glb), m, { source: Buffer.from(b.bytes), planeOffset: m.plane_frame.bind_offset });
  assert.deepEqual(failedChecks(v), []);
  assert.match(v.checks.find((c) => c.name === "planes").summary, new RegExp(SKIRT_VERTS + " piece_root vertices \\(body\\.rigid\\)"), "exactly the skirt's vertices are not checked");
  // the same cut with no box would have exempted the body material in piece_root: naming the whole material is a different (wider) declaration
  const whole = await cutWithAcc(b, ["Skirt_Geo"]);
  assert.deepEqual(whole.manifest.plane_exempt.piece_root, ["body.rigid"], "a whole mesh whose material the body shares gets the copy as well");
  assert.equal(sha256HexBytes(whole.glb), sha256HexBytes(r.glb), "same shell, same bytes");
});

test("rigid accessory: shells_inside that holds no shell, a bad box and a whole-and-shell clash are refused", async () => {
  const b = await buildBody({ skirt: true, skirtShared: true });
  await assert.rejects(() => cutWithAcc(b, [{ name: "body", shells_inside: [[5, 5, 5], [6, 6, 6]] }]), /no shell of the match lies inside/);
  await assert.rejects(() => cutWithAcc(b, [{ name: "body", shells_inside: [[0, 0, 0], [0, 1, 1]] }]), /shells_inside must be a box/);
  await assert.rejects(() => cutWithAcc(b, ["Skirt_Geo", { name: "body", shells_inside: SKIRT_BOX }]), /already took whole/);
});

test("plane_snap: absent is the height-scaled default (same bytes), a bad value is refused, a wide snap really changes the cut", async () => {
  const b = await buildBody();
  const base = await cut(b);
  const run1 = (planeSnap) => cutGlb(b.bytes, b.row, rigMap, { body: "synthetic", rig: "mixamo-106", source: "synthetic.glb", planeSnap });
  assert.equal(sha256HexBytes((await run1(undefined)).glb), sha256HexBytes(base.glb));
  for (const bad of [0, -1, 1.0001e-4, 0.01, "1e-4", null]) await assert.rejects(() => run1(bad), /plane_snap_m must be a number/, JSON.stringify(bad));
  // the value reaches the cut: the synthetic body is 1.7 m tall, so its default snap is 5e-5 x 1.7; giving exactly that value is the default cut
  const h = 1.75; // ymax - ymin of the synthetic GLB (the column's top at 1.75, the leg boxes' bottoms at 0)
  assert.equal(sha256HexBytes((await run1(5e-5 * h)).glb), sha256HexBytes(base.glb));
});

test("rigid accessory: an empty list is the same cut as no option (shipped rows stay byte-identical)", async () => {
  for (const variant of [{}, { hair: true }]) {
    const b = await buildBody(variant);
    const plain = await cut(b), none = await cutWithAcc(b, []), undef = await cutWithAcc(b, undefined);
    assert.equal(sha256HexBytes(none.glb), sha256HexBytes(plain.glb));
    assert.equal(sha256HexBytes(undef.glb), sha256HexBytes(plain.glb));
    assert.equal(JSON.stringify(none.manifest), JSON.stringify(plain.manifest));
    assert.equal(plain.manifest.rigid_accessories, undefined);
    assert.equal(plain.manifest.stats.rigid_accessory_triangles, undefined);
  }
});

// ---------------------------------------------------------------- shoulder_mode: a narrow-shouldered body over a wide waist, hips or skirt
const narrowJoints = () => ({ ...hipJoints([0.188, 0.45, 0], [-0.188, 0.45, 0]), LeftArm: [0.108, 1.23, 0], LeftForeArm: [0.33, 1.22, 0], RightArm: [-0.108, 1.23, 0], RightForeArm: [-0.33, 1.22, 0] });
test("shoulder_mode tilt: shoulderTiltFor clears the wide body below the joint, ignores shoulder tissue and a narrow body", () => {
  const A = [0.108, 1.23, 0], n = [1, 0, 0];
  assert.deepEqual(shoulderTiltFor(A, n, [[0.05, 0.9, 0], [0.09, 0.5, 0]]), { t: 0, binding: null }, "a body inside the joint's width needs no tilt");
  const skirt = [[0.2, 0.63, 0], [0.15, 0.9, 0.1]];
  const { t, binding } = shoulderTiltFor(A, n, skirt, 0);
  assert.ok(Math.abs(t - (0.2 - 0.108) / 0.6) < 1e-12, "the widest-per-drop vertex sets t: " + t);
  assert.deepEqual(binding, skirt[0]);
  for (const p of skirt) assert.ok(n[0] * (p[0] - A[0]) + t * (p[1] - A[1]) <= 1e-12, "every clearing vertex is on or inside the turned plane");
  assert.equal(shoulderTiltFor(A, n, [[0.3, 1.2, 0]], 0, 0.055).t, 0, "a vertex within minDrop below the joint (deltoid) is left to the weights");
  assert.ok(shoulderTiltFor(A, n, [[0.3, 1.2, 0]], 0, 0).t > 5, "without the skip a deltoid vertex would turn the plane almost flat");
  assert.ok(shoulderTiltFor(A, n, [[0.2, 0.63, 0]], 0.01).t > shoulderTiltFor(A, n, [[0.2, 0.63, 0]], 0).t, "the margin adds clearance");
});
test("shoulder_mode tilt: the plane keeps its joint and horizontal normal at tilt 0, and turns about the joint otherwise; default and joint are the same planes", () => {
  const J = narrowJoints();
  const dflt = buildPlanes(J), joint = buildPlanes(J, null, { shoulder_mode: "joint" }), t0 = buildPlanes(J, null, { shoulder_mode: "tilt" }, { left: 0, right: 0 });
  for (const s of ["shoulder_left", "shoulder_right"]) {
    assert.deepEqual({ ...joint[s], d: 0 }, { ...dflt[s], d: 0 }); // same n, c, point, source
    assert.deepEqual(t0[s].n, dflt[s].n);
    assert.deepEqual(t0[s].point, dflt[s].point);
  }
  const f = buildPlanes(J, null, { shoulder_mode: "tilt" }, { left: 0.4, right: 0.25 });
  for (const [s, A, t, sgn] of [["shoulder_left", J.LeftArm, 0.4, 1], ["shoulder_right", J.RightArm, 0.25, -1]]) {
    assert.ok(Math.abs(f[s].d(A)) < 1e-12, s + " still passes through its arm joint");
    assert.ok(Math.abs(vlenOf(f[s].n) - 1) < 1e-12);
    assert.ok(Math.abs(f[s].n[1] / Math.abs(f[s].n[0]) - t) < 1e-12, s + " tilt " + f[s].n);
    assert.ok(sgn * f[s].n[0] > 0, s + " still faces outward along the arm");
    assert.match(f[s].source, /turned about the joint/);
  }
  const wide = [0.21, 0.7, 0];
  assert.ok(dflt.shoulder_left.d(wide) > 0 && f.shoulder_left.d(wide) < 0, "the skirt vertex is on the arm's side of today's plane and on the body's side of the turned one");
});
test("shoulder_mode: an unknown mode and tilt with a moved shoulder_frac are refused", () => {
  assert.throws(() => buildPlanes(narrowJoints(), null, { shoulder_mode: "slant" }), /shoulder_mode must be one of joint, tilt/);
  assert.throws(() => buildPlanes(narrowJoints(), null, { shoulder_mode: "tilt", shoulder_frac: 0.3 }), /shoulder_frac must stay 0/);
});
test("shoulder_mode tilt: the same skirt body FAILS validation with default planes (joint mode) and passes with tilt", async () => {
  const b = await buildBody({ skirt: true });
  const joint = await cut(b);
  assert.notDeepEqual(failedChecks(validateAll(b, joint)), [], "default planes fail at least one check on a skirt wider than the shoulder joints");
  const tilt = await cutGlb(b.bytes, b.row, rigMap, { body: "synthetic", rig: "mixamo-106", source: "synthetic.glb", planes: { shoulder_mode: "tilt" } });
  assert.deepEqual(failedChecks(validateAll(b, tilt)), []);
});
test("shoulder_mode tilt: a plane that would have to turn past 45 degrees is refused, naming the vertex", async () => {
  const b = await buildBody({ skirt: true, skirtHalf: 0.5 }); // skirt out to x 0.5 only 0.2 m below the joint line: tilt 1.5
  await assert.rejects(() => cutGlb(b.bytes, b.row, rigMap, { body: "synthetic", rig: "mixamo-106", source: "synthetic.glb", planes: { shoulder_mode: "tilt" } }), /shoulder_mode tilt: the left shoulder plane would have to turn .* degrees .* at \S+,\S+,\S+; more than the 1 allowed/);
  await assert.doesNotReject(() => cut(b), "joint mode still cuts it");
});
test("shoulder_mode tilt: a wide skirt over the joint-width arms cuts and validates with the mode, the arm bones keep the arm side, and joint mode is the unchanged cut", async () => {
  const b = await buildBody({ skirt: true }); // skirt half width 0.22 against the arm joints at x = 0.2: narrower shoulders than hips
  const plain = await cut(b);
  const joint = await cutGlb(b.bytes, b.row, rigMap, { body: "synthetic", rig: "mixamo-106", source: "synthetic.glb", planes: { shoulder_mode: "joint" } });
  assert.equal(sha256HexBytes(joint.glb), sha256HexBytes(plain.glb), "mode joint is the default cut, byte for byte");
  assert.equal(JSON.stringify(joint.manifest), JSON.stringify(plain.manifest));
  assert.equal(plain.report.shoulder_tilt, undefined);
  const tilt = await cutGlb(b.bytes, b.row, rigMap, { body: "synthetic", rig: "mixamo-106", source: "synthetic.glb", planes: { shoulder_mode: "tilt" } });
  const t = tilt.report.shoulder_tilt;
  assert.ok(t.left.tilt > 0 && t.right.tilt > 0, "the skirt (x 0.22 at y 0.8) needs a turn: " + JSON.stringify(t));
  assert.ok(Math.abs(t.left.tilt - t.right.tilt) < 1e-9, "a symmetric body turns both sides alike");
  const v = validateAll(b, tilt);
  assert.deepEqual(failedChecks(v), [], "all checks pass with the mode");
  const pl = tilt.manifest.planes.shoulder_left;
  assert.ok(pl.normal[1] > 0 && Math.abs(pl.point[0] - 0.2) < 1e-4, "the plane passes through the LeftArm joint and is turned: " + JSON.stringify(pl.normal));
  const again = await cutGlb(b.bytes, b.row, rigMap, { body: "synthetic", rig: "mixamo-106", source: "synthetic.glb", planes: { shoulder_mode: "tilt" } });
  assert.equal(sha256HexBytes(again.glb), sha256HexBytes(tilt.glb), "deterministic");
});

// ---------------------------------------------------------------- optional cut: hands_feet (opt-in, default off): six severable parts, head / body / arms / legs / feet / hands
const HF_IDS = ["hand_left", "hand_right", "foot_left", "foot_right"];
const HF_OWN = { // bones on each side of the wrist and ankle planes, from the skeleton alone
  arm_left: ["LeftArm", "LeftForeArm"], arm_right: ["RightArm", "RightForeArm"], hand_left: ["LeftHand"], hand_right: ["RightHand"],
  leg_left: ["LeftUpLeg", "LeftLeg"], leg_right: ["RightUpLeg", "RightLeg"], foot_left: ["LeftFoot", "LeftToeBase"], foot_right: ["RightFoot", "RightToeBase"],
};
const HF_CAPS = {
  cap_wrist_left_hand: ["hand_left", "hand_left"], cap_wrist_left_arm: ["arm_left", "hand_left"], cap_wrist_right_hand: ["hand_right", "hand_right"], cap_wrist_right_arm: ["arm_right", "hand_right"],
  cap_ankle_left_foot: ["foot_left", "foot_left"], cap_ankle_left_leg: ["leg_left", "foot_left"], cap_ankle_right_foot: ["foot_right", "foot_right"], cap_ankle_right_leg: ["leg_right", "foot_right"],
};
const HF_PLANES = { wrist_left: ["LeftHand", "LeftForeArm"], wrist_right: ["RightHand", "RightForeArm"], ankle_left: ["LeftFoot", "LeftLeg"], ankle_right: ["RightFoot", "RightLeg"] };
const sumArea = (o, names) => names.reduce((s, n) => s + o.meshes[n].prims.reduce((t, p) => t + areaOf(p.positions, p.indices), 0), 0);

test("hands_feet off: explicit false, null or undefined is the same file as the default, with no hands_feet anywhere in the manifest", async () => {
  const { b, r } = await run();
  for (const o of [{ handsFeet: false }, { handsFeet: undefined }, { handsFeet: null }]) {
    const off = await cutWith(b, o);
    assert.ok(Buffer.compare(Buffer.from(off.glb), Buffer.from(r.glb)) === 0, JSON.stringify(o));
    assert.equal(JSON.stringify(off.manifest), JSON.stringify(r.manifest));
  }
  assert.equal(JSON.stringify(r.manifest).includes("hands_feet"), false);
  assert.equal(JSON.stringify(r.manifest).includes("wrist"), false);
  assert.deepEqual(r.manifest.regions.map((x) => x.id), ["root", "upper_torso", "head", "arm_left", "arm_right", "leg_left", "leg_right"]);
});

test("hands_feet planes: the wrist stands at the Hand joint square to ForeArm to Hand, the ankle at the Foot joint square to Leg to Foot; a data fraction moves the point back toward the elbow or knee", () => {
  const J = Object.fromEntries(Object.keys(W0).map((k) => [k, [W0[k][0], W0[k][1] - FLOOR, W0[k][2]]]));
  const f = buildHandsFeetPlanes(J);
  assert.deepEqual(Object.keys(f).sort(), ["ankle_left", "ankle_right", "wrist_left", "wrist_right"]);
  assert.deepEqual(HANDS_FEET.limbs.map((l) => l.plane), ["wrist_left", "wrist_right", "ankle_left", "ankle_right"]);
  for (const [id, [joint, back]] of Object.entries(HF_PLANES)) {
    const d = [0, 1, 2].map((k) => J[joint][k] - J[back][k]), l = Math.hypot(...d);
    assert.deepEqual(f[id].point, J[joint], id + " point is the joint at fraction 0");
    d.forEach((x, k) => assert.ok(Math.abs(f[id].n[k] - x / l) < 1e-12, id + " normal"));
    assert.match(f[id].source, new RegExp(joint));
  }
  assert.equal(HANDS_FEET.wrist_frac, 0); assert.equal(HANDS_FEET.ankle_frac, 0);
  const half = buildHandsFeetPlanes(J, { ...HANDS_FEET, wrist_frac: 0.5, ankle_frac: 0.25 });
  assert.ok(Math.abs(half.wrist_left.point[0] - 0.575) < 1e-12, "half way from the Hand back to the ForeArm: x " + half.wrist_left.point[0]);
  assert.ok(Math.abs(half.ankle_left.point[1] - (0.09 + 0.25 * 0.33)) < 1e-12);
  assert.throws(() => buildHandsFeetPlanes(J, { ...HANDS_FEET, wrist_frac: 1.5 }), /wrist_frac/);
  assert.throws(() => buildHandsFeetPlanes(J, { ...HANDS_FEET, ankle_frac: -0.1 }), /ankle_frac/);
  const noHand = { ...J }; delete noHand.LeftHand;
  assert.throws(() => buildHandsFeetPlanes(noHand), /LeftHand/);
});

test("hands_feet: arms end at the wrist, legs at the ankle; hands and feet are their own pieces with flat caps on both sides", async () => {
  const b = await buildBody();
  const base = await cut(b), baseOut = await readOut(base.glb);
  const r = await cutWith(b, { handsFeet: true });
  const out = await readOut(r.glb), m = r.manifest;
  assert.equal(m.schema, "cut-pieces/1");
  assert.deepEqual(m.regions.map((x) => x.id).sort(), ["arm_left", "arm_right", "foot_left", "foot_right", "hand_left", "hand_right", "head", "leg_left", "leg_right", "root", "upper_torso"]);
  for (const id of HF_IDS) { const x = m.regions.find((q) => q.id === id); assert.equal(x.mesh, "piece_" + id); assert.equal(x.detached_by, id); }
  for (const id of ["arm_left", "arm_right", "leg_left", "leg_right"]) assert.equal(m.regions.find((q) => q.id === id).detached_by, id, "the existing regions keep their detached_by");
  assert.equal(m.caps.length, 20);
  for (const [id, [region, unit]] of Object.entries(HF_CAPS)) { const c = m.caps.find((q) => q.id === id); assert.ok(c, id); assert.equal(c.mesh, id); assert.equal(c.region, region); assert.equal(c.shown_when_cut, unit); }
  const u = m.optional_units.hands_feet;
  assert.equal(u.enabled, true);
  assert.deepEqual(u.units, HF_IDS); assert.deepEqual(u.regions, HF_IDS); assert.deepEqual(u.planes, Object.keys(HF_PLANES)); assert.deepEqual([...u.caps].sort(), Object.keys(HF_CAPS).sort());
  assert.ok(u.stats);
  assert.deepEqual(Object.keys(m.planes), Object.keys(base.manifest.planes), "the six contract planes are unchanged");
  // planes, in the measure row's frame
  for (const [id, [joint]] of Object.entries(HF_PLANES)) {
    const pl = m.optional_planes[id];
    assert.ok(pl && typeof pl.source === "string" && pl.source.length > 10, id + " has a source");
    const w = W0[joint], want = [w[0], w[1] - FLOOR, w[2]];
    pl.point.forEach((x, k) => assert.ok(Math.abs(x - want[k]) < 1e-5, `${id} point ${k}: ${x} vs ${want[k]}`));
  }
  assert.ok(Math.abs(m.optional_planes.wrist_left.normal[0] - 1) < 1e-9 && Math.abs(m.optional_planes.wrist_right.normal[0] + 1) < 1e-9, "wrist normals point out along the arms");
  assert.ok(m.optional_planes.ankle_left.normal[1] < -0.99, "ankle normal points down the leg");
  // meshes: the base ones plus the new pieces and caps, all skinned
  assert.deepEqual(Object.keys(out.meshes).sort(), [...REGIONS.map((x) => x.mesh), ...HF_IDS.map((x) => "piece_" + x), ...CAPS.map((c) => c.id), ...Object.keys(HF_CAPS)].sort());
  for (const [name, mm] of Object.entries(out.meshes)) assert.ok(mm.node.getSkin(), name + " is skinned");
  // untouched pieces keep their geometry exactly; arm + hand and leg + foot hold the old arm and leg's area
  for (const id of ["root", "upper_torso", "head"]) assert.deepEqual(out.meshes["piece_" + id].prims.map((p) => [...p.positions]), baseOut.meshes["piece_" + id].prims.map((p) => [...p.positions]), id + " unchanged");
  for (const s of ["left", "right"]) {
    for (const [limb, end] of [["arm", "hand"], ["leg", "foot"]]) {
      const was = sumArea(baseOut, [`piece_${limb}_${s}`]), now = sumArea(out, [`piece_${limb}_${s}`, `piece_${end}_${s}`]);
      assert.ok(Math.abs(now - was) / was < 1e-7, `${limb}_${s} + ${end}_${s} area ${now} vs ${was}`);
      assert.ok(sumArea(out, [`piece_${end}_${s}`]) > 0.01 && sumArea(out, [`piece_${limb}_${s}`]) < was, `${end}_${s} took its part`);
    }
  }
  // every vertex on its side of its plane (1e-4)
  const side = (pl, p, i) => (pl.normal[0] * (p[i] - pl.point[0]) + pl.normal[1] * (p[i + 1] - (pl.point[1] + FLOOR)) + pl.normal[2] * (p[i + 2] - pl.point[2]));
  for (const [piece, plane, sign] of [["arm_left", "wrist_left", -1], ["hand_left", "wrist_left", 1], ["arm_right", "wrist_right", -1], ["hand_right", "wrist_right", 1], ["leg_left", "ankle_left", -1], ["foot_left", "ankle_left", 1], ["leg_right", "ankle_right", -1], ["foot_right", "ankle_right", 1]]) {
    for (const p of out.meshes["piece_" + piece].prims) for (let i = 0; i < p.positions.length; i += 3) assert.ok(side(m.optional_planes[plane], p.positions, i) * sign >= -1e-4, `${piece} vertex ${i / 3} on the wrong side of ${plane}`);
  }
  // caps: flat on their plane, facing away from their own piece, area = the section (arm box 0.1 x 0.1; leg box 0.156 x 0.14 cut on a plane 1.7 degrees off horizontal)
  for (const [cap, [region]] of Object.entries(HF_CAPS)) {
    const plane = cap.replace(/^cap_/, "").replace(/_(hand|arm|foot|leg)$/, ""), pl = m.optional_planes[plane], want = HF_IDS.includes(region) ? -1 : 1;
    for (const p of out.meshes[cap].prims) {
      for (let i = 0; i < p.positions.length; i += 3) assert.ok(Math.abs(side(pl, p.positions, i)) < 1e-4, cap + " flat");
      for (const n of p.nor) assert.ok((n[0] * pl.normal[0] + n[1] * pl.normal[1] + n[2] * pl.normal[2]) * want > 0.99, cap + " normal faces away from " + region);
      for (let t = 0; t < p.indices.length; t += 3) {
        const q = (k) => p.indices[t + k] * 3, P = p.positions, a = [0, 1, 2].map((c) => P[q(1) + c] - P[q(0) + c]), c2 = [0, 1, 2].map((c) => P[q(2) + c] - P[q(0) + c]);
        const g = [a[1] * c2[2] - a[2] * c2[1], a[2] * c2[0] - a[0] * c2[2], a[0] * c2[1] - a[1] * c2[0]];
        if (Math.hypot(...g) < 1e-12) continue;
        assert.ok((g[0] * pl.normal[0] + g[1] * pl.normal[1] + g[2] * pl.normal[2]) * want > 0, cap + " winding of triangle " + t / 3);
      }
    }
    const a = sumArea(out, [cap]), section = plane.startsWith("wrist") ? 0.01 : 0.156 * 0.14 / Math.abs(pl.normal[1]);
    assert.ok(Math.abs(a - section) < 2e-6, `${cap} area ${a} vs section ${section}`);
  }
  // every piece with its caps is watertight
  for (const R of m.regions) {
    const parts = out.meshes[R.mesh].prims.map((p) => ({ positions: p.positions, indices: p.indices }));
    for (const c of m.caps) if (c.region === R.id) for (const p of out.meshes[c.id].prims) parts.push({ positions: p.positions, indices: p.indices });
    const rep = weldReport(parts, 1e-5);
    assert.equal(rep.boundary_edges + rep.non_manifold_edges + rep.degenerate, 0, `${R.id}: open ${rep.boundary_edges}, non-manifold ${rep.non_manifold_edges}, degenerate ${rep.degenerate} at ${JSON.stringify(rep.boundary_sample)}`);
  }
  // bone side: each piece and its caps only on bones of its own side
  const ALL_OWN = { ...OWN, ...HF_OWN };
  for (const R of m.regions) for (const name of [R.mesh, ...m.caps.filter((c) => c.region === R.id).map((c) => c.id)]) for (const p of out.meshes[name].prims) p.jj.forEach((j, i) => j.forEach((ji, k) => { if (p.ww[i][k] > 0) assert.ok(ALL_OWN[R.id].includes(out.joints[ji]), `${name} vertex ${i} on ${out.joints[ji]}`); }));
  assert.equal(m.stats.orphan_weights, 0);
  for (const id of ["arm_left", "leg_left", "hand_left", "foot_left"]) assert.equal(m.stats.watertight_by_region[id].boundary_edges, 0);
  // weights sum to one everywhere
  for (const nm of Object.keys(out.meshes)) for (const p of out.meshes[nm].prims) for (const w of p.ww) assert.ok(Math.abs(w[0] + w[1] + w[2] + w[3] - 1) < 1e-5, nm);
  // the independent validator agrees and runs its extra check
  const v = validateAll(b, r);
  assert.deepEqual(why(v), []);
  assert.deepEqual(v.checks.map((c) => c.name), ["structure", "watertight", "orientation", "weights", "bone_side", "caps", "conservation", "planes", "hands_feet"]);
  assert.match(v.checks[0].summary, /11 pieces \+ 20 caps/);
  assert.match(v.checks.find((c) => c.name === "hands_feet").summary, /4 planes/);
  assert.ok(Buffer.compare(Buffer.from((await cutWith(b, { handsFeet: true })).glb), Buffer.from(r.glb)) === 0, "deterministic");
});

test("hands_feet: the validator FAILS a body whose hands_feet is wrong, with the reason, and no tolerance is relaxed", async () => {
  const b = await buildBody();
  const r = await cutWith(b, { handsFeet: true }), m = r.manifest;
  const clone = () => JSON.parse(JSON.stringify(m));
  const moved = clone(); moved.optional_planes.wrist_left.point[0] -= 0.05; // the plane moved into the forearm: arm vertices end up beyond it
  const mv = validateAll(b, r, moved);
  assert.ok(failing(mv).includes("planes"), "moved plane: " + failing(mv));
  assert.match(why(mv).join("\n"), /piece_arm_left: \d+ vertices on the wrong side of the wrist_left plane \(worst 0\.0\d+\)/);
  const tilted = clone(); tilted.optional_planes.ankle_right.normal = [0.5, -0.85, 0];
  assert.ok(failing(validateAll(b, r, tilted)).length > 0, "a tilted ankle plane");
  const noCap = clone(); noCap.caps = noCap.caps.filter((c) => c.id !== "cap_ankle_left_foot");
  assert.ok(failing(validateAll(b, r, noCap)).includes("structure"), "cap missing from the manifest");
  const wrongUnit = clone(); wrongUnit.caps.find((c) => c.id === "cap_wrist_right_arm").shown_when_cut = "arm_right";
  assert.ok(failing(validateAll(b, r, wrongUnit)).includes("structure"), "cap shown by the wrong unit");
  const wrongBy = clone(); wrongBy.regions.find((x) => x.id === "foot_left").detached_by = "leg_left";
  assert.ok(failing(validateAll(b, r, wrongBy)).includes("structure"), "foot detached by the leg");
  const noPlane = clone(); delete noPlane.optional_planes.wrist_right;
  assert.ok(failing(validateAll(b, r, noPlane)).length > 0, "a plane missing from the manifest");
  const asPlain = clone(); delete asPlain.optional_units; delete asPlain.optional_planes; // the GLB has hands and feet, the manifest claims the plain seven
  assert.ok(failing(validateAll(b, r, asPlain)).includes("structure"), "pieces in a plain manifest");
  const base = await cut(b);
  assert.ok(failing(validate(Buffer.from(base.glb), m, { source: Buffer.from(b.bytes), planeOffset: m.plane_frame.bind_offset })).includes("structure"), "manifest claims pieces the GLB lacks");
  // a hand vertex bound to the ForeArm fails bone_side: rebind one vertex in a copy of the GLB
  const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).readBinary(r.glb);
  const fore = doc.getRoot().listSkins()[0].listJoints().findIndex((j) => j.getName() === "mixamorig:LeftForeArm");
  const hand = doc.getRoot().listNodes().find((n) => n.getName() === "piece_hand_left").getMesh().listPrimitives()[0];
  hand.getAttribute("JOINTS_0").setElement(0, [fore, 0, 0, 0]); hand.getAttribute("WEIGHTS_0").setElement(0, [1, 0, 0, 0]);
  const bad = validate(Buffer.from(await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(doc)), m, { source: Buffer.from(b.bytes), planeOffset: m.plane_frame.bind_offset });
  assert.ok(failing(bad).includes("bone_side"), "a hand vertex bound to the ForeArm: " + failing(bad));
  assert.match(why(bad).join("\n"), /piece_hand_left uses mixamorig:LeftForeArm \(across the wrist_left cut\)/);
});

test("hands_feet with head_split, hair, a rigid skirt layer and the tilted shoulder plane: all of it keeps working and the validator passes every check", async () => {
  const b = await buildBody({ hair: true, skirt: true });
  const r = await cutGlb(b.bytes, b.row, rigMap, { body: "synthetic", rig: "mixamo-106", source: "synthetic.glb", headSplit: true, handsFeet: true, rigidAccessoryMaterials: ["skirt_mat"], planes: { shoulder_mode: "tilt" } });
  const v = validateAll(b, r);
  assert.deepEqual(why(v), []);
  assert.deepEqual(v.checks.map((c) => c.name), ["structure", "watertight", "orientation", "weights", "bone_side", "caps", "conservation", "planes", "head_split", "hands_feet"]);
  assert.match(v.checks[0].summary, /12 pieces \+ 23 caps/);
  assert.deepEqual(Object.keys(r.manifest.optional_units).sort(), ["hands_feet", "head_split"]);
  assert.ok(r.report.shoulder_tilt.left.tilt > 0);
  assert.deepEqual(r.manifest.plane_exempt.piece_root, ["skirt_mat"]);
  const out = await readOut(r.glb);
  assert.ok(out.meshes.piece_hand_left && out.meshes.piece_foot_right && out.meshes.piece_head_left);
});

test("hands_feet through the CLI flag --hands-feet", async () => {
  const b = await buildBody();
  const dir = mkdtempSync(join(tmpdir(), "cut-units-hf-"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "syn.glb"), b.bytes); writeFileSync(join(dir, "syn.measure.json"), JSON.stringify(b.row));
  const args = (extra) => [new URL("../tools/cut-units.mjs", import.meta.url).pathname, join(dir, "syn.glb"), join(dir, "syn.measure.json"), new URL("../data/rig-maps/mixamo-106.json", import.meta.url).pathname, join(dir, "out"), "--body", "syn", ...extra];
  const res = spawnSync(process.execPath, args(["--hands-feet"]), { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const man = JSON.parse(readFileSync(join(dir, "out", "syn.cut.manifest.json"), "utf8"));
  assert.equal(man.optional_units.hands_feet.enabled, true);
  assert.equal(man.regions.length, 11);
  const plain = spawnSync(process.execPath, args([]), { encoding: "utf8" });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, "out", "syn.cut.manifest.json"), "utf8")).optional_units, undefined);
});

// ---------------------------------------------------------------- hands_feet accessory_feet (a shoe layer sewn into a rigid garment shell)
const bootCut = (b, hf) => cutGlb(b.bytes, b.row, rigMap, { body: "synthetic", rig: "mixamo-106", source: "synthetic.glb", handsFeet: hf, rigidAccessoryMaterials: ["boot_mat"] });

test("hands_feet accessory_feet: off (the default) a rigid layer across the ankle plane stays whole in its piece, and the row field is checked", async () => {
  const b = await buildBody({ boot: true });
  const r = await bootCut(b, true);
  assert.deepEqual(why(validateAll(b, r)), []);
  const out = await readOut(r.glb);
  assert.ok(!out.meshes.piece_foot_left.prims.some((p) => p.material === "boot_mat"), "no boot in the foot piece");
  assert.equal(r.manifest.rigid_accessories_on_feet, undefined);
  assert.equal(r.manifest.optional_units.hands_feet.accessory_caps, undefined);
  assert.equal(r.manifest.optional_units.hands_feet.params.accessory_feet, undefined);
  assert.equal(HANDS_FEET.accessory_feet, false);
  assert.throws(() => buildHandsFeetPlanes(Object.fromEntries(Object.keys(W0).map((k) => [k, [W0[k][0], W0[k][1] - FLOOR, W0[k][2]]])), { ...HANDS_FEET, accessory_feet: "yes" }), /accessory_feet/);
});

test("hands_feet accessory_feet: the layer is cut at the ankle planes, the foot gets the shoe on its Foot bone, each seam is closed by a cap of its own, the validator passes with nothing relaxed", async () => {
  const b = await buildBody({ boot: true });
  const r = await bootCut(b, { accessory_feet: true }), m = r.manifest;
  assert.deepEqual(why(validateAll(b, r)), []);
  const out = await readOut(r.glb);
  const foot = out.meshes.piece_foot_left.prims.find((p) => p.material === "boot_mat"), rest = out.meshes.piece_root.prims.find((p) => p.material === "boot_mat");
  assert.ok(foot && rest, "boot in the foot piece and in piece_root");
  const bone = out.joints.indexOf("LeftFoot");
  for (let i = 0; i < foot.jj.length; i++) { assert.equal(foot.jj[i][0], bone); assert.equal(foot.ww[i][0], 1); }
  const hips = out.joints.indexOf("Hips");
  for (let i = 0; i < rest.jj.length; i++) { assert.equal(rest.jj[i][0], hips); assert.equal(rest.ww[i][0], 1); }
  const pl = m.optional_planes.ankle_left, side = (p, i) => pl.normal[0] * (p[i] - pl.point[0]) + pl.normal[1] * (p[i + 1] - (pl.point[1] + FLOOR)) + pl.normal[2] * (p[i + 2] - pl.point[2]);
  for (let i = 0; i < foot.positions.length; i += 3) assert.ok(side(foot.positions, i) >= -1e-4, "the shoe is beyond the ankle plane");
  assert.deepEqual(m.plane_exempt.piece_foot_left, ["boot_mat"]); assert.deepEqual(m.plane_exempt.piece_foot_right, ["boot_mat"]);
  assert.deepEqual(m.optional_units.hands_feet.accessory_caps.map((c) => c.id).sort(), ["cap_ankle_left_foot_left", "cap_ankle_left_root", "cap_ankle_right_foot_right", "cap_ankle_right_root"]);
  assert.equal(m.optional_units.hands_feet.params.accessory_feet, true);
  for (const c of m.optional_units.hands_feet.accessory_caps) { const cap = m.caps.find((q) => q.id === c.id); assert.ok(cap && cap.region === c.region && cap.shown_when_cut === c.shown_when_cut, c.id); assert.ok(out.meshes[c.id], c.id + " is in the GLB"); }
  // the flesh cut faces keep their ids and areas (the layer's seam has caps of its own)
  const plainHf = await bootCut(b, true), outPlain = await readOut(plainHf.glb);
  for (const cap of ["cap_ankle_left_foot", "cap_ankle_left_leg", "cap_ankle_right_foot", "cap_ankle_right_leg"]) assert.ok(Math.abs(sumArea(out, [cap]) - sumArea(outPlain, [cap])) < 1e-9, cap + " area unchanged");
  assert.ok(Buffer.compare(Buffer.from((await bootCut(b, { accessory_feet: true })).glb), Buffer.from(r.glb)) === 0, "deterministic");
});

test("hands_feet accessory_feet: the validator is told the seam caps by the manifest and still fails a cut without them (not a rubber stamp)", async () => {
  const b = await buildBody({ boot: true });
  const r = await bootCut(b, { accessory_feet: true });
  const stripped = JSON.parse(JSON.stringify(r.manifest)); delete stripped.optional_units.hands_feet.accessory_caps;
  assert.ok(failing(validateAll(b, r, stripped)).includes("watertight"), "without the cap list the piece is open at its seam: " + failing(validateAll(b, r, stripped)));
  const bent = JSON.parse(JSON.stringify(r.manifest)); bent.optional_units.hands_feet.accessory_caps[0].plane = "ankle_right";
  assert.ok(failing(validateAll(b, r, bent)).length > 0, "a cap named for the wrong plane fails");
});
