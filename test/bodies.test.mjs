// The V3 bodies (65-joint rig, measure rows derived from the GLBs by tools/glb-measure.mjs) build, hold their pose, and die cleanly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPhysics } from "../src/index.mjs";

for (const name of ["minotaur", "psyche"]) {
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
