// Ground for the world (data/ground-rows.json): a tilted plane from a row (angle + downhill direction) or a sampled height function the game passes in.
// createPhysics({ ground: "slope15" | { angle_deg, downhill, ... } | { groundHeight: (x, z) => y, ... } }). No `ground` option = the flat floor in engine.mjs, untouched.
// No numbers live here: extents, friction, thickness, cell size, limits are all rows.
import GROUND from "../data/ground-rows.json" with { type: "json" };

// the package's ground rows (data/ground-rows.json)
export const loadGroundRows = () => GROUND;

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const FD = 0.01; // central-difference step for the height function's slope (metres): a probe, not a tuning number

// problems with a ground option as strings ([] = valid)
export function validateGround(opt, rows = GROUND) {
  const errs = [];
  if (typeof opt === "string") { if (!rows.rows[opt]) errs.push(`unknown ground row ${opt} (have: ${Object.keys(rows.rows).join(", ")})`); return errs; }
  if (!opt || typeof opt !== "object") return ["ground must be a row name or an object"];
  if (opt.groundHeight !== undefined) {
    if (typeof opt.groundHeight !== "function") errs.push("groundHeight must be a function (x, z) => y");
    for (const k of ["half_extent_m", "cell_m"]) if (opt[k] !== undefined && !(isNum(opt[k]) && opt[k] > 0)) errs.push(`${k} must be a positive number`);
  } else {
    if (!isNum(opt.angle_deg) || opt.angle_deg < 0 || opt.angle_deg > rows.plane.max_angle_deg) errs.push(`angle_deg must be a number in [0, ${rows.plane.max_angle_deg}]`);
    const d = opt.downhill;
    if (!Array.isArray(d) || d.length !== 2 || !d.every(isNum) || Math.hypot(d[0], d[1]) === 0) errs.push("downhill must be [x, z], not zero");
    if (!(isNum(opt.half_extent_m) && opt.half_extent_m > 0)) errs.push("half_extent_m must be a positive number");
  }
  if (opt.friction !== undefined && !(isNum(opt.friction) && opt.friction >= 0)) errs.push("friction must be >= 0");
  return errs;
}

// ground option -> { kind, friction, height(x, z), normal(x, z), create(Jolt, bi) }; create() adds the static body and returns it. Throws on a bad option.
export function resolveGround(opt, rows = GROUND) {
  const errs = validateGround(opt, rows);
  if (errs.length) throw new Error("ground: " + errs.join("; "));
  if (typeof opt === "string") opt = rows.rows[opt];
  const friction = opt.friction ?? rows.heightfield.friction;
  if (opt.groundHeight === undefined) return plane(opt, rows);
  const h = rows.heightfield, fn = opt.groundHeight;
  const half = opt.half_extent_m ?? h.half_extent_m, cell = opt.cell_m ?? h.cell_m, center = opt.center ?? h.center;
  const block = opt.block_size ?? h.block_size, bits = opt.bits_per_sample ?? h.bits_per_sample;
  // sample count: the 2*half span in cells plus one, rounded up to a multiple of the block size (Jolt's rule)
  let N = Math.round((2 * half) / cell) + 1;
  N = Math.ceil(N / block) * block;
  const ox = center[0] - ((N - 1) * cell) / 2, oz = center[1] - ((N - 1) * cell) / 2;
  const height = (x, z) => fn(x, z);
  return {
    kind: "heightfield", friction, height, normal: normalOf(height), samples: N, cell_m: cell,
    create(Jolt, bi) {
      const s = new Jolt.HeightFieldShapeSettings();
      const off = new Jolt.Vec3(ox, 0, oz), scl = new Jolt.Vec3(cell, 1, cell);
      s.mOffset = off; s.mScale = scl; s.mSampleCount = N; s.mBlockSize = block; s.mBitsPerSample = bits;
      s.mHeightSamples.resize(0);
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        const y = fn(ox + c * cell, oz + r * cell);
        if (!isNum(y)) throw new Error(`ground: groundHeight(${ox + c * cell}, ${oz + r * cell}) is not a number`);
        s.mHeightSamples.push_back(y);
      }
      const res = s.Create();
      if (res.HasError()) { const e = res.GetError().c_str(); Jolt.destroy(s); Jolt.destroy(off); Jolt.destroy(scl); throw new Error("ground: Jolt heightfield: " + e); }
      const shape = res.Get(), pos = new Jolt.RVec3(0, 0, 0), rot = new Jolt.Quat(0, 0, 0, 1);
      const bcs = new Jolt.BodyCreationSettings(shape, pos, rot, Jolt.EMotionType_Static, 0);
      bcs.mFriction = friction;
      const b = bi.CreateBody(bcs);
      bi.AddBody(b.GetID(), Jolt.EActivation_DontActivate);
      Jolt.destroy(bcs); Jolt.destroy(pos); Jolt.destroy(rot); Jolt.destroy(s); Jolt.destroy(off); Jolt.destroy(scl);
      return b;
    },
  };
}

// the flat floor as a ground (world.json): the default when no `ground` option is given
export const FLAT = { height: () => 0, normal: () => [0, 1, 0] };

// highest surface y within r of (x, z): the centre and probe.ring_samples points on the circle of radius r
export function heightMax(g, x, z, r, rows = GROUND) {
  let m = g.height(x, z);
  if (r > 0) for (let i = 0; i < rows.probe.ring_samples; i++) { const t = (2 * Math.PI * i) / rows.probe.ring_samples; m = Math.max(m, g.height(x + r * Math.cos(t), z + r * Math.sin(t))); }
  return m;
}

// unit surface normal of a height function at (x, z)
function normalOf(height) {
  return (x, z) => {
    const gx = (height(x + FD, z) - height(x - FD, z)) / (2 * FD), gz = (height(x, z + FD) - height(x, z - FD)) / (2 * FD), l = Math.hypot(gx, 1, gz);
    return [-gx / l, 1 / l, -gz / l];
  };
}

function plane(row, rows) {
  const a = (row.angle_deg * Math.PI) / 180, dl = Math.hypot(row.downhill[0], row.downhill[1]), dx = row.downhill[0] / dl, dz = row.downhill[1] / dl;
  const o = row.origin || [0, 0, 0], t = Math.tan(a), th = rows.plane.thickness_half_m;
  // surface height: y0 - tan(a) * distance downhill from the origin; normal = up tipped toward the downhill side
  const height = (x, z) => o[1] - t * ((x - o[0]) * dx + (z - o[2]) * dz);
  const n = [Math.sin(a) * dx, Math.cos(a), Math.sin(a) * dz];
  return {
    kind: "plane", friction: row.friction, angle_deg: row.angle_deg, height, normal: () => n.slice(),
    create(Jolt, bi) {
      // box rotated by `a` about the horizontal axis y x downhill; its top face passes through the origin point
      const k = [dz, 0, -dx], s = Math.sin(a / 2), c = Math.cos(a / 2);
      const half = new Jolt.Vec3(row.half_extent_m, th, row.half_extent_m);
      const shape = new Jolt.BoxShape(half, rows.plane.convex_radius_m, null);
      const pos = new Jolt.RVec3(o[0] - n[0] * th, o[1] - n[1] * th, o[2] - n[2] * th), rot = new Jolt.Quat(k[0] * s, k[1] * s, k[2] * s, c);
      const bcs = new Jolt.BodyCreationSettings(shape, pos, rot, Jolt.EMotionType_Static, 0);
      bcs.mFriction = row.friction;
      const b = bi.CreateBody(bcs);
      bi.AddBody(b.GetID(), Jolt.EActivation_DontActivate);
      Jolt.destroy(bcs); Jolt.destroy(half); Jolt.destroy(pos); Jolt.destroy(rot);
      return b;
    },
  };
}
