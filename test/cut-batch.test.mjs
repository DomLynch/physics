// tools/cut-batch.mjs on two synthetic bodies (no real body is in the repo): rows, measure + cut + validate, the receipt, blocked rows, determinism, and the
// general fixes the real 65-rig bodies needed (unskinned props in the source, a second UV set on one primitive only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { loadRows, runBatch, cutOpts, verdict } from "../tools/cut-batch.mjs";
import { cutGlb } from "../tools/cut-units.mjs";

const rigMap = JSON.parse(readFileSync(new URL("../data/rig-maps/mixamo-106.json", import.meta.url), "utf8"));
const FLOOR = 0.05;
const base = { // world bind-pose joints of body A (metres); body B is A scaled by 1.1 in height
  Hips: [0, 0.95, 0], Spine: [0, 1.05, 0], Spine1: [0, 1.17, 0], Spine2: [0, 1.3, 0], Neck: [0, 1.45, 0], Head: [0, 1.55, 0], HeadTop_End: [0, 1.75, 0],
  LeftShoulder: [0.05, 1.4, 0], LeftArm: [0.2, 1.4, 0], LeftForeArm: [0.45, 1.4, 0], LeftHand: [0.7, 1.4, 0],
  RightShoulder: [-0.05, 1.4, 0], RightArm: [-0.2, 1.4, 0], RightForeArm: [-0.45, 1.4, 0], RightHand: [-0.7, 1.4, 0],
  LeftUpLeg: [0.09, 0.9, 0], LeftLeg: [0.12, 0.47, 0], LeftFoot: [0.13, 0.14, 0], LeftToeBase: [0.15, FLOOR, 0.14],
  RightUpLeg: [-0.09, 0.9, 0], RightLeg: [-0.12, 0.47, 0], RightFoot: [-0.13, 0.14, 0], RightToeBase: [-0.15, FLOOR, 0.14],
};
const PARENT = { Spine: "Hips", Spine1: "Spine", Spine2: "Spine1", Neck: "Spine2", Head: "Neck", HeadTop_End: "Head", LeftShoulder: "Spine2", LeftArm: "LeftShoulder", LeftForeArm: "LeftArm", LeftHand: "LeftForeArm", RightShoulder: "Spine2", RightArm: "RightShoulder", RightForeArm: "RightArm", RightHand: "RightForeArm", LeftUpLeg: "Hips", LeftLeg: "LeftUpLeg", LeftFoot: "LeftLeg", LeftToeBase: "LeftFoot", RightUpLeg: "Hips", RightLeg: "RightUpLeg", RightFoot: "RightLeg", RightToeBase: "RightFoot" };
const NAMES = Object.keys(base);
const chain = (pts, v) => {
  if (v <= pts[0][0]) return [[pts[0][1], 1]];
  if (v >= pts[pts.length - 1][0]) return [[pts[pts.length - 1][1], 1]];
  for (let i = 0; i + 1 < pts.length; i++) if (v <= pts[i + 1][0]) { const t = (v - pts[i][0]) / (pts[i + 1][0] - pts[i][0]); return [[pts[i][1], 1 - t], [pts[i + 1][1], t]]; }
};
const box = (c, h, n, weights) => { // a subdivided box with per-face vertices, outward CCW triangles
  const faces = [
    [[c[0] + h[0], c[1] - h[1], c[2] + h[2]], [0, 0, -2 * h[2]], [0, 2 * h[1], 0]], [[c[0] - h[0], c[1] - h[1], c[2] - h[2]], [0, 0, 2 * h[2]], [0, 2 * h[1], 0]],
    [[c[0] - h[0], c[1] + h[1], c[2] - h[2]], [0, 0, 2 * h[2]], [2 * h[0], 0, 0]], [[c[0] - h[0], c[1] - h[1], c[2] - h[2]], [2 * h[0], 0, 0], [0, 0, 2 * h[2]]],
    [[c[0] - h[0], c[1] - h[1], c[2] + h[2]], [2 * h[0], 0, 0], [0, 2 * h[1], 0]], [[c[0] - h[0], c[1] - h[1], c[2] - h[2]], [0, 2 * h[1], 0], [2 * h[0], 0, 0]],
  ];
  const m = { pos: [], nor: [], uv: [], wts: [], idx: [] };
  for (const [o, u, v] of faces) {
    const nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...nrm); nrm[0] /= l; nrm[1] /= l; nrm[2] /= l;
    const b0 = m.pos.length;
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      const p = [o[0] + u[0] * i / n + v[0] * j / n, o[1] + u[1] * i / n + v[1] * j / n, o[2] + u[2] * i / n + v[2] * j / n];
      m.pos.push(p); m.nor.push(nrm); m.uv.push([i / n, j / n]); m.wts.push(weights(p));
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = b0 + j * (n + 1) + i, b = a + 1, d = a + n + 1, e = d + 1; m.idx.push(a, b, e, a, e, d); }
  }
  return m;
};

// Writes a synthetic body GLB: a column, two legs and two arms (second primitive, with a second UV set), plus an unskinned prop (a "weapon") beside it.
async function makeBody(k, only) {
  const W = Object.fromEntries(NAMES.map((n) => [n, [base[n][0], base[n][1] * k, base[n][2]]]));
  const SPINE = [[0.95 * k, "Hips"], [1.05 * k, "Spine"], [1.17 * k, "Spine1"], [1.3 * k, "Spine2"], [1.45 * k, "Neck"], [1.55 * k, "Head"], [1.75 * k, "HeadTop_End"]];
  const legChain = (s) => [[0.05 * k, s + "ToeBase"], [0.14 * k, s + "Foot"], [0.47 * k, s + "Leg"], [0.9 * k, s + "UpLeg"]];
  const wSpine = (p) => chain(SPINE, p[1]);
  const wLeg = (s) => (p) => (p[1] > 0.9 * k ? [[s + "UpLeg", 0.6], ["Hips", 0.4]] : chain(legChain(s), p[1]));
  const wArm = (s) => (p) => (Math.abs(p[0]) < 0.2 ? [[s + "Shoulder", 1]] : chain([[0.2, s + "Arm"], [0.45, s + "ForeArm"], [0.7, s + "Hand"]], Math.abs(p[0])));
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
  const skin = doc.createSkin("skin").setInverseBindMatrices(doc.createAccessor().setType("MAT4").setArray(ibm).setBuffer(buffer));
  for (const n of NAMES) skin.addJoint(nodes[n]);
  const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
  const prim = (parts, material, uv1, isBody) => {
    const pos = [], nor = [], uv = [], jj = [], ww = [], idx = [];
    for (const m of parts) {
      const b0 = pos.length / 3;
      m.pos.forEach((p, i) => { pos.push(...p); nor.push(...m.nor[i]); uv.push(...m.uv[i]); const w = m.wts[i].slice(0, 4); while (w.length < 4) w.push(["Hips", 0]); jj.push(...w.map((e) => NAMES.indexOf(e[0]))); ww.push(...w.map((e) => e[1])); });
      for (const i of m.idx) idx.push(b0 + i);
    }
    const p = doc.createPrimitive().setMaterial(material)
      .setAttribute("POSITION", acc("VEC3", new Float32Array(pos))).setAttribute("NORMAL", acc("VEC3", new Float32Array(nor))).setAttribute("TEXCOORD_0", acc("VEC2", new Float32Array(uv)))
      .setAttribute("JOINTS_0", acc("VEC4", new Uint16Array(jj))).setAttribute("WEIGHTS_0", acc("VEC4", new Float32Array(ww))).setIndices(acc("SCALAR", new Uint32Array(idx)));
    if (uv1) p.setAttribute("TEXCOORD_1", acc("VEC2", new Float32Array(uv)));
    // `only`: an attribute one of the two primitives has and the other lacks (COLOR_0 / TANGENT on the body only; "NORMAL" = the arms lose theirs)
    if (isBody && (only === "COLOR_0" || only === "TANGENT")) p.setAttribute(only, acc("VEC4", new Float32Array((pos.length / 3) * 4).fill(0.5)));
    if (!isBody && only === "NORMAL") p.setAttribute("NORMAL", null);
    return p;
  };
  const body = [box([0, 1.35 * k, 0], [0.1, 0.4 * k, 0.08], 10, wSpine), box([0.09, 0.5 * k, 0], [0.078, 0.5 * k, 0.07], 8, wLeg("Left")), box([-0.09, 0.5 * k, 0], [0.078, 0.5 * k, 0.07], 8, wLeg("Right"))];
  const arms = [box([0.435, 1.4 * k, 0], [0.315, 0.05, 0.05], 10, wArm("Left")), box([-0.435, 1.4 * k, 0], [0.315, 0.05, 0.05], 10, wArm("Right"))];
  const mesh = doc.createMesh("Body").addPrimitive(prim(body, doc.createMaterial("body"), false, true)).addPrimitive(prim(arms, doc.createMaterial("arms"), true, false)); // only the arms carry TEXCOORD_1
  scene.addChild(doc.createNode("Body").setMesh(mesh).setSkin(skin));
  // a rigid prop (no skin) high above the head: it must neither be cut nor counted as body surface
  const propBox = box([0.6, 2.2 * k, 0], [0.04, 0.3, 0.04], 3, () => [["Hips", 1]]);
  const prop = doc.createPrimitive().setMaterial(doc.createMaterial("prop"))
    .setAttribute("POSITION", acc("VEC3", new Float32Array(propBox.pos.flat()))).setAttribute("NORMAL", acc("VEC3", new Float32Array(propBox.nor.flat()))).setIndices(acc("SCALAR", new Uint32Array(propBox.idx)));
  scene.addChild(doc.createNode("WeaponDrawn_1").setMesh(doc.createMesh("prop").addPrimitive(prop)));
  return Buffer.from(await new NodeIO().writeBinary(doc));
}

const tmp = () => mkdtempSync(join(tmpdir(), "cut-batch-"));
async function fixture(rowsExtra = {}) {
  const dir = tmp(), sources = join(dir, "sources");
  mkdirSync(sources);
  writeFileSync(join(sources, "a.glb"), await makeBody(1));
  writeFileSync(join(sources, "b.glb"), await makeBody(1.1));
  const rows = {
    schema: "cut-bodies/1",
    defaults: { rig_map: "data/rig-maps/mixamo-106.json" },
    bodies: [
      { name: "synth-a", source: "a.glb", measure: "data/bodies/synth-a.measure.json" },
      { name: "synth-b", source: "b.glb", measure: "data/bodies/synth-b.measure.json", overrides: { planes: { neck_frac: 0.4 } } },
    ],
    ...rowsExtra,
  };
  const bodiesPath = join(dir, "cut-bodies.json");
  writeFileSync(bodiesPath, JSON.stringify(rows));
  return { dir, sources, bodiesPath, rows };
}

test("a two-body batch measures, cuts and validates both, and writes the receipt", async () => {
  const f = await fixture();
  const out = join(f.dir, "out");
  const { results, failed } = await runBatch({ bodiesPath: f.bodiesPath, sources: f.sources, out });
  assert.deepEqual(failed.map((r) => r.name), [], JSON.stringify(results.map((r) => [r.name, r.error, r.checks.filter((c) => c.result === "FAIL")]), null, 1));
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(verdict(r), "PASS");
    assert.equal(r.checks.length, 8);
    assert.ok(r.checks.every((c) => c.result === "PASS"), r.name + " " + JSON.stringify(r.checks.filter((c) => c.result !== "PASS")));
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
    for (const ext of [".cut.glb", ".cut.manifest.json", ".source-plain.glb", ".measure.json", ".validate.txt"]) assert.ok(existsSync(join(out, r.name + ext)), r.name + ext);
  }
  const receipt = readFileSync(join(out, "RECEIPT.md"), "utf8");
  for (const r of results) assert.ok(receipt.includes(r.sha256), "receipt carries the sha256 of " + r.name);
  assert.match(receipt, /\| synth-a \| mixamo-106 \| \*\*PASS\*\*/);
  assert.match(receipt, /RESULT: OK \(2 pass, 0 blocked\)/);
  const json = JSON.parse(readFileSync(join(out, "receipt.json"), "utf8"));
  assert.equal(json.bodies.length, 2);
});

test("the per-body plane row moves that body's neck plane and nothing else", async () => {
  const f = await fixture();
  const out = join(f.dir, "out");
  await runBatch({ bodiesPath: f.bodiesPath, sources: f.sources, out });
  const mA = JSON.parse(readFileSync(join(out, "synth-a.cut.manifest.json"), "utf8")), mB = JSON.parse(readFileSync(join(out, "synth-b.cut.manifest.json"), "utf8"));
  const rowA = JSON.parse(readFileSync(join(out, "synth-a.measure.json"), "utf8")), rowB = JSON.parse(readFileSync(join(out, "synth-b.measure.json"), "utf8"));
  const at = (row, f) => row.joints.Neck[1] + f * (row.joints.Head[1] - row.joints.Neck[1]);
  // A: half way from the Neck joint to the Head joint (the default); B: 0.4 of the way (its row), both in the measure row's frame
  assert.ok(Math.abs(mA.planes.neck.point[1] - at(rowA, 0.5)) < 2e-6, "default neck plane is half way: " + mA.planes.neck.point[1]);
  assert.ok(Math.abs(mB.planes.neck.point[1] - at(rowB, 0.4)) < 2e-6, "row neck_frac 0.4: " + mB.planes.neck.point[1]);
  assert.match(mB.planes.neck.source, /^0.4 of the way/);
});

test("explicit default plane rows cut byte for byte like no rows (the published bodies keep their bytes)", async () => {
  const f = await fixture();
  // measure through the batch once, then cut the plain source both ways
  const out = join(f.dir, "out");
  await runBatch({ bodiesPath: f.bodiesPath, sources: f.sources, out, only: ["synth-a"] });
  const mrow = JSON.parse(readFileSync(join(out, "synth-a.measure.json"), "utf8"));
  const plain = readFileSync(join(out, "synth-a.source-plain.glb"));
  const a = await cutGlb(plain, mrow, rigMap, { body: "t", rig: "mixamo-106", source: "s" });
  const b = await cutGlb(plain, mrow, rigMap, { body: "t", rig: "mixamo-106", source: "s", planes: { neck_frac: 0.5, waist_frac: 1, shoulder_frac: 0, hip_frac: 0 }, homeMinWeight: 0.2 });
  assert.ok(Buffer.from(a.glb).equals(Buffer.from(b.glb)));
  assert.deepEqual(a.manifest, b.manifest);
});

test("the same batch twice gives the same bytes", async () => {
  const f = await fixture();
  const o1 = join(f.dir, "o1"), o2 = join(f.dir, "o2");
  await runBatch({ bodiesPath: f.bodiesPath, sources: f.sources, out: o1 });
  await runBatch({ bodiesPath: f.bodiesPath, sources: f.sources, out: o2 });
  for (const n of ["synth-a", "synth-b"]) for (const ext of [".cut.glb", ".cut.manifest.json", ".validate.txt"]) assert.ok(readFileSync(join(o1, n + ext)).equals(readFileSync(join(o2, n + ext))), n + ext);
  assert.equal(readFileSync(join(o1, "RECEIPT.md"), "utf8"), readFileSync(join(o2, "RECEIPT.md"), "utf8"));
});

test("hands_feet_params: a row's wrist/ankle parameters apply only on a --hands-feet run (the default cut and its pinned hash are untouched); a bad value is refused", async () => {
  const f = await fixture();
  const rows = JSON.parse(readFileSync(f.bodiesPath, "utf8"));
  rows.bodies[1].hands_feet_params = { ankle_frac: 0.2 };
  writeFileSync(f.bodiesPath, JSON.stringify(rows));
  const plainBase = await runBatch({ bodiesPath: f.bodiesPath, sources: f.sources, out: join(f.dir, "p-plain") });
  assert.ok(plainBase.results.every((r) => r.checks.length === 8), "without --hands-feet the params do nothing");
  const hf = await runBatch({ bodiesPath: f.bodiesPath, sources: f.sources, out: join(f.dir, "p-hf"), handsFeet: true });
  assert.deepEqual(hf.failed.map((r) => r.name), []);
  const m0 = JSON.parse(readFileSync(join(f.dir, "p-hf", hf.results[0].name + ".cut.manifest.json"), "utf8"));
  const m1 = JSON.parse(readFileSync(join(f.dir, "p-hf", hf.results[1].name + ".cut.manifest.json"), "utf8"));
  const ank = (m) => JSON.stringify(m.optional_planes.ankle_left);
  assert.notEqual(ank(m0), ank(m1), "the row with ankle_frac 0.2 puts its ankle plane elsewhere");
  assert.equal(cutOpts({ name: "a", rig_map: "data/rig-maps/v1-65.json", hands_feet_params: { ankle_frac: 0.2 } }).handsFeet, undefined);
  rows.bodies[1].hands_feet_params = [1];
  writeFileSync(f.bodiesPath, JSON.stringify(rows));
  assert.throws(() => loadRows(f.bodiesPath), /hands_feet_params/);
});

test("hands_feet pass-through: a batch built with handsFeet cuts and validates every body with the six severable parts; a row override does the same for one body; a bad override value is refused", async () => {
  const f = await fixture();
  const { results, failed } = await runBatch({ bodiesPath: f.bodiesPath, sources: f.sources, out: join(f.dir, "out-hf"), handsFeet: true });
  assert.deepEqual(failed.map((r) => r.name), [], JSON.stringify(results.map((r) => [r.name, r.error, r.checks.filter((c) => c.result === "FAIL")]), null, 1));
  for (const r of results) {
    assert.deepEqual(r.checks.map((c) => c.name), ["structure", "watertight", "orientation", "weights", "bone_side", "caps", "conservation", "planes", "hands_feet"]);
    assert.ok(r.checks.every((c) => c.result === "PASS"), r.name);
    const m = JSON.parse(readFileSync(join(f.dir, "out-hf", r.name + ".cut.manifest.json"), "utf8"));
    assert.equal(m.optional_units.hands_feet.enabled, true);
    assert.equal(m.regions.length, 11);
  }
  // without the pass-through nothing changes
  const plain = await runBatch({ bodiesPath: f.bodiesPath, sources: f.sources, out: join(f.dir, "out-plain") });
  assert.ok(plain.results.every((r) => r.checks.length === 8));
  assert.notEqual(plain.results[0].sha256, results[0].sha256);
  // a row override turns it on for that body only
  const rows = JSON.parse(readFileSync(f.bodiesPath, "utf8"));
  rows.bodies[1].overrides = { ...rows.bodies[1].overrides, hands_feet: true };
  writeFileSync(f.bodiesPath, JSON.stringify(rows));
  const one = await runBatch({ bodiesPath: f.bodiesPath, sources: f.sources, out: join(f.dir, "out-one") });
  assert.deepEqual(one.results.map((r) => r.checks.length), [8, 9]);
  assert.equal(cutOpts({ name: "a", rig_map: "data/rig-maps/v1-65.json", overrides: { hands_feet: true } }).handsFeet, true);
  assert.equal(cutOpts({ name: "a", rig_map: "data/rig-maps/v1-65.json", overrides: {} }).handsFeet, undefined);
  rows.bodies[1].overrides = { hands_feet: "yes" };
  writeFileSync(f.bodiesPath, JSON.stringify(rows));
  assert.throws(() => loadRows(f.bodiesPath), /hands_feet/);
});

test("a body that does not validate fails the run loudly; a blocked row is reported, not hidden; a blocked row that passes fails too", async () => {
  const f = await fixture();
  // an impossible expected hash fails a body that otherwise validates
  const rows = JSON.parse(readFileSync(f.bodiesPath, "utf8"));
  rows.bodies[0].expect_sha256 = "0".repeat(64);
  rows.bodies[1].blocked = "synthetic: pretend this body cannot be cut";
  rows.bodies[1].blocked_checks = ["watertight"];
  writeFileSync(f.bodiesPath, JSON.stringify(rows));
  const out = join(f.dir, "out");
  const { results, failed } = await runBatch({ bodiesPath: f.bodiesPath, sources: f.sources, out });
  assert.equal(verdict(results[0]), "FAIL");
  assert.match(results[0].error, /not the expected/);
  assert.equal(verdict(results[1]), "UNBLOCKED", "a blocked row that validates is a stale row");
  assert.equal(failed.length, 2);
  assert.match(readFileSync(join(out, "RECEIPT.md"), "utf8"), /RESULT: FAIL \(synth-a FAIL, synth-b UNBLOCKED\)/);
  // a missing source is a FAIL with the path, and so is a blocked row's missing source: an error is never the failure the row expected
  rows.bodies[0] = { ...rows.bodies[0], expect_sha256: undefined, source: "nope.glb" };
  rows.bodies[1] = { ...rows.bodies[1], source: "nope.glb" };
  writeFileSync(f.bodiesPath, JSON.stringify(rows));
  const r2 = await runBatch({ bodiesPath: f.bodiesPath, sources: f.sources, out });
  assert.equal(verdict(r2.results[0]), "FAIL");
  assert.match(r2.results[0].error, /source not found/);
  assert.equal(verdict(r2.results[1]), "FAIL", "a blocked row whose source is missing is a FAIL, not BLOCKED");
  assert.match(readFileSync(join(out, "RECEIPT.md"), "utf8"), /RESULT: FAIL \(synth-a FAIL, synth-b FAIL\)/);
  assert.equal(r2.failed.length, 2);
});

test("a blocked row is BLOCKED only when exactly the checks it names fail, with no error", () => {
  const chk = (...fail) => ["structure", "watertight", "orientation"].map((name) => ({ name, result: fail.includes(name) ? "FAIL" : "PASS" }));
  const row = (checks, extra = {}) => ({ blocked: "cause", blocked_checks: ["watertight", "orientation"], ok: false, error: null, checks, ...extra });
  assert.equal(verdict(row(chk("watertight", "orientation"))), "BLOCKED");
  assert.equal(verdict(row(chk("orientation", "watertight"))), "BLOCKED", "order does not matter");
  assert.equal(verdict(row(chk("watertight"))), "FAIL", "fewer checks fail than the row names: the row is stale, not blocked");
  assert.equal(verdict(row(chk("watertight", "orientation", "structure"))), "FAIL", "an unnamed check also fails");
  assert.equal(verdict(row(chk("structure"))), "FAIL", "a different check fails");
  assert.equal(verdict(row(chk("watertight", "orientation"), { error: "boom" })), "FAIL", "an exception is never the expected failure");
  assert.equal(verdict(row(chk(), { ok: true })), "UNBLOCKED");
});

test("blocked rows must name their checks, and blocked_checks without blocked is refused", () => {
  const dir = tmp();
  const write = (o) => { const p = join(dir, "r.json"); writeFileSync(p, JSON.stringify(o)); return p; };
  const ok = { name: "a", source: "a.glb", rig_map: "r.json", measure: "m.json" };
  assert.throws(() => loadRows(write({ schema: "cut-bodies/1", bodies: [{ ...ok, blocked: "cause" }] })), /blocked_checks/);
  assert.throws(() => loadRows(write({ schema: "cut-bodies/1", bodies: [{ ...ok, blocked: "cause", blocked_checks: [] }] })), /blocked_checks/);
  assert.throws(() => loadRows(write({ schema: "cut-bodies/1", bodies: [{ ...ok, blocked_checks: ["watertight"] }] })), /without blocked/);
  assert.ok(loadRows(write({ schema: "cut-bodies/1", bodies: [{ ...ok, blocked: "cause", blocked_checks: ["watertight"] }] })).bodies.length === 1);
});

// finding 2: a primitive that lacks an attribute another has is filled only where that is honest
async function cutWithOnly(only) {
  const f = await fixture();
  writeFileSync(join(f.sources, "a.glb"), await makeBody(1, only));
  const rows = JSON.parse(readFileSync(f.bodiesPath, "utf8"));
  rows.bodies = [rows.bodies[0]];
  writeFileSync(f.bodiesPath, JSON.stringify(rows));
  const out = join(f.dir, "out");
  const { results } = await runBatch({ bodiesPath: f.bodiesPath, sources: f.sources, out });
  return { r: results[0], out };
}
test("a missing COLOR_0 is filled with opaque white, never transparent black", async () => {
  const { r, out } = await cutWithOnly("COLOR_0");
  assert.equal(r.error, null);
  const doc = await new NodeIO().read(join(out, "synth-a.cut.glb"));
  let seen = 0, white = 0;
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
    const c = p.getAttribute("COLOR_0");
    if (!c) continue;
    for (let i = 0; i < c.getCount(); i++) { const v = c.getElement(i, [0, 0, 0, 0]); seen++; assert.ok(v[3] > 0, "no vertex is transparent"); if (v.every((x) => Math.abs(x - 1) < 1e-6)) white++; }
  }
  assert.ok(seen > 0 && white > 0, "the primitive that lacked COLOR_0 got ones");
});
test("a missing TANGENT is refused, not zero-filled", async () => {
  const { r } = await cutWithOnly("TANGENT");
  assert.match(r.error, /TANGENT/);
});
test("a missing NORMAL is refused, not zero-filled", async () => {
  const { r } = await cutWithOnly("NORMAL");
  assert.match(r.error, /NORMAL/);
});
// finding 4: override values are checked, not just keys
test("override values are type and range checked: a typo never cuts with defaults", () => {
  const dir = tmp();
  const ok = { name: "a", source: "a.glb", rig_map: "r.json", measure: "m.json" };
  const load = (overrides) => { const p = join(dir, "r.json"); writeFileSync(p, JSON.stringify({ schema: "cut-bodies/1", bodies: [{ ...ok, overrides }] })); return loadRows(p); };
  assert.ok(load({ planes: { neck_frac: 0.4 }, home_min_weight: 0.3, hair_materials: ["h"], crotch_planes: false, head_split: true, belly_open: { x: 1 } }));
  for (const bad of [
    [{ planes: { neck_frac: "0.4" } }, /planes\.neck_frac/], [{ planes: { neck_frac: null } }, /planes\.neck_frac/], [{ planes: { neck_frac: 2 } }, /planes\.neck_frac/],
    [{ planes: { neck_frac: -0.1 } }, /planes\.neck_frac/], [{ planes: { neck_frac: NaN } }, /planes\.neck_frac/],
    [{ home_min_weight: "0.3" }, /home_min_weight/], [{ home_min_weight: 3 }, /home_min_weight/],
    [{ hair_materials: "h" }, /hair_materials/], [{ hair_materials: [1] }, /hair_materials/],
    [{ crotch_planes: "false" }, /crotch_planes/], [{ crotch_planes: 0 }, /crotch_planes/],
    [{ head_split: "yes" }, /head_split/], [{ belly_open: [] }, /belly_open/],
  ]) assert.throws(() => load(bad[0]), bad[1], JSON.stringify(bad[0]));
});

// finding 5: committed measure rows and --update-measure
test("a committed measure row that disagrees with the source's own measure fails the body", async () => {
  const f = await fixture();
  const rows = JSON.parse(readFileSync(f.bodiesPath, "utf8"));
  rows.bodies = [rows.bodies[0]];
  const committed = join(f.dir, "committed.measure.json");
  writeFileSync(committed, JSON.stringify({ joints: [] }));
  rows.bodies[0].measure = committed; // absolute: read as is, never written (no --update-measure)
  writeFileSync(f.bodiesPath, JSON.stringify(rows));
  const { results } = await runBatch({ bodiesPath: f.bodiesPath, sources: f.sources, out: join(f.dir, "out") });
  assert.equal(verdict(results[0]), "FAIL");
  assert.match(results[0].error, /different joints/);
});
test("--update-measure refuses a path outside data/ and writes nothing for a body that fails", async () => {
  const f = await fixture();
  const rows = JSON.parse(readFileSync(f.bodiesPath, "utf8"));
  rows.bodies = [rows.bodies[0]];
  const outside = join(f.dir, "outside.measure.json");
  rows.bodies[0].measure = outside;
  writeFileSync(f.bodiesPath, JSON.stringify(rows));
  const r1 = await runBatch({ bodiesPath: f.bodiesPath, sources: f.sources, out: join(f.dir, "out1"), updateMeasure: true });
  assert.equal(verdict(r1.results[0]), "FAIL");
  assert.match(r1.results[0].error, /must be inside data\//);
  assert.ok(!existsSync(outside), "nothing was written outside data/");
  // a body that fails validation does not overwrite its committed row
  const inRepo = "data/bodies/synth-failing-tmp.measure.json";
  rows.bodies[0].measure = inRepo;
  rows.bodies[0].expect_sha256 = "0".repeat(64);
  writeFileSync(f.bodiesPath, JSON.stringify(rows));
  const r2 = await runBatch({ bodiesPath: f.bodiesPath, sources: f.sources, out: join(f.dir, "out2"), updateMeasure: true });
  assert.equal(verdict(r2.results[0]), "FAIL");
  assert.ok(!existsSync(new URL("../" + inRepo, import.meta.url)), "a failing body's committed row was not written");
});

test("a missing TEXCOORD_1 is still zero-filled (the fixture's arms-only second UV set)", async () => {
  const { r } = await cutWithOnly(undefined);
  assert.equal(r.error, null);
});

test("rows are checked: unknown keys, unknown overrides, duplicate names and bad hashes are refused", () => {
  const dir = tmp();
  const write = (o) => { const p = join(dir, "r.json"); writeFileSync(p, JSON.stringify(o)); return p; };
  const ok = { name: "a", source: "a.glb", rig_map: "r.json", measure: "m.json" };
  assert.ok(loadRows(write({ schema: "cut-bodies/1", bodies: [ok] })).bodies.length === 1);
  assert.throws(() => loadRows(write({ schema: "cut-bodies/2", bodies: [ok] })), /schema/);
  assert.throws(() => loadRows(write({ schema: "cut-bodies/1", bodies: [{ ...ok, sourse: "x" }] })), /unknown key sourse/);
  assert.throws(() => loadRows(write({ schema: "cut-bodies/1", bodies: [{ ...ok, overrides: { hair: [] } }] })), /unknown override hair/);
  assert.throws(() => loadRows(write({ schema: "cut-bodies/1", bodies: [{ ...ok, overrides: { planes: { neck: 1 } } }] })), /unknown plane row neck/);
  // shoulder_mode: a named mode, "joint" (today) or "tilt"; tilt keeps the plane at the arm joint
  for (const m of ["joint", "tilt"]) assert.equal(loadRows(write({ schema: "cut-bodies/1", bodies: [{ ...ok, overrides: { planes: { shoulder_mode: m } } }] })).bodies.length, 1);
  assert.throws(() => loadRows(write({ schema: "cut-bodies/1", bodies: [{ ...ok, overrides: { planes: { shoulder_mode: "slant" } } }] })), /shoulder_mode must be one of joint, tilt/);
  assert.throws(() => loadRows(write({ schema: "cut-bodies/1", bodies: [{ ...ok, overrides: { planes: { shoulder_mode: 0.3 } } }] })), /shoulder_mode must be one of/);
  assert.throws(() => loadRows(write({ schema: "cut-bodies/1", bodies: [{ ...ok, overrides: { planes: { shoulder_mode: "tilt", shoulder_frac: 0.3 } } }] })), /shoulder_frac must be absent or 0/);
  assert.deepEqual(cutOpts({ name: "a", rig_map: "data/rig-maps/v1-65.json", overrides: { planes: { shoulder_mode: "tilt" } } }).planes, { shoulder_mode: "tilt" });
  assert.throws(() => loadRows(write({ schema: "cut-bodies/1", bodies: [ok, ok] })), /duplicate/);
  assert.throws(() => loadRows(write({ schema: "cut-bodies/1", bodies: [{ ...ok, expect_sha256: "abc" }] })), /expect_sha256/);
  assert.throws(() => loadRows(write({ schema: "cut-bodies/1", bodies: [{ ...ok, name: "../x" }] })), /plain file stem/);
  assert.throws(() => loadRows(write({ schema: "cut-bodies/1", bodies: [{ ...ok, blocked: "" }] })), /blocked/);
  const o = cutOpts({ name: "a", rig_map: "data/rig-maps/v1-65.json", overrides: { hair_materials: ["h"], planes: { neck_frac: 0.4 }, home_min_weight: 0.3, crotch_planes: false, head_split: true } });
  assert.deepEqual(o, { body: "a", rig: "v1-65", planes: { neck_frac: 0.4 }, hairMaterials: ["h"], homeMinWeight: 0.3, crotchPlanes: false, headSplit: true });
});

test("rows: overrides.rigid_accessory_materials is a list of names or {name, piece}, passed to the cut; a typo is refused", () => {
  const dir = tmp();
  const write = (o) => { const p = join(dir, "r.json"); writeFileSync(p, JSON.stringify(o)); return p; };
  const ok = { name: "a", source: "a.glb", rig_map: "r.json", measure: "m.json" };
  const withAcc = (v) => write({ schema: "cut-bodies/1", bodies: [{ ...ok, overrides: { rigid_accessory_materials: v } }] });
  assert.equal(loadRows(withAcc(["skirt", { name: "sash", piece: "root" }])).bodies.length, 1);
  assert.throws(() => loadRows(withAcc("skirt")), /rigid_accessory_materials must be a list/);
  assert.throws(() => loadRows(withAcc([""])), /rigid_accessory_materials/);
  assert.throws(() => loadRows(withAcc([{ name: "sash", piece: "tail" }])), /piece "tail"/);
  assert.throws(() => loadRows(withAcc([{ name: "sash", extra: 1 }])), /unknown key extra/);
  assert.equal(loadRows(withAcc([{ name: "m", piece: "leg_left", shells_inside: [[-1, 0, -1], [1, 1, 1]] }, { name: "m", shells_inside: [[-1, 1, -1], [1, 2, 1]] }])).bodies.length, 1);
  assert.throws(() => loadRows(withAcc([{ name: "m", shells_inside: [[1, 0, 0], [0, 1, 1]] }])), /shells_inside must be a box/);
  assert.throws(() => loadRows(withAcc([{ name: "m", shells_inside: [[0, 0, 0]] }])), /shells_inside must be a box/);
  assert.throws(() => loadRows(withAcc([{ name: "m", shells_inside: [[0, 0, 0], [1, 1, 1]] }, { name: "m", shells_inside: [[0, 0, 0], [1, 1, 1]] }])), /twice with the same box/);
  assert.deepEqual(cutOpts({ name: "a", rig_map: "data/rig-maps/mixamo-106.json", overrides: { rigid_accessory_materials: ["skirt"] } }), { body: "a", rig: "mixamo-106", rigidAccessoryMaterials: ["skirt"] });
  assert.deepEqual(cutOpts({ name: "a", rig_map: "data/rig-maps/mixamo-106.json", overrides: {} }), { body: "a", rig: "mixamo-106" }, "no override, no option");
  // plane_snap_m: the snap distance of vertices onto a plane, a per-body number in the row
  const withSnap = (v) => write({ schema: "cut-bodies/1", bodies: [{ ...ok, overrides: { plane_snap_m: v } }] });
  assert.equal(loadRows(withSnap(9e-5)).bodies.length, 1);
  assert.equal(loadRows(withSnap(1e-4)).bodies.length, 1, "the validator's tolerance itself is the cap");
  for (const bad of [0, -1e-5, 1.0001e-4, 5e-4, 0.01, "9e-5", null]) assert.throws(() => loadRows(withSnap(bad)), /plane_snap_m must be a number/, JSON.stringify(bad));
  assert.deepEqual(cutOpts({ name: "a", rig_map: "data/rig-maps/mixamo-106.json", overrides: { plane_snap_m: 9e-5 } }), { body: "a", rig: "mixamo-106", planeSnap: 9e-5 });
});

test("the shipped rows file is valid and lists every V3 body", () => {
  const { bodies } = loadRows(new URL("../data/cut-bodies.json", import.meta.url).pathname);
  assert.deepEqual(bodies.map((b) => b.name).sort(), ["anime-boy-black-106", "anime-girl-blonde-106", "arachne-106", "big-vegas-106", "brute-106", "castle-guard-106", "demon-106", "gargantua-106", "hale-pitborn", "hunter-pitborn-106", "kachujin-106", "maw-106", "minotaur-106", "minotaur-65", "parasite-106", "psyche-106", "psyche-65", "pumpkinhulk-106", "sporty-granny-106", "the-boss-106", "vagrant-106", "veteran-65", "warrior-65", "warrok-106"]);
  for (const b of bodies) {
    assert.ok(existsSync(new URL("../" + b.rig_map, import.meta.url)), b.rig_map);
    assert.ok(existsSync(new URL("../" + b.measure, import.meta.url)), b.measure);
  }
  for (const n of ["minotaur-106", "psyche-106", "gargantua-106", "arachne-106", "brute-106", "hunter-pitborn-106", "pumpkinhulk-106", "parasite-106", "anime-boy-black-106", "sporty-granny-106", "the-boss-106"]) assert.match(bodies.find((b) => b.name === n).expect_sha256, /^[0-9a-f]{64}$/);
});

test("psyche-106: pinned to V3's own source (Frankendom-v3 3e2a48c0 = main src/assets/psyche-106.glb), not the unknown-origin plain copy", () => {
  const { bodies } = loadRows(new URL("../data/cut-bodies.json", import.meta.url).pathname);
  const b = bodies.find((x) => x.name === "psyche-106");
  assert.equal(b.source, "psyche-106.glb", "V3's compressed file; the batch decompresses it");
  assert.equal(b.plain, undefined, "not a plain row: the batch decompresses the V3 file");
  assert.equal(b.rig_map, "data/rig-maps/mixamo-106.json");
  assert.equal(b.blocked, undefined, "no validator bypass: the row passes all 8 checks");
  assert.equal(b.expect_sha256, "204e7674e4e3118fee3ea768a8306505a8d96240946b0b3fec36d3abbe61690e");
  assert.notEqual(b.expect_sha256, "b684b455188cad8e2e46742ea16b40faa6357d1b260fb427bdf61fe1d7798477", "the old pin (unknown-origin copy) is gone");
  assert.match(b.note, /3e2a48c0/, "the note names the V3 commit");
  assert.match(b.note, /11c8e72da363f3b04e1d2d2bd5b68ffca00dfa9b2e759565b395b689057c8c74/, "the note records the V3 source sha256");
  assert.match(b.note, /e9f15ce7/, "the note records the replaced unknown-origin copy");
});

test("minotaur-106 row reproduces the shipped cut: head_split and belly_open are on in the row (V3 #111, physics 9056ef7)", async () => {
  const { bodies } = loadRows(new URL("../data/cut-bodies.json", import.meta.url).pathname);
  const b = bodies.find((x) => x.name === "minotaur-106");
  assert.deepEqual(b.overrides, { head_split: true, belly_open: true });
  assert.deepEqual(cutOpts(b), { body: "minotaur-106", rig: "mixamo-106", headSplit: true, bellyOpen: true });
  assert.match(b.note, /head-split/i);
  // the confidential source is only on the VPS: with it, the pinned row's cut carries the extra pieces
  const src = join(process.env.CUT_SOURCES || "/root/cut-out", b.source);
  if (!existsSync(src)) return;
  const json = (p) => JSON.parse(readFileSync(new URL("../" + p, import.meta.url), "utf8"));
  const { glb, manifest } = await cutGlb(readFileSync(src), json(b.measure), json(b.rig_map), cutOpts(b, { source: b.source }));
  assert.ok(glb.byteLength > 0);
  const meshes = manifest.regions.map((r) => r.mesh).concat(manifest.optional_units.belly_open.caps ?? []);
  for (const n of ["piece_head_left", "piece_head_right"]) assert.ok(meshes.includes(n), n);
  assert.ok(!meshes.includes("piece_head"), "the head halves replace piece_head");
  assert.ok(manifest.optional_units.head_split.enabled && manifest.optional_units.belly_open.enabled);
});

test("parasite-106 (V3 boss The Titan's Envoy): a pinned, unblocked row; it names the eye-loop boundary edges and the source caps", () => {
  const { bodies } = loadRows(new URL("../data/cut-bodies.json", import.meta.url).pathname);
  const b = bodies.find((x) => x.name === "parasite-106");
  assert.equal(b.source, "parasite-106.glb");
  assert.equal(b.rig_map, "data/rig-maps/mixamo-106.json");
  assert.equal(b.blocked, undefined, "no validator bypass: the row passes all 8 checks");
  assert.match(b.note, /410/, "the note records the 410 native boundary edges (eye loops)");
  assert.match(b.note, /eye/i);
});

test("the-boss-106 (V3 boss The Boss, rebuilt body, Frankendom-v3 PR 242): a pinned, unblocked row with the two rigid layers; no validator bypass", () => {
  const { bodies } = loadRows(new URL("../data/cut-bodies.json", import.meta.url).pathname);
  const b = bodies.find((x) => x.name === "the-boss-106");
  assert.equal(b.source, "the-boss-106.glb");
  assert.equal(b.rig_map, "data/rig-maps/mixamo-106.json");
  assert.equal(b.blocked, undefined, "the row passes all 8 checks");
  assert.equal(b.blocked_checks, undefined);
  assert.match(b.expect_sha256, /^367554e5[0-9a-f]{56}$/);
  assert.deepEqual(b.overrides, { rigid_accessory_materials: [{ name: "Clothes_MAT" }, { name: "Clothes_MAT.001", piece: "root", shells_inside: [[-0.5, -0.02, -0.4], [0.5, 1.03, 0.5]] }] });
  assert.match(b.note, /43916a8/);
  assert.match(b.note, /shell/i);
  assert.match(b.note, /crotch/i, "the note records that the pass is sensitive near the crotch");
});

test("big-vegas-106 (V3 boss The King): a pinned, unblocked row; the midline wall cap makes all 8 checks pass (no validator bypass)", () => {
  const { bodies } = loadRows(new URL("../data/cut-bodies.json", import.meta.url).pathname);
  const b = bodies.find((x) => x.name === "big-vegas-106");
  assert.equal(b.source, "big-vegas-106.glb");
  assert.equal(b.rig_map, "data/rig-maps/mixamo-106.json");
  assert.equal(b.blocked, undefined, "no validator bypass: the row passes all 8 checks");
  assert.equal(b.blocked_checks, undefined);
  assert.match(b.expect_sha256, /^643bffb5[0-9a-f]{56}$/);
  assert.match(b.note, /midline/);
});

test("anime-boy-black-106 (V3 boss body): a pinned, unblocked row; it records the 3 position-only source repairs and the native open edges", () => {
  const { bodies } = loadRows(new URL("../data/cut-bodies.json", import.meta.url).pathname);
  const b = bodies.find((x) => x.name === "anime-boy-black-106");
  assert.equal(b.source, "anime-boy-black-106.glb");
  assert.equal(b.rig_map, "data/rig-maps/mixamo-106.json");
  assert.equal(b.blocked, undefined, "no validator bypass: the row passes all 8 checks");
  for (const n of ["94", "70", "12", "602"]) assert.match(b.note, new RegExp(n), `the note records ${n}`);
  assert.match(b.note, /repair/i);
});

test("shoulder_mode tilt reaches the plane: the shipped anime-girl row's override turns the shoulder plane away from today's vertical one (fails on a tool without the mode)", async () => {
  const { bodies } = loadRows(new URL("../data/cut-bodies.json", import.meta.url).pathname);
  const o = cutOpts(bodies.find((x) => x.name === "anime-girl-blonde-106"));
  assert.equal(o.planes.shoulder_mode, "tilt");
  const { buildPlanes } = await import("../tools/cut-units.mjs");
  const J = { Hips: [0, 0.87, 0], Spine: [0, 0.92, 0], Neck: [0, 1.27, 0], Head: [0, 1.35, 0], LeftArm: [0.108, 1.23, 0], LeftForeArm: [0.33, 1.22, 0], RightArm: [-0.108, 1.23, 0], RightForeArm: [-0.33, 1.22, 0], LeftUpLeg: [0.077, 0.83, 0], LeftLeg: [0.057, 0.48, 0], RightUpLeg: [-0.077, 0.83, 0], RightLeg: [-0.057, 0.48, 0] };
  const skirt = [0.2, 0.7, 0];
  assert.ok(buildPlanes(J).shoulder_left.d(skirt) > 0, "today's plane puts a 0.2 m wide skirt vertex on the arm side");
  assert.ok(buildPlanes(J, null, o.planes, { left: 0.65, right: 0.65 }).shoulder_left.d(skirt) < 0, "the turned plane puts it on the body side");
});

test("anime-girl-blonde-106 (V3 body): a pinned, unblocked row whose only override is the general narrow-shoulder mode (planes.shoulder_mode tilt)", () => {
  const { bodies } = loadRows(new URL("../data/cut-bodies.json", import.meta.url).pathname);
  const b = bodies.find((x) => x.name === "anime-girl-blonde-106");
  assert.equal(b.source, "anime-girl-blonde-106.glb");
  assert.equal(b.rig_map, "data/rig-maps/mixamo-106.json");
  assert.equal(b.blocked, undefined, "no validator bypass: the row passes all 8 checks");
  assert.equal(b.blocked_checks, undefined);
  assert.deepEqual(b.overrides, { planes: { shoulder_mode: "tilt" } }, "no per-body plane numbers, no weights, no accessory sets");
  assert.match(b.expect_sha256, /^[0-9a-f]{64}$/);
  assert.match(b.note, /narrow/i);
});
