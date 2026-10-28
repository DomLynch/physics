// Load the shape maps and check that every joint name they use resolves on real 106-rig GLBs.
//   node tools/shape-maps-validate.mjs [--dir data/shape-maps] body.glb [more.glb ...]
// The body id is the file name without .glb (and without -phone / -full-phone-mixamorig); it is looked up in body-shapes.json. A GLB whose id is
// not in the lookup is still checked against every map. Exit 1 on the first unresolved joint.
import { readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { glbSkin, PREFIX } from "./shape-maps.mjs";

const args = process.argv.slice(2);
const di = args.indexOf("--dir");
const dir = di >= 0 ? args.splice(di, 2)[1] : "data/shape-maps";
export function loadMaps(dir) {
  const maps = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".map.json"))) { const m = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")); maps[m.shape] = m; }
  return {
    maps, lookup: JSON.parse(readFileSync(`${dir}/body-shapes.json`, "utf8")), follow: JSON.parse(readFileSync(`${dir}/rig-106-follow.json`, "utf8")),
  };
}
// every node name a map uses: key, end, with {S} expanded, prefixed
export function mapJoints(map) {
  const out = [];
  for (const [key, r] of Object.entries(map.roles)) for (const S of key.includes("{S}") ? ["Left", "Right"] : [""]) {
    out.push(map.prefix + key.replace("{S}", S));
    if (r.end) out.push(map.prefix + r.end.replace("{S}", S));
  }
  return [...new Set(out)];
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const { maps, lookup, follow } = loadMaps(dir);
  let bad = 0;
  const shapesChecked = new Set();
  for (const p of args) {
    const names = new Set(glbSkin(p).joints.map((j) => j.name));
    const id = basename(p, ".glb").replace(/-full-phone-mixamorig$|-phone$|\.cut$/, "").replace(/^mx-/, "");
    const row = lookup.bodies[id] || lookup.bodies[basename(p, ".glb")];
    const shape = row ? lookup.shapes[row[0]] : null;
    const all = [...Object.keys(follow.follow), ...follow.roleJoints.map((n) => PREFIX + n)];
    const missingFollow = all.filter((n) => !names.has(n));
    const missing = Object.values(maps).flatMap((m) => mapJoints(m).filter((n) => !names.has(n)).map((n) => `${m.shape}:${n}`));
    if (missing.length || missingFollow.length) bad++;
    if (shape) shapesChecked.add(shape);
    console.log(`${basename(p)}: ${names.size} joints, shape ${shape ?? "(not in lookup)"}, maps unresolved ${missing.length}, follow-table unresolved ${missingFollow.length}`, missing.slice(0, 3).join(" "));
  }
  console.log(`shapes with at least one real GLB checked: ${[...shapesChecked].sort().join(", ")} (${shapesChecked.size} of ${lookup.shapes.length})`);
  process.exit(bad ? 1 : 0);
}
