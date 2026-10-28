# tools/cut-batch.mjs: every body, one command

Measure, cut, validate and receipt for a list of bodies, from one row file. Built on `tools/glb-measure.mjs`, `tools/cut-units.mjs` (`cutGlb`, `decompressGlb`) and `tools/cut-validate.mjs` (`validate`); nothing about a body lives in the tool.

```
node tools/cut-batch.mjs [--bodies data/cut-bodies.json] [--sources <dir>] [--out <dir>] [--only a,b] [--update-measure]
```

`--sources` (default `$CUT_SOURCES`, else `/root/cut-out`) is the folder `source` paths are relative to. `--out` (default `./cut-batch-out`) receives, per body: `<name>.cut.glb`, `<name>.cut.manifest.json`, `<name>.source-plain.glb` (when the source was compressed), `<name>.measure.json`, `<name>.validate.txt`, and for the run `RECEIPT.md` and `receipt.json`. `--update-measure` also writes each fresh measure row to the row's `measure` path (otherwise the batch reports whether the committed row has the same joints). Exit code 1 if any body FAILs. Body sources are confidential: run it where they live (the VPS), never upload them; only the rows, the receipt and the hashes are committed.

## Per body

1. **Measure**: `glb-measure.mjs <source> <rig_map>`, a fresh row in `--out`.
2. **Plain source**: a meshopt or quantised source is decompressed with `decompressGlb` (what `--source-out` writes) into `<name>.source-plain.glb`, the file the validator compares against. `"plain": true` rows (the 106 sources, already decompressed from OpenTrident's files) are used as they are.
3. **Cut**: `cutGlb(plain, measure, rig map, opts from the row)`.
4. **Validate**: `validate(cut, manifest, { source: plain, planeOffset: manifest.plane_frame.bind_offset })`: the eight checks of `docs/CUT-VALIDATE.md`.

## The row file `data/cut-bodies.json` (schema `cut-bodies/1`)

`{ schema, defaults, bodies: [ row ] }`. `defaults` is merged under every row (`overrides` one level deep). Unknown keys are refused, so a typo never cuts with defaults.

| key | meaning |
|---|---|
| `name` | output stem and manifest `body` (plain file stem, unique) |
| `source` | GLB path, relative to `--sources` |
| `plain` | true when the source is already plain (no decompress step; the manifest `source` string is the file's own name) |
| `rig_map` | `data/rig-maps/mixamo-106.json` or `data/rig-maps/v1-65.json` (any rig-map/1 file) |
| `measure` | where the committed measure row lives (compared, written with `--update-measure`) |
| `overrides.planes` | `neck_frac` (0.5, Neck to Head), `waist_frac` (1, Hips to Spine), `shoulder_frac` (0, Arm to ForeArm), `hip_frac` (0, UpLeg to Leg): fraction of the way along the joint pair; the defaults are the contract's start values |
| `overrides.hair_materials` | exact material names that go whole to the head (default: names matching `/hair\|lash\|brow/i`; `[]` turns it off) |
| `overrides.rigid_accessory_materials` | layered or wide garments kept whole (below): a list of material or mesh names, each a string or `{ name, piece?, shells_inside? }` |
| `overrides.plane_snap_m` | metres (0 to 0.0001, the validator's plane tolerance): how close to a plane a vertex counts as on it. Default `5e-5 x body height`, which on a body over 2.0 m is above the validator's 1e-4 plane tolerance |
| `overrides.home_min_weight` | the bone rule's threshold (0.2): a fragment whose cell region owns less of its skin weight goes to the region that owns most |
| `overrides.crotch_planes` | `false` for plain thigh-normal hip planes |
| `overrides.head_split`, `overrides.belly_open` | opt-in cuts (`docs/CUT-CONTRACT.md` "Optional cuts"), true or a row that overrides fields |
| `expect_sha256` | the cut GLB must hash to this: the published bodies carry it, so a tool change that moves their bytes fails the batch |
| `blocked` | the cause, when the body is known not to validate: it is still run and reported as BLOCKED with the cause. It needs `blocked_checks`; the body is BLOCKED (does not fail the run) only when there is no error and exactly those checks fail. Any other failure (an exception, a missing source, a hash mismatch, an extra or missing failing check) is FAIL and fails the run, and a blocked body that passes is UNBLOCKED (fails the run: delete the row's `blocked` and `blocked_checks`) |
| `blocked_checks` | with `blocked`: the names of the validator checks the body is expected to fail, for example `["watertight"]`; refused without `blocked` |
| `note` | free text |

Other rows the cut tool now reads instead of hard-coding: `PLANE_ROWS` (above), `HEAD_SPLIT` and `BELLY_OPEN` (already rows), and the ragdoll's elbow and knee flexion direction, `hinge_flex_z` in `data/world.json` (`forearm` +1, `shin` -1, was hard-coded in `engine.mjs buildDefinition`). The solver sample count for a cut edge was already a row (`states.json` `cut.edge.samples`).

## Changes to the cut tools that new bodies needed (all general)

- **Unskinned props are not body surface.** V3's 65-rig files carry the drawn weapon as rigid mesh nodes beside the body. The cut keeps them untouched; the validator's source surface (`--source`, `--self`) now counts only skinned meshes (`sourceMeshes`), else conservation failed on the weapon's area and the trident above the head (Minotaur 65: 12.8 percent area, bounding box max y 1.957 vs 1.723). A source with no skinned node still counts whole.
- **A second UV set on some primitives.** The Centurion's face and helmet have `TEXCOORD_1`, its body does not: the cut used to refuse it ("primitives carry different attribute sets"). The output attribute set is now the union over all skinned primitives, sorted, zero-filled where a primitive has none (equal sets give the bytes as before).

Both Minotaur-106 and Psyche-106 regenerate byte-identical (sha256 below; `cmp` on the VPS against `/root/cut-out/*.cut.glb` and `*.cut.manifest.json`: identical).

## Receipt (VPS, 2026-10-27, tool = main 0fc0fcb + this change, sources `/root/cut-out` and `/root/cut-out/v3` = V3 `src/assets` at main)

| body | rig | result | structure | watertight | orientation | weights | bone_side | caps | conservation | planes | sha256 of the cut GLB |
|---|---|---|---|---|---|---|---|---|---|---|---|
| minotaur-106 | mixamo-106 | **PASS** | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | e409cd5088b773a580ba714f419c48190931af23fe77a428981f7b80d7ad45d7 |
| psyche-106 | mixamo-106 | **PASS** | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | b684b455188cad8e2e46742ea16b40faa6357d1b260fb427bdf61fe1d7798477 |
| minotaur-65 | v1-65 | **PASS** | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 870db2c4c4152ff0b07c62d73622b00118a2c689f626b22743b6f2ff3056e9a7 |
| psyche-65 | v1-65 | **PASS** | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 38c046e61b0bddbaa5519fef4f50a9c816c5ed67f6972f732393bbd3d37aef9b |
| warrior-65 | v1-65 | **BLOCKED** | PASS | FAIL | PASS | PASS | PASS | PASS | PASS | PASS | 895b5289c3419a1038168d340c0b42d5d06a11b193a5a7137ea4de6273fac0d7 |
| veteran-65 | v1-65 | **BLOCKED** | PASS | FAIL | FAIL | PASS | PASS | PASS | PASS | PASS | 4371e7542fdd45d91fdc008a676c302c8293bb8cc8e4b4dabdecb5802d556eb3 |

`RESULT: OK (4 pass, 2 blocked)`. The 65-rig results are cut files for review, not shipping files: V3 still runs its own copies of these bodies, and the 65 rig has no V3 cut wiring.

### Blocked, with the cause (a finding, not a fix hidden)

- **warrior-65, watertight.** Measured: the skin shell `EXO_BrowsLashes` (material `Exo_MAT`, 9,352 vertices; the body under the `Steel` suit) is open geometry with about 2,170 native open edges. The shoulder, waist and hip planes cross it where it has holes: 195 section chains do not close (`cap_open_chains`), leaving 696 cap-loop edges open (166 root, 234 torso, 89 + 89 arms, 58 + 58 legs). Leaving that mesh out of the cut gives 0 introduced open edges (a leave-one-out run on the VPS, one mesh at a time), but it carries the face, hands and neck skin, so it cannot be dropped. Inferred, not tested: closing the chains by bridging would cap over geometry that is not there. Fix is on the source side (a closed or hand-capped skin shell); every other check passes.
- **veteran-65, watertight and orientation.** Measured: the body `CreatureBody` (47,360 vertices) is a non-manifold sculpt, 2,003 open edges, 1,765 over-used edges and 49 flipped-winding edges natively (`cut-validate --self`), with six overlapping skinned meshes; the section loops through them are tangled (117 loops, 38 holes, 44 forced ears, 50 inward cap triangles). The cut introduces 36 open and 22 over-used edges and 1,054 flipped-winding edges in `piece_root`. Conservation, weights, bone side, caps and planes pass. Inferred, not tested: the 1,054 flipped edges come from cap loops built through the overlapping shells at the hips. Needs a cleaned body mesh.

### Four more 106 bosses (Frankendom-v3 PRs 182 to 185; run on the Mac, same tool, twice, identical bytes)

| body | source head | result | sha256 of the cut GLB | triangles (all pieces) |
|---|---|---|---|---|
| demon-106 | 4e32b08 | **BLOCKED** (watertight, orientation, planes) | e74fe0f5ad99053323571ddcceae77efdfa7e9feedd9990ee6911bb016a5c5b3 | 18,829 |
| warrok-106 | 0aee9ea | **BLOCKED** (watertight, caps) | d7a04ee5c53c52f20320ffb7f722855645dea34148b29045efec40653b74bdc9 | 16,010 |
| brute-106 | 20dcf39 | **PASS** | 6cb36078bf6380626959eaf7e05ade1a63809c56316966696350c7abccaa9ad5 | 25,467 |
| maw-106 | 54d6706 | **BLOCKED** (watertight, planes) | 49b86f2ba0e54d883b174b0b9ca55f2dd1d58cdf68a54d9b15a46797d01493c4 | 17,038 |

Demon, Warrok and Maw are one skinned mesh, one material, no hair material: the open shell at the cut planes is in the source, and no plane fraction (81 combinations each), `home_min_weight` or `crotch_planes` row fixed it (causes in the `blocked` text of each row). Only Brute carries `expect_sha256` (the blocked rows have none, like warrior-65 and veteran-65).

### Armagedom player bodies: vagrant-106 and hale-pitborn (VPS, 2026-10-28)

| body | rig | result | sha256 of the cut GLB |
|---|---|---|---|
| vagrant-106 | mixamo-19 | **BLOCKED** (watertight, caps) | 8a4d48818705a6d923f17da676d604ae88d96650bb2b6e280e00f566987f294f |
| hale-pitborn | v1-65 | **BLOCKED** (watertight, orientation) | 9f27733d64c08f852f501b46cca0c24028529ef80d2265e2287c58988914232b |

- **Rig-map entries.** `tools/cut-units.mjs` now reads the same entries as `tools/glb-measure.mjs`: a node name, or `{ node, along_local_y_m }`. A name that is a skin joint behaves as before. A name that is a node outside the skin (Mixamo's `Spine1` on the 19-joint rig) or a synthesised point (the toes, 0.20 m from the Foot along its +Y) has only a bind position, which is all the measure-row check needs; the seven region anchors (Hips, Spine, Head, both Arms, both UpLegs) must be skin joints. The toes then own no vertices: the foot takes their weight, so the leg pieces need no toe bone. All six committed `expect_sha256` rows regenerate byte-identical.
- **Vagrant's materials all contain "browser"** (`Torso jacket browser`, ...), so the default hair pattern `hair|lash|brow` sent every triangle to `piece_head` ("region root received no triangles"). The row sets `overrides.hair_materials: []`; the Vagrant has no hair mesh.
- **Both bodies are blocked on the source, not on the tool**: layered garment and armour meshes that are not closed shells (Vagrant 1,639 open source edges, Hale 2,769), so the planes pass through unclosed layers. Vagrant fails watertight and caps (2 + 3 triangles with winding against their normals), Hale fails watertight and orientation; weights, bone_side, conservation and planes pass on both. Vagrant: 81 plane combinations, no PASS; Hale: 18 plane combinations plus `home_min_weight` 0.5, no PASS. Causes in the `blocked` text of each row; `test/hale-pitborn.test.mjs` pins the rows.

### Rigid accessory layers (row override `rigid_accessory_materials`)

A layered garment (skirt, sash, hem, jacket, trouser or pauldron layer) that lies over or through the body shell makes the shoulder, hip and waist section loops not nest: over-used and flipped edges, caps that fold. The row names the layer and the cut keeps it **whole**: not cut at any plane, in ONE piece (the piece owning most of its skin weight, or `piece`), bound rigidly to ONE bone of that piece (the heaviest of that piece's bones in the layer; weight 1). The body shell is cut exactly as before. The validator is not changed and nothing is bypassed: the layer is declared in the manifest's `plane_exempt` (the hair mechanism, `docs/CUT-VALIDATE.md`) and listed in `rigid_accessories` (name, piece mesh, materials, bone, triangles, vertices); every other check applies to it.

- `"name"`: a material name or a mesh name. A whole primitive is taken. A name that matches nothing, a hair material, or a primitive another entry took is refused.
- `"shells_inside": [[x0, y0, z0], [x1, y1, z1]]`: only the connected shells (welded positions) of the match whose bounding box lies inside this box (GLB metres) are taken. This is how a skirt is picked out of a body that has one material (Kachujin: one mesh, 27 shells). No shell inside is refused. Such a layer, and any whole primitive whose material the body also uses, gets a copy of the material named `<material>.rigid`, so `plane_exempt` names the layer and not the shell.
- `"piece"`: `root`, `upper_torso`, `head`, `arm_left`, `arm_right`, `leg_left` or `leg_right`; by default the heaviest piece by skin weight.
- A layer that IS the body surface of its piece cannot be set aside: the piece would lose its section (no waist cap) or have no triangles. That body stays blocked until the source carries a body shell under the layer (the PR #232 Boss was blocked; the rebuilt PR #242 Boss passes, see below).
- No row, an empty list: the cut is byte-identical to before (proved on the seven shipped rows with sources, 14 files: GLB and manifest hashes before and after equal).

Results (VPS, 2026-10-28, tool = this change, sources = V3 PRs at the heads in the rows):

| body | before | rigid accessories | result | sha256 of the cut GLB |
|---|---|---|---|---|
| kachujin-106 (V3 #227) | FAIL watertight (8 over-used), orientation (21 flipped), planes (1 vertex 0.00010 m) | back sash 410 + thigh skirt 664 triangles (root, Hips), ponytail 152 (head, Head); `plane_snap_m` 9e-5 | **PASS** (8 of 8) | ed1ce1d402dac0f63eb08a0a64e46d90d45cd199d1fdc65b22dc3e012f2d0357 |
| castle-guard-106 (V3 #231) | FAIL watertight (3 over-used), orientation (6 flipped), caps | the two pauldrons (188 triangles each) | **PASS** (8 of 8) | ccbc64a54b33c22e8a2a7c94f2766834afb44e8da0d820d312b2a6745d02aad1 |
| the-boss-106 (V3 #232) | FAIL watertight (13 over-used), orientation (12 flipped), caps | none possible | **BLOCKED** (no body shell under the clothes) | n/a |
| the-boss-106 (V3 #242 head 43916a8, rebuilt with a closed body shell) | not run | jacket (`Clothes_MAT`, upper_torso) and trousers (`Clothes_MAT.001`, root, hat excluded by `shells_inside`) | **PASS** (8 of 8) | 367554e5baddc5e921e9ba007ced91b7b9def499818d29a4cfb0d85d6ef2404a |

Kachujin needs both parts: the accessories alone leave the planes violation, `plane_snap_m` alone leaves the 8 over-used and 21 flipped edges. The PR #232 Boss had no layer over a body shell: its torso was the jacket and its legs the trousers, so keeping either whole removed the waist section or the legs. PR #242 adds a closed body shell under both, and the same tool then passes (three runs, identical bytes); the pass is sensitive to the shell shape near the crotch (3 of 12 shell variants passed).

## Tests

`test/cut-batch.test.mjs` (synthetic bodies only, no real body in the repo): two bodies through measure, cut, validate and the receipt (8 PASS each, props and a one-sided `TEXCOORD_1` in the source), the per-body plane row, explicit default rows giving the same bytes as no rows, two runs giving the same bytes, a failing hash and a missing source failing the run, a blocked row reported only when exactly its `blocked_checks` fail (an error or a different failing set is FAIL) and an unblocked one flagged, a missing COLOR_0 filled with white and a missing NORMAL or TANGENT refused, and the row checks.
