// Rules evaluator: consumes data/rules.json (M4 rows, M6 schema) and decides what one hit does to one fighter.
// Pure and deterministic: same rows + same hit + same state in, same result and same state out. No clock, no
// global random source: time comes in on the hit (`t`, seconds of sim time) and the finisher roll takes a
// caller-supplied `rand()`. State is plain JSON (server and phone can both hold it); evaluateHit mutates the
// state it is given (that is what "state" is for) and returns the same object in `result.state`.
// Every number is read from the rows; a missing row throws. The only literals here are unit conversions (percent).
// Speed in: `hit.handSpeed` (m/s of the attacker's hand end; the evaluator multiplies it by the weapon lever
// (lever.arm_reach_m + weapons.<id>.length_m) / lever.arm_reach_m) OR `hit.tipSpeed` (a weapon tip speed that already carries the lever); never both.
// `hit.armReachM` overrides lever.arm_reach_m for a body with its own arm. Then strength = tip x sharpness x (swing.heavy_mult if
// hit.swing === "heavy") x (swing.counter_hit_mult if hit.counterHit) x the speed-gate ramp; the gate and the bone gate read the physical tip speed.
import { loadRules, assertRules } from "./rules.mjs";

const fail = (msg) => { throw new Error("rules-eval: " + msg); };
const num = (v, path) => (typeof v === "number" && Number.isFinite(v) ? v : fail(`row ${path} is missing or not a number`));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const SIDES = ["left", "right"];

function need(rules, path) {
  let cur = rules;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !(k in cur)) fail(`row ${path} is missing`);
    cur = cur[k];
  }
  return cur;
}

// ---- state -------------------------------------------------------------------------------------------
const PART_IDS = ["head", "torso", "arm_left", "arm_right", "leg_left", "leg_right"];

// part ids from a ragdoll body measure row (joint names) or an explicit list of part ids
function partIdsOf(input) {
  if (Array.isArray(input)) return input.slice();
  if (input && typeof input === "object" && input.joints) {
    const j = Object.keys(input.joints).map((k) => k.toLowerCase());
    const has = (re) => j.some((k) => re.test(k));
    const ids = [];
    if (has(/head/)) ids.push("head");
    if (has(/spine|chest|torso/)) ids.push("torso");
    for (const S of SIDES) {
      if (has(new RegExp(`${S}.*arm`))) ids.push("arm_" + S);
      if (has(new RegExp(`${S}.*(upleg|thigh|leg)`))) ids.push("leg_" + S);
    }
    return ids;
  }
  return fail("createFighterState needs a body measure row (with joints) or an array of part ids");
}

export function createFighterState(rules, bodyMeasureRowOrPartIds = PART_IDS, opts = {}) {
  const hp = need(rules, "part_hp");
  const sword = opts.sword_side || "right";
  if (!SIDES.includes(sword)) fail("sword_side must be left or right");
  const legMin = num(hp.legs_min, "part_hp.legs_min");
  const legMax = num(hp.legs_max, "part_hp.legs_max");
  const legHp = clamp(opts.leg_hp ?? (legMin + legMax) / 2, legMin, legMax);
  const swordId = "arm_" + sword;
  const budgetOf = (id) => {
    if (id === "head") return num(hp.head, "part_hp.head");
    if (id === "torso") return num(hp.torso, "part_hp.torso");
    if (id === swordId) return num(hp.arm_sword, "part_hp.arm_sword");
    if (id.startsWith("arm_")) return num(hp.arm_off, "part_hp.arm_off");
    if (id.startsWith("leg_")) return legHp;
    return fail(`no part_hp row for part ${id}`);
  };
  const ids = partIdsOf(bodyMeasureRowOrPartIds);
  const parts = {};
  // opts.hp_scale multiplies every budget (map the part rows onto a game's own health pools); opts.budgets sets single parts absolutely ({ head: 60, torso: 400 })
  const scale = opts.hp_scale ?? 1;
  if (!(scale > 0)) fail("hp_scale must be a positive number");
  const budget = (id) => { const o = opts.budgets && opts.budgets[id]; if (o !== undefined && !(o > 0)) fail(`budgets.${id} must be a positive number`); return o !== undefined ? o : budgetOf(id) * scale; };
  for (const id of PART_IDS) if (ids.includes(id)) parts[id] = { hp: budget(id), max: budget(id), gone: false };
  for (const id of ["head", "torso"]) if (!parts[id]) fail(`body has no ${id} part (needs at least head and torso)`);
  return {
    schema: "fighter-state/1",
    alive: true,
    sword_side: sword,
    parts,
    knockdown: { counter: 0, grace_until: 0, stun_count: 0, stun_last_t: null, falls: 0 },
    bleed: null,
    limp: false,
    weapon_dropped: false,
    outgoing_damage_mult: 1,
    cause_of_death: null,
  };
}

// ---- finisher roll (killing blows only) ----------------------------------------------------------------
// chance = base + per_overkill x overkill percent, capped; 100 on a match-winning or boss kill and after the pity count.
// `rand` is caller-supplied (seeded sim random) so a replay reproduces it. Not rolled when the chance is a sure thing.
export function rollFinisher(rules, ctx, rand) {
  const f = need(rules, "evaluator.finisher");
  const base = num(f.base_pct, "evaluator.finisher.base_pct");
  const per = num(f.per_overkill_pct, "evaluator.finisher.per_overkill_pct");
  const cap = num(f.cap_pct, "evaluator.finisher.cap_pct");
  const pity = num(f.pity_after_kills, "evaluator.finisher.pity_after_kills");
  const since = ctx.killsSinceFinisher ?? 0;
  const sure = !!ctx.matchWinning || !!ctx.boss || since >= pity;
  const chancePct = sure ? 100 : Math.min(cap, base + per * Math.max(0, ctx.overkillPct ?? 0));
  let finisher = sure;
  if (!sure) {
    if (typeof rand !== "function") fail("rollFinisher needs a rand() function");
    finisher = rand() * 100 < chancePct;
  }
  return { finisher, chancePct, killsSinceFinisher: finisher ? 0 : since + 1 };
}

// ---- evaluator ----------------------------------------------------------------------------------------
export function createEvaluator(rules = loadRules()) {
  assertRules(rules);
  const scale = need(rules, "strength_scale");
  const rungHit = num(scale.rung_hit, "strength_scale.rung_hit");
  const rungStick = num(scale.rung_stick, "strength_scale.rung_stick");
  const rungCut = num(scale.rung_cut, "strength_scale.rung_cut");
  const heavyMult = num(need(rules, "swing.heavy_mult"), "swing.heavy_mult");
  const counterMult = num(need(rules, "swing.counter_hit_mult"), "swing.counter_hit_mult");
  const armReachRow = num(need(rules, "lever.arm_reach_m"), "lever.arm_reach_m");
  const gate = need(rules, "melee_speed_gate");
  const gateMin = num(gate.min_speed_m_s, "melee_speed_gate.min_speed_m_s");
  const gateMargin = num(gate.full_strength_margin_m_s, "melee_speed_gate.full_strength_margin_m_s");
  const bone = need(rules, "bone_gate");
  const boneNum = num(bone.numerator_m_s, "bone_gate.numerator_m_s");
  const boneMin = num(bone.bone_mult_min, "bone_gate.bone_mult_min");
  const boneMax = num(bone.bone_mult_max, "bone_gate.bone_mult_max");
  const globalScale = num(need(rules, "global.damage_scale"), "global.damage_scale");
  const kd = need(rules, "knockdown");
  const fallAt = num(kd.counter_fall_at, "knockdown.counter_fall_at");
  const cap = num(kd.counter_cap, "knockdown.counter_cap");
  const graceS = num(kd.getup_grace_s, "knockdown.getup_grace_s");
  const pushOver = num(kd.push_force_over, "knockdown.push_force_over");
  const stunPct = need(rules, "knockdown.stun_duration_pct");
  const resets = need(rules, "knockdown.counter_resets_on_fall") === true;
  const fallS = need(rules, "knockdown.fall_seconds");
  const stunWindow = num(need(rules, "evaluator.stun_window_s"), "evaluator.stun_window_s");
  const armGone = num(need(rules, "locational.arm_gone_damage_mult"), "locational.arm_gone_damage_mult");
  const crawl = num(need(rules, "locational.leg_crawl_to_stand_s"), "locational.leg_crawl_to_stand_s");
  const bleedMin = num(need(rules, "bleed_out.seconds_min"), "bleed_out.seconds_min");
  const bleedMax = num(need(rules, "bleed_out.seconds_max"), "bleed_out.seconds_max");
  const kinds = need(rules, "evaluator.kinds");
  const zonePart = need(rules, "evaluator.zone_part");
  const zoneUnit = need(rules, "evaluator.zone_cut_unit");
  const unitBone = need(rules, "evaluator.unit_bone_mult");
  const killRule = need(rules, "evaluator.kill");
  // a LIGHT swing never takes an undamaged kill part (evaluator.kill.any_part_gone: head, torso) to zero: it cannot cut it and its damage stops at
  // light_floor_pct of that part's budget. A heavy swing, or a light one on a part already at or under the floor, kills as before. 0 = off.
  const lightFloorPct = num(killRule.light_floor_pct, "evaluator.kill.light_floor_pct");
  // heavy-kill floor: while a kill part's hp is AT OR ABOVE this percent of its budget a LIGHT swing cannot cut it or take it to zero (its damage stops at the floor);
  // only a heavy blow finishes it. A light swing on a part strictly under the floor may still finish it. Closes the 2-light-counter-hit kill. 0 = off.
  const heavyKillFloorPct = num(killRule.heavy_kill_floor_pct, "evaluator.kill.heavy_kill_floor_pct");

  const fill = (tpl, side, state) => {
    if (tpl === null) return null;
    const sword = state.sword_side;
    const off = sword === "left" ? "right" : "left";
    if (tpl.includes("{side}") && !SIDES.includes(side)) fail(`hit.side ("left" or "right") is required for a zone that names {side}`);
    return tpl.replace("{side}", side).replace("{sword}", sword).replace("{off}", off);
  };

  const tierOf = (armour, zone) => {
    const id = armour === undefined || armour === null ? "none" : typeof armour === "string" ? armour : armour[zone] ?? "none";
    return [id, rules.armour_tiers[id] || fail(`unknown armour tier ${id}`)];
  };

  function isKill(state) {
    const gone = (id) => !state.parts[id] || state.parts[id].gone;
    for (const id of killRule.any_part_gone) if (state.parts[id] && state.parts[id].gone) return id;
    for (const group of killRule.all_parts_gone) if (group.every((id) => state.parts[id] && gone(id))) return group.join("+");
    return null;
  }

  function evaluateHit(hit, state, opts = {}) {
    if (!hit || typeof hit !== "object") fail("hit must be an object");
    if (!state || state.schema !== "fighter-state/1") fail("state must come from createFighterState");
    const t = num(hit.t, "hit.t (sim seconds)");
    const w = rules.weapons[hit.weapon] || fail(`unknown weapon ${hit.weapon}`);
    // speed in: a measured hand speed (x the weapon's lever) OR a weapon tip speed that already carries the lever; never both
    if (hit.handSpeed !== undefined && hit.tipSpeed !== undefined) fail("give hit.handSpeed or hit.tipSpeed, not both");
    let tip, lever = null;
    if (hit.handSpeed !== undefined) {
      const reach = hit.armReachM === undefined ? armReachRow : num(hit.armReachM, "hit.armReachM");
      if (!(reach > 0)) fail("hit.armReachM must be above 0");
      const len = typeof w.length_m === "number" ? w.length_m : fail(`weapon ${hit.weapon} has no length_m (${w.todo || "row is null"})`);
      lever = (reach + len) / reach;
      tip = num(hit.handSpeed, "hit.handSpeed") * lever;
    } else tip = num(hit.tipSpeed, "hit.tipSpeed (or hit.handSpeed)");
    const swingType = hit.swing === undefined ? "light" : hit.swing;
    if (swingType !== "light" && swingType !== "heavy") fail(`hit.swing must be "light" or "heavy", got ${swingType}`);
    if (hit.counterHit !== undefined && typeof hit.counterHit !== "boolean") fail("hit.counterHit must be a boolean");
    const counterHit = hit.counterHit === true;
    const swingMult = (swingType === "heavy" ? heavyMult : 1) * (counterHit ? counterMult : 1);
    const kind = kinds[hit.kind] || fail(`unknown hit kind ${hit.kind}`);
    const zoneRow = rules.zones[hit.zone] || fail(`unknown zone ${hit.zone}`);
    const events = [];
    const result = { outcome: "miss", strength: 0, damage: 0, part: null, partHpAfter: null, knockdown: null, cut: null, bleed: false, finisher: null, tipSpeed: tip, lever, swing: swingType, counterHit, swingMult, sharpness: null, events, state };

    // bleed timer that ran out before this hit
    if (state.alive && state.bleed && t >= state.bleed.until) {
      state.alive = false; state.cause_of_death = "bleed_out"; state.bleed = null;
      events.push({ type: "bleed_out", t });
    }

    const part = fill(need(rules, "evaluator.zone_part." + hit.zone), hit.side, state);
    const unit = fill(zoneUnit[hit.zone] === undefined ? fail(`no zone_cut_unit row for ${hit.zone}`) : zoneUnit[hit.zone], hit.side, state);
    result.part = part;
    const ps = state.parts[part];
    if (!ps) { events.push({ type: "no_such_part", part }); return result; }
    result.partHpAfter = ps.hp;

    // melee speed gate, then the ramp to full strength
    if (tip < gateMin) { events.push({ type: "below_speed_gate", tipSpeed: tip, min: gateMin }); return result; }
    const ramp = gateMargin > 0 ? clamp((tip - gateMin) / gateMargin, 0, 1) : 1;

    // one strength number: tip speed x sharpness x swing multipliers (x speed-gate ramp)
    const sharp = kind.sharpness_column === null ? num(kind.sharpness, `evaluator.kinds.${hit.kind}.sharpness`)
      : w[kind.sharpness_column] === null || w[kind.sharpness_column] === undefined
        ? fail(`weapon ${hit.weapon} has no ${kind.sharpness_column} (${w.todo || "row is null"})`) : num(w[kind.sharpness_column], `weapons.${hit.weapon}.${kind.sharpness_column}`);
    const strength = tip * sharp * swingMult * ramp;
    result.strength = strength;
    result.sharpness = sharp;
    if (strength < rungHit) { events.push({ type: "below_hit_rung", strength, rung: rungHit }); return result; }
    if (ps.gone) { events.push({ type: "part_gone", part }); return result; }

    // armour: raises the cut threshold and the bone gate, trims damage, never blocks
    const [tierId, tier] = tierOf(hit.armour, hit.zone);
    const mod = num(tier.dismember_threshold_modifier, `armour_tiers.${tierId}.dismember_threshold_modifier`);
    const cutThreshold = rungCut * mod;
    let boneGate = null;
    if (kind.can_sever && unit) {
      const bm = clamp(num(w[kind.bone_column], `weapons.${hit.weapon}.${kind.bone_column}`) * num(unitBone[unit], `evaluator.unit_bone_mult.${unit}`), boneMin, boneMax);
      boneGate = (boneNum / Math.sqrt(bm)) * mod;
    }
    result.cutThreshold = cutThreshold;
    result.boneGateSpeed = boneGate;
    const overRung = strength >= cutThreshold;
    let canCut = kind.can_sever && unit !== null && overRung && tip >= boneGate;
    if (kind.can_sever && unit !== null && overRung && !canCut && tip < boneGate) events.push({ type: "bone_gate_not_met", tipSpeed: tip, gate: boneGate });

    // damage = strength x zone x global x armour column (x 0.3 if the attacker lost his sword arm)
    const atk = hit.attacker ? num(hit.attacker.outgoing_damage_mult, "hit.attacker.outgoing_damage_mult") : 1;
    const dealt = strength * num(zoneRow.body_part_mult, `zones.${hit.zone}.body_part_mult`) * globalScale
      * num(tier.damage_taken_mult[kind.armour_column], `armour_tiers.${tierId}.damage_taken_mult.${kind.armour_column}`) * atk;
    const dead = !state.alive;
    // light-swing floor (see lightFloorPct): the cut is refused and the damage that reaches the part is capped; `dealt` (the blow's force) still feeds the knockdown counter
    let applied = dealt;
    const floorHp = ps.max * lightFloorPct / 100;
    if (!dead && swingType === "light" && lightFloorPct > 0 && killRule.any_part_gone.includes(part) && ps.hp > floorHp && (canCut || dealt >= ps.hp - floorHp)) {
      applied = Math.min(dealt, ps.hp - floorHp);
      events.push({ type: "light_floor", part, cutRefused: canCut, floorHp, floorPct: lightFloorPct });
      canCut = false;
    }
    const heavyHp = ps.max * heavyKillFloorPct / 100;
    if (!dead && swingType === "light" && heavyKillFloorPct > 0 && killRule.any_part_gone.includes(part) && ps.hp >= heavyHp && (canCut || applied >= ps.hp - heavyHp)) {
      applied = Math.min(applied, ps.hp - heavyHp);
      events.push({ type: "heavy_kill_floor", part, cutRefused: canCut, floorHp: heavyHp, floorPct: heavyKillFloorPct });
      canCut = false;
    }
    result.damage = dead ? 0 : applied;
    if (dead) events.push({ type: "dead_target" });

    // apply to the part budget (a living target only; a corpse is only cut)
    let overkillPct = 0;
    if (!dead) {
      const before = ps.hp;
      ps.hp = canCut ? 0 : Math.max(0, ps.hp - applied);
      if (ps.hp === 0) { ps.gone = true; events.push({ type: "part_down", part, budgetBefore: before }); }
      overkillPct = (Math.max(0, strength - rungCut) / ps.max) * 100;
    }
    if (canCut) {
      result.cut = { unit };
      ps.hp = 0; ps.gone = true; // zone_part and zone_cut_unit are paired per zone: the cut unit is the struck part
      events.push({ type: "cut", unit, tipSpeed: tip, cutThreshold, boneGate });
    }
    result.partHpAfter = state.parts[part].hp;

    // locational outcomes
    const goneNow = !dead && state.parts[part].gone;
    if (goneNow || (canCut && dead)) {
      if (part === "arm_" + state.sword_side && !state.weapon_dropped) {
        state.weapon_dropped = true; state.outgoing_damage_mult = armGone;
        events.push({ type: "weapon_drop", arm: part, outgoing_damage_mult: armGone });
      } else if (part.startsWith("arm_") && part !== "arm_" + state.sword_side) events.push({ type: "off_arm_gone", arm: part });
      if (part.startsWith("leg_") && !state.limp) {
        state.limp = true;
        events.push({ type: "leg_gone", leg: part, crawl_to_stand_s: crawl });
      }
    }

    // kill rules
    if (!dead) {
      const why = isKill(state);
      if (why) { state.alive = false; state.cause_of_death = why; state.bleed = null; events.push({ type: "kill", why }); }
    }

    // bleed: a severed unit, or a stab over the kill line, starts one timer (only if alive, never restarted)
    if (state.alive && !state.bleed && (canCut || (overRung && !kind.can_sever && kind.sharpness_column !== null))) {
      const f = clamp((strength - cutThreshold) / cutThreshold, 0, 1);
      const seconds = bleedMax - (bleedMax - bleedMin) * f;
      state.bleed = { started: t, until: t + seconds, seconds };
      events.push({ type: "bleed_start", seconds });
    }
    result.bleed = !!state.bleed;

    // knockdown counter, separate from the budgets
    if (state.alive && !dead) {
      const k = state.knockdown;
      let cause = null;
      if (t < k.grace_until) events.push({ type: "knockdown_ignored", grace_until: k.grace_until });
      else {
        k.counter = Math.min(cap, k.counter + dealt * kind.knockdown_mult);
        if (num(hit.force ?? 0, "hit.force") > pushOver) cause = "push";
        else if (k.counter >= fallAt) cause = "damage";
        if (cause) {
          if (k.stun_last_t !== null && t - k.stun_last_t > stunWindow) k.stun_count = 0;
          const pct = stunPct[Math.min(k.stun_count, stunPct.length - 1)];
          if (resets) k.counter = 0;
          if (pct > 0) {
            const fallSeconds = num(fallS[cause], `knockdown.fall_seconds.${cause}`) * (pct / 100);
            const downSeconds = num(fallS.down, "knockdown.fall_seconds.down") * (pct / 100);
            k.stun_count += 1; k.stun_last_t = t; k.falls += 1;
            k.grace_until = t + fallSeconds + downSeconds + graceS;
            result.knockdown = { fallSeconds, downSeconds, cause, graceUntil: k.grace_until, stunPct: pct };
            events.push({ type: "knockdown", ...result.knockdown });
          } else events.push({ type: "stun_diminished_out", window_s: stunWindow });
        }
      }
    }

    // outcome ladder: kill > cut > knockdown > stick > hit
    result.outcome = !state.alive && !dead ? "kill" : result.cut ? "cut" : result.knockdown ? "knockdown" : strength >= rungStick ? "stick" : "hit";
    if (result.outcome === "kill" && opts.rand) {
      const r = rollFinisher(rules, { ...(opts.finisher || {}), overkillPct }, opts.rand);
      result.finisher = r;
      if (state.bleed) state.bleed = null;
      events.push({ type: "finisher_roll", ...r });
    }
    return result;
  }

  return { evaluateHit, rules };
}
