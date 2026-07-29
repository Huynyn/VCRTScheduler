// Regression tests for the exact-solver completeness backstop.
//
// Background: the randomised greedy in scheduler.js is INCOMPLETE — on tight
// rosters (few patterns per person, hours barely meeting the week's minimum) it
// can fail to build a valid schedule even when one exists, which silently dropped
// real fixes from "make a complete schedule possible". src/lib/exactSolver.js is
// the completeness backstop. These tests lock in that:
//   1. the exact solver only ever returns hard-rule-valid schedules;
//   2. it correctly proves impossibility (no pattern / no supervisor);
//   3. the wiring guarantee holds: whenever a complete schedule provably exists,
//      generateSchedules reports ok=true (never "no schedule possible");
//   4. the reach-out reports an availability change the exact oracle confirms
//      unlocks the week, instead of dropping it because the greedy couldn't build
//      the resulting schedule.
//
// Fixtures are built by deriving a roster from a KNOWN valid schedule and keeping
// availability tight, so the exact oracle stays fast and decisive (no flakiness).

import {
  ALL_SLOTS, DAYS, SHIFTS, SHIFT_BY_ID, slotId, parseSlot,
  MIN_PER_SHIFT, MAX_PER_SHIFT, PREF, REDUCED_HOURS, FORBIDDEN_BACK_TO_BACK,
} from '../src/constants/schedule.js';
import { makeRng } from '../src/lib/scoring.js';
import { buildPatterns } from '../src/lib/patterns.js';
import { solveExact } from '../src/lib/exactSolver.js';
import { generateSchedules } from '../src/lib/scheduler.js';

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ FAIL: ${msg}`); failures += 1; }
};

const NIGHT = SHIFTS.find((s) => s.kind === 'night').id;
const [DAY1, DAY2] = SHIFTS.filter((s) => s.kind === 'day').map((s) => s.id);

// Validate a responderId->slots assignment against every HARD rule.
function hardProblems(assignment, responders) {
  const byId = Object.fromEntries(responders.map((r) => [r.id, r]));
  const problems = [];
  const cnt = {}, sup = {}, bil = {};
  for (const id of ALL_SLOTS) { cnt[id] = 0; sup[id] = 0; bil[id] = 0; }
  for (const [rid, slots] of Object.entries(assignment)) {
    const r = byId[rid];
    for (const id of slots) { cnt[id]++; if (r.role === 'supervisor') sup[id]++; if (r.bilingual) bil[id]++; }
  }
  for (const id of ALL_SLOTS) {
    if (cnt[id] < MIN_PER_SHIFT) problems.push(`${id} under min (${cnt[id]})`);
    if (cnt[id] > MAX_PER_SHIFT) problems.push(`${id} over max (${cnt[id]})`);
    if (sup[id] < 1) problems.push(`${id} no supervisor`);
    if (bil[id] < 1) problems.push(`${id} no bilingual`);
  }
  for (const r of responders) {
    const slots = assignment[r.id] || [];
    const hours = slots.reduce((s, id) => s + SHIFT_BY_ID[parseSlot(id).shift].hours, 0);
    const req = r.hours === REDUCED_HOURS ? 6 : 12;
    if (hours !== req) problems.push(`${r.name} ${hours}h != ${req}h`);
    for (const id of slots) if (r.prefs[id] === PREF.UNAVAIL) problems.push(`${r.name} on unavailable ${id}`);
    for (const [a, b] of FORBIDDEN_BACK_TO_BACK) if (slots.includes(a) && slots.includes(b)) problems.push(`${r.name} back-to-back`);
  }
  return problems;
}

// Build a tight roster derived from a concrete valid schedule, so a complete
// schedule is guaranteed to exist. Every night slot gets a (supervisor+bilingual)
// + two rookies; every day gets one (supervisor+bilingual) + two rookies working
// that day's 08:00-14:00 and 14:00-20:00. Supplied hours == weekly minimum
// (zero slack). `extraSeed` sprinkles a little extra availability so responders
// have genuine pattern CHOICE (which is what trips up the greedy) while keeping
// the exact oracle fast.
function buildTightRoster(extraSeed = 0) {
  const responders = [];
  let n = 0;
  const mk = (slots, { sup, bil, hours = 12 }) => {
    const prefs = {};
    for (const id of ALL_SLOTS) prefs[id] = PREF.UNAVAIL;
    for (const id of slots) prefs[id] = PREF.AVAIL;
    n += 1;
    return {
      id: `p${n}`, name: `P${n}`, role: sup ? 'supervisor' : 'rookie',
      bilingual: bil, gender: n % 2 ? 'male' : 'female', hours, prefs,
    };
  };

  // Nights: 7 slots × (1 sup+bil overnight + 2 rookie overnights).
  for (const day of DAYS) {
    const nightSlot = slotId(day, NIGHT);
    responders.push(mk([nightSlot], { sup: true, bil: true }));
    responders.push(mk([nightSlot], { sup: false, bil: false }));
    responders.push(mk([nightSlot], { sup: false, bil: false }));
  }
  // Days: each day, 3 people work that day's 08:00-14:00 + 14:00-20:00 (a legal
  // 12h day pattern), one of them supervisor+bilingual.
  for (const day of DAYS) {
    const pair = [slotId(day, DAY1), slotId(day, DAY2)];
    responders.push(mk(pair, { sup: true, bil: true }));
    responders.push(mk(pair, { sup: false, bil: false }));
    responders.push(mk(pair, { sup: false, bil: false }));
  }

  // Optional extra availability to create pattern choice (harder for greedy).
  if (extraSeed) {
    const rng = makeRng(extraSeed);
    for (const r of responders) {
      if (rng() < 0.35) {
        const slot = ALL_SLOTS[Math.floor(rng() * ALL_SLOTS.length)];
        if (r.prefs[slot] === PREF.UNAVAIL) r.prefs[slot] = PREF.AVAIL;
      }
    }
  }
  return responders;
}

console.log('1) Exact solver returns only hard-rule-valid schedules');
{
  const roster = buildTightRoster(0);
  const res = solveExact(roster, { budgetMs: 4000 });
  ok(res.status === 'sat', `feasible tight roster -> sat (got ${res.status})`);
  if (res.status === 'sat') {
    const problems = hardProblems(res.assignment, roster);
    ok(problems.length === 0, `exact assignment has no hard-rule violations (${problems.slice(0, 3).join('; ')})`);
  }
}

console.log('2) Exact solver proves genuine impossibility');
{
  // A 12h responder whose only availability is a single 6h day slot can never
  // form a legal 12h week -> no pattern -> unsat.
  const roster = buildTightRoster(0);
  roster[0].prefs = Object.fromEntries(ALL_SLOTS.map((id) => [id, PREF.UNAVAIL]));
  roster[0].prefs[slotId('Mon', DAY1)] = PREF.AVAIL; // one 6h slot only, but 12h
  const res = solveExact(roster, { budgetMs: 4000 });
  ok(res.status === 'unsat', `responder with no legal pattern -> unsat (got ${res.status})`);
}
{
  // Remove every supervisor's availability from one slot -> that slot can never
  // hold a supervisor -> unsat.
  const roster = buildTightRoster(0);
  const target = slotId('Wed', NIGHT);
  for (const r of roster) if (r.role === 'supervisor' && r.prefs[target] !== PREF.UNAVAIL) r.prefs[target] = PREF.UNAVAIL;
  const res = solveExact(roster, { budgetMs: 8000 });
  ok(res.status === 'unsat', `slot with no available supervisor -> unsat (got ${res.status})`);
}

console.log('3) Wiring guarantee: exact-sat  =>  generateSchedules reports ok=true');
{
  // Several seeded tight rosters with pattern choice. Whenever the exact oracle
  // proves a complete schedule exists, generateSchedules must NOT report "no
  // schedule possible" — this is the incompleteness bug that dropped real fixes.
  let checked = 0;
  for (const seed of [1, 7, 13, 21, 42, 99, 123, 777]) {
    const roster = buildTightRoster(seed);
    const exact = solveExact(roster, { budgetMs: 4000 });
    if (exact.status !== 'sat') continue; // only assert when the oracle is decisive
    checked += 1;
    const res = generateSchedules(roster, { timeBudgetMs: 1500, noUnlockSearch: true, exactBudgetMs: 3000 });
    ok(res.ok === true, `seed ${seed}: exact=sat so generateSchedules must be ok=true (got ${res.ok})`);
  }
  ok(checked > 0, `exercised the guarantee on ${checked} decidable roster(s)`);
}

console.log('4) Reach-out surfaces an exact-confirmed unlock the greedy would miss');
{
  // Take a feasible tight roster and REMOVE one supervisor's availability from a
  // shift so that shift loses its only supervisor -> the week is now infeasible,
  // and the honest fix is "that supervisor re-opens that shift". The reach-out
  // must report a fix (it verifies with the exact solver now, so it can't drop it
  // just because the greedy fails to rebuild the schedule).
  const roster = buildTightRoster(5);
  // Find a night slot and its supervisor.
  const target = slotId('Fri', NIGHT);
  const supHere = roster.find((r) => r.role === 'supervisor' && r.prefs[target] !== PREF.UNAVAIL);
  // Give that supervisor an alternative overnight so they still have a pattern,
  // then close the target for them -> target loses its supervisor.
  supHere.prefs[slotId('Mon', NIGHT)] = PREF.AVAIL;
  supHere.prefs[target] = PREF.UNAVAIL;

  const base = solveExact(roster, { budgetMs: 6000 });
  // Confirm reopening the target for this supervisor restores feasibility.
  const reopened = roster.map((r) => r.id === supHere.id ? { ...r, prefs: { ...r.prefs, [target]: PREF.NONNEG } } : r);
  const withFix = solveExact(reopened, { budgetMs: 6000 });

  if (base.status === 'unsat' && withFix.status === 'sat') {
    const res = generateSchedules(roster, { timeBudgetMs: 1500, reachoutBudgetMs: 12000, reachoutCheckMs: 1200 });
    ok(res.ok === false, 'base roster reports no complete schedule');
    const reach = res.reachout;
    const named = new Set();
    for (const f of reach?.singleFixes || []) for (const p of f.people) named.add(p.id);
    for (const a of reach?.multiFix?.asks || []) named.add(a.person.id);
    ok(reach && (reach.singleFixes.length > 0 || reach.multiFix), 'reach-out reports at least one concrete fix');
    ok(named.has(supHere.id), `reach-out names the supervisor whose reopening the exact oracle confirms (${supHere.name})`);
  } else {
    console.log(`  (skipped: fixture not in expected state base=${base.status} withFix=${withFix.status})`);
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
