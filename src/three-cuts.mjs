// three.js glue for cut pieces (docs/CUT-CONTRACT.md, Runtime). Pass the `THREE` namespace in (the package does not depend on three).
//   const cuts = createCutRig(THREE, rd, scene, manifest, { rows });   // scene: the loaded <body>.cut.glb scene; manifest: <body>.cut.manifest.json
//   each frame: physics.step(); rig.applyPose(); cuts.update();
//   - `pieces`: region id (head, upper_torso, root, arm_left, ...) -> the `piece_*` mesh. Always visible; the bones carry them (createThreeRig drives the bones),
//     so a severed piece moves with its capsule and the gear on its bones (helmet, hair, weapon sockets) goes with it. No extra code.
//   - `caps`: cap id (cap_neck_head, ...) -> the `cap_*` mesh. Visible iff its `shown_when_cut` unit is in `rd.cuts`; hidden at start.
//   - `update()` derives everything from `rd.cuts` every call, so a cut that is already in the set is a no-op and a fresh or reset ragdoll (empty `rd.cuts`)
//     hides every cap again. (`rd.reset()` itself returns false after a cut; recreate the ragdoll then, and the caps follow its empty cut set.)
//   - `setCapMaterial(rows)`: data-row hook for the cap colours, shape of data/cut-caps.json (`flesh`, `inner`, `blood`); also applied at creation from `opts.rows`.
// Unknown names fail loudly at creation: a manifest mesh missing in the scene, a cap whose unit the ragdoll does not know, a malformed manifest.

const SCHEMA = "cut-pieces/1";

export function createCutRig(THREE, rd, scene, manifest, opts = {}) {
  if (!manifest || manifest.schema !== SCHEMA) throw new Error(`cut manifest: schema must be "${SCHEMA}", got ${manifest && manifest.schema}`);
  if (!Array.isArray(manifest.regions) || !Array.isArray(manifest.caps)) throw new Error("cut manifest: regions and caps must be arrays");
  const units = new Set(rd.row.severable.map((s) => s.id));
  const find = (name, what) => {
    const o = scene.getObjectByName(name);
    if (!o) throw new Error(`cut rig: ${what} mesh "${name}" is not in the scene`);
    return o;
  };

  const pieces = {};
  for (const r of manifest.regions) {
    if (!r.id || !r.mesh) throw new Error("cut manifest: a region needs id and mesh");
    if (r.detached_by && !units.has(r.detached_by)) throw new Error(`cut manifest: region "${r.id}" is detached by unknown unit "${r.detached_by}"`);
    pieces[r.id] = find(r.mesh, `region "${r.id}"`);
  }
  const caps = {}, capUnit = {};
  for (const c of manifest.caps) {
    if (!c.id || !c.mesh) throw new Error("cut manifest: a cap needs id and mesh");
    if (!units.has(c.shown_when_cut)) throw new Error(`cut manifest: cap "${c.id}" is shown for unknown unit "${c.shown_when_cut}"`);
    if (!(c.region in pieces)) throw new Error(`cut manifest: cap "${c.id}" names unknown region "${c.region}"`);
    caps[c.id] = find(c.mesh, `cap "${c.id}"`);
    capUnit[c.id] = c.shown_when_cut;
  }
  // skinned pieces are posed by the bones: the bind-pose bounding sphere would cull a flying piece
  for (const m of [...Object.values(pieces), ...Object.values(caps)]) m.frustumCulled = false;

  // cap materials, by name (cap_flesh; cap_inner when the file carries one)
  const capMats = { flesh: new Set(), inner: new Set() };
  for (const m of Object.values(caps)) {
    for (const mat of [].concat(m.material || [])) (mat.name === "cap_inner" ? capMats.inner : capMats.flesh).add(mat);
  }
  const col = (c, what) => {
    if (c === undefined || c === null) return null;
    const out = new THREE.Color();
    if (Array.isArray(c)) out.setRGB(c[0], c[1], c[2]); else out.set(c);
    if (!Number.isFinite(out.r)) throw new Error("cut caps row: bad colour for " + what);
    return out;
  };
  const colorOf = (row, what) => (row && typeof row === "object" && "color" in row ? row.color : row);

  const api = {
    pieces,
    caps,
    update() {
      const cut = new Set(rd.cuts);
      for (const id in caps) caps[id].visible = cut.has(capUnit[id]);
      for (const id in pieces) pieces[id].visible = true;
    },
    // rows: { flesh: { color }, inner: { color }, blood: { tint, amount } }; colours are CSS strings, hex numbers or [r, g, b] in 0..1. blood mixes its tint into
    // both colours by `amount` (0 = clean, 1 = all tint). A missing key leaves that colour alone.
    setCapMaterial(rows) {
      const blood = rows && rows.blood ? { tint: col(colorOf(rows.blood.tint ?? rows.blood, "blood.tint"), "blood.tint"), amount: rows.blood.amount ?? 0 } : null;
      for (const key of ["flesh", "inner"]) {
        const c = col(colorOf(rows && rows[key], key), key);
        if (!c) continue;
        if (blood && blood.tint && blood.amount > 0) c.lerp(blood.tint, Math.min(1, blood.amount));
        for (const mat of capMats[key]) if (mat.color) mat.color.copy(c);
      }
    },
  };
  if (opts.rows) api.setCapMaterial(opts.rows);
  api.update();
  return api;
}
