// kachujin-106: V3 boss Kachujin (Frankendom-v3 PR 227, mixamo-106 rig). Ships with the 20-role ragdoll only; the cut row is the interim BLOCKED row until the
// rigid-accessory feature merges (the source is a layered skirt/sash/hem body whose section loops do not nest). The GLB stays out of git.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPhysics, generateRow, loadTable } from "../src/index.mjs";

const rd_ = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));
const ROLES20 = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "LeftArm", "LeftForeArm", "LeftHand", "RightArm", "RightForeArm", "RightHand",
  "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase", "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"];
const m = () => rd_("bodies/kachujin-106.measure.json");

test("kachujin-106 measure row: 20 joints, Spine1 between Spine and Spine2, toes ahead of and below the ankle, on their own side", () => {
  const row = m(), J = row.joints;
  assert.deepEqual(Object.keys(J).sort(), [...ROLES20].sort());
  assert.ok(J.Spine[1] < J.Spine1[1] && J.Spine1[1] < J.Spine2[1], "Spine1 sits between Spine and Spine2");
  for (const S of ["Left", "Right"]) {
    const sign = S === "Left" ? 1 : -1;
    assert.ok(J[S + "ToeBase"][1] < J[S + "Foot"][1], S + " toe below ankle");
    assert.ok(J[S + "ToeBase"][2] > J[S + "Foot"][2] + 0.05, S + " toe ahead of ankle");
    assert.ok(sign * J[S + "ToeBase"][0] > 0, S + " toe on its own side");
    assert.ok(sign * J[S + "Arm"][0] > 0, S + " arm on its own side");
  }
  assert.equal(Math.min(J.LeftToeBase[1], J.RightToeBase[1]), 0, "floor-lifted: the lowest toe is on y = 0");
  assert.ok(row.foot_len > 0.1 && row.foot_len < 0.35, "foot_len " + row.foot_len);
  assert.ok(row.height_m > 1.7 && row.height_m < 2.1, "height " + row.height_m);
  assert.match(row.source, /kachujin-106\.glb .*mixamo-106/);
});

test("kachujin-106: generated row has 20 finite parts and a sane mass", () => {
  const row = generateRow("kachujin-106", m(), loadTable());
  assert.equal(row.roles.length, 20);
  for (const r of row.roles) for (const v of [r.radius_m, r.half_height_m, r.length_m, r.mass_kg]) assert.ok(Number.isFinite(v) && v > 0, r.id);
  assert.ok(row.total_mass_kg > 40 && row.total_mass_kg < 120, "mass " + row.total_mass_kg);
});

test("kachujin-106 fall trace: dies, falls, freezes; hips low, speed bounded, nothing below the floor, all finite", async () => {
  const p = await createPhysics({ seed: 1 });
  const rd = p.createRagdoll(m(), { id: "kachujin-106" });
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
  console.log(`kachujin fall trace: hips_rest=${hips0.toFixed(3)} hips_end=${pose[1].toFixed(3)} max_part_speed=${maxSpeed.toFixed(2)} m/s lowest_part_y=${lowest.toFixed(3)} state=${rd.state}`);
  assert.ok(pose[1] < 0.3, "hips at " + pose[1]);
  assert.ok(maxSpeed < 25, "max part speed " + maxSpeed);
  assert.ok(lowest > -0.05, "a part went through the floor: " + lowest);
  assert.equal(rd.state, "frozen");
  p.destroy();
});

// the interim BLOCKED cut row (no expect_sha256): the batch must report exactly these failing checks, so a fixed source turns the row into a flagged "unblocked" one
test("cut-bodies.json: kachujin-106 has a blocked row (mixamo-106) with the failing checks the batch measured, and no expect_sha256", async () => {
  const { loadRows } = await import("../tools/cut-batch.mjs");
  const r = loadRows(new URL("../data/cut-bodies.json", import.meta.url).pathname).bodies.find((x) => x.name === "kachujin-106");
  assert.ok(r, "kachujin-106 row");
  assert.equal(r.source, "kachujin-106.glb");
  assert.equal(r.rig_map, "data/rig-maps/mixamo-106.json");
  assert.deepEqual(r.blocked_checks, ["watertight", "orientation", "planes"]);
  assert.equal(r.expect_sha256, undefined, "a blocked row carries no expected hash");
  assert.ok(r.blocked.length > 100, "blocked cause is spelled out");
  assert.match(r.blocked, /skirt|sash/, "names the overlapping layers");
  assert.ok(rd_(r.measure.replace(/^data\//, "")).joints, "measure row exists");
});
