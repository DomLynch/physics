// Headless NODE run of Frankendom-v3's own sim + M4 rules path (no browser). Run from a V3 checkout (npm ci done) at the live sha, script placed in its scripts/ dir:
//   node scripts/light-sim-node.mjs <outdir>        (node 22: .ts imports are type-stripped by node itself, as `npm test` does)
// Path used (the same code the page uses, nothing re-implemented):
//   sim:        src/fight/duel.ts initialDuel/stepDuel (+ src/fight/combat.ts initialPractice/stepPractice for the AI foe), OPPONENTS.pitborn (the Minotaur's sim), hero weapon longsword
//   evaluator:  src/fight/rules-eval.ts createRulesEval(...).hit(e, simAlive, handSpeed) fed the sim's Hit events exactly as src/fight/ragdoll.ts step() does
//               (killing batch -> simAlive=false, else true), the same hp scale {foe: OPPONENTS.pitborn.health, man: RULES.health}, default rows (m4), @frankendom/physics 3e077903b.
// Not modelled: the animated hand-bone speed (browser only): handSpeed is null, so the evaluator input is the data row `handSpeedRef` (light_p50), as on a stopped-clock page.
// Top-ups: the HERO only (health, stamina every tick). The foe is never written.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as pkg from '@frankendom/physics';
import { initialDuel, stepDuel, idleIntent } from '../src/fight/duel.ts';
import { initialPractice, stepPractice } from '../src/fight/combat.ts';
import { OPPONENTS, RULES as SIM_RULES } from '../src/fight/moves.ts';
import { createRulesEval } from '../src/fight/rules-eval.ts';

const out = process.argv[2] ?? 'out'; mkdirSync(out, { recursive: true });
const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const ROWS = read('../data/rules.json'), BODY = read('../node_modules/@frankendom/physics/data/bodies/minotaur-106.measure.json');
const FOE = OPPONENTS.pitborn, MAX_LANDED = Number(process.env.MAX_LANDED ?? 300), MAX_TICKS = Number(process.env.MAX_TICKS ?? 400000);
const it = (o = {}) => ({ ...idleIntent(), ...o });

// swing: 'light' | 'heavy'. foe: 'idle' (he never attacks: no counter-hits possible) | 'ai' (the page's AI). press: 'any' (swing whenever ready and in range) | 'counter' (swing only while the foe is mid-attack)
function run({ name, swing, foe, press }) {
  const rules = createRulesEval(ROWS, pkg, BODY, 'pitborn', () => 0, { foe: FOE.health ?? SIM_RULES.health, man: SIM_RULES.health }, '');
  const action = swing === 'heavy' ? 'heavy' : 'light';
  let duel, practice;
  if (foe === 'ai') { practice = initialPractice(731, FOE, 'longsword'); duel = practice.duel; } else duel = initialDuel(FOE, 'longsword');
  const advance = (heroIntent, foeIntent) => {
    if (foe === 'ai') { practice = stepPractice(practice, heroIntent); duel = practice.duel; } else duel = stepDuel(duel, [heroIntent, foeIntent]);
  };
  advance(it({ action: 'light' }), it({ action: 'light' }));   // both draw
  const log = [], tally = { landedHits: 0, byOutcome: {}, counterHits: 0, swingsPressed: 0 };
  let verdict = null, lastPress = -999;
  for (let n = 0; n < MAX_TICKS && !verdict; n++) {
    const [h, f] = duel.fighters;
    h.health = h.maxHealth; h.stamina = h.maxStamina;   // HERO only
    const gap = Math.hypot(h.body.x - f.body.x, h.body.z - f.body.z);
    let hi = it();
    if (h.phase === 'sheathed' || h.phase === 'draw') hi = it();
    else if (gap > 1.5) { const g = gap || 1; hi = it({ move: { x: (f.body.x - h.body.x) / g, z: (f.body.z - h.body.z) / g, yaw: 0, run: false } }); }
    else if (h.phase === 'ready' && f.phase !== 'dead' && (press === 'any' || f.phase === 'attack') && n - lastPress > 5) { hi = it({ action }); lastPress = n; tally.swingsPressed++; }
    advance(hi, it());
    const events = duel.events, killed = events.find((e) => e.type === 'Killed' && e.target === 1);
    for (const e of events) {
      if (e.type !== 'Hit' || e.target !== 1) continue;
      const p = rules.hit(e, !killed, null);
      const lastRes = rules.debug.last.at(-1), fs = rules.debug.fighter().parts;
      tally.landedHits++; if (e.counter) tally.counterHits++;
      const oc = lastRes ? lastRes.result.outcome : 'skipped'; tally.byOutcome[oc] = (tally.byOutcome[oc] ?? 0) + 1;
      log.push({ hit: tally.landedHits, tick: duel.tick, move: e.move, zone: e.location, counter: !!e.counter, simDamage: e.damage, foeSimHpAfter: duel.fighters[1].health, foeMaxHp: duel.fighters[1].maxHealth,
        torsoHp: fs.torso.hp, torsoMax: fs.torso.max, headHp: fs.head.hp, headMax: fs.head.max, evalOutcome: oc, evalDamage: lastRes?.result.damage ?? null, evalPart: lastRes?.result.part ?? null,
        action: p?.action ?? null, deferredKill: p?.deferredKill ?? false, simKills: !!killed, foePhase: duel.fighters[1].phase });
    }
    if (killed || duel.fighters[1].health <= 0 || duel.fighters[1].phase === 'dead') { verdict = { ended: true, tick: duel.tick, landedHits: tally.landedHits, lastZone: log.at(-1)?.zone, lastMove: log.at(-1)?.move, lastEval: log.at(-1)?.evalOutcome }; break; }
    if (tally.landedHits >= MAX_LANDED) break;
  }
  const fin = duel.fighters[1];
  const res = { name, swing, foe, press, verdict: verdict ?? { ended: false, reason: tally.landedHits >= MAX_LANDED ? `cap ${MAX_LANDED} landed hits` : 'tick cap', tick: duel.tick, landedHits: tally.landedHits },
    tally, foeFinal: { health: fin.health, maxHealth: fin.maxHealth, phase: fin.phase }, evaluator: { byOutcome: rules.debug.byOutcome, deferredKills: rules.debug.deferredKills, renewals: rules.debug.renewals }, hits: log };
  writeFileSync(`${out}/${name}.json`, JSON.stringify(res));
  console.log(name, JSON.stringify({ verdict: res.verdict, landed: tally.landedHits, counters: tally.counterHits, swings: tally.swingsPressed, foeHp: `${fin.health}/${fin.maxHealth}`, evalOutcomes: tally.byOutcome, deferredKills: rules.debug.deferredKills, zones: log.reduce((a, l) => (a[l.zone] = (a[l.zone] ?? 0) + 1, a), {}), simDmgPerHit: [...new Set(log.map((l) => l.simDamage))].slice(0, 8), first5: log.slice(0, 5).map((l) => [l.zone, l.simDamage, l.foeSimHpAfter, l.evalOutcome, l.torsoHp, l.headHp]) }));
  return res;
}
console.log('foe', FOE.id, 'health', FOE.health, 'weapon', FOE.weapon, 'rig', FOE.rig, 'man health', SIM_RULES.health);
for (const c of [
  { name: 'light-nocounter', swing: 'light', foe: 'idle', press: 'any' },
  { name: 'light-ai', swing: 'light', foe: 'ai', press: 'any' },
  { name: 'light-ai-counter', swing: 'light', foe: 'ai', press: 'counter' },
  { name: 'heavy-nocounter-control', swing: 'heavy', foe: 'idle', press: 'any' },
  { name: 'heavy-ai-control', swing: 'heavy', foe: 'ai', press: 'any' },
]) { try { run(c); } catch (err) { console.log(c.name, 'ERROR', err?.stack ?? err); } }
