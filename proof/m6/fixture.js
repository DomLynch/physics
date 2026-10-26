// A stand-in for <body>.cut.glb until the real one exists: the same scene shape the contract promises (docs/CUT-CONTRACT.md), built in code from the body measure row.
// One skeleton (the 20 role bones, node names from the rig map), seven skinned `piece_*` meshes (capsules per role, rigidly skinned to their bone, hands in the arm
// piece, feet in the leg piece), twelve skinned `cap_*` discs (one pair per cut boundary, `cap_flesh` material), and the manifest. Geometry is in the sim frame at rest.
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export function buildFixture(THREE, body, rigJoints, rd) {
  const roles = rd.row.roles, byId = Object.fromEntries(roles.map((r) => [r.id, r]));
  const group = new THREE.Group();
  group.name = "cut-fixture";
  // skeleton: identity rotations, positions from the pivots (as in test/three-rig.test.mjs)
  const bones = {}, boneList = [], boneIndex = {};
  roles.forEach((r, i) => {
    const b = new THREE.Bone();
    b.name = rigJoints[r.bone_start];
    const pp = r.parent ? byId[r.parent].rest.pivot : [0, 0, 0];
    b.position.set(r.rest.pivot[0] - pp[0], r.rest.pivot[1] - pp[1], r.rest.pivot[2] - pp[2]);
    (r.parent ? bones[r.parent] : group).add(b);
    bones[r.id] = b; boneList.push(b); boneIndex[r.id] = i;
  });
  group.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(boneList);

  const skinned = (geo, roleId) => {
    const n = geo.attributes.position.count, si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) { si[k * 4] = boneIndex[roleId]; sw[k * 4] = 1; }
    geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw, 4));
    return geo;
  };
  const place = (geo, pos, quat) => { geo.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion(...quat), new THREE.Vector3(1, 1, 1))); return geo; };

  const region = (r) => (r.role === "hips" ? "root" : ["spine", "spine1", "spine2", "neck"].includes(r.role) ? "upper_torso" : r.role === "head" ? "head"
    : ["arm", "forearm", "hand"].includes(r.role) ? "arm_" + r.side.toLowerCase() : "leg_" + r.side.toLowerCase());
  const tone = { root: 0x6f5a45, upper_torso: 0x7d6650, head: 0x8a7058, arm_left: 0x76604b, arm_right: 0x76604b, leg_left: 0x6a553f, leg_right: 0x6a553f };
  const geos = {};
  for (const r of roles) {
    const g = skinned(place(new THREE.CapsuleGeometry(r.radius_m, 2 * r.half_height_m, 6, 14), r.rest.centre, r.rest.quat), r.id);
    (geos[region(r)] ||= []).push(g);
  }
  // two horns on the head bone: gear and horns follow the bone with no extra code
  const head = byId.head;
  for (const s of [-1, 1]) {
    const h = new THREE.ConeGeometry(head.radius_m * 0.28, head.radius_m * 1.6, 10), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -s * 0.7));
    geos.head.push(skinned(place(h, [head.rest.centre[0] + s * head.radius_m * 0.9, head.rest.centre[1] + head.radius_m * 0.8, head.rest.centre[2]], [q.x, q.y, q.z, q.w]), "head"));
  }

  const meshes = [], regions = [], caps = [];
  const add = (name, geo, mat) => {
    const m = new THREE.SkinnedMesh(geo, mat);
    m.name = name; m.castShadow = true; m.frustumCulled = false;
    group.add(m); m.bind(skeleton, new THREE.Matrix4()); meshes.push(m);
  };
  const detached = { root: null, upper_torso: "torso_waist", head: "head", arm_left: "arm_left", arm_right: "arm_right", leg_left: "leg_left", leg_right: "leg_right" };
  for (const id of Object.keys(detached)) {
    add("piece_" + id, mergeGeometries(geos[id]), new THREE.MeshStandardMaterial({ color: tone[id], roughness: 0.85, name: "body_" + id }));
    regions.push({ id, mesh: "piece_" + id, detached_by: detached[id] });
  }

  // caps: a disc on each side of each plane, facing out of its piece, bound to the bone on its own side
  const flesh = new THREE.MeshStandardMaterial({ color: 0xa8372e, roughness: 0.5, name: "cap_flesh" });
  const sub = (a, b) => new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const planes = {};
  const boundary = (plane, unit, point, n, radius, a, b) => {
    // a = [cap id, region, bone role] on the far side (faces -n), b = on the near/root side (faces +n)
    planes[plane] = { point, normal: [n.x, n.y, n.z], source: "fixture: from the measure row's role pivots" };
    for (const [[id, reg, boneRole], dir] of [[a, n.clone().negate()], [b, n.clone()]]) {
      const geo = new THREE.CircleGeometry(radius, 24);
      geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir));
      geo.translate(point[0] + dir.x * 0.003, point[1] + dir.y * 0.003, point[2] + dir.z * 0.003);
      add(id, skinned(geo, boneRole), flesh);
      caps.push({ id, mesh: id, region: reg, shown_when_cut: unit });
    }
  };
  const neck = byId.neck.rest.pivot, headP = head.rest.pivot;
  boundary("neck", "head", neck.map((x, k) => (x + headP[k]) / 2), sub(neck, headP).normalize(), byId.neck.radius_m * 1.05,
    ["cap_neck_head", "head", "head"], ["cap_neck_torso", "upper_torso", "neck"]);
  for (const S of ["Left", "Right"]) {
    const s = S.toLowerCase(), arm = byId["arm" + S], fore = byId["forearm" + S], thigh = byId["thigh" + S], shin = byId["shin" + S];
    boundary("shoulder_" + s, "arm_" + s, arm.rest.pivot, sub(arm.rest.pivot, fore.rest.pivot).normalize(), arm.radius_m * 1.1,
      ["cap_shoulder_" + s + "_arm", "arm_" + s, "arm" + S], ["cap_shoulder_" + s + "_torso", "upper_torso", "spine2"]);
    boundary("hip_" + s, "leg_" + s, thigh.rest.pivot, sub(thigh.rest.pivot, shin.rest.pivot).normalize(), thigh.radius_m * 1.1,
      ["cap_hip_" + s + "_leg", "leg_" + s, "thigh" + S], ["cap_hip_" + s + "_root", "root", "hips"]);
  }
  boundary("waist", "torso_waist", byId.spine.rest.pivot, sub(byId.hips.rest.pivot, byId.spine.rest.pivot).normalize(), byId.spine.radius_m * 1.1,
    ["cap_waist_torso", "upper_torso", "spine"], ["cap_waist_root", "root", "hips"]);

  const manifest = { schema: "cut-pieces/1", body: body.id + "-fixture", rig: "mixamo-106", source: "generated in code (proof/m6/fixture.js)", regions, caps, planes,
    stats: { vertices_in: 0, vertices_out: 0, triangles_split: 0, watertight: false, orphan_weights: 0 } };
  return { scene: group, manifest };
}
