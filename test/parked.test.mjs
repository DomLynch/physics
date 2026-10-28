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

const posErr = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) if (i % 10 < 3) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

test("setRoot while parked is a no-op: it does not leak into acquire", async () => {
  const run = async (stale) => {
    const physics = await createPhysics({ seed: 1 });
    const rd = physics.createRagdoll(body, { position: [0, 0, 0], id: "a", parked: true });
    if (stale) assert.equal(rd.setRoot([50, 1, 50], [0, 0, 0, 1]), false);
    rd.acquire([10, 0, 0]);
    for (let t = 0; t < 20; t++) physics.step(1 / 60);
    const p = Array.from(rd.readPose()); physics.destroy(); return p;
  };
  const clean = await run(false), leaked = await run(true);
  assert.deepEqual(leaked, clean, "hips end where they would without the stale setRoot");
  assert.ok(Math.abs(leaked[0] - 10) < 0.5 && Math.abs(leaked[2]) < 0.5, "near (10, 0) not (50, 50)");
});

test("reset() on a parked ragdoll returns false and changes nothing", async () => {
  const physics = await createPhysics({ seed: 1 });
  const rd = physics.createRagdoll(body, { position: [0, 0, 0], id: "a", parked: true });
  const pose = Array.from(rd.readPose());
  assert.equal(rd.reset(), false);
  assert.equal(rd.parked, true);
  assert.equal(rd.awake, false);
  assert.deepEqual(Array.from(rd.readPose()), pose);
  physics.destroy();
});

test("kill, applyImpulse, release, stagger, knockdown, cut, snapToTarget are no-ops returning false while parked", async () => {
  const physics = await createPhysics({ seed: 1 });
  const rd = physics.createRagdoll(body, { position: [0, 0, 0], id: "a", parked: true });
  const pose = Array.from(rd.readPose());
  assert.equal(rd.kill({ part: "spine2", impulse: [0, 0, 60] }), false);
  assert.equal(rd.applyImpulse("head", [0, 0, 50]), false);
  assert.equal(rd.release(), false);
  assert.equal(rd.stagger({ part: "head", impulse: [0, 0, 5] }), false);
  assert.equal(rd.knockdown("damage", { part: "head", impulse: [0, 0, 5] }), false);
  assert.equal(rd.cut("arm_left"), false);
  assert.equal(rd.snapToTarget(), false);
  for (let t = 0; t < 120; t++) physics.step(1 / 60);
  assert.equal(rd.parked, true);
  assert.equal(rd.awake, false);
  assert.equal(rd.state, "alive");
  assert.deepEqual(rd.cuts, []);
  assert.deepEqual(Array.from(rd.readPose()), pose, "nothing moved, nothing fell below the park depth");
  rd.acquire();
  assert.equal(rd.awake, true);
  physics.destroy();
});

test("far acquire: acquire([200,0,-150]) then a kill stays within 2e-3 m of a fresh ragdoll created there, and is deterministic", async () => {
  const at = [200, 0, -150];
  const run = async (parked) => {
    const physics = await createPhysics({ seed: 3 });
    const rd = physics.createRagdoll(body, parked ? { position: [0, 0, 0], id: "a", parked: true } : { position: at, id: "a" });
    if (parked) rd.acquire(at);
    for (let t = 0; t < 10; t++) physics.step(1 / 60);
    rd.kill({ part: "spine2", impulse: [0, 0, 60] });
    const hashes = [];
    for (let t = 0; t < 120; t++) { physics.step(1 / 60); hashes.push(physics.hash()); }
    const pose = Array.from(rd.readPose()); physics.destroy(); return { pose, hashes };
  };
  const fresh = await run(false), a = await run(true), b = await run(true);
  assert.deepEqual(a.hashes, b.hashes, "two identical acquire runs: same per-tick hash");
  assert.ok(posErr(a.pose, fresh.pose) < 2e-3, "position error " + posErr(a.pose, fresh.pose));
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
