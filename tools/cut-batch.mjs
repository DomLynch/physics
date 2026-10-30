// The batch cut pipeline (M9b): for every body in a row file, measure, cut, validate, and write one receipt. Fails loudly (exit 1) on any body that does not
// validate, unless its row says it is `blocked` (a known, explained failure: still run and reported, never hidden).
//   node tools/cut-batch.mjs [--bodies data/cut-bodies.json] [--sources <dir>] [--out <dir>] [--only a,b] [--update-measure]
// Per body: tools/glb-measure.mjs (rig map -> measure row), tools/cut-units.mjs's cutGlb (rig map, row overrides), tools/cut-validate.mjs's validate
// (--plane-offset = the manifest's plane_frame.bind_offset, --source = the plain source). Outputs in <out>: <name>.cut.glb, <name>.cut.manifest.json,
// <name>.source-plain.glb (when the source was compressed), <name>.measure.json, <name>.validate.txt, RECEIPT.md, receipt.json.
// Row format and the receipt: docs/CUT-BATCH.md. Same inputs, same bytes (no clocks in the outputs; the receipt carries none either).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve, isAbsolute, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cutGlb, decompressGlb, rigidAccessorySpecs, SHOULDER_MODES } from "./cut-units.mjs";
import { validate } from "./cut-validate.mjs";
import { sha256HexBytes } from "../src/sha256.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
export const SCHEMA = "cut-bodies/1";
// the row keys a body may carry (anything else is refused: a typo in a row must not silently cut with defaults)
const BODY_KEYS = new Set(["name", "source", "plain", "rig_map", "measure", "overrides", "hands_feet_params", "expect_sha256", "expect_sha256_hands_feet", "blocked", "blocked_checks", "note"]);
const OVERRIDE_KEYS = new Set(["planes", "hair_materials", "home_min_weight", "crotch_planes", "head_split", "belly_open", "hands_feet", "rigid_accessory_materials", "plane_snap_m"]);
const PLANE_KEYS = new Set(["neck_frac", "waist_frac", "shoulder_frac", "hip_frac", "shoulder_mode"]);

// Reads and checks a body-row file. `defaults` fills every body's missing keys (rig_map, overrides merge one level deep).
export function loadRows(path) {
  const file = JSON.parse(readFileSync(path, "utf8"));
  if (file.schema !== SCHEMA) throw new Error(`${path}: schema must be ${SCHEMA}`);
  if (!Array.isArray(file.bodies) || !file.bodies.length) throw new Error(`${path}: no bodies`);
  const defaults = file.defaults || {};
  const seen = new Set();
  const bodies = file.bodies.map((b, i) => {
    const row = { ...defaults, ...b, overrides: { ...(defaults.overrides || {}), ...(b.overrides || {}) } };
    const where = `${path} body #${i} (${row.name})`;
    for (const k of Object.keys(row)) if (!BODY_KEYS.has(k)) throw new Error(`${where}: unknown key ${k}`);
    for (const k of Object.keys(row.overrides)) if (!OVERRIDE_KEYS.has(k)) throw new Error(`${where}: unknown override ${k}`);
    for (const k of Object.keys(row.overrides.planes || {})) if (!PLANE_KEYS.has(k)) throw new Error(`${where}: unknown plane row ${k}`);
    // override values: a typo in a value must not silently cut with defaults either
    const ov = row.overrides, isFrac = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
    if (ov.planes && ov.planes.shoulder_mode !== undefined && !SHOULDER_MODES.includes(ov.planes.shoulder_mode)) throw new Error(`${where}: overrides.planes.shoulder_mode must be one of ${SHOULDER_MODES.join(", ")}, got ${JSON.stringify(ov.planes.shoulder_mode)}`);
    if (ov.planes && ov.planes.shoulder_mode === "tilt" && ov.planes.shoulder_frac) throw new Error(`${where}: overrides.planes.shoulder_mode tilt turns the plane about the arm joint, so shoulder_frac must be absent or 0`);
    for (const [k, v] of Object.entries(ov.planes || {})) if (k !== "shoulder_mode" && !isFrac(v)) throw new Error(`${where}: overrides.planes.${k} must be a number from 0 to 1, got ${JSON.stringify(v)}`);
    if (ov.home_min_weight !== undefined && !isFrac(ov.home_min_weight)) throw new Error(`${where}: overrides.home_min_weight must be a number from 0 to 1, got ${JSON.stringify(ov.home_min_weight)}`);
    if (ov.hair_materials !== undefined && !(Array.isArray(ov.hair_materials) && ov.hair_materials.every((m) => typeof m === "string" && m))) throw new Error(`${where}: overrides.hair_materials must be a list of material names`);
    if (ov.plane_snap_m !== undefined && !(typeof ov.plane_snap_m === "number" && ov.plane_snap_m > 0 && ov.plane_snap_m <= 1e-4)) throw new Error(`${where}: overrides.plane_snap_m must be a number from 0 (exclusive) to 0.0001 metres (the validator's plane tolerance), got ${JSON.stringify(ov.plane_snap_m)}`);
    if (ov.rigid_accessory_materials !== undefined) { try { rigidAccessorySpecs(ov.rigid_accessory_materials); } catch (e) { throw new Error(`${where}: overrides.${e.message}`); } }
    if (ov.crotch_planes !== undefined && typeof ov.crotch_planes !== "boolean") throw new Error(`${where}: overrides.crotch_planes must be true or false, got ${JSON.stringify(ov.crotch_planes)}`);
    for (const k of ["head_split", "belly_open", "hands_feet"]) if (ov[k] !== undefined && typeof ov[k] !== "boolean" && !(ov[k] && typeof ov[k] === "object" && !Array.isArray(ov[k]))) throw new Error(`${where}: overrides.${k} must be true, false or a row object`);
    if (row.hands_feet_params !== undefined && !(row.hands_feet_params && typeof row.hands_feet_params === "object" && !Array.isArray(row.hands_feet_params))) throw new Error(`${where}: hands_feet_params must be a row object (fields of HANDS_FEET, applied only on a --hands-feet run)`);
    for (const k of ["name", "source", "rig_map", "measure"]) if (typeof row[k] !== "string" || !row[k]) throw new Error(`${where}: needs ${k}`);
    if (!/^[A-Za-z0-9._-]+$/.test(row.name)) throw new Error(`${where}: name must be a plain file stem`);
    if (seen.has(row.name)) throw new Error(`${where}: duplicate name`);
    seen.add(row.name);
    if (row.blocked !== undefined && (typeof row.blocked !== "string" || !row.blocked)) throw new Error(`${where}: blocked must be the cause, a non-empty string`);
    if (row.blocked !== undefined && !(Array.isArray(row.blocked_checks) && row.blocked_checks.length && row.blocked_checks.every((c) => typeof c === "string" && c))) throw new Error(`${where}: a blocked row names the checks it expects to fail: blocked_checks, a non-empty list of check names`);
    if (row.blocked === undefined && row.blocked_checks !== undefined) throw new Error(`${where}: blocked_checks without blocked`);
    if (row.expect_sha256 !== undefined && !/^[0-9a-f]{64}$/.test(row.expect_sha256)) throw new Error(`${where}: expect_sha256 must be 64 hex digits`);
    if (row.expect_sha256_hands_feet !== undefined && !/^[0-9a-f]{64}$/.test(row.expect_sha256_hands_feet)) throw new Error(`${where}: expect_sha256_hands_feet must be 64 hex digits`);
    return row;
  });
  return { schema: SCHEMA, bodies };
}

// cutGlb opts from a body row (rows are the only place a per-body number lives)
export function cutOpts(row, extra = {}) {
  const o = row.overrides || {};
  const opts = { body: row.name, rig: basename(row.rig_map, ".json"), ...extra };
  if (o.planes) opts.planes = o.planes;
  if (o.hair_materials) opts.hairMaterials = o.hair_materials;
  if (o.rigid_accessory_materials) opts.rigidAccessoryMaterials = o.rigid_accessory_materials;
  if (o.plane_snap_m !== undefined) opts.planeSnap = o.plane_snap_m;
  if (o.home_min_weight !== undefined) opts.homeMinWeight = o.home_min_weight;
  if (o.crotch_planes === false) opts.crotchPlanes = false;
  if (o.head_split) opts.headSplit = o.head_split;
  if (o.belly_open) opts.bellyOpen = o.belly_open;
  if (o.hands_feet) opts.handsFeet = o.hands_feet;
  return opts;
}

const rel = (base, p) => (isAbsolute(p) ? p : resolve(base, p));

// One body through measure, cut and validate. Never throws for a body-level failure: the failure is the result.
export async function runBody(row, ctx) {
  const res = { name: row.name, rig_map: row.rig_map, source: row.source, blocked: row.blocked || null, blocked_checks: row.blocked ? row.blocked_checks : null, stages: {}, checks: [], ok: false, error: null, sha256: null, source_sha256: null };
  try {
    const srcPath = rel(ctx.sources, row.source);
    if (!existsSync(srcPath)) throw new Error(`source not found: ${row.source}`);
    const rigPath = rel(ctx.root, row.rig_map);
    const rigMap = JSON.parse(readFileSync(rigPath, "utf8"));
    const srcBytes = readFileSync(srcPath);
    res.source_sha256 = sha256HexBytes(srcBytes);

    // 1 measure (tools/glb-measure.mjs; it reads the node tree, so a meshopt source is fine)
    const measureOut = join(ctx.out, row.name + ".measure.json");
    execFileSync(process.execPath, [join(HERE, "glb-measure.mjs"), srcPath, rigPath, measureOut], { stdio: ["ignore", "pipe", "pipe"] });
    const measured = JSON.parse(readFileSync(measureOut, "utf8"));
    const committedPath = rel(ctx.root, row.measure);
    const committed = existsSync(committedPath) ? JSON.parse(readFileSync(committedPath, "utf8")) : null;
    const same = committed && JSON.stringify(committed.joints) === JSON.stringify(measured.joints);
    res.stages.measure = { ok: true, committed: committed ? (same ? "same joints" : "DIFFERENT joints") : "none yet", height_m: measured.height_m };
    // --update-measure only ever writes inside this repo's data/ (a row path like ../../x or an absolute path is refused), and only after the body passes (below)
    if (ctx.updateMeasure && !resolve(committedPath).startsWith(join(ROOT, "data") + sep)) throw new Error(`--update-measure refuses ${row.measure}: the committed row must be inside data/`);
    // the measure row the cut uses: the fresh one (the row on disk is what this body measures to today)
    const mrow = measured;

    // 2 plain source (cut-validate reads plain GLBs only; cutGlb reads either, but both get the plain one so the numbers compare)
    let plainPath = srcPath, plainBytes = srcBytes;
    if (!row.plain) {
      plainBytes = Buffer.from(await decompressGlb(srcBytes));
      plainPath = join(ctx.out, row.name + ".source-plain.glb");
      writeFileSync(plainPath, plainBytes);
    }
    res.stages.source = { plain: row.plain ? "as given" : "decompressed", file: basename(plainPath), sha256: sha256HexBytes(plainBytes) };

    // 3 cut
    // ctx.handsFeet (--hands-feet): every body of the run is built with the wrist and ankle cuts too, unless its row already says what it wants
    const { glb, manifest, report } = await cutGlb(plainBytes, mrow, rigMap, cutOpts(row, { source: basename(plainPath), ...(ctx.handsFeet && (row.overrides || {}).hands_feet === undefined ?{ handsFeet: row.hands_feet_params || true } : {}) }));
    const glbBytes = Buffer.from(glb);
    writeFileSync(join(ctx.out, row.name + ".cut.glb"), glbBytes);
    writeFileSync(join(ctx.out, row.name + ".cut.manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
    res.sha256 = sha256HexBytes(glbBytes);
    const s = manifest.stats;
    res.stages.cut = { ok: true, vertices: `${s.vertices_in} -> ${s.vertices_out}`, triangles: `${s.triangles_in} -> ${s.triangles_out}`, open_edges_at_cuts: s.open_edges_at_cuts, open_edges_native: s.open_edges_native, notes: report.notes || [] };

    // 4 validate
    const v = validate(glbBytes, manifest, { source: plainBytes, planeOffset: manifest.plane_frame.bind_offset });
    res.checks = v.checks.map((c) => ({ name: c.name, result: c.skipped || c.summary.startsWith("skipped") ? "SKIP" : c.ok ? "PASS" : "FAIL", summary: c.summary, details: c.ok ? [] : c.details.slice(0, 12) }));
    writeFileSync(join(ctx.out, row.name + ".validate.txt"), validateText(row.name, v));
    res.ok = v.ok;
    if (row.expect_sha256_hands_feet && ctx.handsFeet && (row.overrides || {}).hands_feet === undefined) {
      // the hands/feet cut of this body is pinned too, so the file V3 gets from a --hands-feet run is reproducible (a default run never reads this key)
      res.stages.expect = { ok: res.sha256 === row.expect_sha256_hands_feet, expected: row.expect_sha256_hands_feet };
      if (!res.stages.expect.ok) { res.ok = false; res.error = `sha256 ${res.sha256} is not the expected ${row.expect_sha256_hands_feet} (expect_sha256_hands_feet)`; }
    } else if (row.expect_sha256 && ctx.handsFeet && (row.overrides || {}).hands_feet === undefined) {
      // the pinned hash is the published (default) cut; a hands_feet pass is a different file by design. Said in the receipt, not hidden.
      res.stages.expect = { ok: true, skipped: "the pinned sha256 is of the cut without hands_feet; this run adds the wrist and ankle cuts" };
    } else if (row.expect_sha256) {
      res.stages.expect = { ok: res.sha256 === row.expect_sha256, expected: row.expect_sha256 };
      if (!res.stages.expect.ok) { res.ok = false; res.error = `sha256 ${res.sha256} is not the expected ${row.expect_sha256}`; }
    }
    // the ragdoll consumes the committed measure row while the cut used the fresh one: if they disagree the body is not consistent, whatever the validator says
    if (committed && !same && !ctx.updateMeasure) { res.ok = false; res.error = res.error || `committed measure row ${row.measure} has different joints from what the source measures to today (rerun with --update-measure)`; }
    if (ctx.updateMeasure && res.ok) { writeFileSync(committedPath, readFileSync(measureOut)); res.stages.measure.written = row.measure; }
  } catch (e) {
    res.ok = false;
    res.error = e && e.message ? e.message : String(e);
  }
  return res;
}

function validateText(name, v) {
  const out = [`cut-validate ${name}.cut.glb`, `sha256 ${v.sha256}`];
  v.checks.forEach((c, i) => {
    out.push(`${String(i + 1).padStart(2)} ${c.name.padEnd(13)} ${c.skipped || c.summary.startsWith("skipped") ? "SKIP" : c.ok ? "PASS" : "FAIL"}  ${c.summary}`);
    for (const t of c.table) out.push("      " + t);
    if (!c.ok) for (const d of c.details.slice(0, 25)) out.push("      - " + d);
  });
  out.push(v.ok ? "RESULT: PASS" : "RESULT: FAIL (" + v.checks.filter((c) => !c.ok).map((c) => c.name).join(", ") + ")");
  return out.join("\n") + "\n";
}

// verdict of one body: PASS, FAIL (fails the run), BLOCKED (failed exactly as the row says: no error, and the failing checks are the row's blocked_checks, no more and no fewer),
// UNBLOCKED (passes although the row says blocked: fails the run so the row is cleaned)
export function verdict(r) {
  if (r.blocked) {
    if (r.ok) return "UNBLOCKED";
    if (r.error) return "FAIL";
    const failing = r.checks.filter((c) => c.result === "FAIL").map((c) => c.name).sort();
    const want = [...(r.blocked_checks || [])].sort();
    return failing.length === want.length && failing.every((n, i) => n === want[i]) ? "BLOCKED" : "FAIL";
  }
  return r.ok ? "PASS" : "FAIL";
}

export function receiptMarkdown(results, meta) {
  const names = [...new Set(results.flatMap((r) => r.checks.map((c) => c.name)))];
  const L = [];
  L.push("# Cut batch receipt", "");
  L.push(`Rows: ${meta.rows} (${results.length} bodies). Tool: physics ${meta.git || "unknown"}. Sources: ${meta.sources}.`, "");
  L.push("| body | rig | result | " + names.join(" | ") + " | sha256 of the cut GLB |");
  L.push("|---|---|---|" + names.map(() => "---|").join("") + "---|");
  for (const r of results) {
    const cell = (n) => (r.checks.find((c) => c.name === n) || {}).result || "-";
    L.push(`| ${r.name} | ${basename(r.rig_map, ".json")} | **${verdict(r)}** | ${names.map(cell).join(" | ")} | ${r.sha256 || "-"} |`);
  }
  L.push("");
  for (const r of results) {
    L.push(`## ${r.name}: ${verdict(r)}`, "");
    if (r.blocked) L.push(`Blocked (row): ${r.blocked}`, `Expected failing checks: ${r.blocked_checks.join(", ")}`, "");
    if (r.error) L.push(`Error: ${r.error}`, "");
    if (r.source_sha256) L.push(`Source ${r.source} sha256 ${r.source_sha256}`, "");
    for (const [k, v] of Object.entries(r.stages)) L.push(`- ${k}: ${Object.entries(v).map(([a, b]) => `${a} ${Array.isArray(b) ? b.join("; ") || "none" : b}`).join(", ")}`);
    for (const c of r.checks) {
      L.push(`- ${c.name}: ${c.result}  ${c.summary}`);
      for (const d of c.details) L.push(`    - ${d}`);
    }
    L.push("");
  }
  const bad = results.filter((r) => ["FAIL", "UNBLOCKED"].includes(verdict(r)));
  L.push(bad.length ? `RESULT: FAIL (${bad.map((r) => r.name + " " + verdict(r)).join(", ")})` : `RESULT: OK (${results.filter((r) => verdict(r) === "PASS").length} pass, ${results.filter((r) => verdict(r) === "BLOCKED").length} blocked)`, "");
  return L.join("\n");
}

export async function runBatch({ bodiesPath, sources, out, only = null, updateMeasure = false, handsFeet = false }) {
  const { bodies } = loadRows(bodiesPath);
  const pick = only ? bodies.filter((b) => only.includes(b.name)) : bodies;
  if (only) for (const n of only) if (!bodies.some((b) => b.name === n)) throw new Error("no body named " + n + " in " + bodiesPath);
  mkdirSync(out, { recursive: true });
  const ctx = { root: ROOT, sources, out, updateMeasure, handsFeet };
  const results = [];
  for (const row of pick) {
    const r = await runBody(row, ctx);
    results.push(r);
    console.log(`${verdict(r).padEnd(9)} ${row.name}${r.error ? "  " + r.error : ""}`);
  }
  let git = null;
  try { git = execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { /* not a checkout */ }
  const meta = { rows: basename(bodiesPath), sources: basename(sources), git }; // the folder name only: an absolute path would make the receipt depend on where it ran
  writeFileSync(join(out, "RECEIPT.md"), receiptMarkdown(results, meta));
  writeFileSync(join(out, "receipt.json"), JSON.stringify({ schema: "cut-batch-receipt/1", ...meta, bodies: results.map((r) => ({ ...r, verdict: verdict(r) })) }, null, 1) + "\n");
  const failed = results.filter((r) => ["FAIL", "UNBLOCKED"].includes(verdict(r)));
  return { results, failed };
}

async function main() {
  const a = process.argv.slice(2);
  const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  if (a.includes("--help") || a.includes("-h")) { console.log("usage: node tools/cut-batch.mjs [--bodies data/cut-bodies.json] [--sources <dir>] [--out <dir>] [--only a,b] [--update-measure] [--hands-feet]"); return 0; }
  const bodiesPath = rel(process.cwd(), opt("--bodies", join(ROOT, "data/cut-bodies.json")));
  const sources = rel(process.cwd(), opt("--sources", process.env.CUT_SOURCES || "/root/cut-out"));
  const out = rel(process.cwd(), opt("--out", "cut-batch-out"));
  const only = opt("--only", null);
  const { results, failed } = await runBatch({ bodiesPath, sources, out, only: only ? only.split(",") : null, updateMeasure: a.includes("--update-measure"), handsFeet: a.includes("--hands-feet") });
  console.log(`receipt ${join(out, "RECEIPT.md")}`);
  if (failed.length) { console.error(`CUT BATCH FAILED: ${failed.map((r) => r.name + " " + verdict(r)).join(", ")}`); return 1; }
  console.log(`cut batch ok: ${results.length} bodies`);
  return 0;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().then((c) => { process.exitCode = c; }, (e) => { console.error(e.stack || e); process.exitCode = 1; });
