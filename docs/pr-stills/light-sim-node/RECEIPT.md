# Does a light-only fight end? Headless node run of V3's own sim + rules (receipt, 2026-10-27)

**Verdict: DOWN.** Landing ONLY light blows on the Minotaur ends the fight: the foe's sim HP goes 190 to 0 and the sim kills him (phase `dead`). 54 landed lights with no counter-hits, 41 with the page's AI foe (2 counter-hits), 33 with counter-hits (27 of 33 were counters). The heavy control also ends the fight (21-25 landed hits), so the harness can end a fight.

## What ran
- V3 `eaeade1fd288b220dce299be9d7a5679e27c86db` (live build, pins physics `3e077903b`), Hugging Face CPU (`hfjob`, `cpu-upgrade`, node 22), `npm ci` then `light-sim-node.mjs` in `scripts/`. No browser, no Mac. Job ids `6ae0e1703fb22a235dd2f0f7` (first run) and `6ae0e3613fb22a235dd2f402` (the traces in this folder).
- Path (the game's own code, nothing re-implemented): sim = `src/fight/duel.ts` `initialDuel`/`stepDuel` and `src/fight/combat.ts` `initialPractice`/`stepPractice` (AI foe); foe = `OPPONENTS.pitborn` (the Minotaur's sim: health 190, cleaver); hero = longsword. Evaluator = `src/fight/rules-eval.ts` `createRulesEval(...).hit(event, simAlive, handSpeed)` fed the sim's `Hit` events as `src/fight/ragdoll.ts` `step()` does (killing batch: `simAlive` false), default rows (`data/rules.json`, m4), hp scale `{foe: 190, man: 150}`, `@frankendom/physics` 3e077903b.
- Foe HP never topped up. Hero health and stamina are reset every tick (hero only). Cap 300 landed hits (never reached).
- The page has no separate "evaluator can end it" path: `rules-eval.ts` is presentation only and the sim decides death (`data/rules.json` about: "the SIM decides death, never the evaluator").

## Results (one run each; the sim is deterministic, the AI foe is seeded 731)
| run | foe | landed hits | counters | ticks | foe sim HP | ended by |
|---|---|---|---|---|---|---|
| light-nocounter | idle (cannot counter) | 54 | 0 | 2579 | 190 to 0 | `slash_riposte` torso, 6 sim dmg |
| light-ai | page AI | 41 | 2 | 7126 | 190 to 0 | `light_right` torso |
| light-ai-counter | page AI, hero swings only while he is mid-attack | 33 | 27 | 5720 | 190 to 0 | `light_left` torso, counter, 4 sim dmg |
| heavy-nocounter-control | idle | 25 | 0 | 1742 | 190 to 0 | `critical` legs, 43 sim dmg (evaluator: cut) |
| heavy-ai-control | page AI | 21 | 0 | 3079 | 190 to 0 | `critical` legs, 36 sim dmg (evaluator: miss) |

- Light damage to the sim: light_right about 3 (5.7 as a counter), light_left about 3 (5.9 as a counter), `slash_riposte` (the light button after he is staggered) 6. Per-move totals are in the trace (`byMove`).
- Every landed hit in the light runs was the torso (head 40/40 and legs untouched), so the 190 HP went down on the torso alone.
- Evaluator on those lights: outcome `stick` 25-45 times, `kill` 7-9 times (about every 4-6 lights, when the torso budget of 24 runs out). Every evaluator `kill` was deferred (`deferredKills` = 7-9, state renewed): shown as a stagger for a light (`killAsSwings` heavy only), never a fall, and it does not touch the sim. The torso budget cycles 24 down to under 2 and back; it never decides the end.
- In the idle-foe heavy control 20 of 25 hits were evaluator `kill` (deferred) and 5 were `cut`; the fight ended on the sim's HP at the `critical`.

## Data rows that matter
- Not a stall: nothing gates the end except the sim's own HP (`OPPONENTS.pitborn.health` 190, `RULES.health` 150, moves/archetype rows, V1-shared) and the light damage rows (about 3 per light on a fresh Minotaur). No floor stops it (physics PR #54 dropped them).
- `data/rules.json` `killAs`/`killAsSwings`/`renewOnKill` decide only what the evaluator's deferred kills look like.

## Not verified
- The animated hand speed (browser only): evaluator input here is the `handSpeedRef` row (light_p50), so a real swing speed could change the evaluator's `hit/stick` mix, but not the sim's damage or the end (presentation only).
- Hero positioning is mine (walk in, swing when ready); zone is always torso here, so a head/leg-only light run is untested. Hit counts in a real fight vary with spacing and what the player does between swings; 33-54 landed lights is this harness's range, not a guarantee.
- Single run per row; the foe AI is seeded, so no variance estimate. The live page was not exercised by this run (the earlier browser attempts ended UNKNOWN on load).
- The first job's output was lost with its disk; the second run re-ran the same script and prints the traces in the log (identical summaries).

## Files
`light-sim-node.mjs` (the script), `light-sim-node-trace.json` (per landed hit: tick, move, zone, counter, sim damage, foe sim HP, torso/head budgets, evaluator outcome, presentation action, deferred kill, whether the sim kills).
