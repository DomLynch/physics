// Jolt (WASM) world: deterministic fixed step, ragdolls from ragdoll-row/2 rows, native joint motors. Lifted from the OpenTrident M1 adapter
// (docs/parts-lab/physics/m1-bakeoff/adapters.mjs) and rebuilt around data rows (data/world.json): no wall clock, no Math.random, no hard-coded numbers.
import initJolt from "jolt-physics/wasm-compat";
import WORLD from "../data/world.json" with { type: "json" };
import STATES from "../data/states.json" with { type: "json" };
import { qmul, qconj, qrot, vadd, vsub, rad } from "./math.mjs";


let joltPromise = null;
const loadJolt = () => (joltPromise ||= initJolt());

// seeded generator for anything the game wants drawn from the sim (finisher rolls etc.); physics itself draws nothing
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FLOATS = 10; // per part in readPose: px py pz qx qy qz qw vx vy vz

// A role-table ragdoll row -> the body definition the engine builds: capsules at their rest pose, lifted to stand on the floor at `position`.
export function buildDefinition(row, position = [0, 0, 0]) {
  const roles = row.roles, idx = Object.fromEntries(roles.map((r, i) => [r.id, i]));
  const def = roles.map((r) => ({ id: r.id, role: r.role, parent: r.parent ? idx[r.parent] : -1, joint: r.joint, r: r.radius_m, halfH: r.half_height_m, mass: r.mass_kg }));
  let low = Infinity;
  roles.forEach((r) => { low = Math.min(low, r.rest.centre[1] - (r.half_height_m * Math.abs(r.rest.dir[1]) + r.radius_m)); });
  const shift = [position[0] - roles[0].rest.centre[0], position[1] - low + 0.012, position[2] - roles[0].rest.centre[2]];
  const spawn = roles.map((r) => ({ c: vadd(r.rest.centre, shift), q: r.rest.quat }));
  const pivot = roles.map((r) => vadd(r.rest.pivot, shift));
  const limits = def.map((b, i) => {
    if (b.parent < 0) return null;
    const j = roles[i].joint;
    if (j.type === "hinge") {
      // rest bend of the joint (parent bone direction vs own): the joint angle is measured from the spawn pose, so the table range moves by it
      const pd = roles[b.parent].rest.dir, d = roles[i].rest.dir;
      const bend = Math.acos(Math.max(-1, Math.min(1, pd[0] * d[0] + pd[1] * d[1] + pd[2] * d[2])));
      return { hingeMin: rad(j.hinge_min_deg) - bend, hingeMax: rad(j.hinge_max_deg) - bend };
    }
    return { swing: rad(j.swing_deg), twist: rad(j.twist_deg) };
  });
  const sub = def.map((b) => b.mass);
  for (let i = def.length - 1; i > 0; i--) sub[def[i].parent] += sub[i];
  return { def, spawn, pivot, limits, sub, idx };
}

export async function createWorld(opts = {}) {
  const Jolt = await loadJolt();
  const W = { ...WORLD, ...(opts.rows || {}) };
  // game data rows override the package's state rows key by key (death, stagger, knockdown): createPhysics({ states: { stagger: { targets: {...} } } })
  const S = { ...STATES };
  for (const k of Object.keys(opts.states || {})) S[k] = { ...STATES[k], ...opts.states[k] };
  const tickDt = 1 / W.tick_hz;
  const settings = new Jolt.JoltSettings();
  const objFilter = new Jolt.ObjectLayerPairFilterTable(2);
  objFilter.EnableCollision(0, 1); objFilter.EnableCollision(1, 1);
  const bp = new Jolt.BroadPhaseLayerInterfaceTable(2, 2);
  bp.MapObjectToBroadPhaseLayer(0, new Jolt.BroadPhaseLayer(0));
  bp.MapObjectToBroadPhaseLayer(1, new Jolt.BroadPhaseLayer(1));
  settings.mObjectLayerPairFilter = objFilter;
  settings.mBroadPhaseLayerInterface = bp;
  settings.mObjectVsBroadPhaseLayerFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(bp, 2, objFilter, 2);
  const jolt = new Jolt.JoltInterface(settings);
  Jolt.destroy(settings);
  const physics = jolt.GetPhysicsSystem();
  const bi = physics.GetBodyInterface();
  { const g = new Jolt.Vec3(0, W.gravity_m_s2, 0); physics.SetGravity(g); Jolt.destroy(g); }
  { const ps = physics.GetPhysicsSettings(); ps.mNumVelocitySteps = W.velocity_iterations; physics.SetPhysicsSettings(ps); }
  { // floor
    const f = W.floor, half = new Jolt.Vec3(f.half_extent_m, 0.5, f.half_extent_m);
    const shape = new Jolt.BoxShape(half, 0.05, null), pos = new Jolt.RVec3(0, -0.5, 0), rot = new Jolt.Quat(0, 0, 0, 1);
    const bcs = new Jolt.BodyCreationSettings(shape, pos, rot, Jolt.EMotionType_Static, 0);
    bcs.mFriction = f.friction;
    const b = bi.CreateBody(bcs);
    bi.AddBody(b.GetID(), Jolt.EActivation_DontActivate);
    Jolt.destroy(bcs); Jolt.destroy(half); Jolt.destroy(pos); Jolt.destroy(rot);
  }

  const ragdolls = [];
  let acc = 0, tick = 0, highRateTicks = 0, nextGroup = 1;
  const rand = mulberry32(opts.seed ?? 1);

  function makeRagdoll(row, ropts = {}) {
    const D = buildDefinition(row, ropts.position || [0, 0, 0]), roles = row.roles;
    const n = D.def.length, body = W.body, groupId = nextGroup++;
    const gf = new Jolt.GroupFilterTable(n);
    D.def.forEach((b, i) => { if (b.parent >= 0) gf.DisableCollision(i, b.parent); });
    const bodies = D.def.map((b, i) => {
      const shape = new Jolt.CapsuleShape(b.halfH, b.r), pos = new Jolt.RVec3(...D.spawn[i].c), rot = new Jolt.Quat(...D.spawn[i].q);
      const bcs = new Jolt.BodyCreationSettings(shape, pos, rot, Jolt.EMotionType_Dynamic, 1);
      bcs.mOverrideMassProperties = Jolt.EOverrideMassProperties_CalculateInertia;
      bcs.mMassPropertiesOverride.mMass = b.mass;
      bcs.mInertiaMultiplier = row.inertia_multiplier;
      bcs.mFriction = body.friction; bcs.mLinearDamping = body.linear_damping; bcs.mAngularDamping = body.angular_damping;
      bcs.mCollisionGroup.SetGroupFilter(gf); bcs.mCollisionGroup.SetGroupID(groupId); bcs.mCollisionGroup.SetSubGroupID(i);
      const bd = bi.CreateBody(bcs);
      bi.AddBody(bd.GetID(), Jolt.EActivation_Activate);
      Jolt.destroy(bcs); Jolt.destroy(pos); Jolt.destroy(rot);
      return bd;
    });
    // motors: stiffness = SK x subtree mass x g x 0.15 m arm, damping 0.8 of critical for that load (M1 finding; row.motor carries the same numbers)
    const K = D.def.map((_, i) => (i ? row.roles[i].motor.stiffness_Nm_per_rad : 0));
    const C = D.def.map((_, i) => (i ? row.roles[i].motor.damping_Nm_s_per_rad : 0));
    const cons = [];
    D.def.forEach((b, i) => {
      if (b.parent < 0) return;
      const pivot = new Jolt.RVec3(...D.pivot[i]), qc = D.spawn[i].q, lim = D.limits[i];
      const rel = qmul(qconj(D.spawn[b.parent].q), qc);
      if (b.joint.type === "hinge") {
        // hinge axis = the child's own X (the generator puts the bend-plane normal there), normal = the child's Y; both bodies agree at spawn
        const hax = new Jolt.Vec3(...qrot(qc, [1, 0, 0])), nor = new Jolt.Vec3(...qrot(qc, [0, 1, 0]));
        const s = new Jolt.HingeConstraintSettings();
        s.mSpace = Jolt.EConstraintSpace_WorldSpace;
        s.mPoint1 = pivot; s.mPoint2 = pivot;
        s.mHingeAxis1 = hax; s.mHingeAxis2 = hax; s.mNormalAxis1 = nor; s.mNormalAxis2 = nor;
        s.mLimitsMin = lim.hingeMin; s.mLimitsMax = lim.hingeMax;
        const c = Jolt.castObject(s.Create(bodies[b.parent], bodies[i]), Jolt.HingeConstraint);
        physics.AddConstraint(c);
        c.SetMotorState(Jolt.EMotorState_Position);
        c.SetTargetAngle(0);
        cons.push({ kind: "hinge", c, i, rel });
        Jolt.destroy(s); Jolt.destroy(hax); Jolt.destroy(nor);
      } else {
        const axis = new Jolt.Vec3(...qrot(qc, [0, 1, 0])), plane = new Jolt.Vec3(...qrot(qc, [1, 0, 0]));
        const s = new Jolt.SwingTwistConstraintSettings();
        s.mSpace = Jolt.EConstraintSpace_WorldSpace;
        s.mPosition1 = pivot; s.mPosition2 = pivot;
        s.mTwistAxis1 = axis; s.mTwistAxis2 = axis; s.mPlaneAxis1 = plane; s.mPlaneAxis2 = plane;
        s.mNormalHalfConeAngle = lim.swing; s.mPlaneHalfConeAngle = lim.swing;
        s.mTwistMinAngle = -lim.twist; s.mTwistMaxAngle = lim.twist;
        const c = Jolt.castObject(s.Create(bodies[b.parent], bodies[i]), Jolt.SwingTwistConstraint);
        physics.AddConstraint(c);
        c.SetSwingMotorState(Jolt.EMotorState_Position); c.SetTwistMotorState(Jolt.EMotorState_Position);
        const q = new Jolt.Quat(...rel); c.SetTargetOrientationBS(q); Jolt.destroy(q); // child's orientation relative to the parent (M1 finding)
        cons.push({ kind: "ball", c, i, rel });
        Jolt.destroy(s); Jolt.destroy(axis); Jolt.destroy(plane);
      }
      Jolt.destroy(pivot);
    });

    const strength = new Float64Array(n).fill(NaN); // last value written per joint, so unchanged motors cost nothing
    const base = new Float64Array(n).fill(1);       // what the game asked for with setMotorStrength
    const want = new Float64Array(n).fill(1);       // base after the state runner (death, stagger, knockdown)
    const motor = W.motor;
    let dampScale = ropts.motorDamping ?? 1; // multiplier on the joint damping (less damping = less lag behind a fast clip, more wobble)
    let gain = ropts.motorGain ?? 1; // tracking gain: scales every joint's stiffness (damping by sqrt) so the motors follow fast clips closer
    let state = "alive", st = null, frozen = false, calm = 0, lastRoot = null, targetQ = null;
    const lerp = (a, b, u) => a + (b - a) * u;
    const shape = (t, g) => (t < g.ease_in_s ? t / g.ease_in_s : t < g.ease_in_s + g.hold_s ? 1 : Math.max(0, 1 - (t - g.ease_in_s - g.hold_s) / g.up_s));
    // advance the state runner one tick, then derive the motor strength of every joint (ticks, not clocks: replays reproduce it)
    const runState = () => {
      if (state === "frozen") return;
      if (state === "alive") { for (let i = 1; i < n; i++) want[i] = base[i]; return; }
      st.t += tickDt;
      if (state === "dying") {
        const u = Math.min(1, st.t / S.death.ramp.seconds);
        for (let i = 1; i < n; i++) want[i] = lerp(st.from[i], S.death.ramp.to, u);
        if (u >= 1) {
          let sq = 0;
          for (const b of bodies) { const v = b.GetLinearVelocity(); sq = Math.max(sq, v.GetX() ** 2 + v.GetY() ** 2 + v.GetZ() ** 2); }
          calm = sq < S.death.freeze_speed_sq ? calm + 1 : 0;
          if (calm >= S.death.freeze_ticks_below) { for (const b of bodies) bi.DeactivateBody(b.GetID()); frozen = true; state = "frozen"; }
        }
      } else if (state === "stagger") {
        const g = S.stagger, k = shape(st.t, g);
        for (let i = 1; i < n; i++) want[i] = Math.min(base[i], 1 - (1 - (g.targets[D.def[i].role] ?? 1)) * k);
        if (st.t >= g.ease_in_s + g.hold_s + g.up_s) state = "alive";
      } else if (state === "knockdown") {
        const g = S.knockdown, down = st.fall_s + g.down_s, s = Math.min(1, g.fall_strength + Math.max(0, st.t - down) * g.recover_per_s);
        for (let i = 1; i < n; i++) want[i] = Math.min(base[i], s);
        if (s >= 1) state = "alive";
      }
    };
    const applyMotors = () => {
      runState();
      for (const k of cons) {
        const s = want[k.i];
        if (s === strength[k.i]) continue;
        strength[k.i] = s;
        const limp = s <= motor.limp_strength_at_or_below;
        const stiff = K[k.i] * gain * s, damp = limp ? C[k.i] * motor.limp_damper_scale * motor.limp_damper_multiplier : C[k.i] * dampScale * Math.sqrt(gain) * Math.sqrt(s);
        const sets = k.kind === "hinge" ? [k.c.GetMotorSettings()] : [k.c.GetSwingMotorSettings(), k.c.GetTwistMotorSettings()];
        for (const m of sets) { const sp = m.mSpringSettings; sp.mMode = Jolt.ESpringMode_StiffnessAndDamping; sp.mStiffness = stiff; sp.mDamping = damp; }
      }
    };

    const kinematic = ropts.rootKinematic !== false;
    if (kinematic) bi.SetMotionType(bodies[0].GetID(), Jolt.EMotionType_Kinematic, Jolt.EActivation_Activate);
    let rootMove = null;
    const cut = new Set();
    const buf = new Float32Array(n * FLOATS);
    const api = {
      id: ropts.id ?? `rd${groupId}`,
      row,
      partIds: D.def.map((b) => b.id),
      get cuts() { return [...cut]; },
      // rows: a number (all joints) or { all, <role>: s, <partId>: s }; later keys win (all < role < partId). 1 = full, 0.01 = limp.
      setMotorStrength(rows) {
        if (typeof rows === "number") rows = { all: rows };
        for (let i = 1; i < n; i++) {
          let s = base[i];
          if (rows.all !== undefined) s = rows.all;
          if (rows[D.def[i].role] !== undefined) s = rows[D.def[i].role];
          if (rows[D.def[i].id] !== undefined) s = rows[D.def[i].id];
          base[i] = Math.min(1, Math.max(0, s));
        }
      },
      get state() { return state; },
      // pose the motors drive towards: world orientation of every part's capsule, 4 floats (x y z w) per part in partIds order (the game's animated pose,
      // retargeted onto the capsules by role). The hips' own orientation goes through setRoot. Ball joints take the child's orientation relative to the
      // parent; hinges the rotation about their axis relative to the spawn pose.
      // tracking gain 1 = the M1 value (SK 40); higher follows fast clips closer (needs the x8 inertia; test before raising above about 4)
      setMotorGain(g, damping = dampScale) { gain = g; dampScale = damping; strength.fill(NaN); },
      // put every capsule on the last setTargetPose / setRoot pose now (no motor lag, velocities zeroed): hides the lag at the moment of death
      snapToTarget() {
        if (!targetQ || !lastRoot) return false;
        const at = (i) => [targetQ[i * 4], targetQ[i * 4 + 1], targetQ[i * 4 + 2], targetQ[i * 4 + 3]];
        const delta = D.def.map((_, i) => qmul(at(i), qconj(roles[i].rest.quat)));
        const pivot = new Array(n), centre = new Array(n);
        centre[0] = lastRoot[0];
        pivot[0] = vsub(centre[0], qrot(delta[0], vsub(D.spawn[0].c, D.pivot[0])));
        for (let i = 1; i < n; i++) {
          const p = D.def[i].parent;
          pivot[i] = vadd(pivot[p], qrot(delta[p], vsub(D.pivot[i], D.pivot[p])));
          centre[i] = vadd(pivot[i], qrot(delta[i], vsub(D.spawn[i].c, D.pivot[i])));
        }
        const zero = new Jolt.Vec3(0, 0, 0);
        for (let i = 0; i < n; i++) {
          const pp = new Jolt.RVec3(...centre[i]), qq = new Jolt.Quat(...at(i));
          bi.SetPositionAndRotation(bodies[i].GetID(), pp, qq, Jolt.EActivation_Activate);
          bi.SetLinearVelocity(bodies[i].GetID(), zero); bi.SetAngularVelocity(bodies[i].GetID(), zero);
          Jolt.destroy(pp); Jolt.destroy(qq);
        }
        Jolt.destroy(zero);
        return true;
      },
      // back to the spawn pose, alive, full strength. Only before any cut (a cut removes joints): returns false then, destroy and recreate instead.
      reset() {
        if (cut.size) return false;
        const zero = new Jolt.Vec3(0, 0, 0);
        for (let i = 0; i < n; i++) {
          const pp = new Jolt.RVec3(...D.spawn[i].c), qq = new Jolt.Quat(...D.spawn[i].q);
          bi.SetPositionAndRotation(bodies[i].GetID(), pp, qq, Jolt.EActivation_Activate);
          bi.SetLinearVelocity(bodies[i].GetID(), zero); bi.SetAngularVelocity(bodies[i].GetID(), zero);
          Jolt.destroy(pp); Jolt.destroy(qq);
        }
        Jolt.destroy(zero);
        const kin = ropts.rootKinematic !== false;
        bi.SetMotionType(bodies[0].GetID(), kin ? Jolt.EMotionType_Kinematic : Jolt.EMotionType_Dynamic, Jolt.EActivation_Activate);
        state = "alive"; st = null; frozen = false; calm = 0; targetQ = null; lastRoot = null;
        base.fill(1); want.fill(1); strength.fill(NaN);
        return true;
      },
      setTargetPose(q) {
        targetQ = Float32Array.from(q);
        const at =(i) => [q[i * 4], q[i * 4 + 1], q[i * 4 + 2], q[i * 4 + 3]];
        for (const k of cons) {
          const rel = qmul(qconj(at(D.def[k.i].parent)), at(k.i));
          if (k.kind === "hinge") { const d = qmul(qconj(k.rel), rel); k.c.SetTargetAngle(2 * Math.atan2(d[0], d[3])); }
          else { const t = new Jolt.Quat(...rel); k.c.SetTargetOrientationBS(t); Jolt.destroy(t); }
        }
      },
      // M3 death: motor strength ramps to 0.01 over 1 s with the limp damper, limits and self-collision stay on, the hit impulse lands this same tick,
      // the ragdoll freezes (sleeps) once every body is under the freeze speed. hit = { part, impulse: [x,y,z] } (optional). Hips are released.
      kill(hit) {
        if (state === "dying" || state === "frozen") return;
        state = "dying"; st = { t: 0, from: Float64Array.from(want) };
        calm = 0;
        api.release();
        if (hit) api.applyImpulse(hit.part, hit.impulse);
      },
      // M3 stagger: brief motor dip on the living body (arm 0.9 / torso 0.6 / hand 0.12, hold 0.5 s, back over 0.35 s). Ignored while dying or knocked down.
      stagger(hit) {
        if (state !== "alive" && state !== "stagger") return;
        state = "stagger"; st = { t: 0 };
        if (hit) api.applyImpulse(hit.part, hit.impulse);
      },
      // M3 knockdown (TABG start values): kind "damage" or "push" picks the fall time; hips are released, strength falls to fall_strength, stays down, then recovers
      // at recover_per_s. The game re-pins the root (setRoot) when state returns to "alive".
      knockdown(kind = "damage", hit) {
        if (state !== "alive" && state !== "stagger") return;
        const g = S.knockdown;
        state = "knockdown"; st = { t: 0, fall_s: (kind === "push" ? g.push_over : g.damage_over).fall_s };
        api.release();
        if (hit) api.applyImpulse(hit.part, hit.impulse);
      },
      // the hips follow the game's pose while kinematic; applied at the next step
      setRoot(position, quaternion) { rootMove = [position, quaternion]; lastRoot = [position, quaternion]; },
      release() { bi.SetMotionType(bodies[0].GetID(), Jolt.EMotionType_Dynamic, Jolt.EActivation_Activate); },
      applyImpulse(part, v) {
        const i = D.idx[part];
        if (i === undefined) throw new Error("unknown part " + part);
        if (frozen) { for (const b of bodies) bi.ActivateBody(b.GetID()); frozen = false; if (state === "frozen") { state = "dying"; st = { t: S.death.ramp.seconds, from: Float64Array.from(want) }; calm = 0; } }
        const iv = new Jolt.Vec3(v[0], v[1], v[2]);
        bi.AddImpulse(bodies[i].GetID(), iv);
        Jolt.destroy(iv);
      },
      // detach a severable unit (head, arm_left, arm_right, leg_left, leg_right, torso_waist): removes the joint of its cut role; the part and what hangs below it fall free
      cut(unit) {
        const u = row.severable.find((s) => s.id === unit);
        if (!u) throw new Error("unknown severable unit " + unit);
        const k = cons.findIndex((c) => c.i === D.idx[u.cut_role]);
        if (k < 0) return null;
        physics.RemoveConstraint(cons[k].c);
        cons.splice(k, 1);
        cut.add(unit);
        highRateTicks = W.cut_high_rate_ticks;
        return { unit, mass_kg: u.mass_kg, carries_roles: u.carries_roles, gear_slots: u.gear_slots };
      },
      // 10 floats per part (px py pz qx qy qz qw vx vy vz), in partIds order. The same Float32Array is reused: copy it if you keep it.
      readPose() {
        for (let i = 0; i < n; i++) {
          const b = bodies[i], p = b.GetPosition(), r = b.GetRotation(), v = b.GetLinearVelocity(), o = i * FLOATS;
          buf[o] = p.GetX(); buf[o + 1] = p.GetY(); buf[o + 2] = p.GetZ();
          buf[o + 3] = r.GetX(); buf[o + 4] = r.GetY(); buf[o + 5] = r.GetZ(); buf[o + 6] = r.GetW();
          buf[o + 7] = v.GetX(); buf[o + 8] = v.GetY(); buf[o + 9] = v.GetZ();
        }
        return buf;
      },
      _pre() {
        applyMotors();
        if (rootMove) {
          const p = new Jolt.RVec3(...rootMove[0]), q = new Jolt.Quat(...rootMove[1]);
          bi.MoveKinematic(bodies[0].GetID(), p, q, tickDt);
          Jolt.destroy(p); Jolt.destroy(q); rootMove = null;
        }
      },
      destroy() {
        for (const k of cons) physics.RemoveConstraint(k.c);
        for (const b of bodies) { bi.RemoveBody(b.GetID()); bi.DestroyBody(b.GetID()); }
        ragdolls.splice(ragdolls.indexOf(api), 1);
      },
    };
    api.setMotorStrength(ropts.motorStrength ?? 1);
    ragdolls.push(api);
    return api;
  }

  const world = {
    tickDt,
    get tick() { return tick; },
    rand,
    // body measure row (a measure row, or an already generated ragdoll-row/2) -> ragdoll. opts: { position, id, rootKinematic (default true), motorStrength (default 1) }
    createRagdoll(input, ropts) { return makeRagdoll(input, ropts); },
    // advance the sim by dt seconds in whole fixed ticks (60 Hz); the remainder is carried. Never reads a clock.
    step(dt = tickDt) {
      acc += dt;
      let ticks = Math.floor(acc / tickDt + 1e-9);
      if (ticks > W.max_dt_ticks_per_step) { ticks = W.max_dt_ticks_per_step; acc = 0; } else acc -= ticks * tickDt;
      for (let t = 0; t < ticks; t++) {
        for (const r of ragdolls) r._pre();
        jolt.Step(tickDt, highRateTicks > 0 ? W.collision_substeps.cut_or_thrown : W.collision_substeps.standing);
        if (highRateTicks > 0) highRateTicks--;
        tick++;
      }
      return ticks;
    },
    // FNV-1a over the pose floats of every ragdoll, in creation order: the determinism test compares this per tick
    hash() {
      let h = 0x811c9dc5;
      const u = new Uint32Array(1), f = new Float32Array(u.buffer);
      for (const r of ragdolls) {
        const p = r.readPose();
        for (let i = 0; i < p.length; i++) { f[0] = p[i] === 0 ? 0 : p[i]; h = Math.imul(h ^ u[0], 0x01000193) >>> 0; }
      }
      return h.toString(16).padStart(8, "0");
    },
    destroy() { for (const r of [...ragdolls]) r.destroy(); Jolt.destroy(jolt); },
  };
  return world;
}
