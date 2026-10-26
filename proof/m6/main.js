// M6 proof page: every severable unit cut in turn on the Minotaur-106 with the cut-piece body (<body>.cut.glb + manifest, or the generated fixture), driven by
// the ragdoll + createThreeRig (bones follow the capsules) + createCutRig (caps appear with the cut). A cut cannot be undone, so each unit gets a fresh ragdoll and
// the bones go back to the bind pose between segments. Timeline: timeline.json. Body: dist/config.json, or `?body=minotaur-106` in the URL (both load
// <body>.cut.glb and <body>.cut.manifest.json from this directory); with no body the page builds the fixture from proof/m6/fixture.js.
// Capture contract (tools/capture-clip.mjs): window.__ready (Promise), window.__advance(ticks), window.__done. Plays by itself in a normal browser.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createPhysics } from "../../src/index.mjs";
import { createThreeRig } from "../../src/three-rig.mjs";
import { createCutRig } from "../../src/three-cuts.mjs";
import { qmul } from "../../src/math.mjs";
import RIG from "../../data/rig-maps/mixamo-106.json";
import BODY from "../../data/bodies/minotaur-106.measure.json";
import CAPS from "../../data/cut-caps.json";
import TIMELINE from "./timeline.json";
import { buildFixture } from "./fixture.js";

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
let rd = physics.createRagdoll(BODY, { id: "minotaur" });
const roles = rd.row.roles;

// which body: dist/config.json, then ?body= ; null = the generated fixture
let bodyName = null;
try { bodyName = (await (await fetch("config.json", { cache: "no-store" })).json()).body || null; } catch {}
const q = new URLSearchParams(location.search).get("body");
if (q) bodyName = q;

const fighter = new THREE.Group(); // the sim frame: the rig root, at the origin
scene.add(fighter);
let model, manifest;
if (bodyName) {
  const gltf = await new GLTFLoader().loadAsync(`${bodyName}.cut.glb`);
  manifest = await (await fetch(`${bodyName}.cut.manifest.json`, { cache: "no-store" })).json();
  model = gltf.scene;
} else {
  ({ scene: model, manifest } = buildFixture(THREE, BODY, RIG.joints, rd));
}
fighter.add(model);
model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
fighter.updateMatrixWorld(true);

// bones by part id (GLTFLoader strips ':' and other reserved characters from node names, so try both spellings)
const findBone = (name) => model.getObjectByName(name) || model.getObjectByName(name.replace(/[[\]./:]/g, "")) || model.getObjectByName(name.replace(/\s/g, "_"));
const bonesById = {};
for (const r of roles) {
  const b = findBone(RIG.joints[r.bone_start]);
  if (!b) throw new Error("no bone for role " + r.id + " (" + RIG.joints[r.bone_start] + ")");
  bonesById[r.id] = b;
}
// every node's bind-pose local transform, to put the body back between segments
const bindNodes = [];
model.traverse((o) => bindNodes.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
const restoreBind = () => { for (const [o, p, qq, s] of bindNodes) { o.position.copy(p); o.quaternion.copy(qq); o.scale.copy(s); } fighter.updateMatrixWorld(true); };

// the guard: arms brought in from the T-pose, driven by the motors
function guardTarget(r0) {
  const target = new Float32Array(r0.length * 4);
  r0.forEach((r, i) => {
    let qq = r.rest.quat;
    const g = TIMELINE.guard[r.role];
    if (g) { const h = (((r.side === "Left" ? -1 : 1) * g * Math.PI) / 180) / 2; qq = qmul([0, 0, Math.sin(h), Math.cos(h)], qq); }
    target.set(qq, i * 4);
  });
  return target;
}

// segments: tick ranges on one global clock
let t0 = 0;
const segs = TIMELINE.segments.map((s, i) => { const o = { ...s, i, start: t0 }; t0 += s.ticks; return o; });
const endTick = t0;
let tick = 0, segIndex = -1, seg = null, rig = null, cuts = null, cutDone = false, done = false, canvasW = 0, canvasH = 0;

function startSegment(i) {
  seg = segs[i]; segIndex = i; cutDone = false;
  if (i > 0) { rd.destroy(); rd = physics.createRagdoll(BODY, { id: "minotaur" + i }); }
  restoreBind();
  rd.setTargetPose(guardTarget(rd.row.roles));
  for (let k = 0; k < TIMELINE.warmup_ticks; k++) physics.step(TICK);
  rig = createThreeRig(THREE, rd, bonesById, fighter); // bind pose, before the first applied pose
  cuts = createCutRig(THREE, rd, model, manifest, { rows: CAPS });
}

function advance(n) {
  for (let k = 0; k < n && !done; k++) {
    if (tick >= seg.start + seg.ticks) startSegment(segIndex + 1);
    const local = tick - seg.start;
    if (!cutDone && local === seg.cut_tick) {
      cutDone = true;
      const r = rd.cut(seg.unit, { impulse: seg.impulse });
      if (!r) throw new Error("cut(" + seg.unit + ") returned null");
      if (seg.kill) rd.kill(seg.kill);
    }
    physics.step(TICK);
    tick++;
    if (tick >= endTick) done = true;
  }
  if (seg) { rig.applyPose(); cuts.update(); }
  const w = window.innerWidth, h = window.innerHeight;
  if (w && h && (canvasW !== w || canvasH !== h)) { canvasW = w; canvasH = h; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  renderer.render(scene, camera);
  if (seg) {
    const cutNow = rd.cuts.length ? `<b>${seg.note}</b>` : "guard";
    hud.innerHTML = `${cutNow}  |  ${seg.i + 1}/${segs.length}  |  t ${((tick - seg.start) * TICK).toFixed(2)} s  |  ${rd.state}  |  ${bodyName ? bodyName + ".cut.glb" : "fixture"}`;
  }
}
startSegment(0);
window.__advance = advance;
Object.defineProperty(window, "__done", { get: () => done });
window.__ready = Promise.resolve(true);
advance(0);
if (!navigator.webdriver) {
  let last = performance.now(), acc = 0;
  const loop = (now) => { acc += Math.min(0.1, (now - last) / 1000); last = now; while (acc >= TICK) { advance(1); acc -= TICK; } requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}
