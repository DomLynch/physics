// @frankendom/physics: Jolt WASM, deterministic fixed step, ragdolls from body measure rows. See docs/API.md.
import { createWorld, mulberry32 } from "./engine.mjs";
import { generateRow, loadTable, lintNoBlock } from "./generate.mjs";

// const physics = await createPhysics({ seed });
// const rd = physics.createRagdoll(bodyMeasureRow, { position: [0, 0, 0] });
// rd.setMotorStrength({ all: 1 }); rd.applyImpulse("head", [0, 0, 20]); rd.cut("arm_right");
// physics.step(1 / 60); const pose = rd.readPose();
export async function createPhysics(opts = {}) {
  const world = await createWorld(opts);
  const table = loadTable(opts.roleTable);
  const make = world.createRagdoll;
  world.createRagdoll = (input, ropts = {}) => {
    const row = input && input.schema === "ragdoll-row/2" ? input : generateRow(ropts.id || input.id || "body", input, table);
    return make(row, ropts);
  };
  return world;
}

export { generateRow, loadTable, lintNoBlock, mulberry32 };
