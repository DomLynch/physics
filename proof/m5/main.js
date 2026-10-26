// M3 proof page: the Minotaur (V3's 65-joint rig, rest pose = bind pose) as a ragdoll from its body measure row. Idle guard (motors on, hips pinned), a
// stagger dip on a hit, then the death ramp on the final blow: motors 1 -> 0.01 over 1 s, hit impulse the same tick, freeze when still.
// Capture contract (tools/capture-clip.mjs): window.__ready (Promise), window.__advance(ticks), window.__done. Plays by itself in a normal browser.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createPhysics } from "../../src/index.mjs";
import { qmul, qconj, qrot } from "../../src/math.mjs";
import RIG from "../../data/rig-maps/v1-65.json";
import BODY from "../../data/bodies/minotaur.measure.json";
import TIMELINE from "./timeline.json";

const TICK = 1 / 60;
const hud = document.getElementById("hud");
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById("c"), antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1c1a18);
scene.fog = new THREE.Fog(0x1c1a18, 9, 24);
const C = TIMELINE.camera;
const camera = new THREE.PerspectiveCamera(C.fov, window.innerWidth / window.innerHeight, 0.1, 60);
camera.position.set(...C.position);
camera.lookAt(...C.look);
scene.add(new THREE.HemisphereLight(0xcfd8ff, 0x3a2f24, 0.9));
const sun = new THREE.DirectionalLight(0xfff0d8, 2.4);
sun.position.set(-3, 6, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 1, far: 20 });
scene.add(sun);
const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 48), new THREE.MeshStandardMaterial({ color: 0x6a5a42, roughness: 1 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const physics = await createPhysics({ seed: TIMELINE.seed });
const rd = physics.createRagdoll(BODY, { id: "minotaur" });
const roles = rd.row.roles;

// the model: bones by role, rest world orientations, and the sim-space offset that puts the model's hips joint on the ragdoll's
const gltf = await new GLTFLoader().loadAsync("minotaur.glb");
const model = gltf.scene;
const holder = new THREE.Group();
holder.add(model);
scene.add(holder);
model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
holder.updateMatrixWorld(true);
const bones = roles.map((r) => model.getObjectByName(RIG.joints[r.bone_start]));
bones.forEach((b, i) => { if (!b) throw new Error("no bone for role " + roles[i].id); });
const restWorldQ = bones.map((b) => b.getWorldQuaternion(new THREE.Quaternion()));
const pose0 = rd.readPose();
const simHipsPivot = new THREE.Vector3(...[0, 1, 2].map((k) => roles[0].rest.pivot[k] + (pose0[k] - roles[0].rest.centre[k])));
holder.position.copy(simHipsPivot.sub(bones[0].getWorldPosition(new THREE.Vector3())));
holder.updateMatrixWorld(true);

// the guard: arms brought in from the T-pose (a stand-in for the animated pose V3 will send), driven by the motors
const target = new Float32Array(roles.length * 4);
roles.forEach((r, i) => {
  let q = r.rest.quat;
  const g = TIMELINE.guard[r.role];
  if (g) { const h = (((r.side === "Left" ? -1 : 1) * g * Math.PI) / 180) / 2; q = qmul([0, 0, Math.sin(h), Math.cos(h)], q); }
  target.set(q, i * 4);
});
rd.setTargetPose(target);

const V = new THREE.Vector3(), Q = new THREE.Quaternion(), QP = new THREE.Quaternion();
function applyPose() {
  const p = rd.readPose();
  roles.forEach((r, i) => {
    const o = i * 10, pq = [p[o + 3], p[o + 4], p[o + 5], p[o + 6]];
    const delta = qmul(pq, qconj(r.rest.quat));
    const bw = qmul(delta, [restWorldQ[i].x, restWorldQ[i].y, restWorldQ[i].z, restWorldQ[i].w]);
    const b = bones[i];
    b.parent.updateWorldMatrix(true, false);
    b.parent.getWorldQuaternion(QP);
    Q.set(bw[0], bw[1], bw[2], bw[3]).premultiply(QP.invert());
    b.quaternion.copy(Q);
    if (i === 0) {
      const off = qrot(delta, [0, 1, 2].map((k) => r.rest.pivot[k] - r.rest.centre[k]));
      V.set(p[o] + off[0], p[o + 1] + off[1], p[o + 2] + off[2]);
      b.position.copy(b.parent.worldToLocal(V));
    }
    b.updateMatrixWorld(true);
  });
}

// scripted timeline in ticks: hit events from the sim (the game's job; here a script)
let tick = 0, canvasW = 0, canvasH = 0;
let done = false;
const events = TIMELINE.events;
// M5 visuals: red cap discs at the stumps and the helmet as a prop sphere (the skinned mesh stretches at the neck seam: placeholder until cut-piece meshes exist)
const capMat = new THREE.MeshStandardMaterial({ color: 0x8e1b16, roughness: 0.4 }), helmMat = new THREE.MeshStandardMaterial({ color: 0x5c5f66, metalness: 0.7, roughness: 0.35 });
const propMeshes = [], caps = [];
function advance(n) {
  for (let k = 0; k < n && !done; k++) {
    for (const e of events) if (e.tick === tick) {
      if (e.type === "stagger") rd.stagger({ part: e.part, impulse: e.impulse });
      if (e.type === "kill") rd.kill({ part: e.part, impulse: e.impulse });
      if (e.type === "cut") {
        const r = rd.cut(e.unit, { helmet: !!e.helmet, impulse: e.impulse });
        if (r) {
          const cap = new THREE.Mesh(new THREE.SphereGeometry(e.cap_radius || 0.05, 16, 12), capMat);
          // the stump cap stays on the body: remember its offset in the parent part's frame and follow that part every frame
          const pi = rd.partIds.indexOf(rd.row.roles.find((x) => x.id === r.cap.part).parent), pp = rd.readPose(), o = pi * 10;
          const pq = [pp[o + 3], pp[o + 4], pp[o + 5], pp[o + 6]];
          caps.push({ cap, pi, off: qrot(qconj(pq), [r.cap.position[0] - pp[o], r.cap.position[1] - pp[o + 1], r.cap.position[2] - pp[o + 2]]) });
          cap.position.set(...r.cap.position); scene.add(cap);
          for (const pr of r.props) { const m = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 14), helmMat); m.castShadow = true; scene.add(m); propMeshes.push({ m, pr }); }
        }
      }
      hud.dataset.note = e.note;
    }
    physics.step(TICK);
    tick++;
    if (tick >= TIMELINE.end_tick) done = true;
  }
  applyPose();
  { const pp = rd.readPose(); for (const c of caps) { const o = c.pi * 10, w = qrot([pp[o + 3], pp[o + 4], pp[o + 5], pp[o + 6]], c.off); c.cap.position.set(pp[o] + w[0], pp[o + 1] + w[1], pp[o + 2] + w[2]); } }
  for (const { m, pr } of propMeshes) { const p = pr.readPose(); m.position.set(p[0], p[1], p[2]); m.quaternion.set(p[3], p[4], p[5], p[6]); }
  const w = window.innerWidth, h = window.innerHeight;
  if (w && h && (canvasW !== w || canvasH !== h)) { canvasW = w; canvasH = h; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  renderer.render(scene, camera);
  hud.textContent = `${hud.dataset.note || "guard"}  |  t ${(tick * TICK).toFixed(2)} s  |  ${rd.state}`;
}
for (let k = 0; k < TIMELINE.warmup_ticks; k++) physics.step(TICK);
window.__advance = advance;
Object.defineProperty(window, "__done", { get: () => done });
window.__ready = Promise.resolve(true);
advance(0);
if (!navigator.webdriver) {
  let last = performance.now(), acc = 0;
  const loop = (now) => { acc += Math.min(0.1, (now - last) / 1000); last = now; while (acc >= TICK) { advance(1); acc -= TICK; } requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}
