// rd.park(): a used ragdoll goes back to the pool exactly like a freshly created parked one (asleep, 500 m under the floor, rd.parked true);
// rd.acquire() then works as the first time. A cut that removed joints cannot be undone: park() returns false (destroy and recreate), same rule as reset().
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPhysics } from "../src/index.mjs";

const body = JSON.parse(readFileSync(new URL("./fixtures/body-0002.measure.json", import.meta.url), "utf8"));
const KILL = { part: "spine2", impulse: [0, 0, 60] };

async function cycle(lives) {
  const physics = await createPhysics({ seed: 3 });
  const rd = physics.createRagdoll(body, { position: [0.4, 0, 0], id: "a", parked: true });
  for (let k = 0; k < lives; k++) {
    if (k) assert.equal(rd.park(), true);
    for (let t = 0; t < 20; t++) physics.step(1 / 60); // idle in the pool
    assert.equal(rd.acquire(), true);
    for (let t = 0; t < 10; t++) physics.step(1 / 60);
    rd.kill(KILL);
    if (k < lives - 1) for (let t = 0; t < 400; t++) physics.step(1 / 60);
  }
  const hashes = [];
  for (let t = 0; t < 300; t++) { physics.step(1 / 60); hashes.push(physics.hash()); }
  const out = { hashes, pose: Array.from(rd.readPose()) };
  physics.destroy();
  return out;
}

test("acquire -> kill -> park -> acquire -> kill gives the same final pose and hash as acquire -> kill on a fresh one", async () => {
  const once = await cycle(1), twice = await cycle(2);
  assert.deepEqual(twice.pose, once.pose, "final pose");
  assert.deepEqual(twice.hashes, once.hashes, "per-tick hash");
});

test("park() after a cut that removed joints returns false and changes nothing; a visual-only cut still parks", async () => {
  const physics = await createPhysics({ seed: 1 });
  const rd = physics.createRagdoll(body, { position: [0, 0, 0], id: "a" });
  rd.cut("arm_right");
  assert.equal(rd.park(), false);
  assert.equal(rd.parked, false);
  assert.equal(rd.awake, true);
  const v = physics.createRagdoll(body, { position: [2, 0, 0], id: "v" });
  const vis = v.row.severable.find((s) => s.visual_only);
  if (vis) { v.cut(vis.id); assert.equal(v.park(), true); assert.deepEqual(v.cuts, []); }
  physics.destroy();
});

test("a ragdoll that was parked again costs nothing: no body awake after the used one is parked, nothing moves", async () => {
  const physics = await createPhysics({ seed: 1 });
  const pool = [];
  for (let i = 0; i < 6; i++) pool.push(physics.createRagdoll(body, { position: [0, 0, 0], id: "p" + i, parked: true }));
  for (const r of pool) { r.acquire(); }
  for (let t = 0; t < 30; t++) physics.step(1 / 60);
  pool.forEach((r, i) => { if (i % 2) r.kill(KILL); });
  for (let t = 0; t < 30; t++) physics.step(1 / 60);
  for (const r of pool) assert.equal(r.park(), true);
  assert.ok(pool.every((r) => r.awake === false && r.parked === true), "all asleep and parked");
  const before = pool.map((r) => Array.from(r.readPose()));
  for (let t = 0; t < 120; t++) physics.step(1 / 60);
  assert.ok(pool.every((r) => r.awake === false), "still asleep after 120 ticks");
  pool.forEach((r, i) => assert.deepEqual(Array.from(r.readPose()), before[i], "does not move"));
  // parked pose is the fresh parked pose
  const fresh = physics.createRagdoll(body, { position: [0, 0, 0], id: "f", parked: true });
  assert.deepEqual(Array.from(pool[0].readPose()).map((x, i) => (i % 10 > 6 ? 0 : x)), Array.from(fresh.readPose()).map((x, i) => (i % 10 > 6 ? 0 : x)));
  physics.destroy();
});

test("park() twice is idempotent", async () => {
  const physics = await createPhysics({ seed: 1 });
  const rd = physics.createRagdoll(body, { position: [0, 0, 0], id: "a" });
  assert.equal(rd.park(), true);
  const pose = Array.from(rd.readPose());
  assert.equal(rd.park(), true);
  assert.deepEqual(Array.from(rd.readPose()), pose);
  assert.equal(rd.parked, true);
  assert.equal(rd.awake, false);
  physics.destroy();
});

test("destroy after park frees the bodies and constraints", async () => {
  const physics = await createPhysics({ seed: 1 });
  const rd = physics.createRagdoll(body, { position: [0, 0, 0], id: "a" });
  const h0 = physics.hash();
  rd.park(); rd.destroy();
  assert.equal(physics.hash(), "811c9dc5", "no ragdoll left in the world");
  assert.notEqual(h0, "811c9dc5");
  physics.step(1 / 60);
  physics.destroy();
});
