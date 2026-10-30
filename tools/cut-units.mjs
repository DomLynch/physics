// Body GLB -> seven skinned cut regions + twelve cap meshes on the unchanged skeleton (docs/CUT-CONTRACT.md, docs/CUT-TOOL.md).
//   node tools/cut-units.mjs <body.glb> <body.measure.json> <rig-map.json> <out-dir> [--body name] [--head-split] [--belly-open] [--hands-feet]
// writes <out-dir>/<body>.cut.glb and <out-dir>/<body>.cut.manifest.json.
// Needs @gltf-transform/core + /extensions + meshoptimizer (devDependencies; the package's runtime never loads this file).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- contract tables
export const REGIONS = [
  { id: "root", mesh: "piece_root", detached_by: null },
  { id: "upper_torso", mesh: "piece_upper_torso", detached_by: "torso_waist" },
  { id: "head", mesh: "piece_head", detached_by: "head" },
  { id: "arm_left", mesh: "piece_arm_left", detached_by: "arm_left" },
  { id: "arm_right", mesh: "piece_arm_right", detached_by: "arm_right" },
  { id: "leg_left", mesh: "piece_leg_left", detached_by: "leg_left" },
  { id: "leg_right", mesh: "piece_leg_right", detached_by: "leg_right" },
];
export const CAPS = [
  { id: "cap_neck_head", region: "head", plane: "neck", shown_when_cut: "head" },
  { id: "cap_neck_torso", region: "upper_torso", plane: "neck", shown_when_cut: "head" },
  { id: "cap_shoulder_left_arm", region: "arm_left", plane: "shoulder_left", shown_when_cut: "arm_left" },
  { id: "cap_shoulder_left_torso", region: "upper_torso", plane: "shoulder_left", shown_when_cut: "arm_left" },
  { id: "cap_shoulder_right_arm", region: "arm_right", plane: "shoulder_right", shown_when_cut: "arm_right" },
  { id: "cap_shoulder_right_torso", region: "upper_torso", plane: "shoulder_right", shown_when_cut: "arm_right" },
  { id: "cap_hip_left_leg", region: "leg_left", plane: "hip_left", shown_when_cut: "leg_left" },
  { id: "cap_hip_left_root", region: "root", plane: "hip_left", shown_when_cut: "leg_left" },
  { id: "cap_hip_right_leg", region: "leg_right", plane: "hip_right", shown_when_cut: "leg_right" },
  { id: "cap_hip_right_root", region: "root", plane: "hip_right", shown_when_cut: "leg_right" },
  { id: "cap_waist_torso", region: "upper_torso", plane: "waist", shown_when_cut: "torso_waist" },
  { id: "cap_waist_root", region: "root", plane: "waist", shown_when_cut: "torso_waist" },
];
// the bone that anchors each region: the nearest ancestor-or-self of a node among these decides which region owns the bone
const ANCHOR_ROLES = { Hips: "root", Spine: "upper_torso", Head: "head", LeftArm: "arm_left", RightArm: "arm_right", LeftUpLeg: "leg_left", RightUpLeg: "leg_right" };
const REGION_ANCHOR = { root: "Hips", upper_torso: "Spine", head: "Head", arm_left: "LeftArm", arm_right: "RightArm", leg_left: "LeftUpLeg", leg_right: "RightUpLeg" };
const FLESH = { name: "cap_flesh", color: [0.55, 0.1, 0.09, 1], roughness: 0.55 };
const FLESH_INNER = { name: "cap_inner", color: [0.3, 0.03, 0.04, 1], roughness: 0.35 };

// ---------------------------------------------------------------- optional cuts (opt-in, default OFF; docs/CUT-CONTRACT.md "Optional cuts")
// Both are rows: every number and name the feature uses is here. `opts.headSplit` / `opts.bellyOpen` (true, or an object that overrides fields of the
// row) turn them on; with both off the output is byte for byte the seven pieces and twelve caps of the plain contract.
// HEAD_SPLIT: a sagittal plane splits piece_head into piece_head_left / piece_head_right (they replace piece_head). Both halves stay detached by `head`
// (they fly together while only the head is cut) and are `separated_by` the unit head_split. Caps: the neck cap of each half, and a cap on the cut face.
export const HEAD_SPLIT = {
  unit: "head_split", plane: "head_split", replaces: "head",
  point_frac: 0.5, // the plane point: this far from the Neck joint to the Head joint, then moved onto the body's symmetry plane
  regions: [
    { id: "head_left", mesh: "piece_head_left", detached_by: "head", separated_by: "head_split", bones: "head", side: 1, extra_plane: "head_split" },
    { id: "head_right", mesh: "piece_head_right", detached_by: "head", separated_by: "head_split", bones: "head", side: -1, extra_plane: "head_split" },
  ],
  caps: [
    { id: "cap_neck_head_left", region: "head_left", plane: "neck", shown_when_cut: "head" },
    { id: "cap_neck_head_right", region: "head_right", plane: "neck", shown_when_cut: "head" },
    { id: "cap_split_head_left", region: "head_left", plane: "head_split", shown_when_cut: "head_split" },
    { id: "cap_split_head_right", region: "head_right", plane: "head_split", shown_when_cut: "head_split" },
  ],
};
// BELLY_OPEN: a wound patch on the front of piece_upper_torso above the waist plane. It removes no geometry and detaches nothing: a skinned mesh
// (cap_belly_opening: a flesh rim and a dark `cap_inner` core, standing a few millimetres in front of the skin) shown when the unit belly_open is cut.
export const BELLY_OPEN = {
  unit: "belly_open", plane: "belly_open", cap: "cap_belly_opening", region: "upper_torso",
  centre_frac: 0.28, // centre height: this fraction of the way from the waist plane up to the neck plane
  half_height_frac: 0.18, // semi axis along the spine, as a fraction of the waist to neck distance
  half_width_frac: 0.3, // semi axis across the body, as a fraction of the shoulder span (LeftArm to RightArm)
  min_clearance_frac: 0.08, // the ellipse must stay at least this fraction of waist to neck above the waist plane (so it is wholly on the torso's side)
  rings: 6, segments: 32, core_frac: 0.62, // polar tessellation; the core (cap_inner) is the inner part up to this fraction of the radius
  rim_lift: 0.0015, bulge: 0.008, // metres in front of the skin along the body's forward axis: at the rim, and the extra at the centre (1 - s^2)
};
// HANDS_FEET: four more planes cut the arm pieces at the wrists and the leg pieces at the ankles, so a body has six severable parts: head, body, arms, legs,
// feet, hands. With it on, piece_arm_* end at the wrist plane and piece_hand_* hold everything beyond it (hand, fingers, gear on those bones); piece_leg_* end
// at the ankle plane and piece_foot_* hold foot and toes. The arm and leg regions keep their ids and `detached_by` (an arm cut at the shoulder carries its hand
// because the hand piece is bound to the Hand bone, which the physics carries). A wrist plane stands at the Hand joint (or `wrist_frac` of the forearm back
// toward the elbow), square to ForeArm to Hand; an ankle plane at the Foot joint (or `ankle_frac` of the lower leg back toward the knee), square to Leg to Foot.
// Each limb: the plane id, the joint the plane stands at, the joint it looks back toward, the row field holding the fraction, and the piece it is cut out of.
export const HANDS_FEET = {
  unit: "hands_feet",
  wrist_frac: 0, // fraction of ForeArm to Hand, measured from the Hand joint back toward the ForeArm joint (0: at the Hand joint)
  ankle_frac: 0, // fraction of Leg to Foot, measured from the Foot joint back toward the Leg (knee) joint (0: at the Foot joint)
  accessory_feet: false, // true: a rigid accessory layer that reaches past an ankle plane (shoes in the trouser shell) gives its triangles beyond the plane to piece_foot_* (Foot bone)
  limbs: [
    { id: "hand_left", mesh: "piece_hand_left", from: "arm_left", plane: "wrist_left", joint: "LeftHand", toward: "LeftForeArm", frac: "wrist_frac" },
    { id: "hand_right", mesh: "piece_hand_right", from: "arm_right", plane: "wrist_right", joint: "RightHand", toward: "RightForeArm", frac: "wrist_frac" },
    { id: "foot_left", mesh: "piece_foot_left", from: "leg_left", plane: "ankle_left", joint: "LeftFoot", toward: "LeftLeg", frac: "ankle_frac", with_accessories: true },
    { id: "foot_right", mesh: "piece_foot_right", from: "leg_right", plane: "ankle_right", joint: "RightFoot", toward: "RightLeg", frac: "ankle_frac", with_accessories: true },
  ],
  caps: [
    { id: "cap_wrist_left_hand", region: "hand_left", plane: "wrist_left", shown_when_cut: "hand_left" },
    { id: "cap_wrist_left_arm", region: "arm_left", plane: "wrist_left", shown_when_cut: "hand_left" },
    { id: "cap_wrist_right_hand", region: "hand_right", plane: "wrist_right", shown_when_cut: "hand_right" },
    { id: "cap_wrist_right_arm", region: "arm_right", plane: "wrist_right", shown_when_cut: "hand_right" },
    { id: "cap_ankle_left_foot", region: "foot_left", plane: "ankle_left", shown_when_cut: "foot_left" },
    { id: "cap_ankle_left_leg", region: "leg_left", plane: "ankle_left", shown_when_cut: "foot_left" },
    { id: "cap_ankle_right_foot", region: "foot_right", plane: "ankle_right", shown_when_cut: "foot_right" },
    { id: "cap_ankle_right_leg", region: "leg_right", plane: "ankle_right", shown_when_cut: "foot_right" },
  ],
};
const rowOf = (def, opt) => (opt && typeof opt === "object" ? { ...def, ...opt } : def);

// ---------------------------------------------------------------- small vector helpers
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const posLess = (a, b) => a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];

// ---------------------------------------------------------------- planes
// A plane fn has d(p) = n.p - c with n unit, so d is the signed distance. Positive side = the outer unit (head / arm / leg / upper torso).
function makeFn(id, point, normal, source) {
  const n = norm(normal);
  return { id, n, c: dot(n, point), point, source, d: (p) => n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - dot(n, point) };
}
// apex: the crotch point (where the two inner thighs meet), or null for the contract's plain thigh-normal hip planes. With an apex each hip plane
// keeps its point (the UpLeg joint) and is turned about its line to the apex, as little as possible away from the thigh normal, so the two
// hip planes meet below the pelvis, no mesh sits in the wedge under both, and the legs need no wall between them.
// PLANE_ROWS: where each plane sits, as a fraction of the way along a joint pair (a body row can override any of them: data/cut-bodies.json "planes").
// The defaults are the contract's start values, so a body with no override cuts exactly as before. A fraction of 0 is the first joint itself, 1 the second.
export const PLANE_ROWS = {
  neck_frac: 0.5, // Neck -> Head: half way
  waist_frac: 1, // Hips -> Spine: at the Spine joint
  shoulder_frac: 0, // Arm -> ForeArm: at the Arm joint
  hip_frac: 0, // UpLeg -> Leg: at the UpLeg joint
  // "joint": the shoulder plane stands square to the horizontal part of the upper arm bone (today's cut). "tilt": the same plane through the same joint,
  // turned about the arm joint toward the vertical until it clears every vertex the other regions own (a narrow-shouldered body over a wide waist,
  // hips or skirt); the plane keeps its joint, so the skeleton's sides of it, and so bone_side, do not change. See shoulderTiltFor.
  shoulder_mode: "joint",
};
export const SHOULDER_MODES = ["joint", "tilt"];
export const SHOULDER_TILT_MAX = 1; // tan 45 degrees: a plane turned further than this is no shoulder cut; the cut refuses rather than clip
export const SHOULDER_TILT_MARGIN = 0.0005; // metres: a clearing vertex ends this far from the plane, past the snap band
// The tilt that clears the body below the shoulder. The plane is d(p) = n.(p - A) + t (p_y - A_y) with n the unit shoulder normal (square to the upper
// arm, vertical part dropped) and A the arm joint, so t = 0 is today's plane and t > 0 lowers the outer side of the plane down the body (its foot swings out).
// `below` = positions of the vertices NOT owned by this arm (bones of the other regions) lying below the joint by at least minDrop: each needs d <= -margin,
// which is t >= (n.(p - A) + margin) / (A_y - p_y); t is the largest of those, never below 0. Returns { t, binding } (binding = the position that set t).
export const shoulderNormalOf = (A, B) => { const d = sub(B, A), h = [d[0], 0, d[2]]; return vlen(h) >= 0.5 * vlen(d) ? h : d; };
export const SHOULDER_TILT_SKIP_ARM_LEN = 0.25; // vertices within this fraction of the upper arm's length below the joint are shoulder tissue (deltoid, trapezius), not the wide body below
export function shoulderTiltFor(A, n, below, margin = SHOULDER_TILT_MARGIN, minDrop = 0) {
  let t = 0, binding = null;
  for (const p of below) {
    const drop = A[1] - p[1];
    if (!(drop > 0) || drop < minDrop) continue;
    const need = (dot(n, sub(p, A)) + margin) / drop;
    if (need > t) { t = need; binding = p; }
  }
  return { t, binding };
}
export const HIP_SPLIT_PARALLEL = 0.1; // |left hip normal - right hip normal| under this: thighs parallel, hip_split is the midline plane (shipped bodies: 0.20 and up)
const alongPair = (a, b, f) => (f === 0 ? a : f === 1 ? b : lerp3(a, b, f));
export function buildPlanes(J, apex = null, planeRows = PLANE_ROWS, shoulderTilts = null) {
  const PR = { ...PLANE_ROWS, ...planeRows };
  const need = ["Hips", "Spine", "Neck", "Head", "LeftArm", "LeftForeArm", "RightArm", "RightForeArm", "LeftUpLeg", "LeftLeg", "RightUpLeg", "RightLeg"];
  for (const r of need) if (!J[r]) throw new Error("measure row has no joint " + r);
  const fns = {};
  fns.neck = makeFn("neck", alongPair(J.Neck, J.Head, PR.neck_frac), sub(J.Head, J.Neck), (PR.neck_frac === 0.5 ? "half way" : PR.neck_frac + " of the way") + " from the Neck joint to the Head joint, normal along Neck to Head");
  // the upper arm bone with its vertical part dropped: a plane square to a drooping arm tilts into the flank and gives the arm a slab of ribs
  const shoulderNormal = shoulderNormalOf;
  const shSrc = "joint, normal along the upper arm bone with its vertical part dropped (a plane square to a drooping arm would cut into the flank)";
  if (!SHOULDER_MODES.includes(PR.shoulder_mode)) throw new Error(`shoulder_mode must be one of ${SHOULDER_MODES.join(", ")}, got ${JSON.stringify(PR.shoulder_mode)}`);
  if (PR.shoulder_mode === "tilt") {
    if (PR.shoulder_frac !== 0) throw new Error("shoulder_mode tilt turns the plane about the arm joint: shoulder_frac must stay 0");
    // the unit normal of each plane before the turn, and how far to turn it (cutGlb measures that from the mesh; without it the plane is today's)
    for (const [side, A, B] of [["left", J.LeftArm, J.LeftForeArm], ["right", J.RightArm, J.RightForeArm]]) {
      const n0 = norm(shoulderNormal(A, B)), t = (shoulderTilts && shoulderTilts[side]) || 0;
      fns["shoulder_" + side] = makeFn("shoulder_" + side, A, [n0[0], n0[1] + t, n0[2]],
        (side === "left" ? "LeftArm " : "RightArm ") + shSrc.replace(/\)$/, "), turned about the joint toward the vertical until it clears the other regions' vertices below the shoulder") + (t ? " (tilt " + r6(t) + ", " + r6(Math.atan(t) * 180 / Math.PI) + " degrees)" : " (no vertex below the shoulder needs it: tilt 0)"));
    }
  } else {
    fns.shoulder_left = makeFn("shoulder_left", alongPair(J.LeftArm, J.LeftForeArm, PR.shoulder_frac), shoulderNormal(J.LeftArm, J.LeftForeArm), "LeftArm " + shSrc);
    fns.shoulder_right = makeFn("shoulder_right", alongPair(J.RightArm, J.RightForeArm, PR.shoulder_frac), shoulderNormal(J.RightArm, J.RightForeArm), "RightArm " + shSrc);
  }
  const hipNormal = (H, K) => {
    const t = norm(sub(K, H));
    if (!apex) return t;
    const e = norm(sub(apex, H));
    const n = norm(sub(t, e.map((x) => x * dot(t, e))));
    return dot(n, t) > 0.3 ? n : t; // never turn the plane more than about 70 degrees from the thigh normal
  };
  const hipSrc = apex ? "UpLeg joint, normal along the thigh turned the least that puts the plane through the crotch apex" : "UpLeg joint, normal along the thigh";
  fns.hip_left = makeFn("hip_left", alongPair(J.LeftUpLeg, J.LeftLeg, PR.hip_frac), hipNormal(J.LeftUpLeg, J.LeftLeg), "LeftUpLeg joint, " + hipSrc.replace("UpLeg joint, ", ""));
  fns.hip_right = makeFn("hip_right", alongPair(J.RightUpLeg, J.RightLeg, PR.hip_frac), hipNormal(J.RightUpLeg, J.RightLeg), "RightUpLeg joint, " + hipSrc.replace("UpLeg joint, ", ""));
  fns.waist = makeFn("waist", alongPair(J.Hips, J.Spine, PR.waist_frac), sub(J.Spine, J.Hips), "Spine joint, normal along Hips to Spine");
  // internal, not a cut: where the two hip half-spaces overlap below the crotch, the side with the larger distance wins (a wall only if mesh sits there)
  const bn = sub(fns.hip_left.n, fns.hip_right.n);
  const bp = lerp3(fns.hip_left.point, fns.hip_right.point, 0.5);
  if (vlen(bn) >= HIP_SPLIT_PARALLEL) {
    fns.hip_split = makeFn("hip_split", bp, bn, "internal: bisector of the two hip planes, separates the legs where both hip half-spaces overlap (no cap of its own)");
    fns.hip_split.d = (p) => fns.hip_left.d(p) - fns.hip_right.d(p), fns.hip_split.exact = true;
    return fns;
  }
  // Parallel thighs (the two unit normals differ by under HIP_SPLIT_PARALLEL, about 5.7 degrees): the difference of the normals is a few thousandths
  // and points wherever the thighs' tiny tilt asymmetry says (front to back on Big Vegas), and its scaled distance widens the snap band by 1/|bn|.
  // The bisector is then the midline plane: through the midpoint of the two hip points, normal = left to right between the UpLeg joints with the
  // part along the mean thigh direction dropped, d in metres (positive on the left leg's side, like the bisector).
  const t = norm(fns.hip_left.n.map((x, i) => x + fns.hip_right.n[i]));
  // Two nearly parallel hip planes through the two UpLeg joints cross each other along a line across the whole body (Big Vegas: 7 mm apart at most,
  // crossing 0.1 m behind the joints), and each leaves a thin slab of the far flank to the wrong leg. With parallel thighs the two hip planes are ONE
  // plane: through the midpoint of the hip points, along the mean thigh. hip_left and hip_right stay two named planes (two root caps, two leg caps);
  // the midline splits everything that lies on it between the two sides.
  // (raised, if need be, until both hip points lie on or below it: the leg bones stay on the leg side of the plane, what the validator's bone_side check reads)
  const lift = Math.max(0, -Math.min(dot(t, sub(fns.hip_left.point, bp)), dot(t, sub(fns.hip_right.point, bp))));
  const hp = bp.map((x, i) => x - t[i] * lift);
  fns.hip_left = makeFn("hip_left", hp, t, fns.hip_left.source + "; thighs parallel: one shared plane with hip_right (mean thigh direction, through the midpoint of the two hip points, raised until both hip points are on it or below)");
  fns.hip_right = makeFn("hip_right", hp, t, fns.hip_right.source + "; thighs parallel: one shared plane with hip_left (mean thigh direction, through the midpoint of the two hip points, raised until both hip points are on it or below)");
  const lat0 = sub(J.LeftUpLeg, J.RightUpLeg), lat = norm(sub(lat0, t.map((x) => x * dot(lat0, t))));
  fns.hip_split = makeFn("hip_split", bp, lat, "internal: midline plane (the thighs are parallel, so the bisector of the two hip planes is undefined), normal left to right between the UpLeg joints, separates the legs where both hip half-spaces overlap (its wall caps are triangles of the two leg caps)");
  fns.hip_split.exact = true;
  fns.hip_split.midline = true; // cutGlb: wall caps on this plane, and the shared hip plane's root cap is shared out left and right by it
  return fns;
}

// The body's own axes from the joints (T-pose or any pose with the legs apart): lateral = Right to Left (arms and hips, vertical part dropped),
// centre = the symmetry plane's offset along lateral (mean of the four joints), forward = Foot to ToeBase made square to lateral.
export function bodyAxes(J) {
  const flat = (a, b) => { const d = sub(J[a], J[b]); return [d[0], 0, d[2]]; };
  const lat = norm([0, 1, 2].map((k) => norm(flat("LeftArm", "RightArm"))[k] + norm(flat("LeftUpLeg", "RightUpLeg"))[k]));
  if (!(vlen(flat("LeftArm", "RightArm")) > 1e-6)) throw new Error("the Left and Right arm joints coincide: no left-right axis");
  const centre = (dot(lat, J.LeftArm) + dot(lat, J.RightArm) + dot(lat, J.LeftUpLeg) + dot(lat, J.RightUpLeg)) / 4;
  let fwd = [0, 0, 0];
  for (const [t, f] of [["LeftToeBase", "LeftFoot"], ["RightToeBase", "RightFoot"]]) if (J[t] && J[f]) { const d = sub(J[t], J[f]); fwd = [fwd[0] + d[0], 0, fwd[2] + d[2]]; }
  fwd = sub(fwd, lat.map((x) => x * dot(fwd, lat)));
  if (!(vlen(fwd) > 1e-6)) fwd = cross(lat, [0, 1, 0]);
  return { lat, centre, fwd: norm(fwd) };
}
// head_split: the plane through the Neck to Head line (moved onto the symmetry plane), normal = lateral (Right to Left): + side is the left half
export function buildHeadSplitPlane(J, row = HEAD_SPLIT) {
  const { lat, centre } = bodyAxes(J);
  const a = lerp3(J.Neck, J.Head, row.point_frac), pt = sub(a, lat.map((x) => x * (dot(lat, a) - centre)));
  return makeFn("head_split", pt, lat, "Neck to Head midline " + row.point_frac + " of the way, moved onto the body's symmetry plane; normal = the left-right axis (Right to Left, from the arm and hip joints)");
}

// hands_feet: wrist and ankle planes from the measure row's joints. The normal points from the proximal joint to the distal one (ForeArm to Hand, Leg to Foot),
// so the + side is the hand or the foot. Returns { plane id: plane fn }.
export function buildHandsFeetPlanes(J, row = HANDS_FEET) {
  const fns = {};
  if (row.accessory_feet !== undefined && typeof row.accessory_feet !== "boolean") throw new Error(`hands_feet: accessory_feet must be true or false, got ${JSON.stringify(row.accessory_feet)}`);
  for (const L of row.limbs) {
    for (const r of [L.joint, L.toward]) if (!J[r]) throw new Error("hands_feet: measure row has no joint " + r);
    const f = row[L.frac];
    if (!(typeof f === "number" && Number.isFinite(f) && f >= 0 && f <= 1)) throw new Error(`hands_feet: ${L.frac} must be a number from 0 to 1, got ${JSON.stringify(f)}`);
    fns[L.plane] = makeFn(L.plane, alongPair(J[L.joint], J[L.toward], f), sub(J[L.joint], J[L.toward]),
      `${L.joint} joint${f ? ", " + f + " of the way back toward " + L.toward : ""}, normal along ${L.toward} to ${L.joint}`);
  }
  return fns;
}

// ---------------------------------------------------------------- weld analysis (exported: the tests use the same measure)
// meshes: [{ positions: ArrayLike<number> (xyz), indices: ArrayLike<number> }]. Welds points closer than tol (metres), counts directed edges.
// A closed oriented surface has every directed edge exactly once and its reverse exactly once.
export function weldReport(meshes, tol = 1e-5, collect = false) {
  const pts = [], base = [];
  for (const m of meshes) { base.push(pts.length); for (let i = 0; i < m.positions.length; i += 3) pts.push([m.positions[i], m.positions[i + 1], m.positions[i + 2]]); }
  const wid = weldCluster(pts, tol);
  const firstPos = [];
  for (let i = 0; i < pts.length; i++) if (firstPos[wid[i]] === undefined) firstPos[wid[i]] = pts[i];
  const edge = new Map();
  let degenerate = 0, tris = 0;
  meshes.forEach((m, mi) => {
    for (let t = 0; t + 2 < m.indices.length; t += 3) {
      const a = wid[base[mi] + m.indices[t]], b = wid[base[mi] + m.indices[t + 1]], c = wid[base[mi] + m.indices[t + 2]];
      tris++;
      if (a === b || b === c || c === a) degenerate++;
      for (const [u, v] of [[a, b], [b, c], [c, a]]) if (u !== v) edge.set(u * 4194304 + v, (edge.get(u * 4194304 + v) || 0) + 1);
    }
  });
  const ids = { size: firstPos.length };
  let boundary = 0, nonManifold = 0;
  const boundaryAt = [];
  for (const [k, cnt] of edge) {
    const u = Math.floor(k / 4194304), v = k % 4194304;
    const rev = edge.get(v * 4194304 + u) || 0;
    if (cnt > 1) nonManifold++;
    if (cnt > rev) { boundary += cnt - rev; if (collect || boundaryAt.length < 8) boundaryAt.push([firstPos[u], firstPos[v]]); }
  }
  return { boundary_list: collect ? boundaryAt : undefined, triangles: tris, vertices: ids.size, degenerate, boundary_edges: boundary, non_manifold_edges: nonManifold, watertight: boundary === 0 && nonManifold === 0, boundary_sample: boundaryAt };
}

// cluster points closer than tol (union-find over a spatial hash); returns a compact id per point, ids in order of first appearance
export function weldCluster(points, tol) {
  const n = points.length, parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const inv = 1 / tol, grid = new Map(), t2 = tol * tol;
  const key = (x, y, z) => (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  for (let i = 0; i < n; i++) {
    const p = points[i], cx = Math.floor(p[0] * inv), cy = Math.floor(p[1] * inv), cz = Math.floor(p[2] * inv);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = grid.get(key(cx + dx, cy + dy, cz + dz));
      if (!list) continue;
      for (const j of list) {
        const q = points[j];
        if ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2 <= t2) { const a = find(i), b = find(j); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); }
      }
    }
    const k = key(cx, cy, cz);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  const ids = new Int32Array(n), compact = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!compact.has(r)) compact.set(r, compact.size); ids[i] = compact.get(r); }
  return ids;
}

// ---------------------------------------------------------------- polygon triangulation (ear clipping with hole bridging)
// outer: CCW points [{x,y,i}], holes: CW rings. Returns flat [i,i,i,...] with CCW triangles; every input vertex is used (none dropped,
// so the cap's boundary edges match the piece's edges exactly). stats.forced counts ears clipped without passing the strict test.
const area2 = (a, b, c) => (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y); // < 0 convex (CCW polygon), >= 0 reflex or flat
const same2 = (a, b) => a.x === b.x && a.y === b.y;
function inTri(a, b, c, p) {
  return (c.x - p.x) * (a.y - p.y) - (a.x - p.x) * (c.y - p.y) >= 0 && (a.x - p.x) * (b.y - p.y) - (b.x - p.x) * (a.y - p.y) >= 0 && (b.x - p.x) * (c.y - p.y) - (c.x - p.x) * (b.y - p.y) >= 0;
}
function ring(pts, ccw) {
  let a = 0;
  for (let k = 0; k < pts.length; k++) { const p = pts[k], q = pts[(k + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
  const arr = (a > 0) === ccw ? pts : pts.slice().reverse();
  let first = null, last = null;
  for (const p of arr) { const n = { i: p.i, x: p.x, y: p.y, prev: null, next: null }; if (!first) first = n; else { last.next = n; n.prev = last; } last = n; }
  last.next = first; first.prev = last;
  return first;
}
function locallyInside(a, b) {
  return area2(a.prev, a, a.next) < 0 ? area2(a, b, a.next) >= 0 && area2(a, a.prev, b) >= 0 : area2(a, b, a.prev) < 0 || area2(a, a.next, b) < 0;
}
function findHoleBridge(hole, outer) {
  let p = outer, qx = -Infinity, m = null;
  const hx = hole.x, hy = hole.y;
  do {
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + (hy - p.y) * (p.next.x - p.x) / (p.next.y - p.y);
      if (x <= hx && x > qx) { qx = x; m = p.x < p.next.x ? p : p.next; if (x === hx) return m; }
    }
    p = p.next;
  } while (p !== outer);
  if (!m) return null;
  const stop = m, mx = m.x, my = m.y;
  let tanMin = Infinity;
  p = m;
  do {
    if (hx >= p.x && p.x >= mx && hx !== p.x && inTri({ x: hy < my ? hx : qx, y: hy }, { x: mx, y: my }, { x: hy < my ? qx : hx, y: hy }, p)) {
      const tan = Math.abs(hy - p.y) / (hx - p.x);
      if (locallyInside(p, hole) && (tan < tanMin || (tan === tanMin && p.x > m.x))) { m = p; tanMin = tan; }
    }
    p = p.next;
  } while (p !== stop);
  return m;
}
function splitPolygon(a, b) {
  const a2 = { i: a.i, x: a.x, y: a.y, prev: null, next: null }, b2 = { i: b.i, x: b.x, y: b.y, prev: null, next: null };
  const an = a.next, bp = b.prev;
  a.next = b; b.prev = a; a2.next = an; an.prev = a2; b2.next = a2; a2.prev = b2; bp.next = b2; b2.prev = bp;
  return b2;
}
export function triangulateLoops(outerPts, holePts, stats = { forced: 0, bridgeFallback: 0 }) {
  let outer = ring(outerPts, true);
  const holes = holePts.map((h) => {
    let n = ring(h, false), left = n, p = n;
    do { if (p.x < left.x || (p.x === left.x && p.y < left.y)) left = p; p = p.next; } while (p !== n);
    return left;
  }).sort((a, b) => a.x - b.x || a.y - b.y);
  for (const h of holes) {
    let m = findHoleBridge(h, outer);
    if (!m) { // no visible segment: join to the nearest outer vertex
      stats.bridgeFallback++;
      let best = Infinity, p = outer;
      do { const d = (p.x - h.x) ** 2 + (p.y - h.y) ** 2; if (d < best) { best = d; m = p; } p = p.next; } while (p !== outer);
    }
    splitPolygon(m, h);
  }
  let n = 0, p = outer;
  do { n++; p = p.next; } while (p !== outer);
  const tris = [];
  let ear = outer, fails = 0, mode = 0;
  const isEar = (e, md) => {
    const a = e.prev, c = e.next, ar = area2(a, e, c);
    if (md === 0 ? ar >= 0 : ar > 0) return false;
    for (let q = c.next; q !== a; q = q.next) {
      if (same2(q, a) || same2(q, e) || same2(q, c)) continue;
      if (inTri(a, e, c, q) && area2(q.prev, q, q.next) >= 0) return false;
    }
    return true;
  };
  while (n > 3) {
    if (mode === 3 || isEar(ear, mode)) {
      if (mode === 3) stats.forced++;
      tris.push(ear.prev.i, ear.i, ear.next.i);
      const nx = ear.next;
      ear.prev.next = nx; nx.prev = ear.prev;
      ear = nx; n--; fails = 0; mode = 0;
      continue;
    }
    ear = ear.next; fails++;
    if (fails >= n) {
      fails = 0; mode++;
      if (mode === 3) { // forced: the most convex vertex
        let best = ear, bv = Infinity, q = ear;
        do { const ar = area2(q.prev, q, q.next); if (ar < bv) { bv = ar; best = q; } q = q.next; } while (q !== ear);
        ear = best;
      }
    }
  }
  tris.push(ear.prev.i, ear.i, ear.next.i);
  return tris;
}

// ---------------------------------------------------------------- GLB io (gltf-transform; the V3 bodies are meshopt compressed)
async function gltfIO() {
  const { NodeIO } = await import("@gltf-transform/core");
  const { ALL_EXTENSIONS } = await import("@gltf-transform/extensions");
  const { MeshoptDecoder } = await import("meshoptimizer");
  await MeshoptDecoder.ready;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
}
const mul4 = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; }; // column-major a x b

// Vertex space -> world for one skin (Q = jointWorld x inverseBind, the same for every joint of the skin): the row-major 3x3 A, its inverse Ai, the
// inverse of Q as a column-major matrix (Qinv, what the inverse binds absorb), and the position, normal (A^-T n) and tangent maps.
function vertexFrame(Q) {
  const A = [Q[0], Q[4], Q[8], Q[1], Q[5], Q[9], Q[2], Q[6], Q[10]];
  const [a0, b0, c0, d0, e0, f0, g0, h0, i0] = A, det = a0 * (e0 * i0 - f0 * h0) - b0 * (d0 * i0 - f0 * g0) + c0 * (d0 * h0 - e0 * g0);
  const Ai = [(e0 * i0 - f0 * h0) / det, (c0 * h0 - b0 * i0) / det, (b0 * f0 - c0 * e0) / det, (f0 * g0 - d0 * i0) / det, (a0 * i0 - c0 * g0) / det, (c0 * d0 - a0 * f0) / det, (d0 * h0 - e0 * g0) / det, (b0 * g0 - a0 * h0) / det, (a0 * e0 - b0 * d0) / det];
  const t = [-(Ai[0] * Q[12] + Ai[1] * Q[13] + Ai[2] * Q[14]), -(Ai[3] * Q[12] + Ai[4] * Q[13] + Ai[5] * Q[14]), -(Ai[6] * Q[12] + Ai[7] * Q[13] + Ai[8] * Q[14])];
  return {
    Q, A, Ai,
    Qinv: [Ai[0], Ai[3], Ai[6], 0, Ai[1], Ai[4], Ai[7], 0, Ai[2], Ai[5], Ai[8], 0, t[0], t[1], t[2], 1],
    toWorld: (p) => [A[0] * p[0] + A[1] * p[1] + A[2] * p[2] + Q[12], A[3] * p[0] + A[4] * p[1] + A[5] * p[2] + Q[13], A[6] * p[0] + A[7] * p[1] + A[8] * p[2] + Q[14]],
    normalToWorld: (n) => norm([Ai[0] * n[0] + Ai[3] * n[1] + Ai[6] * n[2], Ai[1] * n[0] + Ai[4] * n[1] + Ai[7] * n[2], Ai[2] * n[0] + Ai[5] * n[1] + Ai[8] * n[2]]),
    tangentToWorld: (t3) => [A[0] * t3[0] + A[1] * t3[1] + A[2] * t3[2], A[3] * t3[0] + A[4] * t3[1] + A[5] * t3[2], A[6] * t3[0] + A[7] * t3[1] + A[8] * t3[2]],
  };
}
const sameQ = (a, b) => a.every((x, k) => Math.abs(x - b[k]) <= 1e-4 * (1 + Math.abs(b[k])));
const isQuantised = (doc) => doc.getRoot().listExtensionsUsed().some((e) => e.extensionName === "KHR_mesh_quantization" || e.extensionName === "EXT_meshopt_compression");

// The source GLB with meshopt and quantisation undone: plain float32 vertex attributes, same vertex space, same nodes (for plain readers such as
// tools/cut-validate.mjs: `--source-out` writes it).
export async function decompressGlb(glbBytes) {
  const io = await gltfIO();
  const doc = await io.readBinary(glbBytes instanceof Uint8Array ? glbBytes : new Uint8Array(glbBytes));
  // like the cut output: vertices in metres (vertex space -> world baked in, inverse binds absorb the inverse), so source and cut compare directly.
  // One frame per skin (an exporter that quantised each mesh on its own gives each skin its own Q); a skin with the first skin's Q shares its frame.
  const skins = doc.getRoot().listSkins(), skin = skins[0], ibm = skin && skin.getInverseBindMatrices();
  let Q = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (ibm) Q = mul4(skin.listJoints()[0].getWorldMatrix(), ibm.getElement(0, new Array(16)));
  const F0 = vertexFrame(Q);
  const quantised = isQuantised(doc); // a plain input keeps the first skin's frame and the first skin's binds only, as before
  const frameOfSkin = new Map(skins.map((sk) => {
    const sib = sk.getInverseBindMatrices();
    if (sk === skin || !sib || !quantised) return [sk, F0];
    const sj = sk.listJoints(), qAt = (i) => mul4(sj[i].getWorldMatrix(), sib.getElement(i, new Array(16)));
    const Qs = qAt(0); // a few body joints must agree (end-site and socket joints of some exporters carry binds of their own)
    const consistent = ["Head", "LeftToeBase", "RightHand"].every((nm) => { const at = sj.findIndex((j) => j.getName().replace("mixamorig:", "") === nm); return at < 0 || sameQ(qAt(at), Qs); });
    return [sk, !consistent || sameQ(Qs, Q) ? F0 : vertexFrame(Qs)];
  }));
  const frameOfMesh = new Map();
  for (const n of doc.getRoot().listNodes()) if (n.getMesh() && n.getSkin() && !frameOfMesh.has(n.getMesh())) frameOfMesh.set(n.getMesh(), frameOfSkin.get(n.getSkin()));
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) for (const sem of prim.listSemantics()) {
    const a = prim.getAttribute(sem), { toWorld, normalToWorld } = frameOfMesh.get(mesh) || F0;
    if (/^JOINTS_/.test(sem)) continue;
    const n = a.getElementSize(), out = new Float32Array(a.getCount() * n), el = new Array(n).fill(0);
    for (let i = 0; i < a.getCount(); i++) {
      a.getElement(i, el);
      if (sem === "POSITION") out.set(toWorld(el), i * n);
      else if (sem === "NORMAL") out.set(normalToWorld(el), i * n);
      else out.set(el, i * n);
    }
    prim.setAttribute(sem, doc.createAccessor().setType(a.getType()).setArray(out).setBuffer(doc.getRoot().listBuffers()[0]));
  }
  for (const sk of skins) {
    const sib = sk.getInverseBindMatrices();
    if (!sib || (!quantised && sk !== skin)) continue;
    const { Qinv } = frameOfSkin.get(sk);
    const arr = new Float32Array(sib.getCount() * 16);
    for (let i = 0; i < sib.getCount(); i++) arr.set(mul4(sib.getElement(i, new Array(16)), Qinv), i * 16);
    sib.setArray(arr);
  }
  for (const ext of doc.getRoot().listExtensionsUsed()) if (ext.extensionName === "EXT_meshopt_compression" || ext.extensionName === "KHR_mesh_quantization") ext.dispose();
  return io.writeBinary(doc);
}

// ---------------------------------------------------------------- the cutter
// The row override `rigid_accessory_materials` (cutGlb opt `rigidAccessoryMaterials`): a list of material or mesh names, each a string or { name, piece }.
// Returns [{ name, piece | null }]; undefined or null is the empty list. A typo in a row is refused here, not cut around.
export function rigidAccessorySpecs(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error("rigid_accessory_materials must be a list of material or mesh names, or { name, piece } objects");
  const ids = REGIONS.map((r) => r.id), seen = new Set();
  return list.map((e) => {
    const o = typeof e === "string" ? { name: e } : e;
    if (!o || typeof o !== "object" || Array.isArray(o) || typeof o.name !== "string" || !o.name) throw new Error("rigid_accessory_materials entries must be a non-empty name or { name, piece }, got " + JSON.stringify(e));
    for (const k of Object.keys(o)) if (k !== "name" && k !== "piece" && k !== "shells_inside") throw new Error(`rigid_accessory_materials entry ${JSON.stringify(o.name)}: unknown key ${k}`);
    if (o.piece !== undefined && !ids.includes(o.piece)) throw new Error(`rigid_accessory_materials entry ${JSON.stringify(o.name)}: piece ${JSON.stringify(o.piece)} is not one of ${ids.join(", ")}`);
    const b = o.shells_inside;
    if (b !== undefined && !(Array.isArray(b) && b.length === 2 && b.every((c) => Array.isArray(c) && c.length === 3 && c.every(Number.isFinite)) && [0, 1, 2].every((a) => b[0][a] < b[1][a]))) throw new Error(`rigid_accessory_materials entry ${JSON.stringify(o.name)}: shells_inside must be a box [[x0, y0, z0], [x1, y1, z1]] in metres with x0 < x1, y0 < y1, z0 < z1`);
    const key = o.name + "|" + JSON.stringify(b === undefined ? null : b);
    if (seen.has(key)) throw new Error(`rigid_accessory_materials names ${JSON.stringify(o.name)} twice${b === undefined ? "" : " with the same box"}`);
    seen.add(key);
    return { name: o.name, piece: o.piece === undefined ? null : o.piece, shells_inside: b === undefined ? null : b };
  });
}

export async function cutGlb(glbBytes, row, rigMap, opts = {}) {
  const io = await gltfIO();
  const doc = await io.readBinary(glbBytes instanceof Uint8Array ? glbBytes : new Uint8Array(glbBytes));
  const root = doc.getRoot();
  const report = { notes: [] };

  // ---- skeleton, bone ownership
  const skinNodes = root.listNodes().filter((n) => n.getMesh() && n.getSkin());
  if (!skinNodes.length) throw new Error("no skinned mesh node in the GLB");
  const skin0 = skinNodes[0].getSkin();
  const joints = skin0.listJoints();
  const jIndex = new Map(joints.map((n, i) => [n, i]));
  const jointByName = new Map(joints.map((n, i) => [n.getName(), i]));
  // bind pose of every joint in world space (metres) = node world translation, the way tools/glb-measure.mjs reads it
  const bindPos = joints.map((n) => n.getWorldTranslation());
  // A rig-map entry is a node name, or { node, along_local_y_m } (a joint the rig lacks: toes on the 19-joint Mixamo rig, put that far from the node along
  // its own +Y axis; tools/glb-measure.mjs reads it the same way). Only a skin joint named by a plain string gets a roleJoint (it can own vertices and
  // anchor a region); a node outside the skin (Mixamo's Spine1) or a synthesised point has only a bind position, rolePos, which is all the measure-row
  // comparison needs. Plain-string maps whose nodes are all skin joints behave exactly as before.
  const roleJoint = {}, rolePos = {};
  const nodeByName = new Map(root.listNodes().map((n) => [n.getName(), n]));
  for (const [role, spec] of Object.entries(rigMap.joints)) {
    const name = typeof spec === "string" ? spec : spec && spec.node;
    if (typeof spec !== "string" && !(spec && typeof spec === "object" && typeof name === "string" && Number.isFinite(spec.along_local_y_m))) throw new Error(`rig map entry for ${role} must be a node name or { node, along_local_y_m }`);
    if (typeof spec === "string" && jointByName.has(name)) { roleJoint[role] = jointByName.get(name); rolePos[role] = bindPos[roleJoint[role]]; continue; }
    const node = nodeByName.get(name);
    if (!node) throw new Error(`rig map names ${name} for ${role}, but the skin has no such joint`);
    if (typeof spec === "string") { rolePos[role] = node.getWorldTranslation(); continue; }
    const m = node.getWorldMatrix(), t = node.getWorldTranslation(), yl = Math.hypot(m[4], m[5], m[6]) || 1;
    rolePos[role] = [t[0] + (m[4] / yl) * spec.along_local_y_m, t[1] + (m[5] / yl) * spec.along_local_y_m, t[2] + (m[6] / yl) * spec.along_local_y_m];
  }
  for (const role of Object.keys(ANCHOR_ROLES)) if (roleJoint[role] === undefined) throw new Error(`rig map role ${role} must be a skin joint: it anchors a region`);
  // hands_feet (opt-in, default off): the hand and foot pieces are anchored at the Hand and Foot joints, so the bones past the wrist or ankle belong to them
  const handsFeet = opts.handsFeet ? rowOf(HANDS_FEET, opts.handsFeet) : null;
  if (handsFeet) for (const L of handsFeet.limbs) if (roleJoint[L.joint] === undefined) throw new Error(`rig map role ${L.joint} must be a skin joint: it anchors the region ${L.id}`);
  const anchorRoles = handsFeet ? { ...ANCHOR_ROLES, ...Object.fromEntries(handsFeet.limbs.map((L) => [L.joint, L.id])) } : ANCHOR_ROLES;
  const regionAnchor = handsFeet ? { ...REGION_ANCHOR, ...Object.fromEntries(handsFeet.limbs.map((L) => [L.id, L.joint])) } : REGION_ANCHOR;
  const sideIds = REGIONS.map((r) => r.id).concat(handsFeet ? handsFeet.limbs.map((L) => L.id) : []); // every id a piece can be bound as (the key of the bind caches)
  const sideIdx = (id) => sideIds.indexOf(id);
  // vertex space -> world: jointWorld x inverseBind is the same matrix Q for every joint (gltfpack bakes its position dequantisation into the
  // inverse binds, so the vertices of the quantised bodies are not in metres). Everything geometric below runs in world space.
  const ibm = skin0.getInverseBindMatrices();
  let Q = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (ibm) {
    const q = (i) => mul4(joints[i].getWorldMatrix(), ibm.getElement(i, new Array(16)));
    Q = q(roleJoint.Hips);
    for (const role of ["Head", "LeftToeBase", "RightHand"]) if (roleJoint[role] !== undefined) {
      const o = q(roleJoint[role]);
      for (let k = 0; k < 16; k++) if (Math.abs(o[k] - Q[k]) > 1e-4 * (1 + Math.abs(Q[k]))) throw new Error("joint world x inverse bind differs between joints: the skin is not at its bind pose");
    }
  }
  // The output is written in metres: vertices go to world and the inverse binds absorb Q^-1 (jointWorld x (IBM Q^-1) x (Q v) = jointWorld x IBM x v),
  // so the contract file is plain float32 in the units of the measure row, with no hidden dequantisation matrix.
  const F0 = vertexFrame(Q);
  const { A, Qinv } = F0;
  const normalToVertex = (n) => norm([A[0] * n[0] + A[3] * n[1] + A[6] * n[2], A[1] * n[0] + A[4] * n[1] + A[7] * n[2], A[2] * n[0] + A[5] * n[1] + A[8] * n[2]]); // A^T n
  // Each skin has its own Q when the exporter quantised each mesh on its own (Arachne: body, eyes, lashes, face and hair are five skins with five scales).
  // A skin whose Q equals the first skin's takes the first skin's frame object, so single-Q bodies keep their bytes.
  // Only a still-quantised source has this: a plain file (`decompressGlb` output, or one written by an older tool, whose later skins keep their old binds
  // beside vertices already in metres) keeps the first skin's frame for every mesh, as before. A later skin that is not at a consistent bind pose too.
  const frameOfSkin = new Map([[skin0, F0]]);
  const quantised = isQuantised(doc);
  for (const node of skinNodes) {
    const sk = node.getSkin();
    if (frameOfSkin.has(sk)) continue;
    const sib = sk.getInverseBindMatrices(), sjoints = sk.listJoints();
    let F = F0;
    if (quantised && sib) {
      const sq = (role) => { const at = sjoints.indexOf(joints[roleJoint[role]]); return at < 0 ? null : mul4(sjoints[at].getWorldMatrix(), sib.getElement(at, new Array(16))); };
      const Qs = sq("Hips");
      let ok = !!Qs;
      for (const role of ["Head", "LeftToeBase", "RightHand"]) {
        const o = roleJoint[role] !== undefined && Qs ? sq(role) : null;
        if (o && o.some((x, k) => Math.abs(x - Qs[k]) > 1e-4 * (1 + Math.abs(Qs[k])))) ok = false;
      }
      if (ok && Qs.some((x, k) => Math.abs(x - Q[k]) > 1e-4 * (1 + Math.abs(Q[k])))) F = vertexFrame(Qs);
    }
    frameOfSkin.set(sk, F);
  }
  // the measure row is floor-lifted (tools/glb-measure.mjs): recover its offset from the 20 role joints
  const roles = Object.keys(rigMap.joints).filter((r) => row.joints[r]);
  const offs = roles.map((r) => sub(rolePos[r], row.joints[r]));
  const med = (k) => offs.map((o) => o[k]).sort((a, b) => a - b)[Math.floor(offs.length / 2)];
  const offset = [med(0), med(1), med(2)];
  let resid = 0;
  for (const o of offs) resid = Math.max(resid, Math.abs(o[0] - offset[0]), Math.abs(o[1] - offset[1]), Math.abs(o[2] - offset[2]));
  if (resid > 2e-3) throw new Error(`measure row does not match the GLB skeleton (joint residual ${resid.toFixed(4)} m after the floor offset)`);
  const J = {};
  for (const r of Object.keys(row.joints)) J[r] = [row.joints[r][0] + offset[0], row.joints[r][1] + offset[1], row.joints[r][2] + offset[2]];

  const owner = joints.map((n) => { // region owning each joint: nearest ancestor-or-self that is an anchor
    for (let p = n; p; p = p.getParentNode()) for (const [role, region] of Object.entries(anchorRoles)) if (jIndex.get(p) === roleJoint[role]) return region;
    return "root";
  });
  // the same ownership with the hand and foot folded back into their arm and leg: what decides which of the seven plain regions holds a fragment (hands_feet
  // splits those pieces afterwards, so everything before the split sees the plain seven)
  const baseRegionOf = handsFeet ? Object.fromEntries(handsFeet.limbs.map((L) => [L.id, L.from])) : {};
  const baseOwner = handsFeet ? owner.map((o) => baseRegionOf[o] || o) : owner;
  const nodeNeighbours = (n) => [n.getParentNode(), ...n.listChildren()].filter(Boolean);
  const nearCache = new Map();
  const nearOwned = (j, region) => { // the nearest joint (tree distance) owned by `region`
    const key = j * 16 + sideIdx(region);
    if (nearCache.has(key)) return nearCache.get(key);
    let level = [joints[j]];
    const seen = new Set(level);
    let found = null;
    while (level.length && found === null) {
      const hits = level.map((n) => jIndex.get(n)).filter((k) => k !== undefined && owner[k] === region).sort((a, b) => a - b);
      if (hits.length) { found = hits[0]; break; }
      const next = [];
      for (const n of level) for (const m of nodeNeighbours(n)) if (!seen.has(m)) { seen.add(m); next.push(m); }
      level = next;
    }
    if (found === null) found = roleJoint[regionAnchor[region]];
    nearCache.set(key, found);
    return found;
  };

  // ---- source vertices and triangles (all skinned primitives of all skinned mesh nodes)
  const V = { pos: [], raw: [], frame: [], attr: {}, skin: [] }; // pos = world (metres, bind pose), raw = the vertex space the GLB stores
  const srcPrims = [], tris = [];
  // The attribute set of the output is the union over all skinned primitives (a body whose face mesh has a second UV set and whose skin does not,
  // like the Centurion's, is not refused): a primitive without a TEXCOORD gets zeros, without a COLOR white, and a missing NORMAL / TANGENT is refused (see missingFill). Sorted, so equal sets give equal bytes.
  const semSize = {};
  for (const node of skinNodes) for (const prim of node.getMesh().listPrimitives()) for (const s of prim.listSemantics()) {
    if (/^(POSITION|JOINTS_0|WEIGHTS_0)$/.test(s)) continue;
    const sz = prim.getAttribute(s).getElementSize();
    if (semSize[s] !== undefined && semSize[s] !== sz) throw new Error(`attribute ${s} has element size ${semSize[s]} on one primitive and ${sz} on another`);
    semSize[s] = sz;
  }
  // what a primitive without the attribute gets: TEXCOORD_n zeros (it samples the corner), COLOR_n ones (white, opaque: zeros would paint it transparent black);
  // anything else (NORMAL, TANGENT, custom) cannot be invented, so a primitive missing it is refused
  const missingFill = (s, size) => (/^TEXCOORD_\d+$/.test(s) ? new Array(size).fill(0) : /^COLOR_\d+$/.test(s) ? new Array(size).fill(1) : null);
  for (const s of Object.keys(semSize)) if (!missingFill(s, semSize[s])) for (const node of skinNodes) for (const prim of node.getMesh().listPrimitives()) {
    if (!prim.getAttribute(s)) throw new Error(`a skinned primitive has no ${s} while another has it; only TEXCOORD_n and COLOR_n are filled in, the cut will not invent ${s}`);
  }
  const semantics = Object.keys(semSize).sort();
  for (const s of semantics) V.attr[s] = [];
  const oldMeshes = new Set(), oldSkins = new Set(), oldNodes = [];
  for (const node of skinNodes) {
    const skin = node.getSkin();
    const jmap = skin.listJoints().map((jn) => { if (!jIndex.has(jn)) throw new Error("a second skin binds a joint that is not in the first skin: " + jn.getName()); return jIndex.get(jn); });
    if (skin !== skin0) oldSkins.add(skin);
    oldNodes.push(node);
    const mesh = node.getMesh();
    oldMeshes.add(mesh);
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) throw new Error("only triangle primitives are supported");
      if (prim.listTargets().length) throw new Error("morph targets are not supported");
      if (prim.getAttribute("JOINTS_1")) throw new Error("JOINTS_1 (more than four influences per vertex) is not supported");
      const pa = prim.getAttribute("POSITION"), ja = prim.getAttribute("JOINTS_0"), wa = prim.getAttribute("WEIGHTS_0");
      if (!ja || !wa) throw new Error("a primitive has no JOINTS_0 / WEIGHTS_0");
      const base = V.pos.length, n = pa.getCount(), frame = frameOfSkin.get(skin);
      for (let i = 0; i < n; i++) {
        const rawp = pa.getElement(i, [0, 0, 0]);
        V.raw.push(rawp); V.pos.push(frame.toWorld(rawp)); V.frame.push(frame);
        for (const s of semantics) { const at = prim.getAttribute(s); V.attr[s].push(at ? at.getElement(i, new Array(semSize[s]).fill(0)) : missingFill(s, semSize[s])); }
        const jj = ja.getElement(i, [0, 0, 0, 0]), ww = wa.getElement(i, [0, 0, 0, 0]);
        const sp = [];
        for (let k = 0; k < 4; k++) if (ww[k] > 0) sp.push([jmap[jj[k]], ww[k]]);
        V.skin.push(sp);
      }
      const idx = prim.getIndices();
      const cnt = idx ? idx.getCount() : n;
      const pi = srcPrims.length;
      srcPrims.push({ material: prim.getMaterial(), name: mesh.getName() });
      for (let t = 0; t + 2 < cnt; t += 3) {
        const a = idx ? idx.getScalar(t) : t, b = idx ? idx.getScalar(t + 1) : t + 1, c = idx ? idx.getScalar(t + 2) : t + 2;
        tris.push([base + a, base + b, base + c, pi]);
      }
    }
  }
  const verticesIn = V.pos.length;
  // The bodies carry hairline cracks along their UV seams (duplicate vertices a few 0.01 mm apart, from the exporter's quantisation). Snap vertices
  // closer than 0.15 mm onto one position so a cut loop through a crack still closes; the surface moves by under 0.15 mm.
  const pre = weldCluster(V.pos, 1.5e-4), firstOf = new Map();
  let snapped = 0;
  for (let v = 0; v < verticesIn; v++) {
    const c = pre[v];
    if (!firstOf.has(c)) { firstOf.set(c, v); continue; }
    const r = firstOf.get(c);
    if (opts.snapCracks === true && (V.pos[v][0] !== V.pos[r][0] || V.pos[v][1] !== V.pos[r][1] || V.pos[v][2] !== V.pos[r][2])) { V.pos[v] = V.pos[r].slice(); V.raw[v] = V.raw[r].slice(); snapped++; }
  }
  report.crack_vertices_snapped = snapped;
  let ymin = Infinity, ymax = -Infinity;
  for (const p of V.pos) { ymin = Math.min(ymin, p[1]); ymax = Math.max(ymax, p[1]); }
  // a vertex this close to a plane counts as on it (0.09 mm on a 1.7 m body): no sliver triangles, boundary edges stay classifiable.
  // opts.planeSnap (row override plane_snap_m, metres) replaces the height-scaled default: on a body taller than 2 m the default is above the validator's
  // 1e-4 m plane tolerance, so a vertex snapped "onto" the plane can sit just past the tolerance on the wrong side.
  if (opts.planeSnap !== undefined && !(typeof opts.planeSnap === "number" && opts.planeSnap > 0 && opts.planeSnap <= 1e-4)) throw new Error("plane_snap_m must be a number from 0 (exclusive) to 0.0001 metres (the validator's plane tolerance), got " + JSON.stringify(opts.planeSnap));
  const eps = opts.planeSnap !== undefined ? opts.planeSnap : 5e-5 * (ymax - ymin);

  // what the source mesh already has open (hair cards, eye sockets, slits), for the report
  const srcPos = new Float64Array(verticesIn * 3), srcIdx = new Uint32Array(tris.length * 3);
  for (let v = 0; v < verticesIn; v++) srcPos.set(V.pos[v], v * 3);
  tris.forEach((t, i) => srcIdx.set([t[0], t[1], t[2]], i * 3));
  const srcRep = weldReport([{ positions: srcPos, indices: srcIdx }], 1e-5);

  // the crotch apex: where the two legs' inner surfaces reach the midline
  let apex = null;
  if (opts.crotchPlanes !== false) {
    // scan down from the hip joint: the crotch is the first height where the left leg's innermost vertex (bones say which vertices are left-leg)
    // and the right leg's reach the midline
    const xm = (J.LeftUpLeg[0] + J.RightUpLeg[0]) / 2, halfGap = Math.abs(J.LeftUpLeg[0] - J.RightUpLeg[0]) / 2;
    const yTop = Math.max(J.LeftUpLeg[1], J.RightUpLeg[1]), thigh = vlen(sub(J.LeftUpLeg, J.LeftLeg));
    const legs = [];
    for (let v = 0; v < verticesIn; v++) {
      let l = 0, r = 0, all = 0;
      for (const [j, w] of V.skin[v]) { all += w; if (baseOwner[j] === "leg_left") l += w; else if (baseOwner[j] === "leg_right") r += w; }
      if (all > 0 && (l / all >= 0.5 || r / all >= 0.5)) legs.push({ p: V.pos[v], left: l >= r });
    }
    for (let y = yTop; y >= yTop - 0.6 * thigh && !apex; y -= 0.005) {
      let lMin = Infinity, rMax = -Infinity, zs = 0, zn = 0;
      for (const { p, left } of legs) {
        if (Math.abs(p[1] - y) > 0.01) continue;
        if (left) { if (p[0] < lMin) lMin = p[0]; } else if (p[0] > rMax) rMax = p[0];
      }
      if (lMin <= xm + 0.2 * halfGap && rMax >= xm - 0.2 * halfGap) {
        for (const { p } of legs) if (Math.abs(p[1] - y) <= 0.01 && Math.abs(p[0] - xm) <= 0.3 * halfGap) { zs += p[2]; zn++; }
        apex = [xm, y - 0.002, zn ? zs / zn : (J.LeftUpLeg[2] + J.RightUpLeg[2]) / 2];
      }
    }
    if (apex) report.crotch_apex = apex.map(r6);
    else report.notes.push("no crotch apex found: hip planes are the plain thigh-normal planes");
  }
  // shoulder_mode "tilt": measure how far each shoulder plane must turn about its arm joint to clear the vertices the other regions own below the shoulder
  // (the heaviest region of a vertex's skin weight owns it; the head's hair and the other arm are left out: the head is cut by the neck plane, the other arm is on the far side)
  let shoulderTilts = null;
  if (opts.planes && opts.planes.shoulder_mode === "tilt") {
    shoulderTilts = {};
    const dominant = new Array(verticesIn);
    for (let v = 0; v < verticesIn; v++) {
      const share = {};
      for (const [j, w] of V.skin[v]) share[baseOwner[j]] = (share[baseOwner[j]] || 0) + w;
      let best = "root", bw = -1;
      for (const k of Object.keys(share).sort()) if (share[k] > bw) { bw = share[k]; best = k; }
      dominant[v] = best;
    }
    report.shoulder_tilt = {};
    for (const [side, A, B] of [["left", J.LeftArm, J.LeftForeArm], ["right", J.RightArm, J.RightForeArm]]) {
      const n0 = norm(shoulderNormalOf(A, B)), below = [];
      for (let v = 0; v < verticesIn; v++) if (dominant[v] !== "arm_" + side && dominant[v] !== "head" && dominant[v] !== "arm_" + (side === "left" ? "right" : "left")) below.push(V.pos[v]);
      const { t, binding } = shoulderTiltFor(A, n0, below, SHOULDER_TILT_MARGIN, SHOULDER_TILT_SKIP_ARM_LEN * vlen(sub(B, A)));
      if (t > SHOULDER_TILT_MAX) throw new Error(`shoulder_mode tilt: the ${side} shoulder plane would have to turn ${r6(Math.atan(t) * 180 / Math.PI)} degrees (tilt ${r6(t)}) to clear a vertex at ${binding.map(r6)}; more than the ${SHOULDER_TILT_MAX} allowed, so this body needs its source fixed or another rule`);
      shoulderTilts[side] = t;
      report.shoulder_tilt[side] = { tilt: r6(t), degrees: r6(Math.atan(t) * 180 / Math.PI), binding_vertex: binding ? binding.map(r6) : null };
    }
  }
  const fns = buildPlanes(J, apex, opts.planes || PLANE_ROWS, shoulderTilts);
  // optional cuts (rows above): off unless asked for
  const headSplit = opts.headSplit ? rowOf(HEAD_SPLIT, opts.headSplit) : null, bellyOpen = opts.bellyOpen ? rowOf(BELLY_OPEN, opts.bellyOpen) : null;
  if (headSplit) fns.head_split = buildHeadSplitPlane(J, headSplit);
  if (handsFeet) Object.assign(fns, buildHandsFeetPlanes(J, handsFeet));
  // the regions and caps of this run: the plain seven and twelve, with piece_head replaced by its halves when head_split is on, and each limb piece followed
  // by its hand or foot when hands_feet is on (the limb piece gets the wrist or ankle plane among its own planes)
  let regions = headSplit ? REGIONS.flatMap((r) => (r.id === headSplit.replaces ? headSplit.regions : [r])) : REGIONS;
  if (handsFeet) regions = regions.flatMap((r) => { const ls = handsFeet.limbs.filter((L) => L.from === r.id); return ls.length ? [{ ...r, extra_planes: ls.map((L) => L.plane) }, ...ls.map((L) => ({ id: L.id, mesh: L.mesh, detached_by: L.id, extra_planes: [L.plane] }))] : [r]; });
  let capsAll = headSplit ? CAPS.filter((c) => c.region !== headSplit.replaces).concat(headSplit.caps) : CAPS;
  if (handsFeet) capsAll = capsAll.concat(handsFeet.caps);
  const boneRegion = (id) => (regions.find((r) => r.id === id) || {}).bones || id; // the region whose bones a piece may use
  const extraPlanes = new Set(["head_split"].concat(handsFeet ? handsFeet.limbs.map((L) => L.plane) : [])); // planes that only matter to the pieces they bound
  const planeOrder = ["neck", "shoulder_left", "shoulder_right", "hip_left", "hip_right", "waist", "hip_split"].concat(headSplit ? ["head_split"] : [], handsFeet ? handsFeet.limbs.map((L) => L.plane) : []);
  const regionPlanes = (R) => planeOrder.filter((id) => !extraPlanes.has(id) || R.extra_plane === id || (R.extra_planes || []).includes(id));

  // ---- split every triangle at the planes (decision tree of half-space clips); split vertices are shared through a cache
  const edgeCache = new Map();
  const dOf = (fn, v) => { const d = fn.d(V.pos[v]); return Math.abs(d) <= eps ? 0 : d; };
  const splitVertex = (a, b, fn) => {
    let lo = a, hi = b;
    // canonical order by position (ids break ties), so UV-seam duplicates of one edge produce bit-identical split points
    const eq = V.pos[a][0] === V.pos[b][0] && V.pos[a][1] === V.pos[b][1] && V.pos[a][2] === V.pos[b][2];
    if (eq ? b < a : posLess(V.pos[b], V.pos[a])) { lo = b; hi = a; }
    const key = lo + "_" + hi + "_" + fn.id;
    if (edgeCache.has(key)) return edgeCache.get(key);
    const dl = fn.d(V.pos[lo]), dh = fn.d(V.pos[hi]);
    const t = dl / (dl - dh);
    const id = V.pos.length;
    const p = lerp3(V.pos[lo], V.pos[hi], t);
    V.pos.push(p);
    V.raw.push(lerp3(V.raw[lo], V.raw[hi], t));
    V.frame.push(V.frame[lo]); // an edge lies inside one primitive, so both ends share a frame
    for (const s of semantics) {
      const A = V.attr[s][lo], B = V.attr[s][hi];
      let o = A.map((x, k) => x + (B[k] - x) * t);
      if (s === "NORMAL") o = norm(o);
      else if (s === "TANGENT") { const u = norm(o.slice(0, 3)); o = [u[0], u[1], u[2], A[3]]; }
      V.attr[s].push(o);
    }
    const m = new Map();
    for (const [j, w] of V.skin[lo]) m.set(j, (m.get(j) || 0) + w * (1 - t));
    for (const [j, w] of V.skin[hi]) m.set(j, (m.get(j) || 0) + w * t);
    V.skin.push([...m.entries()].sort((x, y) => x[0] - y[0]));
    edgeCache.set(key, id);
    return id;
  };
  const splitPoly = (poly, fn) => {
    const d = poly.map((v) => dOf(fn, v));
    const hasPos = d.some((x) => x > 0), hasNeg = d.some((x) => x < 0);
    if (!hasNeg) return hasPos ? [poly, null] : [null, poly]; // all zero: coplanar with the cut, goes to the negative side
    if (!hasPos) return [null, poly];
    const pos = [], neg = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], da = d[i], db = d[(i + 1) % poly.length];
      if (da >= 0) pos.push(a);
      if (da <= 0) neg.push(a);
      if ((da > 0 && db < 0) || (da < 0 && db > 0)) { const m = splitVertex(a, b, fn); pos.push(m); neg.push(m); }
    }
    return [pos.length >= 3 ? pos : null, neg.length >= 3 ? neg : null];
  };
  // the arrangement: every triangle is cut at every plane it crosses (the hip bisector only inside the double hip half-space), each fragment
  // carries the sign bits of its cell
  const BIT = { neck: 1, shoulder_left: 2, shoulder_right: 4, hip_left: 8, hip_right: 16, waist: 32, hip_split: 64 };
  const sequence = [fns.neck, fns.shoulder_left, fns.shoulder_right, fns.hip_left, fns.hip_right, fns.waist];
  const homeOf = (bits) => bits & 1 ? "head" : bits & 2 ? "arm_left" : bits & 4 ? "arm_right" : (bits & 24) === 24 ? (bits & 64 ? "leg_left" : "leg_right") : bits & 8 ? "leg_left" : bits & 16 ? "leg_right" : bits & 32 ? "upper_torso" : "root";
  const feasible = (r, b) => r === "head" ? !!(b & 1) : r === "upper_torso" ? !(b & 1) && !!(b & 32) && !(b & 2) && !(b & 4) : r === "root" ? !(b & 56) :
    r === "arm_left" ? !!(b & 2) : r === "arm_right" ? !!(b & 4) : r === "leg_left" ? !!(b & 8) && (!(b & 16) || !!(b & 64)) : !!(b & 16) && (!(b & 8) || !(b & 64));
  const cellTris = []; // [a, b, c, prim, cell bits]
  let trianglesSplit = 0;
  // Hair (Physics Dev ruling, docs/CUT-CONTRACT.md): hair-card and eyelash materials belong to the head, so a severed head carries its hair whole.
  // Those triangles are not cut at any plane and go to piece_head, re-bound rigidly to the Head bone (manifest `plane_exempt`).
  const isHairMaterial = (name) => (Array.isArray(opts.hairMaterials) ? opts.hairMaterials.includes(name) : /hair|lash|brow/i.test(name || ""));
  const hairPrim = srcPrims.map((p) => !!p.material && isHairMaterial(p.material.getName()));
  const hairTris = [], hairVerts = new Set();
  // Rigid accessory layers (row override rigid_accessory_materials, docs/CUT-TOOL.md): a layered or wide garment (skirt, sash, hem, jacket, trousers, pauldron)
  // whose material or mesh the row names is kept whole, like hair: its triangles are not cut at any plane, they go to ONE piece (the piece owning most of the
  // layer's skin weight, or the piece the row names) and are bound rigidly to ONE bone of that piece. The rest of the body shell is cut exactly as before.
  // Nothing is loosened for it in the validator: the layer is declared in the manifest's plane_exempt, the mechanism hair already uses.
  // An entry names a material or a mesh. With `shells_inside` (a box in the GLB's world metres) only the connected shells of the match whose bounding box lies
  // inside the box are accessories (a skirt that shares its material with the body); the rest of the match is cut as before.
  // plane_exempt names materials, so an accessory that shares its material with anything cut gets a copy of the material named "<name>.rigid": the
  // exemption then covers the accessory triangles and nothing else.
  const accSpecs = rigidAccessorySpecs(opts.rigidAccessoryMaterials);
  const accPrim = srcPrims.map(() => -1); // source primitive -> index into accSpecs
  const nSrcPrims = srcPrims.length, copies = new Map(); // material -> its ".rigid" copy
  for (const p of srcPrims) p.srcMaterial = p.material; // what the file said, whatever copy a primitive ends up with
  const rigidCopy = (mat) => {
    if (!copies.has(mat)) { const m = mat.clone(); m.setName(mat.getName() + ".rigid"); copies.set(mat, m); }
    return copies.get(mat);
  };
  const matchName = (spec, pi) => { const p = srcPrims[pi], mat = p.srcMaterial ? p.srcMaterial.getName() : null; return spec.name === mat || spec.name === p.name; };
  const accShells = []; // debug listing of the shells of every match
  accSpecs.forEach((spec, k) => {
    if (spec.shells_inside) return;
    let hit = 0;
    for (let pi = 0; pi < nSrcPrims; pi++) {
      if (!matchName(spec, pi)) continue;
      hit++;
      const p = srcPrims[pi];
      if (hairPrim[pi]) throw new Error(`rigid accessory ${JSON.stringify(spec.name)} is a hair material (hair_materials): it already goes whole to the head`);
      if (accPrim[pi] >= 0) throw new Error(`rigid accessory ${JSON.stringify(spec.name)} matches a primitive that ${JSON.stringify(accSpecs[accPrim[pi]].name)} already took`);
      if (!p.material) throw new Error(`rigid accessory ${JSON.stringify(spec.name)}: a primitive of mesh ${JSON.stringify(p.name)} has no material name, so plane_exempt cannot declare it`);
      if (srcPrims.some((q, qi) => qi !== pi && q.srcMaterial === p.srcMaterial && accSpecs.findIndex((s) => !s.shells_inside && matchName(s, qi)) !== k)) p.material = rigidCopy(p.material);
      accPrim[pi] = k;
    }
    if (!hit) throw new Error(`rigid accessory ${JSON.stringify(spec.name)} matches no material or mesh of the body`);
  });
  if (accSpecs.some((s) => s.shells_inside)) {
    const wc = weldCluster(V.pos, 1e-5), eps6 = 1e-6;
    accSpecs.forEach((spec, k) => {
      if (!spec.shells_inside) return;
      const [lo, hi] = spec.shells_inside;
      let hit = 0;
      for (let pi = 0; pi < nSrcPrims; pi++) {
        if (!matchName(spec, pi)) continue;
        hit++;
        const p = srcPrims[pi];
        if (hairPrim[pi]) throw new Error(`rigid accessory ${JSON.stringify(spec.name)} is a hair material (hair_materials): it already goes whole to the head`);
        if (accPrim[pi] >= 0) throw new Error(`rigid accessory ${JSON.stringify(spec.name)} matches a primitive that ${JSON.stringify(accSpecs[accPrim[pi]].name)} already took whole`);
        if (!p.material) throw new Error(`rigid accessory ${JSON.stringify(spec.name)}: a primitive of mesh ${JSON.stringify(p.name)} has no material name, so plane_exempt cannot declare it`);
        // the connected shells of this primitive (welded positions)
        const own = tris.filter((t) => t[3] === pi), par = new Map();
        const find = (x) => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x))); x = par.get(x); } return x; };
        for (const t of own) for (let i = 0; i < 3; i++) if (!par.has(wc[t[i]])) par.set(wc[t[i]], wc[t[i]]);
        for (const t of own) for (let i = 1; i < 3; i++) { const x = find(wc[t[0]]), y = find(wc[t[i]]); if (x !== y) par.set(Math.max(x, y), Math.min(x, y)); }
        const shells = new Map();
        for (const t of own) {
          const r = find(wc[t[0]]);
          if (!shells.has(r)) shells.set(r, { tris: [], lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] });
          const S = shells.get(r);
          S.tris.push(t);
          for (let i = 0; i < 3; i++) for (let a = 0; a < 3; a++) { S.lo[a] = Math.min(S.lo[a], V.pos[t[i]][a]); S.hi[a] = Math.max(S.hi[a], V.pos[t[i]][a]); }
        }
        const chosen = [...shells.values()].filter((S) => [0, 1, 2].every((a) => S.lo[a] >= lo[a] - eps6 && S.hi[a] <= hi[a] + eps6));
        if (opts.debug) for (const S of shells.values()) accShells.push({ entry: spec.name, material: p.material.getName(), triangles: S.tris.length, lo: S.lo.map(r6), hi: S.hi.map(r6), taken: chosen.includes(S) });
        if (!chosen.length) continue;
        const npi = srcPrims.length;
        srcPrims.push({ material: rigidCopy(p.material), name: p.name });
        accPrim.push(k);
        for (const S of chosen) for (const t of S.tris) t[3] = npi;
      }
      if (!hit) throw new Error(`rigid accessory ${JSON.stringify(spec.name)} matches no material or mesh of the body`);
      if (!accPrim.some((x, pi) => x === k && pi >= nSrcPrims)) throw new Error(`rigid accessory ${JSON.stringify(spec.name)}: no shell of the match lies inside shells_inside ${JSON.stringify(spec.shells_inside)}`);
    });
  }
  if (opts.debug && accShells.length) report.accessory_shells = accShells;
  const accTris = accSpecs.map(() => []), accVerts = accSpecs.map(() => new Set());
  for (const [a, b, c, pi] of tris) {
    if (accPrim[pi] >= 0) { const k = accPrim[pi]; accTris[k].push([a, b, c, pi]); accVerts[k].add(a); accVerts[k].add(b); accVerts[k].add(c); continue; }
    if (hairPrim[pi]) { hairTris.push([a, b, c, pi]); hairVerts.add(a); hairVerts.add(b); hairVerts.add(c); continue; }
    let polys = [{ v: [a, b, c], bits: 0 }];
    for (const fn of sequence) {
      const nx = [];
      for (const P of polys) { const [p, n] = splitPoly(P.v, fn); if (p) nx.push({ v: p, bits: P.bits | BIT[fn.id] }); if (n) nx.push({ v: n, bits: P.bits }); }
      polys = nx;
    }
    polys = polys.flatMap((P) => {
      if ((P.bits & 24) !== 24) return [P];
      const [p, n] = splitPoly(P.v, fns.hip_split), o = [];
      if (p) o.push({ v: p, bits: P.bits | 64 }); if (n) o.push({ v: n, bits: P.bits });
      return o;
    });
    if (polys.length > 1 || polys[0].v.some((v) => v >= verticesIn)) trianglesSplit++;
    for (const P of polys) for (let k = 1; k + 1 < P.v.length; k++) cellTris.push([P.v[0], P.v[k], P.v[k + 1], pi, P.bits]);
  }
  // where each rigid accessory goes: the row's piece, else the piece owning most of the layer's skin weight (ties: the first in region order); its one bone
  // is the heaviest joint of that piece in the layer (none: the piece's anchor joint)
  const accPlace = accSpecs.map((spec, k) => {
    const score = new Array(REGIONS.length).fill(0), jointW = new Map();
    for (const v of accVerts[k]) for (const [j, w] of V.skin[v]) { score[REGIONS.findIndex((r) => r.id === baseOwner[j])] += w; jointW.set(j, (jointW.get(j) || 0) + w); }
    let region = spec.piece;
    if (!region) { let best = 0; for (let i = 1; i < score.length; i++) if (score[i] > score[best]) best = i; region = REGIONS[best].id; }
    if (headSplit && region === "head") throw new Error(`rigid accessory ${JSON.stringify(spec.name)} would go to piece_head, which head_split replaces by its halves: name another piece`);
    let bone = -1;
    for (const [j, w] of [...jointW.entries()].sort((x, y) => x[0] - y[0])) if (owner[j] === region && (bone < 0 || w > jointW.get(bone))) bone = j;
    if (bone < 0) bone = roleJoint[regionAnchor[region]];
    return { region, bone };
  });
  const accVertBone = new Map();
  accSpecs.forEach((spec, k) => { for (const v of accVerts[k]) accVertBone.set(v, accPlace[k].bone); });
  const accFor = {};
  accSpecs.forEach((spec, k) => { (accFor[accPlace[k].region] ||= []).push(...accTris[k]); });
  if (opts.debug) {
    const seen = new Set();
    for (const t of cellTris) { seen.add(t[0]); seen.add(t[1]); seen.add(t[2]); }
    const lost = new Map();
    for (const t of tris) for (let k = 0; k < 3; k++) if (!seen.has(t[k]) && !hairVerts.has(t[k]) && !accVertBone.has(t[k])) lost.set(t[k], t[3]);
    report.lostAfterSplit = { count: lost.size, sample: [...lost.entries()].slice(0, 5).map(([v, p]) => [v, p, V.pos[v].map(r6)]) };
  }
  // fragments = connected pieces (welded positions) of one cell. A fragment goes to the region its cell names, unless its bones say otherwise:
  // when the home region owns under 20 percent of the fragment's skin weight, the region owning most of it takes the fragment (a foot sticking
  // through the shoulder plane's far side, hair hanging below the neck plane, a tail across the hip bisector). Gear follows its bone.
  // welded vertex ids (the pre-weld above made seam duplicates bit-identical)
  let wcl = weldCluster(V.pos, 1e-5);
  const weldId = (v) => wcl[v];
  const uf = new Map();
  const find = (x) => { let r = x; while (uf.get(r) !== r) r = uf.get(r); while (x !== r) { const nx = uf.get(x); uf.set(x, r); x = nx; } return r; };
  const unite = (x, y) => { const rx = find(x), ry = find(y); if (rx !== ry) uf.set(Math.max(rx, ry), Math.min(rx, ry)); };
  const keyOf = (t, v) => t[4] * 4194304 + weldId(v);
  for (const t of cellTris) { const ks = [t[0], t[1], t[2]].map((v) => keyOf(t, v)); for (const k of ks) if (!uf.has(k)) uf.set(k, k); unite(ks[0], ks[1]); unite(ks[0], ks[2]); }
  const fragVerts = new Map(); // fragment root -> Set of vertex ids
  const triFrag = cellTris.map((t) => find(keyOf(t, t[0])));
  cellTris.forEach((t, i) => { const f = triFrag[i]; if (!fragVerts.has(f)) fragVerts.set(f, new Set()); const s = fragVerts.get(f); s.add(t[0]); s.add(t[1]); s.add(t[2]); });
  const regionIdx = Object.fromEntries(REGIONS.map((r, i) => [r.id, i]));
  const fragRegion = new Map();
  const fragStats = { fragments: fragVerts.size, reassigned: 0, reassigned_triangles: 0 };
  const cellOfFrag = new Map();
  cellTris.forEach((t, i) => cellOfFrag.set(triFrag[i], t[4]));
  for (const [f, set] of [...fragVerts.entries()].sort((a, b) => a[0] - b[0])) {
    const home = homeOf(cellOfFrag.get(f));
    const score = new Array(REGIONS.length).fill(0);
    for (const v of set) for (const [j, w] of V.skin[v]) score[regionIdx[baseOwner[j]]] += w;
    const total = score.reduce((s, x) => s + x, 0);
    let region = home;
    if (total > 0 && score[regionIdx[home]] / total < (opts.homeMinWeight ?? 0.2)) {
      // only a region the cell's planes allow can take it (a piece's vertices stay on its side of every plane that bounds it)
      let best = -1;
      for (let k = 0; k < score.length; k++) if (feasible(REGIONS[k].id, cellOfFrag.get(f)) && score[k] > 0 && (best < 0 || score[k] > score[best])) best = k;
      if (best >= 0) region = REGIONS[best].id;
    }
    if (region !== home) {
      fragStats.reassigned++;
      if (opts.debug) {
        const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
        for (const v of set) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], V.pos[v][k]); hi[k] = Math.max(hi[k], V.pos[v][k]); }
        (report.reassigned ||= []).push({ home, region, vertices: set.size, bbox: [lo.map(r6), hi.map(r6)], shares: Object.fromEntries(REGIONS.map((r, k) => [r.id, r6(score[k] / total)])) });
      }
    }
    fragRegion.set(f, region);
  }
  const pieceTris = Object.fromEntries(REGIONS.map((r) => [r.id, []]));
  cellTris.forEach((t, i) => {
    const region = fragRegion.get(triFrag[i]);
    if (region !== homeOf(t[4])) fragStats.reassigned_triangles++;
    pieceTris[region].push([t[0], t[1], t[2], t[3]]);
  });

  // ---- head_split (opt-in): piece_head is cut again at the sagittal plane into two halves. The head's triangles are split exactly as at the other
  // planes (shared split vertices, all attributes and weights interpolated). Hair is not cut (Physics Dev ruling): each connected card goes whole to
  // the half its area lies mostly in. The halves replace piece_head; they are bound to the same bones (the Head side).
  const hairFor = { head: hairTris };
  let splitInfo = null;
  if (headSplit) {
    const fn = fns.head_split, halves = Object.fromEntries(headSplit.regions.map((r) => [r.id, []]));
    const idOfSide = (s) => headSplit.regions.find((r) => r.side === s).id;
    let headIn = 0;
    for (const [a, b, c, pi] of pieceTris.head) {
      headIn++;
      const [pos, neg] = splitPoly([a, b, c], fn);
      for (const [poly, id] of [[pos, idOfSide(1)], [neg, idOfSide(-1)]]) if (poly) for (let k = 1; k + 1 < poly.length; k++) halves[id].push([poly[0], poly[k], poly[k + 1], pi]);
    }
    delete pieceTris.head;
    Object.assign(pieceTris, halves);
    wcl = weldCluster(V.pos, 1e-5); // the split vertices are new
    const hp = new Map(); // hair cards: union-find over welded vertices
    const hf = (x) => { while (hp.get(x) !== x) { hp.set(x, hp.get(hp.get(x))); x = hp.get(x); } return x; };
    for (const [a, b, c] of hairTris) { for (const v of [a, b, c]) if (!hp.has(weldId(v))) hp.set(weldId(v), weldId(v)); const ra = hf(weldId(a)); for (const v of [b, c]) { const rv = hf(weldId(v)); if (rv !== ra) hp.set(Math.max(ra, rv), Math.min(ra, rv)); } }
    const score = new Map();
    for (const [a, b, c] of hairTris) { const ar = 0.5 * vlen(cross(sub(V.pos[b], V.pos[a]), sub(V.pos[c], V.pos[a]))), cen = [0, 1, 2].map((k) => (V.pos[a][k] + V.pos[b][k] + V.pos[c][k]) / 3); const r = hf(weldId(a)); score.set(r, (score.get(r) || 0) + ar * Math.sign(fn.d(cen))); }
    for (const id of Object.keys(halves)) hairFor[id] = [];
    for (const t of hairTris) hairFor[idOfSide((score.get(hf(weldId(t[0]))) || 0) > 0 ? 1 : -1)].push(t);
    delete hairFor.head;
    splitInfo = { head_triangles_in: headIn, left_triangles: halves[idOfSide(1)].length, right_triangles: halves[idOfSide(-1)].length, hair_triangles: Object.fromEntries(Object.keys(halves).map((id) => [id, hairFor[id].length])) };
  }

  // ---- hands_feet (opt-in): the arm and leg pieces are cut once more, at the wrist and ankle planes, with the same machinery as the other planes (shared split
  // vertices, every attribute and skin weight interpolated). The + side of the plane (hand, foot) becomes its own piece, the - side stays in the limb piece.
  let handsInfo = null;
  const accCaps = []; // accessory_feet: the extra caps (the accessory's piece at an ankle plane)
  const accFootVerts = {}, accFootBone = {}; // accessory_feet: foot region -> the accessory vertices it holds, and the Foot bone they are bound to
  if (handsFeet) {
    handsInfo = {};
    for (const L of handsFeet.limbs) {
      const fn = fns[L.plane], beyond = [], kept = [];
      let before = 0;
      for (const [a, b, c, pi] of pieceTris[L.from]) {
        before++;
        const [pos, neg] = splitPoly([a, b, c], fn);
        for (const [poly, dst] of [[pos, beyond], [neg, kept]]) if (poly) for (let k = 1; k + 1 < poly.length; k++) dst.push([poly[0], poly[k], poly[k + 1], pi]);
      }
      pieceTris[L.from] = kept;
      pieceTris[L.id] = beyond;
      handsInfo[L.id] = { cut_from: L.from, plane: L.plane, triangles_in: before, triangles_kept: kept.length, triangles_beyond: beyond.length };
    }
    // accessory_feet (row field, default off): a rigid accessory that reaches past an ankle plane (shoes sewn into the trouser layer, one shell) is cut at that
    // plane like the body: each of its triangles is split at the ankle plane of the foot nearest to it, the part beyond goes to piece_foot_* (bound rigidly to the
    // Foot bone), the part before stays in the piece that holds the accessory (bound to the accessory's own bone). The seam loops then go through the normal cap
    // code: the foot gets one more loop on cap_ankle_*_foot, the accessory's piece gets a cap of its own on the same plane (cap_ankle_*_<piece>).
    if (handsFeet.accessory_feet) {
      const feet = handsFeet.limbs.filter((L) => L.with_accessories);
      for (const L of feet) { accFootVerts[L.id] = new Set(); accFootBone[L.id] = roleJoint[L.joint]; }
      accSpecs.forEach((spec, k) => {
        const from = accPlace[k].region, mine = new Set(accTris[k]), gone = new Set();
        for (const t of accFor[from] ? accFor[from].filter((x) => mine.has(x)) : []) {
          const cen = [0, 1, 2].map((a) => (V.pos[t[0]][a] + V.pos[t[1]][a] + V.pos[t[2]][a]) / 3);
          let best = null, bd = Infinity;
          for (const L of feet) { const j = bindPos[roleJoint[L.joint]], d = Math.hypot(cen[0] - j[0], cen[1] - j[1], cen[2] - j[2]); if (d < bd) { bd = d; best = L; } }
          if (!best) continue;
          const [pos, neg] = splitPoly([t[0], t[1], t[2]], fns[best.plane]);
          if (!pos) continue; // wholly before the plane: stays in the accessory, uncut
          gone.add(t);
          for (const [poly, dst, foot] of [[pos, pieceTris[best.id], true], [neg, pieceTris[from], false]]) if (poly) for (let q = 1; q + 1 < poly.length; q++) {
            const tri = [poly[0], poly[q], poly[q + 1], t[3]];
            dst.push(tri);
            for (let i = 0; i < 3; i++) { if (foot) accFootVerts[best.id].add(tri[i]); else accVertBone.set(tri[i], accPlace[k].bone); }
          }
          for (const v of [t[0], t[1], t[2]]) if (!accVertBone.has(v)) accVertBone.set(v, accPlace[k].bone);
          handsInfo[best.id].accessory_triangles = (handsInfo[best.id].accessory_triangles || 0) + 1;
          if (neg) { const R0 = regions.find((r) => r.id === from); R0.extra_planes = [...new Set([...(R0.extra_planes || []), best.plane])]; } // the accessory's piece now has this plane among its own
          for (const region of neg ? [from, best.id] : [best.id]) {
            const cid = `cap_${best.plane}_${region}`;
            if (!capsAll.some((c) => c.id === cid)) { const cap = { id: cid, region, plane: best.plane, shown_when_cut: best.id }; capsAll.push(cap); accCaps.push(cap); }
          }
        }
        if (accFor[from]) accFor[from] = accFor[from].filter((x) => !gone.has(x));
      });
    }
    wcl = weldCluster(V.pos, 1e-5); // the split vertices are new
  }

  // ---- bind weights to the bones of the piece's own side
  let weightsRebound = 0, weightsTruncated = 0, orphan = 0;
  const bindCache = new Map();
  const bindWeights = (v, region) => {
    // hair travels with the head as one rigid piece: Head bone only (renormalised weights of a single bone)
    const side = boneRegion(region); // a head half uses the bones of the head
    if (accFootVerts[region] && accFootVerts[region].has(v)) return { j: [accFootBone[region], 0, 0, 0], w: [1, 0, 0, 0] }; // accessory_feet: a shoe is bound to the Foot bone
    if (accVertBone.has(v)) return { j: [accVertBone.get(v), 0, 0, 0], w: [1, 0, 0, 0] }; // a rigid accessory: its one bone
    if (side === "head" && hairVerts.has(v)) return { j: [roleJoint.Head, 0, 0, 0], w: [1, 0, 0, 0] };
    const key = v * 16 + sideIdx(side);
    if (bindCache.has(key)) return bindCache.get(key);
    const acc = new Map();
    for (const [j, w] of V.skin[v]) {
      if (!(w > 0)) continue;
      let t = j;
      if (owner[j] !== side) {
        t = nearOwned(j, side); weightsRebound++;
        if (opts.debug) { const k = `${region}: ${joints[j].getName().replace("mixamorig:", "")} -> ${joints[t].getName().replace("mixamorig:", "")}`; (report.rebinds ||= {})[k] = (report.rebinds[k] || 0) + 1; }
      }
      acc.set(t, (acc.get(t) || 0) + w);
    }
    let list = [...acc.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    if (list.length > 4) { weightsTruncated++; list = list.slice(0, 4); }
    if (!list.length) list = [[roleJoint[regionAnchor[side]], 1]];
    const sum = list.reduce((s, e) => s + e[1], 0);
    const jj = [0, 0, 0, 0], ww = [0, 0, 0, 0];
    list.forEach((e, k) => { jj[k] = e[0]; ww[k] = e[1] / sum; });
    for (let k = 0; k < 4; k++) if (ww[k] > 0 && owner[jj[k]] !== side) orphan++;
    const r = { j: jj, w: ww };
    bindCache.set(key, r);
    return r;
  };

  // ---- emit each piece: one primitive per source material
  const outPieces = {}; // region -> { prims: [{ pi, gv: [vertex ids], indices }], positionsAll }
  for (const R of regions) {
    const byPrim = new Map();
    const whole = hairFor[R.id] ? pieceTris[R.id].concat(hairFor[R.id]) : pieceTris[R.id]; // hair and rigid accessories are added uncut
    for (const [a, b, c, pi] of accFor[R.id] ? whole.concat(accFor[R.id]) : whole) {
      if (!byPrim.has(pi)) byPrim.set(pi, { pi, gv: [], map: new Map(), indices: [] });
      const P = byPrim.get(pi);
      for (const v of [a, b, c]) {
        if (!P.map.has(v)) { P.map.set(v, P.gv.length); P.gv.push(v); }
        P.indices.push(P.map.get(v));
      }
    }
    outPieces[R.id] = { prims: [...byPrim.values()].sort((x, y) => x.pi - y.pi) };
    if (!outPieces[R.id].prims.length) throw new Error("region " + R.id + " received no triangles: the cut planes do not fit this body");
  }

  // ---- caps: boundary edges of each piece that lie on a cut plane, chained into loops, triangulated (outer rings + holes)
  const capStats = { loops: 0, open_chains: 0, holes: 0, forced_ears: 0, bridge_fallbacks: 0, fallback_loops: 0, inward_triangles: 0, nonplanar_loops: 0, gaps_bridged: 0 };
  const capOf = new Map(capsAll.filter((c) => !accCaps.includes(c)).map((c) => [c.region + ":" + c.plane, c]));
  const capsOut = {}; // cap id -> { verts: [{v, region}], uv, tris }
  for (const R of regions) {
    const edges = new Map(); // directed welded edge -> { count, a, b }
    const W = weldId;
    const rep = new Map(); // welded id -> lowest vertex id
    const accEdge = new Set(); // accessory_feet: directed welded edges of rigid accessory triangles (their loops get caps of their own)
    for (const [a, b, c, pi] of pieceTris[R.id]) for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const wu = W(u), wv = W(v);
      if (accCaps.length && accPrim[pi] >= 0) accEdge.add(wu * 4194304 + wv);
      if (!rep.has(wu) || rep.get(wu) > u) rep.set(wu, u);
      if (!rep.has(wv) || rep.get(wv) > v) rep.set(wv, v);
      if (wu === wv) continue;
      const k = wu * 4194304 + wv;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
    const boundary = [];
    for (const [k, cnt] of edges) {
      const u = Math.floor(k / 4194304), v = k % 4194304;
      const rev = edges.get(v * 4194304 + u) || 0;
      if (cnt > rev) boundary.push([u, v]);
    }
    // centroid for the outward direction
    const used = new Set();
    for (const [a, b, c, pi] of pieceTris[R.id]) { if (accPrim[pi] >= 0) continue; used.add(a); used.add(b); used.add(c); } // a rigid accessory's seam part (accessory_feet) is not the piece's body: the validator's centroid leaves it out too
    const cen = [0, 0, 0];
    for (const v of used) for (let k = 0; k < 3; k++) cen[k] += V.pos[v][k] / used.size;
    // classify the boundary edges that lie on a cut plane; the others are native open edges of the source mesh (reported, not capped)
    const planeOf = new Map(); // directed welded edge -> plane id
    const planesOn = new Map(); // directed welded edge -> every cap plane of this region the edge lies on
    const midline = !!fns.hip_split.midline; // parallel thighs: the midline is a wall plane of its own (below), not part of the hip cap's plane
    const hipCapOf = (pl) => (pl === "hip_split" ? (R.id === "leg_left" ? "hip_left" : R.id === "leg_right" ? "hip_right" : pl) : pl);
    const capPlane = (pl) => (midline ? pl : hipCapOf(pl));
    const out = new Map();
    const edgeList = [];
    for (const [u, v] of boundary) {
      const pu = V.pos[rep.get(u)], pv = V.pos[rep.get(v)];
      const on = regionPlanes(R).filter((id) => Math.abs(fns[id].d(pu)) <= 2 * eps && Math.abs(fns[id].d(pv)) <= 2 * eps);
      if (!on.length) continue;
      // an edge on the meeting line of two planes goes to the plane this region has a cap for
      const plane = on.find((id) => capOf.has(R.id + ":" + id)) || on.find((id) => id === "hip_split") || on[0];
      planeOf.set(u * 4194304 + v, plane);
      const capped = [...new Set(on.map(capPlane))].filter((p) => capOf.has(R.id + ":" + p));
      planesOn.set(u * 4194304 + v, capped.length ? capped : [capPlane(plane)]);
      edgeList.push([u, v]);
      if (!out.has(u)) out.set(u, []);
      out.get(u).push(v);
    }
    // A hairline hole in the source mesh that the plane crosses leaves a dead end and a start a fraction of a millimetre apart: bridge such gaps
    // (under 1 mm) with a straight edge so the loop closes. The hole itself stays open and is counted as a native open edge.
    {
      const bal = new Map(), inPlane = new Map();
      for (const [u, v] of edgeList) { bal.set(u, (bal.get(u) || 0) + 1); bal.set(v, (bal.get(v) || 0) - 1); inPlane.set(v, planeOf.get(u * 4194304 + v)); }
      const sinks = [...bal.entries()].filter(([, b]) => b < 0).map(([w]) => w).sort((a, b) => a - b);
      const sources = [...bal.entries()].filter(([, b]) => b > 0).map(([w]) => w).sort((a, b) => a - b);
      for (const s of sinks) {
        let best = -1, bd = 1e-3;
        for (const t of sources) { if (bal.get(t) <= 0) continue; const d = vlen(sub(V.pos[rep.get(s)], V.pos[rep.get(t)])); if (d < bd) { bd = d; best = t; } }
        if (best < 0) continue;
        planeOf.set(s * 4194304 + best, inPlane.get(s));
        edgeList.push([s, best]);
        if (!out.has(s)) out.set(s, []);
        out.get(s).push(best);
        bal.set(s, bal.get(s) + 1); bal.set(best, bal.get(best) - 1);
        capStats.gaps_bridged++;
      }
    }
    // chain all of them into loops
    const loops = [];
    for (const [u0, v0] of edgeList) {
      const list = out.get(u0);
      const ix = list.indexOf(v0);
      if (ix < 0) continue; // used already
      list.splice(ix, 1);
      const loop = [u0];
      let cur = v0, closed = false;
      for (let guard = 0; guard < 1e7; guard++) {
        if (cur === u0) { closed = true; break; }
        loop.push(cur);
        const nxt = out.get(cur);
        if (!nxt || !nxt.length) break;
        cur = nxt.shift();
      }
      if (closed && loop.length >= 3) loops.push(loop); else capStats.open_chains++;
    }
    const describe = (loop, closed) => {
      const len = {};
      const n = loop.length;
      for (let k = 0; k < (closed ? n : n - 1); k++) {
        const u = loop[k], v = loop[(k + 1) % n];
        const pl = capPlane(planeOf.get(u * 4194304 + v));
        len[pl] = (len[pl] || 0) + vlen(sub(V.pos[rep.get(u)], V.pos[rep.get(v)]));
      }
      const dom = Object.entries(len).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
      return { loop, len, dom };
    };
    // A loop that runs along two cap planes (the root's lower edge where the two hip planes meet) is cut at the two points where it changes plane
    // and each half is closed by the straight chord, so every cap is flat: a Lambda triangulated as one polygon would fold.
    const loopInfo = loops.flatMap((loop) => {
      const n = loop.length;
      const on = loop.map((u, k) => planesOn.get(u * 4194304 + loop[(k + 1) % n]) || [capPlane(planeOf.get(u * 4194304 + loop[(k + 1) % n]))]);
      // edges on the meeting line of two planes keep the plane of the edge before them; start from an edge on one plane only
      let st = on.findIndex((l) => l.length === 1);
      if (st < 0) return [describe(loop, true)];
      const seq = new Array(n);
      let cur = on[st][0];
      for (let j = 0; j < n; j++) { const k = (st + j) % n; if (!on[k].includes(cur)) cur = on[k][0]; seq[k] = cur; }
      const s = seq.findIndex((p, k) => p !== seq[(k + n - 1) % n]);
      if (s < 0) return [describe(loop, true)];
      const rot = loop.slice(s).concat(loop.slice(0, s)), rseq = seq.slice(s).concat(seq.slice(0, s));
      const runs = [];
      rseq.forEach((p, k) => { if (!runs.length || runs[runs.length - 1].plane !== p) runs.push({ plane: p, from: k, to: k }); else runs[runs.length - 1].to = k; });
      if (opts.debug) (report.runs ||= []).push({ region: R.id, n, runs: runs.map((r) => `${r.plane}:${r.to - r.from + 1}`) });
      const runPlanes = [...new Set(runs.map((r) => r.plane))];
      if (runs.length >= 2 && runs.length % 2 === 0 && runPlanes.length >= 2 && runPlanes.every((p) => capOf.has(R.id + ":" + p) || (midline && p === "hip_split"))) {
        // Each run is an open polyline of one plane whose two ends lie on the meeting line of the two planes. Per plane the ends are sorted along that line
        // and paired two by two (even-odd, as for any section of a solid by a plane): each pair is closed by the chord along the line, and the polylines
        // chained through those chords are the cap polygons. Two runs (the root's hip Lambda) give one polygon per run; a loop that leaves and re-enters
        // the plane several times (a hollow tube cut by both the neck plane and the sagittal plane) gives the half rings and the separate wall strips.
        // With more than two planes (a collar island cut by the neck plane and both shoulder planes) an end of a run meets the run of ONE other plane, on
        // the meeting line of that pair: the ends of a plane are grouped by the plane they meet, and each group is sorted and paired along its own line.
        const subs = runs.map((r) => { const sub = []; for (let k = r.from; k <= r.to + 1; k++) sub.push(rot[k % n]); return sub; });
        const partner = new Map(); // "run:start|end" -> "run:start|end"
        for (const pl of runPlanes) {
          const groups = new Map(); // the plane met -> its ends
          runs.forEach((r, i) => {
            if (r.plane !== pl) return;
            for (const [which, nb] of [["start", runs[(i + runs.length - 1) % runs.length]], ["end", runs[(i + 1) % runs.length]]]) {
              if (!groups.has(nb.plane)) groups.set(nb.plane, []);
              groups.get(nb.plane).push({ key: i + ":" + which, v: V.pos[rep.get(which === "start" ? subs[i][0] : subs[i][subs[i].length - 1])] });
            }
          });
          for (const [q, ends] of groups) {
            const L = runPlanes.indexOf(pl) < runPlanes.indexOf(q) ? cross(fns[pl].n, fns[q].n) : cross(fns[q].n, fns[pl].n);
            for (const e of ends) e.t = dot(e.v, L);
            ends.sort((a, b) => a.t - b.t || (a.key < b.key ? -1 : 1));
            for (let k = 0; k + 1 < ends.length; k += 2) { partner.set(ends[k].key, ends[k + 1].key); partner.set(ends[k + 1].key, ends[k].key); }
          }
        }
        const used = new Set(), polys = [];
        let consistent = true;
        runs.forEach((r0, i0) => {
          if (used.has(i0) || !consistent) return;
          const nodes = [], len = {};
          let i = i0;
          for (let guard = 0; guard <= runs.length; guard++) {
            used.add(i);
            const d = describe(subs[i], false);
            nodes.push(...subs[i]);
            for (const [p, l] of Object.entries(d.len)) len[p] = (len[p] || 0) + l;
            const next = partner.get(i + ":end");
            if (!next || !next.endsWith(":start")) { consistent = false; return; } // an end paired with an end: not a section of a solid, keep the one-polygon fallback
            i = Number(next.split(":")[0]);
            if (i === i0) break;
            if (used.has(i)) { consistent = false; return; }
          }
          polys.push({ loop: nodes, len, dom: r0.plane });
        });
        if (consistent && polys.length) return polys;
      }
      return [describe(loop, true)];
    });
    if (opts.debug) {
      const deg = new Map();
      for (const [u, v] of edgeList) { deg.set(u, (deg.get(u) || 0) + 1); deg.set(v, (deg.get(v) || 0) - 1); }
      const bad = [...deg.entries()].filter(([, d]) => d !== 0).map(([w, d]) => [d, V.pos[rep.get(w)].map(r6)]);
      const near = [];
      for (const [u, v] of boundary) {
        if (planeOf.has(u * 4194304 + v)) continue;
        const pu = V.pos[rep.get(u)], pv = V.pos[rep.get(v)];
        if (bad.some(([, p]) => vlen(sub(pu, p)) < 5e-4 || vlen(sub(pv, p)) < 5e-4)) near.push([pu.map(r6), pv.map(r6), planeOrder.map((id) => +fns[id].d(pu).toExponential(2)), planeOrder.map((id) => +fns[id].d(pv).toExponential(2))]);
      }
      (report.groups ||= []).push({ near, region: R.id, edges: edgeList.length, loops: loops.length, loops_by_plane: loopInfo.map((l) => l.dom + ":" + l.loop.length), unbalanced: bad.length, unbalancedSample: bad.slice(0, 4) });
    }
    const byDom = new Map();
    for (const li of loopInfo) { const key = li.dom + (accEdge.has(li.loop[0] * 4194304 + li.loop[1]) && accCaps.some((c) => c.region === R.id && c.plane === li.dom) ? "|acc" : ""); if (!byDom.has(key)) byDom.set(key, []); byDom.get(key).push(li); }
    for (const [domKey, infos] of byDom) {
      const isAcc = domKey.endsWith("|acc"), dom = isAcc ? domKey.slice(0, -4) : domKey;
      const fn = fns[dom];
      const nOut = dot(sub(cen, fn.point), fn.n) > 0 ? fn.n.map((x) => -x) : fn.n.slice();
      const u = norm(Math.abs(nOut[2]) < 0.9 ? cross(nOut, [0, 0, 1]) : cross(nOut, [1, 0, 0]));
      const vv = cross(nOut, u);
      const all = [];
      const rings = infos.map(({ loop }) => {
        const pts = loop.map((w) => { const p = V.pos[rep.get(w)]; return { x: dot(p, u), y: dot(p, vv), i: all.push(rep.get(w)) - 1 }; });
        let a = 0;
        for (let k = 0; k < pts.length; k++) { const p = pts[k], q = pts[(k + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
        let dev = 0; // how far the loop strays from the plane it is capped against
        for (const w of loop) dev = Math.max(dev, Math.abs(fn.d(V.pos[rep.get(w)])));
        if (dev > 10 * eps) capStats.nonplanar_loops++;
        return { pts, area: a / 2 };
      });
      // traversal of an outer ring is clockwise seen from the outside (area < 0); holes are counter-clockwise (area > 0)
      const outers = rings.filter((r) => r.area <= 0), holes = rings.filter((r) => r.area > 0);
      const owners = outers.map(() => []);
      const inPoly = (pt, poly) => { let c = false; for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) { const p = poly[a], q = poly[b]; if ((p.y > pt.y) !== (q.y > pt.y) && pt.x < (q.x - p.x) * (pt.y - p.y) / (q.y - p.y) + p.x) c = !c; } return c; };
      const orphanHoles = [];
      for (const h of holes) {
        let best = -1;
        outers.forEach((o, k) => { if (inPoly(h.pts[0], o.pts) && (best < 0 || Math.abs(o.area) < Math.abs(outers[best].area))) best = k; });
        if (best < 0) orphanHoles.push(h); else owners[best].push(h);
      }
      capStats.loops += infos.length;
      capStats.holes += holes.length - orphanHoles.length;
      const stats = { forced: 0, bridgeFallback: 0 };
      const capTris = [];
      outers.forEach((o, k) => capTris.push(...triangulateLoops(o.pts, owners[k].map((h) => h.pts), stats)));
      for (const h of orphanHoles) { // a hole with no ring around it: fill it as an outer ring of its own (flagged)
        capStats.fallback_loops++;
        capTris.push(...triangulateLoops(h.pts, [], stats));
      }
      capStats.forced_ears += stats.forced; capStats.bridge_fallbacks += stats.bridgeFallback;
      if (opts.debug && (stats.forced || stats.bridgeFallback)) (report.forced ||= []).push({ region: R.id, plane: dom, forced: stats.forced, rings: rings.map((r) => [r.pts.length, +r.area.toFixed(6)]), holes: holes.length, orphanHoles: orphanHoles.length });
      // the caps this group may feed: planes it lies on that this region has a cap for (a loop along two planes, the Lambda of the root's lower edge,
      // is triangulated once and shared out by the nearest plane)
      const planesHere = [...new Set(infos.flatMap((i) => Object.keys(i.len)).map((p) => (p === "hip_split" ? (midline ? hipCapOf(p) : dom) : p)))].filter((p) => capOf.has(R.id + ":" + p)).sort((a, b) => planeOrder.indexOf(a) - planeOrder.indexOf(b));
      let targets = isAcc ? [accCaps.find((c) => c.region === R.id && c.plane === dom)] : planesHere.map((p) => capOf.get(R.id + ":" + p));
      // parallel thighs: the root's lower face is one plane, shared out between its two hip caps by the side of the midline
      const sideCaps = midline && capOf.has(R.id + ":hip_left") && capOf.has(R.id + ":hip_right") && (dom === "hip_left" || dom === "hip_right") ? [capOf.get(R.id + ":hip_left"), capOf.get(R.id + ":hip_right")] : null;
      if (sideCaps) targets = sideCaps;
      if (!targets.length) { targets = [capsAll.find((c) => c.region === R.id)]; capStats.fallback_loops++; }
      let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
      for (const v of all) { umin = Math.min(umin, dot(V.pos[v], u)); umax = Math.max(umax, dot(V.pos[v], u)); vmin = Math.min(vmin, dot(V.pos[v], vv)); vmax = Math.max(vmax, dot(V.pos[v], vv)); }
      const S = Math.max(umax - umin, vmax - vmin) || 1;
      const locals = new Map();
      for (let t = 0; t < capTris.length; t += 3) {
        const ia = capTris[t], ib = capTris[t + 1], ic = capTris[t + 2];
        const a = V.pos[all[ia]], b = V.pos[all[ib]], c = V.pos[all[ic]];
        // Ear clipping winds every triangle of a simple loop to the outward normal. A loop that crosses itself (the plane cuts a folded or overlapping
        // layer of the source mesh) has regions of negative winding that no consistent triangulation can cover with outward triangles: those triangles
        // (folded slivers) are kept, so the cap stays closed and oriented with its piece, but each gets its own vertices carrying the normal of its
        // winding, so that every triangle's winding agrees with its stored normals (CUT-VALIDATE `caps`).
        const folded = dot(cross(sub(b, a), sub(c, a)), nOut) < -1e-14;
        if (folded) capStats.inward_triangles++;
        let cap = targets[0];
        if (targets.length > 1) {
          const cen3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
          let bd = Infinity;
          if (sideCaps) { cap = sideCaps[fns.hip_split.d(cen3) >= 0 ? 0 : 1]; bd = -Infinity; }
          for (const tc of targets) { const d = Math.abs(fns[tc.plane].d(cen3)); if (d < bd - 1e-12) { bd = d; cap = tc; } }
        }
        const rec = capsOut[cap.id] || (capsOut[cap.id] = { cap, verts: [], uv: [], nrm: [], tris: [] });
        if (!locals.has(cap.id)) locals.set(cap.id, new Map());
        const lm = locals.get(cap.id);
        for (const gi of [ia, ib, ic]) {
          const v = all[gi], uv = [(dot(V.pos[v], u) - umin) / S, (dot(V.pos[v], vv) - vmin) / S];
          if (folded) { rec.tris.push(rec.verts.length); rec.verts.push(v); rec.uv.push(uv); rec.nrm.push(nOut.map((x) => -x)); continue; }
          if (!lm.has(gi)) { lm.set(gi, rec.verts.length); rec.verts.push(v); rec.uv.push(uv); rec.nrm.push(nOut); }
          rec.tris.push(lm.get(gi));
        }
      }
    }
  }

  // ---- belly_open (opt-in): an elliptical wound patch on the front of piece_upper_torso, above the waist plane. Nothing is removed from the torso
  // and nothing detaches. The ellipse (rows above) lives in the plane belly_open (point = its centre, normal = the body's forward axis). Each patch
  // vertex is the front-most skin point of piece_upper_torso straight behind it (a ray along -forward), moved `lift` in front of it along forward, so
  // the patch follows the skin, is skinned like the three skin vertices it sits on (their own-side bone weights, barycentric), and cannot reach other pieces.
  let belly = null;
  if (bellyOpen) {
    const B = bellyOpen, ax = bodyAxes(J), f = ax.fwd, lat = ax.lat;
    const sa = sub(fns.neck.point, fns.waist.point), L = vlen(sa);
    let up = sub(sa, f.map((x) => x * dot(sa, f)));
    up = norm(sub(up, lat.map((x) => x * dot(up, lat))));
    const span = Math.abs(dot(lat, sub(J.LeftArm, J.RightArm))), a = B.half_width_frac * span, b = B.half_height_frac * L;
    let c0 = lerp3(fns.waist.point, fns.neck.point, B.centre_frac);
    c0 = sub(c0, lat.map((x) => x * (dot(lat, c0) - ax.centre)));
    fns.belly_open = makeFn("belly_open", c0, f, "ellipse centre " + B.centre_frac + " of the way from the waist plane point to the neck plane point on the symmetry plane; normal = the body's forward axis (Foot to ToeBase)");
    const clear = fns.waist.d(sub(c0, up.map((x) => x * b)));
    if (clear < B.min_clearance_frac * L) throw new Error(`belly_open: the ellipse reaches ${clear.toFixed(3)} m above the waist plane, under the ${(B.min_clearance_frac * L).toFixed(3)} m clearance: lower half_height_frac or raise centre_frac`);
    // skin triangles of the torso that the ellipse can see, in the ellipse's own coordinates (X lateral, Y up, Z forward)
    const loc = (p) => { const d = sub(p, c0); return [dot(lat, d), dot(up, d), dot(f, d)]; };
    const cand = [];
    for (const [ta, tb, tc] of pieceTris.upper_torso) {
      const q = [loc(V.pos[ta]), loc(V.pos[tb]), loc(V.pos[tc])];
      if (Math.min(q[0][0], q[1][0], q[2][0]) > a || Math.max(q[0][0], q[1][0], q[2][0]) < -a || Math.min(q[0][1], q[1][1], q[2][1]) > b || Math.max(q[0][1], q[1][1], q[2][1]) < -b) continue;
      const den = (q[1][1] - q[2][1]) * (q[0][0] - q[2][0]) + (q[2][0] - q[1][0]) * (q[0][1] - q[2][1]);
      if (Math.abs(den) < 1e-14) continue;
      cand.push({ v: [ta, tb, tc], q, den });
    }
    const hitAt = (x, y) => {
      let best = null;
      for (const c of cand) {
        const [p0, p1, p2] = c.q;
        const w0 = ((p1[1] - p2[1]) * (x - p2[0]) + (p2[0] - p1[0]) * (y - p2[1])) / c.den, w1 = ((p2[1] - p0[1]) * (x - p2[0]) + (p0[0] - p2[0]) * (y - p2[1])) / c.den, w2 = 1 - w0 - w1;
        if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
        const z = w0 * p0[2] + w1 * p1[2] + w2 * p2[2];
        if (!best || z > best.z) best = { z, c, w: [w0, w1, w2] };
      }
      return best;
    };
    const coreRings = Math.round(B.core_frac * B.rings), pv = [], tr = []; // pv: { p, n, uv, j, w, s }
    const addV = (x, y, s) => {
      const h = hitAt(x, y);
      if (!h) throw new Error(`belly_open: no torso skin behind the patch at (${x.toFixed(3)}, ${y.toFixed(3)}) in the ellipse frame: the ellipse is not on the torso`);
      const z = h.z + B.rim_lift + B.bulge * (1 - s * s);
      const p = [c0[0] + lat[0] * x + up[0] * y + f[0] * z, c0[1] + lat[1] * x + up[1] * y + f[1] * z, c0[2] + lat[2] * x + up[2] * y + f[2] * z];
      let n = cross(sub(V.pos[h.c.v[1]], V.pos[h.c.v[0]]), sub(V.pos[h.c.v[2]], V.pos[h.c.v[0]]));
      n = norm(n); if (dot(n, f) < 0) n = n.map((e) => -e);
      const acc = new Map();
      h.c.v.forEach((v, k) => { const bw = bindWeights(v, B.region); for (let m = 0; m < 4; m++) if (bw.w[m] > 0) acc.set(bw.j[m], (acc.get(bw.j[m]) || 0) + bw.w[m] * h.w[k]); });
      const list = [...acc.entries()].sort((u, w) => w[1] - u[1] || u[0] - w[0]).slice(0, 4), sum = list.reduce((t, e) => t + e[1], 0), jj = [0, 0, 0, 0], ww = [0, 0, 0, 0];
      list.forEach((e, k) => { jj[k] = e[0]; ww[k] = e[1] / sum; });
      pv.push({ p, n, uv: [0.5 + 0.5 * x / a, 0.5 + 0.5 * y / b], j: jj, w: ww, s, x, y, skinZ: h.z });
      return pv.length - 1;
    };
    const centre = addV(0, 0, 0), ringStart = [];
    for (let i = 1; i <= B.rings; i++) { ringStart.push(pv.length); for (let k = 0; k < B.segments; k++) { const an = 2 * Math.PI * k / B.segments, s = i / B.rings; addV(a * s * Math.cos(an), b * s * Math.sin(an), s); } }
    let flipped = 0;
    const pushTri = (i0, i1, i2, ring) => {
      const g = cross(sub(pv[i1].p, pv[i0].p), sub(pv[i2].p, pv[i0].p));
      if (dot(g, f) < 0) { flipped++; tr.push([i0, i2, i1, ring]); } else tr.push([i0, i1, i2, ring]);
    };
    for (let k = 0; k < B.segments; k++) pushTri(centre, ringStart[0] + k, ringStart[0] + (k + 1) % B.segments, 1);
    for (let i = 0; i + 1 < B.rings; i++) for (let k = 0; k < B.segments; k++) {
      const a0 = ringStart[i] + k, a1 = ringStart[i] + (k + 1) % B.segments, b0 = ringStart[i + 1] + k, b1 = ringStart[i + 1] + (k + 1) % B.segments;
      pushTri(a0, b0, b1, i + 2); pushTri(a0, b1, a1, i + 2);
    }
    let area = 0;
    for (const [i0, i1, i2] of tr) area += 0.5 * vlen(cross(sub(pv[i1].p, pv[i0].p), sub(pv[i2].p, pv[i0].p)));
    belly = { B, c0, f, lat, up, a, b, pv, tr, coreRings, flipped, area, ellipseArea: Math.PI * a * b, waistClearance: clear, torsoTrianglesSeen: cand.length };
  }

  // ---- build the output document
  const buffer =root.listBuffers()[0] || doc.createBuffer();
  const oldAcc = new Set();
  for (const m of oldMeshes) for (const p of m.listPrimitives()) { for (const s of p.listSemantics()) oldAcc.add(p.getAttribute(s)); if (p.getIndices()) oldAcc.add(p.getIndices()); }
  const parent = oldNodes[0].getParentNode();
  const scene = root.listScenes()[0];
  for (const n of oldNodes) n.dispose();
  for (const m of oldMeshes) { for (const p of m.listPrimitives()) p.dispose(); m.dispose(); }
  for (const s of oldSkins) s.dispose();
  for (const a of oldAcc) if (a.listParents().every((p) => p.propertyType === "Root")) a.dispose();
  for (const ext of root.listExtensionsUsed()) if (ext.extensionName === "EXT_meshopt_compression" || ext.extensionName === "KHR_mesh_quantization") ext.dispose();

  const mkAcc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const addNode = (name, mesh) => {
    const n = doc.createNode(name).setMesh(mesh).setSkin(skin0);
    if (parent) parent.addChild(n); else scene.addChild(n);
    return n;
  };
  const piecePos = {}, pieceIdx = {}, outStats = { pieces: {}, caps: {} };
  for (const R of regions) {
    const mesh = doc.createMesh(R.mesh);
    const pp = [], ii = [];
    let vcount = 0, tcount = 0;
    for (const P of outPieces[R.id].prims) {
      const n = P.gv.length;
      const prim = doc.createPrimitive().setMaterial(srcPrims[P.pi].material);
      const pos = new Float32Array(n * 3), posW = new Float64Array(n * 3), jj = new Uint16Array(n * 4), ww = new Float32Array(n * 4);
      const att = Object.fromEntries(semantics.map((s) => [s, new Float32Array(n * V.attr[s][0].length)]));
      P.gv.forEach((v, k) => {
        pos.set(V.pos[v], k * 3); posW.set(V.pos[v], k * 3);
        const b = bindWeights(v, R.id);
        jj.set(b.j, k * 4); ww.set(b.w, k * 4);
        for (const s of semantics) {
          let val = V.attr[s][v];
          if (s === "NORMAL") val = V.frame[v].normalToWorld(val); else if (s === "TANGENT") val = [...norm(V.frame[v].tangentToWorld(val)), val[3]];
          att[s].set(val, k * val.length);
        }
      });
      prim.setAttribute("POSITION", mkAcc("VEC3", pos));
      for (const s of semantics) prim.setAttribute(s, mkAcc(["SCALAR", "VEC2", "VEC3", "VEC4"][V.attr[s][0].length - 1], att[s]));
      prim.setAttribute("JOINTS_0", mkAcc("VEC4", jj)).setAttribute("WEIGHTS_0", mkAcc("VEC4", ww));
      const idx = n < 65536 ? new Uint16Array(P.indices) : new Uint32Array(P.indices);
      prim.setIndices(mkAcc("SCALAR", idx));
      mesh.addPrimitive(prim);
      pp.push(posW); ii.push(idx);
      vcount += n; tcount += idx.length / 3;
    }
    addNode(R.mesh, mesh);
    piecePos[R.id] = pp; pieceIdx[R.id] = ii;
    outStats.pieces[R.id] = { vertices: vcount, triangles: tcount };
  }
  const flesh = doc.createMaterial(FLESH.name).setBaseColorFactor(FLESH.color).setRoughnessFactor(FLESH.roughness).setMetallicFactor(0);
  const capGeom = {};
  const capsMissing = [];
  for (const C of capsAll) {
    const rec = capsOut[C.id];
    if (!rec) { capsMissing.push(C.id); continue; }
    // A triangle's winding is judged above on float64 positions, but the file stores float32 and the validator reads the file. A triangle whose winding
    // then disagrees with its stored normals is either a sliver whose sign flips under the rounding, or a folded triangle (of a loop that crosses itself)
    // that the float64 test did not catch: this pass does not tell them apart and does not look at size. CUT-VALIDATE `caps` allows 1 percent of a cap's
    // triangles to disagree. When a cap is over that, every disagreeing triangle gets vertices of its own carrying the normal of its winding, like a
    // folded one (geometry unchanged, only the stored normals). A cap within the allowance is left exactly as built.
    {
      const bad = [];
      let total = 0;
      for (let t = 0; t + 2 < rec.tris.length; t += 3) {
        const q = [0, 1, 2].map((k) => V.pos[rec.verts[rec.tris[t + k]]].map(Math.fround));
        const g = cross(sub(q[1], q[0]), sub(q[2], q[0]));
        if (!(vlen(g) > 1e-14)) continue; // the validator skips these
        total++;
        const avg = [0, 1, 2].map((k) => rec.nrm[rec.tris[t]][k] + rec.nrm[rec.tris[t + 1]][k] + rec.nrm[rec.tris[t + 2]][k]);
        if (dot(g, avg.map(Math.fround)) <= 0) bad.push(t);
      }
      if (total && (total - bad.length) / total < 0.99) {
        for (const t of bad) for (let k = 0; k < 3; k++) {
          const i = rec.tris[t + k];
          rec.tris[t + k] = rec.verts.length;
          rec.verts.push(rec.verts[i]); rec.uv.push(rec.uv[i]); rec.nrm.push(rec.nrm[i].map((x) => -x));
        }
        capStats.rewound_triangles = (capStats.rewound_triangles || 0) + bad.length;
      }
    }
    const n = rec.verts.length;
    const posW = new Float64Array(n * 3), pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2), jj = new Uint16Array(n * 4), ww = new Float32Array(n * 4);
    rec.verts.forEach((v, k) => {
      pos.set(V.pos[v], k * 3); posW.set(V.pos[v], k * 3); nor.set(rec.nrm[k], k * 3); uv.set(rec.uv[k], k * 2);
      const b = bindWeights(v, C.region);
      jj.set(b.j, k * 4); ww.set(b.w, k * 4);
    });
    const prim = doc.createPrimitive().setMaterial(flesh)
      .setAttribute("POSITION", mkAcc("VEC3", pos)).setAttribute("NORMAL", mkAcc("VEC3", nor)).setAttribute("TEXCOORD_0", mkAcc("VEC2", uv))
      .setAttribute("JOINTS_0", mkAcc("VEC4", jj)).setAttribute("WEIGHTS_0", mkAcc("VEC4", ww))
      .setIndices(mkAcc("SCALAR", n < 65536 ? new Uint16Array(rec.tris) : new Uint32Array(rec.tris)));
    addNode(C.id, doc.createMesh(C.id).addPrimitive(prim));
    capGeom[C.id] = { positions: posW, indices: rec.tris };
    outStats.caps[C.id] = { vertices: n, triangles: rec.tris.length / 3 };
  }
  if (belly) { // one mesh, two primitives: the flesh rim and the dark core
    const inner = doc.createMaterial(FLESH_INNER.name).setBaseColorFactor(FLESH_INNER.color).setRoughnessFactor(FLESH_INNER.roughness).setMetallicFactor(0);
    const mesh = doc.createMesh(belly.B.cap);
    for (const [mat, pick] of [[inner, (r) => r <= belly.coreRings], [flesh, (r) => r > belly.coreRings]]) {
      const T = belly.tr.filter((t) => pick(t[3])), map = new Map(), used = [];
      for (const t of T) for (const v of t.slice(0, 3)) if (!map.has(v)) { map.set(v, used.length); used.push(v); }
      const n = used.length, pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2), jj = new Uint16Array(n * 4), ww = new Float32Array(n * 4);
      used.forEach((v, k) => { const q = belly.pv[v]; pos.set(q.p, k * 3); nor.set(q.n, k * 3); uv.set(q.uv, k * 2); jj.set(q.j, k * 4); ww.set(q.w, k * 4); });
      const idx = T.flatMap((t) => [map.get(t[0]), map.get(t[1]), map.get(t[2])]);
      mesh.addPrimitive(doc.createPrimitive().setMaterial(mat)
        .setAttribute("POSITION", mkAcc("VEC3", pos)).setAttribute("NORMAL", mkAcc("VEC3", nor)).setAttribute("TEXCOORD_0", mkAcc("VEC2", uv))
        .setAttribute("JOINTS_0", mkAcc("VEC4", jj)).setAttribute("WEIGHTS_0", mkAcc("VEC4", ww)).setIndices(mkAcc("SCALAR", n < 65536 ? new Uint16Array(idx) : new Uint32Array(idx))));
    }
    addNode(belly.B.cap, mesh);
    outStats.caps[belly.B.cap] = { vertices: belly.pv.length, triangles: belly.tr.length };
  }
  if (ibm) { // inverse binds absorb Q^-1 (see above)
    const arr = new Float32Array(joints.length * 16);
    for (let i = 0; i < joints.length; i++) arr.set(mul4(ibm.getElement(i, new Array(16)), Qinv), i * 16);
    ibm.setArray(arr);
  }
  const glb = await io.writeBinary(doc);

  // ---- watertight check: every piece with the caps that belong to it
  const watertight = {};
  let allClosed = true, openTotal = 0, cutOpenTotal = 0, nativeTotal = 0, nonManifoldTotal = 0;
  for (const R of regions) {
    const parts = piecePos[R.id].map((p, k) => ({ positions: p, indices: pieceIdx[R.id][k] }));
    for (const C of capsAll) if (C.region === R.id && capGeom[C.id]) parts.push(capGeom[C.id]);
    const rep = weldReport(parts, 1e-5, true);
    // an open edge is "at a cut" when both its ends lie on a cut plane; the rest are open edges the source mesh already had (hair cards, eye sockets...)
    const onAnyPlane = (p) => regionPlanes(R).some((id) => Math.abs(fns[id].d(p)) <= 3 * eps);
    const atCut = rep.boundary_list.filter(([a, b]) => onAnyPlane(a) && onAnyPlane(b));
    watertight[R.id] = { boundary_edges: rep.boundary_edges, open_edges_at_cuts: atCut.length, open_edges_native: rep.boundary_edges - atCut.length, non_manifold_edges: rep.non_manifold_edges, degenerate_triangles: rep.degenerate, at_cuts: atCut.slice(0, 4).map((e) => ({ from: e[0].map(r6), planes: regionPlanes(R).filter((id) => Math.abs(fns[id].d(e[0])) <= 3 * eps && Math.abs(fns[id].d(e[1])) <= 3 * eps) })) };
    if (!rep.watertight) allClosed = false;
    openTotal += rep.boundary_edges; cutOpenTotal += atCut.length; nativeTotal += rep.boundary_edges - atCut.length; nonManifoldTotal += rep.non_manifold_edges;
  }

  // ---- manifest
  const planes = {};
  for (const id of ["neck", "shoulder_left", "shoulder_right", "hip_left", "hip_right", "waist"]) {
    const f = fns[id];
    planes[id] = { point: sub(f.point, offset).map(r6), normal: f.n.map(r6), source: f.source };
  }
  // the internal hip bisector is not a cut: kept out of `planes` (readers match plane names loosely) and listed apart
  const internalPlanes = { hip_split: { point: sub(fns.hip_split.point, offset).map(r6), normal: fns.hip_split.n.map(r6), source: fns.hip_split.source } };
  let verticesOut = 0, capVerts = 0;
  for (const R of regions) verticesOut += outStats.pieces[R.id].vertices;
  for (const k of Object.keys(outStats.caps)) capVerts += outStats.caps[k].vertices;
  // optional cuts: additive manifest fields (cut-pieces/1 readers ignore them); absent when both are off
  const optionalUnits = {}, optionalPlanes = {};
  const planeRow = (f) => ({ point: sub(f.point, offset).map(r6), normal: f.n.map(r6), source: f.source });
  if (headSplit) {
    optionalPlanes.head_split = planeRow(fns.head_split);
    optionalUnits.head_split = { enabled: true, kind: "split", unit: headSplit.unit, plane: headSplit.plane, replaces: "piece_" + headSplit.replaces, regions: headSplit.regions.map((r) => r.id), caps: headSplit.caps.map((c) => c.id),
      about: "piece_head is cut at a sagittal plane into piece_head_left (+ side of the plane) and piece_head_right; both are detached by the unit head and separated by the unit head_split. Hair cards go whole to the half they lie mostly in", stats: splitInfo };
  }
  if (handsFeet) {
    for (const L of handsFeet.limbs) optionalPlanes[L.plane] = planeRow(fns[L.plane]);
    optionalUnits.hands_feet = { enabled: true, kind: "split", unit: handsFeet.unit, units: handsFeet.limbs.map((L) => L.id), planes: handsFeet.limbs.map((L) => L.plane), regions: handsFeet.limbs.map((L) => L.id), caps: handsFeet.caps.concat(accCaps).map((c) => c.id),
      about: "piece_arm_* end at the wrist plane and piece_hand_* hold everything beyond it (hand, fingers, gear on those bones); piece_leg_* end at the ankle plane and piece_foot_* hold foot and toes. Each is detached by its own unit (hand_left ...); the arm and leg regions keep their ids and detached_by. Every piece is bound only to the bones on its own side of its plane",
      params: { wrist_frac: handsFeet.wrist_frac, ankle_frac: handsFeet.ankle_frac, ...(handsFeet.accessory_feet ? { accessory_feet: true } : {}) }, stats: handsInfo,
      ...(accCaps.length ? { accessory_caps: accCaps.map((c) => ({ id: c.id, region: c.region, plane: c.plane, shown_when_cut: c.shown_when_cut })) } : {}) };
  }
  if (belly) {
    optionalPlanes.belly_open = planeRow(fns.belly_open);
    const B = belly.B;
    optionalUnits.belly_open = { enabled: true, kind: "opening", unit: B.unit, plane: B.plane, cap: B.cap, region: B.region, removes_geometry: false, detaches: null,
      about: "a wound patch (flesh rim + cap_inner core) standing in front of the torso skin; the skin under it is not removed, so it reads as an opening only as a decal: hide or replace the skin under it at runtime for a true hole",
      frame: { centre: sub(belly.c0, offset).map(r6), forward: belly.f.map(r6), lateral: belly.lat.map(r6), up: belly.up.map(r6), half_width: r6(belly.a), half_height: r6(belly.b) },
      params: { rim_lift: B.rim_lift, bulge: B.bulge, rings: B.rings, segments: B.segments, core_rings: belly.coreRings },
      materials: { rim: FLESH.name, core: FLESH_INNER.name },
      stats: { vertices: belly.pv.length, triangles: belly.tr.length, area: r6(belly.area), ellipse_area: r6(belly.ellipseArea), triangles_rewound: belly.flipped, waist_clearance: r6(belly.waistClearance), torso_triangles_seen: belly.torsoTrianglesSeen } };
  }
  const manifest = {
    schema: "cut-pieces/1",
    body: opts.body || row.id || "body",
    rig: opts.rig || "rig",
    source: opts.source || "body.glb",
    regions: regions.map((r) => ({ id: r.id, mesh: r.mesh, detached_by: r.detached_by, ...(r.separated_by ? { separated_by: r.separated_by } : {}) })),
    caps: capsAll.filter((c) => capGeom[c.id]).map((c) => ({ id: c.id, mesh: c.id, region: c.region, shown_when_cut: c.shown_when_cut }))
      .concat(belly ? [{ id: belly.B.cap, mesh: belly.B.cap, region: belly.B.region, shown_when_cut: belly.B.unit, kind: "opening" }] : []),
    planes,
    internal_planes: internalPlanes,
    ...(Object.keys(optionalUnits).length ? { optional_units: optionalUnits, optional_planes: optionalPlanes } : {}),
    plane_frame: { about: "plane points are in the measure row's coordinates (floor-lifted bind pose, metres); add bind_offset to get the GLB's bind-pose world space; vertex_to_world is the identity in the cut GLB (written in metres); source_vertex_to_world is the matrix the source GLB's stored vertex space needed", bind_offset: offset.map(r6), crotch_apex: apex ? sub(apex, offset).map(r6) : null, vertex_to_world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], source_vertex_to_world: Q.map((x) => Math.round(x * 1e9) / 1e9) },
    stats: {
      vertices_in: verticesIn,
      vertices_out: verticesOut,
      cap_vertices: capVerts,
      triangles_in: tris.length,
      triangles_out: regions.reduce((s, r) => s + outStats.pieces[r.id].triangles, 0),
      triangles_split: trianglesSplit,
      split_vertices_created: V.pos.length - verticesIn,
      watertight: allClosed,
      watertight_at_cuts: cutOpenTotal === 0 && nonManifoldTotal === 0,
      open_edges: openTotal,
      open_edges_at_cuts: cutOpenTotal,
      open_edges_native: nativeTotal,
      source_open_edges: srcRep.boundary_edges,
      source_non_manifold_edges: srcRep.non_manifold_edges,
      non_manifold_edges: nonManifoldTotal,
      orphan_weights: orphan,
      hair_triangles: hairTris.length,
      hair_vertices: hairVerts.size,
      fragments: fragStats.fragments,
      fragments_reassigned_by_bones: fragStats.reassigned,
      triangles_reassigned_by_bones: fragStats.reassigned_triangles,
      weights_rebound: weightsRebound,
      weights_truncated_to_4: weightsTruncated,
      caps_missing: capsMissing,
      cap_loops: capStats.loops,
      cap_holes: capStats.holes,
      cap_open_chains: capStats.open_chains,
      cap_gaps_bridged: capStats.gaps_bridged,
      crack_vertices_snapped: report.crack_vertices_snapped,
      cap_fallback_loops: capStats.fallback_loops,
      cap_nonplanar_loops: capStats.nonplanar_loops,
      cap_forced_ears: capStats.forced_ears,
      cap_bridge_fallbacks: capStats.bridge_fallbacks,
      cap_inward_triangles: capStats.inward_triangles,
      pieces: outStats.pieces,
      caps: outStats.caps,
      watertight_by_region: watertight,
      ...(accSpecs.length ? { rigid_accessory_triangles: accTris.reduce((s, t) => s + t.length, 0) } : {}),
    },
  };
  const hairNames = [...new Set(hairTris.map((t) => srcPrims[t[3]].material.getName()))].sort();
  if (hairNames.length) {
    if (headSplit) { // each half names the hair materials it actually carries
      manifest.plane_exempt = {};
      for (const r of headSplit.regions) { const m = [...new Set(hairFor[r.id].map((t) => srcPrims[t[3]].material.getName()))].sort(); if (m.length) manifest.plane_exempt[r.mesh] = m; }
    } else manifest.plane_exempt = { piece_head: hairNames };
    manifest.plane_exempt_reason = "hair, hair cards and eyelashes belong to the head: a severed head carries its hair whole, so these materials are not cut at any plane (they reach below the neck plane) and are bound rigidly to the Head bone; cut-validate skips the planes check for them only";
  }
  if (accSpecs.length) {
    // rigid accessories: declared through the same plane_exempt mechanism (the validator is unchanged), plus a table saying where each went and on which bone
    const pe = manifest.plane_exempt || (manifest.plane_exempt = {}), entries = [];
    accSpecs.forEach((spec, k) => {
      const mesh = "piece_" + accPlace[k].region, mats = [...new Set(accTris[k].map((t) => srcPrims[t[3]].material.getName()))].sort();
      pe[mesh] = [...new Set((pe[mesh] || []).concat(mats))].sort();
      entries.push({ name: spec.name, ...(spec.shells_inside ? { shells_inside: spec.shells_inside } : {}), mesh, materials: mats, bone: joints[accPlace[k].bone].getName(), triangles: accTris[k].length, vertices: accVerts[k].size });
    });
    const accReason = "rigid accessory layers (the row's rigid_accessory_materials: a skirt, sash, hem, jacket, trousers or pauldron layer) are kept whole and bound rigidly to one bone of the piece that holds them, so they are not cut at any plane (they reach across planes of the pieces beside them); cut-validate skips the planes check for them only";
    manifest.plane_exempt_reason = manifest.plane_exempt_reason ? manifest.plane_exempt_reason + "; " + accReason : accReason;
    manifest.rigid_accessories = entries;
    if (handsFeet && handsFeet.accessory_feet) {
      for (const L of handsFeet.limbs) if (L.with_accessories && accFootVerts[L.id] && accFootVerts[L.id].size) {
        const own = pieceTris[L.id].filter((t) => accPrim[t[3]] >= 0);
        pe[L.mesh] = [...new Set(own.map((t) => srcPrims[t[3]].material.getName()))].sort();
        manifest.rigid_accessories_on_feet = { ...(manifest.rigid_accessories_on_feet || {}), [L.mesh]: { bone: joints[accFootBone[L.id]].getName(), triangles: own.length, vertices: accFootVerts[L.id].size } };
      }
    }
  }
  return { glb, manifest, report };
}

// ---------------------------------------------------------------- CLI
async function main() {
  const args = process.argv.slice(2);
  const bi = args.indexOf("--body");
  let bodyName = null;
  if (bi >= 0) { bodyName = args[bi + 1]; args.splice(bi, 2); }
  const [glbPath, rowPath, mapPath, outDir] = args;
  if (!outDir) { console.error("usage: node tools/cut-units.mjs <body.glb> <body.measure.json> <rig-map.json> <out-dir> [--body name] [--head-split] [--belly-open] [--hands-feet]"); process.exit(2); }
  const row = JSON.parse(readFileSync(rowPath, "utf8"));
  const rigMap = JSON.parse(readFileSync(mapPath, "utf8"));
  const name = bodyName || row.id || basename(glbPath, ".glb");
  const debug = args.includes("--debug") || process.env.CUT_DEBUG === "1";
  const { glb, manifest, report } = await cutGlb(readFileSync(glbPath), row, rigMap, { body: name, rig: basename(mapPath, ".json"), source: basename(glbPath), debug, headSplit: args.includes("--head-split"), bellyOpen: args.includes("--belly-open"), handsFeet: args.includes("--hands-feet") });
  if (debug) console.log(JSON.stringify(report, null, 1));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, name + ".cut.glb"), glb);
  if (args.includes("--meshopt")) { // optional shipping copy: meshopt + quantised, NOT the contract file
    const { NodeIO } = await import("@gltf-transform/core");
    const { ALL_EXTENSIONS, EXTMeshoptCompression } = await import("@gltf-transform/extensions");
    const { MeshoptDecoder, MeshoptEncoder } = await import("meshoptimizer");
    await MeshoptDecoder.ready; await MeshoptEncoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });
    const d = await io.readBinary(glb);
    d.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
    writeFileSync(join(outDir, name + ".cut.min.glb"), await io.writeBinary(d));
  }
  const so = args.indexOf("--source-out");
  if (so >= 0) writeFileSync(args[so + 1], await decompressGlb(readFileSync(glbPath)));
  writeFileSync(join(outDir, name + ".cut.manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
  const s = manifest.stats;
  console.log(`${name}: vertices ${s.vertices_in} -> ${s.vertices_out} (+${s.cap_vertices} cap), triangles ${s.triangles_in} -> ${s.triangles_out}, split ${s.triangles_split}, watertight ${s.watertight} (open edges ${s.open_edges}: ${s.open_edges_at_cuts} at cuts, ${s.open_edges_native} native to the source; ${s.non_manifold_edges} non-manifold), orphan weights ${s.orphan_weights}, rebound ${s.weights_rebound}`);
  for (const [r, w] of Object.entries(s.watertight_by_region)) if (w.open_edges_at_cuts || w.non_manifold_edges) console.log(`  OPEN ${r}: ${w.open_edges_at_cuts} at cuts, ${w.non_manifold_edges} non-manifold, first at ${JSON.stringify(w.at_cuts.slice(0, 3))}`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e.stack || e); process.exit(1); });
