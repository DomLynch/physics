// Chain bodies retuned from the game's real measurements (Armagedom PR #435, Web/src/data/creatureChainRows.json: radiusModel = median distance of skin-weighted
// side-wall vertices from the bone axis, in GLB model units). Radii only: part ids and bone maps are unchanged. Each radius below is a FLOOR (the pinned data value
// minus rounding), so a later retune cannot quietly thin a body back to the old placeholder; the ceiling is the "no two non-adjacent capsules overlap at rest" test,
// which also runs here for the five retuned bodies. Where a game radius would overlap, the data holds the largest radius that passes and the file says what limits it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadChainBody, chainBodyNames } from "../src/index.mjs";

const read = (f) => JSON.parse(readFileSync(new URL(`../data/bodies/${f}`, import.meta.url), "utf8"));

// model-unit radius floors (the game's value, or the largest that passes at rest, minus 0.001) and the model scale
const FLOOR = {
  salamander: { scale: 3.6, r: { hind_up_L: 0.075, hind_up_R: 0.075, hind_low_L: 0.095, hind_low_R: 0.095, front_up_L: 0.043, front_up_R: 0.043 } },
  eel: { scale: 0.9, r: { hips: 0.1, chest_a: 0.09, chest_b: 0.13, head: 0.09, tail_a: 0.1, tail_b: 0.1, tail_c: 0.09 } },
  wolf: { scale: 2.5, r: { head: 0.075, tail_a: 0.04, tail_b: 0.026, hind_up_L: 0.038, hind_up_R: 0.038, hind_low_L: 0.045, hind_low_R: 0.045, front_low_L: 0.041, front_low_R: 0.041 } },
  "rat-king": { scale: 6, r: { hips: 0.06, chest: 0.055, head: 0.04, tail_a: 0.05, leg_BL_up: 0.05, leg_BR_up: 0.05 } },
  crow: { scale: 4, r: { hips: 0.027, chest: 0.057, head: 0.052, tail_a: 0.04, leg_BL_up: 0.033, leg_BR_up: 0.033, leg_FL_up: 0.03, leg_FR_up: 0.03 } },
};

for (const [name, want] of Object.entries(FLOOR)) {
  test(`${name}: model scale ${want.scale} and every retuned radius is at or above its game-measured floor`, () => {
    const spec = read(`${name}.chain.json`);
    assert.equal(spec.scale, want.scale);
    for (const [id, floor] of Object.entries(want.r)) {
      const s = spec.segments.find((x) => x.id === id);
      assert.ok(s, `${name}: no part ${id}`);
      assert.ok(s.radius >= floor, `${name}.${id}: radius ${s.radius} is below the floor ${floor}`);
    }
  });
}

test("rat king: scale 6 (Armagedom creatureDefinitions rat-king), still several times heavier than the crow", () => {
  const rat = read("rat-king.chain.json"), crow = read("crow.chain.json");
  assert.equal(rat.scale, 6);
  const total = (s) => s.segments.reduce((a, x) => a + x.mass, 0);
  assert.ok(total(rat) > total(crow) * 3, `rat king ${total(rat)} kg vs crow ${total(crow)} kg`);
  assert.ok(/cube/.test(rat.mass_assumption), "the mass assumption still records the cube-of-ratio step and what replaced it");
});

test("crow: the wing skin rides leg_FL_up / leg_FR_up, so the spec says so and those bones are fatter than the hind uppers' old placeholder", () => {
  const crow = read("crow.chain.json");
  assert.ok(/wing/i.test(crow.about) && /leg_FL_up/.test(crow.about) && /leg_FR_up/.test(crow.about), "about names the front limb bones as the wing carriers");
  assert.ok(!/follow the chest body|wings are skinned to the chest/i.test(crow.about + JSON.stringify(crow.segments)), "the old 'wings follow the chest' note is gone");
  const up = (id) => crow.segments.find((x) => x.id === id);
  assert.equal(up("leg_FL_up").radius, up("leg_FR_up").radius, "wings are symmetric");
  assert.ok(up("leg_FL_up").radius >= 0.03, "wing bones were 0.007; the game measures about 0.09");
  assert.ok(/0\.09/.test(JSON.stringify(crow.segments.filter((s) => s.id.endsWith("_up")))) || /0\.09/.test(crow.about), "the game value (0.09) and what limits the physics radius are written down");
});

// closest distance between two segments (Ericson, Real-Time Collision Detection 5.1.9), same as chain-quadrupeds.test.mjs
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
function segDist(p1, q1, p2, q2) {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2), a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  const c = dot(d1, r), b = dot(d1, d2), den = a * e - b * b;
  let s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0, t = (b * s + f) / e;
  if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
  return Math.hypot(...sub(add(p1, d1, s), add(p2, d2, t)));
}
const axis = (r) => [add(r.rest.centre, r.rest.dir, -r.half_height_m), add(r.rest.centre, r.rest.dir, r.half_height_m)];

for (const name of Object.keys(FLOOR)) {
  test(`${name}: no two capsules that are not parent and child overlap at rest, with a 2 mm margin (the retuned radii are as fat as that allows)`, () => {
    const { row } = loadChainBody(name);
    for (let i = 0; i < row.roles.length; i++) for (let j = i + 1; j < row.roles.length; j++) {
      const a = row.roles[i], b = row.roles[j];
      if (a.id === b.parent || b.id === a.parent) continue;
      const [pa, qa] = axis(a), [pb, qb] = axis(b), gap = segDist(pa, qa, pb, qb) - a.radius_m - b.radius_m;
      assert.ok(gap > 0.002, `${name}: ${a.id} and ${b.id} overlap or touch: gap ${(gap * 100).toFixed(2)} cm`);
    }
  });
}

// ---- density: mass must follow the capsule volume (the radius retune made some parts 3500 kg/m3 and others 13 kg/m3) ----
const volume = (r) => Math.PI * r.radius_m ** 2 * 2 * r.half_height_m + (4 / 3) * Math.PI * r.radius_m ** 3;
// bodies allowed outside 100..3000 kg/m3, each with the reason; keep this list short
const DENSITY_EXCEPTIONS = {
  drone: "one hollow-shell capsule for a hovering machine: about 96 kg/m3 is the point of it (25 kg in a 0.26 m3 envelope)",
};
const DENSITY = { eel: 800, salamander: 300, wolf: 700, "rat-king": 600, crow: 500 }; // placeholders (kg/m3) written into each spec as density_kg_m3

test("every part of every chain body has a density between 100 and 3000 kg/m3 (capsule volume from the built row), except the listed bodies", () => {
  const names = chainBodyNames();
  assert.ok(names.length >= 8, `expected all chain bodies on main, got ${names}`);
  for (const name of names) {
    if (DENSITY_EXCEPTIONS[name]) continue;
    for (const r of loadChainBody(name).row.roles) {
      const d = r.mass_kg / volume(r);
      assert.ok(d >= 100 && d <= 3000, `${name}.${r.id}: ${d.toFixed(0)} kg/m3 (${r.mass_kg} kg in ${volume(r).toFixed(4)} m3)`);
    }
  }
});

for (const [name, density] of Object.entries(DENSITY)) {
  test(`${name}: spec states density_kg_m3 ${density} and every part's mass is that density times its capsule volume (within 2%)`, () => {
    assert.equal(read(`${name}.chain.json`).density_kg_m3, density);
    for (const r of loadChainBody(name).row.roles) {
      const want = density * volume(r);
      assert.ok(Math.abs(r.mass_kg - want) <= 0.02 * want + 0.002, `${name}.${r.id}: mass ${r.mass_kg} kg, ${density} x volume = ${want.toFixed(3)} kg`);
    }
  });
}
