# M4 calibration: one strength number, from our own clips

Strategy ruling (COMBAT-101 items 16 and 17, A1 to A4, B2 to B5; binding): strength = tip speed x sharpness, three rungs (hit, stick, cut), measured on our clips, sharpness 1.0 for the baseline blade, donor multipliers kept only as ratios between weapons. Target behaviour: a normal full-speed LIGHT swing with the baseline blade lands between stick and cut on cloth; only a HEAVY swing or a COUNTER-HIT cuts; mail needs a heavy; plate needs a heavy plus the counter-hit; armour never blocks (a tier only multiplies a threshold, and a cut stays reachable for the strongest allowed hit).

This page supersedes the "Proposed thresholds" table of `docs/M4-MEASURE.md` (hand-speed rungs, no weapon). The hand speeds themselves are unchanged. Everything below is reproducible:

```
git -C ~/Developer/frankendom-v3 show origin/docs/ragdoll-poses:docs/ragdoll-fight-poses.json > /tmp/fight.json
node tools/tip-speed.mjs /tmp/fight.json data/bodies/minotaur.measure.json   # hand speeds, arm reach, lever and tip table
node tools/calibration-table.mjs                                              # the behaviour table (runs the evaluator)
```

## 1. Measured

Clip source: Frankendom V3 recorded fight dump `docs/ragdoll-fight-poses.json` (branch `docs/ragdoll-poses`, 902 ticks at 60 Hz, the Minotaur "pitborn" on the 65 rig fighting the hero). Body: `data/bodies/minotaur.measure.json`. 12 swings after the 28 pose snaps are removed; light / heavy is split by run duration at the median (0.2 s), a proxy because the dump has no clip labels.

Hand-end speed per swing (m/s, peak per swing):

| class | swings | p50 | p90 | p99 | max |
|---|---|---|---|---|---|
| all | 12 | 8.27 | 12.18 | 13.00 | 13.09 |
| light | 7 | 6.25 | 9.74 | 11.16 | 11.32 |
| heavy | 5 | 12.01 | 12.74 | 13.06 | 13.09 |

Arm reach (shoulder pivot to hand end at rest, the same chain the tool uses for the hand): 0.5634 m (left and right equal).

Lever = (arm reach + weapon length) / arm reach, tip speed = hand speed x lever. Weapon length is grip to blade tip along the weapon axis, `bladeTip.z - holdPoint.z` in the Gladio Mori `weapons-physics.csv` (donor number; no length exists in our rows, in `weapons.csv` or in the TABG data, so this is the only source). TABG Viking Axe and Shovel have no length anywhere: `length_m` is null with a todo.

| weapon | length m | lever | tip light p50 / p90 / p99 | tip heavy p50 / p90 / p99 |
|---|---|---|---|---|
| gm_dagger | 0.331 | 1.588 | 9.9 / 15.5 / 17.7 | 19.1 / 20.2 / 20.7 |
| **gm_gladius (baseline)** | 0.559 | 1.992 | 12.4 / 19.4 / 22.2 | 23.9 / 25.4 / 26.0 |
| gm_battleaxe | 1.040 | 2.846 | 17.8 / 27.7 / 31.8 | 34.2 / 36.2 / 37.2 |
| gm_katana | 0.969 | 2.720 | 17.0 / 26.5 / 30.4 | 32.7 / 34.6 / 35.5 |
| gm_rapier | 1.150 | 3.041 | 19.0 / 29.6 / 33.9 | 36.5 / 38.7 / 39.7 |
| gm_claymore | 1.164 | 3.066 | 19.2 / 29.9 / 34.2 | 36.8 / 39.1 / 40.0 |
| tabg_viking_axe, tabg_shovel | null | null | todo | todo |

(Tip speed before sharpness. The gladius arm 0.563 + 0.559 = 1.12 m matches the donor `reach_max_m` 1.15, a sanity check on the length number.)

## 2. Sharpness: a relative ratio, baseline 1.0

`strength_scale.baseline_weapon` = `gm_gladius`, the plain blade. Each weapon row carries `slash_sharpness` and `stab_sharpness` = donor multiplier divided by the baseline's (slash 2.92, stab 2.8), so the Gladio Mori numbers are ratios, not absolutes. The donor `slash_mult` / `stab_mult` columns stay in the rows as the source; a test pins each ratio to the division.

| weapon | slash | stab |
|---|---|---|
| gm_gladius | 1.000 | 1.000 |
| gm_katana, gm_claymore | 1.000 | 1.043 |
| gm_battleaxe | 0.997 | 1.000 |
| gm_dagger | 0.342 | 1.071 |
| gm_rapier | 0.342 | 1.143 |

The best slash ratio is 1.0 (nothing slashes sharper than the gladius in the donor data); the best stab ratio is 1.143 but stabs never sever. So the difference between weapons is the lever far more than the sharpness.

## 3. Chosen rungs and why

Rungs are weapon-tip m/s of strength at sharpness 1.0 for the baseline blade. They keep the percentiles of the first M4 measurement (hit = p10, stick = p50, cut = p90 of all 12 swing peaks) and move them to tip speed with the baseline lever 1.992:

| row | hand percentile | x lever | rung |
|---|---|---|---|
| `strength_scale.rung_hit` | p10 = 4.01 | 1.992 | **8.0** |
| `strength_scale.rung_stick` | p50 = 8.27 | 1.992 | **16.5** |
| `strength_scale.rung_cut` | p90 = 12.18 | 1.992 | **24.3** |
| `melee_speed_gate.min_speed_m_s` | p10 = 4.01 | 1.992 | **8.0** (tip speed) |

Why these satisfy the target: the full-speed light swing (hand p90 9.74, tip 19.4) sits between stick (16.5) and the cloth cut line (24.3 x 1.05 = 25.5); even the fastest measured light swing (p99 hand 11.16, tip 22.2) stays under it. A cut therefore needs more than a light swing can give.

`swing.heavy_mult` = **1.92**, `measured`: heavy p50 12.01 over light p50 6.25 (ratio 1.923). A heavy at the full-speed light reference is 19.4 x 1.92 = 37.3: over the mail line (36.5), under plate tier 2 (48.6). `swing.counter_hit_mult` = **1.75**, `own` start value (todo: measure): the smallest round value that lifts a heavy over the top plate line with a margin (needs at least 1.63; heavy alone cannot reach it and light + counter-hit 33.9 does not even cut mail).

Armour thresholds (cut rung x tier modifier): none 24.3, cloth 25.5, leather 27.9, mail 36.5, plate_t2 48.6, plate_t3 60.8. The tier rows themselves are unchanged (own start values).

Bone gate (`3 / sqrt(bone_mult) x armour modifier`, 2.7 to 3.0 m/s bare, 7.5 for plate_t3) is unchanged and still does not bind: it reads the physical tip speed and every swing is far above it.

## 4. Behaviour table (computed by `tools/calibration-table.mjs`)

One slash on a bare arm (`arm_off`, a severable unit), hand speeds from the rows (`swing.hand_speed_ref_m_s`), outcome word and strength / cut threshold of that tier in brackets (1.00 or more = cut).

Baseline blade, `gm_gladius` (lever 1.992, sharpness 1.0):

| swing (hand m/s) | tip m/s | none | cloth | leather | mail | plate_t2 | plate_t3 |
|---|---|---|---|---|---|---|---|
| light, typical (p50 hand 6.25) | 12.5 | hit (0.51) | hit (0.49) | hit (0.45) | hit (0.34) | hit (0.26) | hit (0.20) |
| light, full speed (p90 hand 9.74) | 19.4 | stick (0.80) | stick (0.76) | stick (0.69) | stick (0.53) | stick (0.40) | stick (0.32) |
| light + counter-hit | 19.4 | cut (1.40) | cut (1.33) | cut (1.22) | stick (0.93) | stick (0.70) | stick (0.56) |
| heavy | 19.4 | cut (1.53) | cut (1.46) | cut (1.33) | cut (1.02) | stick (0.77) | stick (0.61) |
| heavy + counter-hit | 19.4 | cut (2.68) | cut (2.56) | cut (2.33) | cut (1.79) | cut (1.34) | cut (1.07) |

Strongest weapon, `gm_claymore` (lever 3.066, slash sharpness 1.0; the strongest slash power = lever x slash sharpness among the rows):

| swing (hand m/s) | tip m/s | none | cloth | leather | mail | plate_t2 | plate_t3 |
|---|---|---|---|---|---|---|---|
| light, typical (p50 hand 6.25) | 19.2 | stick (0.79) | stick (0.75) | stick (0.69) | stick (0.53) | stick (0.39) | stick (0.32) |
| light, full speed (p90 hand 9.74) | 29.9 | cut (1.23) | cut (1.17) | cut (1.07) | stick (0.82) | stick (0.61) | stick (0.49) |
| light + counter-hit | 29.9 | cut (2.15) | cut (2.05) | cut (1.87) | cut (1.43) | cut (1.08) | stick (0.86) |
| heavy | 29.9 | cut (2.36) | cut (2.25) | cut (2.05) | cut (1.57) | cut (1.18) | stick (0.94) |
| heavy + counter-hit | 29.9 | cut (4.13) | cut (3.93) | cut (3.59) | cut (2.75) | cut (2.06) | cut (1.65) |

Cloth and "none" behave the same in the table (cloth 1.05 is a thin tier). A fall, a kill or a bleed is not shown: the table classifies the strength.

### The reachability number (armour never blocks)

Top plate line = rung_cut 24.3 x plate_t3 2.5 = **60.75**. Strongest allowed hit on the baseline blade: full-speed light tip 19.40 x heavy 1.92 x counter-hit 1.75 x best slash ratio 1.0 = **65.20**, which exceeds 60.75 (margin 7 percent). With the strongest weapon's lever (claymore, 3.066): **100.34**. Every tier is reachable; the top tier needs a heavy AND a counter-hit for the baseline blade and for the claymore. A test asserts this from the evaluator, not from the arithmetic.

## 5. What is measured, what is assumed, what is own

| item | status | note |
|---|---|---|
| hand speed p10 / p50 / p90 / p99 | measured | 12 swings, one fight, one body (Minotaur), one opponent |
| arm reach 0.5634 m | measured | Minotaur body rest chain; a body with another arm passes `armReachM` |
| rungs 8.0 / 16.5 / 24.3, gate 8.0 | measured percentiles, assumed lever | design call: p10 / p50 / p90 of the swing peaks |
| lever formula | assumed | the weapon continues the arm and the chain turns about the shoulder; the dump has no weapon axis |
| weapon length_m | assumed | donor numbers (Gladio Mori), the weapon axis taken as z; not our measurement |
| sharpness ratios | assumed | donor multipliers divided by the gladius; not measured on our clips |
| heavy_mult 1.92 | measured on a proxy | p50 / p50 of 5 duration-split "heavy" and 7 "light" swings; the p90 / p90 ratio is only 1.31 |
| counter_hit_mult 1.75 | own | picked so heavy + counter-hit clears the top plate line; todo: measure on counter-hit clips |
| armour tiers, bone gate, knockdown, budgets | unchanged | start values from the M4 rows |

Open points to hand back to Strategy:

- **Heavy double counting.** `heavy_mult` is the median heavy / light ratio. The measured heavy swings alone (hand p50 12.01 x 1.992 = 23.9 tip) sit just under the cut line (24.3), so a clip's own heavy speed without the multiplier would not cut cloth. The evaluator therefore expects the light-reference hand speed with `swing: "heavy"`, or the measured heavy speed with `swing: "light"`; feeding both counts the heavy twice (a heavy at 12.0 hand x 1.992 x 1.92 = 45.9 would sit at 94 percent of the plate tier 2 line). Re-measure on labelled charged clips.
- **Long weapons cut on a light swing.** At the same hand speed, a claymore (lever 3.07) or a rapier (3.04, but slash sharpness 0.34) swings faster at the tip. The claymore cuts cloth and leather with a full-speed light, and cuts plate tier 2 with a heavy alone; only the top plate still needs the counter-hit. That follows from COMBAT-101 A2 (a long arm or weapon swings a faster tip on the same clip), but it is a design call if two-handers should also need a heavy for cloth: the fix is a lower lever for two-handers or a slower hand speed row, not a block.
- **Margins are thin.** Heavy on mail is 1.02 of the line (2 percent); light + counter-hit on mail is 0.93. Both are deterministic but a small move of a rung flips them, which is why a test pins them.
## Strategy's rulings (2026-10-26, after PR 23)

1. **The 12-swing sample ships as the starting table.** Widen it as a data PR when V3's 106 clips land (Psyche's 32 plus the Pitborn set); measure counter-hit speed then. No hold on the V3 wire.
2. **Long weapons stay honest.** A claymore light swing cutting cloth is the point of a claymore. The balance lever is the weapon row (stamina cost, wind-up ticks, recovery), not a fake threshold or a lower lever.
3. **Thin margins are accepted while pinned by tests; each one is a deliberate ruling if it moves.** Pinned today (tests in `test/calibration.test.mjs`): heavy on mail 1.02 of the cut line (cuts); light + counter-hit on mail 0.93 (sticks); heavy + counter-hit on plate_t3 1.07 (cuts); light on cloth 0.76 (sticks, never cuts). Moving a rung (`strength_scale`), `heavy_mult` 1.92 or `counter_hit_mult` 1.75 flips these, so a change needs a ruling and the test changed in the same PR.

- Not measured (as of the first table; section 6 widens it): Mixamo and Hellish Quart library clips (on the donor store, not on this machine), special swings (no labels), counter-hit speeds, a real weapon tip.

## 6. Widened sample (2026-10-27, 106 rig): derivation, nothing re-pinned

Strategy ruling 1 above asked for the 12-swing table to be widened with V3's 106 clips. Tools: `tools/clip-swings.mjs` (hand-end speed of every melee clip baked in a 106 body GLB, same run detector as `tools/tip-speed.mjs`, rig map `data/rig-maps/mixamo-106.json`, hand end = the hand's Middle1 joint) and `tools/swing-sample.mjs` (merges them with the dump table into `data/m4-swing-sample.json`, derives the rungs; `node tools/swing-sample.mjs` prints the numbers below). Test: `test/calibration-sample.test.mjs`. The GLBs are read locally; the committed sample holds numbers and clip names only.

```
node tools/tip-speed.mjs ~/Developer/frankendom-v3/docs/ragdoll-fight-poses.json data/bodies/minotaur.measure.json --json /tmp/dump.json
node tools/clip-swings.mjs ~/Developer/frankendom-v3/src/assets/psyche-106.glb data/rig-maps/mixamo-106.json /tmp/psyche.json
node tools/clip-swings.mjs ~/Developer/frankendom-v3/src/assets/minotaur-106.glb data/rig-maps/mixamo-106.json /tmp/minotaur.json
node tools/swing-sample.mjs /tmp/dump.json /tmp/psyche.json /tmp/minotaur.json
```

Sample: 12 fight-dump swings (Minotaur, 65 rig) + 23 Psyche-106 clip swings + 5 Minotaur-106 clip swings = **40** (9 more Psyche `Skill_*` swings kept apart as special). Clips read: Attack, Riposte, Cut_Outward, Cut_OutwardMirror, Stab (light), Heavy, Heavy_Gladius (heavy), Skill_WitchArm, Skill_Pommel (special). Light / heavy now come from the clip label, not from run duration. The Minotaur-106 GLB carries only Attack, Heavy and Riposte of these (no Stab, Cut_Outward, Heavy_Gladius, Skill_*).

| hand m/s | n | p10 | p50 | p90 |
|---|---|---|---|---|
| 12-swing dump (the pins) | 12 | 4.01 | 8.27 | 12.18 |
| 106 clips only | 28 | 2.16 | 5.66 | 10.76 |
| **all 40** | 40 | 2.28 | 6.05 | 11.59 |
| all, peaks >= 3 m/s (sensitivity) | 30 | 3.85 | 7.28 | 11.63 |

Rungs from them (percentile x baseline lever 1.992) against the pins. Rule used: re-pin only when the wider sample moves a rung by more than 10 percent.

| rung | pin | all 40 | change | peaks >= 3 | change |
|---|---|---|---|---|---|
| `rung_hit` (p10) | 8.0 | 4.5 | -43% | 7.7 | -4% |
| `rung_stick` (p50) | 16.5 | 12.0 | -27% | 14.5 | -12% |
| `rung_cut` (p90) | 24.3 | 23.1 | **-5%** | 23.2 | -5% |

**Decision: no rung re-pinned, `rules.json` untouched, so no hit or cut outcome changes.** The cut rung (p90, the one that decides cuts) holds within 5 percent. Hit and stick fall outside 10 percent only on the all-40 method, and the whole shift is the bottom of the sample: 9 of the 28 clip runs peak under 3 m/s (a clip's first or last frames, a hand drifting, not a swing). Taking them in would put `rung_hit` below the speed gate (4.5 against `min_speed_m_s` 8.0) and turn a typical light swing (tip 12.5) from a hit into a stick on every armour tier, which is not what ruling 1 asked for. Leaving them out puts hit within 4 percent and stick 12 percent under its pin. That candidate (hit 7.7, stick 14.5, cut 23.2) keeps every pinned behaviour row (light typical hits, light full speed sticks, heavy cuts mail) and moves two thin margins: heavy on mail 1.02 to 1.07, and light + counter-hit on mail 0.93 to 0.98 (still a stick, 2 percent from a cut). That is a Strategy call, so it is stated, not applied.

**Read the 40 as less than 40.** The effective sample is smaller and not independent: the 12 dump swings are the ones the pins came from; the clip swings are about 13 distinct clips (Psyche and Minotaur share Attack, Heavy and Riposte, and Cut_Outward / Cut_OutwardMirror are mirrors) for 28 swings; the hand end here is the Middle1 joint, not the hand pivot of the dump's chain, so the two parts differ slightly in definition. The 3.0 m/s floor was chosen after seeing the all-40 result, so the sensitivity row is a post-hoc view, not a pre-registered one. This is another reason nothing is re-pinned.

Other findings:
- **`heavy_mult` 1.92 is neither supported nor contradicted by clips.** Labelled Heavy clips are not faster than light ones at the hand (heavy / light p50 = 1.05 over the 7 heavy and 21 light swings of the labelled clips only; the dump's classes are a duration proxy, and mixing them in gave 1.13; the 1.92 was that proxy). The multiplier stands for the charge, a game mechanic, so it stays a proxy value; re-measure on recorded charged swings, not on library clips.
- **`counter_hit_mult` 1.75 is still `own`.** The library has no counter-hit swing (Hit, BlockImpact, Deflected are the victim's reactions); it needs a recorded fight with counter-hit events.
- **Arm reach differs per body.** The pins use 0.5634 m (Minotaur, 65 rig). On the 106 bodies, same hand-end definition: Psyche 0.587 m, Minotaur 0.600 m (baseline lever 1.952 and 1.932, 2 and 3 percent under 1.992). `evaluateHit` takes `armReachM`; a V3 wire that passes the body's reach gets a slightly lower tip speed than the tables above.
- **Library speed is not game speed.** V3 eases each clip so its contact key meets the move's contact tick (`data/hero-clips.json`), so raw clip peaks are not play speed. The fight dump is play; re-measure on a 106-rig fight dump when V3 records one.
