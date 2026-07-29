import {
  ALL_SLOTS,
  MIN_PER_SHIFT,
  MAX_PER_SHIFT,
  SHIFT_BY_ID,
  parseSlot,
  REDUCED_HOURS,
} from '../constants/schedule.js';
import { buildPatterns } from './patterns.js';

// ---------------------------------------------------------------------------
// Exact feasibility solver — the completeness backstop for the heuristic greedy.
//
// The randomised greedy in scheduler.js is fast and produces diverse, well-scored
// schedules, but it is INCOMPLETE: on tight rosters (e.g. when supplied hours
// barely meet the week's minimum, so every shift must be filled to exactly the
// minimum and everyone placed at their exact hours) it can fail to construct a
// valid schedule even when one demonstrably exists. That directly corrupts the
// "make a complete schedule possible" feature, which asks the solver whether a
// given availability change unlocks a complete week: if the greedy can't build
// the schedule that change unlocks, the change is wrongly dropped from the
// suggestions.
//
// This module answers the same question completely. It is a systematic
// backtracking search over each responder's legal weekly patterns (which already
// encode exact hours, non-negotiables and the rest-period rule), enforcing the
// hard slot rules: every shift holds between MIN and MAX people, with at least
// one supervisor and one bilingual, and no keep-apart pair shares a shift.
//
// Returns { status, assignment }:
//   status 'sat'     — a fully valid schedule exists; `assignment` is one such
//                      responderId -> slot[] map.
//   status 'unsat'   — the search space was explored exhaustively (within the
//                      node cap) and no valid schedule exists. Definitive.
//   status 'unknown' — the time/node budget ran out before either was proven.
//
// A 'sat' assignment always passes evaluate().valid: every responder is placed on
// an exact-hours pattern (so nobody is unplaced or under-hours), every shift is
// within [MIN, MAX] with a supervisor and bilingual, and keep-apart is respected.
// ---------------------------------------------------------------------------

const SLOT_INDEX = Object.fromEntries(ALL_SLOTS.map((id, i) => [id, i]));
const S = ALL_SLOTS.length;

const slotHoursOf = (id) => SHIFT_BY_ID[parseSlot(id).shift].hours;
const committedHours = (r) => (r.hours === REDUCED_HOURS ? REDUCED_HOURS : 12);

// Upper bound on people per shift for THIS roster. When supplied hours exactly
// equal the week's minimum demand there is zero slack: every shift must be filled
// to exactly MIN and no shift may take a fourth person (that would starve
// another). Capping at MIN in that case is both correct and a huge pruning win.
function shiftCap(responders) {
  const supplied = responders.reduce((sum, r) => sum + committedHours(r), 0);
  const minDemand = ALL_SLOTS.reduce(
    (sum, id) => sum + slotHoursOf(id) * MIN_PER_SHIFT,
    0
  );
  return supplied === minDemand ? MIN_PER_SHIFT : MAX_PER_SHIFT;
}

// Node cap for a single systematic search. Reaching it turns a fruitless search
// into 'unknown' rather than a false 'unsat'. Generous enough to prove UNSAT on
// realistic single-team rosters, bounded so a pathological instance can't spin
// forever between the time checks.
const DEFAULT_NODE_CAP = 200_000_000;

export function solveExact(responders, opts = {}) {
  const budgetMs = opts.budgetMs ?? 4000;
  const avoidancePairs = opts.avoidancePairs ?? [];
  const nodeCap = opts.nodeCap ?? DEFAULT_NODE_CAP;

  if (responders.length === 0) return { status: 'unsat', assignment: null, nodes: 0, ms: 0 };

  const cap = shiftCap(responders);

  const vars = [];
  for (const r of responders) {
    const list = buildPatterns(r).patterns.map((p) => p.map((id) => SLOT_INDEX[id]));
    // A responder with no legal pattern can never be placed at their committed
    // hours, so no valid schedule exists — definitive.
    if (list.length === 0) {
      return { status: 'unsat', assignment: null, nodes: 0, ms: 0, reason: `${r.name} has no legal weekly pattern` };
    }
    vars.push({ r, sup: r.role === 'supervisor', bil: !!r.bilingual, list });
  }

  // Variable ordering (fail-first): scarce attribute holders bind the schedule,
  // and among those the most-constrained (fewest patterns) go first.
  vars.sort((a, b) => {
    const sa = a.sup || a.bil ? 0 : 1;
    const sb = b.sup || b.bil ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return a.list.length - b.list.length;
  });
  const n = vars.length;

  // Keep-apart adjacency in the SORTED index space.
  const idToIdx = new Map(vars.map((v, i) => [v.r.id, i]));
  const avoid = Array.from({ length: n }, () => new Set());
  for (const [a, b] of avoidancePairs) {
    const ia = idToIdx.get(a);
    const ib = idToIdx.get(b);
    if (ia != null && ib != null) {
      avoid[ia].add(ib);
      avoid[ib].add(ia);
    }
  }
  const anyAvoid = avoidancePairs.length > 0;

  // Live slot state.
  const count = new Int32Array(S);
  const sup = new Int32Array(S);
  const bil = new Int32Array(S);
  const membersAt = anyAvoid ? Array.from({ length: S }, () => []) : null;

  // Suffix supply: from variable i onward, how many remaining responders could
  // still contribute to each slot (and how many of them are sup / bil). Lets us
  // prune the instant a slot can no longer reach its minimum or its required
  // supervisor / bilingual.
  const supplyCount = new Array(n + 1);
  const supplySup = new Array(n + 1);
  const supplyBil = new Array(n + 1);
  {
    const c = new Int32Array(S);
    const u = new Int32Array(S);
    const b = new Int32Array(S);
    supplyCount[n] = c.slice();
    supplySup[n] = u.slice();
    supplyBil[n] = b.slice();
    for (let i = n - 1; i >= 0; i--) {
      const seen = new Set();
      for (const p of vars[i].list) for (const s of p) seen.add(s);
      for (const s of seen) {
        c[s] += 1;
        if (vars[i].sup) u[s] += 1;
        if (vars[i].bil) b[s] += 1;
      }
      supplyCount[i] = c.slice();
      supplySup[i] = u.slice();
      supplyBil[i] = b.slice();
    }
  }

  const choice = new Array(n);
  let nodes = 0;
  let found = null;
  let truncated = false;
  const deadline = Date.now() + budgetMs;

  const feasibleFrom = (i) => {
    const sc = supplyCount[i];
    const ss = supplySup[i];
    const sb = supplyBil[i];
    for (let s = 0; s < S; s++) {
      if (count[s] + sc[s] < MIN_PER_SHIFT) return false;
      if (sup[s] === 0 && ss[s] === 0) return false;
      if (bil[s] === 0 && sb[s] === 0) return false;
    }
    return true;
  };

  const dfs = (i) => {
    if (found) return;
    if (nodes >= nodeCap) {
      truncated = true;
      return;
    }
    if ((nodes & 2047) === 0 && Date.now() > deadline) {
      truncated = true;
      return;
    }
    nodes += 1;

    if (i === n) {
      for (let s = 0; s < S; s++) {
        if (count[s] < MIN_PER_SHIFT || sup[s] < 1 || bil[s] < 1) return;
      }
      found = vars.map((v, k) => [v.r.id, choice[k].map((si) => ALL_SLOTS[si])]);
      return;
    }

    if (!feasibleFrom(i)) return;

    const v = vars[i];

    // Value ordering: try patterns that plug the currently-neediest shifts first,
    // so a satisfying assignment surfaces quickly when one exists.
    const options = [];
    for (const p of v.list) {
      let fits = true;
      let score = 0;
      for (const s of p) {
        if (count[s] >= cap) {
          fits = false;
          break;
        }
        if (count[s] < MIN_PER_SHIFT) score += 10 * (MIN_PER_SHIFT - count[s]);
        if (v.sup && sup[s] === 0) score += 5;
        if (v.bil && bil[s] === 0) score += 5;
      }
      if (!fits) continue;
      if (anyAvoid && avoid[i].size) {
        let clash = false;
        for (const s of p) {
          for (const m of membersAt[s]) {
            if (avoid[i].has(m)) {
              clash = true;
              break;
            }
          }
          if (clash) break;
        }
        if (clash) continue;
      }
      options.push({ p, score });
    }
    options.sort((a, b) => b.score - a.score);

    for (const { p } of options) {
      for (const s of p) {
        count[s] += 1;
        if (v.sup) sup[s] += 1;
        if (v.bil) bil[s] += 1;
        if (anyAvoid) membersAt[s].push(i);
      }
      choice[i] = p;
      dfs(i + 1);
      for (const s of p) {
        count[s] -= 1;
        if (v.sup) sup[s] -= 1;
        if (v.bil) bil[s] -= 1;
        if (anyAvoid) membersAt[s].pop();
      }
      if (found) return;
    }
  };

  const t0 = Date.now();
  dfs(0);
  const ms = Date.now() - t0;

  if (found) {
    const assignment = {};
    for (const [id, slots] of found) assignment[id] = slots;
    return { status: 'sat', assignment, nodes, ms, cap };
  }
  return { status: truncated ? 'unknown' : 'unsat', assignment: null, nodes, ms, cap };
}
