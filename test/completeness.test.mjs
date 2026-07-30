// Regression tests for the exact-solver completeness backstop.
//
// Background: the randomised greedy in scheduler.js is INCOMPLETE - on tight
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
  // schedule possible" - this is the incompleteness bug that dropped real fixes.
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

// Exact ground truth: everyone whose reopening `slot` (forced) yields a complete
// schedule. This is what the reach-out must report for that shift - no more
// (false positives), no fewer (the cap / role-filter bug dropped real fixers).
function groundTruthFixers(roster, slot, budgetMs = 4000) {
  const set = new Set();
  for (const r of roster) {
    if (r.prefs[slot] !== PREF.UNAVAIL) continue;
    const mod = roster.map((x) =>
      x.id === r.id ? { ...x, prefs: { ...x.prefs, [slot]: PREF.NONNEG } } : x
    );
    if (solveExact(mod, { budgetMs }).status === 'sat') set.add(r.id);
  }
  return set;
}
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

console.log('4) Reach-out reports EXACTLY the exact-confirmed single-shift fixers (no cap, role-blind)');
{
  // Feasible tight roster, then close one shift for its only supervisor (giving
  // them an alternative overnight so they stay placeable) -> the week is now one
  // supervisor short at that shift. The reach-out must list every responder the
  // exact oracle confirms could reopen it - not a capped subset, and not only
  // role-holders (a plain body can complete the week by relieving the packing).
  const roster = buildTightRoster(5);
  const target = slotId('Fri', NIGHT);
  const supHere = roster.find((r) => r.role === 'supervisor' && r.prefs[target] !== PREF.UNAVAIL);
  supHere.prefs[slotId('Mon', NIGHT)] = PREF.AVAIL;
  supHere.prefs[target] = PREF.UNAVAIL;

  const base = solveExact(roster, { budgetMs: 6000 });
  if (base.status === 'unsat' || base.status === 'unknown') {
    const truth = groundTruthFixers(roster, target);
    const res = generateSchedules(roster, { timeBudgetMs: 1500, reachoutBudgetMs: 20000, reachoutCheckMs: 1500 });
    ok(res.ok === false, 'base roster reports no complete schedule');
    const reported = new Set();
    for (const f of res.reachout?.singleFixes || []) if (f.slot === target) for (const p of f.people) reported.add(p.id);
    ok(truth.size > 0, `exact oracle finds ${truth.size} genuine fixer(s) for the shift`);
    ok(reported.has(supHere.id), `names the supervisor whose reopening the oracle confirms (${supHere.name})`);
    ok(sameSet(reported, truth), `reports EXACTLY the ${truth.size} oracle-confirmed fixer(s) - got ${reported.size} (no cap, no role filter, no false positives)`);
  } else {
    console.log(`  (skipped: fixture unexpectedly feasible, base=${base.status})`);
  }
}

console.log('5) Multiple shifts short: EVERY option per shift is reported (not one example)');
{
  // Build a two-supervisor-short week where no single change completes it, but many
  // pairs do. We add a couple of spare supervisors (slack) then close two day
  // shifts for the regular supervisors, so each short shift can be reopened by any
  // of several people. The reach-out must list, FOR EACH short shift, EVERY person
  // who could open it as part of a complete fix - not one example pair.
  const makeTwoGap = (seed) => {
    const roster = buildTightRoster(seed);
    // Two spare bilingual supervisors, each able to work either targeted day.
    const spare = (name, days) => {
      const prefs = {};
      for (const id of ALL_SLOTS) prefs[id] = PREF.UNAVAIL;
      for (const d of days) { prefs[slotId(d, 'day1')] = PREF.AVAIL; prefs[slotId(d, 'day2')] = PREF.AVAIL; }
      return { id: name, name, role: 'supervisor', bilingual: true, gender: 'female', hours: 12, prefs };
    };
    roster.push(spare('SpareA', ['Wed', 'Thu']));
    roster.push(spare('SpareB', ['Sat', 'Sun']));
    const targets = [slotId('Wed', 'day2'), slotId('Sat', 'day2')];
    for (const r of roster) {
      if (r.role !== 'supervisor') continue;
      for (const t of targets) if (r.prefs[t] !== PREF.UNAVAIL) r.prefs[t] = PREF.UNAVAIL;
    }
    return { roster, targets };
  };

  let picked = null;
  for (const seed of [3, 8, 15, 22, 30]) {
    const cand = makeTwoGap(seed);
    if (solveExact(cand.roster, { budgetMs: 5000 }).status === 'sat') continue; // must be infeasible
    const res = generateSchedules(cand.roster, { timeBudgetMs: 1500, reachoutBudgetMs: 60000, reachoutCheckMs: 2000 });
    if (res.ok === false && res.reachout?.multiFix?.slots?.length >= 2) { picked = { ...cand, res }; break; }
  }

  if (!picked) {
    console.log('  (skipped: could not construct a decidable two-gap fixture)');
  } else {
    const mf = picked.res.reachout.multiFix;
    ok(picked.res.ok === false, 'two-gap roster reports no complete schedule');
    ok(mf.slots.length >= 2, `multi-fix names all ${mf.slots.length} shifts that must be opened`);
    // Exact ground truth for one target shift: P is an option iff forcing P there
    // AND opening the other shift for some distinct person yields a valid week.
    const [S, other] = picked.targets;
    const truth = new Set();
    for (const P of picked.roster) {
      if (P.prefs[S] !== PREF.UNAVAIL) continue;
      const forced = picked.roster.map((r) => r.id === P.id ? { ...r, prefs: { ...r.prefs, [S]: PREF.NONNEG } } : r);
      let works = false;
      for (const Q of forced) {
        if (Q.id === P.id || Q.prefs[other] !== PREF.UNAVAIL) continue;
        const mod = forced.map((r) => r.id === Q.id ? { ...r, prefs: { ...r.prefs, [other]: PREF.NONNEG } } : r);
        if (solveExact(mod, { budgetMs: 1500 }).status === 'sat') { works = true; break; }
      }
      if (works) truth.add(P.id);
    }
    const reported = new Set((mf.slots.find((x) => x.slot === S)?.people || []).map((p) => p.id));
    ok(truth.size > 1, `the shift genuinely has ${truth.size} options (more than one example)`);
    ok(sameSet(reported, truth), `reports EXACTLY the ${truth.size} options for the shift - got ${reported.size} (no false positives, none missed)`);
  }
}

console.log('6) Exhaustive over ALL shifts: "displacement" fixes at non-short shifts are found');
{
  // A supervisor (S_blocked) can only work Wed 08:00-14:00 paired with Thu
  // 08:00-14:00, but Thu 08:00-14:00 is filled to the maximum by a 6h rookie (RX)
  // whose only availability is that shift. So S_blocked can't be placed and the
  // week is infeasible - yet NO shift is under-covered (the greedy just over-fills
  // to cram people in). The only fixes are "displacement": open some OTHER shift
  // for someone (e.g. RX) so the packing frees up. This is the case the old
  // gap-only search silently returned nothing for.
  const NIGHT = SHIFTS.find((s) => s.kind === 'night').id;
  const [d1, d2] = SHIFTS.filter((s) => s.kind === 'day').map((s) => s.id);
  const rs = [];
  let idn = 0;
  const mk = (slots, opts = {}) => {
    const { sup = false, bil = false, hours = 12, name } = opts;
    const prefs = {};
    for (const id of ALL_SLOTS) prefs[id] = PREF.UNAVAIL;
    for (const id of slots) prefs[id] = PREF.AVAIL;
    idn += 1;
    return { id: `d${idn}`, name: name || `D${idn}`, role: sup ? 'supervisor' : 'rookie', bilingual: bil, gender: idn % 2 ? 'male' : 'female', hours, prefs };
  };
  for (const day of DAYS) { const s = slotId(day, NIGHT); rs.push(mk([s], { sup: true, bil: true })); rs.push(mk([s])); rs.push(mk([s])); }
  for (const day of DAYS) { if (day === 'Wed') continue; const pair = [slotId(day, d1), slotId(day, d2)]; rs.push(mk(pair, { sup: true, bil: true })); rs.push(mk(pair)); rs.push(mk(pair)); }
  const wed = [slotId('Wed', d1), slotId('Wed', d2)];
  rs.push(mk(wed)); rs.push(mk(wed)); rs.push(mk(wed));
  rs.push(mk([slotId('Wed', d2)], { sup: true, bil: true, hours: 6, name: 'SW2' }));
  rs.push(mk([slotId('Wed', d1), slotId('Thu', d1)], { sup: true, bil: true, name: 'S_blocked' }));
  rs.push(mk([slotId('Thu', d1)], { hours: 6, name: 'RX' }));

  // Exact ground truth over EVERY (person, shift): who, opening which shift,
  // completes the week - regardless of whether that shift was "short".
  const truth = new Set();
  for (const P of rs) {
    for (const S of ALL_SLOTS) {
      if (P.prefs[S] !== PREF.UNAVAIL) continue;
      const mod = rs.map((x) => x.id === P.id ? { ...x, prefs: { ...x.prefs, [S]: PREF.NONNEG } } : x);
      if (solveExact(mod, { budgetMs: 3000 }).status === 'sat') truth.add(`${P.id}@${S}`);
    }
  }

  const res = generateSchedules(rs, { timeBudgetMs: 1500 });
  const reported = new Set();
  let displacementShifts = 0;
  for (const f of res.reachout?.singleFixes || []) {
    if (f.indirect) displacementShifts += 1;
    for (const p of f.people) reported.add(`${p.id}@${f.slot}`);
  }
  ok(res.ok === false, 'infeasible-by-packing roster reports no complete schedule');
  ok(truth.size > 0, `exact oracle finds ${truth.size} genuine fix(es), none at a short shift`);
  ok(displacementShifts > 0, 'reach-out reports fixes flagged as displacement (non-short shift)');
  const missed = [...truth].filter((x) => !reported.has(x));
  const falsePos = [...reported].filter((x) => !truth.has(x));
  ok(missed.length === 0, `no genuine fix missed (missed ${missed.length})`);
  ok(falsePos.length === 0, `no false-positive fix reported (extra ${falsePos.length})`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
