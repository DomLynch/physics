# Cut-piece validator

`tools/cut-validate.mjs` checks a `<body>.cut.glb` + `<body>.cut.manifest.json` against `docs/CUT-CONTRACT.md`. It is independent of the tool that makes the files: it reads the GLB by hand (JSON chunk + BIN chunk, accessors for POSITION, NORMAL, TEXCOORD_0, JOINTS_0, WEIGHTS_0 and indices, strides and normalised integers handled) and has no dependency beyond `src/sha256.mjs`.

```
node tools/cut-validate.mjs <body.cut.glb> <body.cut.manifest.json> [--source <body.glb>] [--json] [--hash] [--plane-offset x,y,z]
node tools/cut-validate.mjs <file.glb> --hash        # only the sha256 of the bytes (determinism: run the tool twice, compare)
```

Prints a table (PASS / FAIL / SKIP per check, per-piece open-edge counts, the first violations) and exits 1 on any failed check. `--json` prints the full result. `--hash` adds the GLB's sha256 to the output. `--plane-offset` shifts the manifest planes if they are in a different frame than the GLB (the measure rows put the toes on y = 0; the GLB may not).

## Checks

| check | what it verifies |
|---|---|
| `structure` | manifest schema `cut-pieces/1`; the seven `piece_*` and twelve `cap_*` meshes exist and match the manifest (region, `shown_when_cut`, `detached_by`); exactly one skin and every piece and cap is skinned with it; with `--source`, the skeleton joints and their parents are unchanged |
| `watertight` | each piece plus its caps: every undirected edge is used by exactly two triangles, vertices welded by position within 1e-5 so UV or normal seams are not holes. Reports open-edge and over-used-edge counts per piece and the world position of the first three open edges |
| `orientation` | the two triangles on a shared edge traverse it in opposite directions (no flipped winding) |
| `weights` | every vertex sums to 1 within 1e-3, no NaN or negative, joints inside the skin, at most 4 influences (no weight in `WEIGHTS_1`) |
| `bone_side` | no vertex of a piece or its caps is bound to a bone on the other side of a cut. The side sets come from the skeleton tree and the manifest planes: a bone is on the positive side of a plane when it is at or beyond it and its nearest joint ancestor is not; that bone and its descendants are the positive subtree (neck: Head and below; shoulder: the arm; hip: the leg; waist: Spine and everything above). A region may use only bones on its own side of every plane it touches |
| `caps` | each cap has triangles, `TEXCOORD_0`, `NORMAL`; the mean normal points from the piece centroid toward the cap centroid; the winding agrees with the stored normals and faces outward |
| `conservation` | needs `--source`: sum of piece triangle areas (caps excluded) within 1 percent of the source, bounding box equal (1e-4), every welded source vertex present among the pieces' vertices. Skipped, not failed, without `--source` |
| `planes` | every vertex of a piece and its caps is on its side of its manifest planes within 1e-4 (no overlap across a cut) |

Plane keys in the manifest are matched loosely (`neck`, `waist`, `shoulder_left` / `shoulderL` / `shoulder_right`, `hip_left` ...). Region sides: head is beyond the neck plane; upper torso is below the neck, above the waist and inside both shoulder planes; root is below the waist and above both hip planes; an arm is beyond its shoulder plane; a leg is beyond its hip plane.

## Tests

`test/cut-validate.test.mjs` builds a stack of boxes on an 8-joint skeleton (Hips, Spine, Neck, Head, two arms, two legs: eight, not five, because seven pieces need both arms and both legs) with seven pieces and twelve caps generated in the test, a valid variant that passes, and one broken variant per check: a hole (`watertight`), a weight sum off (`weights`), a head vertex on the Neck bone (`bone_side`), an inward cap normal (`caps`), a plane the head overlaps (`planes`), a missing cap mesh (`structure`), plus a missing source area (`conservation`) and the CLI exit codes. Run on the VPS: `node --test test/cut-validate.test.mjs`.
