// The V3 bodies (65-joint rig, measure rows derived from the GLBs by tools/glb-measure.mjs) build, hold their pose, and die cleanly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPhysics } from "../src/index.mjs";

import { generateRow, loadTable } from "../src/index.mjs";

// the ragdoll's capsule lengths must match the lengths measured from the GLB joints (the row is what the game's body really is)
for (const name of ["minotaur", "psyche", "warrior", "veteran", "minotaur-106", "psyche-106", "gargantua-106", "arachne-106", "demon-106", "warrok-106", "brute-106", "maw-106"]) {
  test(`${name}: ragdoll part lengths match the measured bone lengths`, () => {
    const m = JSON.parse(readFileSync(new URL(`../data/bodies/${name}.measure.json`, import.meta.url), "utf8"));
    const row = generateRow(name, m, loadTable());
    const len = (id) => row.roles.find((r) => r.id === id).length_m;
    const pairs = [["armLeft", m.upper_arm_len], ["forearmLeft", m.forearm_len], ["thighLeft", m.thigh_len], ["shinLeft", m.shin_len], ["neck", m.neck_len]];
    for (const [id, measured] of pairs) assert.ok(Math.abs(len(id) - measured) / measured < 0.12, `${name} ${id}: ragdoll ${len(id)} m vs measured ${measured} m`);
  });
}

for (const name of ["minotaur", "psyche", "warrior", "veteran", "minotaur-106", "psyche-106", "gargantua-106", "arachne-106", "demon-106", "warrok-106", "brute-106", "maw-106"]) {
  const body = JSON.parse(readFileSync(new URL(`../data/bodies/${name}.measure.json`, import.meta.url), "utf8"));
  test(`${name}: holds its rest pose (hips kinematic), then dies and freezes on the floor`, async () => {
    const p = await createPhysics({ seed: 1 });
    const rd = p.createRagdoll(body, { id: name });
    assert.equal(rd.partIds.length, 20);
    const p0 = Float32Array.from(rd.readPose());
    for (let t = 0; t < 120; t++) p.step(1 / 60);
    const p1 = rd.readPose();
    let worst = 0;
    for (let i = 0; i < 20; i++) worst = Math.max(worst, Math.hypot(p1[i * 10] - p0[i * 10], p1[i * 10 + 1] - p0[i * 10 + 1], p1[i * 10 + 2] - p0[i * 10 + 2]));
    assert.ok(worst < 0.12, `${name}: a part drifted ${worst} m`);
    rd.kill({ part: "spine2", impulse: [0, 0, 60] });
    for (let t = 0; t < 600; t++) p.step(1 / 60);
    const pose = rd.readPose();
    for (const v of pose) assert.ok(Number.isFinite(v));
    assert.ok(pose[1] < 0.3, `${name}: hips at ${pose[1]} m`);
    assert.equal(rd.state, "frozen");
    p.destroy();
  });
}
