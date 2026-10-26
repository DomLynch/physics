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

**Known gaps:** the masses (32 to 46 kg) are low for fighters of this height because the widths are proportions, not mesh girths; the heights assume the head reaches 1.9 times the neck-to-head joint span above the head joint. Both should be replaced by measures from the skinned mesh when V3 or OpenTrident has them (OpenTrident owns measure rows). Mesh node scale (the GLBs carry a 0.9 / 0.97 scale on the mesh node) is not applied.
