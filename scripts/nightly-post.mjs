// nightly-post.mjs : turn the latest nightly results (written on the VPS by scripts/physics-nightly.sh) into ONE issue per game repo, titled "Nightly physics benchmark", edited in place.
// Run it from a gh-authenticated host (the Mac); the VPS gh is not logged in. DRY RUN IS THE DEFAULT: without --post it prints the report and what it would do, and writes nothing (its only gh call is the read of the baseline file; none with --baseline-dir).
// --post is the one flag that creates or edits an issue (and, with --update-baseline, writes the baseline branch).
// Usage: node scripts/nightly-post.mjs [--post] [--dry-run] [--help] [--target physics-main,frankendom-v3,armagedom] [--update-baseline]
//          [--host root@49.12.7.18] [--key ~/.ssh/binance_futures_tool] [--results-dir /srv/dev-jobs/physics-nightly-results]
//          [--from-dir DIR] [--baseline-dir DIR] [--baseline-branch bench-results]
//   --from-dir / --baseline-dir read local files instead of ssh / the bench-results branch (tests, offline).
//   --update-baseline writes tonight's results to data/nightly-baseline/<target>.json on the bench-results branch AFTER the post (the branch must already exist; this script never creates it).
// Baseline file on that branch: data/nightly-baseline/<target>.json, a nightly/1 file { schema, sha, node, cpus, runs, cells: { '<set>/<scenario>/n<N>/<cap>': { p95_ms } } }. Missing = no regression flag.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { renderReport, flagLine, gate, validateResults } from "../tools/nightly-gate.mjs";

export const TITLE = "Nightly physics benchmark";
export const MARKER = "<!-- nightly-physics-benchmark -->";
export const TARGETS = {
  "physics-main": "DomLynch/physics",
  "frankendom-v3": "DomLynch/Frankendom-v3",
  armagedom: "DomLynch/ARMAGEDOM",
};
const PHYSICS = "DomLynch/physics";

const args = process.argv.slice(2);
const flag = (k) => args.includes("--" + k);
const opt = (k, d) => { const i = args.indexOf("--" + k); return i < 0 ? d : args[i + 1]; };
if (flag("help") || flag("h")) {
  console.log("nightly-post.mjs [--post] [--dry-run] [--target t1,t2] [--update-baseline] [--host H] [--key K] [--results-dir D] [--from-dir D] [--baseline-dir D] [--baseline-branch B]\n" +
    "Dry run is the default: without --post nothing is created or edited on GitHub (--dry-run is accepted and means the same). --post is required to write to any issue; --update-baseline needs --post.");
  process.exit(0);
}
const dry = !flag("post");
if (flag("update-baseline") && dry) console.error("--update-baseline ignored: it needs --post");
const host = opt("host", "root@49.12.7.18"), key = opt("key", `${homedir()}/.ssh/binance_futures_tool`), rdir = opt("results-dir", "/srv/dev-jobs/physics-nightly-results");
const fromDir = opt("from-dir"), baseDir = opt("baseline-dir"), branch = opt("baseline-branch", "bench-results");
const ssh = (cmd) => execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-i", key, host, cmd], { encoding: "utf8", maxBuffer: 1 << 26 });
const gh = (a, input) => execFileSync("gh", a, { encoding: "utf8", input, maxBuffer: 1 << 26, stdio: ["pipe", "pipe", "pipe"] });

// latest <date>-<target>.json; the date prefix sorts, and the target name must match exactly after it
function latestName(target, names) {
  return names.filter((n) => /^\d{4}-\d{2}-\d{2}-/.test(n) && n.slice(11) === target + ".json").sort().pop();
}
function fetchResults(target) {
  if (fromDir) { const n = latestName(target, readdirSync(fromDir)); return n ? JSON.parse(readFileSync(`${fromDir}/${n}`, "utf8")) : null; }
  const n = latestName(target, ssh(`ls -1 ${rdir}`).split("\n"));
  return n ? JSON.parse(ssh(`cat ${rdir}/${n}`)) : null;
}
function fetchBaseline(target) {
  if (baseDir) { const p = `${baseDir}/${target}.json`; return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; }
  try {
    const b64 = gh(["api", `repos/${PHYSICS}/contents/data/nightly-baseline/${target}.json?ref=${branch}`, "-q", ".content"]);
    return JSON.parse(Buffer.from(b64.trim(), "base64").toString("utf8"));
  } catch { return null; } // no branch or no file yet: no regression flag
}

function findIssue(repo) {
  const list = JSON.parse(gh(["issue", "list", "-R", repo, "--state", "open", "--search", `"${TITLE}" in:title`, "--json", "number,title", "-L", "20"]));
  return list.find((i) => i.title === TITLE)?.number ?? null;
}

function updateBaseline(target, results) {
  const { job, skipped, skip_reasons, date, target: _t, limit_ms, regress_pct, ...rest } = results; // the stored shape: schema, sha, node, cpus, runs, cells (+ the date it was taken)
  const body = JSON.stringify({ ...rest, date }, null, 2) + "\n";
  const path = `data/nightly-baseline/${target}.json`;
  let sha;
  try { sha = JSON.parse(gh(["api", `repos/${PHYSICS}/contents/${path}?ref=${branch}`])).sha; } catch { sha = undefined; }
  gh(["api", "-X", "PUT", `repos/${PHYSICS}/contents/${path}`, "-f", `message=Nightly baseline ${target} ${date}`, "-f", `branch=${branch}`, "-f", `content=${Buffer.from(body).toString("base64")}`, ...(sha ? ["-f", `sha=${sha}`] : [])]);
}

const only = opt("target");
const targets = (only ? only.split(",") : Object.keys(TARGETS));
let bad = 0;
for (const target of targets) {
  const repo = TARGETS[target];
  if (!repo) { console.error(`unknown target ${target}`); bad++; continue; }
  const res = fetchResults(target);
  if (!res) { console.error(`${target}: no results file found`); bad++; continue; }
  const errs = validateResults(res);
  if (errs.length) { console.error(`${target}: results file invalid: ${errs.join("; ")}`); bad++; continue; }
  const baseline = fetchBaseline(target);
  const body = renderReport(res, baseline);
  const line = flagLine(gate(res.cells, baseline?.cells, { limit_ms: res.limit_ms, regress_pct: res.regress_pct, skipped: res.skipped ?? [] }));
  console.log(`=== ${target} -> ${repo} issue "${TITLE}" : ${line}`);
  if (dry) {
    console.log(body + "\n");
    console.log(`(dry run, the default: with --post this would edit (or create if absent) the issue in ${repo}${flag("update-baseline") ? `, then write data/nightly-baseline/${target}.json to ${branch}` : ""}; nothing posted)\n`);
    continue;
  }
  let n = findIssue(repo);
  if (n) gh(["issue", "edit", String(n), "-R", repo, "--body-file", "-"], body);
  else console.log(`created ${gh(["issue", "create", "-R", repo, "--title", TITLE, "--body-file", "-"], body).trim()}`);
  if (n) console.log(`edited ${repo}#${n}`);
  if (flag("update-baseline")) { updateBaseline(target, res); console.log(`baseline ${target} written to ${branch}`); }
}
process.exit(bad ? 1 : 0);
