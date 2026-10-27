// Live-page light-only fight to the end. Headless Chromium 375x812@2x, paused 60 Hz clock stepped in large batches.
// In-page controller (rAF, one per tick): tops up the HERO only, swings KeyF (light) when hero is ready and foe in reach. Foe is never written.
//   node light-live.mjs <base> <outdir>      env: CAP_MS (720000), BATCH (120), REACH (gap), PROBE=<ticks> (short probe)
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const [base, OUT] = process.argv.slice(2);
const CAP = Number(process.env.CAP_MS ?? 720000), BATCH = Number(process.env.BATCH ?? 120), TICK = 1000 / 60, T0 = Date.now();
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
page.on('pageerror', (e) => console.error(`pageerror ${e.message}`));
await page.clock.install();
await page.goto(`${base}/`);
await page.waitForFunction(() => document.getElementById('attack-button')?.getAttribute('aria-disabled') === 'false', null, { timeout: 240000, polling: 'raf' });
await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 2000);
const run = (t) => page.clock.runFor(Math.round(t * TICK));
await run(120);
await page.waitForFunction(() => globalThis.__ragdoll?.state === 'alive', null, { timeout: 90000 });
const phase = () => page.evaluate(() => globalThis.__v3Fight.duel.fighters[0].phase);
for (let i = 0; i < 240 && /sheathed|draw/.test(await phase()); i++) await run(1);
await run(30);
const build = (await (await fetch(`${base}/build.txt`)).text()).trim();
await page.screenshot({ path: `${OUT}/ready-idle-375.png`, timeout: 120000 }).catch(() => {});
await page.keyboard.down('KeyW');   // walk toward the foe (kept down; the hero stops at melee range)
await page.evaluate((REACH) => {
  const S = globalThis.__LL = { tick: 0, presses: 0, hits: [], seen: new Set(), end: null, gaps: [], lastPress: -999, ruleN: 0, log: [] };
  const fire = (type) => window.dispatchEvent(new KeyboardEvent(type, { code: 'KeyF', key: 'f', bubbles: true }));
  const loop = () => {
    const p = globalThis.__v3Fight, [h, f] = p.duel.fighters, R = globalThis.__v3Rules;
    h.health = h.maxHealth; h.stamina = h.maxStamina;           // HERO ONLY
    S.tick++;
    const gap = Math.hypot(f.body.x - h.body.x, f.body.z - h.body.z);
    if (S.tick % 30 === 0 && S.gaps.length < 40) S.gaps.push([S.tick, +gap.toFixed(2), h.phase, f.phase]);
    for (const e of (p.events || [])) {
      const k = `${e.tick}|${e.type}|${e.actor}|${e.target}|${e.move}|${e.location}|${e.count}`;
      if (S.seen.has(k)) continue; S.seen.add(k);
      if (e.type === 'Hit' && e.actor === 0) S.hits.push({ tick: S.tick, move: e.move, loc: e.location, ctr: e.counter ?? e.counterHit ?? null, foeHP: f.health, foeMax: f.maxHealth, foeSta: +f.stamina.toFixed(1), parts: R?.partFractions?.() ?? null, ragdoll: globalThis.__ragdoll?.state, foePhase: f.phase, gap: +gap.toFixed(2) });
      else if (e.type === 'Killed' || e.type === 'KnockedDown' || e.type === 'Down') S.hits.push({ tick: S.tick, marker: e.type, actor: e.actor, foeHP: f.health });
    }
    const rl = R?.last ?? []; while (S.ruleN < rl.length) { const e = rl[S.ruleN++]; const open = S.hits.find((x) => !x.marker && !x.rule); if (open) open.rule = { swing: e.input.swing, zone: e.input.zone, outcome: e.result.outcome, damage: +e.result.damage.toFixed(2), part: e.result.part }; }
    if (!S.end && (f.health <= 0 || f.phase === 'dead' || f.down)) S.end = { tick: S.tick, foeHP: f.health, foePhase: f.phase, down: f.down ?? null, ragdoll: globalThis.__ragdoll?.state, over: p.over ?? p.duel.over ?? p.duel.winner ?? p.winner ?? null };
    if (!S.end && h.phase === 'ready' && gap < REACH && S.tick - S.lastPress > 6) { fire('keydown'); fire('keyup'); S.presses++; S.lastPress = S.tick; }
    if (S.tick % 600 === 0) S.log.push({ t: S.tick, foeHP: f.health, hits: S.hits.filter((x) => !x.marker).length, presses: S.presses, gap: +gap.toFixed(2) });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}, Number(process.env.REACH ?? 2.2));
const st = () => page.evaluate(() => { const S = globalThis.__LL, f = globalThis.__v3Fight.duel.fighters[1]; return { tick: S.tick, presses: S.presses, hits: S.hits.filter((x) => !x.marker).length, foeHP: f.health, foeMax: f.maxHealth, end: S.end, gaps: S.gaps.slice(-3) }; });
let lastHits = 0, s;
while (Date.now() - T0 < CAP) {
  await run(BATCH); s = await st();
  if (s.hits >= lastHits + 10 || s.tick % 1200 < BATCH) { console.error(`LL t${s.tick} presses ${s.presses} landed ${s.hits} foeHP ${s.foeHP}/${s.foeMax} gaps ${JSON.stringify(s.gaps)} wall ${((Date.now() - T0) / 1000) | 0}s`); lastHits = s.hits - (s.hits % 10); }
  if (s.end || (process.env.PROBE && s.tick > Number(process.env.PROBE))) break;
}
let after = null;
if (s.end) { await run(180); after = await page.evaluate(() => { const f = globalThis.__v3Fight.duel.fighters[1]; return { foeHP: f.health, foePhase: f.phase, down: f.down ?? null, ragdoll: globalThis.__ragdoll?.state }; }); }
const hud = await page.evaluate(() => ({ text: document.body.innerText.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 40), defeated: /Minotaur defeated\./.test(document.body.innerText), v3Picked: globalThis.__v3Picked ?? null }));
await page.screenshot({ path: `${OUT}/end-375x812@2x.png`, timeout: 120000 }).catch(() => console.error('end still failed'));
const final = await page.evaluate(() => { const S = globalThis.__LL; return { S: { tick: S.tick, presses: S.presses, end: S.end, log: S.log, gaps: S.gaps, hits: S.hits }, R: globalThis.__v3Rules && { hits: globalThis.__v3Rules.hits, byOutcome: globalThis.__v3Rules.byOutcome, deferredKills: globalThis.__v3Rules.deferredKills }, foe: (({ health, maxHealth, phase, down, stamina }) => ({ health, maxHealth, phase, down, stamina }))(globalThis.__v3Fight.duel.fighters[1]) }; });
writeFileSync(`${OUT}/trace.json`, JSON.stringify({ build, base, wallSec: (Date.now() - T0) / 1000, afterEnd: after, hud, ...final }, null, 1));
console.log(JSON.stringify({ build, wallSec: (Date.now() - T0) / 1000, end: final.S.end, afterEnd: after, presses: final.S.presses, landed: final.S.hits.filter((x) => !x.marker).length, foe: final.foe, hud: { defeated: hud.defeated, v3Picked: hud.v3Picked } }));
await browser.close();
