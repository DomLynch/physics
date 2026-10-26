# physics

The shared combat physics package for Dom's games: Jolt compiled to WebAssembly, a deterministic fixed step, one module that runs in the phone browser and headless in Node on the VPS. Ragdolls are generated from body measure rows (never bone names), so it serves Frankendom V3's 65-joint rig and OpenTrident's 106-joint rig alike, and Armagedom later.

Read `docs/BRIEF.md` first: owner, consumers, rules that stand, budgets, M3 to M6 deliverables in order, the package API. The design rulings (armour never blocks a cut, full gore, winner takes a copy, the finisher trigger, the strength scale) live in the strategy repo `DomLynch/RPG-game`, branch `strategy/state-1007b`, `docs/COMBAT-101-TOP-25-2026-10-25.md`; the numbers in `opentrident-steam/docs/parts-lab/combat-physics-comparison-five-games.md`.

Package name `@frankendom/physics` (rename later if Dom wants a neutral one). First consumer: `DomLynch/Frankendom-v3`. M1 and M2 state comes from the OpenTrident Dev's handover (`opentrident-steam/docs/parts-lab/physics/`).
