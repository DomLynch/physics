// Does a fight of only light blows end? Headless Chromium 375x812, paused 60 Hz fake clock (1 rAF = 1 tick), the live default page (m4).
//   node light-only-end.mjs <base> <outfile.json>     env: KEY (KeyF light | KeyG heavy, default KeyF), COUNTERS (20), MORE (150 swings after), PER (300 ticks per swing), QUERY, ALT=KeyG to mix a second key in every 3rd follow swing (control)
// ONLY THE HERO is topped up (health + stamina, every tick). The foe's health/stamina are never written: only the page's own rules move them.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const [base, outFile] = process.argv.slice(2);
const KEY = process.env.KEY ?? 'KeyF', COUNTERS = Number(process.env.COUNTERS ?? 20), MORE = Number(process.env.MORE ?? 150), PER = Number(process.env.PER ?? 300), QUERY = process.env.QUERY ?? '';
const TICK = 1000 / 60, MAXTICKS = Number(process.env.MAXTICKS ?? 60000);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
page.on('pageerror', (e) => console.error(`pageerror ${e.message}`));
await page.clock.install();
await page.goto(`${base}/${QUERY ? `?${QUERY}` : ''}`);
await page.waitForFunction(() => document.getElementById('attack-button')?.getAttribute('aria-disabled') === 'false', null, { timeout: 240000, polling: 'raf' });
await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 2000);
const run = (t) => page.clock.runFor(Math.round(t * TICK));
await run(120);
await page.waitForFunction(() => globalThis.__ragdoll?.state === 'alive', null, { timeout: 90000 });
const phase = () => page.evaluate(() => globalThis.__v3Fight.duel.fighters[0].phase);
for (let i = 0; i < 240 && /sheathed|draw/.test(await phase()); i++) await run(1);
await run(30);
const heroTop = () => page.evaluate(() => { const h = globalThis.__v3Fight.duel.fighters[0]; h.health = h.maxHealth; h.stamina = h.maxStamina; });   // HERO ONLY
const probe = await page.evaluate(() => { const d = globalThis.__v3Fight.duel, f = d.fighters[1]; return { duelKeys: Object.keys(d), foeKeys: Object.keys(f), foeHealth: f.health, foeMax: f.maxHealth, foeStamina: f.stamina, foeMaxStamina: f.maxStamina, foePhase: f.phase, rig: f.rig, weapon: f.weapon, heroWeapon: d.fighters[0].weapon }; });
const OUT = process.env.OUTDIR ?? '.', T0 = Date.now(); await page.screenshot({ path: `${OUT}/ready-idle-375.png`, timeout: 120000 }).catch((e) => console.error('ready still failed')); console.error('probe', JSON.stringify(probe));
const snap = () => page.evaluate(() => {
  const p = globalThis.__v3Fight, [h, f] = p.duel.fighters, r = globalThis.__ragdoll, R = globalThis.__v3Rules;
  return { st: r.state, fh: f.health, fmax: f.maxHealth, fsta: f.stamina, fdown: f.down ?? 0, fphase: f.phase, hphase: h.phase, hh: h.health, gap: Math.hypot(f.body.x - h.body.x, f.body.z - h.body.z), parts: R?.partFractions?.() ?? null,
    nrules: (R?.last ?? []).length, hits: R?.hits ?? 0,
    ev: (p.events || []).map((e) => ({ k: `${e.tick}|${e.type}|${e.actor}|${e.target}|${e.move}|${e.location}|${e.count}`, t: e.type, a: e.actor, mv: e.move, loc: e.location, ctr: e.counter ?? e.counterHit ?? e.stopHit ?? null })),
    over: p.over ?? p.duel.over ?? p.duel.winner ?? p.winner ?? null };
});
const lastRules = (n0) => page.evaluate((n) => (globalThis.__v3Rules?.last ?? []).slice(n).map((e) => ({ swing: e.input.swing, counter: e.input.counterHit, zone: e.input.zone, speed: +e.input.handSpeed.toFixed(2), outcome: e.result.outcome, damage: +e.result.damage.toFixed(2), part: e.result.part, partHpAfter: e.result.partHpAfter === null ? null : +e.result.partHpAfter.toFixed(2), action: e.presentation.action, deferredKill: e.presentation.deferredKill })), n0);
await page.keyboard.down('KeyW');
const press = async (c) => { await page.keyboard.down(c); await page.keyboard.up(c); };
const seen = new Set(); const hits = []; const states = {}; const swings = [];
let t = 0, nr = 0, end = null, lastS = null, pressed = 0;
const nHits = () => hits.filter((x) => !x.marker).length;
const step = async () => {
  await heroTop(); await run(1); t++;
  const s = await snap(); lastS = s; states[s.st] = (states[s.st] ?? 0) + 1;
  for (const e of s.ev) {
    if (seen.has(e.k)) continue; seen.add(e.k);
    if (e.t === 'Hit' && e.a === 0) hits.push({ tick: t, move: e.mv, loc: e.loc, counterFlag: e.ctr, foeHealth: s.fh, foeMax: s.fmax, foeFrac: +(s.fh / s.fmax).toFixed(4), foeStamina: +s.fsta.toFixed(1), parts: s.parts, ragdoll: s.st, foePhase: s.fphase, gap: +s.gap.toFixed(2), rules: null });
    if (e.t === 'Killed' || e.t === 'KnockedDown' || e.t === 'Down') hits.push({ tick: t, marker: e.t, actor: e.a, move: e.mv, foeHealth: s.fh, ragdoll: s.st });
  }
  if (!end && (s.fh <= 0 || s.fphase === 'dead' || s.fdown)) end = { tick: t, why: s.fh <= 0 ? 'foe sim health 0' : s.fphase === 'dead' ? 'foe phase dead' : 'foe.down', foeHealth: s.fh, foePhase: s.fphase, ragdoll: s.st, down: s.fdown, parts: s.parts, over: s.over };
  return s;
};
// evaluator results are matched to this swing's own Hit rows in order
const attach = async () => { const rs = await lastRules(nr); nr += rs.length; const open = hits.filter((h) => !h.marker && h.rules === null); rs.forEach((r, i) => { if (open[i]) open[i].rules = r; else hits.push({ tick: t, orphanRule: r }); }); };
const log = (a, tag) => { const s = lastS; console.error(`${tag} sw${a} t${t} foeHP ${s.fh.toFixed(1)}/${s.fmax} sta ${s.fsta.toFixed(0)} parts ${JSON.stringify(s.parts && Object.fromEntries(Object.entries(s.parts).map(([k, v]) => [k, +v.toFixed(2)])))} rag ${s.st} hits ${nHits()}`); };
let waited = 0;
await step();
// phase 1: COUNTERS counter-hits: press the key while the foe is mid-attack (windup/active/attack)
while (pressed < COUNTERS && !end && t < MAXTICKS) {
  let w = 0;
  while (!end && !/windup|active|attack/.test(lastS.fphase) && w < 600 && t < MAXTICKS) { await step(); w++; waited++; }
  if (end) break;
  const h0 = nHits(), t0 = t;
  await press(KEY); pressed++;
  for (let k = 0; k < PER && !end; k++) { await step(); if (k > 40 && lastS.hphase === 'ready') break; }
  await attach();
  swings.push({ n: pressed, kind: 'counter', startTick: t0, endTick: t, hitsLanded: nHits() - h0, foeHealth: lastS.fh, foeFrac: +(lastS.fh / lastS.fmax).toFixed(4), parts: lastS.parts, ragdoll: lastS.st });
  log(pressed, 'counter');
}
const counterEnd = { tick: t, foeHealth: lastS.fh, hits: nHits() };
// phase 2: press the key whenever the hero is ready, up to PER ticks per swing, MORE swings, until the foe ends
let more = 0;
while (!end && more < MORE && t < MAXTICKS && Date.now() - T0 < 300000) {
  const t0 = t, h0 = nHits();
  const key = process.env.ALT && more % 3 === 2 ? process.env.ALT : KEY;
  while (!end && lastS.hphase !== 'ready' && t - t0 < 200) await step();
  await press(key); more++;
  for (let k = 0; k < PER && !end; k++) { await step(); if (k > 40 && lastS.hphase === 'ready') break; }
  await attach();
  swings.push({ n: pressed + more, kind: key === KEY ? 'follow' : 'alt', key, startTick: t0, endTick: t, hitsLanded: nHits() - h0, foeHealth: lastS.fh, foeFrac: +(lastS.fh / lastS.fmax).toFixed(4), parts: lastS.parts, ragdoll: lastS.st });
  if (more % 10 === 0 || end) log(pressed + more, 'follow');
  if (more === 12) await page.screenshot({ path: `${OUT}/mid-fight-375.png`, timeout: 120000 }).catch((e) => console.error('mid still failed'));
}
let after = null;
if (end) { for (let k = 0; k < 300; k++) await step(); after = { ragdoll: lastS.st, foePhase: lastS.fphase, foeHealth: lastS.fh }; }
const rulesFinal = await page.evaluate(() => { const r = globalThis.__v3Rules; return r && { hits: r.hits, byOutcome: r.byOutcome, deferredKills: r.deferredKills, renewals: r.renewals, cuts: r.cuts }; });
const out = { harness: 'light-only-end.mjs', base, query: QUERY || 'default (m4)', key: KEY, alt: process.env.ALT ?? null, heroToppedUp: 'HERO ONLY (health+stamina every tick); foe never written', probe, counterPresses: pressed, counterPhaseWaitedTicks: waited, counterEnd, followSwings: more, totalTicks: t, end, afterEnd: after, ragdollStateTicks: states, foeFinal: { health: lastS.fh, max: lastS.fmax, fraction: +(lastS.fh / lastS.fmax).toFixed(4), parts: lastS.parts, ragdoll: lastS.st, phase: lastS.fphase, stamina: lastS.fsta }, hitCount: nHits(), rulesFinal, swings, hits };
writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ end, afterEnd: after, totalTicks: t, hitCount: out.hitCount, foeFinal: out.foeFinal, rulesFinal, counterEnd, counterPresses: pressed, followSwings: more }));
if (process.env.STILL) { try { await page.screenshot({ path: process.env.STILL, timeout: 30000 }); } catch (e) { console.error('still failed', e.message.slice(0, 80)); } }
await browser.close();
