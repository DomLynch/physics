# Heavy-blow fight on live V3 vs the default foe (PARTIAL, 2026-10-27)

**Verdict: UNKNOWN whether a heavy-only fight ends on eaeade1fd (run killed at the 540 s wall cap before its JSON was written). Partial progress and a mixed sequence below.**

Live build: `https://v3.frankendom.com/build.txt` = `eaeade1fd288b220dce299be9d7a5679e27c86db` (read 17:23Z). Pins physics 3e077903b. Default ruleset (no `?rules=`). Headless Chromium on the VPS (not the Mac), 375x812, paused 60 Hz clock (1 rAF = 1 tick), live URL, no local port.
Foe: the default opponent; probe says sim rig `hero`, weapon cleaver, 137 sim HP (I did not verify this is the Minotaur). **Top-ups: HERO only** (health+stamina every tick); the foe is never written.
Harness: `heavy-fight.mjs` (this folder; light-only-end.mjs plus SEQ key sequence, WALK, and stills).

## Heavy run (KEY=KeyG, up to 25 heavies, 540 s cap): partial only
`heavy-progress.log` / `heavy.log` (only the sw10 progress line exists): after 10 heavy swings (666 ticks) 8 hits landed, foe sim HP 87/137, torso budget 43%, head/arms/legs 100%, foe stamina 40, ragdoll `knockdown`. No fight end observed before the timeout. Per-hit rows (outcome, falls, ticks to end) were NOT captured because the JSON is written only at run end. Reference (previous build 9b76784f): the heavy control ended the fight at tick 1609, 24 swings, 20 hits.
Not repeated: deadline.

## Mixed sequence light, light, heavy, light (`mixed.json`, after 300 walk ticks)
- sw1 F: 1 hit, light_right on torso, outcome `hit`, 4.26 dmg, action `stagger`, foe HP 137 to 134, torso budget 82%.
- sw2 F: 0 hits. sw3 G (heavy): 1 hit, outcome `stick`, foe HP 134 to 130, torso budget 26%. sw4 F: 0 hits.
- 509 ticks total, foe 130/137, ragdoll `alive`, no fall, no end. rulesFinal: hits 2 (hit 1, stick 1), no kills or cuts.

## Stills (375 wide, mixed run)
`mixed-ready-idle-375.png`, `mixed-mid-fight-375.png` (after swing 2), `mixed-end-375.png` (end of the 4 swings). Heavy-run stills failed (screenshot timeout under load); none for the heavy run.

## Not verified
Heavy-only fight end; per-hit kill/cut/stagger outcomes and falls for the heavy run; foe identity (Minotaur); single runs, no repeat.
