// hale-pitborn: the Armagedom player Hale shares the 65-joint UE-style body (rig map v1-65). The 20-role ragdoll comes straight from the measure row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPhysics, generateRow, loadTable } from "../src/index.mjs";

const rd_ = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));
const ROLES20 = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "LeftArm", "LeftForeArm", "LeftHand", "RightArm", "RightForeArm", "RightHand",
  "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase", "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"];
const m = () => rd_("bodies/hale-pitborn.measure.json");

test("hale-pitborn measure row: 20 joints, Spine1 between Spine and Spine2, toes ahead of and below the ankle, on their own side", () => {
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
  assert.ok(row.height_m > 1.5 && row.height_m < 2.0, "height " + row.height_m);
  assert.match(row.source, /hale-pitborn\.glb .*v1-65/);
});

test("hale-pitborn: generated row has 20 finite parts and a sane mass", () => {
  const row = generateRow("hale-pitborn", m(), loadTable());
  assert.equal(row.roles.length, 20);
  for (const r of row.roles) for (const v of [r.radius_m, r.half_height_m, r.length_m, r.mass_kg]) assert.ok(Number.isFinite(v) && v > 0, r.id);
  assert.ok(row.total_mass_kg > 40 && row.total_mass_kg < 120, "mass " + row.total_mass_kg);
});

test("hale-pitborn fall trace: dies, falls, freezes; hips low, speed bounded, nothing below the floor, all finite", async () => {
  const p = await createPhysics({ seed: 1 });
  const rd = p.createRagdoll(m(), { id: "hale-pitborn" });
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
  console.log(`hale fall trace: hips_rest=${hips0.toFixed(3)} hips_end=${pose[1].toFixed(3)} max_part_speed=${maxSpeed.toFixed(2)} m/s lowest_part_y=${lowest.toFixed(3)} state=${rd.state}`);
  assert.ok(pose[1] < 0.3, "hips at " + pose[1]);
  assert.ok(maxSpeed < 25, "max part speed " + maxSpeed);
  assert.ok(lowest > -0.05, "a part went through the floor: " + lowest);
  assert.equal(rd.state, "frozen");
  p.destroy();
});

// the committed cut rows for the two Armagedom player bodies (the sources are confidential and stay out of git; the rows are what the VPS batch reads)
test("cut-bodies.json: vagrant-106 (mixamo-19) and hale-pitborn (v1-65) have rows whose maps and measure rows exist, blocked with the checks the batch expects", async () => {
  const { loadRows } = await import("../tools/cut-batch.mjs");
  const rows = loadRows(new URL("../data/cut-bodies.json", import.meta.url).pathname).bodies;
  const want = { "vagrant-106": ["data/rig-maps/mixamo-19.json", ["watertight"]], "hale-pitborn": ["data/rig-maps/v1-65.json", ["watertight", "orientation"]] };
  for (const [name, [map, checks]] of Object.entries(want)) {
    const r = rows.find((x) => x.name === name);
    assert.ok(r, name + " row");
    assert.equal(r.rig_map, map);
    assert.deepEqual(r.blocked_checks, checks);
    assert.ok(r.blocked.length > 100, name + " blocked cause is spelled out");
    assert.ok(rd_(r.measure.replace(/^data\//, "")).joints, name + " measure row exists");
  }
  assert.deepEqual(rows.find((x) => x.name === "vagrant-106").overrides, { hair_materials: [] }, "the default hair pattern matches 'browser' in every Vagrant material");
});
