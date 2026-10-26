// V3's asks after the M5 wire: three-rig places a cut bone on its capsule joint; rd.awake says when a body is asleep; cut() is cheap in the package.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { createPhysics } from "../src/index.mjs";
import { createThreeRig } from "../src/three-rig.mjs";

const body = JSON.parse(readFileSync(new URL("../data/bodies/minotaur.measure.json", import.meta.url), "utf8"));
const TICK = 1 / 60;

test("a cut head bone leaves its parent: it ends at the head capsule's joint, far from where the neck would hold it", async () => {
  const p = await createPhysics({ seed: 1 });
  const rd = p.createRagdoll(body);
  const root = new THREE.Group(), bones = {};
  rd.row.roles.forEach((r) => {
    const b = new THREE.Object3D(), pp = r.parent ? rd.row.roles.find((x) => x.id === r.parent).rest.pivot : [0, 0, 0];
    b.position.set(r.rest.pivot[0] - pp[0], r.rest.pivot[1] - pp[1], r.rest.pivot[2] - pp[2]);
    (r.parent ? bones[r.parent] : root).add(b);
    bones[r.id] = b;
  });
  root.updateMatrixWorld(true);
  const rig = createThreeRig(THREE, rd, bones, root);
  for (let t = 0; t < 30; t++) { rig.drive(); p.step(TICK); }
  rd.cut("head", { impulse: [0, 8, -10] });
  for (let t = 0; t < 90; t++) p.step(TICK);
  rig.applyPose();
  const hi = rd.partIds.indexOf("head"), pose = rd.readPose(), role = rd.row.roles[hi];
  const bonePos = bones.head.getWorldPosition(new THREE.Vector3());
  // the head capsule has moved well away from the neck; the bone must follow its capsule joint (within a head's length of the capsule centre)
  const neck = bones.neck.getWorldPosition(new THREE.Vector3());
  assert.ok(bonePos.distanceTo(neck) > 0.15, `the head bone stayed on the neck (${bonePos.distanceTo(neck)} m)`);
  assert.ok(Math.hypot(bonePos.x - pose[hi * 10], bonePos.y - pose[hi * 10 + 1], bonePos.z - pose[hi * 10 + 2]) < role.length_m + 0.1, "the head bone follows the head capsule");
  p.destroy();
});

test("rd.awake: true while moving, false once a frozen corpse sleeps, true again when a piece is cut", async () => {
  const p = await createPhysics({ seed: 1 });
  const rd = p.createRagdoll(body);
  assert.equal(rd.awake, true);
  rd.kill({ part: "spine2", impulse: [0, 0, 60] });
  for (let t = 0; t < 700; t++) p.step(TICK);
  assert.equal(rd.state, "frozen");
  assert.equal(rd.awake, false);
  rd.cut("arm_right", { impulse: [0, 3, 0] });
  assert.equal(rd.awake, true);
  p.destroy();
});

test("cut() itself is cheap in the package (a few ms at most even on a loaded box): a spike on the cut frame is the skin carving, not the physics", async () => {
  const p = await createPhysics({ seed: 1 });
  const rd = p.createRagdoll(body);
  for (let t = 0; t < 60; t++) p.step(TICK);
  const t0 = performance.now();
  rd.cut("head", { helmet: true });
  const ms = performance.now() - t0;
  console.log(`# cut("head", helmet) took ${ms.toFixed(2)} ms`);
  assert.ok(ms < 12, `cut() took ${ms} ms`);
  p.destroy();
});
