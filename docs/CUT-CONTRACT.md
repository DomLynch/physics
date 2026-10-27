# Cut-piece contract (Strategy-confirmed 2026-10-26)

One body becomes **seven skinned cut regions on the same skeleton** plus **cap meshes hidden until the unit is cut**. The tool (`tools/cut-units.mjs`) lives in this repo; each body's `<body>.cut.glb` and `<body>.cut.manifest.json` are stored beside the body in OpenTrident's library (OpenTrident Dev publishes them), so every game downloads the cut variant once and V3 never builds bodies itself. Quality gate: Dom's phone, a 375 clip of the Minotaur's head cut and one limb cut.

## Regions (the loot contract's six paired units map onto them; hands are in the arm piece, feet in the leg piece)
| region mesh | contains | unit that detaches it |
|---|---|---|
| `piece_root` | pelvis and everything the legs hang from, above the hip planes and below the waist plane | (the root piece; stays) |
| `piece_upper_torso` | waist plane up to the neck plane and shoulder planes (chest, back, shoulders) | `torso_waist` (carries head and arms too) |
| `piece_head` | above the neck plane, incl. hair, jaw, horns, helm/gear on the head bone | `head` |
| `piece_arm_left`, `piece_arm_right` | from the shoulder plane outward, incl. hands and fingers | `arm_left`, `arm_right` |
| `piece_leg_left`, `piece_leg_right` | below the hip plane, incl. feet and toes | `leg_left`, `leg_right` |

Unit names are the package's severable ids (`rd.cut(unit)`; `rd.cuts`). Gear (helmet, weapon sockets, armour layers) follows its bone, so it travels with the piece whose bone carries it.

## Planes and weights
- Six cut planes (neck, shoulder L/R, hip L/R, waist), each defined by a point and a normal derived from the body measure row's joint positions (`data/bodies/<name>.measure.json`) and stored in the manifest (`planes`). Start values: neck at 50 percent from the Neck joint to the Head joint, normal along Neck to Head; shoulders at the Arm joint, normal along the arm bone; hips at the UpLeg joint, normal along the thigh; waist at the Spine joint, normal along hips to Spine. The tool may refine these and must document why.
- **Triangles that cross a plane are split at the plane** (new vertices interpolated: position, normal, UV, all skin weights), never assigned whole, so no gap or ledge.
- **Each piece is bound only to bones on its own side of the cut.** A vertex of the head piece that carries weight on the Neck bone (which stays with the torso when the head is cut) is re-bound to the Head bone (weights renormalised); likewise at the other planes. Vertices keep their weights otherwise. Result: when the physics head flies, no vertex of the head piece is still driven by a torso bone, and no rubber-sheet stretch appears.

## Hair (Physics Dev ruling, binding)
Hair, hair cards, eyelashes and brows (any material that belongs to the head) go **whole to `piece_head`**, never cut at a plane, **re-bound rigidly to the Head bone** (weights renormalised to Head only), because a severed head must carry its hair and hair cut into fragments at the neck plane would look wrong. The tool finds them by material name (`/hair|lash|brow/i`; `hairMaterials` overrides) and declares them in the manifest, so the validator knows why they are across the plane:
```json
"plane_exempt": { "piece_head": ["Ch22_hair"] },
"plane_exempt_reason": "hair, hair cards and eyelashes belong to the head: ..."
```
`plane_exempt` relaxes the **planes** check for those materials only (they hang below the neck plane to the knees). Weights, bone side, watertightness, orientation and the cap checks still apply to them; Head-only binding is a valid bone side for the head. A body with no such material has no `plane_exempt` and behaves as before (the Minotaur).

## Caps
- Each cut boundary has **two caps**, one on each side, built by triangulating the cut loop(s) (handle several loops, e.g. horns or hair strands crossing the plane; holes by ear clipping with hole bridging or a fan with a centre vertex), with normals facing out of the piece, UVs for a flesh material, and the same skin weights as the loop vertices (so the cap follows its piece).
- Cap meshes: `cap_neck_head`, `cap_neck_torso`, `cap_shoulder_left_arm`, `cap_shoulder_left_torso`, `cap_shoulder_right_arm`, `cap_shoulder_right_torso`, `cap_hip_left_leg`, `cap_hip_left_root`, `cap_hip_right_leg`, `cap_hip_right_root`, `cap_waist_torso`, `cap_waist_root`. Material `cap_flesh` (and an optional `cap_inner` for bone or a darker core; a data row picks colours).
- A cap is **visible iff its `shown_when_cut` unit is in the cut set**: `cap_neck_*` shown when `head` is cut; `cap_shoulder_left_*` when `arm_left`; `cap_shoulder_right_*` when `arm_right`; `cap_hip_left_*` when `leg_left`; `cap_hip_right_*` when `leg_right`; `cap_waist_*` when `torso_waist`. Region meshes are always visible.

## Files
`<body>.cut.glb`: one scene, one skin (the original skeleton, unchanged node names), the seven `piece_*` meshes, the twelve `cap_*` meshes (all SkinnedMesh bound to that skin), original materials kept plus `cap_flesh`. `<body>.cut.manifest.json`:
```json
{ "schema": "cut-pieces/1", "body": "minotaur-106", "rig": "mixamo-106", "source": "minotaur-106.glb",
  "regions": [{ "id": "head", "mesh": "piece_head", "detached_by": "head" }, ...],
  "caps": [{ "id": "cap_neck_head", "mesh": "cap_neck_head", "region": "head", "shown_when_cut": "head" }, ...],
  "planes": { "neck": { "point": [x, y, z], "normal": [x, y, z], "source": "..." }, ... },
  "plane_exempt": { "piece_head": ["<hair material>"] }, "plane_exempt_reason": "...",
  "stats": { "vertices_in": 0, "vertices_out": 0, "triangles_split": 0, "watertight": true, "orphan_weights": 0 } }
```
(`plane_exempt` and its reason are present only when the body has hair-card, eyelash or brow materials.)

## Optional cuts (opt-in, default OFF)
Two more cuts for the finishers, added as rows (`HEAD_SPLIT`, `BELLY_OPEN` in `tools/cut-units.mjs`) and as **additive, optional** manifest fields. With both off (the default) the files are the seven pieces and twelve caps above, byte for byte (the published Minotaur-106 and Psyche-106 cut files regenerate identically) and every `cut-pieces/1` consumer works unchanged. Turned on with `--head-split` / `--belly-open` (or `opts.headSplit` / `opts.bellyOpen`; an object overrides fields of the row). The manifest then carries `optional_units` (one entry per enabled cut, `enabled: true`, the unit, plane, regions and caps, and stats) and `optional_planes` (their planes, in the same frame as `planes`); the schema string stays `cut-pieces/1`.

**`head_split` (V1 Split Crown, a head cleaved on the midline).** A sagittal plane (normal = the body's left-right axis from the LeftArm / RightArm and hip joints, Right to Left; point on the Neck-Head line, moved onto the body's symmetry plane) cuts `piece_head` into `piece_head_left` (the + side) and `piece_head_right`, and **the halves replace `piece_head`** (a body has `piece_head` or its halves, never both). Both halves keep `detached_by: "head"` (they fly together while only the head is cut) and carry `separated_by: "head_split"` (the new severable unit: cut it and the two halves are independent pieces). Caps: `cap_neck_head_left` / `cap_neck_head_right` (shown when `head` is cut; they replace `cap_neck_head`) and `cap_split_head_left` / `cap_split_head_right` (the cut faces, shown when `head_split` is cut; flat on the plane, each facing away from its half). The halves are bound to the same Head-side bones as the head; hair cards still go whole (never cut) to the half they lie mostly in, Head-only bound, and `plane_exempt` is declared per half (`piece_head_left` / `piece_head_right`). The cut stops at the neck plane: it splits the skull, not the chest (the torso piece is untouched).

**`belly_open` (V1 Opened, belly opened and entrails).** One extra skinned mesh `cap_belly_opening` on `piece_upper_torso` (manifest `caps` entry with `region: "upper_torso"`, `shown_when_cut: "belly_open"`, `kind: "opening"`): an elliptical wound patch (flesh rim `cap_flesh`, dark core `cap_inner`) standing a few millimetres in front of the torso skin, above the waist plane, centred on the symmetry plane, inside a forward-facing ellipse (`optional_units.belly_open.frame`: centre, forward, lateral, up, half axes). It **does not detach anything and does not remove any geometry** (`removes_geometry: false`; the torso skin under it is still there), so it reads as an opening only as a decal that covers the skin; for a true hole the runtime must hide or replace the skin under it. It is skinned like the three skin vertices it sits on (own-side bone weights, barycentric), so it follows the belly.

What V3 must do to use them: register `head_split` and `belly_open` as severable unit ids (`createCutRig` rejects a cap or region naming a unit the package does not know), call `rd.cut("head_split")` / `rd.cut("belly_open")`, and when `head_split` is cut let the two halves move independently (today they follow the same `head` capsule). Nothing in `src/` changes for the default files.

## Acceptance (the tool)
Vertex and skin-weight conservation (every original vertex lands in exactly one piece, or is split with its weights interpolated), watertight pieces with their caps on, no vertex bound to a bone across a cut, a render of every unit cut in turn from 8 angles at 375 wide with no hole or ledge, runs on the Minotaur-106 and Psyche-106 first (V3 `rig/106-default` GLBs; warrior and Centurion 106 files when V3 provides them).

## Runtime (`src/three-cuts.mjs`)
`createCutRig(THREE, rd, scene, manifest)` returns `{ update() }` (call every frame after `rig.applyPose()`; shows or hides caps from `rd.cuts`), plus a `capMaterial` row hook (blood tint), and exposes the pieces by region. The bones are driven by the existing `createThreeRig(...).applyPose()`, so a severed piece moves with its capsule with no extra code.
