// V3's asks: states override rows, motor gain, snapToTarget, reset, three-rig bind source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { createPhysics } from "../src/index.mjs";
import { createThreeRig } from "../src/three-rig.mjs";
import { qmul } from "../src/math.mjs";

const body = JSON.parse(readFileSync(new URL("../data/bodies/minotaur.measure.json", import.meta.url), "utf8"));
const TICK = 1 / 60;
const armsDown = (rd, deg) => {
  const q = new Float32Array(rd.row.roles.length * 4);
  rd.row.roles.forEach((r, i) => {
    let v = r.rest.quat;
    if (/^(arm|forearm|hand)(Left|Right)$/.test(r.id)) { const h = (((r.side === "Left" ? -1 : 1) * deg * Math.PI) / 180) / 2; v = qmul([0, 0, Math.sin(h), Math.cos(h)], v); }
    q.set(v, i * 4);
  });
  return q;
};

test("createPhysics({ states }) overrides the package rows key by key", async () => {
  const p = await createPhysics({ seed: 1, states: { stagger: { hold_s: 0.2 } } });
  const rd = p.createRagdoll(body);
  rd.stagger();
  for (let t = 0; t < Math.round((0.05 + 0.2 + 0.35) / TICK) + 3; t++) p.step(TICK);
  assert.equal(rd.state, "alive", "0.2 s hold should be over after 0.6 s");
  p.destroy();
});

test("motor gain: stable at 1, 2, 4 and 8 and the tracking error of a fast arm swing (2 Hz, +-50 degrees) is reported", async () => {
  const err = {};
  for (const g of [1, 2, 4, 8]) {
    const p = await createPhysics({ seed: 1 });
    const rd = p.createRagdoll(body, { motorGain: g });
    const i = rd.partIds.indexOf("armLeft");
    let sum = 0, cnt = 0;
    for (let t = 0; t < 120; t++) {
      const deg = 50 * Math.sin(2 * Math.PI * 2 * t * TICK), tq = armsDown(rd, deg);
      rd.setTargetPose(tq);
      p.step(TICK);
      if (t >= 30) {
        const pose = rd.readPose(), a = [pose[i * 10 + 3], pose[i * 10 + 4], pose[i * 10 + 5], pose[i * 10 + 6]], b = Array.from(tq.subarray(i * 4, i * 4 + 4));
        sum += (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180) / Math.PI; cnt++;
        for (const v of pose) assert.ok(Number.isFinite(v), `gain ${g}: NaN`);
      }
    }
    err[g] = +(sum / cnt).toFixed(2);
    p.destroy();
  }
  console.log("# mean arm tracking error (deg) by motor gain:", JSON.stringify(err));
  const errD = {};
  for (const [g, d] of [[2, 0.5], [2, 0.25], [4, 0.5], [4, 0.25]]) {
    const p = await createPhysics({ seed: 1 });
    const rd = p.createRagdoll(body, { motorGain: g, motorDamping: d });
    const i = rd.partIds.indexOf("armLeft");
    let sum = 0, cnt = 0, finite = true;
    for (let t = 0; t < 120; t++) {
      const tq = armsDown(rd, 50 * Math.sin(2 * Math.PI * 2 * t * TICK));
      rd.setTargetPose(tq); p.step(TICK);
      if (t >= 30) {
        const pose = rd.readPose(), a = [pose[i * 10 + 3], pose[i * 10 + 4], pose[i * 10 + 5], pose[i * 10 + 6]], b = Array.from(tq.subarray(i * 4, i * 4 + 4));
        sum += (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180) / Math.PI; cnt++;
        for (const v of pose) if (!Number.isFinite(v)) finite = false;
      }
    }
    errD[`gain ${g} damping ${d}`] = finite ? +(sum / cnt).toFixed(2) : "NaN";
    p.destroy();
  }
  console.log("# with less damping:", JSON.stringify(errD));
  assert.ok(Math.min(err[2], err[4]) < err[1], `a higher gain should track a fast swing closer: ${JSON.stringify(err)}`);
});

test("snapToTarget puts the capsules on the target pose at once", async () => {
  const p = await createPhysics({ seed: 1 });
  const rd = p.createRagdoll(body);
  const t = armsDown(rd, 60), yHandBefore = rd.readPose()[rd.partIds.indexOf("handLeft") * 10 + 1];
  rd.setRoot(Array.from(rd.readPose().slice(0, 3)), Array.from(t.subarray(0, 4)));
  rd.setTargetPose(t);
  assert.equal(rd.snapToTarget(), true);
  const pose = rd.readPose(), i = rd.partIds.indexOf("armLeft");
  const a = [pose[i * 10 + 3], pose[i * 10 + 4], pose[i * 10 + 5], pose[i * 10 + 6]], b = Array.from(t.subarray(i * 4, i * 4 + 4));
  assert.ok(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) > 0.9999, "arm orientation on target");
  const j = rd.partIds.indexOf("handLeft");
  assert.ok(pose[j * 10 + 1] < yHandBefore - 0.2, `the left hand drops from ${yHandBefore} to ${pose[j * 10 + 1]} after the snap`);
  p.destroy();
});

test("reset returns a killed ragdoll to alive at the spawn pose; after a cut it says no", async () => {
  const p = await createPhysics({ seed: 1 });
  const rd = p.createRagdoll(body);
  const p0 = Array.from(rd.readPose().slice(0, 3));
  rd.kill({ part: "spine2", impulse: [0, 0, 60] });
  for (let t = 0; t < 200; t++) p.step(TICK);
  assert.equal(rd.reset(), true);
  assert.equal(rd.state, "alive");
  const h = rd.readPose();
  assert.ok(Math.hypot(h[0] - p0[0], h[1] - p0[1], h[2] - p0[2]) < 1e-4);
  rd.cut("head");
  assert.equal(rd.reset(), false);
  p.destroy();
});

test("three-rig accepts a bind-pose source separate from the live (animated) rig", async () => {
  const p = await createPhysics({ seed: 1 });
  const rd = p.createRagdoll(body);
  const build = () => {
    const root = new THREE.Group(), bones = {};
    rd.row.roles.forEach((r) => {
      const b = new THREE.Object3D(), pp = r.parent ? rd.row.roles.find((x) => x.id === r.parent).rest.pivot : [0, 0, 0];
      b.position.set(r.rest.pivot[0] - pp[0], r.rest.pivot[1] - pp[1], r.rest.pivot[2] - pp[2]);
      (r.parent ? bones[r.parent] : root).add(b);
      bones[r.id] = b;
    });
    root.updateMatrixWorld(true);
    return { root, bones };
  };
  const bind = build(), live = build();
  live.bones.armLeft.rotation.z = -1; // the live rig is already animated when the rig is built
  live.root.updateMatrixWorld(true);
  const rig = createThreeRig(THREE, rd, live.bones, live.root, { bind });
  const h0 = Array.from(rd.readPose().slice(0, 3));
  for (let t = 0; t < 30; t++) { rig.drive(); p.step(TICK); }
  const h1 = rd.readPose();
  assert.ok(Math.hypot(h1[0] - h0[0], h1[1] - h0[1], h1[2] - h0[2]) < 0.03, "hips stayed put");
  p.destroy();
});
