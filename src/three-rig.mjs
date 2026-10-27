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
export function createThreeRig(THREE, rd, bones, root, opts = {}) {
  const roles = rd.row.roles, n = roles.length;
  const pick = (map) => roles.map((r) => {
    const b = map[r.id];
    if (!b) throw new Error("no bone for part " + r.id);
    return b;
  });
  const objs = pick(bones), bindObjs = opts.bind ? pick(opts.bind.bones) : objs, bindRoot = opts.bind ? opts.bind.root : root;
  const wq = new THREE.Quaternion(), rq = new THREE.Quaternion(), tq = new THREE.Quaternion(), pq = new THREE.Quaternion(), v = new THREE.Vector3();
  const arr = (q) => [q.x, q.y, q.z, q.w];
  root.updateWorldMatrix(true, true);
  const rootQ = () => root.getWorldQuaternion(rq);
  // bind-pose orientation of every bone in the sim frame, and the offset that puts the bone's hips joint on the ragdoll's
  bindRoot.updateWorldMatrix(true, true);
  const bindRootQ = bindRoot.getWorldQuaternion(new THREE.Quaternion()).invert();
  const restQ = bindObjs.map((b) => arr(bindRootQ.clone().multiply(b.getWorldQuaternion(wq))));
  const bindHips = bindRoot.worldToLocal(bindObjs[0].getWorldPosition(v.clone()));
  const p0 = rd.readPose();
  const ragdollHips = [0, 1, 2].map((k) => roles[0].rest.pivot[k] + (p0[k] - roles[0].rest.centre[k]));
  const offset = [ragdollHips[0] - bindHips.x, ragdollHips[1] - bindHips.y, ragdollHips[2] - bindHips.z];
  const target = new Float32Array(n * 4);

  const simQuat = (b) => { root.updateWorldMatrix(true, false); return arr(rootQ().clone().invert().multiply(b.getWorldQuaternion(wq))); };

  return {
    // animated bones -> motors: root from the hips, every other part's capsule orientation as target
    drive() {
      root.updateWorldMatrix(true, true);
      let rootPos = null, rootRot = null;
      for (let i = 0; i < n; i++) {
        const bq = simQuat(objs[i]), delta = qmul(bq, qconj(restQ[i])), cq = qmul(delta, roles[i].rest.quat);
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
    },
  };
}
