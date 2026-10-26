// Determinism: same inputs, same per-tick hash, twice (and once more with a different dt chunking). Includes a hit impulse, a motor change and a cut.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPhysics } from "../src/index.mjs";

const body = JSON.parse(readFileSync(new URL("./fixtures/body-0002.measure.json", import.meta.url), "utf8"));

async function run(ticks = 240, chunks = 1) {
  const physics = await createPhysics({ seed: 7 });
  const a = physics.createRagdoll(body, { position: [-0.6, 0, 0], id: "a" });
  const b = physics.createRagdoll(body, { position: [0.6, 0, 0], id: "b", rootKinematic: false, motorStrength: 0.01 });
  const hashes = [];
  for (let t = 0; t < ticks; t++) {
    if (t === 30) a.applyImpulse("spine2", [0, 0, 40]);
    if (t === 60) a.setMotorStrength({ all: 0.6, arm: 0.9, forearm: 0.6, hand: 0.12 });
    if (t === 90) a.cut("arm_right");
    if (t === 100) b.applyImpulse("head", [30, 10, 0]);
    for (let c = 0; c < chunks; c++) physics.step(1 / 60 / chunks);
    hashes.push(physics.hash());
  }
  const draws = [physics.rand(), physics.rand()];
  physics.destroy();
  return { hashes, draws };
}

test("same inputs give the same per-tick hash, twice", async () => {
  const r1 = await run(), r2 = await run();
  assert.equal(r1.hashes.length, r2.hashes.length);
  const bad = r1.hashes.findIndex((h, i) => h !== r2.hashes[i]);
  assert.equal(bad, -1, "first differing tick: " + bad);
  assert.deepEqual(r1.draws, r2.draws);
  assert.notEqual(r1.hashes[0], r1.hashes[239], "the sim must actually move");
});

test("the hash is not a constant: a different impulse changes it", async () => {
  const physics = await createPhysics({ seed: 7 });
  const a = physics.createRagdoll(body, { rootKinematic: false, motorStrength: 0.01 });
  physics.step(1 / 60);
  const h0 = physics.hash();
  a.applyImpulse("head", [10, 0, 0]);
  physics.step(1 / 60);
  assert.notEqual(physics.hash(), h0);
  physics.destroy();
});

test("no Math.random and no clock in src", () => {
  for (const f of ["engine.mjs", "index.mjs", "math.mjs", "generate.mjs"]) {
    const s = readFileSync(new URL("../src/" + f, import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
    assert.ok(!/Math\.random|Date\.now|performance\.now|new Date\(/.test(s), f + " reads a clock or Math.random");
  }
});
