# Cut-piece validator

`tools/cut-validate.mjs` checks a `<body>.cut.glb` + `<body>.cut.manifest.json` against `docs/CUT-CONTRACT.md`. It is independent of the tool that makes the files: it reads the GLB by hand (JSON chunk + BIN chunk, accessors for POSITION, NORMAL, TEXCOORD_0, JOINTS_0, WEIGHTS_0 and indices, strides and normalised integers handled) and has no dependency beyond `src/sha256.mjs`.

```
node tools/cut-validate.mjs <body.cut.glb> <body.cut.manifest.json> [--source <body.glb>] [--json] [--hash] [--plane-offset x,y,z]
node tools/cut-validate.mjs <file.glb> --hash        # only the sha256 of the bytes (determinism: run the tool twice, compare)
```

Prints a table (PASS / FAIL / SKIP per check, per-piece open-edge counts, the first violations) and exits 1 on any failed check. `--json` prints the full result. `--hash` adds the GLB's sha256 to the output. `--plane-offset` shifts the manifest planes if they are in a different frame than the GLB (the measure rows put the toes on y = 0; the GLB may not): pass the manifest's `plane_frame.bind_offset` (`docs/CUT-TOOL.md`).

```
node tools/cut-validate.mjs <plain.glb> --self [--json]
```
`--self` prints the defects a surface already has (open edges, over-used edges, flipped-winding edges, the whole GLB welded as one group): run it on the plain source to see what the cut inherits.

## Native versus introduced (watertight and orientation)

A source mesh can have open edges (hair cards, a hairline slit), and a cut that leaves them alone must not fail for them. With `--source`, the validator welds the source surface as one group, lists its defects, and sorts every defect of a piece (with its caps) into:

- **native**: the output edge lies on a source edge that has the same defect. An open or over-used output edge is native when both its ends are within 0.05 mm of one source open (or over-used) edge, so the two halves of a source edge that the cut split at a plane are native too. A flipped-winding output edge is native when it lies on a flipped source edge. An open output edge shorter than 1 mm whose two ends both lie on source open edges is native as well: it is the cap's closing chord across a hairline hole the source already had (the Minotaur's neck slit), which has no piece edge to meet.
- **introduced**: everything else (an edge the source had closed, or wound consistently, that the cut left open, over-used or flipped).

`watertight` and `orientation` **pass when no defect was introduced** and report the native count (`every piece with its caps is closed except N edge(s) native to the source (...); none introduced`; the table shows per piece `open edges (n native)`). They fail on introduced defects, and the details list those only. Without `--source` there is nothing to be native to, so every defect counts as introduced (the strict behaviour). Nothing else is relaxed: a hole the cut made in a closed surface, a cap that leaves a cut open, or a flipped cap fail as before.

## plane_exempt (hair on the head piece)

The manifest may carry `plane_exempt: { "piece_head": ["<material>", ...] }` and a non-empty `plane_exempt_reason` (Physics Dev ruling, `docs/CUT-CONTRACT.md`: hair goes whole to the head, re-bound to the Head bone, and hangs below the neck plane). The validator honours it for the **`planes` check only**: vertices of a primitive with a listed material are not tested against the planes. It also leaves them out of the piece centroid that the `caps` outward test uses (hair hanging below the cap would otherwise drag the head's centroid under its own neck cap). Everything else applies to those vertices: `weights`, `bone_side` (a Head-only binding is on the head's side; a weight on Neck is not), `watertight`, `orientation`, `caps` and `conservation`. `structure` rejects a `plane_exempt` with no reason, a piece that is not a `piece_*` mesh, or a material the piece does not use. The planes line says how many vertices were not checked.

## Checks

| check | what it verifies |
|---|---|
| `structure` | manifest schema `cut-pieces/1`; the seven `piece_*` and twelve `cap_*` meshes exist and match the manifest (region, `shown_when_cut`, `detached_by`); exactly one skin and every piece and cap is skinned with it; with `--source`, the skeleton joints and their parents are unchanged |
| `watertight` | each piece plus its caps: every undirected edge is used by exactly two triangles, vertices welded by position within 1e-5 so UV or normal seams are not holes. Reports open-edge and over-used-edge counts per piece (with `--source`: how many are native to the source) and the world position of the first three introduced edges. Passes when the cut introduced none (see below) |
| `orientation` | the two triangles on a shared edge traverse it in opposite directions (no flipped winding); native flipped edges are reported, introduced ones fail |
| `weights` | every vertex sums to 1 within 1e-3, no NaN or negative, joints inside the skin, at most 4 influences (no weight in `WEIGHTS_1`) |
| `bone_side` | no vertex of a piece or its caps is bound to a bone on the other side of a cut. The side sets come from the skeleton tree and the manifest planes: a bone is on the positive side of a plane when it is at or beyond it and its nearest joint ancestor is not; that bone and its descendants are the positive subtree (neck: Head and below; shoulder: the arm; hip: the leg; waist: Spine and everything above). A region may use only bones on its own side of every plane it touches |
| `caps` | each cap has triangles, `TEXCOORD_0`, `NORMAL`; the mean normal points from the piece centroid toward the cap centroid; the winding agrees with the stored normals and faces outward |
| `conservation` | needs `--source`: sum of piece triangle areas (caps excluded) within 1 percent of the source, bounding box equal (1e-4), every welded source vertex present among the pieces' vertices. Skipped, not failed, without `--source` |
| `planes` | every vertex of a piece and its caps is on its side of its manifest planes within 1e-4 (no overlap across a cut); vertices of a manifest `plane_exempt` material are skipped (below) |

Plane keys in the manifest are matched loosely (`neck`, `waist`, `shoulder_left` / `shoulderL` / `shoulder_right`, `hip_left` ...). Region sides: head is beyond the neck plane; upper torso is below the neck, above the waist and inside both shoulder planes; root is below the waist and above both hip planes; an arm is beyond its shoulder plane; a leg is beyond its hip plane.

## Tests

`test/cut-validate.test.mjs` builds a stack of boxes on an 8-joint skeleton (Hips, Spine, Neck, Head, two arms, two legs: eight, not five, because seven pieces need both arms and both legs) with seven pieces and twelve caps generated in the test, a valid variant that passes, and one broken variant per check: a hole (`watertight`), a weight sum off (`weights`), a head vertex on the Neck bone (`bone_side`), an inward cap normal (`caps`), a plane the head overlaps (`planes`), a missing cap mesh (`structure`), plus a missing source area (`conservation`) and the CLI exit codes. Cases for the hair and edge rules: a hair card with its own material across the neck plane (passes with `plane_exempt`, fails `planes` without it, still fails `bone_side` when half its weight is on Neck, does not excuse the head's own surface across the plane, `plane_exempt` without a reason or naming an unknown piece or material fails `structure`); a hole the source has too (native: passes with `--source`, fails without it), an introduced hole (fails), a native open edge the cut split in two halves (native), a flipped triangle the source has too (native) and one the cut made (fails `orientation`), and `surfaceReport` / `--self`. Run on the VPS: `node --test test/cut-validate.test.mjs`.
