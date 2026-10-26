// Ragdoll generator, lifted from opentrident-steam tools/ragdoll-gen.mjs (OpenTrident M2): one body measure row (height_m, lengths, girths, 20 joint
// positions) + the role table (data/ragdoll-role-table.json) -> one ragdoll-row/2: a capsule per bone role with radius, length, mass, joint type and
// limits, motor defaults, damage multiplier, material and armour slot. Plain JS, no dependencies, engine independent, no bone names beyond the 20 role joints.
// Units: metres, kilograms, degrees in the row. Capsule axis is local Y; centre = middle of the bone (or of the extended bone).
import ROLE_TABLE from "../data/ragdoll-role-table.json" with { type: "json" };

// ---- small vector / quaternion maths ([x, y, z, w] quaternions)
const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vscl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vlen = (a) => Math.sqrt(vdot(a, a));
const vnorm = (a) => vscl(a, 1 / (vlen(a) || 1));
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export function qShortestArc(from, to) {
  const f = vnorm(from), t = vnorm(to), d = vdot(f, t);
  if (d < -0.999999) return [1, 0, 0, 0]; // 180 degrees about local X (keeps a knee/elbow hinge axis along X)
  const c = vcross(f, t), q = [c[0], c[1], c[2], 1 + d], l = Math.hypot(...q);
  return q.map((x) => x / l);
}
// A stable capsule frame: local Y = the bone direction, local X = a fixed reference side axis made perpendicular to it (world +Y for the arm chain, whose bones run
// sideways, world +X for everything else). The roll is therefore a rule, not an accident of a shortest-arc rotation: a leg tilted 6 degrees off vertical gets the same
// hinge axis (world X) as a perfectly vertical one, so knees and elbows bend about the right axis on every body.
const ARM_CHAIN = new Set(["arm", "forearm", "hand"]);
// Hinge roles (elbow, knee) of a body that rests with the joint already bent (the MakeHuman A-pose bodies): the hinge axis is the normal of the bend plane
// (parent direction x own direction), signed to agree with the straight-limb rule, because the straight-limb axis is not the joint's real axis once it is bent.
const HINGE_ROLES = new Set(["forearm", "shin"]);
export function frameQuat(dir, role, parentDir) {
  const y = vnorm(dir);
  let ref = ARM_CHAIN.has(role) ? [0, 1, 0] : [1, 0, 0];
  if (Math.abs(vdot(ref, y)) > 0.98) ref = ARM_CHAIN.has(role) ? [0, 0, 1] : [0, 0, 1];
  if (parentDir && HINGE_ROLES.has(role)) {
    const n = vcross(vnorm(parentDir), y);
    if (vlen(n) > 0.09) ref = vscl(vnorm(n), vdot(n, ref) >= 0 ? 1 : -1); // bend of more than about 5 degrees
  }
  const x = vnorm(vsub(ref, vscl(y, vdot(ref, y)))), z = vcross(x, y);
  // rotation matrix with columns x, y, z -> quaternion
  const m00 = x[0], m10 = x[1], m20 = x[2], m01 = y[0], m11 = y[1], m21 = y[2], m02 = z[0], m12 = z[1], m22 = z[2];
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]; }
  const l = Math.hypot(...q);
  return q.map((v) => v / l);
}
const round = (x, n = 5) => Math.round(x * 10 ** n) / 10 ** n;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ---- segment to segment distance (for the rest-pose penetration check and the radius relaxation)
export function segSegDist(p1, q1, p2, q2) {
  const d1 = vsub(q1, p1), d2 = vsub(q2, p2), r = vsub(p1, p2);
  const a = vdot(d1, d1), e = vdot(d2, d2), f = vdot(d2, r);
  let s, t;
  if (a < 1e-12 && e < 1e-12) return vlen(r);
  if (a < 1e-12) { s = 0; t = clamp(f / e, 0, 1); }
  else {
    const c = vdot(d1, r);
    if (e < 1e-12) { t = 0; s = clamp(-c / a, 0, 1); }
    else {
      const b = vdot(d1, d2), den = a * e - b * b;
      s = den > 1e-12 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  return vlen(vsub(vadd(p1, vscl(d1, s)), vadd(p2, vscl(d2, t))));
}

// ---- lint: armour carries a threshold modifier, never a block (Dom, 2026-10-25)
const BLOCK_RE = /block|immune|invulnerab|cannot_?sever|no_?dismember|prevent/i;
export function lintNoBlock(obj, path = "") {
  const bad = [];
  const walk = (o, p) => {
    if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) {
      if (BLOCK_RE.test(k)) bad.push(p + "." + k);
      walk(v, p + "." + k);
    }
  };
  walk(obj, path);
  return bad;
}

export function loadTable(table = ROLE_TABLE) {
  const bad = lintNoBlock(table.armour_tiers, "armour_tiers");
  if (bad.length) throw new Error("role table has block-like armour fields (Dom's ruling: threshold modifiers only): " + bad.join(", "));
  for (const [name, t] of Object.entries(table.armour_tiers.tiers)) {
    if (!(t.dismember_threshold_modifier >= 1)) throw new Error("armour tier " + name + ": dismember_threshold_modifier must be a number >= 1");
  }
  return table;
}

// roles of one body: expand the sided roles into Left / Right
function expandRoles(table) {
  const out = [];
  for (const r of table.roles) {
    if (r.sided) {
      for (const S of ["Left", "Right"]) {
        const sideOf = (p) => (p && table.roles.find((x) => x.id === p && x.sided) ? p + S : p);
        out.push({ ...r, id: r.id + S, role: r.id, side: S, start: S + r.start, end: r.end ? S + r.end : undefined, parent: sideOf(r.parent) });
      }
    } else out.push({ ...r, role: r.id, side: null });
  }
  return out;
}

const JOINT_KEYS = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "LeftArm", "LeftForeArm", "LeftHand", "RightArm", "RightForeArm", "RightHand",
  "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase", "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"];

function geometry(table, m, relaxLog) {
  const H = m.height_m, ref = table.reference;
  const P = m.joints;
  for (const k of JOINT_KEYS) if (!P[k]) throw new Error("measure row has no joint " + k);
  const roles = expandRoles(table);
  const byId = Object.fromEntries(roles.map((r) => [r.id, r]));
  const out = roles.map((r) => {
    const p0 = P[r.start];
    let p1;
    if (r.end) p1 = P[r.end];
    else {
      // extension beyond the last joint along the direction of the parent bone
      const parentStart = P[byId[r.parent].start];
      const dir = vnorm(vsub(p0, parentStart));
      const ratio = { head: ref.head_ext_height_ratio, hand: ref.hand_ext_height_ratio, toe: ref.toe_ext_height_ratio }[r.ext];
      p1 = vadd(p0, vscl(dir, ratio * H));
    }
    const L = vlen(vsub(p1, p0));
    const R = r.r;
    let rad;
    const wChest = m.chest_w, wWaist = m.waist_w, wHip = m.hip_w;
    if (R.from === "hip_w") rad = R.k * wHip;
    else if (R.from === "waist_w") rad = R.k * wWaist;
    else if (R.from === "waist_chest") rad = R.k * (wWaist + wChest) / 2;
    else if (R.from === "chest_w") rad = R.k * wChest;
    else if (R.from === "fixed_height_ratio" || R.from === "neck_len") rad = R.fixed_height_ratio * H;
    else {
      rad = R.k_len * L;
      const meas = m[R.from];
      if (meas) rad = clamp(rad, R.min_measured * meas, R.max_measured * meas);
    }
    rad = Math.min(rad, R.max_len_ratio * L);
    return { id: r.id, role: r.role, side: r.side, parent: r.parent, def: r, p0, p1, L, mid: vscl(vadd(p0, p1), 0.5), dir: vnorm(vsub(p1, p0)), r: rad, rNominal: rad };
  });
  // thigh radius also limited by the hip spacing, so the two thighs do not start inside each other
  const hipGap = vlen(vsub(P.LeftUpLeg, P.RightUpLeg));
  for (const b of out) if (b.role === "thigh") b.r = b.rNominal = Math.min(b.r, 0.46 * hipGap);
  // relax: shrink the radii of capsule pairs that overlap at rest (parent and child are excluded in the engine, so they are not checked)
  const idx = Object.fromEntries(out.map((b, i) => [b.id, i]));
  const ends = (b) => { const hh = Math.max(0.01, b.L / 2 - b.r); return [vsub(b.mid, vscl(b.dir, hh)), vadd(b.mid, vscl(b.dir, hh))]; };
  const adj = (a, b) => a.parent === b.id || b.parent === a.id;
  let iterations = 0;
  for (; iterations < 40; iterations++) {
    let worst = 0;
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
      const a = out[i], b = out[j];
      if (adj(a, b)) continue;
      const [a0, a1] = ends(a), [b0, b1] = ends(b);
      const pen = a.r + b.r - segSegDist(a0, a1, b0, b1);
      if (pen > 0.002) {
        worst = Math.max(worst, pen);
        const k = 1 - Math.min(0.5, (pen * 1.05) / (a.r + b.r));
        a.r = Math.max(a.r * k, 0.55 * a.rNominal); b.r = Math.max(b.r * k, 0.55 * b.rNominal);
      }
    }
    if (worst === 0) break;
  }
  relaxLog.iterations = iterations;
  relaxLog.shrunk = out.filter((b) => b.r < b.rNominal - 1e-6).map((b) => ({ id: b.id, from: round(b.rNominal, 4), to: round(b.r, 4) }));
  return out;
}

const capsuleVolume = (r, halfH) => Math.PI * r * r * 2 * halfH + (4 / 3) * Math.PI * r ** 3;
const TORSO = new Set(["hips", "spine", "spine1", "spine2"]);

// Body volume for the mass: the limb, neck and head capsules plus an elliptic-cylinder torso from the measured widths (the torso capsules are too slim
// to carry a wide body's mass: a dwarf came out at 34 kg before this).
export function bodyVolume(geo, m) {
  const W = (m.chest_w + m.waist_w + m.hip_w) / 3, D = (m.chest_d || 0.7 * m.chest_w) * 0.9;
  const torso = (Math.PI / 4) * W * D * m.torso_len;
  return torso + geo.filter((b) => !TORSO.has(b.role)).reduce((a, b) => a + capsuleVolume(b.r, Math.max(0.01, b.L / 2 - b.r)), 0);
}

export function totalVolume(table, m) {
  const log = {};
  return bodyVolume(geometry(table, m, log), m);
}

// stand-alone self test of the lint (the CLI flag --selftest-lint): an armour row with a block-like field must fail
export function lintSelfTest(table) {
  const probes = [{ block_dismember: true }, { immune: ["head"] }, { Block_Dismember_Bone: "head" }, { cannotSever: 1 }, { no_dismember: 1 }, { prevent_cut: 1 }];
  const results = probes.map((p) => ({ field: Object.keys(p)[0], rejected: lintNoBlock({ slots: { head: p } }, "armour").length > 0 }));
  const clean = lintNoBlock({ armour: table.armour_tiers }, "").length === 0;
  return { probes: results, table_clean: clean, ok: results.every((r) => r.rejected) && clean };
}

export function generateRow(bodyId, m, table, opts = {}) {
  if (!m || m.error || !m.joints) throw new Error(bodyId + ": no usable measure row");
  const volumeRef = opts.volumeRef ?? table.reference.volume_m3;
  const relaxLog = {};
  const geo = geometry(table, m, relaxLog);
  const vol = bodyVolume(geo, m);
  const capVol = geo.reduce((a, b) => a + capsuleVolume(b.r, Math.max(0.01, b.L / 2 - b.r)), 0);
  const ref = table.reference;
  const rawTotal = ref.total_mass_kg * vol / volumeRef;
  const total = clamp(rawTotal, ref.mass_bounds_kg[0], ref.mass_bounds_kg[1]);
  const fracSum = geo.reduce((a, b) => a + b.def.mass_hq_kg, 0);
  const roleRows = geo.map((b) => {
    const halfH = Math.max(0.01, b.L / 2 - b.r);
    const mass = total * b.def.mass_hq_kg / fracSum;
    const par = b.parent ? geo.find((g) => g.id === b.parent) : null;
    const q = frameQuat(b.dir, b.role, par ? par.dir : null);
    const joint = b.def.joint ? { ...b.def.joint } : null;
    return {
      id: b.id, role: b.role, side: b.side, parent: b.parent,
      bone_start: b.def.start, bone_end: b.def.end || null, extends_beyond: b.def.ext || null,
      radius_m: round(b.r), half_height_m: round(halfH), length_m: round(b.L), volume_m3: round(capsuleVolume(b.r, halfH), 6),
      mass_kg: round(mass, 3),
      rest: { centre: b.mid.map((x) => round(x)), quat: q.map((x) => round(x, 6)), pivot: b.p0.map((x) => round(x)), dir: b.dir.map((x) => round(x, 5)) },
      joint, damage_multiplier: b.def.damage_multiplier, material: b.def.material, armour_slot: b.def.armour_slot,
      source: { radius: b.def.r.source, mass: b.def.mass_source, damage: b.def.damage_source },
    };
  });
  // motor defaults: the M1 formula (SK x subtree mass x 9.81 x 0.15 m), so the engine and the row agree
  const idx = Object.fromEntries(roleRows.map((r, i) => [r.id, i]));
  const sub = roleRows.map((r) => r.mass_kg);
  const order = roleRows.map((_, i) => i).sort((a, b) => depth(b) - depth(a));
  function depth(i) { let d = 0, p = roleRows[i].parent; while (p) { d++; p = roleRows[idx[p]].parent; } return d; }
  for (const i of order) if (roleRows[i].parent) sub[idx[roleRows[i].parent]] += sub[i];
  const SK = table.motor.sk;
  roleRows.forEach((r, i) => {
    if (!r.parent) return;
    const K = SK * sub[i] * 9.81 * 0.15, C = 2 * 0.8 * Math.sqrt(K * sub[i] * 0.15 * 0.15);
    r.motor = { stiffness_Nm_per_rad: round(K, 3), damping_Nm_s_per_rad: round(C, 3), subtree_mass_kg: round(sub[i], 3) };
  });
  // reach: the length of the part's chain to its tip (the part's own length plus the longest chain below it). tip speed = reach x clip angular speed
  const kids = {};
  roleRows.forEach((r) => { if (r.parent) (kids[r.parent] ||= []).push(r.id); });
  const reachOf = (id) => { const r = roleRows[idx[id]]; return r.length_m + Math.max(0, ...(kids[id] || []).map(reachOf)); };
  roleRows.forEach((r) => { r.reach_m = round(reachOf(r.id), 4); r.tip_speed_per_rad_s = r.reach_m; });
  // severable units: the cut role, its parent joint, what goes with it, the gear slots on it, the mass and the cut position (the cut role's pivot)
  const severable = table.severable.units.map((u) => {
    const carried = u.carries_roles.map((id) => roleRows[idx[id]]);
    const cut = roleRows[idx[u.cut_role]];
    return { id: u.id, cut_role: u.cut_role, detaches_from: u.cut_parent, carries_roles: u.carries_roles, gear_slots: u.gear_slots,
      mass_kg: round(carried.reduce((a, r) => a + r.mass_kg, 0), 3), length_m: round(u.carries_roles.length ? Math.max(...carried.map((r) => r.reach_m)) : 0, 4), cut_pivot: cut.rest.pivot,
      joint: cut.joint, note: u.note || null };
  });
  const armLeft = roleRows[idx.armLeft], armRight = roleRows[idx.armRight], thighLeft = roleRows[idx.thighLeft], thighRight = roleRows[idx.thighRight];
  const row = {
    schema: "ragdoll-row/2",
    body: bodyId,
    generated_by: "@frankendom/physics src/generate.mjs",
    inputs: { role_table: "data/ragdoll-role-table.json", measure: opts.measureSource || null },
    height_m: m.height_m,
    total_mass_kg: round(total, 2),
    total_mass_before_clamp_kg: round(rawTotal, 2),
    body_volume_m3: round(vol, 5),
    capsule_volume_m3: round(capVol, 5),
    volume_reference_m3: round(volumeRef, 5),
    bodies: roleRows.length,
    inertia_multiplier: table.motor.inertia_multiplier,
    solver: table.solver,
    stiffness_by_state: table.stiffness_by_state,
    reach: { arm_left_m: armLeft.reach_m, arm_right_m: armRight.reach_m, leg_left_m: thighLeft.reach_m, leg_right_m: thighRight.reach_m, formula: table.part_mechanics.formula },
    severable,
    relax: relaxLog,
    roles: roleRows,
    death: table.death,
    motor_reference: table.motor.puppetmaster_reference,
    armour: { slots: table.armour_tiers.slots, tiers: table.armour_tiers.tiers, default_tier: table.armour_tiers.default_tier, rule: "dismember_threshold_modifier is a number >= 1 that multiplies the dismember threshold of the covered zones; there is no block flag (Dom 2026-10-25)" },
    materials: table.materials,
  };
  row.armour.design_check_ratio = table.armour_tiers.design_check_ratio;
  const bad = [...lintNoBlock(row.armour, "armour"), ...lintNoBlock(row.materials, "materials"), ...lintNoBlock(row.severable, "severable")];
  if (bad.length) throw new Error(bodyId + ": block-like armour/material fields (only a dismember_threshold_modifier number is allowed): " + bad.join(", "));
  return row;
}

