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

## State runners (M3)

`rd.kill({ part, impulse })` (strength 1 to 0.01 over 1 s, limp damper, limits and self-collision on, impulse the same tick, hips released, sleeps when still), `rd.stagger({ part, impulse })` (arm 0.9 / torso 0.6 / hand 0.12, hold 0.5 s, back over 0.35 s), `rd.knockdown("damage" | "push", hit)` (TABG values: 0.2 / 0.5 s fall, 2 s down, recover 0.3 per s), `rd.state` (`alive`, `stagger`, `knockdown`, `dying`, `frozen`). Numbers: `data/states.json`.

## Rules the package keeps

- Deterministic: same inputs and same call order give the same per-tick hash (CI test `test/determinism.test.mjs`, twice). No `Math.random`, no `Date.now`, no `performance.now` in `src/` (the test greps for it).
- Every tuning number is a data row with a named source: `data/world.json` (step, solver, damping, high-rate window) and `data/ragdoll-role-table.json` (masses, radii, joint limits, motor gain, severable units, armour tiers). The generator lints any `block` / `immune` field and throws (armour only raises a dismember threshold).
- Budget: DUEL = four active ragdolls, M3 proof = five, under 3 ms a frame on a mid phone; `test/budget.test.mjs` guards it in Node on CI, the phone number comes from the bench page in each milestone PR.

## Not yet (M3 to M6)

Death ramp and stagger runners from rows (M3), target pose / clip driving (M3), the weapon swept-edge cut and severed head with gear (M5), the strength-scale rule rows and the schema lint (M4, M6). Version bumps follow `0.x` until V3 wires against it.
