# Does a light-only fight end on live V3? (receipt, 2026-10-27)

**Verdict: UNKNOWN (run capped by the deadline; the control proves the harness can end a fight).**

Live build: `https://v3.frankendom.com/build.txt` = `9b76784f219529eafa8518351d4bbc1aa3a5dfdc`, default ruleset m4 (no `?rules=`). Headless Chromium on the VPS (never the Mac), 375x812, paused 60 Hz clock (1 rAF = 1 tick). The harness drives the live URL directly, so no local port was used. Foe: the default opponent (sim rig `hero`, weapon cleaver, 137 sim HP). Hero: longsword.

**Top-ups: the HERO only** (health and stamina rewritten every tick). The foe is never written, so only the page's own rules move his HP.

Harness: `light-only-end.mjs` (this folder; adapted from `light-hit-fall.mjs` / `m4-proof.mjs`).

## Control: heavies (KeyG only) end the fight, so the harness can see an end

`heavy-control-trace.json`: the foe's sim HP went 137 to 0 at tick 1609 (24 swings, 20 hits); foe phase `dead`, ragdoll `dying` and then `frozen`, and he stayed dead for the 300 ticks after.

- Ordinary heavy hits take 4 sim HP each (133, 129, 125...). Hits of the move `critical` take 11-21 at once (121 to 106, 83 to 68, 52 to 37, 21 to 0).
- The killing hit was a `critical` (evaluator outcome `stick`, part torso). The evaluator never ended it: 6 evaluator `kill`s were all deferred (`deferredKills` 6, `renewals` 6), which matches `present()` treating an evaluator kill the sim did not make as a stagger or knockdown. The sim's health decided the end.

## Light-only: not finished

20 light counter-hits then up to 40 more light swings (cap lowered from 150 because the VPS load was 16-25, about 230 ticks per counter swing and no time left). `lights-partial-progress.log` is the last progress I could copy at 16:53Z (the run's JSON is only written at its end):

- 8 counter presses, 5 landed hits, 2204 ticks, foe sim HP 137 to 117 (4 per light hit). Torso budget fell to its 10% floor after 3 hits and stayed there (`heavy_kill_floor_pct`: a light cannot finish it). Head 100%, legs 100%. Ragdoll only alive/stagger, never a fall.
- No light-only fight end observed. At 4 HP per hit, about 30 more light hits would be needed if no `critical` or other bigger hit happens. Whether lights ever trigger the `critical` hit that ended the control is unknown.
- Also seen: at counter press 6 the foe was at stamina 0 and stopped attacking, so my "press during a foe attack" wait ran 700 ticks without a hit. The slow counter phase is the harness's weakness.

## Not verified

- That a light-only fight ends or stalls (the verdict above). If it stalls, the gating rows would be the sim's own HP (`RULES.health` / moves rows, V1-shared) and `data/rules.json` `killAs` / `killAsSwings` / `renewOnKill` (presentation only); I did not establish this.
- Whether foe stamina-exhaustion or regen changes the trend.
- Runs were on a paused fake clock, one run each, no repeat.
- The full light run was still going on the VPS at `/tmp/m4rc/lo/lights.json` (written when it finishes).
- No code change is proposed.
