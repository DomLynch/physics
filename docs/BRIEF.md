# Physics Dev brief: M3 to M6 as a package (Strategy, drafted 2026-10-25 night; updated 2026-10-26 ~20:00 Dubai at Dom's go)

## Update 2026-10-26 evening (Dom's decisions; this block wins over anything below that disagrees)
- **Owner: a dedicated Physics Dev**, its own session and repo, neutral (not under Frankendom or Armagedom): repo `DomLynch/physics`, Mac folder `~/Developer/physics`. OpenTrident Dev hands over the M1/M2 state and stays the owner of bodies, measure rows and clips.
- **Consumer is Frankendom V3** (repo `DomLynch/Frankendom-v3`, live https://v3.frankendom.com), not V2. V2 is retired. The V3 dev agrees the API in one message.
- **Two rigs.** V3 runs V1's 65-joint UE-style rig today (warrior, Centurion, Psyche, Minotaur bodies) and moves to OpenTrident's 106-joint rig in a later swap. The package takes body MEASURE ROWS (part lengths, masses, joint limits), never bone names, so one ragdoll generator serves both; a 65-rig measure-row set for V3's current bodies is part of M2's handover, and the M3 proof clip may run on the 106 bodies.
- **Universal by design: Armagedom uses the same package** (top-down 2.5D, ten passive ragdolls, motors off, same 3 ms budget) after V3's M3 passes. Nothing Frankendom-specific in the API; rule rows are data per game. Frankendom first.
- Everything else in this brief stands: Jolt, WASM, deterministic fixed step, one module for phone and headless Node, the sim decides every outcome, the budgets, the rulings, the deliverables in order, the package shape.



## Read first
1. Core reference, direction and rulings: `frankendom-strategy/docs/COMBAT-101-TOP-25-2026-10-25.md` (items 13 to 18, addendum 1 A1 to A10, addendum 2 B1 to B8, the budget correction, the finisher trigger).
2. Numbers: `opentrident-steam/docs/parts-lab/combat-physics-comparison-five-games.md` (extends the three-game doc).
3. Where M1 and M2 stand: `opentrident-steam/docs/parts-lab/physics/` and the OpenTrident Dev's HANDOFF of 10-25 12:28. M1 = Jolt chosen (MIT, WASM), motor bake-off harness. M2 = 20-body ragdoll generator from the body measure rows, running.
4. Plans already written on the OpenTrident side: `docs/parts-lab/combat-physics-phase1.md`, `combat-physics-phase1-plan.md`.

## Rules that stand
- Jolt, compiled to WebAssembly, deterministic fixed step. Same module runs in the phone and headless in Node on the VPS; never two sims.
- The sim decides every outcome. Hits stay animation windows; deaths, knockdowns and cuts are physics outcomes by rows. Physics is not decoration.
- Budget: DUEL = four active 20-body ragdolls with motors, self-collision and one cut in progress under 3 ms a frame on a mid phone; the M3 proof is measured with FIVE fighters on screen. Armagedom = ten passive ragdolls, motors off, same 3 ms.
- Armour never blocks a dismemberment; the schema rejects any block field. Full gore. Winner takes a copy, loser keeps.
- Ragdoll substep 120 Hz with 6 iterations only for thrown weapons and cuts; standing ragdolls at 60.
- Template layer only: numbers from the donor games are starting shapes, measured on OUR clips before any threshold is written.

## Deliverables, in order
**M3 (first, proof within 48 h of start):** death ramp (motor strength 1 to 0.01 over 1.0 s, damper 2, joint limits and self-collision on from the start, hit impulse applied at the same tick, freeze under 0.02 squared speed) and the stagger dip (strength down for 0.5 s, back over 0.35 s, arm 0.9 / torso 0.6 / 0.12) on the M2 ragdoll of a 106-rig library body. Knockdown start values from TABG (damage over 60 falls 0.2 s, push over 80 falls 0.5 s, down 2 s, recovery 0.3 per second), retuned on our clips. Proof: one clip at 375 at the fight camera for Dom, plus the real-phone number with five fighters on screen under 3 ms. One line to Dom with the clip.

**In parallel with M3, as data PRs (no physics proof needed):**
- M4 rule rows: the one strength scale (hit 20 / stick 50 / cut 100, measured on our Mixamo and Hellish Quart attack clips first, tip speed times sharpness), zone multipliers (start: head 2.0, torso 1.0, legs 0.75, feet 0.5), the bone gate before a cut (start shape `3 / sqrt(bone_mult)`), armour tiers as threshold multipliers (cloth 1.0 to top plate 0.35 cut, threshold 1.0 to 2.5), knockdown counter separate from kill budgets (60 of 120, resets on fall, get-up invulnerability 1.5 s), per-part HP budgets (head 20, torso 60, sword arm 45, off arm 70, legs 50 to 70), weapon rows seeded from the Gladio Mori and TABG tables, one global damage scale row, bleed-out as one timer row (20 to 30 s).
- M6 schema: columns `bone_break_speed`, `slash_mult`, `stab_mult`, `body_part_mult`, `fall_seconds`, `recover_per_s`, per-state stiffness, with the lint that rejects any immune or block field; closed key sets; round-trip test.

**M5 (right after M3 passes):** severed head and corpse cut on one body: swept blade edge crossing a part past its threshold detaches it as a rigid body with inherited velocity and a cut cap, with its equipped gear; helmet flies as a prop; a dead or limp body gives the blade less drag; the corpse on the floor is cut on tap (the butcher's table). Proof: one clip.

## The package
Ship from the first M3 PR as an ESM package V2 can install (name it in the PR, for example `@frankendom/physics`): Jolt WASM inside, deterministic fixed step, API: `createRagdoll(bodyMeasureRows)`, `setMotorStrength(perStateRows)`, `applyImpulse(part, vector)`, `cut(part)`, `step(dt)`, `readPose()`. Runs headless in Node on the VPS. API doc in the repo with the first PR so the V2 dev wires against it before M5. Versioned, hashed paths, long-lived caching on the library server.

## Who is who
Dom owns and judges every clip on his phone. Strategy for decisions no lane can make and project-stopping blockers only. V2 Dev (local_0d75328b-4dc5-4e9d-88a8-9059e05232c2) is the consumer; agree the API with it in one message, not a meeting. OpenTrident Dev owns the body and clip library and the M1/M2 state. Report by clips, not status.
