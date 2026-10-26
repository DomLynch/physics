# tools/cut-units.mjs: one body GLB into seven pieces and twelve caps

The mesh pipeline behind `docs/CUT-CONTRACT.md`. It reads a skinned humanoid GLB, its measure row and its rig map, and writes `<body>.cut.glb` and `<body>.cut.manifest.json`: seven `piece_*` skinned meshes and twelve `cap_*` skinned meshes on the unchanged skeleton, the original materials plus `cap_flesh`. Rendering and the runtime (`createCutRig`) are not part of this tool.

## Run

```
node tools/cut-units.mjs <body.glb> <body.measure.json> <rig-map.json> <out-dir> [--body name] [--debug]
node tools/cut-units.mjs minotaur-106.glb data/bodies/minotaur-106.measure.json data/rig-maps/mixamo-106.json out/
```

Needs `@gltf-transform/core`, `@gltf-transform/extensions` and `meshoptimizer` (devDependencies: the V3 106 bodies are meshopt-compressed and webp-textured, and the tool reads and writes through gltf-transform; nothing in the package's runtime loads this file). Runs in about two seconds per body. `--body` names the output files and the manifest `body` (default: the measure row's `id`). `--debug` prints which fragments the bones moved, the cap loops per region and the re-bind counts. Same input, same output bytes (no clocks, no random, every map ordered).

`opts` of `cutGlb(bytes, row, rigMap, opts)` (the function the CLI wraps): `body`, `rig`, `source` (manifest strings), `debug`, `crotchPlanes: false` (plain thigh-normal hip planes).

The output keeps the animations, textures and node names of the source. `<body>.cut.glb` is the contract file: **uncompressed and un-quantised**, plain float32 POSITION / NORMAL / TEXCOORD_0 in **metres** (the source's dequantisation matrix is baked into the vertices and out of the inverse binds), uint16 JOINTS_0, float32 WEIGHTS_0, uint16/32 indices, so plain readers (tools/cut-validate.mjs) work. `--meshopt` also writes `<body>.cut.min.glb` (meshopt + quantised, for shipping, not the contract file). `--source-out <file>` writes the source in the same plain form (needed by `cut-validate --source` when the source is a meshopt web GLB):

```
node tools/cut-units.mjs src.glb row.json rig.json out/ --source-out out/src-plain.glb
node tools/cut-validate.mjs out/body.cut.glb out/body.cut.manifest.json --source out/src-plain.glb --plane-offset <manifest plane_frame.bind_offset>
```
The manifest's plane points are in the measure row's frame; the validator needs `--plane-offset` = `plane_frame.bind_offset` to compare them with the GLB. The internal hip bisector is listed under `internal_planes`, not `planes`.

## Method

1. **Frames.** The measure row is floor-lifted (`tools/glb-measure.mjs` puts the toes on y = 0). The tool recovers that offset from the 20 role joints (refusing a row that does not fit the GLB beyond 2 mm) and works in the GLB's bind-pose world. Quantised bodies (gltfpack) keep their vertices in a normalised space and bake the dequantisation into the inverse binds; the tool finds that matrix (`jointWorld x inverseBind`, the same for every joint) and does all geometry in metres, writing positions back in the stored space. The manifest carries `plane_frame.vertex_to_world`, `bind_offset` and `crotch_apex`. Plane points in the manifest are in the measure row's frame.
2. **Planes** (contract start values, with two refinements, below). Neck: half way Neck to Head, normal along Neck to Head. Waist: the Spine joint, normal Hips to Spine. Shoulders: the Arm joint. Hips: the UpLeg joint.
3. **Split.** Every triangle is cut at every plane it crosses (Sutherland-Hodgman). A new vertex on an edge gets position, normal, tangent (if present), every UV set, any other float attribute, and all skin weights interpolated; it is created once per edge and plane (looked up by the edge's two end positions, so UV-seam duplicates of one edge get bit-identical split points) and shared by every triangle on that edge. A vertex within 0.09 mm (5e-5 of the height) of a plane counts as on it, so no sliver triangles. Never assigned whole: no gap and no ledge.
4. **Fragments and regions.** Cutting gives cells (the sign pattern over the planes). Within a cell, connected pieces of mesh (welded by position) are fragments. A fragment goes to the region its cell names (head above the neck plane, an arm beyond its shoulder plane, a leg below its hip plane, upper torso above the waist, root otherwise; priority head, arms, legs, torso). **Unless its bones disagree:** when the cell's region owns under 20 percent of the fragment's skin weight, the feasible region owning most of it takes the fragment. "Feasible" means the cell's planes allow it (head needs the + side of the neck plane; an arm or leg the + side of its own plane; the torso the - side of neck and shoulders and the + side of the waist; the root the - side of waist and both hips), so every piece vertex stays on its side of every plane that bounds its piece (`cut-validate` check 8). This is what makes the planes safe on a real body, where an infinite plane also crosses unrelated mesh: a foot beyond the shoulder plane's far side stays in its leg, a tail across the hip bisector stays in the root. Gear below a plane that its bones put elsewhere (Psyche's hair below the neck plane) goes to the piece the plane says, and its Head weights are re-bound to that piece's bones. Where two fragments of one region meet across a plane, the shared split vertices make them one surface again, so no cap appears there.
5. **Bone ownership and re-bind.** Each bone belongs to the region of its nearest ancestor-or-self among Hips (root), Spine (upper torso: Spine, Spine1, Spine2, Neck, shoulders), Head (head, hair, jaw...), LeftArm / RightArm (arm), LeftUpLeg / RightUpLeg (leg, feet, toes, twist bones). A piece keeps weights on its own bones and moves every other weight to the nearest bone it does own (tree distance; Neck goes to Head in the head piece, Head goes to Neck in the torso piece, Hips goes to UpLeg in a leg), merges duplicates, keeps the four largest, renormalises to 1. `orphan_weights` counts influences left on a foreign bone after this: 0 on both bodies.
6. **Caps.** For each piece, the boundary edges that lie on a cut plane are chained into loops; a loop along two cap planes (the root's lower edge where the two hip planes meet) is cut at the two points where it changes plane and each half closed by a straight chord, so every cap is flat. Loops are triangulated by **ear clipping with hole bridging** (outer rings and holes by orientation and containment, so a hollow tube or a horn crossing the plane gives a ring with a hole), keeping every loop vertex (a dropped collinear vertex would leave a T-junction against the piece). Cap triangles are wound to meet the piece's edges the other way round, so the outward normal comes out by construction (the tool also counts any cap triangle facing against the plane's outward direction: `cap_inward_triangles`). Cap vertices copy the loop vertices' position and weights, UV is a planar fit 0..1, normal is the outward plane normal.
7. **Native mesh flaws.** A cut loop that meets a hairline slit in the source is bridged across gaps under 1 mm (`cap_gaps_bridged`). Source vertices are never moved (an opt-in `snapCracks: true` merges vertices closer than 0.15 mm; off because the validator wants every source vertex position kept). Open edges the source already had are counted separately (`open_edges_native`, against `source_open_edges`).

## Refinements of the contract's plane values (and why)

- **Shoulder planes are vertical.** The normal is the upper-arm bone with its vertical part dropped. A plane square to a slightly drooping arm (the Minotaur's arm points 10 degrees down) tilts into the flank and hands the arm a slab of ribs: with the bone normal the Minotaur's arm piece started at y 1.185 m, with the vertical plane at 1.27 m.
- **Hip planes pass through the crotch.** Left and right hip planes meet along the midline. With the thigh-normal planes the wedge below both planes held the crotch skin, so the leg pieces needed a wall between them (a non-planar, folded cap). The tool finds the crotch apex (scanning down from the hip joint for the height where the left and right legs' innermost bone-weighted vertices reach the midline: Minotaur y 0.8174 in the row frame, Psyche 0.8517) and turns each hip plane about the UpLeg joint the least that puts it through the apex (normal about 37 degrees off the thigh on the Minotaur). The wedge is empty, the leg caps are flat, and no extra plane is needed (an internal `hip_split` bisector stays in the manifest, flagged `internal`, for stray mesh; it has no cap). `crotchPlanes: false` gives the plain contract planes.
- Neck and waist are as the contract says.

## Stats on the two bodies (V3 `rig/106-default`, via opentrident.org/models/custom/*-106-v3-web.glb)

| | Minotaur-106 | Psyche-106 |
|---|---|---|
| vertices in / out (+ cap vertices) | 24,422 / 26,605 (+1,444) | 34,164 / 46,979 (+1,450) |
| triangles in / out | 44,278 / 47,088 | 54,961 / 69,293 |
| triangles split | 1,409 | 6,102 |
| orphan weights | 0 | 0 |
| every cap present (12) | yes | yes |
| open edges at the cuts (piece + caps) | 2 (head 1, torso 1: a hairline slit in the source mesh at the front of the neck, left of centre) | 6,992 (hair cards cut by the planes) |
| open edges native to the source (source had) | 8 (6) | 8,875 (7,413) |
| non-manifold edges (source had) | 0 (0) | 56 (4) |
| cap triangles facing inward | 0 | 25 |
| file | 2.9 MB (animations + textures kept) | 4.7 MB |

Minotaur: root, both arms and both legs have no open edge at all; the only open edges are the neck slit (torso 7, head 3 incl. the slit's own) . The manifest says it region by region: `stats.watertight_by_region`.

### tools/cut-validate.mjs (all 8 checks)

| check | Minotaur-106 | Psyche-106 |
|---|---|---|
| 1 structure | PASS | PASS |
| 2 watertight | FAIL: upper_torso 7, head 3 open edges (the neck slit) | FAIL: open hair cards in 10 pieces (root 2,372, torso 1,442, head 524, arms 3,958 / 2,909, legs 2,403 / 2,187 open edges; 8 over-used edges) |
| 3 orientation | PASS | FAIL: legs 19 + 17 flipped-winding edges (overlapping hair cards) |
| 4 weights | PASS | PASS |
| 5 bone_side | PASS | PASS |
| 6 caps | PASS | FAIL: 5 caps with a few triangles against their normals (7/108, 7/114, 1/72, 5/282, 5/282) |
| 7 conservation | PASS (22,183 source vertices all present, area equal) | PASS (31,438) |
| 8 planes | PASS (1e-4) | PASS |

The full tables are saved beside the outputs (`<body>.validate.txt`).

## Limits (plain)

- **The Minotaur's neck slit.** The source mesh has a hairline hole (0.09 mm wide, 1.5 mm long) where the neck plane crosses it. The loop is bridged and capped; the hole's two edges stay open on each side. Not visible at any scale a phone shows.
- **Psyche's hair.** Her hair is open geometry (cards) hanging to her knees. Every plane it crosses cuts it, each part goes to the piece the plane says and is re-bound to that piece's bones; an open card cannot be capped, so those cuts stay open (3,276 open chains, 6,992 open edges at the cuts, mostly in root, arms, legs; 8,875 more are native, the source has 7,413). Validator on Psyche: structure, weights, bone_side, conservation, planes pass; watertight fails (open hair cards, 56 non-manifold edges vs 4 in the source), orientation fails (19 + 17 flipped-winding edges in the leg pieces, overlapping hair cards at y 0.7 to 0.8, z -0.5 to -0.7), caps fails (5 problems: 7 of 108 and 7 of 114 hip-leg cap triangles, 1 of 72, and 5 of 282 waist cap triangles wind against their normals: ear clipping forced 24 ears on loops that touch themselves where hair layers meet the body, 25 cap triangles face inward in all). A hair-aware pass (peel hair fragments out by material and give them to the head piece, capped by a skirt) is the next step; it needs a ruling because it breaks the "piece stays on its side of the plane" rule the validator enforces.
- **Seams while intact.** Region meshes are always visible and each piece is bound only to its own side's bones, so at a seam where the two bones rotate relative to each other (a raised arm, a turned head) the two pieces no longer share a skinning blend and a hairline gap can open on one side of the seam. That is the contract's re-bind rule (it is what makes the cut piece not stretch); it is smallest at the neck (mid-neck plane, small relative rotation) and largest at the shoulder. Check the 8-angle render at an extreme pose before shipping a body; the fix, if needed, is a runtime one (a thin overlap skirt on the cap, or the cap shown during violent poses), not a mesh one.
- **Four influences.** Interpolated vertices and re-bound vertices keep the four largest weights (renormalised): 12 vertices on the Minotaur and 7 on Psyche lost a fifth influence. `JOINTS_1` (more than four influences per vertex) and morph targets are refused with a clear error.
- **One skin.** A second skin with the same joints (Psyche's eyelashes) is merged into the first; a skin with a joint the first lacks is refused.
- **Region by plane and bones, not by hand.** A body whose limbs cross the infinite planes in ways the bones do not explain (arms down in an A-pose with hands below the hip plane) is handled by the bone rule, not verified; the two bodies here are T-pose. Run `--debug` on a new body and read `reassigned`.
- **Extra splits.** Planes are infinite, so a triangle far from the cut but crossed by a plane (the Minotaur's feet beyond the shoulder plane, hair strands across the hip plane) is split and then re-joined in one region: harmless, but it adds vertices (Psyche 34,164 to 42,913, mostly her hair).
- **No `cap_inner`.** Only `cap_flesh` is written; a data row can still pick colours at runtime.
- **Textures** are copied as they are; caps use their own flesh material and no texture.

## Tests

`test/cut-units.test.mjs` (run on the VPS; `npm test` includes it). A synthetic skinned body (a column across the waist and neck planes, two strands and a hollow square tube across the neck plane so the cut has several loops and a hole, two legs across the hip planes, two arms across the shoulder planes in a second material, an eyelash mesh with its own skin) with floor-lifted measure row. Asserts: manifest valid against the contract; one skin, 7 + 12 skinned meshes, materials kept; surface area conserved to 1e-9 and every vertex away from a plane in exactly one piece; every piece with its caps watertight (each welded edge shared by exactly two triangles, no degenerate triangle); no vertex bound across a cut by bone name; cap triangles and normals outward and cap areas equal the section areas (column + strands + tube annulus); determinism (same bytes twice); the CLI; a mismatched measure row refused; the triangulator on a hole and on collinear boundary vertices. When `/root/bodies/{minotaur,psyche}-106.glb` (or `CUT_BODIES_DIR`) exist the same checks that make sense run on the real bodies; the GLBs are not in the repo (licence).
