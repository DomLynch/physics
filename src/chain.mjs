// Chain ragdoll body kind: a creature described by a short list of capsule segments along its bones (data/bodies/<name>.chain.json) + the measured bone
// positions (data/bodies/<name>.bones.json) -> one 'ragdoll-row/2' the engine builds like any humanoid row (createPhysics passes a ragdoll-row/2 through).
// No numbers live here: radii, masses, limits, scale and flexion directions are all in the spec; the motor numbers come from the same role table formula
// (stiffness = SK x subtree mass x 9.81 x 0.15 m, damping 0.8 of critical) the humanoid generator uses. Units: metres (bones x spec.scale), kilograms, degrees.
import ROLE_TABLE from "../data/ragdoll-role-table.json" with { type: "json" };
import SALAMANDER_SPEC from "../data/bodies/salamander.chain.json" with { type: "json" };
import SALAMANDER_BONES from "../data/bodies/salamander.bones.json" with { type: "json" };
import EEL_SPEC from "../data/bodies/eel.chain.json" with { type: "json" };
import EEL_BONES from "../data/bodies/eel.bones.json" with { type: "json" };
import ELEPHANT_SPEC from "../data/bodies/elephant.chain.json" with { type: "json" };
import ELEPHANT_BONES from "../data/bodies/elephant.bones.json" with { type: "json" };
import WOLF_SPEC from "../data/bodies/wolf.chain.json" with { type: "json" };
import WOLF_BONES from "../data/bodies/wolf.bones.json" with { type: "json" };
import { frameQuat, severableRow } from "./generate.mjs";

import RAT_KING_SPEC from "../data/bodies/rat-king.chain.json" with { type: "json" };
import RAT_KING_BONES from "../data/bodies/rat-king.bones.json" with { type: "json" };
import CROW_SPEC from "../data/bodies/crow.chain.json" with { type: "json" };
import CROW_BONES from "../data/bodies/crow.bones.json" with { type: "json" };

const BODIES = {
  salamander: { spec: SALAMANDER_SPEC, bones: SALAMANDER_BONES },
  "rat-king": { spec: RAT_KING_SPEC, bones: RAT_KING_BONES },
  crow: { spec: CROW_SPEC, bones: CROW_BONES },
  eel: { spec: EEL_SPEC, bones: EEL_BONES },
  elephant: { spec: ELEPHANT_SPEC, bones: ELEPHANT_BONES },
  wolf: { spec: WOLF_SPEC, bones: WOLF_BONES },
};
const round = (x, n = 5) => Math.round(x * 10 ** n) / 10 ** n;
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

// every problem with a chain spec against its bone measurement, as strings ([] = valid)
export function validateChainSpec(spec, bones) {
  const errs = [];
  if (!spec || spec.schema !== "chain-body/1") return ["schema must be chain-body/1"];
  if (!bones || !bones.bones) return ["no bone measurement"];
  if (!(isNum(spec.scale) && spec.scale > 0)) errs.push("scale must be a positive number");
  if (!Array.isArray(spec.segments) || !spec.segments.length) return [...errs, "segments must be a non-empty array"];
  const seen = new Set();
  spec.segments.forEach((s, i) => {
    const at = `segment ${i} (${s.id})`;
    if (typeof s.id !== "string" || !s.id) errs.push(`${at}: id must be a non-empty string`);
    else if (seen.has(s.id)) errs.push(`${at}: duplicate id`);
    if (i === 0) { if (s.parent !== null) errs.push(`${at}: the first segment is the root, parent must be null`); }
    else if (!seen.has(s.parent)) errs.push(`${at}: parent ${JSON.stringify(s.parent)} must be an earlier segment (parent-first order)`);
    seen.add(s.id);
    if (!(isNum(s.radius) && s.radius > 0)) errs.push(`${at}: radius must be positive`);
    if (!(isNum(s.mass) && s.mass > 0)) errs.push(`${at}: mass must be positive`);
    if (s.extend !== undefined && !(isNum(s.extend) && s.extend >= 0)) errs.push(`${at}: extend must be >= 0`);
    const b0 = bones.bones[s.bone], b1 = bones.bones[s.tip];
    if (!b0) errs.push(`${at}: bone ${s.bone} is not in the measurement`);
    if (!b1) errs.push(`${at}: tip ${s.tip} is not in the measurement`);
    if (b0 && b1 && !(len3(sub3(b1.pos, b0.pos)) + (s.extend || 0) > 0)) errs.push(`${at}: bone and tip are the same point`);
    const j = s.joint;
    if (i === 0) { if (j !== null) errs.push(`${at}: the root has no joint`); }
    else if (!j) errs.push(`${at}: joint missing`);
    else if (j.type === "ball") { if (!(isNum(j.swing_deg) && j.swing_deg > 0 && isNum(j.twist_deg) && j.twist_deg >= 0)) errs.push(`${at}: ball joint needs swing_deg > 0 and twist_deg >= 0`); }
    else if (j.type === "hinge") { if (!(isNum(j.hinge_min_deg) && isNum(j.hinge_max_deg) && j.hinge_min_deg < j.hinge_max_deg)) errs.push(`${at}: hinge needs hinge_min_deg < hinge_max_deg`); }
    else errs.push(`${at}: joint type must be ball or hinge`);
  });
  for (const [role, v] of Object.entries(spec.hinge_flex_z || {})) if (v !== 1 && v !== -1) errs.push(`hinge_flex_z.${role} must be 1 or -1`);
  const ids = new Set(spec.segments.map((s) => s.id)), units = new Set();
  for (const u of spec.severable || []) {
    if (units.has(u.id)) errs.push(`severable ${u.id}: duplicate`);
    units.add(u.id);
    if (!ids.has(u.cut_role)) errs.push(`severable ${u.id}: cut_role ${u.cut_role} is not a segment`);
    for (const c of u.carries_roles || []) if (!ids.has(c)) errs.push(`severable ${u.id}: carries ${c}, not a segment`);
  }
  return errs;
}

// spec + bone measurement -> ragdoll-row/2 (kind "chain"). Throws with every problem if the spec does not validate.
export function buildChainRow(spec, bones, table = ROLE_TABLE) {
  const errs = validateChainSpec(spec, bones);
  if (errs.length) throw new Error(`chain spec ${spec && spec.name}: ` + errs.join("; "));
  const S = spec.scale, idx = Object.fromEntries(spec.segments.map((s, i) => [s.id, i]));
  const roles = [];
  for (const s of spec.segments) {
    const p0 = bones.bones[s.bone].pos.map((x) => x * S), p1 = bones.bones[s.tip].pos.map((x) => x * S);
    const d0 = sub3(p1, p0), L0 = len3(d0), dir = d0.map((x) => x / L0);
    const L = L0 + (s.extend || 0) * S, r = s.radius * S, halfH = Math.max(0.01, L / 2 - r);
    const par = s.parent === null ? null : roles[idx[s.parent]];
    const q = frameQuat(dir, s.role || s.id, par ? par.rest.dir : null);
    roles.push({
      id: s.id, role: s.role || s.id, side: null, parent: s.parent,
      bone_start: s.bone, bone_end: s.tip, extends_beyond: s.extend ? s.tip : null,
      radius_m: round(r), half_height_m: round(halfH), length_m: round(L), mass_kg: round(s.mass, 3),
      rest: { centre: [0, 1, 2].map((k) => round(p0[k] + dir[k] * L / 2)), quat: q.map((x) => round(x, 6)), pivot: p0.map((x) => round(x)), dir: dir.map((x) => round(x, 5)) },
      joint: s.joint ? { ...s.joint } : null,
    });
  }
  // motor defaults: the same formula as the humanoid generator (SK x subtree mass x 9.81 x 0.15 m), scaled per segment by spec motor {stiffness_scale, damping_scale}
  const sub = roles.map((r) => r.mass_kg);
  for (let i = roles.length - 1; i > 0; i--) sub[idx[roles[i].parent]] += sub[i];
  const SK = table.motor.sk;
  roles.forEach((r, i) => {
    if (!r.parent) return;
    const m = spec.segments[i].motor || {};
    const K = SK * sub[i] * 9.81 * 0.15 * (m.stiffness_scale ?? 1), C = 2 * 0.8 * Math.sqrt(K * sub[i] * 0.15 * 0.15) * (m.damping_scale ?? 1);
    r.motor = { stiffness_Nm_per_rad: round(K, 3), damping_Nm_s_per_rad: round(C, 3), subtree_mass_kg: round(sub[i], 3) };
  });
  const kids = {};
  roles.forEach((r) => { if (r.parent) (kids[r.parent] ||= []).push(r.id); });
  const reachOf = (id) => { const r = roles[idx[id]]; return r.length_m + Math.max(0, ...(kids[id] || []).map(reachOf)); };
  roles.forEach((r) => { r.reach_m = round(reachOf(r.id), 4); r.tip_speed_per_rad_s = r.reach_m; });
  const total = roles.reduce((a, r) => a + r.mass_kg, 0);
  return {
    schema: "ragdoll-row/2",
    kind: "chain",
    body: spec.name,
    generated_by: "@frankendom/physics src/chain.mjs",
    inputs: { chain_spec: `data/bodies/${spec.name}.chain.json`, bones: spec.measure, scale: S },
    placeholder: !!spec.placeholder,
    height_m: round(Math.max(...Object.values(bones.bones).map((b) => b.pos[1])) * S),
    total_mass_kg: round(total, 2),
    bodies: roles.length,
    inertia_multiplier: spec.inertia_multiplier ?? table.motor.inertia_multiplier,
    solver: table.solver,
    hinge_flex_z: { ...(spec.hinge_flex_z || {}) },
    severable: (spec.severable || []).map((u) => severableRow(u, roles)),
    roles,
    death: table.death,
  };
}

// part id -> bone name, for every body of the spec: { hips: "spine0", ... }. The game maps each name to its Object3D and passes that to createThreeRig.
export function chainBoneMap(spec) {
  return Object.fromEntries(spec.segments.map((s) => [s.id, s.bone]));
}

// the same map as Object3Ds: find(boneName) -> Object3D (e.g. (n) => gltf.scene.getObjectByName(n)). Throws on a bone the model does not have.
export function chainBoneObjects(spec, find) {
  return Object.fromEntries(Object.entries(chainBoneMap(spec)).map(([part, bone]) => {
    const o = find(bone);
    if (!o) throw new Error(`model has no bone ${bone} (part ${part})`);
    return [part, o];
  }));
}

export const chainBodyNames = () => Object.keys(BODIES);

// a named chain body -> { name, spec, bones, row, boneMap }. A new creature = two data files + one line in BODIES above.
export function loadChainBody(name) {
  const b = BODIES[name];
  if (!b) throw new Error(`unknown chain body ${name} (have: ${Object.keys(BODIES).join(", ")})`);
  return { name, spec: b.spec, bones: b.bones, row: buildChainRow(b.spec, b.bones), boneMap: chainBoneMap(b.spec) };
}
