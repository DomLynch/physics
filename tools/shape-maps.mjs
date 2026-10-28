// One ragdoll rig map per body SHAPE on the 106-joint Mixamo rig, plus a body -> shape lookup table.
//
//   node tools/shape-maps.mjs --out data/shape-maps --glb <any 106 glb> \
//        --measure mixamo=<file.json>  --measure makehuman=<file.json>[#idRegex] ...  [--k 7]
//
// Each --measure file is a { bodyId: body_measure_row } object (height_m, lengths, widths, 20 role joint positions: the OpenTrident rows or the
// data/bodies/*.measure.json rows). For every body the repo's own generator (src/generate.mjs, role table data/ragdoll-role-table.json) makes the full
// ragdoll row; the bodies are grouped by shape (log height, log volume / height^3, leg share of height; deterministic k-means) and each group gets ONE
// map: per role joint, capsule radius and length as fractions of height, mass as a fraction of body mass, and the joint limit. The lookup gives each body
// its shape and its three scalars (height, girth, mass), so a Physics row is [shape, h, g, kg] instead of a 30 KB ragdoll row.
// Deterministic: same inputs, same bytes. Plain JS, no dependencies.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { generateRow, loadTable } from "../src/generate.mjs";

const J = (p) => JSON.parse(readFileSync(p, "utf8"));
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// ---- the 106 joint names and which role joint each one rides on, from the node tree of any 106-rig GLB
export function glbSkin(path) {
  const b = readFileSync(path);
  const len = b.readUInt32LE(12);
  const g = JSON.parse(b.subarray(20, 20 + len).toString("utf8"));
  const parent = new Map();
  g.nodes.forEach((n, i) => (n.children || []).forEach((c) => parent.set(c, i)));
  const joints = g.skins[0].joints.map((i) => ({ i, name: g.nodes[i].name }));
  return { g, parent, joints };
}
export const ROLE_JOINTS = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "LeftArm", "LeftForeArm", "LeftHand", "RightArm", "RightForeArm", "RightHand",
  "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase", "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"];
export const PREFIX = "mixamorig:";

function followTable(glb) {
  const { g, parent, joints } = glbSkin(glb);
  const roleSet = new Set(ROLE_JOINTS.map((n) => PREFIX + n));
  const follow = {};
  for (const j of joints) {
    if (roleSet.has(j.name)) continue;
    let p = parent.get(j.i), hit = null;
    while (p !== undefined && !hit) { if (roleSet.has(g.nodes[p].name)) hit = g.nodes[p].name; p = parent.get(p); }
    follow[j.name] = hit;
  }
  return { names: joints.map((j) => j.name), follow };
}

// ---- args
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i < 0 ? d : argv[i + 1]; };
const all = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));
if (import.meta.url === `file://${process.argv[1]}`) main();

function main() {
  const out = opt("--out", "data/shape-maps"), K = Number(opt("--k", 7)), glb = opt("--glb");
  const table = loadTable();
  const refSpec = opt("--reference");
  const ref = refSpec ? J(refSpec.split(":")[0])[refSpec.split(":")[1]] : null;
  const bodies = [];
  const seen = new Set();
  for (const spec of all("--measure")) {
    const [family, rest] = spec.split("=");
    const [file, re] = rest.split("#");
    const rx = re ? new RegExp(re) : null;
    for (const [id, m] of Object.entries(J(file))) {
      if (seen.has(id) || !m || !m.joints || !m.height_m || (rx && !rx.test(id))) continue;
      if (!ROLE_JOINTS.every((k) => m.joints[k])) continue;
      seen.add(id);
      const row = generateRow(id, m, table, { referenceRow: ref });
      const R = Object.fromEntries(row.roles.map((x) => [x.id, x]));
      bodies.push({ id, family, row, R, H: row.height_m, mass: row.total_mass_kg, B: row.body_volume_m3 / row.height_m ** 3,
        leg: (R.thighLeft.length_m + R.shinLeft.length_m) / row.height_m });
    }
  }

  // ---- group by shape. Scale outliers (height under 1.0 m or over 3.0 m: a GLB node-scale error, not a body) are left out of the fit and assigned afterwards.
  // Children (under 1.45 m) are their own shape; the rest go through deterministic k-means on (ln H, ln B, 0.5 x leg share), z-scored.
  const OUT_LO = 1.0, OUT_HI = 3.0, CHILD_H = 1.45;
  const outliers = bodies.filter((b) => b.H < OUT_LO || b.H > OUT_HI);
  const fit = bodies.filter((b) => b.H >= OUT_LO && b.H <= OUT_HI);
  const child = fit.filter((b) => b.H < CHILD_H), rest = fit.filter((b) => b.H >= CHILD_H);
  const feat = (b) => [Math.log(b.H), Math.log(b.B), b.leg];
  const F = rest.map(feat);
  const mu = [0, 1, 2].map((t) => F.reduce((a, f) => a + f[t], 0) / F.length);
  const sd = [0, 1, 2].map((t) => Math.sqrt(F.reduce((a, f) => a + (f[t] - mu[t]) ** 2, 0) / F.length));
  const WT = [1, 1, 0.5];
  const zf = (b) => feat(b).map((v, t) => (WT[t] * (v - mu[t])) / sd[t]);
  const Z = rest.map(zf);
  const kk = child.length >= 3 ? K - 1 : K;
  const order = Z.map((_, i) => i).sort((a, b) => Z[a][0] + Z[a][1] - (Z[b][0] + Z[b][1]) || a - b);
  let C = Array.from({ length: kk }, (_, j) => Z[order[Math.floor(((j + 0.5) * Z.length) / kk)]].slice());
  const near = (C, z) => { let best = 0, bd = Infinity; C.forEach((c, j) => { const d = c.reduce((s, v, t) => s + (v - z[t]) ** 2, 0); if (d < bd) { bd = d; best = j; } }); return best; };
  let A = [];
  for (let it = 0; it < 200; it++) {
    A = Z.map((z) => near(C, z));
    const N = C.map((c, j) => { const m = Z.filter((_, i) => A[i] === j); return m.length ? [0, 1, 2].map((t) => m.reduce((s, z) => s + z[t], 0) / m.length) : c; });
    if (JSON.stringify(N) === JSON.stringify(C)) break;
    C = N;
  }
  const centroid = (m) => [0, 1, 2].map((t) => m.reduce((s, b) => s + zf(b)[t], 0) / m.length);
  const raw = C.map((_, j) => ({ fit: rest.filter((_, i) => A[i] === j), out: [] })).filter((g) => g.fit.length);
  if (child.length >= 3) raw.push({ fit: child, out: [] });
  const cents = raw.map((g) => centroid(g.fit));
  for (const b of outliers) raw[near(cents, zf(b))].out.push(b);

  // ---- name each group from its median height and build
  const hTier = (h) => (h < 1.45 ? "child" : h < 1.65 ? "short" : h < 1.85 ? "average" : h < 2.1 ? "tall" : "giant");
  const bTier = (b) => (b < 0.0095 ? "slim" : b < 0.016 ? "medium" : b < 0.03 ? "heavy" : "massive");
  const groups = raw;
  groups.sort((a, b) => med(a.fit.map((x) => x.H)) - med(b.fit.map((x) => x.H)) || med(a.fit.map((x) => x.B)) - med(b.fit.map((x) => x.B)));
  const used = {};
  const roleDefs = [
    // [key, role id (left variant for sided), sided]
    ["Hips", "hips", 0], ["Spine", "spine", 0], ["Spine1", "spine1", 0], ["Spine2", "spine2", 0], ["Neck", "neck", 0], ["Head", "head", 0],
    ["{S}Arm", "arm", 1], ["{S}ForeArm", "forearm", 1], ["{S}Hand", "hand", 1], ["{S}UpLeg", "thigh", 1], ["{S}Leg", "shin", 1], ["{S}Foot", "foot", 1], ["{S}ToeBase", "toe", 1],
  ];
  const RR = (b, id, sided, S) => b.R[sided ? id + S : id];
  const { names, follow } = followTable(glb);
  const maps = {}, lookup = {}, report = [], excluded = {};
  groups.forEach((grp, gi) => {
    const g = grp.fit;
    const ht = hTier(med(g.map((x) => x.H)));
    let name = ht === "child" ? "child" : ht + "-" + bTier(med(g.map((x) => x.B)));
    if (used[name]) name += "-" + String.fromCharCode(96 + ++used[name]); else used[name] = 1;
    const roles = {};
    for (const [key, id, sided] of roleDefs) {
      const L = g.map((b) => RR(b, id, sided, "Left")), Rt = g.map((b) => RR(b, id, sided, "Right"));
      const both = sided ? [...L, ...Rt] : L;
      const first = L[0];
      const prefix = (s) => (s ? s.replace(/^(Left|Right)/, "{S}") : s);
      const rolePar = first.parent ? (sided || /Left|Right/.test(first.parent) ? first.parent.replace(/(Left|Right)$/, "") : first.parent) : null;
      const parentKey = rolePar ? roleDefs.find((d) => d[1] === rolePar)[0] : null;
      roles[key] = {
        end: first.bone_end ? prefix(first.bone_end) : null,
        ext: first.extends_beyond ? table.reference[first.extends_beyond + "_ext_height_ratio"] : undefined,
        parent: parentKey,
        r: r5(med(both.map((x, i) => x.radius_m / g[i % g.length].H))),
        l: r5(med(both.map((x, i) => x.length_m / g[i % g.length].H))),
        m: r5(med(both.map((x, i) => x.mass_kg / g[i % g.length].mass))),
        j: first.joint ? (first.joint.type === "hinge" ? ["hinge", first.joint.hinge_min_deg, first.joint.hinge_max_deg] : [first.joint.type, first.joint.swing_deg, first.joint.twist_deg]) : null,
      };
      if (roles[key].ext === undefined) delete roles[key].ext;
    }
    // per-body scalars: girth g is the median ratio of the body's radii to the shape's radii at its own height
    const errBefore = [], errAfter = [];
    for (const o of grp.out) excluded[o.id] = `scale outlier: height ${Math.round(o.H * 1000)} mm from a GLB node-scale error, not a body; no shape (re-measure the GLB and rerun)`;
    for (const b of g) {
      const ratios = [];
      for (const [key, id, sided] of roleDefs) for (const S of sided ? ["Left", "Right"] : [""]) {
        const x = RR(b, id, sided, S); if (x.radius_m > 0) ratios.push(x.radius_m / (roles[key].r * b.H));
      }
      const girth = r4(med(ratios));
      lookup[b.id] = [gi, Math.round(b.H * 1000), Math.round(girth * 100), Math.round(b.mass * 10), Math.round(b.row.total_mass_before_clamp_kg * 10)];
      for (const [key, id, sided] of roleDefs) for (const S of sided ? ["Left", "Right"] : [""]) {
        const x = RR(b, id, sided, S); if (x.radius_m <= 0) continue;
        errBefore.push(Math.abs(roles[key].r * b.H - x.radius_m) / x.radius_m);
        errAfter.push(Math.abs(roles[key].r * b.H * (lookup[b.id][2] / 100) - x.radius_m) / x.radius_m);
      }
    }
    const Hs = g.map((x) => x.H), Ms = g.map((x) => x.mass);
    maps[name] = {
      schema: "shape-map/1", shape: name, rig: "mixamo-106", prefix: PREFIX, table: table.schema, n: g.length,
      height_m: [r4(Math.min(...Hs)), r4(med(Hs)), r4(Math.max(...Hs))], mass_kg: [r4(Math.min(...Ms)), r4(med(Ms)), r4(Math.max(...Ms))],
      use: "radius_m = r * height * girth; length_m = l * height; mass_kg = m * body_mass; node = prefix + key with {S} -> Left / Right; end null + ext = extension of ext * height beyond the joint along the parent bone. Limits are the role table's, in degrees.",
      roles,
    };
    lookup.__names ??= []; lookup.__names.push(name);
    report.push({ shape: name, n: g.length + grp.out.length, scaleOutliers: grp.out.map((x) => x.id + " " + x.H + " m"), medianH: r4(med(Hs)), medianMass: r4(med(Ms)), clamped140: g.filter((x) => x.mass >= 140).length,
      families: Object.fromEntries([...new Set(g.map((x) => x.family))].map((f) => [f, g.filter((x) => x.family === f).length])),
      radiusErrMedianNoGirth: r4(med(errBefore)), radiusErrMedian: r4(med(errAfter)), radiusErrP95: r4(pct(errAfter, 0.95)), example: g.reduce((a, b) => (Math.abs(b.H - med(Hs)) < Math.abs(a.H - med(Hs)) ? b : a)).id });
  });
  const shapeNames = lookup.__names; delete lookup.__names;

  // ---- write
  mkdirSync(out, { recursive: true });
  const fmt = (m) => {
    const head = JSON.stringify({ ...m, roles: undefined }).slice(0, -1);
    const rl = Object.entries(m.roles).map(([k, v]) => "  " + JSON.stringify(k) + ":" + JSON.stringify(v)).join(",\n");
    return head + ',"roles":{\n' + rl + "\n}}\n";
  };
  const sizes = {};
  for (const n of shapeNames) { const s = fmt(maps[n]); writeFileSync(`${out}/${n}.map.json`, s); sizes[n] = Buffer.byteLength(s); }
  const idx = {
    schema: "body-shape-lookup/1", rig: "mixamo-106",
    row: "body -> [shapeIndex, height_mm, girth_x100, mass_kg_x10, unclamped_mass_kg_x10]; shape = shapes[shapeIndex]; radius_m = map.r * height_m * girth; role mass_kg = map.m * mass. Girth is the body's own radius scale against its shape (a heavy MakeHuman body in an average shape reads 1.3, say). Use bodyShape(lookup, id) from src/shape-maps.mjs: it throws for an unknown or excluded id.",
    rules: {
      child_max_height_mm: Math.round(CHILD_H * 1000),
      child: "Height under 1450 mm is the child shape, whatever the build: a small adult under 1.45 m (e.g. mon-0056, 1445 mm) becomes a child, and mon-0846 at 1462 mm is average-heavy. The height is the only input; there is no age field in the measure rows.",
      mass: `mass_kg_x10 is the role table's mass clamped to 18..140 kg (the role table's bounds), so it reads exactly 140 for ${Object.values(lookup).filter((v) => v[3] === 1400).length} of ${Object.keys(lookup).length} bodies (and 18 for ${Object.values(lookup).filter((v) => v[3] === 180).length}). The 5th value is the unclamped volume-based mass: use it to scale impulses. The clamp is deliberate for ragdoll joint stiffness, not a measurement.`,
      excluded: "Scale outliers (height under 1.0 m or over 3.0 m) have no shape: bodyShape throws.",
    },
    shapes: shapeNames, excluded, bodies: lookup,
  };
  const lines = Object.entries(lookup).map(([k, v]) => "  " + JSON.stringify(k) + ":" + JSON.stringify(v));
  writeFileSync(`${out}/body-shapes.json`, JSON.stringify({ ...idx, bodies: undefined }).slice(0, -1) + ',"bodies":{\n' + lines.join(",\n") + "\n}}\n");
  const fhead = JSON.stringify({
    schema: "rig-follow/1", rig: "mixamo-106", about: "The 106 skin joints of the Mixamo-106 rig: the 20 role joints (prefix + ROLE name) carry a capsule in every shape map; every other joint rides on the nearest ancestor role joint (null = no collider: root, ik_*, fk cloth/socket chains handled by the game).",
    count: names.length, roleJoints: ROLE_JOINTS,
  }).slice(0, -1);
  writeFileSync(`${out}/rig-106-follow.json`, fhead + ',"follow":{\n' + Object.entries(follow).map(([k, v]) => "  " + JSON.stringify(k) + ":" + JSON.stringify(v)).join(",\n") + "\n}}\n");
  writeFileSync(`${out}/REPORT.json`, JSON.stringify({ bodies: bodies.length, shapes: report, bytesPerMap: sizes, lookupBytes: Buffer.byteLength(readFileSync(`${out}/body-shapes.json`)) }, null, 1) + "\n");
  console.log(JSON.stringify({ bodies: bodies.length, shapes: report.map((r) => [r.shape, r.n, r.radiusErrMedian, r.radiusErrP95]), sizes }, null, 0));
}
