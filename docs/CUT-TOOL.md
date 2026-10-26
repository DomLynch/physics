# tools/cut-units.mjs: one body GLB into seven pieces and twelve caps

The mesh pipeline behind `docs/CUT-CONTRACT.md`. It reads a skinned humanoid GLB, its measure row and its rig map, and writes `<body>.cut.glb` and `<body>.cut.manifest.json`: seven `piece_*` skinned meshes and twelve `cap_*` skinned meshes on the unchanged skeleton, the original materials plus `cap_flesh`. Rendering and the runtime (`createCutRig`) are not part of this tool.

## Run

```
node tools/cut-units.mjs <body.glb> <body.measure.json> <rig-map.json> <out-dir> [--body name] [--debug]
node tools/cut-units.mjs minotaur-106.glb data/bodies/minotaur-106.measure.json data/rig-maps/mixamo-106.json out/
```

Needs `@gltf-transform/core`, `@gltf-transform/extensions` and `meshoptimizer` (devDependencies: the V3 106 bodies are meshopt-compressed and webp-textured, and the tool reads and writes through gltf-transform; nothing in the package's runtime loads this file). Runs in about two seconds per body. `--body` names the output files and the manifest `body` (default: the measure row's `id`). `--debug` prints which fragments the bones moved, the cap loops per region and the re-bind counts. Same input, same output bytes (no clocks, no random, every map ordered).

`opts` of `cutGlb(bytes, row, rigMap, opts)` (the function the CLI wraps): `body`, `rig`, `source` (manifest strings), `debug`, `crotchPlanes: false` (plain thigh-normal hip planes).

The output keeps the animations, textures and node names of the source. It is **not** meshopt- or quantisation-compressed: the cut vertices are float32 so that a piece and its cap carry bit-identical positions. Compressing afterwards with a lossless-position step is fine; a quantising step reopens 0.01 mm gaps along the cuts (invisible, but it breaks an exact watertight check).

## Method

1. **Frames.** The measure row is floor-lifted (`tools/glb-measure.mjs` puts the toes on y = 0). The tool recovers that offset from the 20 role joints (refusing a row that does not fit the GLB beyond 2 mm) and works in the GLB's bind-pose world. Quantised bodies (gltfpack) keep their vertices in a normalised space and bake the dequantisation into the inverse binds; the tool finds that matrix (`jointWorld x inverseBind`, the same for every joint) and does all geometry in metres, writing positions back in the stored space. The manifest carries `plane_frame.vertex_to_world`, `bind_offset` and `crotch_apex`. Plane points in the manifest are in the measure row's frame.
2. **Planes** (contract start values, with two refinements, below). Neck: half way Neck to Head, normal along Neck to Head. Waist: the Spine joint, normal Hips to Spine. Shoulders: the Arm joint. Hips: the UpLeg joint.
3. **Split.** Every triangle is cut at every plane it crosses (Sutherland-Hodgman). A new vertex on an edge gets position, normal, tangent (if present), every UV set, any other float attribute, and all skin weights interpolated; it is created once per edge and plane (looked up by the edge's two end positions, so UV-seam duplicates of one edge get bit-identical split points) and shared by every triangle on that edge. A vertex within 0.09 mm (5e-5 of the height) of a plane counts as on it, so no sliver triangles. Never assigned whole: no gap and no ledge.
4. **Fragments and regions.** Cutting gives cells (the sign pattern over the planes). Within a cell, connected pieces of mesh (welded by position) are fragments. A fragment goes to the region its cell names (head above the neck plane, an arm beyond its shoulder plane, a leg below its hip plane, upper torso above the waist, root otherwise; priority head, arms, legs, torso). **Unless its bones disagree:** when the cell's region owns under 20 percent of the fragment's skin weight, the region owning most of it takes the fragment. This is what makes the planes safe on a real body, where an infinite plane also crosses unrelated mesh: a foot beyond the shoulder plane's far side stays in its leg, a tail across the hip bisector stays in the root, hair hanging below the neck plane stays with the head ("gear follows its bone", contract). Where two fragments of one region meet across a plane, the shared split vertices make them one surface again, so no cap appears there.
5. **Bone ownership and re-bind.** Each bone belongs to the region of its nearest ancestor-or-self among Hips (root), Spine (upper torso: Spine, Spine1, Spine2, Neck, shoulders), Head (head, hair, jaw...), LeftArm / RightArm (arm), LeftUpLeg / RightUpLeg (leg, feet, toes, twist bones). A piece keeps weights on its own bones and moves every other weight to the nearest bone it does own (tree distance; Neck goes to Head in the head piece, Head goes to Neck in the torso piece, Hips goes to UpLeg in a leg), merges duplicates, keeps the four largest, renormalises to 1. `orphan_weights` counts influences left on a foreign bone after this: 0 on both bodies.
6. **Caps.** For each piece, the boundary edges that lie on a cut plane are chained into loops; a loop along two cap planes (the root's lower edge where the two hip planes meet) is cut at the two points where it changes plane and each half closed by a straight chord, so every cap is flat. Loops are triangulated by **ear clipping with hole bridging** (outer rings and holes by orientation and containment, so a hollow tube or a horn crossing the plane gives a ring with a hole), keeping every loop vertex (a dropped collinear vertex would leave a T-junction against the piece). Cap triangles are wound to meet the piece's edges the other way round, so the outward normal comes out by construction (the tool also counts any cap triangle facing against the plane's outward direction: `cap_inward_triangles`). Cap vertices copy the loop vertices' position and weights, UV is a planar fit 0..1, normal is the outward plane normal.
7. **Native mesh flaws.** Vertices closer than 0.15 mm are snapped together first (the bodies have hairline UV-seam cracks; `crack_vertices_snapped`), and a cut loop that meets a hairline slit is bridged across gaps under 1 mm (`cap_gaps_bridged`). Open edges the source already had are counted separately (`open_edges_native`, against `source_open_edges`).

## Refinements of the contract's plane values (and why)

- **Shoulder planes are vertical.** The normal is the upper-arm bone with its vertical part dropped. A plane square to a slightly drooping arm (the Minotaur's arm points 10 degrees down) tilts into the flank and hands the arm a slab of ribs: with the bone normal the Minotaur's arm piece started at y 1.185 m, with the vertical plane at 1.27 m.
- **Hip planes pass through the crotch.** Left and right hip planes meet along the midline. With the thigh-normal planes the wedge below both planes held the crotch skin, so the leg pieces needed a wall between them (a non-planar, folded cap). The tool finds the crotch apex (scanning down from the hip joint for the height where the left and right legs' innermost bone-weighted vertices reach the midline: Minotaur y 0.8174 in the row frame, Psyche 0.8517) and turns each hip plane about the UpLeg joint the least that puts it through the apex (normal about 37 degrees off the thigh on the Minotaur). The wedge is empty, the leg caps are flat, and no extra plane is needed (an internal `hip_split` bisector stays in the manifest, flagged `internal`, for stray mesh; it has no cap). `crotchPlanes: false` gives the plain contract planes.
- Neck and waist are as the contract says.

## Stats on the two bodies (V3 `rig/106-default`, via opentrident.org/models/custom/*-106-v3-web.glb)

| | Minotaur-106 | Psyche-106 |
|---|---|---|
| vertices in / out (+ cap vertices) | 24,422 / 26,605 (+1,444) | 34,164 / 42,913 (+1,308) |
| triangles in / out | 44,278 / 47,088 | 54,961 / 69,293 |
| triangles split | 1,409 | 6,102 |
| orphan weights | 0 | 0 |
| every cap present (12) | yes | yes |
| open edges at the cuts (piece + caps) | 2 (head 1, torso 1: a hairline slit in the source mesh at the front of the neck, left of centre) | 279, all in `piece_head` on the neck plane |
| open edges native to the source (source had) | 8 (6) | 8,904 (7,413) |
| non-manifold edges (source had) | 0 (0) | 259 (194) |
| cap triangles facing inward | 0 | 10 |
| file | 2.9 MB (animations + textures kept) | 4.7 MB |

`piece_root`, `piece_arm_left`, `piece_arm_right`, `piece_leg_left`, `piece_leg_right` have no open edge at all on the Minotaur and none at a cut on Psyche (her legs and arms keep 134 and 20 native open edges each, hair and cuffs of the source); `piece_upper_torso` has none at a cut on Psyche (30 native) and one on the Minotaur (the slit). The manifest says it region by region: `stats.watertight_by_region`.

## Limits (plain)

- **The Minotaur's neck slit.** The source mesh has a hairline hole (0.09 mm wide, 1.5 mm long) where the neck plane crosses it. The loop is bridged and capped; the hole's two edges stay open on each side. Not visible at any scale a phone shows.
- **Psyche's head.** Her hair is open geometry (cards), 8,566 of the head's open edges are native, and 279 more are open surfaces that cross the neck plane and cannot be capped (11 open chains; ear clipping forced 20 ears on the rings that remain, 10 cap triangles face inward). Long hair stays with the head piece by its bones (`piece_head` spans y 0.17 to 1.73 m and x +-0.6 m on Psyche): cutting her head takes the whole hair with it, as gear on the head bone should. If the game wants the hair to stay, a rule that peels fragments by material is the next step (it is one function: the fragment's region).
- **Seams while intact.** Region meshes are always visible and each piece is bound only to its own side's bones, so at a seam where the two bones rotate relative to each other (a raised arm, a turned head) the two pieces no longer share a skinning blend and a hairline gap can open on one side of the seam. That is the contract's re-bind rule (it is what makes the cut piece not stretch); it is smallest at the neck (mid-neck plane, small relative rotation) and largest at the shoulder. Check the 8-angle render at an extreme pose before shipping a body; the fix, if needed, is a runtime one (a thin overlap skirt on the cap, or the cap shown during violent poses), not a mesh one.
- **Four influences.** Interpolated vertices and re-bound vertices keep the four largest weights (renormalised): 12 vertices on the Minotaur and 7 on Psyche lost a fifth influence. `JOINTS_1` (more than four influences per vertex) and morph targets are refused with a clear error.
- **One skin.** A second skin with the same joints (Psyche's eyelashes) is merged into the first; a skin with a joint the first lacks is refused.
- **Region by plane and bones, not by hand.** A body whose limbs cross the infinite planes in ways the bones do not explain (arms down in an A-pose with hands below the hip plane) is handled by the bone rule, not verified; the two bodies here are T-pose. Run `--debug` on a new body and read `reassigned`.
- **Extra splits.** Planes are infinite, so a triangle far from the cut but crossed by a plane (the Minotaur's feet beyond the shoulder plane, hair strands across the hip plane) is split and then re-joined in one region: harmless, but it adds vertices (Psyche 34,164 to 42,913, mostly her hair).
- **No `cap_inner`.** Only `cap_flesh` is written; a data row can still pick colours at runtime.
- **Textures** are copied as they are; caps use their own flesh material and no texture.

## Tests

`test/cut-units.test.mjs` (run on the VPS; `npm test` includes it). A synthetic skinned body (a column across the waist and neck planes, two strands and a hollow square tube across the neck plane so the cut has several loops and a hole, two legs across the hip planes, two arms across the shoulder planes in a second material, an eyelash mesh with its own skin) with floor-lifted measure row. Asserts: manifest valid against the contract; one skin, 7 + 12 skinned meshes, materials kept; surface area conserved to 1e-9 and every vertex away from a plane in exactly one piece; every piece with its caps watertight (each welded edge shared by exactly two triangles, no degenerate triangle); no vertex bound across a cut by bone name; cap triangles and normals outward and cap areas equal the section areas (column + strands + tube annulus); determinism (same bytes twice); the CLI; a mismatched measure row refused; the triangulator on a hole and on collinear boundary vertices. When `/root/bodies/{minotaur,psyche}-106.glb` (or `CUT_BODIES_DIR`) exist the same checks that make sense run on the real bodies; the GLBs are not in the repo (licence).
