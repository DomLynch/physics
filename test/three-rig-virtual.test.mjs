// three-rig on chain bodies with VIRTUAL parts (no bone) and FOLLOWER bones (copy a driver bone's rotation): the centipede wiring in one call (chainRigOptions).
// The bodies without either (salamander, spider) must give the same pose output with and without the new options.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createPhysics, loadChainBody, chainRigOptions } from "../src/index.mjs";
import { createThreeRig } from "../src/three-rig.mjs";

// a fake model for a chain body: one Object3D per driven part (parented to the nearest driven ancestor, offset by the pivots), one per follower bone (a child of the root)
function fakeModel(body, rd, rootInit) {
  const root = new THREE.Group();
  rootInit?.(root);
  const bones = new Map(), made = {};
  const find = (name) => {
    if (!bones.has(name)) bones.set(name, new THREE.Object3D());
    return bones.get(name);
  };
  const roles = rd.row.roles, byId = Object.fromEntries(roles.map((r) => [r.id, r]));
  const virt = new Set(body.virtualParts);
  const driven = (id) => { let r = byId[id]; while (r && virt.has(r.id)) r = byId[r.parent]; return r; };
  for (const r of roles) {
    if (virt.has(r.id)) continue;
    const o = find(body.boneMap[r.id]);
    const anc = r.parent ? driven(r.parent) : null;
    const pp = anc ? anc.rest.pivot : [0, 0, 0];
    o.position.set(r.rest.pivot[0] - pp[0], r.rest.pivot[1] - pp[1], r.rest.pivot[2] - pp[2]);
    (anc ? made[anc.id] : root).add(o);
    made[r.id] = o;
  }
  for (const [part, names] of Object.entries(body.followMap)) for (const n of names) {
    const o = find(n);
    o.position.set(...byId[part].rest.pivot);
    root.add(o);
  }
  root.updateMatrixWorld(true);
  return { root, find };
}
const qdiff = (a, b) => 1 - Math.abs(a.clone().normalize().dot(b.clone().normalize())); // the pose quaternions are float32, not exactly unit
const hit = (rd, z) => rd.kill({ part: rd.row.roles[1].id, impulse: [0, 0, z] });

async function centipede() {
  const p = await createPhysics({ seed: 3 });
  const body = loadChainBody("centipede");
  const rd = p.createRagdoll(body.row, { id: "c" });
  const { root, find } = fakeModel(body, rd, (r) => { r.position.set(2, 0, -1); r.rotation.y = 0.7; });
  const ro = chainRigOptions(body, find);
  const rig = createThreeRig(THREE, rd, ro.bones, root, ro.options);
  return { p, body, rd, root, find, ro, rig };
}

test("centipede: virtual parts do not throw, drive() and applyPose() run, virtual parts still simulate", async () => {
  const { p, body, rd, ro, rig } = await centipede();
  assert.deepEqual(body.virtualParts, ["seg1", "seg4", "seg6"]);
  for (const id of body.virtualParts) assert.equal(ro.bones[id], undefined, "no bone for " + id);
  const p0 = Array.from(rd.readPose());
  for (let t = 0; t < 30; t++) { rig.drive(); p.step(1 / 60); }
  hit(rd, 200);
  for (let t = 0; t < 90; t++) { p.step(1 / 60); rig.applyPose(); }
  const p1 = rd.readPose();
  const i = rd.row.roles.findIndex((r) => r.id === "seg4");
  for (let k = 0; k < 7; k++) assert.ok(Number.isFinite(p1[i * 10 + k]));
  assert.ok(Math.hypot(p1[i * 10] - p0[i * 10], p1[i * 10 + 1] - p0[i * 10 + 1], p1[i * 10 + 2] - p0[i * 10 + 2]) > 1e-3, "the virtual segment moved with the fall");
  p.destroy();
});

test("centipede: without the options the old error stands (no bone for part seg1)", async () => {
  const p = await createPhysics({ seed: 3 });
  const body = loadChainBody("centipede"), rd = p.createRagdoll(body.row, { id: "c" });
  const { root, find } = fakeModel(body, rd);
  const ro = chainRigOptions(body, find);
  assert.throws(() => createThreeRig(THREE, rd, ro.bones, root), /no bone for part seg1/);
  p.destroy();
});

test("centipede: after applyPose every follower ends with its driver's local rotation (and the drivers moved)", async () => {
  const { p, body, rd, rig, find } = await centipede();
  for (let t = 0; t < 20; t++) { rig.drive(); p.step(1 / 60); }
  hit(rd, 300);
  for (let t = 0; t < 120; t++) { p.step(1 / 60); rig.applyPose(); }
  let checked = 0, moved = 0;
  for (const [part, names] of Object.entries(body.followMap)) {
    const driver = find(body.boneMap[part]);
    if (qdiff(driver.quaternion, new THREE.Quaternion()) > 1e-4) moved++;
    for (const n of names) { assert.ok(qdiff(find(n).quaternion, driver.quaternion) < 1e-9, `${n} follows ${part}`); checked++; }
  }
  assert.equal(checked, 10);
  assert.ok(moved >= 5, "the banks rotated in the fall, so the check is not vacuous");
  p.destroy();
});

test("followers are refreshed in the same applyPose call: a follower's world rotation matches its driver's", async () => {
  const { p, body, rd, rig, find } = await centipede();
  hit(rd, 300);
  for (let t = 0; t < 60; t++) p.step(1 / 60);
  rig.applyPose();
  const f = find(body.followMap.bank3L[0]), d = find(body.boneMap.bank3L);
  assert.ok(qdiff(f.quaternion, d.quaternion) < 1e-9);
  // the follower hangs off the root: its stored world matrix must already equal root * local rotation (refreshed after the copy, no updateMatrixWorld by the caller)
  const stored = new THREE.Quaternion().setFromRotationMatrix(f.matrixWorld);
  const expect = f.parent.getWorldQuaternion(new THREE.Quaternion()).multiply(f.quaternion);
  assert.ok(qdiff(stored, expect) < 1e-9);
  p.destroy();
});

test("chainRigOptions: bones are the driven parts only, options carry virtual ids and follow objects; bind is passed through", () => {
  const body = loadChainBody("centipede");
  const find = (n) => ({ name: n });
  const ro = chainRigOptions(body, find);
  assert.deepEqual(Object.keys(ro.bones).sort(), Object.keys(body.boneMap).sort());
  assert.deepEqual(ro.options.virtual, ["seg1", "seg4", "seg6"]);
  assert.deepEqual(Object.keys(ro.options.follow).sort(), Object.keys(body.followMap).sort());
  assert.equal(ro.options.follow.bank2L[0].name, "leg_0L");
  assert.equal(ro.options.bind, undefined);
  const rb = chainRigOptions(body, find, { bindFind: (n) => ({ name: "b_" + n }), bindRoot: "R" });
  assert.equal(rb.options.bind.bones.seg3.name, "b_body");
  assert.equal(rb.options.bind.root, "R");
  assert.throws(() => chainRigOptions(body, () => null), /model has no bone/);
  const sal = chainRigOptions(loadChainBody("salamander"), find);
  assert.deepEqual(sal.options.virtual, []);
  assert.deepEqual(sal.options.follow, {});
});

test("salamander, spider and roach: pose output is identical with and without the (empty) new options", async () => {
  for (const name of ["salamander", "spider", "roach"]) {
    const run = async (useOpts) => {
      const p = await createPhysics({ seed: 5 });
      const body = loadChainBody(name), rd = p.createRagdoll(body.row, { id: "x" });
      const { root, find } = fakeModel(body, rd, (r) => { r.position.set(1, 0, 2); r.rotation.y = 0.4; });
      const ro = chainRigOptions(body, find);
      const rig = useOpts ? createThreeRig(THREE, rd, ro.bones, root, ro.options) : createThreeRig(THREE, rd, ro.bones, root);
      for (let t = 0; t < 20; t++) { rig.drive(); p.step(1 / 60); }
      hit(rd, 200);
      for (let t = 0; t < 80; t++) { p.step(1 / 60); rig.applyPose(); }
      const out = [];
      root.traverse((o) => out.push(...o.quaternion.toArray(), ...o.position.toArray()));
      p.destroy();
      return out;
    };
    assert.deepEqual(await run(true), await run(false), name);
  }
});

test("errors at creation: unknown virtual id, virtual root, unknown follow driver, follower of a virtual part, follower that is not an object, follow not an array", async () => {
  const { p, rd, root, ro } = await centipede();
  const make = (mut) => { const o = { ...ro.options, virtual: [...ro.options.virtual], follow: { ...ro.options.follow } }; const b = { ...ro.bones }; mut(o, b); return () => createThreeRig(THREE, rd, b, root, o); };
  assert.throws(make((o) => { o.virtual.push("nope"); }), /unknown virtual part nope/);
  assert.throws(make((o, b) => { o.virtual.push("seg3"); delete b.seg3; }), /root part seg3 cannot be virtual/);
  assert.throws(make((o) => { o.follow.nope = [new THREE.Object3D()]; }), /unknown follow driver nope/);
  assert.throws(make((o) => { o.follow.seg1 = [new THREE.Object3D()]; }), /follow driver seg1 is virtual/);
  assert.throws(make((o) => { o.follow.bank1L = ["leg_c0L"]; }), /follower of bank1L is not an Object3D/);
  assert.throws(make((o) => { o.follow.bank1L = "x"; }), /follow\.bank1L must be an array/);
  p.destroy();
});
