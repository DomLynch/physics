# V3 body measure rows (65-joint rig)

Rows in `data/bodies/<name>.measure.json`, derived by `tools/glb-measure.mjs` from the bind pose of Frankendom V3 `src/assets/<name>.glb` (V3 main 0cbcba5, 2026-10-26) with the rig map `data/rig-maps/v1-65.json` (given by Frankendom v3 Dev). The GLBs are not committed; rebuild a row with
`node tools/glb-measure.mjs <path>/<name>.glb data/rig-maps/v1-65.json data/bodies/<name>.measure.json`.

Source per field: lengths and joint positions are measured from the GLB joint tree (world matrices). `chest_w`, `waist_w`, `hip_w`, `chest_d` are NOT measured: they are the proportions of OpenTrident's reference body (see `proportions_source` in each row), so mass is an estimate.

Measured length / ragdoll capsule length (m), from `test/bodies.test.mjs` (limit: within 12 percent; they agree to 0.0003 m):

| body | height | upper arm | forearm | thigh | shin | neck | ragdoll mass (kg) |
|---|---|---|---|---|---|---|---|
| minotaur | 1.6765 | 0.2298 / 0.22992 | 0.2456 / 0.24563 | 0.4196 / 0.41952 | 0.3706 / 0.37065 | 0.0967 / 0.09669 | 44.85 |
| psyche | 1.6194 | 0.2457 / 0.24567 | 0.236 / 0.23599 | 0.4128 / 0.41281 | 0.4125 / 0.41249 | 0.0817 / 0.08171 | 31.94 |
| warrior | 1.7357 | 0.2768 / 0.2768 | 0.2787 / 0.2787 | 0.4168 / 0.41683 | 0.3928 / 0.39282 | 0.0852 / 0.0852 | 45.23 |
| veteran (Centurion) | 1.6834 | 0.226 / 0.22602 | 0.2192 / 0.21922 | 0.4159 / 0.4159 | 0.445 / 0.44501 | 0.0804 / 0.08045 | 46.34 |

## 106-joint boss bodies (Frankendom-v3 `src/assets/<name>-106.glb`, rig map `data/rig-maps/mixamo-106.json`)

Demon (PR 182, head 4e32b08), Warrok (PR 183, head 0aee9ea), Brute (PR 184, head 20dcf39), Maw (PR 185, head 54d6706). Rows in `data/bodies/<name>-106.measure.json`; cut rows in `data/cut-bodies.json` (`docs/CUT-BATCH.md`).

| body | height | ragdoll mass (kg) | cut result |
|---|---|---|---|
| demon-106 | 2.1028 | 83.63 | BLOCKED (watertight, orientation, planes) |
| warrok-106 | 2.2177 | 140 | BLOCKED (watertight, caps) |
| brute-106 | 2.0916 | 87.54 | PASS |
| maw-106 | 1.901 | 117.66 | BLOCKED (watertight, planes) |

Known gap, same as above: the widths are proportions of the reference body, not mesh girths, so these masses are estimates (Warrok sits at the 140 kg clamp).

**Known gaps:** the masses (32 to 46 kg) are low for fighters of this height because the widths are proportions, not mesh girths; the heights assume the head reaches 1.9 times the neck-to-head joint span above the head joint. Both should be replaced by measures from the skinned mesh when V3 or OpenTrident has them (OpenTrident owns measure rows). Mesh node scale (the GLBs carry a 0.9 / 0.97 scale on the mesh node) is not applied.

## Hub NPC bodies (ARMAGEDOM PR 452, `npc-*.glb`, 106 joints, rig map `mixamo-106.json`)

Rows are named by BODY id: `mh-male-01` (Brannock), `mh-gen-v2-0036` (Ines), `mh-gen-v2-0020` (Marrow). Built with `tools/glb-measure.mjs` (unchanged), then `height_m` replaced by the real mesh height.

| body | glb-measure height | real mesh height | game lookup | row mass (kg) |
|---|---|---|---|---|
| mh-male-01 | 1.5744 | 1.7387 | 1.774 | 46.51 |
| mh-gen-v2-0036 | 1.5402 | 1.7137 | 1.749 | 48.34 |
| mh-gen-v2-0020 | 1.4562 | 1.6582 | 1.693 | 35.27 |

Why glb-measure read 9 to 12 percent short: not accessor quantisation (it reads joint node transforms, never accessors). These GLBs are gltfpack output: POSITION is normalised int16 filling [-1, 1] and the dequantisation (scale about 0.83 to 0.87) is folded into the inverse bind matrices, so the mesh node carries no transform. The shortfall is the head-top heuristic (head joint + 1.9 x neck-to-head span; a Mixamo neck span is about 0.04 m) plus the toe joint sitting above the sole. The real height is the skinned mesh at the bind pose (meshopt decode, then joint world x inverse bind per vertex). The game lookup is the mesh height plus about 0.035 m on all three.

Mass stays an estimate (widths are proportions of the reference body): the generator gives 35 to 48 kg against the 65 kg lookup mass for mh-male-01 (46.5 kg). Mesh girths are the fix and are not in this PR.
