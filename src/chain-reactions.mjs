// ALIVE hit-reaction rows for the chain bodies (data/hit-reactions.chain.json): per body family, a row per zone x direction with a bend/twist weight per chain PART id,
// an impulse scale and a hold time. Data only: the game's bone-maths layer reads a row, maps part ids to bones through boneMap and lays the lean/twist on the clip;
// physics needs nothing new (rd.stagger({ part, impulse }) already works on a living chain ragdoll, and data/states.json carries the chain-role motor dips).
// validateChainReactions is a CLOSED schema: an unknown key, an unknown part id, a weight out of range or a missing direction is an error string.
import DATA from "../data/hit-reactions.chain.json" with { type: "json" };
import { loadChainBody, chainBodyNames } from "./chain.mjs";

export const CHAIN_REACTION_ZONES = ["head", "front_body", "rear_body", "legs", "tail"];
export const CHAIN_REACTION_DIRS = ["front", "back", "left", "right"];

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const closed = (o, keys, at, errs) => {
  if (!o || typeof o !== "object" || Array.isArray(o)) { errs.push(`${at}: must be an object`); return false; }
  for (const k of Object.keys(o)) if (!keys.includes(k)) errs.push(`${at}: unknown key ${k}`);
  for (const k of keys) if (!(k in o)) errs.push(`${at}: missing key ${k}`);
  return true;
};
const roleOf = (s) => s.role || s.id;

// every problem with a rows file, as strings ([] = valid). Checks each family's part ids against the chain spec of every body in it.
export function validateChainReactions(d) {
  const errs = [];
  if (!closed(d, ["schema", "about", "frame", "zones", "dirs", "impulse_dirs", "weights_note", "impulse_note", "no_joints", "families"], "file", errs)) return errs;
  if (d.schema !== "chain-hit-reactions/1") errs.push("schema must be chain-hit-reactions/1");
  if (JSON.stringify(d.zones) !== JSON.stringify(CHAIN_REACTION_ZONES)) errs.push(`zones must be ${JSON.stringify(CHAIN_REACTION_ZONES)}`);
  if (JSON.stringify(d.dirs) !== JSON.stringify(CHAIN_REACTION_DIRS)) errs.push(`dirs must be ${JSON.stringify(CHAIN_REACTION_DIRS)}`);
  closed(d.frame, ["forward", "up", "left", "note"], "frame", errs);
  if (closed(d.impulse_dirs, CHAIN_REACTION_DIRS, "impulse_dirs", errs)) {
    for (const k of CHAIN_REACTION_DIRS) {
      const v = d.impulse_dirs[k];
      if (!(Array.isArray(v) && v.length === 3 && v.every(isNum) && Math.abs(Math.hypot(...v) - 1) < 1e-6)) errs.push(`impulse_dirs.${k}: must be a unit [x, y, z]`);
    }
  }
  const known = new Set(chainBodyNames()), placed = new Map();
  for (const n of Array.isArray(d.no_joints) ? d.no_joints : [(errs.push("no_joints must be an array"), null)]) {
    if (!known.has(n)) { errs.push(`no_joints: unknown body ${n}`); continue; }
    if (loadChainBody(n).spec.segments.length !== 1) errs.push(`no_joints: ${n} has joints`);
    placed.set(n, "no_joints");
  }
  if (!d.families || typeof d.families !== "object" || Array.isArray(d.families)) return [...errs, "families must be an object"];
  for (const [fam, F] of Object.entries(d.families)) {
    const at = `family ${fam}`;
    if (!closed(F, ["bodies", "zones", "rows"], at, errs)) continue;
    if (!Array.isArray(F.bodies) || !F.bodies.length) { errs.push(`${at}: bodies must be a non-empty array`); continue; }
    if (!Array.isArray(F.rows)) { errs.push(`${at}: rows must be an array`); continue; }
    const specs = [];
    for (const b of F.bodies) {
      if (!known.has(b)) { errs.push(`${at}: unknown body ${b}`); continue; }
      if (placed.has(b)) errs.push(`${at}: body ${b} is already in ${placed.get(b)}`);
      placed.set(b, fam);
      specs.push({ name: b, spec: loadChainBody(b).spec });
    }
    const zonesSeen = new Set(), pairs = new Set();
    F.rows.forEach((r, i) => {
      const rat = `${at} row ${i}`;
      if (!closed(r, ["zone", "dir", "part", "impulse_scale", "hold_s", "weights"], rat, errs)) return;
      if (!CHAIN_REACTION_ZONES.includes(r.zone)) { errs.push(`${rat}: unknown zone ${r.zone}`); return; }
      if (!CHAIN_REACTION_DIRS.includes(r.dir)) { errs.push(`${rat}: unknown dir ${r.dir}`); return; }
      const key = `${r.zone}/${r.dir}`;
      if (pairs.has(key)) errs.push(`${rat}: duplicate ${key}`);
      pairs.add(key); zonesSeen.add(r.zone);
      if (!(isNum(r.impulse_scale) && r.impulse_scale > 0 && r.impulse_scale <= 10)) errs.push(`${rat}: impulse_scale must be in (0, 10]`);
      if (!(isNum(r.hold_s) && r.hold_s > 0 && r.hold_s <= 2)) errs.push(`${rat}: hold_s must be in (0, 2]`);
      if (typeof r.part !== "string") errs.push(`${rat}: part must be a string`);
      if (!r.weights || typeof r.weights !== "object" || Array.isArray(r.weights) || !Object.keys(r.weights).length) { errs.push(`${rat}: weights must be a non-empty object`); return; }
      for (const [id, w] of Object.entries(r.weights)) {
        if (!(Array.isArray(w) && w.length === 2 && w.every(isNum))) { errs.push(`${rat}: weights.${id} must be [bend, twist]`); continue; }
        if (!(w[0] >= 0 && w[0] <= 1)) errs.push(`${rat}: weights.${id} bend must be 0..1`);
        if (!(w[1] >= -1 && w[1] <= 1)) errs.push(`${rat}: weights.${id} twist must be -1..1`);
      }
      for (const { name, spec } of specs) {
        const ids = new Set(spec.segments.map((s) => s.id));
        if (!ids.has(r.part)) errs.push(`${rat}: struck part ${r.part} is not a part of ${name}`);
        for (const id of Object.keys(r.weights)) if (!ids.has(id)) errs.push(`${rat}: weights.${id} is not a part of ${name}`);
      }
    });
    if (JSON.stringify([...zonesSeen].sort()) !== JSON.stringify([...(Array.isArray(F.zones) ? F.zones : [])].sort())) errs.push(`${at}: zones must list exactly the zones its rows use`);
    for (const z of zonesSeen) for (const dir of CHAIN_REACTION_DIRS) if (!pairs.has(`${z}/${dir}`)) errs.push(`${at}: zone ${z} has no ${dir} row`);
    for (const { name, spec } of specs) {
      const has = (f) => spec.segments.some((s) => f(roleOf(s)));
      for (const [z, f] of [["tail", (r) => r === "tail"], ["legs", (r) => r.startsWith("leg")]]) {
        if (zonesSeen.has(z) !== has(f)) errs.push(`${at}: ${name} ${has(f) ? "has" : "has no"} ${z} parts but the family ${zonesSeen.has(z) ? "has" : "has no"} ${z} rows`);
      }
    }
  }
  for (const n of known) if (!placed.has(n)) errs.push(`body ${n} is in no family and not in no_joints`);
  return errs;
}

let checked = false;
// a named chain body -> { body, family, frame, rows: [{ zone, dir, part, impulse_dir, impulse_scale, hold_s, weights: { partId: [bend, twist] } }] }.
// A body with no joints (drone) returns rows []. Throws on an unknown body or if the shipped file does not validate.
export function loadChainReactions(name) {
  if (!checked) { const errs = validateChainReactions(DATA); if (errs.length) throw new Error("data/hit-reactions.chain.json: " + errs.join("; ")); checked = true; }
  if (!chainBodyNames().includes(name)) throw new Error(`unknown chain body ${name} (have: ${chainBodyNames().join(", ")})`);
  if (DATA.no_joints.includes(name)) return { body: name, family: null, frame: DATA.frame, rows: [] };
  const family = Object.keys(DATA.families).find((f) => DATA.families[f].bodies.includes(name));
  const rows = DATA.families[family].rows.map((r) => ({ ...r, impulse_dir: [...DATA.impulse_dirs[r.dir]], weights: Object.fromEntries(Object.entries(r.weights).map(([k, w]) => [k, [...w]])) }));
  return { body: name, family, frame: DATA.frame, rows };
}
