// Parked (pooled) ragdolls: createRagdoll(row, { parked: true }) makes the bodies asleep and out of the way, so world.step costs nothing for them;
// rd.acquire(position?) puts the ragdoll at its spawn pose (at `position`, default the one given at create) and wakes it. No wall clock here:
// cost is asserted as "how many bodies are awake", which is what Jolt's step time follows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPhysics } from "../src/index.mjs";

const body = JSON.parse(readFileSync(new URL("./fixtures/body-0002.measure.json", import.meta.url), "utf8"));

test("a parked ragdoll is asleep and stays asleep: 30 parked bodies, nothing awake, nothing moves", async () => {
  const physics = await createPhysics({ seed: 1 });
  const pool = [];
  for (let i = 0; i < 30; i++) pool.push(physics.createRagdoll(body, { position: [0, 0, 0], id: "pool" + i, parked: true }));
  assert.ok(pool.every((r) => r.awake === false), "all asleep at create");
  assert.ok(pool.every((r) => r.parked === true));
  const before = Array.from(pool[7].readPose());
  for (let t = 0; t < 120; t++) physics.step(1 / 60);
  assert.ok(pool.every((r) => r.awake === false), "all still asleep after 120 ticks");
  assert.deepEqual(Array.from(pool[7].readPose()), before, "a parked ragdoll does not move");
  physics.destroy();
});

test("a parked ragdoll sits out of the way: a live one at the origin is not touched by it", async () => {
  const physics = await createPhysics({ seed: 1 });
  physics.createRagdoll(body, { position: [0, 0, 0], id: "pool", parked: true });
  const live = physics.createRagdoll(body, { position: [0, 0, 0], id: "live" });
  const ref = await createPhysics({ seed: 1 });
  const alone = ref.createRagdoll(body, { position: [0, 0, 0], id: "live" });
  for (let t = 0; t < 90; t++) { physics.step(1 / 60); ref.step(1 / 60); }
  assert.deepEqual(Array.from(live.readPose()), Array.from(alone.readPose()), "same pose as with no parked ragdoll in the world");
  physics.destroy(); ref.destroy();
});

test("default create is unchanged: awake, not parked", async () => {
  const physics = await createPhysics({ seed: 1 });
  const r = physics.createRagdoll(body, { position: [0, 0, 0], id: "a" });
  assert.equal(r.awake, true);
  assert.equal(r.parked, false);
  physics.destroy();
});

async function fall(parked) {
  const physics = await createPhysics({ seed: 3 });
  const rd = physics.createRagdoll(body, parked ? { position: [0.4, 0, 0], id: "a", parked: true } : { position: [0.4, 0, 0], id: "a" });
  if (parked) { for (let t = 0; t < 30; t++) physics.step(1 / 60); assert.equal(rd.awake, false); rd.acquire(); assert.equal(rd.awake, true); assert.equal(rd.parked, false); }
  for (let t = 0; t < 10; t++) physics.step(1 / 60);
  rd.kill({ part: "spine2", impulse: [0, 0, 60] });
  const hashes = [];
  for (let t = 0; t < 300; t++) { physics.step(1 / 60); hashes.push(physics.hash()); }
  const pose = Array.from(rd.readPose());
  physics.destroy();
  return { hashes, pose };
}

test("a parked ragdoll that is acquired, then killed, falls exactly like a fresh one (same hash every tick)", async () => {
  const fresh = await fall(false), pooled = await fall(true);
  // the pooled one idled 30 ticks before acquire, the fresh one did not: compare the same ticks after kill
  assert.deepEqual(pooled.pose, fresh.pose, "same final pose");
  assert.deepEqual(pooled.hashes, fresh.hashes, "same per-tick hash");
});

test("acquire(position) puts the ragdoll at that position", async () => {
  const physics = await createPhysics({ seed: 1 });
  const rd = physics.createRagdoll(body, { position: [0, 0, 0], id: "a", parked: true });
  rd.acquire([3, 0, -2]);
  const fresh = physics.createRagdoll(body, { position: [3, 0, -2], id: "b" });
  const a = rd.readPose(), b = fresh.readPose();
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-5, "float " + i);
  physics.destroy();
});
