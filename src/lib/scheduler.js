import {
  ALL_SLOTS,
  DAYS,
  MIN_PER_SHIFT,
  MAX_PER_SHIFT,
  REDUCED_HOURS,
  SHIFTS,
  SHIFT_BY_ID,
  parseSlot,
  PREF,
  PRIORITY_NIGHT_DAYS,
  WEEKEND_DAYS,
} from '../constants/schedule.js';
import { buildPatterns, highPrefCount } from './patterns.js';
import { checkFeasibility } from './feasibility.js';
import { evaluate, signature, makeRng } from './scoring.js';
import { pairKey, makePair } from './pair.js';
import { buildSuggestions } from './suggestions.js';

const NIGHT_SHIFT_ID = SHIFTS.find((s) => s.kind === 'night').id;
const isNightSlot = (id) => parseSlot(id).shift === NIGHT_SHIFT_ID;
const isPriorityNightSlot = (id) =>
  isNightSlot(id) && PRIORITY_NIGHT_DAYS.includes(parseSlot(id).day);
const isWeekendDaySlot = (id) => {
  const { day, shift } = parseSlot(id);
  return WEEKEND_DAYS.includes(day) && shift !== NIGHT_SHIFT_ID;
};

// ---------------------------------------------------------------------------
// Generate the best feasible weekly schedules.
//
// Priority-driven randomised greedy with restarts and local repair. Always
// keeps its best attempts even when they aren't fully valid, so the coordinator
// gets the *least broken* candidate schedules plus a targeted list of people to
// contact for additional availability (see suggestions.js).
// ---------------------------------------------------------------------------

const FILL_UNDER_MIN = 100000; // dominate everything: fill shifts below the minimum
const ROLE_GAP = 5000; // close a missing supervisor / bilingual gap
const NIGHT_GENDER_GAP = 800; // soft: fill missing gender on a priority overnight
const NIGHT_GENDER_GAP_GENERAL = 250; // soft: same for any other overnight
const HIGH_PREF = 50; // honour a responder's high-preference slot
const FILL_BONUS = 10; // mild preference for topping shifts up toward MAX

// Soft-rule placement penalties (negative gain).
const AVOID_PENALTY = 900; // per shift a placement joins an avoidance-paired co-worker
const WEEKEND_DOUBLE_PENALTY = 400; // per pattern that lands two weekend day shifts

// Soft-rule placement bonus: joining a "schedule together" partner. Matching a
// partner on even one shift is what counts, so the first shared shift with a
// given partner earns the big bonus and further overlaps a token amount.
const PREFER_FIRST_BONUS = 1200;
const PREFER_EXTRA_BONUS = 60;

function emptySlots() {
  const s = {};
  for (const id of ALL_SLOTS) {
    s[id] = { members: [], sup: 0, bil: 0, male: 0, female: 0 };
  }
  return s;
}

function patternFits(pattern, slots) {
  return pattern.every((id) => slots[id].members.length < MAX_PER_SHIFT);
}

// avoidByRid / preferByRid: Map of responder id -> Set of responder ids they
// should avoid / be scheduled together with.
function patternGain(responder, pattern, slots, rng, avoidByRid, preferByRid) {
  let gain = 0;
  const conflicts = avoidByRid.get(responder.id);
  const partners = preferByRid.get(responder.id);
  const partnersMet = partners && partners.size ? new Set() : null;
  for (const id of pattern) {
    const s = slots[id];
    const n = s.members.length;
    if (n < MIN_PER_SHIFT) gain += FILL_UNDER_MIN * (MIN_PER_SHIFT - n);
    else gain += FILL_BONUS * (MAX_PER_SHIFT - n);
    if (responder.role === 'supervisor' && s.sup === 0) gain += ROLE_GAP;
    if (responder.bilingual && s.bil === 0) gain += ROLE_GAP;
    if (responder.gender === 'male' && s.male === 0 && isNightSlot(id)) {
      gain += isPriorityNightSlot(id) ? NIGHT_GENDER_GAP : NIGHT_GENDER_GAP_GENERAL;
    }
    if (responder.gender === 'female' && s.female === 0 && isNightSlot(id)) {
      gain += isPriorityNightSlot(id) ? NIGHT_GENDER_GAP : NIGHT_GENDER_GAP_GENERAL;
    }
    // Avoidance penalty for each conflict already placed on this slot.
    if (conflicts && conflicts.size) {
      for (const otherId of s.members) if (conflicts.has(otherId)) gain -= AVOID_PENALTY;
    }
    // "Schedule together" bonus for each partner already placed on this slot.
    if (partnersMet) {
      for (const otherId of s.members) {
        if (!partners.has(otherId)) continue;
        gain += partnersMet.has(otherId) ? PREFER_EXTRA_BONUS : PREFER_FIRST_BONUS;
        partnersMet.add(otherId);
      }
    }
  }
  gain += HIGH_PREF * highPrefCount(responder, pattern);

  // Weekend-double: 12h day pattern where both slots are on Sat/Sun.
  if (pattern.length === 2 && pattern.every(isWeekendDaySlot)) gain -= WEEKEND_DOUBLE_PENALTY;

  gain += rng() * 5; // jitter for diversity between restarts
  return gain;
}

function place(responder, pattern, slots, assignment) {
  assignment[responder.id] = pattern;
  for (const id of pattern) {
    const s = slots[id];
    s.members.push(responder.id);
    if (responder.role === 'supervisor') s.sup += 1;
    if (responder.bilingual) s.bil += 1;
    if (responder.gender === 'male') s.male += 1;
    if (responder.gender === 'female') s.female += 1;
  }
}

function unplace(responder, slots, assignment) {
  const pattern = assignment[responder.id];
  if (!pattern) return;
  for (const id of pattern) {
    const s = slots[id];
    s.members = s.members.filter((x) => x !== responder.id);
    if (responder.role === 'supervisor') s.sup -= 1;
    if (responder.bilingual) s.bil -= 1;
    if (responder.gender === 'male') s.male -= 1;
    if (responder.gender === 'female') s.female -= 1;
  }
  delete assignment[responder.id];
}

function orderResponders(responders, patternMap, rng, preferByRid) {
  const base = [...responders].sort((a, b) => {
    const scarceA = a.role === 'supervisor' || a.bilingual ? 0 : 1;
    const scarceB = b.role === 'supervisor' || b.bilingual ? 0 : 1;
    if (scarceA !== scarceB) return scarceA - scarceB;
    const na = patternMap[a.id].length;
    const nb = patternMap[b.id].length;
    if (na !== nb) return na - nb;
    return rng() - 0.5;
  });

  if (!preferByRid || preferByRid.size === 0) return base;

  // Place "schedule together" partners back to back: the second one is picked
  // while their partner's shifts still have room, which is what makes the
  // pairing preference achievable without weakening coverage.
  const byId = Object.fromEntries(responders.map((r) => [r.id, r]));
  const used = new Set();
  const order = [];
  for (const r of base) {
    if (used.has(r.id)) continue;
    order.push(r);
    used.add(r.id);
    for (const partnerId of preferByRid.get(r.id) || []) {
      const partner = byId[partnerId];
      if (partner && !used.has(partnerId)) {
        order.push(partner);
        used.add(partnerId);
      }
    }
  }
  return order;
}

function underMinSlots(slots) {
  return ALL_SLOTS.filter(
    (id) => slots[id].members.length < MIN_PER_SHIFT || slots[id].sup < 1 || slots[id].bil < 1
  );
}

// Try to fix a near-miss by re-routing one responder to a different pattern.
function repair(responders, byId, patternMap, slots, assignment, rng, avoidByRid) {
  for (let pass = 0; pass < 3; pass++) {
    const bad = underMinSlots(slots);
    if (bad.length === 0) return;
    let improved = false;
    for (const target of bad) {
      for (const r of responders) {
        const current = assignment[r.id];
        if (!current || current.includes(target)) continue;
        const alts = patternMap[r.id].filter((p) => p.includes(target));
        if (alts.length === 0) continue;
        unplace(r, slots, assignment);
        let placed = false;
        for (const alt of alts) {
          if (patternFits(alt, slots)) {
            const leaving = current.filter((id) => !alt.includes(id));
            place(r, alt, slots, assignment);
            const dropped = leaving.some(
              (id) =>
                slots[id].members.length < MIN_PER_SHIFT ||
                slots[id].sup < 1 ||
                slots[id].bil < 1
            );
            if (!dropped) {
              placed = true;
              improved = true;
              break;
            }
            unplace(r, slots, assignment);
          }
        }
        if (!placed) place(r, current, slots, assignment);
        if (placed) break;
      }
    }
    if (!improved) return;
  }
}

// After the greedy pass, unmatched "schedule together" pairs get one targeted
// reroute attempt: move one of the two onto a pattern that overlaps their
// partner, but only when the move (a) keeps every touched shift valid,
// (b) creates no avoidance conflict, and (c) loses no high-preference slot.
function slotStillValid(slots, id) {
  return slots[id].members.length >= MIN_PER_SHIFT && slots[id].sup >= 1 && slots[id].bil >= 1;
}

function tryReroute(r, partnerSlots, patternMap, slots, assignment, avoidByRid) {
  const current = assignment[r.id];
  if (!current) return false;
  const curHigh = highPrefCount(r, current);
  const conflicts = avoidByRid.get(r.id);
  const alts = patternMap[r.id]
    .filter((p) => p.some((id) => partnerSlots.includes(id)))
    .filter((p) => highPrefCount(r, p) >= curHigh)
    .sort(
      (a, b) =>
        b.filter((id) => partnerSlots.includes(id)).length -
          a.filter((id) => partnerSlots.includes(id)).length ||
        highPrefCount(r, b) - highPrefCount(r, a)
    );
  if (alts.length === 0) return false;

  unplace(r, slots, assignment);
  for (const alt of alts) {
    if (!patternFits(alt, slots)) continue;
    if (
      conflicts &&
      conflicts.size &&
      alt.some((id) => slots[id].members.some((m) => conflicts.has(m)))
    ) {
      continue;
    }
    const leaving = current.filter((id) => !alt.includes(id));
    place(r, alt, slots, assignment);
    if (leaving.every((id) => slotStillValid(slots, id))) return true;
    unplace(r, slots, assignment);
  }
  place(r, current, slots, assignment);
  return false;
}

function improvePreferredPairs(byId, patternMap, slots, assignment, preferredPairs, avoidByRid) {
  for (const [a, b] of preferredPairs) {
    const rA = byId[a];
    const rB = byId[b];
    if (!rA || !rB) continue;
    const pa = assignment[a];
    const pb = assignment[b];
    if (!pa || !pb) continue;
    if (pa.some((id) => pb.includes(id))) continue; // already share a shift
    if (tryReroute(rA, pb, patternMap, slots, assignment, avoidByRid)) continue;
    tryReroute(rB, assignment[a], patternMap, slots, assignment, avoidByRid);
  }
}

function attempt(responders, byId, patternMap, seed, avoidByRid, preferByRid, preferredPairs) {
  const rng = makeRng(seed);
  const slots = emptySlots();
  const assignment = {};
  const order = orderResponders(responders, patternMap, rng, preferByRid);

  for (const r of order) {
    const candidates = patternMap[r.id];
    if (!candidates || candidates.length === 0) continue;
    const fitting = candidates.filter((p) => patternFits(p, slots));
    const pool = fitting.length ? fitting : candidates;
    let best = pool[0];
    let bestGain = -Infinity;
    for (const p of pool) {
      const g = patternGain(r, p, slots, rng, avoidByRid, preferByRid);
      if (g > bestGain) {
        bestGain = g;
        best = p;
      }
    }
    place(r, best, slots, assignment);
  }

  repair(responders, byId, patternMap, slots, assignment, rng, avoidByRid);
  if (preferredPairs.length > 0) {
    improvePreferredPairs(byId, patternMap, slots, assignment, preferredPairs, avoidByRid);
  }
  return assignment;
}

// Evaluate-guided polish: for each still-unmatched "schedule together" pair,
// try moving one member onto a pattern that overlaps their partner, then let
// the normal repair pass backfill whatever shift they left. The result is kept
// only when the FULL schedule score improves, so coverage, supervisor and
// bilingual requirements, high preferences and "keep apart" rules can never get
// worse in exchange for a pairing.
function rebuildSlots(assignment, byId) {
  const slots = emptySlots();
  for (const [rid, pattern] of Object.entries(assignment)) {
    const r = byId[rid];
    if (!r) continue;
    for (const id of pattern) {
      const s = slots[id];
      s.members.push(rid);
      if (r.role === 'supervisor') s.sup += 1;
      if (r.bilingual) s.bil += 1;
      if (r.gender === 'male') s.male += 1;
      if (r.gender === 'female') s.female += 1;
    }
  }
  return slots;
}

const MAX_ALTS_PER_MOVE = 24;

const patKey = (p) => [...p].sort().join(',');

// Swap two responders' entire patterns. Every shift keeps exactly the same head
// count, so a swap can never break the minimum-coverage rule — only the role /
// language / gender mix changes, and evaluate() judges that. This is the move
// that lets a "schedule together" pair join up in an already-full week.
function swapCandidates(rid, partnerId, assignment, patternMap) {
  const mine = assignment[rid];
  if (!mine) return [];
  const mineKey = patKey(mine);
  const partnerSlots = assignment[partnerId] || [];
  const myPatternKeys = new Set((patternMap[rid] || []).map(patKey));

  const out = [];
  for (const [otherId, theirs] of Object.entries(assignment)) {
    if (otherId === rid || otherId === partnerId) continue;
    // The swap only helps if `other` currently sits with the partner.
    if (!theirs.some((id) => partnerSlots.includes(id))) continue;
    // Both people must actually be allowed to work the other's pattern.
    if (!myPatternKeys.has(patKey(theirs))) continue;
    if (!(patternMap[otherId] || []).some((p) => patKey(p) === mineKey)) continue;
    out.push({ otherId, theirs });
  }
  return out;
}

function polishPreferredPairs(item, responders, byId, patternMap, avoidancePairs, preferredPairs, avoidByRid) {
  let assignment = { ...item.assignment };
  let ev = item.eval;

  for (let pass = 0; pass < 2; pass++) {
    let improved = false;

    for (const [a, b] of preferredPairs) {
      if (!assignment[a] || !assignment[b]) continue;
      if (assignment[a].some((id) => assignment[b].includes(id))) continue;

      let best = null;

      // 1) Swaps first: they preserve every shift's head count exactly.
      for (const [rid, partnerId] of [
        [a, b],
        [b, a],
      ]) {
        for (const { otherId, theirs } of swapCandidates(rid, partnerId, assignment, patternMap)) {
          const trial = { ...assignment, [rid]: theirs, [otherId]: assignment[rid] };
          const e = evaluate(trial, responders, avoidancePairs, preferredPairs);
          if (e.score > (best ? best.eval.score : ev.score)) best = { assignment: trial, eval: e };
        }
      }

      // 2) Otherwise, move one member across and let repair backfill.
      for (const [rid, partnerId] of [
        [a, b],
        [b, a],
      ]) {
        const r = byId[rid];
        if (!r) continue;
        const partnerSlots = assignment[partnerId];
        const others = responders.filter((x) => x.id !== rid);
        const alts = (patternMap[rid] || [])
          .filter((p) => p.some((id) => partnerSlots.includes(id)))
          .sort(
            (p1, p2) =>
              p2.filter((id) => partnerSlots.includes(id)).length -
                p1.filter((id) => partnerSlots.includes(id)).length ||
              highPrefCount(r, p2) - highPrefCount(r, p1)
          )
          .slice(0, MAX_ALTS_PER_MOVE);

        for (const alt of alts) {
          const trial = { ...assignment };
          const slots = rebuildSlots(trial, byId);
          unplace(r, slots, trial);
          if (!patternFits(alt, slots)) continue;
          place(r, alt, slots, trial);
          // Backfill any shift the move left short — but never by moving `r`
          // back off their partner's shift.
          repair(others, byId, patternMap, slots, trial, makeRng(alt.length + 7), avoidByRid);
          const e = evaluate(trial, responders, avoidancePairs, preferredPairs);
          if (e.score > (best ? best.eval.score : ev.score)) best = { assignment: trial, eval: e };
        }
      }

      if (best) {
        assignment = best.assignment;
        ev = best.eval;
        improved = true;
      }
    }

    if (!improved) break;
  }

  return { assignment, eval: ev };
}

// Public entry point. Always returns up to `want` schedules ranked by score.
// `ok: true` iff the best schedule is fully valid; when it isn't, `suggestions`
// lists people to contact for extra availability.
export function generateSchedules(responders, options = {}) {
  const {
    maxAttempts = 100000, // time is the real limiter; keep this high so long budgets aren't capped
    timeBudgetMs = 4000,
    want = 20,
    avoidancePairs = [],
    preferredPairs = [],
    // Internal: skip the (recursive) reach-out unlock search. Set when this call
    // is itself part of an unlock search, to avoid infinite recursion.
    noUnlockSearch = false,
    // Internal: stop the moment ONE valid schedule is found. Used by the reach-out
    // search, which only needs to know whether a complete schedule is reachable —
    // so a successful check returns fast and only true dead-ends spend the budget.
    stopOnFirstValid = false,
    // How long the reach-out search may run (it re-solves many times). Generous
    // by default — a thorough answer is worth the wait, and it stops early the
    // moment it finds fixes, so only genuinely-hard rosters spend the full budget.
    reachoutBudgetMs = 30000,
    // Per-check budget for a single reach-out re-solve. A successful check returns
    // as soon as it finds one valid schedule; this is really the ceiling for
    // confirming that a particular change DOESN'T work.
    reachoutCheckMs = 1500,
    // Optional progress callback, called with a fraction in [0, 1].
    onProgress = null,
  } = options;

  let lastReport = 0;
  const report = (f) => {
    if (!onProgress) return;
    const now = Date.now();
    if (f < 1 && now - lastReport < 80) return; // throttle
    lastReport = now;
    onProgress(Math.max(0, Math.min(1, f)));
  };
  report(0.02);

  const { errors, warnings, stats } = checkFeasibility(responders, avoidancePairs, preferredPairs);
  // Only block when there is literally nothing to solve for. Everything else
  // becomes diagnostic input for the best-effort partial schedule + suggestions.
  if (responders.length === 0) {
    return { ok: false, errors, warnings, stats, schedules: [] };
  }

  const byId = Object.fromEntries(responders.map((r) => [r.id, r]));
  const patternMap = {};
  for (const r of responders) patternMap[r.id] = buildPatterns(r).patterns;

  // Pair lookups for quick checks during placement.
  const buildPairMap = (pairs) => {
    const map = new Map();
    for (const [a, b] of pairs) {
      if (!byId[a] || !byId[b]) continue;
      if (!map.has(a)) map.set(a, new Set());
      if (!map.has(b)) map.set(b, new Set());
      map.get(a).add(b);
      map.get(b).add(a);
    }
    return map;
  };
  const avoidByRid = buildPairMap(avoidancePairs);
  const preferByRid = buildPairMap(preferredPairs);

  const found = new Map(); // signature -> { assignment, eval }
  const start = Date.now();
  let attempts = 0;

  while (attempts < maxAttempts && Date.now() - start < timeBudgetMs) {
    attempts += 1;
    if (attempts % 32 === 0) {
      // Reserve the back half of the bar for the reach-out search (if any).
      report(0.03 + 0.45 * Math.min((Date.now() - start) / timeBudgetMs, 1));
    }
    const assignment = attempt(
      responders,
      byId,
      patternMap,
      attempts * 2654435761,
      avoidByRid,
      preferByRid,
      preferredPairs
    );
    if (!assignment || Object.keys(assignment).length === 0) continue;
    const sig = signature(assignment);
    if (found.has(sig)) continue;
    const ev = evaluate(assignment, responders, avoidancePairs, preferredPairs);
    found.set(sig, { assignment, eval: ev });
    // Reach-out mode: one valid schedule is all we needed to prove reachability.
    if (stopOnFirstValid && ev.valid) break;
    // Once we have a healthy pool of distinct *valid* solutions (comfortably
    // more than we display), we can stop early.
    if (
      [...found.values()].filter((v) => v.eval.valid).length >= want + 10 &&
      Date.now() - start > timeBudgetMs / 2
    ) {
      break;
    }
  }

  if (found.size === 0) {
    return {
      ok: false,
      errors: [
        `Could not build any schedule after ${attempts} attempts. Check that responders have enough usable slots given the rest-period rule (no 14:00-20:00 immediately followed by 08:00-14:00).`,
      ],
      warnings,
      stats: { ...stats, attempts },
      schedules: [],
    };
  }

  let all = [...found.values()].sort((a, b) => b.eval.score - a.eval.score);

  // Polish the strongest candidates so "schedule together" pairs get matched
  // whenever a same-or-better schedule exists, then de-duplicate and re-rank.
  if (preferredPairs.length > 0) {
    const POLISH_TOP = 40;
    const polished = new Map();
    all.slice(0, POLISH_TOP).forEach((item) => {
      const out = polishPreferredPairs(
        item,
        responders,
        byId,
        patternMap,
        avoidancePairs,
        preferredPairs,
        avoidByRid
      );
      const sig = signature(out.assignment);
      if (!polished.has(sig) || polished.get(sig).eval.score < out.eval.score) {
        polished.set(sig, out);
      }
    });
    for (const item of all.slice(POLISH_TOP)) {
      const sig = signature(item.assignment);
      if (!polished.has(sig)) polished.set(sig, item);
    }
    all = [...polished.values()].sort((a, b) => b.eval.score - a.eval.score);
  }

  const valids = all.filter((v) => v.eval.valid);
  const partials = all.filter((v) => !v.eval.valid);
  // Show as many schedules as possible up to `want`: every valid one first,
  // then top up with the least-broken partial schedules.
  const chosen = [...valids, ...partials].slice(0, want);

  const schedules = chosen.map(({ assignment, eval: ev }, i) => {
    const schedule = {
      rank: i + 1,
      assignment,
      slots: buildSlotView(assignment, byId),
      metrics: ev,
      valid: ev.valid,
    };
    // Every partial schedule carries its OWN "who to contact for availability"
    // list, ranked by impact — reaching out to different people helps different
    // near-miss schedules.
    if (!ev.valid) {
      schedule.suggestions = buildSuggestions(schedule, responders, avoidancePairs, patternMap);
    }
    return schedule;
  });

  const ok = schedules.length > 0 && schedules[0].valid;
  const firstPartial = schedules.find((s) => !s.valid);
  const result = {
    ok,
    schedules,
    warnings,
    stats: {
      ...stats,
      attempts,
      distinctFound: found.size,
      validFound: valids.length,
      partialShown: schedules.filter((s) => !s.valid).length,
    },
  };

  // Surface a top-level suggestions object (used by the PDF contact page and as
  // a convenient default) whenever any shown schedule is partial.
  if (firstPartial) result.suggestions = firstPartial.suggestions;

  if (!ok) {
    result.errors = [
      `No complete schedule could be assembled — the ${schedules.length === 1 ? 'schedule' : 'schedules'} below ${schedules.length === 1 ? 'is' : 'are'} the closest possible. See "make a complete schedule possible" below.`,
      ...errors,
    ];
    // Reachability-based reach-out: find the availability change(s) that would
    // actually make a complete schedule possible, and the schedule they unlock.
    if (!noUnlockSearch) {
      report(0.5);
      result.reachout = findUnlocks(
        schedules[0],
        responders,
        avoidancePairs,
        preferredPairs,
        (f) => report(0.5 + 0.49 * f),
        { budgetMs: reachoutBudgetMs, checkBudgetMs: reachoutCheckMs }
      );
    }
  } else if (errors.length > 0) {
    // Valid schedules found despite up-front worries — pass warnings through
    // (checkFeasibility's errors were conservative), but keep them visible.
    result.warnings = [...warnings, ...errors];
  }

  report(1);
  return result;
}

// Turn a responder->pattern map into a slot->responders view for rendering.
function buildSlotView(assignment, byId) {
  const slots = {};
  for (const id of ALL_SLOTS) slots[id] = [];
  for (const [rid, pattern] of Object.entries(assignment)) {
    const r = byId[rid];
    if (!r) continue;
    for (const id of pattern) slots[id].push(r);
  }
  for (const id of ALL_SLOTS) {
    slots[id].sort((a, b) => {
      const s = (b.role === 'supervisor') - (a.role === 'supervisor');
      if (s) return s;
      const bi = (b.bilingual ? 1 : 0) - (a.bilingual ? 1 : 0);
      if (bi) return bi;
      return a.name.localeCompare(b.name);
    });
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Reach-out: what availability change makes a COMPLETE schedule possible?
//
// Instead of a vague "these people could help" list, this answers the concrete
// question the coordinator actually has: "who do I call, and what shift do I ask
// them to open, so that a fully valid schedule then exists?"
//
// Two-stage answer:
//   1. Capacity check (instant, exact necessary condition). If the roster simply
//      doesn't have enough people / supervisors / bilinguals for the week's
//      minimum coverage, NO availability change can help — so we say exactly how
//      many more you need, rather than grinding through a doomed search.
//   2. Reachability search (thorough). When the roster is big enough in
//      principle, we actually add availability, re-solve, and only report a fix
//      when the re-solve produces a complete schedule that USES it. The search is
//      exhaustive within a time budget — it never abandons a shift after a couple
//      of tries — and it stops early the moment it finds fixes.
// ---------------------------------------------------------------------------

const shiftLabelFor = (id) => {
  const { day, shift } = parseSlot(id);
  return `${day} ${SHIFT_BY_ID[shift].label}`;
};

const isDaySlotId = (id) => SHIFT_BY_ID[parseSlot(id).shift].kind === 'day';

// The unfilled slots of a partial schedule, each tagged with what it's missing.
function gapSlotsWithNeeds(schedule) {
  const map = new Map(); // slot -> { sup, bil, people }
  const issues = schedule.metrics.issues;
  for (const g of issues.underMin) {
    if (!map.has(g.slot)) map.set(g.slot, { sup: false, bil: false, people: 0 });
    map.get(g.slot).people = g.need - g.have;
  }
  for (const id of issues.missingSup) {
    if (!map.has(id)) map.set(id, { sup: false, bil: false, people: 0 });
    map.get(id).sup = true;
  }
  for (const id of issues.missingBil) {
    if (!map.has(id)) map.set(id, { sup: false, bil: false, people: 0 });
    map.get(id).bil = true;
  }
  return map;
}

// People who could fill `slot` by opening availability and who hold the fixed
// attribute the gap requires. Currently unavailable for the slot (that's the
// only thing we can ask them to change).
function candidatesForGap(responders, slot, need) {
  let pool = responders.filter((r) => r.prefs[slot] === PREF.UNAVAIL);
  if (need.sup && need.bil) pool = pool.filter((r) => r.role === 'supervisor' && r.bilingual);
  else if (need.sup) pool = pool.filter((r) => r.role === 'supervisor');
  else if (need.bil) pool = pool.filter((r) => r.bilingual);
  return pool;
}

// Anyone currently unavailable for the slot — used to fill a plain head-count
// gap (no role requirement) with the closest-fitting person.
function candidatesAny(responders, slot) {
  return responders.filter((r) => r.prefs[slot] === PREF.UNAVAIL);
}

const briefPerson = (p) => ({ id: p.id, name: p.name, role: p.role, bilingual: p.bilingual });

const slotHoursOf = (id) => SHIFT_BY_ID[parseSlot(id).shift].hours;

// Copy the roster with availability opened up on the given shifts. `opens` is
// [{ id, slot }, ...]. The opened shift is marked NON-NEGOTIABLE, which forces
// the re-solve to actually place that person there — so the check reliably asks
// "can the rest of the week complete around this person taking this shift?"
// (rather than hoping the greedy heuristic happens to use the opening).
function withOpened(responders, opens) {
  const bySlot = new Map();
  for (const { id, slot } of opens) {
    if (!bySlot.has(id)) bySlot.set(id, new Set());
    bySlot.get(id).add(slot);
  }
  return responders.map((r) => {
    const slots = bySlot.get(r.id);
    if (!slots) return r;
    const prefs = { ...r.prefs };
    for (const s of slots) prefs[s] = PREF.NONNEG;
    return { ...r, prefs };
  });
}

const askOf = (r, slot) => ({
  person: briefPerson(r),
  slot,
  slotLabel: shiftLabelFor(slot),
  addedHours: slotHoursOf(slot),
});

// Slots one calendar day either side of a slot (any shift) — used to prefer the
// people for whom opening a shift is the smallest stretch.
function proximityScore(responder, slot) {
  const { day } = parseSlot(slot);
  return ALL_SLOTS.filter((id) => {
    if (id === slot) return false;
    const p = responder.prefs[id];
    if (p !== PREF.AVAIL && p !== PREF.HIGH) return false;
    const od = parseSlot(id).day;
    return od === day; // same day, another shift — the closest kind of stretch
  }).length;
}

// Rank a candidate list so the smallest asks (people already available nearby)
// come first, with a stable name tie-break.
function rankCandidates(list, slot) {
  return list
    .map((r) => ({ r, prox: proximityScore(r, slot) }))
    .sort((a, b) => b.prox - a.prox || a.r.name.localeCompare(b.r.name))
    .map((x) => x.r);
}

// Plain-language description of what a shift is missing.
function needLabelFor(need) {
  if (need.sup && need.bil) return 'a bilingual supervisor';
  const parts = [];
  if (need.sup) parts.push('a supervisor');
  if (need.bil) parts.push('a bilingual responder');
  if (need.people > 0) parts.push(`${need.people} more responder${need.people === 1 ? '' : 's'}`);
  return parts.join(' and ') || 'more coverage';
}

// ---------------------------------------------------------------------------
// Capacity floor — exact necessary conditions on head-count and roles.
//
// Each 12h responder covers either two day shifts OR one overnight; each 6h
// responder covers one day shift. Every shift needs MIN_PER_SHIFT people, with
// at least one supervisor and one bilingual. These give hard lower bounds on how
// many people (and how many supervisors / bilinguals) the week needs — bounds no
// amount of availability-shuffling can beat. If the roster is under one of them,
// a complete schedule is impossible without bringing someone new in, full stop.
// ---------------------------------------------------------------------------
function capacityFloor(responders) {
  const dayShiftCount = SHIFTS.filter((s) => s.kind === 'day').length; // day blocks per day
  const nightShiftCount = SHIFTS.filter((s) => s.kind === 'night').length;
  const daySlots = DAYS.length * dayShiftCount;
  const nightSlots = DAYS.length * nightShiftCount;
  const dayDemand = daySlots * MIN_PER_SHIFT;
  const nightDemand = nightSlots * MIN_PER_SHIFT;

  const n6 = responders.filter((r) => r.hours === REDUCED_HOURS).length;
  const n12 = responders.length - n6;
  const sups = responders.filter((r) => r.role === 'supervisor').length;
  const bils = responders.filter((r) => r.bilingual).length;

  // Bodies: need at least `nightDemand` twelve-hour people for the overnights,
  // and enough remaining day capacity (2 per 12h, 1 per 6h) for the day demand.
  // Minimising night workers at nightDemand, day supply is 2*n12 + n6 and must
  // reach dayDemand + 2*nightDemand. Each extra 12h person adds 2 to that supply.
  const needForNights = Math.max(0, nightDemand - n12);
  const needForDays = Math.ceil((dayDemand + 2 * nightDemand - (2 * n12 + n6)) / 2);
  const needBodies = Math.max(0, needForNights, needForDays);

  // Roles: every shift needs >= 1. A supervisor covers two day slots or one
  // night, so the floor is ceil(daySlots/2) + nightSlots.
  const roleFloor = Math.ceil(daySlots / 2) + nightSlots;
  const needSups = Math.max(0, roleFloor - sups);
  const needBils = Math.max(0, roleFloor - bils);

  const reasons = [];
  if (needBodies > 0)
    reasons.push(`${needBodies} more responder${needBodies === 1 ? '' : 's'} (basic head-count)`);
  if (needSups > 0)
    reasons.push(`${needSups} more supervisor${needSups === 1 ? '' : 's'}`);
  if (needBils > 0)
    reasons.push(`${needBils} more bilingual responder${needBils === 1 ? '' : 's'}`);

  return {
    feasible: needBodies === 0 && needSups === 0 && needBils === 0,
    needBodies,
    needSups,
    needBils,
    reasons,
  };
}

// Expand the gaps into a flat list of "openings": one per missing person-slot,
// each with the ranked candidates who could fill it. A shift short by two bodies
// yields two openings; a shift that only lacks a supervisor yields one opening
// whose candidates are supervisors. The first opening on a shift carries any
// role requirement (so it draws typed candidates); extra openings on the same
// shift are plain head-count and draw from anyone unavailable for it.
function buildOpenings(responders, rankedByGap) {
  const openings = [];
  for (const { slot, need } of rankedByGap) {
    const roleNeeded = need.sup || need.bil;
    const count = Math.max(need.people, roleNeeded ? 1 : 0);
    const typed = rankCandidates(candidatesForGap(responders, slot, need), slot);
    const any = rankCandidates(candidatesAny(responders, slot), slot);
    for (let i = 0; i < count; i++) {
      const cands = i === 0 && roleNeeded ? typed : any;
      openings.push({ slot, cands });
    }
  }
  return openings;
}

// Search for a minimal SET of asks (one distinct person per opening) that
// together makes a complete schedule possible. Tries the cheapest combination
// first, then varies each opening across its best candidates, then samples more
// broadly — all bounded by the shared time budget. Returns the first working set.
function searchMultiFix(openings, solveWith, timeLeft, tick) {
  const m = openings.length;
  const sizes = openings.map((o) => o.cands.length);
  if (sizes.some((s) => s === 0)) return null;

  const tried = new Set();
  const distinct = (vec) => {
    const ids = vec.map((idx, i) => openings[i].cands[idx].id);
    return new Set(ids).size === ids.length;
  };
  const build = (hit) => ({
    asks: hit.vec.map((idx, i) => askOf(openings[i].cands[idx], openings[i].slot)),
    schedule: hit.valid,
  });
  const attempt = (vec) => {
    const key = vec.join(',');
    if (tried.has(key)) return null;
    tried.add(key);
    if (!distinct(vec)) return null;
    if (timeLeft() < 500) return null;
    tick();
    const opens = vec.map((idx, i) => ({ id: openings[i].cands[idx].id, slot: openings[i].slot }));
    const valid = solveWith(opens);
    return valid ? { vec, valid } : null;
  };

  // 1) Cheapest distinct combination (top candidate per opening, bumping on
  //    collisions so the same person is never asked for two openings).
  const top = [];
  const used = new Set();
  for (let i = 0; i < m; i++) {
    let idx = 0;
    while (idx < sizes[i] && used.has(openings[i].cands[idx].id)) idx += 1;
    if (idx >= sizes[i]) idx = 0;
    top.push(idx);
    used.add(openings[i].cands[idx]?.id);
  }
  let hit = attempt(top);
  if (hit) return build(hit);

  // 2) Coordinate search: vary one opening at a time across its best candidates.
  const SPREAD = 8;
  for (let i = 0; i < m; i++) {
    for (let idx = 0; idx < Math.min(sizes[i], SPREAD); idx++) {
      if (timeLeft() < 500) return null;
      const vec = [...top];
      vec[i] = idx;
      hit = attempt(vec);
      if (hit) return build(hit);
    }
  }

  // 3) Broader randomised sampling of distinct combinations until time runs out
  //    or the (bounded) combination space is effectively exhausted — whichever
  //    comes first. `attempt` skips duplicates cheaply, so we stop once fresh
  //    combinations dry up rather than busy-spinning to the deadline.
  const rng = makeRng(0x5eed ^ m);
  const space = openings.reduce((p, o, i) => p * Math.min(sizes[i], SPREAD), 1);
  let staleStreak = 0;
  while (timeLeft() > 800 && staleStreak < 400 && tried.size < space) {
    const vec = openings.map((_, i) => Math.floor(rng() * Math.min(sizes[i], SPREAD)));
    const before = tried.size;
    hit = attempt(vec);
    if (hit) return build(hit);
    staleStreak = tried.size > before ? 0 : staleStreak + 1;
  }
  return null;
}

// Reachability search — the honest answer to "who do I call so a complete
// schedule becomes possible?" Returns:
//   capacity:   the hard head-count / role floor analysis (see capacityFloor).
//   singleFixes:[{ slot, slotLabel, needLabel, people:[…], schedule }] — shifts a
//               single phone call completes, with everyone who could and a sample
//               resulting schedule.
//   multiFix:   { asks:[{ person, slot, slotLabel, addedHours }], schedule } | null
//               — a minimal set of changes that together complete the week.
//   unplaced:   people who aren't in the schedule at all.
//   searched:   did we actually run the re-solve search? (false when capacity
//               already rules a complete schedule out).
//   exhausted:  searched the whole roster/budget and still found nothing.
export function findUnlocks(bestPartial, responders, avoidancePairs, preferredPairs, onProgress, opts = {}) {
  const budgetMs = opts.budgetMs ?? 30000;
  const checkBudgetMs = opts.checkBudgetMs ?? 1500;
  const start = Date.now();
  const deadline = start + budgetMs;
  const timeLeft = () => deadline - Date.now();
  const report = (f) => onProgress && onProgress(Math.max(0, Math.min(0.99, f)));
  const tickProgress = () => report((Date.now() - start) / budgetMs);

  const gaps = gapSlotsWithNeeds(bestPartial);
  const bodyDeficit = [...gaps.values()].reduce((s, n) => s + n.people, 0);
  const capacity = capacityFloor(responders);

  const assignedIds = new Set(
    Object.keys(bestPartial.assignment).filter((id) => bestPartial.assignment[id].length > 0)
  );
  const unplaced = responders.filter((r) => !assignedIds.has(r.id)).map(briefPerson);

  const result = {
    gapCount: gaps.size,
    bodyDeficit,
    capacity,
    unplaced,
    singleFixes: [],
    multiFix: null,
    searched: false,
    exhausted: false,
  };

  // Under a hard capacity/role floor → no availability change can ever complete
  // the week. Say exactly what's missing instead of burning the budget.
  if (!capacity.feasible) {
    report(1);
    return result;
  }

  // Coverage is complete but someone can't be placed (< 6h available on any open
  // slot). Nothing to "unlock" coverage-wise — the unplaced note carries this.
  if (gaps.size === 0) {
    report(1);
    return result;
  }

  // Rank gaps hardest-first; keep the candidate lists for each.
  const rankedByGap = [...gaps.entries()]
    .map(([slot, need]) => ({
      slot,
      need,
      cands: rankCandidates(candidatesForGap(responders, slot, need), slot),
    }))
    .sort((a, b) => {
      const sev = (g) => (g.need.sup ? 100 : 0) + (g.need.bil ? 50 : 0) + g.need.people * 10;
      return sev(b) - sev(a);
    });

  // A gap literally nobody could ever fill (no one with the right fixed
  // attributes is free to open it) is unreachable — you need someone new.
  if (rankedByGap.some((g) => g.cands.length === 0)) {
    result.searched = true;
    result.exhausted = true;
    report(1);
    return result;
  }

  const solveOpts = {
    want: 1,
    stopOnFirstValid: true,
    avoidancePairs,
    preferredPairs,
    noUnlockSearch: true,
  };
  const solveWith = (opens) => {
    const t = Math.min(checkBudgetMs, timeLeft());
    if (t < 300) return null;
    const res = generateSchedules(withOpened(responders, opens), { ...solveOpts, timeBudgetMs: t });
    const valid = res.schedules.find((s) => s.valid);
    if (valid && opens.every(({ id, slot }) => (valid.slots[slot] || []).some((p) => p.id === id))) {
      return valid;
    }
    return null;
  };

  result.searched = true;

  // Total openings that must be filled. A single phone call can only complete the
  // week when that number is one (one body, one shift).
  const openings = buildOpenings(responders, rankedByGap);
  const totalOpenings = openings.length;

  // ---- Pass 1: single-call fixes ----
  // Only meaningful when the week is exactly one opening short. We try EVERY
  // candidate for that shift — no early abandonment — and list everyone who works.
  if (totalOpenings === 1) {
    const { slot, need } = rankedByGap[0];
    const cands = openings[0].cands;
    const people = [];
    let schedule = null;
    for (const r of cands) {
      if (timeLeft() < 400) break;
      tickProgress();
      const valid = solveWith([{ id: r.id, slot }]);
      if (valid) {
        people.push(briefPerson(r));
        if (!schedule) schedule = valid;
      }
    }
    if (people.length) {
      result.singleFixes = [
        { slot, slotLabel: shiftLabelFor(slot), needLabel: needLabelFor(need), people, schedule },
      ];
    }
  }

  // ---- Pass 2: minimal multi-call fix ----
  // Fill every opening at once, searching candidate combinations until a set
  // makes a complete schedule possible. Bounded by the shared time budget.
  if (result.singleFixes.length === 0 && totalOpenings >= 1 && totalOpenings <= 6) {
    result.multiFix = searchMultiFix(openings, solveWith, timeLeft, tickProgress);
  }

  result.exhausted = result.singleFixes.length === 0 && !result.multiFix;
  report(1);
  return result;
}
