# Light-only fight vs the Minotaur on live V3 (receipt, 2026-10-27)

**Verdict: UNKNOWN (partial: the run hit its 300 s wall cap after only 12 light swings and 2 landed hits).** No DOWN, no STALL observed; nothing here supports either.

Live build: `https://v3.frankendom.com/build.txt` = `eaeade1fd288b220dce299be9d7a5679e27c86db` (read 17:23Z), pinning physics 3e077903b. Default ruleset (no `?rules=`). Headless Chromium on the VPS (not the Mac; load rose from 0.1 to 28 during the run), 375x812, paused 60 Hz clock (1 rAF = 1 tick), driving the live URL (no local port). Harness: `light-fight.mjs` (this folder; `docs/pr-stills/light-only-end/light-only-end.mjs` plus stills and a 300 s cap), run with `COUNTERS=0 MORE=60`, key KeyF (light).

**Top-ups: the HERO only** (health and stamina every tick). The foe's HP and stamina were never written. Foe: sim rig `hero`, weapon cleaver, 137 sim HP.

## Per hit (trace.json)

| tick | move / zone | evaluator outcome | damage | torso budget after | head | foe sim HP | ragdoll |
|---|---|---|---|---|---|---|---|
| 282 | light, torso (swing speed 6.67) | stick | 4.72 | 19.28 (0.80 est.) | 1.00 | not captured for this row (orphan rule row) | stagger |
| 302 | light_right, torso (speed 6.02) | hit | 4.26 | 15.02 (fraction 0.626) | 1.00 | 126 | stagger |

- After 12 swings (632 ticks): foe sim HP 126/137 (0.9197), torso 0.626, head 1.00, arms/legs 1.00, foe phase `ready`, foe stamina 17.9; ragdoll ticks alive 530, stagger 102; no fall. Evaluator: 2 hits, 0 deferred kills, 0 renewals, 0 cuts.
- Neither light killed or dropped a fresh part, consistent with "a single light never kills a fresh part". Torso lost about 4.3-4.7 budget per light, which would mean roughly 4-5 more lights to empty a torso budget of about 24 (an inference from 2 data points; the stated ~5-18 range is not tested by this run).
- 10 of the 12 swings landed nothing (swings 6 and 7 hit): the foe was out of range or evading, and foe stamina was down near 0-18.

## Stills (375 wide)
`ready-idle-375.png`, `mid-fight-375.png` (after swing 12), `end-375.png` (last frame). Raw trace: `trace.json`; script stderr: `err.txt`.

## Not verified
- Whether lights alone ever fell or killed the Minotaur: the run stopped at 2 hits. A real answer needs about 30+ hits, i.e. a longer, uncapped run (the harness is slow under load: about 50 ticks of wall time per second at load 28).
- Which data row would cause a stall, if there is one: not established.
- One run, no repeat. The first torso hit's foe sim HP was not captured (the hit row was an orphan in the harness matching).
