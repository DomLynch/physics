// three-rig: the bones follow the ragdoll and the animated pose drives it, in a rotated and moved fighter frame.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { createPhysics } from "../src/index.mjs";
import { createThreeRig } from "../src/three-rig.mjs";

const body = JSON.parse(readFileSync(new URL("../data/bodies/minotaur.measure.json", import.meta.url), "utf8"));

function setup(p) {
  const rd = p.createRagdoll(body);
  const root = new THREE.Group();
  root.position.set(3, 0, -2);
  root.rotation.y = 0.9;
  const bones = {};
  rd.row.roles.forEach((r) => {
    const b = new THREE.Object3D();
    const par = r.parent ? bones[r.parent] : root;
    const pp = r.parent ? rd.row.roles.find((x) => x.id === r.parent).rest.pivot : [0, 0, 0];
    b.position.set(r.rest.pivot[0] - pp[0], r.rest.pivot[1] - pp[1], r.rest.pivot[2] - pp[2]);
    par.add(b);
    bones[r.id] = b;
  });
  root.updateMatrixWorld(true);
  return { rd, root, bones, rig: createThreeRig(THREE, rd, bones, root) };
}

test("drive() at the bind pose keeps the ragdoll where it is", async () => {
  const p = await createPhysics({ seed: 1 });
  const { rd, rig } = setup(p);
  const h0 = Array.from(rd.readPose().slice(0, 3));
  for (let t = 0; t < 60; t++) { rig.drive(); p.step(1 / 60); }
  const h1 = rd.readPose();
  assert.ok(Math.hypot(h1[0] - h0[0], h1[1] - h0[1], h1[2] - h0[2]) < 0.02, "hips moved");
  for (const x of h1) assert.ok(Number.isFinite(x));
  p.destroy();
});

test("applyPose() puts the hips bone on the ragdoll's hips joint and the bones fall with a dying ragdoll", async () => {
  const p = await createPhysics({ seed: 1 });
  const { rd, root, bones, rig } = setup(p);
  rd.kill({ part: "spine2", impulse: [0, 0, 60] });
  for (let t = 0; t < 240; t++) p.step(1 / 60);
  rig.applyPose();
  const pose = rd.readPose();
  const head = new THREE.Vector3(); bones.head.getWorldPosition(head);
  const headSim = root.worldToLocal(head.clone());
  assert.ok(headSim.y < 0.5, `head bone at ${headSim.y} m in the sim frame (should be on the floor)`);
  const hips = new THREE.Vector3(); bones.hips.getWorldPosition(hips);
  const hipsSim = root.worldToLocal(hips.clone());
  assert.ok(Math.abs(hipsSim.y - pose[1]) < 0.15, `hips bone ${hipsSim.y} vs capsule ${pose[1]}`);
  p.destroy();
});
