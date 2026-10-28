// @frankendom/physics: Jolt WASM, deterministic fixed step, ragdolls from body measure rows. See docs/API.md.
import { createWorld, mulberry32 } from "./engine.mjs";
import { generateRow, loadTable, lintNoBlock, severableRow } from "./generate.mjs";

// const physics = await createPhysics({ seed });
// const rd = physics.createRagdoll(bodyMeasureRow, { position: [0, 0, 0] });
// rd.setMotorStrength({ all: 1 }); rd.applyImpulse("head", [0, 0, 20]); rd.cut("arm_right");
// physics.step(1 / 60); const pose = rd.readPose();
export async function createPhysics(opts = {}) {
  const world = await createWorld(opts);
  const table = loadTable(opts.roleTable);
  const make = world.createRagdoll;
  world.createRagdoll = (input, ropts = {}) => {
    let row = input && input.schema === "ragdoll-row/2" ? input : generateRow(ropts.id || input.id || "body", input, table);
    // a ragdoll-row/2 generated before the visual-only units existed: add them from the role table (the row passed in is not changed)
    if (row === input && row.kind !== "chain") { // a chain row (src/chain.mjs) is not a humanoid: it has no head_split / belly_open parts
      const have = new Set(row.severable.map((s) => s.id)), add = table.severable.units.filter((u) => u.visual_only && !have.has(u.id));
      if (add.length) row = { ...row, severable: [...row.severable, ...add.map((u) => severableRow(u, row.roles))] };
    }
    return make(row, ropts);
  };
  return world;
}

export { generateRow, loadTable, lintNoBlock, mulberry32 };
export { buildChainRow, validateChainSpec, loadChainBody, chainBoneMap, chainBoneObjects, chainFollowMap, chainFollowObjects, chainVirtualParts, chainRigOptions, chainBodyNames } from "./chain.mjs";
export { loadChainReactions, validateChainReactions, CHAIN_REACTION_ZONES, CHAIN_REACTION_DIRS } from "./chain-reactions.mjs";
export { createEvaluator, createFighterState, rollFinisher } from "./rules-eval.mjs";
export { loadLimbLoss, validateLimbLoss } from "./limb-loss.mjs";
export { validateGround, loadGroundRows } from "./ground.mjs";
export { admit } from "./budget.mjs";
export { validateRules, assertRules, loadRules, rulesHash } from "./rules.mjs";
