# Cut source repair (experiment: veteran-65)

`tools/cut-source-repair.mjs <in.glb> <out.glb> --mesh CreatureBody [--keep-over-used]` writes a cleaned COPY of a body GLB for cutting only. The original is never
written. It edits triangle indices of the named skinned meshes and nothing else: vertices, normals, UVs, joints and weights stay byte-identical (the input goes through
`decompressGlb`, so the copy is plain float32 metres, the same space the cut reads). The copy is confidential like the source and stays out of git (VPS: `/root/cut-out/v3/`).

Two repairs, judged with the validator's welder (1e-5, all skinned meshes welded together):

1. over-used edges: keep the best pair of triangles (opposite traversal first, then flattest, then largest surface), delete the rest. Skipped by `--keep-over-used`.
2. winding: flood-fill over two-triangle edges, flip the smaller side of each connected surface.

## Result on V3's veteran (sha256 79857ca8…aa859d), measured 2026-10-27 on the VPS

| copy | source `--self` (open / over-used / flipped) | cut-batch veteran-65 |
|---|---|---|
| original | 2,003 / 1,765 / 49 | FAIL watertight + orientation (6 + 15 root; 1,054 flipped in piece_root) |
| winding only (45 triangles flipped, 0.0007 m² of 9.28) | 2,003 / 1,765 / 0 | FAIL, identical numbers to the original |
| over-used deleted (2,127 triangles, 0.032 m², 0.3%) and winding (6,327 triangles flipped) | 4,557 / 0 / 1,222 | FAIL, worse: about 900 introduced open edges at the hips |

Conclusion: the 1,054 flipped edges are not in the source. They come from the cap fill over self-overlapping section loops where the hip plane (y about 1.0) slices the
overlapping pelvis and thigh shells (neck: 12 open edges at y 1.53). A clean pass needs the shells merged into one manifold body (boolean union, weight transfer,
new UVs), which redraws the surface and is an art decision. Validators were not loosened; the veteran-65 row stays `blocked` with this cause.
