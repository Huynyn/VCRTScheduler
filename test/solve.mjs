import {
  SAMPLE_RESPONDERS,
  SAMPLE_AVOIDANCE_PAIRS,
  SAMPLE_PREFERRED_PAIRS,
} from '../src/data/sampleData.js';
import { generateSchedules } from '../src/lib/scheduler.js';
import { buildPatterns } from '../src/lib/patterns.js';
import { nonNegotiableFlags } from '../src/lib/validation.js';
import {
  ALL_SLOTS,
  MIN_PER_SHIFT,
  MAX_PER_SHIFT,
  REDUCED_HOURS,
  PREF,
  parseSlot,
  SHIFT_BY_ID,
  FORBIDDEN_BACK_TO_BACK,
  WEEKEND_DAYS,
  DAYS,
  SHIFTS,
} from '../src/constants/schedule.js';

function validate(schedule, responders) {
  const byId = Object.fromEntries(responders.map((r) => [r.id, r]));
  const problems = [];

  // Slot-level.
  for (const id of ALL_SLOTS) {
    const ppl = schedule.slots[id];
    if (ppl.length < MIN_PER_SHIFT) problems.push(`${id}: ${ppl.length} < min`);
    if (ppl.length > MAX_PER_SHIFT) problems.push(`${id}: ${ppl.length} > max`);
    if (!ppl.some((p) => p.role === 'supervisor')) problems.push(`${id}: no supervisor`);
    if (!ppl.some((p) => p.bilingual)) problems.push(`${id}: no bilingual`);
  }

  // Responder-level.
  for (const r of responders) {
    const slots = schedule.assignment[r.id] || [];
    const hours = slots.reduce((s, id) => s + SHIFT_BY_ID[parseSlot(id).shift].hours, 0);
    const req = r.hours === REDUCED_HOURS ? REDUCED_HOURS : 12;
    if (hours !== req) problems.push(`${r.name}: ${hours}h != ${req}h`);
    for (const id of slots) {
      if (r.prefs[id] === PREF.UNAVAIL) problems.push(`${r.name}: assigned unavailable ${id}`);
    }
    for (const id of ALL_SLOTS) {
      if (r.prefs[id] === PREF.NONNEG && !slots.includes(id))
        problems.push(`${r.name}: non-neg ${id} not honoured`);
    }
    // Rest-period rule: no 14:00-20:00 followed by next 08:00-14:00.
    for (const [a, b] of FORBIDDEN_BACK_TO_BACK) {
      if (slots.includes(a) && slots.includes(b))
        problems.push(`${r.name}: back-to-back ${a} -> ${b}`);
    }
  }
  return problems;
}

const responders = SAMPLE_RESPONDERS();
const avoidancePairs = SAMPLE_AVOIDANCE_PAIRS();
const preferredPairs = SAMPLE_PREFERRED_PAIRS();

console.log(`Responders: ${responders.length}`);
console.log(`Supervisors: ${responders.filter((r) => r.role === 'supervisor').length}`);
console.log(`Bilingual: ${responders.filter((r) => r.bilingual).length}`);
console.log(`Reduced (6h): ${responders.filter((r) => r.hours === REDUCED_HOURS).length}`);
console.log(`Avoidance pairs: ${avoidancePairs.length}`);

// Pattern-count sanity: min/avg patterns (back-to-back rule shouldn't tank it).
const patternCounts = responders.map((r) => buildPatterns(r).patterns.length);
console.log(
  `Patterns per responder: min=${Math.min(...patternCounts)} avg=${(
    patternCounts.reduce((s, x) => s + x, 0) / patternCounts.length
  ).toFixed(1)}`
);

const t0 = Date.now();
const result = generateSchedules(responders, {
  timeBudgetMs: 3000,
  avoidancePairs,
  preferredPairs,
});
console.log(`Solve time: ${Date.now() - t0}ms`);
console.log(`ok=${result.ok} validFound=${result.stats?.validFound} distinctFound=${result.stats?.distinctFound}`);

if (!result.schedules?.length) {
  console.log('NO SCHEDULES', result.errors);
} else {
  result.schedules.forEach((s) => {
    const problems = validate(s, responders);
    console.log(
      `Option ${s.rank}: valid=${s.valid} score=${s.metrics.score.toFixed(0)} high=${s.metrics.high} nonNeg=${s.metrics.nonNeg} M=${s.metrics.nightsWithMale}/${s.metrics.nightTotal}(p${s.metrics.prioNightsWithMale}/${s.metrics.prioNightTotal}) F=${s.metrics.nightsWithFemale}/${s.metrics.nightTotal}(p${s.metrics.prioNightsWithFemale}/${s.metrics.prioNightTotal}) avoid=${s.metrics.avoidanceCount} wknd2=${s.metrics.weekendDoubles} pairs=${s.metrics.preferredMatched}/${s.metrics.preferredTotal} | problems=${problems.length}`
    );
    if (problems.length) console.log('   ', problems.slice(0, 5));
  });
  const sigs = new Set(result.schedules.map((s) => JSON.stringify(s.assignment)));
  console.log(`Distinct top schedules: ${sigs.size}/${result.schedules.length}`);
}

// --- Best-effort mode: make a deliberately over-constrained roster ---------
console.log('\n=== Best-effort mode test ===');
const tightRoster = SAMPLE_RESPONDERS().slice(0, 20); // way too few people
const tightResult = generateSchedules(tightRoster, { timeBudgetMs: 2000, avoidancePairs: [] });
const tightPartial = tightResult.schedules.find((s) => !s.valid);
const reach = tightResult.reachout;
console.log(
  `Tight roster ok=${tightResult.ok} schedules=${tightResult.schedules.length} suggestions=${tightPartial?.suggestions?.gapCount || 0} singleFixes=${reach?.singleFixes.length ?? 'n/a'} multiFix=${reach ? (reach.multiFix ? 'yes' : 'no') : 'n/a'} unplaced=${reach?.unplaced.length ?? 'n/a'}`
);
if (tightPartial?.suggestions?.gaps?.length) {
  console.log('First 2 gaps (shift-by-shift asks):');
  for (const g of tightPartial.suggestions.gaps.slice(0, 2)) {
    console.log(`  ${g.label}:`);
    for (const a of g.asks) {
      console.log(`    ${a.question}`);
      for (const c of a.candidates.slice(0, 2)) console.log(`      -> ${c.name}: ${c.reason}`);
    }
  }
}
if (reach?.singleFixes.length) {
  console.log('Single-fix shifts found:');
  for (const f of reach.singleFixes) {
    console.log(`  ${f.slotLabel} (${f.needLabel}) -> unlockers: ${f.people.map((p) => p.name).join(', ')}`);
  }
}
if (reach?.multiFix) {
  console.log('Multi-fix:', reach.multiFix.asks.map((a) => `${a.person.name}->${a.slotLabel}`).join(' + '));
}

// --- Non-neg flag rules ----------------------------------------------------
function mkPrefs(map) {
  const p = {};
  for (const id of ALL_SLOTS) p[id] = map[id] || 'unavail';
  return p;
}
const flagA = nonNegotiableFlags({
  name: 'A', role: 'rookie', bilingual: false, gender: 'male', hours: 12,
  prefs: mkPrefs({
    'Mon|night': 'nonneg', 'Tue|day1': 'avail', 'Tue|day2': 'avail',
    'Wed|day1': 'avail', 'Wed|day2': 'avail', 'Thu|day1': 'avail',
  }),
});
const flagB = nonNegotiableFlags({
  name: 'B', role: 'rookie', bilingual: false, gender: 'female', hours: 12,
  prefs: mkPrefs({ 'Mon|night': 'nonneg', 'Tue|night': 'nonneg' }),
});
const flagC = nonNegotiableFlags({
  name: 'C', role: 'rookie', bilingual: false, gender: 'male', hours: 12,
  prefs: mkPrefs({ 'Mon|day1': 'nonneg', 'Mon|day2': 'avail' }),
});
console.log('\nNon-neg flag tests:');
console.log('  rule a (6h+ nonneg, >12h other):', flagA.length > 0);
console.log('  rule b (>12h nonneg):', flagB.length > 0);
console.log('  constrained responder NOT flagged:', flagC.length === 0);

// --- Rest-period rule ------------------------------------------------------
const restViolator = {
  id: 'test', name: 'Rest test', role: 'rookie', bilingual: false, gender: 'male', hours: 12,
  prefs: mkPrefs({ 'Mon|day2': 'nonneg', 'Tue|day1': 'nonneg' }),
};
const restResult = buildPatterns(restViolator);
console.log('\nRest-period rule:');
console.log('  patterns for back-to-back non-neg pair:', restResult.patterns.length, '(should be 0)');
console.log('  reason mentions rest:', /14:00-20:00/.test(restResult.reason || '') ? 'yes' : 'no');
