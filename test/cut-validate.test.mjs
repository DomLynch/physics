// tools/cut-validate.mjs on a hand-built fixture: a stack of boxes on an 8-joint skeleton, seven pieces and twelve caps generated here, plus one broken variant per check.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate, surfaceReport } from "../tools/cut-validate.mjs";
import { sha256HexBytes } from "../src/sha256.mjs";

const TOOL = fileURLToPath(new URL("../tools/cut-validate.mjs", import.meta.url));

// joints: 0 Hips, 1 Spine, 2 Neck, 3 Head, 4 ArmL, 5 ArmR, 6 LegL, 7 LegR (translations are relative to the parent)
const JOINTS = [
  ["Hips", [0, 0.75, 0], [1, 6, 7]], ["Spine", [0, 0.25, 0], [2, 4, 5]], ["Neck", [0, 0.5, 0], [3]], ["Head", [0, 0.2, 0], []],
  ["ArmL", [0.3, 0.3, 0], []], ["ArmR", [-0.3, 0.3, 0], []], ["LegL", [0.15, -0.25, 0], []], ["LegR", [-0.15, -0.25, 0], []],
];
const W = { root: [[0, 1]], upper_torso: [[1, 0.7], [2, 0.3]], head: [[3, 1]], arm_left: [[4, 1]], arm_right: [[5, 1]], leg_left: [[6, 1]], leg_right: [[7, 1]] };
// [region, min, max, faces to leave open]; faces are "+x" "-y" ...
const BOXES = [
  ["root", [-0.3, 0.5, -0.2], [0.3, 1.0, 0.2], ["+y", "-y"]],
  ["upper_torso", [-0.3, 1.0, -0.2], [0.3, 1.6, 0.2], ["+x", "-x", "+y", "-y"]],
  ["head", [-0.3, 1.6, -0.2], [0.3, 2.0, 0.2], ["-y"]],
  ["arm_left", [0.3, 1.0, -0.2], [0.8, 1.6, 0.2], ["-x"]],
  ["arm_right", [-0.8, 1.0, -0.2], [-0.3, 1.6, 0.2], ["+x"]],
  ["leg_left", [0, 0, -0.2], [0.3, 0.5, 0.2], ["+y"]],
  ["leg_right", [-0.3, 0, -0.2], [0, 0.5, 0.2], ["+y"]],
];
// caps: [id, region, axis face, box min, box max]: each is the one face of a (flat) box, facing out of its piece
const CAPBOXES = [
  ["cap_neck_head", "head", "-y", [-0.3, 1.6, -0.2], [0.3, 1.6, 0.2]],
  ["cap_neck_torso", "upper_torso", "+y", [-0.3, 1.6, -0.2], [0.3, 1.6, 0.2]],
  ["cap_shoulder_left_arm", "arm_left", "-x", [0.3, 1.0, -0.2], [0.3, 1.6, 0.2]],
  ["cap_shoulder_left_torso", "upper_torso", "+x", [0.3, 1.0, -0.2], [0.3, 1.6, 0.2]],
  ["cap_shoulder_right_arm", "arm_right", "+x", [-0.3, 1.0, -0.2], [-0.3, 1.6, 0.2]],
  ["cap_shoulder_right_torso", "upper_torso", "-x", [-0.3, 1.0, -0.2], [-0.3, 1.6, 0.2]],
  ["cap_hip_left_leg", "leg_left", "+y", [0, 0.5, -0.2], [0.3, 0.5, 0.2]],
  ["cap_hip_left_root", "root", "-y", [0, 0.5, -0.2], [0.3, 0.5, 0.2]],
  ["cap_hip_right_leg", "leg_right", "+y", [-0.3, 0.5, -0.2], [0, 0.5, 0.2]],
  ["cap_hip_right_root", "root", "-y", [-0.3, 0.5, -0.2], [0, 0.5, 0.2]],
  ["cap_waist_torso", "upper_torso", "-y", [-0.3, 1.0, -0.2], [0.3, 1.0, 0.2]],
  ["cap_waist_root", "root", "+y", [-0.3, 1.0, -0.2], [0.3, 1.0, 0.2]],
];
const UNIT = { head: "head", arm_left: "arm_left", arm_right: "arm_right", leg_left: "leg_left", leg_right: "leg_right", upper_torso: "torso_waist" };
const CAP_UNIT = (id) => (id.includes("neck") ? "head" : id.includes("shoulder_left") ? "arm_left" : id.includes("shoulder_right") ? "arm_right" : id.includes("hip_left") ? "leg_left" : id.includes("hip_right") ? "leg_right" : "torso_waist");

const newMesh = () => ({ pos: [], nrm: [], uv: [], jn: [], wt: [], idx: [] });
function addFace(m, min, max, face, weights) {
  const sign = face[0] === "+" ? 1 : -1, a = "xyz".indexOf(face[1]), u = (a + 1) % 3, v = (a + 2) % 3;
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  if (sign < 0) corners.reverse();
  const base = m.pos.length / 3;
  for (const [cu, cv] of corners) {
    const p = [0, 0, 0];
    p[a] = sign > 0 ? max[a] : min[a]; p[u] = cu ? max[u] : min[u]; p[v] = cv ? max[v] : min[v];
    const n = [0, 0, 0]; n[a] = sign;
    m.pos.push(...p); m.nrm.push(...n); m.uv.push(cu, cv);
    const j = [0, 0, 0, 0], w = [0, 0, 0, 0];
    weights.forEach(([jj, ww], k) => { j[k] = jj; w[k] = ww; });
    m.jn.push(...j); m.wt.push(...w);
  }
  m.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

// an open vertical strip (x0..x1, y0..y1, at z), n quads high, facing +z
function addCard(m, x0, x1, y0, y1, z, n, weights) {
  const base = m.pos.length / 3;
  for (let j = 0; j <= n; j++) for (const x of [x0, x1]) {
    m.pos.push(x, y0 + (y1 - y0) * j / n, z); m.nrm.push(0, 0, 1); m.uv.push(x === x0 ? 0 : 1, j / n);
    const jn = [0, 0, 0, 0], wt = [0, 0, 0, 0];
    weights.forEach(([jj, ww], k) => { jn[k] = jj; wt[k] = ww; });
    m.jn.push(...jn); m.wt.push(...wt);
  }
  for (let j = 0; j < n; j++) { const a = base + j * 2, b = a + 1, c = a + 2, d = a + 3; m.idx.push(a, b, d, a, d, c); }
}
const trisAtY = (m, y) => { const out = []; for (let t = 0; t < m.idx.length; t += 3) if ([0, 1, 2].every((k) => Math.abs(m.pos[m.idx[t + k] * 3 + 1] - y) < 1e-9)) out.push(t); return out; };
const dropTri = (m, t) => m.idx.splice(t, 3);
const flipTri = (m, t) => { const b = m.idx[t + 1]; m.idx[t + 1] = m.idx[t + 2]; m.idx[t + 2] = b; };

function fixture(variant = {}) {
  const meshes = {}; // name -> mesh
  const sourceMesh = newMesh();
  for (const [region, min, max, open] of BOXES) {
    const m = (meshes["piece_" + region] = newMesh());
    for (const f of ["+x", "-x", "+y", "-y", "+z", "-z"]) {
      if (open.includes(f)) continue;
      // the pelvis' front and back are split at x = 0 so its two hip caps meet the wall without a T-junction
      const halves = region === "root" && f[1] === "z" ? [[min, [0, max[1], max[2]]], [[0, min[1], min[2]], max]] : [[min, max]];
      for (const [lo, hi] of halves) { addFace(m, lo, hi, f, W[region]); addFace(sourceMesh, lo, hi, f, W[region]); }
    }
  }
  for (const [id, region, face, min, max] of CAPBOXES) {
    const m = (meshes[id] = newMesh());
    if (id === "cap_waist_root") { addFace(m, min, [0, max[1], max[2]], face, W[region]); addFace(m, [0, min[1], min[2]], max, face, W[region]); } else addFace(m, min, max, face, W[region]);
  }

  // hair: an open card with its own material, hanging from above the neck plane to below it, bound rigidly to Head (hairCrossBind: half on Neck). The
  // source has the card too, so its open edges are native to the source.
  if (variant.hair) {
    const weights = variant.hairCrossBind ? [[2, 0.5], [3, 0.5]] : [[3, 1]], h = newMesh();
    h.material = "hair"; addCard(h, 0, 0.2, 1.1, 1.9, 0.25, 10, weights);
    meshes.piece_head.more = [h];
    addCard(sourceMesh, 0, 0.2, 1.1, 1.9, 0.25, 10, weights);
  }
  // native versus introduced: the head's top face (y = 2) is two triangles, t0 = (b0, b1, b2) and t1 = (b0, b2, b3)
  {
    const head = meshes.piece_head, [t0, t1] = trisAtY(head, 2), [s0, s1] = trisAtY(sourceMesh, 2);
    if (variant.nativeHole || variant.nativeSplit) { dropTri(head, t1); dropTri(sourceMesh, s1); } // a hole in the source, the same hole in the piece
    if (variant.nativeSplit) { // ... and the piece's neighbour triangle split at the midpoint of the open diagonal: the open edges are halves of a source edge
      const [a, b, c] = head.idx.slice(t0, t0 + 3), m = head.pos.length / 3, mid = [0, 1, 2].map((k) => (head.pos[a * 3 + k] + head.pos[c * 3 + k]) / 2);
      head.pos.push(...mid); head.nrm.push(...head.nrm.slice(a * 3, a * 3 + 3)); head.uv.push(0.5, 0.5); head.jn.push(...head.jn.slice(a * 4, a * 4 + 4)); head.wt.push(...head.wt.slice(a * 4, a * 4 + 4));
      head.idx.splice(t0, 3, a, b, m, m, b, c);
    }
    if (variant.nativeFlip || variant.introFlip) flipTri(head, t0); // a flipped triangle in the piece ...
    if (variant.nativeFlip) flipTri(sourceMesh, s0); // ... that the source has flipped too
  }
  if (variant.hole) { const m = meshes.piece_head; m.idx.length -= 3; }
  if (variant.weightSum) meshes.piece_arm_left.wt[0] = 0.9;
  if (variant.crossBind) { const m = meshes.piece_head; m.jn[0] = 2; m.jn[1] = 3; m.wt[0] = 0.4; m.wt[1] = 0.6; } // Neck stays with the torso when the head is cut
  if (variant.inwardCap) { const m = meshes.cap_neck_head; for (let i = 0; i < m.nrm.length; i++) m.nrm[i] = -m.nrm[i]; }
  if (variant.dropCap) delete meshes[variant.dropCap];
  if (variant.noUv) meshes.cap_waist_root.uv = null;

  const manifest = {
    schema: "cut-pieces/1", body: "fixture", rig: "fixture", source: "fixture.glb",
    regions: BOXES.map(([id]) => ({ id, mesh: "piece_" + id, ...(UNIT[id] ? { detached_by: UNIT[id] } : {}) })),
    caps: CAPBOXES.map(([id, region]) => ({ id, mesh: id, region, shown_when_cut: CAP_UNIT(id) })),
    planes: {
      neck: { point: [0, variant.neckPlane ?? 1.6, 0], normal: [0, 1, 0], source: "test" }, waist: { point: [0, 1, 0], normal: [0, 1, 0], source: "test" },
      shoulder_left: { point: [0.3, 1.3, 0], normal: [1, 0, 0], source: "test" }, shoulder_right: { point: [-0.3, 1.3, 0], normal: [-1, 0, 0], source: "test" },
      hip_left: { point: [0.15, 0.5, 0], normal: [0, -1, 0], source: "test" }, hip_right: { point: [-0.15, 0.5, 0], normal: [0, -1, 0], source: "test" },
    },
    stats: {},
  };
  if (variant.exempt) { manifest.plane_exempt = variant.exempt === true ? { piece_head: ["hair"] } : variant.exempt; manifest.plane_exempt_reason = variant.noReason ? "" : "hair goes whole to the head"; }
  const body = { body: sourceMesh };
  return { glb: buildGlb(meshes, true), source: buildGlb(body, false), manifest };
}

function buildGlb(meshes, split) {
  const chunks = [], bufferViews = [], accessors = [];
  const push = (arr, Type, componentType, type, target, minmax) => {
    const bytes = Buffer.from(new Type(arr).buffer);
    while (chunks.reduce((s, c) => s + c.length, 0) % 4) chunks.push(Buffer.alloc(1));
    const off = chunks.reduce((s, c) => s + c.length, 0);
    chunks.push(bytes);
    bufferViews.push({ buffer: 0, byteOffset: off, byteLength: bytes.length, target });
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
    accessors.push({ bufferView: bufferViews.length - 1, componentType, count: arr.length / n, type, ...(minmax || {}) });
    return accessors.length - 1;
  };
  const nodes = JOINTS.map(([name, t, ch]) => ({ name, translation: t, children: ch }));
  const jointCount = nodes.length, json = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes, meshes: [], skins: [{ joints: [...Array(jointCount).keys()], skeleton: 0 }], buffers: [] };
  json.materials = [];
  const matIndex = (name) => { let i = json.materials.findIndex((x) => x.name === name); if (i < 0) { json.materials.push({ name }); i = json.materials.length - 1; } return i; };
  for (const [name, m0] of Object.entries(meshes)) {
    const primitives = [];
    for (const m of [m0, ...(m0.more || [])]) { // `more`: further primitives of the mesh, each with its own material
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < m.pos.length; i++) { lo[i % 3] = Math.min(lo[i % 3], m.pos[i]); hi[i % 3] = Math.max(hi[i % 3], m.pos[i]); }
      const attributes = {
        POSITION: push(m.pos, Float32Array, 5126, "VEC3", 34962, { min: lo, max: hi }), NORMAL: push(m.nrm, Float32Array, 5126, "VEC3", 34962),
        JOINTS_0: push(m.jn, Uint16Array, 5123, "VEC4", 34962), WEIGHTS_0: push(m.wt, Float32Array, 5126, "VEC4", 34962),
      };
      if (m.uv) attributes.TEXCOORD_0 = push(m.uv, Float32Array, 5126, "VEC2", 34962);
      const indices = push(m.idx, Uint32Array, 5125, "SCALAR", 34963);
      primitives.push({ attributes, indices, mode: 4, ...(m.material ? { material: matIndex(m.material) } : {}) });
    }
    json.meshes.push({ name, primitives });
    json.nodes.push({ name, mesh: json.meshes.length - 1, skin: 0 });
    json.scenes[0].nodes.push(json.nodes.length - 1);
  }
  void split;
  if (!json.materials.length) delete json.materials;
  json.accessors = accessors; json.bufferViews = bufferViews;
  let bin = Buffer.concat(chunks);
  while (bin.length % 4) bin = Buffer.concat([bin, Buffer.alloc(1)]);
  json.buffers = [{ byteLength: bin.length }];
  let js = Buffer.from(JSON.stringify(json));
  while (js.length % 4) js = Buffer.concat([js, Buffer.from(" ")]);
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  return Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(bin.length, 0x004e4942), bin]);
}

const run = (variant, withSource = true) => { const f = fixture(variant); return validate(f.glb, f.manifest, { source: withSource ? f.source : null }); };
const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);

test("a valid fixture passes every check, with the source compared", () => {
  const r = run({});
  assert.deepEqual(failed(r), [], JSON.stringify(r.checks.filter((c) => !c.ok), null, 1));
  assert.equal(r.ok, true);
  assert.deepEqual(r.checks.map((c) => c.name), ["structure", "watertight", "orientation", "weights", "bone_side", "caps", "conservation", "planes"]);
  assert.ok(r.checks.find((c) => c.name === "watertight").table.filter((t) => t.startsWith("piece_")).length === 7, "one table row per piece");
  assert.ok(!r.checks.find((c) => c.name === "conservation").summary.startsWith("skipped"));
});

test("without --source conservation is skipped, not failed", () => {
  const r = run({}, false);
  assert.equal(r.ok, true);
  assert.match(r.checks.find((c) => c.name === "conservation").summary, /skipped/);
});

test("the hash is the sha256 of the GLB bytes and is stable", () => {
  const f = fixture({}), again = fixture({});
  assert.equal(validate(f.glb, f.manifest).sha256, sha256HexBytes(again.glb));
  assert.equal(sha256HexBytes(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("a hole in a piece fails watertight and names the open edge", () => {
  const r = run({ hole: true });
  assert.ok(failed(r).includes("watertight"));
  const c = r.checks.find((x) => x.name === "watertight");
  assert.match(c.details.join("\n"), /piece_head: \d+ open edge/);
  assert.match(c.details.join("\n"), /\(-?\d/); // a world position
});

test("weights that do not sum to one fail weights", () => {
  const r = run({ weightSum: true });
  assert.deepEqual(failed(r), ["weights"]);
});

test("a head vertex bound to the Neck bone fails bone_side", () => {
  const r = run({ crossBind: true });
  assert.deepEqual(failed(r), ["bone_side"]);
  assert.match(r.checks.find((c) => c.name === "bone_side").details.join("\n"), /piece_head uses Neck/);
});

test("an inward cap normal fails caps", () => {
  const r = run({ inwardCap: true });
  assert.deepEqual(failed(r), ["caps"]);
  assert.match(r.checks.find((c) => c.name === "caps").details.join("\n"), /cap_neck_head: normals face inward/);
});

test("a cap without UVs fails caps", () => {
  assert.deepEqual(failed(run({ noUv: true })), ["caps"]);
});

test("a piece that crosses a manifest plane fails planes", () => {
  const r = run({ neckPlane: 1.65 });
  assert.deepEqual(failed(r), ["planes"]);
  assert.match(r.checks.find((c) => c.name === "planes").details.join("\n"), /piece_head.*neck plane/);
});

test("a missing cap mesh fails structure", () => {
  const r = run({ dropCap: "cap_hip_left_root" });
  assert.ok(failed(r).includes("structure"));
  assert.match(r.checks.find((c) => c.name === "structure").details.join("\n"), /cap_hip_left_root.*not in the GLB/);
});

test("a wrong schema fails structure", () => {
  const f = fixture({});
  f.manifest.schema = "cut-pieces/0";
  assert.ok(failed(validate(f.glb, f.manifest)).includes("structure"));
});

test("conservation: a missing piece area is caught against the source", () => {
  const f = fixture({ hole: true });
  const r = validate(f.glb, f.manifest, { source: f.source });
  assert.ok(failed(r).includes("conservation"));
});

test("CLI: exit 0 on the valid fixture, 1 on a broken one, --hash alone prints the digest", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutval-"));
  const put = (name, variant) => {
    const f = fixture(variant);
    writeFileSync(join(dir, name + ".glb"), f.glb); writeFileSync(join(dir, name + ".json"), JSON.stringify(f.manifest)); writeFileSync(join(dir, name + ".src.glb"), f.source);
  };
  put("good", {}); put("bad", { hole: true });
  const good = spawnSync("node", [TOOL, join(dir, "good.glb"), join(dir, "good.json"), "--source", join(dir, "good.src.glb"), "--hash"], { encoding: "utf8" });
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /RESULT: PASS/);
  assert.match(good.stdout, /sha256 [0-9a-f]{64}/);
  const bad = spawnSync("node", [TOOL, join(dir, "bad.glb"), join(dir, "bad.json"), "--json"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  const h = spawnSync("node", [TOOL, join(dir, "good.glb"), "--hash"], { encoding: "utf8" });
  assert.match(h.stdout, /^[0-9a-f]{64}  /);
});

// ---------------------------------------------------------------- plane_exempt (hair goes whole to the head, across the neck plane)
test("plane_exempt: hair across the neck plane, bound to Head only, passes every check with the source compared", () => {
  const r = run({ hair: true, exempt: true });
  assert.deepEqual(failed(r), [], JSON.stringify(r.checks.filter((c) => !c.ok), null, 1));
  assert.match(r.checks.find((c) => c.name === "planes").summary, /plane_exempt .*piece_head.*hair/);
  // the card's open border is native: the source has it open too
  assert.match(r.checks.find((c) => c.name === "watertight").summary, /native to the source/);
});

test("plane_exempt: without the manifest entry the same hair fails planes", () => {
  const r = run({ hair: true });
  assert.ok(failed(r).includes("planes"), failed(r).join());
  assert.match(r.checks.find((c) => c.name === "planes").details.join("\n"), /piece_head: \d+ vertices on the wrong side of the neck plane/);
});

test("plane_exempt skips the planes check only: weights on a bone across the cut still fail bone_side", () => {
  const r = run({ hair: true, hairCrossBind: true, exempt: true });
  assert.deepEqual(failed(r), ["bone_side"]);
  assert.match(r.checks.find((c) => c.name === "bone_side").details.join("\n"), /piece_head uses Neck/);
});

test("plane_exempt covers the listed material only: the head's own surface across the plane still fails", () => {
  const r = run({ hair: true, exempt: true, neckPlane: 1.65 });
  assert.ok(failed(r).includes("planes"));
  assert.match(r.checks.find((c) => c.name === "planes").details.join("\n"), /piece_head.*neck plane/);
});

test("plane_exempt is validated: a reason is required, and the piece and material must exist", () => {
  const noReason = run({ hair: true, exempt: true, noReason: true });
  assert.ok(failed(noReason).includes("structure"));
  assert.match(noReason.checks.find((c) => c.name === "structure").details.join("\n"), /plane_exempt_reason/);
  const badMat = run({ hair: true, exempt: { piece_head: ["nothing"] } });
  assert.match(badMat.checks.find((c) => c.name === "structure").details.join("\n"), /material "nothing", which the piece does not use/);
  const badPiece = run({ hair: true, exempt: { piece_nope: ["hair"] } });
  assert.match(badPiece.checks.find((c) => c.name === "structure").details.join("\n"), /"piece_nope", which is not a piece mesh/);
});

// ---------------------------------------------------------------- native versus introduced edge defects
test("a hole the source already has is native: passes with --source, fails without it", () => {
  const f = fixture({ nativeHole: true });
  const withSrc = validate(f.glb, f.manifest, { source: f.source });
  assert.deepEqual(failed(withSrc), [], JSON.stringify(withSrc.checks.filter((c) => !c.ok), null, 1));
  const w = withSrc.checks.find((c) => c.name === "watertight");
  assert.match(w.summary, /except 3 edge\(s\) native to the source \(3 open, 0 over-used\); none introduced/);
  assert.match(w.table.join("\n"), /piece_head: .* 3 open edges \(3 native\)/);
  assert.deepEqual(failed(validate(f.glb, f.manifest)), ["watertight"], "without a source every open edge counts as introduced");
});

test("an introduced hole fails even when the source has a different hole", () => {
  const f = fixture({ nativeHole: true, hole: true }); // `hole` also drops the head's last triangle from the piece only
  const r = validate(f.glb, f.manifest, { source: f.source });
  assert.ok(failed(r).includes("watertight"));
  assert.match(r.checks.find((c) => c.name === "watertight").details.join("\n"), /piece_head: \d+ open edge\(s\) introduced by the cut/);
});

test("a native open edge the cut split in two (halves of a source edge) is still native", () => {
  const f = fixture({ nativeSplit: true });
  const r = validate(f.glb, f.manifest, { source: f.source });
  assert.deepEqual(failed(r), [], JSON.stringify(r.checks.filter((c) => !c.ok), null, 1));
  assert.match(r.checks.find((c) => c.name === "watertight").table.join("\n"), /piece_head: .* 4 open edges \(4 native\)/);
});

test("flipped winding: native when the source has it at the same edges, introduced when the cut made it", () => {
  const f = fixture({ nativeFlip: true });
  const nat = validate(f.glb, f.manifest, { source: f.source });
  assert.deepEqual(failed(nat), [], JSON.stringify(nat.checks.filter((c) => !c.ok), null, 1));
  assert.match(nat.checks.find((c) => c.name === "orientation").summary, /3 flipped edge\(s\) native to the source; none introduced/);
  const g = fixture({ introFlip: true });
  const intro = validate(g.glb, g.manifest, { source: g.source });
  assert.deepEqual(failed(intro), ["orientation"]);
  assert.match(intro.checks.find((c) => c.name === "orientation").details.join("\n"), /piece_head: 3 edge\(s\) traversed in the same direction.*introduced by the cut/);
});

test("surfaceReport and --self count the defects a surface already has", () => {
  const plain = fixture({ nativeHole: true });
  const rep = surfaceReport(plain.source);
  assert.equal(rep.flipped_edges, 0);
  assert.ok(rep.open_edges >= 3);
  const flipped = fixture({ nativeFlip: true });
  assert.equal(surfaceReport(flipped.source).flipped_edges, 3);
  const dir = mkdtempSync(join(tmpdir(), "cutval-self-"));
  writeFileSync(join(dir, "src.glb"), flipped.source);
  const res = spawnSync("node", [TOOL, join(dir, "src.glb"), "--self"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /flipped-winding edges 3/);
  assert.match(res.stdout, /open edges \d+, over-used edges \d+/);
});
