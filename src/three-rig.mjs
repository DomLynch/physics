// three.js glue: pose <-> bones. Pass the `THREE` namespace in (the package does not depend on three).
//   const rig = createThreeRig(THREE, rd, { hips: Object3D, spine: ..., head: ..., armLeft: ... }, fighterGroup);
//   - `bones`: part id (rd.partIds: hips, spine, spine1, spine2, neck, head, armLeft, forearmLeft, handLeft, armRight, ..., toeRight) -> the Object3D of that bone.
//     Your role map (e.g. hips -> pelvis) lives on your side; the package never sees bone names.
//   - `root`: the Object3D whose local frame is the sim frame (the fighter's group, with its world position and yaw). The ragdoll sim lives in that frame.
//   - Create the rig while the model is in its BIND pose (that is the pose the body measure row was taken from), before the first physics step.
//   Alive: each frame call rig.drive() after the animation has posed the bones: it sends the hips (setRoot) and the animated pose (setTargetPose) to the motors.
//   Dying / dead: after physics.step(), call rig.applyPose(): the bones follow the capsules (the animation no longer drives them).
import { qmul, qconj, qrot } from "./math.mjs";

// opts.bind = { bones, root }: the same part-id map and frame from an UNTOUCHED copy of the model (e.g. the loaded glTF scene before the animation mixer
// touched it), when your live rig is already animated at the time you build the rig. Default: read the bind pose from `bones` and `root` themselves.
// opts.virtual = [partId, ...]: parts with NO bone (a chain body's `drives: null` parts, e.g. centipede segments). They are simulated but drive() sends them the nearest
//   driven ancestor's orientation change and applyPose() leaves them alone. Default none: a part without a bone throws, as before. The root part cannot be virtual.
// opts.follow = { partId: [Object3D, ...] }: extra bones that copy a driven part's rotation (chainFollowObjects shape). At the end of applyPose() each follower's local
//   quaternion is set to its driver bone's local quaternion (driver parts in role order, followers in list order), then the world matrices are refreshed.
//   A driver must be a driven (non-virtual) part. src/chain.mjs chainRigOptions(body, find) builds bones + opts for a chain body in one call.
export function createThreeRig(THREE, rd, bones, root, opts = {}) {
  const roles = rd.row.roles, n = roles.length, ids = new Set(roles.map((r) => r.id));
  const virtual = new Set(opts.virtual || []);
  for (const id of virtual) if (!ids.has(id)) throw new Error("unknown virtual part " + id);
  if (virtual.has(roles[0].id)) throw new Error("root part " + roles[0].id + " cannot be virtual");
  const follow = Object.entries(opts.follow || {});
  for (const [part, list] of follow) {
    if (!ids.has(part)) throw new Error("unknown follow driver " + part);
    if (virtual.has(part)) throw new Error("follow driver " + part + " is virtual (it has no bone to copy)");
    if (!Array.isArray(list)) throw new Error("follow." + part + " must be an array of Object3D");
    if (!list.every((o) => o && typeof o.updateMatrixWorld === "function" && o.quaternion)) throw new Error("follower of " + part + " is not an Object3D");
  }
  const pick = (map) => roles.map((r) => {
    if (virtual.has(r.id)) return null;
    const b = map[r.id];
    if (!b) throw new Error("no bone for part " + r.id);
    return b;
  });
  const parentIdx = roles.map((r) => (r.parent ? roles.findIndex((x) => x.id === r.parent) : -1));
  const followers = roles.map((r, i) => (follow.find(([part]) => part === r.id) || [null, []])[1].map((o) => [o, i])).flat();
  const objs = pick(bones), bindObjs = opts.bind ? pick(opts.bind.bones) : objs, bindRoot = opts.bind ? opts.bind.root : root;
  const wq = new THREE.Quaternion(), rq = new THREE.Quaternion(), tq = new THREE.Quaternion(), pq = new THREE.Quaternion(), v = new THREE.Vector3();
  const arr = (q) => [q.x, q.y, q.z, q.w];
  root.updateWorldMatrix(true, true);
  const rootQ = () => root.getWorldQuaternion(rq);
  // bind-pose orientation of every bone in the sim frame, and the offset that puts the bone's hips joint on the ragdoll's
  bindRoot.updateWorldMatrix(true, true);
  const bindRootQ = bindRoot.getWorldQuaternion(new THREE.Quaternion()).invert();
  const restQ = bindObjs.map((b) => !b ? null : arr(bindRootQ.clone().multiply(b.getWorldQuaternion(wq))));
  const bindHips = bindRoot.worldToLocal(bindObjs[0].getWorldPosition(v.clone()));
  const p0 = rd.readPose();
  const ragdollHips = [0, 1, 2].map((k) => roles[0].rest.pivot[k] + (p0[k] - roles[0].rest.centre[k]));
  const offset = [ragdollHips[0] - bindHips.x, ragdollHips[1] - bindHips.y, ragdollHips[2] - bindHips.z];
  const target = new Float32Array(n * 4), deltas = new Array(n);

  const simQuat = (b) => { root.updateWorldMatrix(true, false); return arr(rootQ().clone().invert().multiply(b.getWorldQuaternion(wq))); };

  return {
    // animated bones -> motors: root from the hips, every other part's capsule orientation as target
    drive() {
      root.updateWorldMatrix(true, true);
      let rootPos = null, rootRot = null;
      for (let i = 0; i < n; i++) {
        // a virtual part (no bone) takes its parent's orientation change (parent-first order: the parent's delta is already in `deltas`)
        const delta = objs[i] ? qmul(simQuat(objs[i]), qconj(restQ[i])) : deltas[parentIdx[i]], cq = qmul(delta, roles[i].rest.quat);
        deltas[i] = delta;
        target.set(cq, i * 4);
        if (i === 0) {
          const bp = root.worldToLocal(objs[0].getWorldPosition(v));
          const pivot = [bp.x + offset[0], bp.y + offset[1], bp.z + offset[2]];
          const c = qrot(delta, [0, 1, 2].map((k) => roles[0].rest.centre[k] - roles[0].rest.pivot[k]));
          rootPos = [pivot[0] + c[0], pivot[1] + c[1], pivot[2] + c[2]];
          rootRot = cq;
        }
      }
      rd.setRoot(rootPos, rootRot);
      rd.setTargetPose(target);
    },
    // capsules -> bones (parents first; roles are in parent-first order)
    applyPose() {
      const p = rd.readPose();
      const cutRoles = new Set(rd.cuts.map((u) => rd.row.severable.find((s) => s.id === u).cut_role).filter(Boolean)); // visual-only units have no cut role
      for (let i = 0; i < n; i++) {
        if (!objs[i]) continue; // virtual part: simulated, no bone to move
        const o = i * 10, delta = qmul([p[o + 3], p[o + 4], p[o + 5], p[o + 6]], qconj(roles[i].rest.quat)), bw = qmul(delta, restQ[i]);
        const b = objs[i];
        b.parent.updateWorldMatrix(true, false);
        b.parent.getWorldQuaternion(pq);
        tq.set(bw[0], bw[1], bw[2], bw[3]).premultiply(rootQ()).premultiply(pq.invert());
        b.quaternion.copy(tq);
        // the hips, and every bone whose joint was cut: the bone goes to its capsule's joint (a severed piece leaves its parent, so the parent-relative offset no longer holds)
        if (i === 0 || cutRoles.has(roles[i].id)) {
          const c = qrot(delta, [0, 1, 2].map((k) => roles[i].rest.pivot[k] - roles[i].rest.centre[k]));
          v.set(p[o] + c[0] - offset[0], p[o + 1] + c[1] - offset[1], p[o + 2] + c[2] - offset[2]);
          root.localToWorld(v);
          b.position.copy(b.parent.worldToLocal(v));
        }
        b.updateMatrixWorld(true);
      }
      // follower bones copy their driver bone's local rotation (after every driver is posed)
      for (const [f, i] of followers) { f.quaternion.copy(objs[i].quaternion); f.updateMatrixWorld(true); }
    },
  };
}
