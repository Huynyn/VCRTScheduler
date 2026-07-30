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
import { solveExact } from './exactSolver.js';

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

// Keep-apart is a HARD rule: joining a co-worker you must be kept apart from is
// penalised near the coverage tier so the greedy strongly avoids it, but still
// below FILL_UNDER_MIN so filling an empty shift always wins (a genuinely
// impossible conflict then surfaces as an invalid schedule + a message, rather
// than silently leaving shifts unstaffed). `attempt` also filters to
// conflict-free patterns first, so this only breaks ties among fallbacks.
const AVOID_PENALTY = 50000; // per shift a placement joins a keep-apart co-worker
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

// True when placing `responder` on `pattern` would put them on a shift that
// already holds someone they must be kept apart from (hard keep-apart rule).
function patternCreatesConflict(responder, pattern, slots, avoidByRid) {
  const conflicts = avoidByRid.get(responder.id);
  if (!conflicts || conflicts.size === 0) return false;
  for (const id of pattern) {
    for (const otherId of slots[id].members) {
      if (conflicts.has(otherId)) return true;
    }
  }
  return false;
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
          // Never repair a coverage gap by creating a keep-apart conflict.
          if (patternFits(alt, slots) && !patternCreatesConflict(r, alt, slots, avoidByRid)) {
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
    const fitPool = fitting.length ? fitting : candidates;
    // Hard keep-apart: only consider patterns that don't seat this person with a
    // co-worker they must be kept apart from. Fall back to the full pool only
    // when every fitting pattern would create a conflict (best-effort - that
    // schedule then reads as invalid and the coordinator gets a message).
    const conflictFree = fitPool.filter(
      (p) => !patternCreatesConflict(r, p, slots, avoidByRid)
    );
    const pool = conflictFree.length ? conflictFree : fitPool;
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
// count, so a swap can never break the minimum-coverage rule - only the role /
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
          // Backfill any shift the move left short - but never by moving `r`
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
    // search, which only needs to know whether a complete schedule is reachable -
    // so a successful check returns fast and only true dead-ends spend the budget.
    stopOnFirstValid = false,
    // How long the reach-out search may run (it re-solves many times). Deliberately
    // large: completeness matters more than latency here, so we let the exhaustive
    // every-shift, every-person search run for minutes if it needs to. It still
    // stops the moment the search space is exhausted, so easy rosters finish fast.
    reachoutBudgetMs = 300000,
    // Per-check budget for a single reach-out re-solve. A successful check returns
    // as soon as it finds one valid schedule; this is the ceiling for a check that
    // DOESN'T pan out. Comfortably above the time a genuine fix takes to surface,
    // so no real fix is missed for want of a moment more search.
    reachoutCheckMs = 3000,
    // Completeness backstop: after the greedy pass, if NO fully valid schedule was
    // found, ask the exact solver whether one exists and adopt it if so. The
    // greedy is incomplete on tight rosters, so without this the app can report
    // "no complete schedule" (and drop real reach-out fixes) when a valid schedule
    // is actually reachable. Kept optional so callers can disable it.
    exactFallback = true,
    // Time budget for that exact backstop. On a top-level solve we want a correct
    // verdict even on a hard, tight roster (proving/finding one can take many
    // seconds), so this is generous; the fast reachability checks keep it small.
    exactBudgetMs = stopOnFirstValid ? 2000 : 30000,
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

  // Completeness backstop. The greedy above is fast but INCOMPLETE: on tight
  // rosters it can fail to construct a valid schedule even when one exists (it
  // never lands the exact per-shift partition a zero-slack week demands). If it
  // produced no valid schedule, ask the exact solver whether one is reachable and
  // adopt it - so the app never claims "no complete schedule" when there is one,
  // and (crucially) the reach-out reachability checks below become sound.
  if (exactFallback && !all.some((v) => v.eval.valid)) {
    report(0.49);
    const ex = solveExact(responders, { avoidancePairs, budgetMs: exactBudgetMs });
    if (ex.status === 'sat') {
      const ev = evaluate(ex.assignment, responders, avoidancePairs, preferredPairs);
      if (ev.valid) {
        const sig = signature(ex.assignment);
        if (!found.has(sig)) found.set(sig, { assignment: ex.assignment, eval: ev });
        all = [...found.values()].sort((a, b) => b.eval.score - a.eval.score);
      }
    }
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
    // list, ranked by impact - reaching out to different people helps different
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
      `No complete schedule could be assembled - the ${schedules.length === 1 ? 'schedule' : 'schedules'} below ${schedules.length === 1 ? 'is' : 'are'} the closest possible. See "make a complete schedule possible" below.`,
      ...errors,
    ];

    // Keep-apart is a hard rule, so the FIRST thing to check when no complete
    // schedule exists is whether the keep-apart rules themselves are the reason:
    // if relaxing them lets a fully valid schedule appear, the honest fix is a
    // decision about those pairs, not a scramble for extra availability.
    let apartIsBlocker = false;
    if (!noUnlockSearch && avoidancePairs.length > 0) {
      report(0.5);
      const apart = probeApartBlock(responders, avoidancePairs, preferredPairs, {
        budgetMs: Math.min(reachoutBudgetMs, 12000),
      });
      if (apart) {
        result.apartBlock = apart;
        apartIsBlocker = true;
      }
    }

    // Reachability-based reach-out: find the availability change(s) that would
    // actually make a complete schedule possible, and the schedule they unlock.
    // Skipped when keep-apart is the sole blocker - there, the fix is to relax a
    // keep-apart pair, not to open up availability.
    if (!noUnlockSearch && !apartIsBlocker) {
      report(0.5);
      result.reachout = findUnlocks(
        schedules[0],
        responders,
        avoidancePairs,
        preferredPairs,
        (f) => report(0.5 + 0.49 * f),
        {
          budgetMs: reachoutBudgetMs,
          checkBudgetMs: reachoutCheckMs,
          // All the near-miss schedules, so the search covers every shift that is
          // short in ANY of them - not just the single best one.
          partials: schedules.filter((s) => !s.valid),
        }
      );
    }
  } else if (errors.length > 0) {
    // Valid schedules found despite up-front worries - pass warnings through
    // (checkFeasibility's errors were conservative), but keep them visible.
    result.warnings = [...warnings, ...errors];
  }

  report(1);
  return result;
}

// Wrap a bare responderId->pattern assignment (e.g. from the exact solver) in the
// same schedule shape the greedy path produces, so the UI and the reach-out
// placement check can consume it uniformly.
function scheduleFromAssignment(assignment, byId, responders, avoidancePairs, preferredPairs) {
  const metrics = evaluate(assignment, responders, avoidancePairs, preferredPairs);
  return {
    rank: 1,
    assignment,
    slots: buildSlotView(assignment, byId),
    metrics,
    valid: metrics.valid,
  };
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
// Keep-apart diagnosis - is the "avoid together" rule itself what's blocking a
// complete schedule?
//
// Keep-apart is a hard rule, so the solver will never quietly seat two people
// who must stay apart. But that means an over-strict set of keep-apart rules can
// make the whole week unsolvable. When that happens the coordinator deserves a
// straight answer: "a valid schedule IS possible, but only if you relax keeping
// X & Y apart - here's the schedule that unlocks." This re-solves with the rules
// relaxed to find out, and pins down exactly which pair(s) are at fault.
//
// Returns { pairs: [{ a, b, names }], schedule } when keep-apart is the blocker,
// or null when something else (coverage, roster size) is the real problem.
// ---------------------------------------------------------------------------
function probeApartBlock(responders, avoidancePairs, preferredPairs, opts = {}) {
  const budgetMs = opts.budgetMs ?? 12000;
  const perSolveMs = Math.max(1500, Math.floor(budgetMs / (avoidancePairs.length + 2)));
  const byId = Object.fromEntries(responders.map((r) => [r.id, r]));
  const nameOf = (id) => byId[id]?.name || 'Unknown';

  const solve = (pairs) =>
    generateSchedules(responders, {
      avoidancePairs: pairs,
      preferredPairs,
      want: 1,
      stopOnFirstValid: true,
      noUnlockSearch: true, // never re-enter this probe or the reach-out search
      timeBudgetMs: perSolveMs,
    });

  // 1) With NO keep-apart rules, is a complete schedule possible at all? If not,
  //    keep-apart isn't the blocker (coverage / roster size is) - bail out and
  //    let the normal reach-out search handle it.
  const relaxedAll = solve([]);
  if (!relaxedAll.ok) return null;

  // 2) Which individual pairs, enforced alone, break the week? Those are the
  //    ones to reconsider first.
  const culpable = [];
  for (const pair of avoidancePairs) {
    if (!solve([pair]).ok) culpable.push(pair);
  }

  // If no single pair is individually fatal but the full set is (they interact),
  // report the whole set - relaxing just one may not be enough.
  const source = culpable.length ? culpable : avoidancePairs;
  const pairs = source.map(([a, b]) => ({ a, b, names: `${nameOf(a)} & ${nameOf(b)}` }));

  // The complete schedule that becomes possible once the fatal pair(s) are
  // relaxed: keep every OTHER keep-apart rule, drop only the culpable ones.
  const culpableKeys = new Set(culpable.map((p) => pairKey(makePair(p[0], p[1]))));
  const kept = avoidancePairs.filter((p) => !culpableKeys.has(pairKey(makePair(p[0], p[1]))));
  let schedule = null;
  if (culpable.length && kept.length) {
    schedule = solve(kept).schedules.find((s) => s.valid) || null;
  }
  if (!schedule) schedule = relaxedAll.schedules.find((s) => s.valid) || null;

  return { pairs, schedule };
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
//      minimum coverage, NO availability change can help - so we say exactly how
//      many more you need, rather than grinding through a doomed search.
//   2. Reachability search (thorough). When the roster is big enough in
//      principle, we actually add availability, re-solve, and only report a fix
//      when the re-solve produces a complete schedule that USES it. The search is
//      exhaustive within a time budget - it never abandons a shift after a couple
//      of tries - and it stops early the moment it finds fixes.
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

// Union the short-shift needs across several near-miss schedules. Different
// partial schedules leave different shifts short, so a fix that opens shift G
// only surfaces if G appears as a gap in SOME candidate - searching just the
// single best partial's gaps would miss it. Merges by taking the largest body
// shortfall and OR-ing the role needs per slot.
function unionGaps(schedules) {
  const map = new Map();
  for (const s of schedules) {
    if (!s) continue;
    for (const [slot, need] of gapSlotsWithNeeds(s).entries()) {
      if (!map.has(slot)) map.set(slot, { sup: false, bil: false, people: 0 });
      const cur = map.get(slot);
      cur.sup = cur.sup || need.sup;
      cur.bil = cur.bil || need.bil;
      cur.people = Math.max(cur.people, need.people);
    }
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

// Anyone currently unavailable for the slot - used to fill a plain head-count
// gap (no role requirement) with the closest-fitting person.
function candidatesAny(responders, slot) {
  return responders.filter((r) => r.prefs[slot] === PREF.UNAVAIL);
}

// EVERYONE who could open `slot`, ordered so the people who most plausibly
// resolve this particular gap come first (role-holders for a role gap), but with
// NOBODY excluded. This matters: opening a shift for a responder who ISN'T the
// missing role can still complete the week - a plain body freeing up the tight
// packing elsewhere is enough - so the role of the person is NOT a safe filter.
// The only reliable test of "does opening this shift for this person complete the
// week?" is to actually try it (solveWith does, exactly), one by one, for all of
// them. `spareOf` optionally biases the order toward people with unused hours.
function candidatesForSlotExhaustive(responders, slot, need, spareOf = null) {
  const preferred = rankCandidates(candidatesForGap(responders, slot, need), slot, spareOf);
  const preferredIds = new Set(preferred.map((r) => r.id));
  const rest = rankCandidates(
    candidatesAny(responders, slot).filter((r) => !preferredIds.has(r.id)),
    slot,
    spareOf
  );
  return [...preferred, ...rest];
}

const briefPerson = (p) => ({ id: p.id, name: p.name, role: p.role, bilingual: p.bilingual });

const slotHoursOf = (id) => SHIFT_BY_ID[parseSlot(id).shift].hours;

// Copy the roster with availability opened up on the given shifts. `opens` is
// [{ id, slot }, ...]. The opened shift is marked NON-NEGOTIABLE, which forces
// the re-solve to actually place that person there - so the check reliably asks
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

// Slots one calendar day either side of a slot (any shift) - used to prefer the
// people for whom opening a shift is the smallest stretch.
function proximityScore(responder, slot) {
  const { day } = parseSlot(slot);
  return ALL_SLOTS.filter((id) => {
    if (id === slot) return false;
    const p = responder.prefs[id];
    if (p !== PREF.AVAIL && p !== PREF.HIGH) return false;
    const od = parseSlot(id).day;
    return od === day; // same day, another shift - the closest kind of stretch
  }).length;
}

// Rank a candidate list so the people who can ACTUALLY take an opened shift come
// first. `spareOf(r)` is the responder's unused weekly hours in the current
// partial schedule: someone already booked to their full 12h can't take another
// shift without dropping one (which usually just moves the gap), so people with
// spare hours - above all the unplaced, who have a whole week free - are the real
// fixers and must lead the list. Proximity (opening a nearby shift is the
// smallest stretch) breaks ties, then name for stability. `spareOf` is optional;
// without it this falls back to proximity-only ordering.
function rankCandidates(list, slot, spareOf = null) {
  return list
    .map((r) => ({ r, spare: spareOf ? spareOf(r) : 0, prox: proximityScore(r, slot) }))
    .sort(
      (a, b) => b.spare - a.spare || b.prox - a.prox || a.r.name.localeCompare(b.r.name)
    )
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
// Capacity floor - exact necessary conditions on head-count and roles.
//
// Each 12h responder covers either two day shifts OR one overnight; each 6h
// responder covers one day shift. Every shift needs MIN_PER_SHIFT people, with
// at least one supervisor and one bilingual. These give hard lower bounds on how
// many people (and how many supervisors / bilinguals) the week needs - bounds no
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
// yields two openings; a shift that only lacks a supervisor yields one opening.
// Every opening draws from EVERYONE currently unavailable for that shift (a
// non-role responder can still complete the week - see candidatesForSlotExhaustive)
// - role-holders are merely ordered first on the opening that carries the role
// requirement, so the combination search reaches them soonest.
function buildOpenings(responders, rankedByGap, spareOf = null) {
  const openings = [];
  for (const { slot, need } of rankedByGap) {
    const roleNeeded = need.sup || need.bil;
    const count = Math.max(need.people, roleNeeded ? 1 : 0);
    const roleFirst = candidatesForSlotExhaustive(responders, slot, need, spareOf);
    const any = rankCandidates(candidatesAny(responders, slot), slot, spareOf);
    for (let i = 0; i < count; i++) {
      const cands = i === 0 && roleNeeded ? roleFirst : any;
      openings.push({ slot, cands });
    }
  }
  return openings;
}

// Can the week be completed by opening each of `remaining` for one DISTINCT
// person (on top of `baseOpens`, already forced)? Depth-first over each opening's
// candidates (best-first), returning the first witness schedule found - or null.
// Bounded by the shared time budget.
function canComplete(baseOpens, remaining, usedIds, solveWith, timeLeft, tick) {
  if (remaining.length === 0) {
    tick();
    return solveWith(baseOpens);
  }
  if (timeLeft() < 500) return null;
  const [opening, ...rest] = remaining;
  for (const cand of opening.cands) {
    if (usedIds.has(cand.id)) continue;
    if (timeLeft() < 500) return null;
    const witness = canComplete(
      [...baseOpens, { id: cand.id, slot: opening.slot }],
      rest,
      new Set([...usedIds, cand.id]),
      solveWith,
      timeLeft,
      tick
    );
    if (witness) return witness;
  }
  return null;
}

// When no SINGLE change completes the week, find the smallest set of shifts that
// must be opened together - and, for EACH of those shifts, EVERYONE who could open
// it as part of a complete fix (with the other shifts opened by someone). This is
// the thorough answer: not one example combination, but the full menu of options
// per shift, so the coordinator sees every availability change that would work.
// Exhaustive and uncapped within the time budget.
function enumerateMultiFix(openings, solveWith, timeLeft, tick) {
  const m = openings.length;
  if (m === 0 || openings.some((o) => o.cands.length === 0)) return null;

  let witness0 = null;
  const bySlot = new Map(); // slot -> { slotLabel, count, people: Map(id -> person) }

  for (let i = 0; i < m; i++) {
    if (timeLeft() < 600) break;
    const opening = openings[i];
    const others = openings.filter((_, j) => j !== i);
    let entry = bySlot.get(opening.slot);
    if (!entry) {
      entry = { slot: opening.slot, slotLabel: shiftLabelFor(opening.slot), count: 0, people: new Map() };
      bySlot.set(opening.slot, entry);
    }
    entry.count += 1;
    // Every person who could take THIS opening as part of a complete fix: force
    // them here, then check the other shifts can be opened by distinct others.
    for (const cand of opening.cands) {
      if (timeLeft() < 600) break;
      if (entry.people.has(cand.id)) continue;
      const witness = canComplete(
        [{ id: cand.id, slot: opening.slot }],
        others,
        new Set([cand.id]),
        solveWith,
        timeLeft,
        tick
      );
      if (witness) {
        entry.people.set(cand.id, { ...briefPerson(cand), schedule: witness });
        if (!witness0) witness0 = witness;
      }
    }
  }

  const slots = [...bySlot.values()]
    .filter((e) => e.people.size > 0)
    .map((e) => ({ slot: e.slot, slotLabel: e.slotLabel, count: e.count, people: [...e.people.values()] }));
  if (slots.length === 0) return null;
  return { size: m, slots, schedule: witness0 };
}

// Reachability search - the honest answer to "who do I call so a complete
// schedule becomes possible?" Returns:
//   capacity:   the hard head-count / role floor analysis (see capacityFloor).
//   singleFixes:[{ slot, slotLabel, needLabel, people:[…], schedule }] - shifts a
//               single phone call completes, with everyone who could and a sample
//               resulting schedule.
//   multiFix:   { asks:[{ person, slot, slotLabel, addedHours }], schedule } | null
//               - a minimal set of changes that together complete the week.
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

  // Gaps to search: the short shifts of the best partial UNIONED with those of
  // every other near-miss schedule, so a fix that opens a shift only some of them
  // leave short is still considered.
  const gaps = unionGaps([bestPartial, ...(opts.partials || [])]);
  const bodyDeficit = [...gaps.values()].reduce((s, n) => s + n.people, 0);
  const capacity = capacityFloor(responders);

  const assignedIds = new Set(
    Object.keys(bestPartial.assignment).filter((id) => bestPartial.assignment[id].length > 0)
  );
  const unplaced = responders.filter((r) => !assignedIds.has(r.id)).map(briefPerson);

  // Unused weekly hours per responder in the current partial. Someone at their
  // full commitment can't absorb an opened shift without dropping another (which
  // just moves the gap), so candidate ranking leads with the people who have
  // spare hours - the unplaced most of all. This is what makes the multi-fix
  // search reliably find the people who can ACTUALLY complete the week.
  const targetHoursOf = (r) => (r.hours === REDUCED_HOURS ? REDUCED_HOURS : 12);
  const spareOf = (r) => {
    const assigned = (bestPartial.assignment[r.id] || []).reduce(
      (s, id) => s + slotHoursOf(id),
      0
    );
    return targetHoursOf(r) - assigned;
  };

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

  // Rank the identified short shifts hardest-first - these are searched FIRST as
  // the most likely place a fix lives. But they are only a priority ordering, NOT
  // a gate: an infeasible week can also show up purely as an over-filled shift or
  // an unplaced responder with no "gap" at all, and the exhaustive sweep below
  // still finds the fix. So we never bail out just because no short shift was
  // identified.
  const rankedByGap = [...gaps.entries()]
    .map(([slot, need]) => ({
      slot,
      need,
      cands: rankCandidates(candidatesForGap(responders, slot, need), slot, spareOf),
    }))
    .sort((a, b) => {
      const sev = (g) => (g.need.sup ? 100 : 0) + (g.need.bil ? 50 : 0) + g.need.people * 10;
      return sev(b) - sev(a);
    });

  const solveOpts = {
    want: 1,
    stopOnFirstValid: true,
    avoidancePairs,
    preferredPairs,
    noUnlockSearch: true,
  };
  const byId = Object.fromEntries(responders.map((r) => [r.id, r]));

  // Does opening the given shifts make a COMPLETE, valid schedule possible? This
  // is the heart of "make a complete schedule possible", so it must not miss a
  // reachable schedule. We ask the exact solver first - it is complete, and a
  // real fix usually verifies in milliseconds while a definitive 'unsat' rejects
  // a non-fix outright - and only fall back to the greedy when the exact search
  // runs out of time ('unknown'). Relying on the greedy alone (as before) is
  // exactly what dropped genuine fixes from the list.
  const solveWith = (opens, maxMs = checkBudgetMs) => {
    const opened = withOpened(responders, opens);

    const tExact = Math.min(maxMs, timeLeft());
    let valid = null;
    if (tExact >= 300) {
      const ex = solveExact(opened, { avoidancePairs, budgetMs: tExact });
      if (ex.status === 'sat') {
        valid = scheduleFromAssignment(ex.assignment, byId, responders, avoidancePairs, preferredPairs);
      } else if (ex.status === 'unsat') {
        return null; // provably no valid schedule with this opening - done.
      }
    }

    if (!valid) {
      const tGreedy = Math.min(maxMs, timeLeft());
      if (tGreedy < 300) return null;
      const res = generateSchedules(opened, {
        ...solveOpts,
        timeBudgetMs: tGreedy,
        exactFallback: false, // exact already tried above; don't repeat it
      });
      valid = res.schedules.find((s) => s.valid) || null;
    }

    if (valid && opens.every(({ id, slot }) => (valid.slots[slot] || []).some((p) => p.id === id))) {
      return valid;
    }
    return null;
  };

  // Go one by one through everyone who could open `slot` and collect each person
  // for whom opening that ONE shift makes a COMPLETE schedule possible. Role-blind
  // (a plain body can complete the week by relieving the packing) and, by default,
  // uncapped. `probeLimit` optionally stops early on shifts that clearly aren't a
  // single-call fix (used by the wider sweep to stay within budget); `deadline`
  // and `perCheckMs` bound the effort.
  const collectFixers = (slot, need, { probeLimit = 0, deadlineLeft, perCheckMs = checkBudgetMs }) => {
    const cands = candidatesForSlotExhaustive(responders, slot, need, spareOf);
    const people = [];
    let schedule = null;
    let tried = 0;
    for (const r of cands) {
      if (deadlineLeft() < 400) break;
      if (probeLimit && people.length === 0 && tried >= probeLimit) break;
      tried += 1;
      tickProgress();
      const valid = solveWith([{ id: r.id, slot }], perCheckMs);
      if (valid) {
        // Keep EACH unlocker's own resulting schedule so the UI can let the
        // coordinator click between people and see the exact week each produces.
        people.push({ ...briefPerson(r), schedule: valid });
        if (!schedule) schedule = valid;
      }
    }
    return { people, schedule };
  };

  result.searched = true;

  // Total openings that must be filled across all short shifts. When that's one,
  // the week is a single phone call away; when it's more, a single call usually
  // can't complete it (that's what the multi-change search is for).
  const openings = buildOpenings(responders, rankedByGap, spareOf);
  const totalOpenings = openings.length;
  const multiGap = totalOpenings > 1;

  // Budget phasing. Completeness is the priority (see the reach-out contract),
  // so nothing is capped by count and every candidate is tried in full. We only
  // partition TIME: the direct fixes (opening a short shift) and the multi-change
  // search run first, then the wider all-shifts sweep gets the rest. Each phase
  // hands unused time forward, so on the common (fast) rosters everything is
  // searched exhaustively; only a genuinely intractable roster ever truncates,
  // and then the high-value direct fixes are the part that already ran.
  const gapPhaseEnd = start + budgetMs * 0.4;
  const gapLeft = () => Math.min(timeLeft(), gapPhaseEnd - Date.now());
  // The multi-change enumeration is the thorough answer when no single change
  // works, so it gets a big slice of the budget; the wider sweep takes the tail.
  const multiPhaseEnd = start + budgetMs * 0.85;
  const multiLeft = () => Math.min(timeLeft(), multiPhaseEnd - Date.now());

  // ---- Pass 1: single-change fixes at the short shifts ----
  // For EVERY short shift, go one by one through EVERYONE who would have to open
  // it (role-blind, uncapped, no early abandonment - see collectFixers) and keep
  // each person for whom opening that ONE shift completes the week.
  for (const { slot, need } of rankedByGap) {
    if (gapLeft() < 400) break;
    const { people, schedule } = collectFixers(slot, need, { deadlineLeft: gapLeft });
    if (people.length) {
      result.singleFixes.push({
        slot,
        slotLabel: shiftLabelFor(slot),
        needLabel: needLabelFor(need),
        people,
        schedule,
      });
    }
  }

  // ---- Pass 2: minimal multi-call fix ----
  // No single change completes a short shift, so find the smallest set of shifts
  // that must be opened together - and, for EACH, EVERYONE who could open it as
  // part of a complete fix (not just one example combination).
  if (result.singleFixes.length === 0 && totalOpenings >= 1 && totalOpenings <= 6) {
    result.multiFix = enumerateMultiFix(openings, solveWith, multiLeft, tickProgress);
  }

  // ---- Pass 3: wide sweep over every OTHER shift ----
  // Closes the last gap in exhaustiveness: a single change can also complete the
  // week by opening a shift that ISN'T currently short - a plain body there frees
  // the packing so a supervisor can move to cover the real gap ("displacement"
  // fix). So we try opening every remaining shift too, one by one for EVERYONE,
  // with the same full per-check budget - no early-stop, since a genuine fixer can
  // be ranked anywhere. Fixes found here are flagged `indirect` (the shift they
  // open isn't the one that was short). Bounded only by the overall time budget.
  for (const slot of ALL_SLOTS) {
    if (gaps.has(slot)) continue; // already searched in full above
    if (timeLeft() < 400) break;
    if (candidatesAny(responders, slot).length === 0) continue;
    const { people, schedule } = collectFixers(slot, {}, { deadlineLeft: timeLeft });
    if (people.length) {
      result.singleFixes.push({
        slot,
        slotLabel: shiftLabelFor(slot),
        needLabel: needLabelFor({}),
        indirect: true,
        people,
        schedule,
      });
    }
  }

  result.exhausted = result.singleFixes.length === 0 && !result.multiFix;
  report(1);
  return result;
}
