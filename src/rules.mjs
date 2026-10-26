// M4/M6 rule rows: loader, hand-written validator (no dependencies) and canonical hash.
// Schema: data/rules.schema.json (JSON Schema subset, closed key sets). Data: data/rules.json.
import SCHEMA from "../data/rules.schema.json" with { type: "json" };
import RULES_DATA from "../data/rules.json" with { type: "json" };
import { lintNoBlock } from "./generate.mjs";
import { sha256Hex } from "./sha256.mjs";

export function loadRules() {
  const rules = JSON.parse(JSON.stringify(RULES_DATA));
  assertRules(rules);
  return rules;
}

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const isType = (v, t) => (t === "number" ? typeof v === "number" && Number.isFinite(v) : t === "integer" ? Number.isInteger(v) : typeOf(v) === t);

function resolve(node) {
  if (node && node.$ref) {
    let cur = SCHEMA;
    for (const part of node.$ref.replace(/^#\//, "").split("/")) cur = cur[part];
    return cur;
  }
  return node;
}

function check(value, rawNode, path, errors) {
  const node = resolve(rawNode);
  if ("const" in node && value !== node.const) { errors.push(`${path}: must be ${JSON.stringify(node.const)}`); return; }
  if (node.enum && !node.enum.includes(value)) { errors.push(`${path}: must be one of ${node.enum.join(", ")}`); return; }
  if (node.type) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.some((t) => isType(value, t))) { errors.push(`${path}: expected ${types.join("|")}, got ${typeOf(value)}`); return; }
  }
  if (typeof value === "number") {
    if (node.minimum !== undefined && value < node.minimum) errors.push(`${path}: ${value} is below minimum ${node.minimum}`);
    if (node.maximum !== undefined && value > node.maximum) errors.push(`${path}: ${value} is above maximum ${node.maximum}`);
    if (node.exclusiveMinimum !== undefined && !(value > node.exclusiveMinimum)) errors.push(`${path}: ${value} must be above ${node.exclusiveMinimum}`);
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) errors.push(`${path}: needs at least ${node.minItems} items`);
    if (node.maxItems !== undefined && value.length > node.maxItems) errors.push(`${path}: at most ${node.maxItems} items`);
    if (node.items) value.forEach((v, i) => check(v, node.items, `${path}[${i}]`, errors));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const props = node.properties || {};
    for (const k of node.required || []) if (!(k in value)) errors.push(`${path}: missing required key ${k}`);
    if (node.minProperties !== undefined && Object.keys(value).length < node.minProperties) errors.push(`${path}: needs at least ${node.minProperties} keys`);
    for (const [k, v] of Object.entries(value)) {
      if (k in props) check(v, props[k], `${path}.${k}`, errors);
      else if (node.additionalProperties === false) errors.push(`${path}: unknown key ${k}`);
      else if (node.additionalProperties && typeof node.additionalProperties === "object") check(v, node.additionalProperties, `${path}.${k}`, errors);
    }
  }
}

// Every row that directly holds a number (or array of numbers) needs a `source` string on it or on an
// ancestor; every row that holds a null needs its own `todo` string (a donor number is missing, say so).
function checkProvenance(o, path, covered, errors) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return;
  const has = typeof o.source === "string" && o.source.length > 0;
  const here = covered || has;
  const vals = Object.entries(o).filter(([k]) => k !== "source" && k !== "todo");
  if (vals.some(([, v]) => v === null) && !(typeof o.todo === "string" && o.todo.length > 0)) errors.push(`${path}: has a null value but no todo`);
  if (!here && vals.some(([, v]) => typeof v === "number" || (Array.isArray(v) && v.some((x) => typeof x === "number")))) errors.push(`${path}: numbers without a source`);
  for (const [k, v] of vals) checkProvenance(v, `${path}.${k}`, here, errors);
}

export function validateRules(obj) {
  const errors = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, errors: ["rules: must be an object"] };
  check(obj, SCHEMA, "rules", errors);
  for (const bad of lintNoBlock(obj, "rules")) errors.push(`${bad}: block-like key (armour only raises a threshold, nothing is immune or blocked)`);
  checkProvenance(obj, "rules", false, errors);
  return { ok: errors.length === 0, errors };
}

export function assertRules(obj) {
  const r = validateRules(obj);
  if (!r.ok) throw new Error("invalid rules: " + r.errors.join("; "));
  return obj;
}

// canonical JSON: sorted keys, so a parse round-trip hashes identically
export function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
export const rulesHash = (obj) => sha256Hex(canonical(obj));
