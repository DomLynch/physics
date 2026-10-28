// Per-body limb-loss rows: loader and closed-schema validator for data/limb-loss.json (no dependencies).
// A body without a row gets null and the evaluator uses the global locational rows, exactly as before.
import DATA from "../data/limb-loss.json" with { type: "json" };

const PARTS = ["head", "torso", "arm_left", "arm_right", "leg_left", "leg_right"];
const CUT_UNITS = ["head", "torso_waist", "arm_left", "arm_right", "leg_left", "leg_right"]; // the severable units (tools/cut-units.mjs REGIONS.detached_by)
const LEG_STATES = ["kneel", "limp"];
const ROW_KEYS = ["body", "budgets", "arm_gone_damage_mult", "leg_state", "piece_hostile", "note", "source"];
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function validateLimbLoss(d) {
  const e = [];
  if (!isObj(d)) return ["limb-loss: must be an object"];
  for (const k of Object.keys(d)) if (!["schema", "about", "rows"].includes(k)) e.push(`limb-loss: unknown key ${k}`);
  if (d.schema !== "limb-loss/1") e.push('limb-loss.schema: must be "limb-loss/1"');
  if (!Array.isArray(d.rows)) return [...e, "limb-loss.rows: must be an array"];
  const seen = new Set();
  d.rows.forEach((r, i) => {
    const p = `rows[${i}]`;
    if (!isObj(r)) { e.push(`${p}: must be an object`); return; }
    for (const k of Object.keys(r)) if (!ROW_KEYS.includes(k)) e.push(`${p}: unknown key ${k}`);
    if (typeof r.body !== "string" || !r.body) e.push(`${p}.body: must be a non-empty string`);
    else if (seen.has(r.body)) e.push(`${p}.body: duplicate ${r.body}`); else seen.add(r.body);
    for (const k of ["note", "source"]) if (typeof r[k] !== "string" || !r[k]) e.push(`${p}.${k}: required string`);
    if (r.budgets !== undefined) {
      if (!isObj(r.budgets)) e.push(`${p}.budgets: must be an object`);
      else for (const [id, v] of Object.entries(r.budgets)) {
        if (!PARTS.includes(id)) e.push(`${p}.budgets.${id}: unknown part`);
        else if (!(typeof v === "number" && Number.isFinite(v) && v > 0)) e.push(`${p}.budgets.${id}: must be a number above 0`);
      }
    }
    if (r.arm_gone_damage_mult !== undefined && !(typeof r.arm_gone_damage_mult === "number" && r.arm_gone_damage_mult >= 0 && r.arm_gone_damage_mult <= 1)) e.push(`${p}.arm_gone_damage_mult: must be a number in 0..1`);
    if (r.leg_state !== undefined && !LEG_STATES.includes(r.leg_state)) e.push(`${p}.leg_state: must be one of ${LEG_STATES.join(", ")}`);
    if (r.piece_hostile !== undefined) {
      if (!isObj(r.piece_hostile)) e.push(`${p}.piece_hostile: must be an object`);
      else for (const [u, h] of Object.entries(r.piece_hostile)) {
        if (!CUT_UNITS.includes(u)) { e.push(`${p}.piece_hostile.${u}: not a cut unit`); continue; }
        if (!isObj(h)) { e.push(`${p}.piece_hostile.${u}: must be an object`); continue; }
        for (const k of Object.keys(h)) if (!["attack", "hp"].includes(k)) e.push(`${p}.piece_hostile.${u}: unknown key ${k}`);
        if (typeof h.attack !== "string" || !h.attack) e.push(`${p}.piece_hostile.${u}.attack: required string`);
        if (!(typeof h.hp === "number" && Number.isFinite(h.hp) && h.hp > 0)) e.push(`${p}.piece_hostile.${u}.hp: required number above 0`);
      }
    }
  });
  return e;
}

// the row for `body` (a copy), or null when the body has none
export function loadLimbLoss(body, data = DATA) {
  const errors = validateLimbLoss(data);
  if (errors.length) throw new Error("limb-loss: " + errors.join("; "));
  const row = typeof body === "string" ? data.rows.find((r) => r.body === body) : undefined;
  return row ? JSON.parse(JSON.stringify(row)) : null;
}
