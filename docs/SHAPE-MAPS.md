# Shape maps (106 rig)

One ragdoll map per body SHAPE instead of one 30 KB row per body. `data/shape-maps/`:

| file | what |
|---|---|
| `<shape>.map.json` (7 files, about 1.8 KB each) | per role joint: end joint, parent, capsule radius `r` and length `l` (fractions of height), mass `m` (fraction of body mass), limit `j` (ball swing/twist or hinge min/max, degrees) |
| `body-shapes.json` (19.5 KB, 582 bodies) | body id -> `[shapeIndex, height_mm, girth_x100, mass_kg_x10]` |
| `rig-106-follow.json` (4.4 KB) | the 106 joint names; the 86 non-role joints (fingers, shoulders, twist, fk_*) -> the role joint they ride on |
| `REPORT.json` | per shape: size, families, fit error, scale outliers |

Use: `radius_m = r * height_m * girth`, `length_m = l * height_m`, `mass_kg = m * body_mass`; node name = `mixamorig:` + key with `{S}` -> `Left`/`Right`; `end: null` + `ext` = extension of `ext * height` beyond the joint along the parent bone (head, hand, toe). Limits are the role table's (`data/ragdoll-role-table.json`); mass fractions across roles are the table's too, so only radius, length and absolute mass differ by shape.

Shapes (k-means on ln height, ln volume/height^3, leg share; children under 1.45 m split off first): child, average-medium, average-heavy, tall-medium, giant-slim, giant-heavy, giant-massive. The 140 kg mass clamp of the role table hits every giant-massive body and most giant-heavy ones: their masses are the clamp, not a measure.

Regenerate (inputs are OpenTrident measure rows, not committed): `node tools/shape-maps.mjs --out data/shape-maps --glb <any 106 glb> --reference <temp1-measure.json>:mh-male-01 --measure family=<rows.json>[#idRegex] ...`. Check on real GLBs: `node tools/shape-maps-validate.mjs body.glb ...`.

Not in the lookup: the 19-joint vagrant-106 (its own rig map `mixamo-19`) and the 65-joint rig (never). Scale outliers (the-boss 0.54 m, pirate-by-p-konstantinov 0.65 m, remy 3.65 m) are assigned to their nearest shape but kept out of the fit: their Mixamo rows look like GLB node-scale errors.
