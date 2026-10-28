# @frankendom/physics API (v0.1, skeleton)

ESM, Jolt 1.1.1 WASM inside (the `wasm-compat` build: one JS file with the wasm embedded, so the same import works in the phone browser and in Node >= 22). One module, one deterministic fixed-step sim; never two.

```js
import { createPhysics } from "@frankendom/physics";

const physics = await createPhysics({ seed: 731 });                 // seed feeds physics.rand() only; the engine itself draws nothing
const rd = physics.createRagdoll(bodyMeasureRow, { position: [0, 0, 0], id: "hero" });
rd.setMotorStrength({ all: 1 });
physics.step(1 / 60);                                               // call once per sim tick
const pose = rd.readPose();                                         // Float32Array, 10 floats per part
```

## Calls

| call | what it does |
|---|---|
| `createPhysics({ seed, rows?, roleTable? })` | async, once. Loads Jolt, builds the world and a floor. `rows` overrides keys of `data/world.json`. |
| `physics.createRagdoll(bodyMeasureRow, opts?)` | Builds a 20-body ragdoll from ONE body measure row (`height_m`, lengths, widths and the 20 role-joint positions: see `test/fixtures/body-0002.measure.json`). No bone names beyond those 20 role joints, so the 65-joint and 106-joint rigs use the same call. A generated `ragdoll-row/2` is accepted as well. `opts`: `position` [x,y,z] (feet on the floor), `id`, `rootKinematic` (default true: the hips follow your pose while alive), `motorStrength` (default 1). Returns the ragdoll. |
| `rd.setMotorStrength(rows)` | A number, or `{ all, <role>, <partId> }` with values 0 to 1 (1 full, 0.01 limp; at or below 0.011 the limp damper applies). Later keys win: `all` < role (`arm`, `forearm`, `hand`, `spine`, `thigh`, `shin`...) < part id (`armLeft`). The stagger dip (arm 0.9 / torso 0.6 / hand 0.12) is three keys. You call it each tick you want a ramp; M3 adds `startDeath` / `startStagger` that run the ramps from data rows. |
| `rd.applyImpulse(part, [x, y, z])` | World-space impulse (N s) on one part by id (`head`, `spine2`, `armRight`...). Applied at the moment you call it, effective on the next step. |
| `rd.cut(unit)` | Detaches a severable unit: `head`, `arm_left`, `arm_right`, `leg_left`, `leg_right`, `torso_waist`. The cut role's joint is removed, the part and what hangs below it fall free and keep their velocity. The world steps at 120 Hz for the next `cut_high_rate_ticks` ticks. Returns `{ unit, mass_kg, carries_roles, gear_slots }` for the game's own gear and gore, or `null` if it was already cut. The sim decides that a cut happens; this call carries it out. |
| `physics.step(dt)` | Advances in whole 60 Hz ticks (`tick_hz` in `data/world.json`); the remainder carries. At most 4 ticks per call. Never reads a clock. Standing ragdolls run 1 substep a tick, 2 (120 Hz) while a cut is live. |
| `rd.readPose()` | `Float32Array` reused between calls: per part (order = `rd.partIds`): `px py pz qx qy qz qw vx vy vz`, world space, metres, the capsule centre and orientation. Copy it if you keep it. Map parts onto your rig's bones by role in your own code. |
| `rd.setRoot(position, quaternion)` | Moves the kinematic hips for the next tick (the game's animated root). `rd.release()` makes the hips dynamic (death, knockdown). |
| `physics.hash()` | FNV-1a over every ragdoll's pose floats: the determinism check, compare per tick between phone, server and replay. |
| `physics.rand()` | Seeded mulberry32 for sim draws (finisher rolls). The game owns what it draws. |
| `rd.destroy()`, `physics.destroy()` | Free bodies and constraints. |

## three.js glue: `@frankendom/physics/three-rig`

```js
import * as THREE from "three";
import { createThreeRig } from "@frankendom/physics/three-rig";
const rig = createThreeRig(THREE, rd, { hips: pelvisBone, spine: spine01, ..., toeRight: ballR }, fighterGroup);
```
`bones` maps the 20 part ids (`rd.partIds`) to your Object3Ds (your role map); `root` is the Object3D whose local frame is the sim frame (the fighter's group with its position and yaw). Create the rig while the model is in its bind pose, before the first step. Alive: after the animation has posed the bones, call `rig.drive()` each frame (sends the hips via `setRoot` and the animated pose via `setTargetPose`). Dying or dead: after `physics.step()`, call `rig.applyPose()` and the bones follow the capsules. Also `rd.setTargetPose(Float32Array)` (4 floats per part, world quaternion of each capsule) if you drive the motors yourself.

### Chain bodies with virtual parts and follower bones (centipede): one call

A chain part with `drives: null` is virtual (simulated, no bone) and a part with a `follow` list carries extra bones that copy its rotation. `createThreeRig` handles both through `opts.virtual` (part ids with no bone: skipped by `applyPose`, they take the nearest driven ancestor's orientation change in `drive`) and `opts.follow` (`{ partId: [Object3D] }`: after every bone is posed, `applyPose` sets each follower's local quaternion to its driver bone's, then refreshes the world matrices). The game does not give virtual parts empty nodes and does not copy rotations by hand:

```js
import { loadChainBody, chainRigOptions } from "@frankendom/physics";
const body = loadChainBody("centipede"), rd = physics.createRagdoll(body.row);
const r = chainRigOptions(body, (name) => gltf.scene.getObjectByName(name)); // optional 3rd arg { bindFind, bindRoot } for an untouched bind copy
const rig = createThreeRig(THREE, rd, r.bones, fighterGroup, r.options);
```
Errors at creation: a model without a bone the spec names, an unknown `virtual` or `follow` part id, a virtual root part, a virtual follow driver, a follower that is not an Object3D. Bodies with no virtual or follow entries (humanoid, salamander, spider) behave exactly as before; omitting `r.options` keeps the old "no bone for part X" error.

## Tracking a live clip, reset, snap, rows (asked for by V3 Dev)

- `createRagdoll(row, { motorGain, motorDamping })` and `rd.setMotorGain(g, damping)`: stiffness multiplier and damping multiplier (default 1 and 1 = the M1 values). Measured on one arm swinging 2 Hz, +-50 degrees (VPS, Node 22, `test/api2.test.mjs`), mean orientation error: gain 1 = 20.9 deg, gain 2 = 12.6, gain 4 = 13.6, gain 8 = 20.4 (unstable-ish); with less damping: gain 2 / damping 0.25 = 7.6 deg, gain 4 / damping 0.25 = 8.6. Start with `{ motorGain: 2, motorDamping: 0.25 }` for a body that follows a fighting clip; retune on the real clip. One arm and one frequency only.
- Pooled ragdolls: `createRagdoll(row, { position, id, parked: true })` adds the bodies asleep and 500 m under the floor, so `world.step` spends nothing on them (default `parked` off: behaviour unchanged). Take one from the pool with `rd.acquire(position?)` (spawn pose at `position`, default the one given at create; velocities zero; awake; returns false if not parked). `rd.parked` tells which. `rd.park()` sends a used ragdoll back to the pool: spawn pose, alive, full strength, motor targets and velocities cleared, asleep and 500 m under the floor, `rd.parked` true; `acquire()` then works as the first time. It returns false and changes nothing if a cut removed joints (destroy and recreate, like `reset()`); parking a parked ragdoll returns true. Until acquired, `readPose()` reports the parked position, and `setRoot`, `reset`, `kill`, `applyImpulse`, `release`, `stagger`, `knockdown`, `cut` and `snapToTarget` do nothing and return `false`. Acquired far from the origin (200 m) a ragdoll matches a fresh one created there to within 2e-3 m after a kill (float32 sensitivity, see `test/parked.test.mjs`). Measured: 30 unparked pool ragdolls at the origin cost about 21 ms per step on the HF CPU job (they overlap and collide), parked about 0 (`tools/parked-cost.mjs`).
- Per-role tuning: `createRagdoll(row, { motorTuning })` or `rd.setMotorTuning({ all: { gain: 2, damping: 0.25 }, neck: { gain: 1, damping: 1 }, head: { gain: 1, damping: 1 } })`; keys `all` < role < part id.
- **Elbow sign fix and real-clip numbers (2026-10-26).** The left elbow flexed the wrong way: the hinge limits were the same sign on both arms, but a left elbow's flexion is a negative angle about the shared axis (a replay of V3's 902-tick Minotaur fight showed the left forearm needing -138..1 degrees against limits of -30..150). Limits now mirror per hinge. Replayed with `tools/replay-poses.mjs` (V3 pose dump, Minotaur 65 rig, median / p95 degrees, long-axis error, settled = 20 extra ticks): forearm 31.4 live / 21.5 settled before, now 19.4 / 11.0 with the plane solve on (gain 1) and 21.5 / 11.1 at gain 2 / damping 0.25; shin 9.0 to 2.6 live; upper arm 19.3 live / 12.0 settled (unchanged); full-orientation error is higher (twist). `solveHinges` now defaults to true.
- Elbow and knee bend plane: `setTargetPose` now twists the parent about its own long axis so the hinge's bend plane matches the clip (a hinge can only bend in one plane). On a guard pose (upper arm down, forearm forward and up) the forearm long-axis error went from 46.5 to 15.4 degrees (`test/hinge.test.mjs`). `createRagdoll(row, { solveHinges: false })` turns it off. The parent twist is invisible on a round capsule; on the skinned mesh it shows as upper-arm roll.
- `rd.snapToTarget()`: puts every capsule on the last `setRoot` + `setTargetPose` pose at once, velocities zeroed (no motor lag at the killing frame). Returns false before both were called.
- `rd.reset()`: back to the spawn pose, alive, full strength; returns false after a cut (a cut removes joints: destroy and recreate).
- `createPhysics({ states: { stagger: { ... } } })`: game data rows override `data/states.json` key by key (death, stagger, knockdown).
- `createThreeRig(THREE, rd, bones, root, { bind: { bones, root } })`: read the bind pose from an untouched copy of the model when the live rig is already animated at build time.

## Visual-only units: `head_split`, `belly_open`

`rd.row.severable` lists eight units: the six above plus `head_split` and `belly_open`, rows in `data/ragdoll-role-table.json` flagged `visual_only: true` (`cut_role: null`, `joint: null`, `mass_kg: 0`, `carries_roles: []`, `cap_role` = the part the event points at: `head` and `spine1`). They exist for cut GLBs made with `tools/cut-units.mjs --head-split --belly-open` (docs/CUT-CONTRACT.md, Optional cuts).

- `rd.cut("head_split")` / `rd.cut("belly_open")` return `{ unit, mass_kg: 0, carries_roles: [], gear_slots: [], cap: { part, position }, props: [], visual_only: true }` and put the unit in `rd.cuts`. Nothing detaches: no capsule or joint is removed, no mass moves, no helmet prop (the `helmet` and `impulse` options are ignored), the 120 Hz window is not started, the ragdoll stays alive and its per-tick hash is identical to a run without the call. A second cut of the same unit returns `null`. They can be cut in any order with `head` (`head` after `head_split`, or the reverse), on a living or a frozen body.
- `createCutRig(...).update()` shows `cap_split_head_left` / `cap_split_head_right` once `head_split` is in `rd.cuts` and `cap_belly_opening` once `belly_open` is; a manifest region may carry `separated_by: "head_split"` (checked against the known units, like `detached_by`).
- `rd.reset()` still returns false after a detaching cut, but works after visual-only cuts alone (it clears them, so the caps hide again).
- A `ragdoll-row/2` generated before these units existed is accepted: `createRagdoll` adds the visual-only units from the role table to its `severable` list (the row you passed in is not touched). The two head halves do NOT move independently yet: both follow the `head` capsule (a separate step, not done).

## Cuts (M5)

- `rd.cut(unit, { helmet, impulse })` detaches `head`, `arm_left`, `arm_right`, `leg_left`, `leg_right` or `torso_waist` and returns `{ unit, mass_kg, carries_roles, gear_slots, cap: { part, position }, props }`. `gear_slots` is the six-unit contract (the gear on the severed unit goes with it); `cap` is where the stump is now (attach your cap mesh to the parent part and follow it); `helmet: true` (head only) spawns the helmet as a rigid prop (`data/states.json` `cut.helmet`) with the head's velocity plus a pop. `impulse` pushes the severed piece. Works on a frozen corpse (the corpse cut on tap): the severed piece wakes, the rest stays asleep. After a cut the world steps at 120 Hz for `cut_high_rate_ticks`.
- `physics.createProp({ radius, mass, position, velocity, spin, id })` returns `{ id, readPose(), destroy() }` (10 floats like a part); props are in `physics.hash()`.
- `rd.sweepEdge(base0, tip0, base1, tip1)`: the blade segment at the start and the end of the tick; returns `[{ part, dist, radius, through }]` nearest first; `through` = the blade passed within 0.6 x radius of the part's axis (`data/states.json` `cut.edge`). The threshold that turns a crossing into a cut is the rules evaluator's, not this call's. A dead or limp body giving the blade less drag is not modelled yet.
- Proof: `proof/m5/` (clip `docs/clips/m5-head-cut-375.mp4`). The skinned mesh is one piece, so the head bone flies off with the stretched neck skin until cut-piece meshes exist (V3 has its own severed-head mesh for finishers).

## Cut pieces on the model: `@frankendom/physics/three-cuts`

```js
import { createCutRig } from "@frankendom/physics/three-cuts";
import CAPS from "@frankendom/physics/data/cut-caps.json";
const cuts = createCutRig(THREE, rd, gltf.scene, manifest, { rows: CAPS });   // manifest = <body>.cut.manifest.json (docs/CUT-CONTRACT.md)
// each frame: physics.step(); rig.applyPose(); cuts.update();
```
Returns `{ update(), pieces, caps, setCapMaterial(rows) }`. `pieces` = region id to `piece_*` mesh (always visible; the bones carry them), `caps` = cap id to `cap_*` mesh. `update()` shows each cap iff its `shown_when_cut` unit is in `rd.cuts` (derived every call: cutting an already cut unit is a no-op, a fresh ragdoll hides every cap; `rd.reset()` returns false after a cut, recreate the ragdoll). Gear, hair and horns follow their bones. `setCapMaterial({ flesh, inner, blood })` reads `data/cut-caps.json` (own start values, tunable): colours of the `cap_flesh` and `cap_inner` materials, `blood` mixes a tint in by `amount`. Missing meshes, unknown units or regions and a wrong manifest schema throw at creation. Tests: `test/three-cuts.test.mjs`.
- Proof: `proof/m6/` (every unit cut in turn on the Minotaur-106, 375 wide). `node proof/m6/build.mjs` builds against a generated fixture body (`proof/m6/fixture.js`); `node proof/m6/build.mjs <body>.cut.glb [manifest]` uses the real cut body. Clip `docs/clips/m6-cuts-fixture-375.mp4` is the fixture run.

## State runners (M3)

`rd.kill({ part, impulse })` (strength 1 to 0.01 over 1 s, limp damper, limits and self-collision on, impulse the same tick, hips released, sleeps when still), `rd.stagger({ part, impulse })` (arm 0.9 / torso 0.6 / hand 0.12, hold 0.5 s, back over 0.35 s), `rd.knockdown("damage" | "push", hit)` (TABG values: 0.2 / 0.5 s fall, 2 s down, recover 0.3 per s), `rd.state` (`alive`, `stagger`, `knockdown`, `dying`, `frozen`). Numbers: `data/states.json`.

## Rules the package keeps

- Deterministic: same inputs and same call order give the same per-tick hash (CI test `test/determinism.test.mjs`, twice). No `Math.random`, no `Date.now`, no `performance.now` in `src/` (the test greps for it).
- Every tuning number is a data row with a named source: `data/world.json` (step, solver, damping, high-rate window) and `data/ragdoll-role-table.json` (masses, radii, joint limits, motor gain, severable units, armour tiers). The generator lints any `block` / `immune` field and throws (armour only raises a dismember threshold).
- **Ragdoll cap:** `data/budget-rows.json` row `max_simultaneous_ragdolls` (3) keeps the 3 ms budget when many bosses die at once (#64 measured seven dying+cut bosses at 3-4 ms p95 CPU). `admit(activeCount, rows)` (package export, pure) returns `'ragdoll'` while fewer than the cap are active, else `'baked'`: the game counts its active ragdolls, asks before creating the next, and plays the baked death for a `'baked'` answer (no body, no cut). The library never creates or refuses bodies itself; the games (ARMAGEDOM, V3) own their pools and read the row from this repo. `node tools/budget-seven.mjs --cap` measures with the cap applied.
- Budget: DUEL = four active ragdolls, M3 proof = five, under 3 ms a frame on a mid phone; `test/budget.test.mjs` guards it in Node on CI, the phone number comes from the bench page in each milestone PR.

## Not yet (M3 to M6)

Death ramp and stagger runners from rows (M3), target pose / clip driving (M3), the weapon swept-edge cut and severed head with gear (M5), the strength-scale rule rows and the schema lint (M4, M6). Version bumps follow `0.x` until V3 wires against it.

## Rules evaluator

`src/rules-eval.mjs` (exported from the package root) turns the M4 rows in `data/rules.json` into one decision per hit. Pure and deterministic: no clock, no global random source; sim time comes in on the hit (`t`, seconds) and the finisher roll takes your seeded `rand()`. State is plain JSON, so the server and the phone hold the same object. `evaluateHit` mutates the state it is given (and returns it in `result.state`). A missing or null row it needs throws, naming the row.

```js
import { createEvaluator, createFighterState, loadRules, mulberry32 } from "@frankendom/physics";
const ev = createEvaluator(loadRules());                    // validates the rows, reads every number from them
const target = createFighterState(ev.rules, bodyMeasureRow, { sword_side: "right", leg_hp: 60 }); // or an array of part ids
const r = ev.evaluateHit(
  { weapon: "gm_gladius", kind: "slash", zone: "arm_off", armour: "leather", handSpeed: 9.74, swing: "heavy", counterHit: false, t: 12.5 },
  target,
  { rand: mulberry32(seed), finisher: { killsSinceFinisher, matchWinning, boss } }, // opts only needed for the finisher roll
);
// r = { outcome: "cut", strength: 37.2, damage: 15.4, part: "arm_left", partHpAfter: 0,
//       cut: { unit: "arm_left" }, bleed: true, knockdown: null, finisher: null,
//       tipSpeed: 19.4, lever: 1.992, swing: "heavy", counterHit: false, swingMult: 1.92, sharpness: 1,
//       cutThreshold: 27.9, boneGateSpeed: 3.15, events: [...], state }
if (r.cut) rd.cut(r.cut.unit);                              // head, arm_left, arm_right, leg_left, leg_right, torso_waist
```

- **hit**: `weapon` (id in `rules.weapons`), `kind` (`slash` | `stab` | `blunt`), `zone` (`head`, `torso`, `legs`, `feet`, `arm_sword`, `arm_off`), the speed in, one of `handSpeed` (m/s of the attacker's hand end, the number the clips measure; the evaluator multiplies it by the weapon's lever `(lever.arm_reach_m + weapons.<id>.length_m) / lever.arm_reach_m`, or pass `armReachM` for a body with its own arm) or `tipSpeed` (m/s of the weapon tip, lever already in; both at once throws), `swing` (`light` default | `heavy`, a charged swing: strength x `swing.heavy_mult`), `counterHit` (bool, default false: strength x `swing.counter_hit_mult`), `t` sim seconds, `armour` (tier id, or `{ zone: tierId }`, default `none`); `side` (`left` | `right`) for `legs` and `feet`; optional `force` (push force, over `knockdown.push_force_over` forces the fall) and `attacker` (the attacker's state, scales damage by his `outgoing_damage_mult`).
- **result**: `outcome` (`miss` | `hit` | `stick` | `cut` | `knockdown` | `kill`, highest wins: kill > cut > knockdown > stick > hit), `strength`, `tipSpeed`, `lever` (null when `tipSpeed` was given), `swing`, `counterHit`, `swingMult`, `sharpness` (null on a miss below the speed gate), `damage`, `part`, `partHpAfter`, `knockdown` (`{ fallSeconds, downSeconds, cause, graceUntil, stunPct }` or null), `cut` (`{ unit }` or null), `bleed`, `finisher` (the roll, only on a kill when `opts.rand` is given), `events` (`part_down`, `cut`, `weapon_drop`, `off_arm_gone`, `leg_gone`, `bleed_start`, `bleed_out`, `kill`, `knockdown`, `knockdown_ignored`, `stun_diminished_out`, `bone_gate_not_met`, `below_speed_gate`, `below_hit_rung`, `part_gone`, `dead_target`).
- **The rules, in order:** melee speed gate (below `melee_speed_gate.min_speed_m_s` is a miss; strength ramps in over `full_strength_margin_m_s`), `strength = tip speed x sharpness x heavy x counter-hit` (sharpness = weapon `slash_sharpness` / `stab_sharpness`, a ratio to the baseline blade `strength_scale.baseline_weapon` whose sharpness is 1.0; blunt uses the fixed row in `evaluator.kinds`; the donor `slash_mult` / `stab_mult` columns are kept as the source of those ratios; the rungs are tip m/s of strength at sharpness 1.0; do not feed the faster hand speed of a heavy animation together with `swing: "heavy"`, `heavy_mult` already stands for the charge; the speed gate and the bone gate read the physical tip speed, not the multiplied strength), below `rung_hit` is a miss, `damage = strength x zone body_part_mult x global.damage_scale x armour damage_taken_mult[cut|stab|blunt]`. A cut needs a slash, `strength >= rung_cut x armour dismember_threshold_modifier` and the bone gate `tip speed >= bone_gate.numerator / sqrt(weapon bone mult x unit bone mult) x armour modifier`. Armour only raises those two numbers; any weapon cuts through any tier with a fast enough blow. A stab over the cut rung sticks and bleeds, it does not sever. A cut removes the whole part budget. Zone to budget and zone to severable unit are rows (`evaluator.zone_part`, `evaluator.zone_cut_unit`), so `torso` cuts `torso_waist`, which is a kill.
- **Two counters:** per-part budgets (`part_hp`; head 20, torso 60, sword arm 45, off arm 70, legs 50 to 70) decide kill and limp; the knockdown counter (damage since last fall, falls at `counter_fall_at`, resets on fall, capped at `counter_cap`, blunt weighted by `evaluator.kinds.blunt.knockdown_mult`) decides the fall. A fall opens a window of fall + downed + `getup_grace_s` in which further knockdowns are ignored (damage still lands). Repeated falls inside `evaluator.stun_window_s` shorten by `knockdown.stun_duration_pct` (100, 50, 25, then no fall).
- **Kill rules** are rows (`evaluator.kill`): head budget gone, torso budget gone, or both legs gone. Sword arm gone sets `weapon_dropped` and `outgoing_damage_mult = locational.arm_gone_damage_mult`; one leg gone sets `limp` (event carries `leg_crawl_to_stand_s`). **Damage is cumulative; there is no floor** (Strategy+Dom 2026-10-27): zero health is dead, light or heavy. The old rows `evaluator.kill.light_floor_pct` and `heavy_kill_floor_pct` (and events `light_floor`, `heavy_kill_floor`) are REMOVED; a rules file that still carries them loads and they are ignored. Do not reinstate them. **Light damage on kill parts** (`evaluator.kill.light_damage_mult`, 0.4, required): a LIGHT swing on a head or torso deals strength x zone x global x this multiplier; heavy swings and limbs are unchanged, rungs unchanged, the knockdown counter still uses the full force. A light swing never CUTS a head or torso while the part's hp is above the damage the blow itself deals (event `light_cut_refused`); once hp <= that damage it kills normally by damage. Without it a light counter-hit (strength over `rung_cut`) cut and killed a bare fighter in one blow. **Per-blow cap** (`evaluator.kill.light_part_cap_pct`, 45, required; must stay under 50 so two lights never kill a fresh part): a light's damage to a head or torso is capped at that percent of the part's FULL budget (per blow, not on the total), so one light never kills or cuts a fresh part, man or boss; cumulative damage still kills; heavy and limbs are not capped. At 0.4 a fresh Minotaur-scale torso (76) dies to 6 to 10 mixed lights or 2 heavies (heavy p50 hand speed); 1 = the old damage.
- **Bleed:** a cut starts one timer of `bleed_out.seconds_max` down to `seconds_min` by how far the blow cleared the cut threshold; the next hit at or after `bleed.until` finds the target dead (`cause_of_death: "bleed_out"`). A corpse is cut by any hit that clears the cut rules (damage 0).
- **Finisher roll:** `rollFinisher(rules, { overkillPct, matchWinning, boss, killsSinceFinisher }, rand)`: `base_pct` + `per_overkill_pct` per 1 percent of the part budget the strength cleared the cut rung by, capped at `cap_pct`; always on a match-winning or boss kill and after `pity_after_kills`. `rand()` is only called when the chance is not a sure thing. The killer holds `killsSinceFinisher` (the roll returns the next value). Defaults (2026-10-27): base 90, cap 100, pity 2, so about 90 percent of kills by roll, never 3 misses in a row, damage kills included. When it fires the roll also returns `kind`, one id from `evaluator.finisher.pool` (`decapitation`, `split_crown`, `belly_open`, `waist_cut`, `run_through`) that fits the struck part (`ctx.part`: `head` or `torso`) and hit kind (`ctx.hitKind`), never equal to `ctx.lastKind` when another fits; the pick uses the same seeded `rand()`. `evaluateHit` fills `part` and `hitKind` itself; the game passes `finisher: { killsSinceFinisher, lastKind, boss, matchWinning }` and stores `result.finisher.kind` as the next `lastKind`.
- **Hash:** `rulesHash(state)` over the fighter state gives a replay check (test: same hits twice, same hash).
