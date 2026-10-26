# M3 receipt (Physics Dev, 2026-10-26)

**Status (updated 2026-10-26 evening): clip delivered; PHONE NUMBER TAKEN by Dom on his iPhone.** Device: iPhone, iOS 26.5, Chrome for iOS (CriOS 155), bench served from https://v3.frankendom.com/physics1/ (V3 build f71c56f), run at about 9:15 pm Dubai on 2026-10-26, phone otherwise idle (battery 48 percent; the phone does not report a load average). Five fighters + one cut, 210 timed frames: **average 0.40 ms, p95 1.00 ms, max 1.00 ms (timer rounds to 1 ms), under 3 ms: YES.** Calibration loop 18.0 ms = 0.89x the quiet M-series Mac reference (20.2 ms). Source: Dom's screenshot sent in the Physics Dev session. ARMAGEDOM (ten passive ragdolls) is still NOT measured on a phone.

## Clip
`docs/clips/m3-minotaur-375.mp4` (333 KB, 12 s, 375x812 at 2x, 30 fps from 60 Hz ticks). Minotaur (Frankendom V3 `src/assets/minotaur.glb`, 65-joint rig) skinned from the ragdoll by role. Timeline in `proof/m3/timeline.json`: guard; hit at 1.5 s (stagger dip: hold 0.5 s, back over 0.35 s); final blow at 4.5 s (motors 1 to 0.01 over 1 s, hit impulse the same tick, freeze under 0.02 squared speed). Captured by `tools/capture-clip.mjs` on the VPS (Chromium, software GL, load about 53). The camera approximates V3's fight camera (about 2.2 m up, 1.0 m over the shoulder, pulled in); it is not V3's real camera. No hero on screen. Known weak: the stagger reads only as a small head and torso movement (head moves 0.33 m in the sim); stagger values are the brief's start values, retune on Dom's verdict.

## Frame time, five fighters + one cut (NOT a phone)
| where | load | avg | p95 | max |
|---|---|---|---|---|
| Node 22, VPS, `npm run test:budget` (0.2 ms avg) | about 60 | 0.21 ms | 0.99 ms | 2.6 ms |
| Chromium headless, VPS, software GL, one core, `proof/bench` | 4.75 | 1.375 ms | 3.3 ms | 14.2 ms |
| same, earlier run | 55 to 65 | 1.29 to 1.44 ms | 3.0 to 3.5 ms | 13.5 to 14 ms |
Calibration loop (4M iterations, median of 5) was 111.6 ms on that VPS core against 20.2 ms on a quiet M-series Mac (OpenTrident M1), so it is about 5.5x slower than that Mac. The bench page (`proof/bench/dist/bench.html`, built by `npm run build:bench`, one file, no external requests) prints the number on screen for a real phone.

## ARMAGEDOM
Not claimed. OpenTrident's iOS-Simulator number at the role-table setting (4.29 ms avg, Mac load 14 to 21) fails 3 ms; it passes only at 60 Hz (2.23 ms). A real phone or quiet-window run decides.

## Not touched
M2 pose gate (3 of 50 generated bodies and the dwarf fail 10 degrees) is Dom's decision, not tuned.
