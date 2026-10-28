// GLB (bind pose) -> body measure row for createRagdoll. Reads the node tree of a skinned humanoid, takes the 20 role joints by a rig map, and derives the
// lengths from them. Widths come from joint spans and the proportions of the reference body (tagged below): they are inputs to the generator, not bone names.
//   node tools/glb-measure.mjs <file.glb> <rig-map.json> [out.json] [--yaw-fix]
import { readFileSync, writeFileSync } from "node:fs";

const [glb, mapFile, out] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const buf = readFileSync(glb);
const jl = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jl).toString("utf8"));
const map = JSON.parse(readFileSync(mapFile, "utf8")).joints;

// node world matrices (column-major 4x4) at the bind pose
const nodes = json.nodes, parent = new Array(nodes.length).fill(-1);
nodes.forEach((n, i) => (n.children || []).forEach((c) => (parent[c] = i)));
const mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
const local = (n) => {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1], [sx, sy, sz] = n.scale || [1, 1, 1], [tx, ty, tz] = n.translation || [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
};
const world = new Array(nodes.length);
const W = (i) => (world[i] ||= parent[i] < 0 ? local(nodes[i]) : mul(W(parent[i]), local(nodes[i])));
const byName = {};
nodes.forEach((n, i) => (byName[n.name] = i));
const joints = {};
// a map value is a node name, or { node, along_local_y_m }: a joint the rig lacks (toes on a 19-joint Mixamo rig), put that many metres from the node along
// the node's own +Y axis (Mixamo bones point down their length) in the bind pose
for (const [role, spec] of Object.entries(map)) {
  if (typeof spec !== "string") {
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) throw new Error("rig map entry for " + role + " must be a node name or { node, along_local_y_m }");
    if (typeof spec.node !== "string" || spec.node === "") throw new Error("rig map entry for " + role + ": node must be a non-empty string");
    if (typeof spec.along_local_y_m !== "number" || !Number.isFinite(spec.along_local_y_m)) throw new Error("rig map entry for " + role + ": along_local_y_m must be a finite number");
  }
  const name = typeof spec === "string" ? spec : spec.node;
  if (byName[name] === undefined) throw new Error("rig has no node " + name + " for " + role);
  const m = W(byName[name]);
  const len = typeof spec === "string" ? 0 : spec.along_local_y_m;
  const yl = Math.hypot(m[4], m[5], m[6]) || 1;
  joints[role] = [m[12] + (m[4] / yl) * len, m[13] + (m[5] / yl) * len, m[14] + (m[6] / yl) * len];
}
const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const J = joints, r4 = (x) => Math.round(x * 1e4) / 1e4;
// lowest joint is the floor: shift so the feet's toe joints sit on y = 0 + their own height (the generator lifts the whole body onto the floor anyway)
const floorY = Math.min(J.LeftToeBase[1], J.RightToeBase[1]);
for (const k of Object.keys(J)) J[k] = [r4(J[k][0]), r4(J[k][1] - floorY), r4(J[k][2])];
const headTop = J.Head[1] + (J.Head[1] - J.Neck[1]) * 1.9; // head capsule reaches about 0.13 of the height above the head joint (role table head_ext_height_ratio)
const height = headTop;
const shoulderW = d(J.LeftArm, J.RightArm);
// proportions of the reference body (OpenTrident M2 mh-gen-v2-0002) for the widths a joint tree does not give
const row = {
  id: process.argv[2] ? glb.split("/").pop().replace(/\.glb$/, "") : "body",
  source: glb.split("/").pop() + " bind pose via " + mapFile.split("/").pop(),
  height_m: r4(height),
  neck_len: r4(d(J.Neck, J.Head)),
  torso_len: r4(d(J.Spine, J.Neck)),
  shoulder_w: r4(shoulderW),
  upper_arm_len: r4((d(J.LeftArm, J.LeftForeArm) + d(J.RightArm, J.RightForeArm)) / 2),
  forearm_len: r4((d(J.LeftForeArm, J.LeftHand) + d(J.RightForeArm, J.RightHand)) / 2),
  thigh_len: r4((d(J.LeftUpLeg, J.LeftLeg) + d(J.RightUpLeg, J.RightLeg)) / 2),
  shin_len: r4((d(J.LeftLeg, J.LeftFoot) + d(J.RightLeg, J.RightFoot)) / 2),
  foot_len: r4((d(J.LeftFoot, J.LeftToeBase) + d(J.RightFoot, J.RightToeBase)) / 2),
  chest_w: r4(shoulderW * 1.019),
  waist_w: r4(shoulderW * 0.94),
  hip_w: r4(d(J.LeftUpLeg, J.RightUpLeg) * 1.716),
  chest_d: r4(shoulderW * 1.019 * 0.78),
  proportions_source: "chest_w 1.019 x shoulder_w, waist_w 0.94 x shoulder_w, hip_w 1.716 x hip joint gap, chest_d 0.78 x chest_w: ratios of OpenTrident mh-gen-v2-0002; limb radii left to the role table (k_len x length)",
  joints: J,
};
const text = JSON.stringify(row, null, 1);
if (out) writeFileSync(out, text); else console.log(text);
