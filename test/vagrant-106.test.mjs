// vagrant-106: the Armagedom Vagrant is a 19-joint Mixamo skeleton (no Spine1 skin joint, no toes). The 20-role body still works:
// Spine1 is the bind-pose pass-through node Mixamo keeps between Spine and Spine2, and the toes are synthesised from the Foot bone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPhysics, generateRow, loadTable } from "../src/index.mjs";

const rd_ = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));
const ROLES20 = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "LeftArm", "LeftForeArm", "LeftHand", "RightArm", "RightForeArm", "RightHand",
  "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase", "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"];

test("rig map mixamo-19: all 20 roles; Spine1 is a node; toes are derived from the Foot bone", () => {
  const map = rd_("rig-maps/mixamo-19.json");
  assert.equal(map.schema, "rig-map/1");
  assert.deepEqual(Object.keys(map.joints).sort(), [...ROLES20].sort());
  assert.equal(map.joints.Spine1, "mixamorig:Spine1");
  for (const S of ["Left", "Right"]) {
    const t = map.joints[S + "ToeBase"];
    assert.equal(typeof t, "object");
    assert.equal(t.node, `mixamorig:${S}Foot`);
    assert.ok(t.along_local_y_m > 0.1 && t.along_local_y_m < 0.35, "toe offset along the foot bone, metres");
  }
});

const m = () => rd_("bodies/vagrant-106.measure.json");

test("vagrant-106 measure row: 20 joints, Spine1 between Spine and Spine2, toes ahead of and below the ankle", () => {
  const row = m(), J = row.joints;
  assert.deepEqual(Object.keys(J).sort(), [...ROLES20].sort());
  assert.ok(J.Spine[1] < J.Spine1[1] && J.Spine1[1] < J.Spine2[1], "Spine1 sits between Spine and Spine2");
  for (const S of ["Left", "Right"]) {
    const sign = S === "Left" ? 1 : -1;
    assert.ok(J[S + "ToeBase"][1] < J[S + "Foot"][1], S + " toe below ankle");
    assert.ok(J[S + "ToeBase"][2] > J[S + "Foot"][2] + 0.05, S + " toe ahead of ankle");
    assert.ok(sign * J[S + "ToeBase"][0] > 0, S + " toe on its own side");
  }
  assert.ok(row.foot_len > 0.1 && row.foot_len < 0.35, "foot_len " + row.foot_len);
  assert.ok(row.height_m > 1.7 && row.height_m < 2.2, "height " + row.height_m);
});

test("vagrant-106: generated row has 20 finite parts and a sane mass", () => {
  const row = generateRow("vagrant-106", m(), loadTable());
  assert.equal(row.roles.length, 20);
  for (const r of row.roles) for (const v of [r.radius_m, r.half_height_m, r.length_m, r.mass_kg]) assert.ok(Number.isFinite(v) && v > 0, r.id);
  assert.ok(row.total_mass_kg > 50 && row.total_mass_kg < 120, "mass " + row.total_mass_kg);
});

test("vagrant-106 fall trace: dies, falls, freezes; hips low, speed bounded, nothing below the floor, all finite", async () => {
  const p = await createPhysics({ seed: 1 });
  const rd = p.createRagdoll(m(), { id: "vagrant-106" });
  assert.equal(rd.partIds.length, 20);
  for (let t = 0; t < 60; t++) p.step(1 / 60);
  const hips0 = rd.readPose()[1];
  rd.kill({ part: "spine2", impulse: [0, 0, 60] });
  let maxSpeed = 0, prev = Float32Array.from(rd.readPose());
  for (let t = 0; t < 600; t++) {
    p.step(1 / 60);
    const q = rd.readPose();
    for (let i = 0; i < 20; i++) maxSpeed = Math.max(maxSpeed, Math.hypot(q[i * 10] - prev[i * 10], q[i * 10 + 1] - prev[i * 10 + 1], q[i * 10 + 2] - prev[i * 10 + 2]) * 60);
    prev = Float32Array.from(q);
  }
  const pose = rd.readPose();
  let lowest = Infinity;
  for (let i = 0; i < 20; i++) lowest = Math.min(lowest, pose[i * 10 + 1]);
  for (const v of pose) assert.ok(Number.isFinite(v));
  console.log(`vagrant fall trace: hips_rest=${hips0.toFixed(3)} hips_end=${pose[1].toFixed(3)} max_part_speed=${maxSpeed.toFixed(2)} m/s lowest_part_y=${lowest.toFixed(3)} state=${rd.state}`);
  assert.ok(pose[1] < 0.3, "hips at " + pose[1]);
  assert.ok(maxSpeed < 25, "max part speed " + maxSpeed);
  assert.ok(lowest > -0.05, "a part went through the floor: " + lowest);
  assert.equal(rd.state, "frozen");
  p.destroy();
});

// glb-measure input validation: bad {node, along_local_y_m} specs fail with a message naming the role (run the tool on a tiny synthetic GLB)
function runMeasure(joints) {
  const dir = mkdtempSync(join(tmpdir(), "glbm-"));
  const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, nodes: [{ name: "A", children: [1] }, { name: "B", translation: [0, 1, 0] }] }));
  const pad = Buffer.alloc((4 - (json.length % 4)) % 4, 0x20), body = Buffer.concat([json, pad]);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + body.length, 8); head.writeUInt32LE(body.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  writeFileSync(join(dir, "t.glb"), Buffer.concat([head, body]));
  writeFileSync(join(dir, "map.json"), JSON.stringify({ joints }));
  return spawnSync(process.execPath, [fileURLToPath(new URL("../tools/glb-measure.mjs", import.meta.url)), join(dir, "t.glb"), join(dir, "map.json")], { encoding: "utf8" });
}

for (const [label, spec, msg] of [
  ["missing along_local_y_m", { node: "B" }, /LeftToeBase.*along_local_y_m/],
  ["non-finite along_local_y_m", { node: "B", along_local_y_m: "x" }, /LeftToeBase.*along_local_y_m/],
  ["missing node", { along_local_y_m: 0.2 }, /LeftToeBase.*node/],
  ["empty node", { node: "", along_local_y_m: 0.2 }, /LeftToeBase.*node/],
  ["null entry", null, /LeftToeBase/],
  ["array entry", ["B"], /LeftToeBase/],
  ["unknown node", { node: "Nope", along_local_y_m: 0.2 }, /LeftToeBase.*Nope/],
]) {
  test(`glb-measure rejects a map entry with ${label}`, () => {
    const r = runMeasure({ LeftToeBase: spec });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, msg);
    assert.doesNotMatch(r.stderr, /TypeError|undefined/);
  });
}

test("glb-measure still accepts a plain string entry (old path)", () => {
  const r = runMeasure({ LeftToeBase: "B" });
  assert.doesNotMatch(r.stderr, /rig has no node|along_local_y_m/);
});
