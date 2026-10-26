# M4 measurement: tip speed of attacks

Goal: put the strength scale (hit / stick / cut), the melee speed gate and the bone gate on measured numbers instead of donor-game start values.
Strength = tip speed x sharpness, so the rungs below are tip speed in m/s at sharpness 1.0.

## Method

- Source: Frankendom V3's recorded fight dump (902 ticks at 60 Hz, 15 s: the Minotaur "pitborn" on the 65 rig fights the hero, attacks, blocks, takes hits and staggers). Per tick: root pose and the 20 capsule target quaternions.
- Body: `data/bodies/minotaur.measure.json` through `generateRow` and `buildDefinition` (the same capsules the engine builds).
- Forward kinematics: the chain `snapToTarget` uses (`pivot[i] = pivot[parent] + delta[parent] * (rest pivot[i] - rest pivot[parent])`, `delta = target * conj(rest quat)`, hips centre = root position).
- Tip = hand end = hand pivot + hand capsule length along its axis, both hands.
- Speed = backward difference of the tip position over 3 ticks (0.05 s). V3 steps its clips at 20 fps, so 1 or 2 tick differences show stair-step spikes.
- A swing = one run of tip speed above 2 m/s (runs closer than 0.15 s are joined); its value is the run's peak speed.
- Pose snaps: a run whose speed was still under 0.3 x its peak three ticks before the peak rose in under 0.05 s. Those are hit reactions or state switches (both hands jump together in one tick, then decay), not swings. 28 of 40 runs are snaps and are excluded. This is an inference from the shape of the curve: the dump carries no event labels.
- Light / heavy: no clip labels either, so swings are split by run duration at the median (0.2 s): short = light, long = heavy. A proxy, not the clip's own tag.

## Result (hand end, m/s, peak per swing)

| set | swings | p50 | p90 | p99 | max |
|---|---|---|---|---|---|
| all swings | 12 | 8.27 | 12.18 | 13.00 | 13.09 |
| light (run <= 0.2 s) | 7 | 6.25 | 9.74 | 11.16 | 11.32 |
| heavy (run > 0.2 s) | 5 | 12.01 | 12.74 | 13.06 | 13.09 |
| special | 0 | unmeasured | | | |
| left hand | 5 | 7.85 | 11.49 | 12.93 | 13.09 |
| right hand | 7 | 8.69 | 12.09 | 12.19 | 12.20 |
| all runs incl. snaps (upper bound, hit reactions mixed in) | 40 | 10.75 | 13.94 | 15.46 | 16.05 |

Sorted peaks of the 12 swings: 2.95 3.87 5.25 6.25 6.95 7.85 8.69 9.08 11.32 12.01 12.20 13.09. Percentiles are linear interpolation. With 12 swings p99 and max are the same few points: read them as a range, not a tail.

> **Superseded 2026-10-26 by `docs/M4-CALIBRATION.md`:** the rungs and the speed gate below are hand-speed numbers with no weapon. They are now weapon tip speed (hand speed x lever of the weapon row), with per-weapon sharpness ratios, a heavy and a counter-hit multiplier. The hand-speed measurement on this page is unchanged and still the source.

## Proposed thresholds (in data/rules.json)

| row | was | now | where it sits |
|---|---|---|---|
| strength_scale.rung_hit | 20 | 4.0 | p10 of the swing peaks (4.01 m/s) |
| strength_scale.rung_stick | 50 | 8.3 | p50 (8.27 m/s) |
| strength_scale.rung_cut | 100 | 12.2 | p90 (12.18 m/s) |
| melee_speed_gate.min_speed_m_s | 5 | 4.0 | p10; TABG's 5 m/s is about p17 |
| melee_speed_gate.full_strength_margin_m_s | 0.5 | 0.5 | not measurable from a pose dump, left |
| bone_gate.numerator_m_s | 3 | 3 | unchanged, see below |

The scale is re-based: the old 20/50/100 are Gladio and Glory units and the repo has no sharpness column to convert them with. `status` is now `measured`, with the limits in `measure_note`. Choosing p10 / p50 / p90 is a design call: one swing in ten cuts at sharpness 1; a sharper weapon (sharpness above 1) moves its own swings up the same ladder.

Findings to act on:

- Bone gate: `3 / sqrt(bone_mult)` is 2.7 to 3.0 m/s for bone_mult 1.0 to 1.2, under 11 to 12 of the 12 swings. On our clips the cut rung (12.2 at sharpness 1) is what binds. Left alone; raise the numerator only if the bone gate should bind.
- Armour design check (plate_t3 threshold x2.5): the cut rung times 2.5 is 30.5 m/s-equivalent, above the fastest measured swing (13.09). A weapon needs sharpness of about 2.3 (fastest swing) to 2.5 (p90 swing) to cut top plate. Sharpness values per weapon are the next row to define, or top plate is a block in practice.

## What could not be measured

- Mixamo and Hellish Quart library clips: the clip GLBs live on the donor store (`/mnt/frankendom-donors/.../site-mixamo-clips`, per `tools/mixamo/CLIP-FORMAT.md`), not on the Mac, and `site/models/mixamo/` holds only the index and character GLBs. Not read.
- Special swings: no labels in the dump, so none identified.
- Weapon tip: the dump has no weapon axis. The old `--weapon` option (a weapon placed on the hand axis by its reach_max, 55 to 80 m/s medians, a guessed axis) is removed. M4 calibration instead scales the measured hand speed by the lever (arm reach + weapon length) / arm reach, an assumption stated in `docs/M4-CALIBRATION.md`; the tool prints the lever table.
- Sharpness: no per-weapon value exists yet, so strength is expressed at sharpness 1.0.
- Light / heavy are a duration proxy; the sample is one fight, one body, one hero opponent, 12 swings.

## Reproduce

```
git -C ~/Developer/frankendom-v3 show origin/docs/ragdoll-poses:docs/ragdoll-fight-poses.json > /tmp/fight.json
node tools/tip-speed.mjs /tmp/fight.json data/bodies/minotaur.measure.json
```

Options: `--window 3` (ticks), `--start 2.0` (m/s), `--gap 0.15` (s), `--snap 0.3` (0 keeps the snaps), `--json out.json`, `--series out.csv` (per-tick speed of both hands).
