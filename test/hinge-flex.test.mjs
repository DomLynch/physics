// hinge_flex_z (data/world.json): the world's own row must reach buildDefinition, and a row value is +1 or -1, never silently "unset".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildDefinition } from "../src/engine.mjs";
import { createPhysics } from "../src/index.mjs";

const measure = JSON.parse(readFileSync(new URL("../data/bodies/minotaur.measure.json", import.meta.url), "utf8"));
// the ragdoll row buildDefinition takes (the measure row turned into roles by createRagdoll)
const probe = await createPhysics({ seed: 1 });
const body = probe.createRagdoll(measure).row;
probe.destroy();
const forearm = body.roles.findIndex((r) => r.role === "forearm");

test("flipping a role's hinge_flex_z flips that hinge's limits", () => {
  const a = buildDefinition(body, [0, 0, 0], { forearm: 1, shin: -1 }).limits[forearm];
  const b = buildDefinition(body, [0, 0, 0], { forearm: -1, shin: -1 }).limits[forearm];
  assert.notDeepEqual(a, b);
});

test("a role not named in the row keeps its default direction", () => {
  const a = buildDefinition(body, [0, 0, 0], {}).limits[forearm];
  const b = buildDefinition(body, [0, 0, 0], { forearm: 1 }).limits[forearm];
  assert.deepEqual(a, b);
});

test("a row value other than 1 or -1 is refused, 0 is not treated as unset", () => {
  assert.throws(() => buildDefinition(body, [0, 0, 0], { forearm: 0 }), /hinge_flex_z\.forearm must be 1 or -1/);
  assert.throws(() => buildDefinition(body, [0, 0, 0], { forearm: "up" }), /hinge_flex_z\.forearm/);
});

test("createPhysics({ rows: { hinge_flex_z } }) reaches the ragdoll it builds (a bad world row is refused at createRagdoll)", async () => {
  const p = await createPhysics({ seed: 1, rows: { hinge_flex_z: { forearm: 0 } } });
  assert.throws(() => p.createRagdoll(measure), /hinge_flex_z\.forearm must be 1 or -1/);
  p.destroy();
});
