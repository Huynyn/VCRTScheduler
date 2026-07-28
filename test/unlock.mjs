// Tests for the reworked scheduler:
//   1. Keep-apart is a HARD rule (a valid schedule never seats a keep-apart pair
//      together), and when keep-apart is the sole thing making the week
//      impossible, generateSchedules reports which pair to reconsider plus the
//      complete schedule that relaxing it unlocks.
//   2. "Make a complete schedule possible" carries, for a single-shift gap, EACH
//      unlocker's own resulting schedule (so the UI can let the coordinator click
//      between people), and every one is a valid, distinct week.
//   3. It handles MULTIPLE gaps needing MULTIPLE different people's availability
//      (the multi-fix path).
//
// Run: node test/unlock.mjs
import { SAMPLE_RESPONDERS } from '../src/data/sampleData.js';
import { generateSchedules } from '../src/lib/scheduler.js';
import { ALL_SLOTS, PREF, slotId } from '../src/constants/schedule.js';

let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures += 1;
};

const fullPrefs = () => Object.fromEntries(ALL_SLOTS.map((id) => [id, PREF.AVAIL]));
const emptyPrefs = () => Object.fromEntries(ALL_SLOTS.map((id) => [id, PREF.UNAVAIL]));

// Keep exactly two available people at `slot` — a bilingual supervisor (covers
// both role needs) plus one other — so the shift has sup + bil but is one head
// short of the minimum. Everyone else becomes unavailable there.
function makeShortByOne(responders, slot) {
  // "Present" = anyone the slot could hold: available, high-pref, OR
  // non-negotiable (a non-negotiable forces them onto the slot, so it must be
  // cleared too, or the shift won't actually be short).
  const present = (r) => r.prefs[slot] !== PREF.UNAVAIL;
  const bilSup = responders.find((r) => present(r) && r.role === 'supervisor' && r.bilingual);
  const other = responders.find((r) => present(r) && r !== bilSup);
  const keep = new Set([bilSup?.id, other?.id]);
  for (const r of responders) {
    if (present(r) && !keep.has(r.id)) r.prefs = { ...r.prefs, [slot]: PREF.UNAVAIL };
  }
}

// ---------------------------------------------------------------------------
console.log('\n[1] Keep-apart is a hard rule + blocker message');
{
  const responders = SAMPLE_RESPONDERS();
  // Two reduced (6h) rookies whose only feasible pattern is the same day shift.
  // Keeping them apart is impossible -> keep-apart is the sole blocker, but the
  // rest of the roster stays solvable.
  const pin = (r) => ({
    ...r,
    role: 'rookie',
    bilingual: false,
    hours: 6,
    prefs: { ...emptyPrefs(), 'Mon|day1': PREF.NONNEG },
  });
  const i0 = responders.findIndex((r) => r.id === 'sample_44');
  const i1 = responders.findIndex((r) => r.id === 'sample_45');
  responders[i0] = pin(responders[i0]);
  responders[i1] = pin(responders[i1]);
  const avoidancePairs = [['sample_44', 'sample_45']];

  const res = generateSchedules(responders, {
    timeBudgetMs: 4000,
    reachoutBudgetMs: 12000,
    avoidancePairs,
  });

  check('no complete schedule as-is (ok=false)', res.ok === false);
  check('apartBlock is reported', !!res.apartBlock);
  check('culpable pair identified', res.apartBlock?.pairs?.some(
    (p) => (p.a === 'sample_44' && p.b === 'sample_45') || (p.a === 'sample_45' && p.b === 'sample_44')
  ));
  check('relaxing the rule unlocks a valid schedule', res.apartBlock?.schedule?.valid === true);
  const together = res.schedules.filter((s) => {
    if (!s.valid) return false;
    const a = new Set(s.assignment['sample_44'] || []);
    return (s.assignment['sample_45'] || []).some((x) => a.has(x));
  }).length;
  check('no valid schedule ever seats the apart-pair together', together === 0);
}

// ---------------------------------------------------------------------------
console.log('\n[2] Single-shift gap: each unlocker carries its own valid schedule');
{
  const responders = SAMPLE_RESPONDERS();
  for (let i = 0; i < 4; i++)
    responders.push({ id: `xsup${i}`, name: `Extra Sup ${i}`, role: 'supervisor', bilingual: true, gender: i % 2 ? 'male' : 'female', hours: 12, prefs: fullPrefs() });

  const gap = slotId('Sat', 'day1');
  makeShortByOne(responders, gap);
  // Three 6h rookies, each normally placed on their own separate day shift and
  // unavailable for the gap. Any ONE could instead open the gap to complete it.
  [slotId('Mon', 'day1'), slotId('Tue', 'day1'), slotId('Wed', 'day1')].forEach((home, i) =>
    responders.push({ id: `sp${i}`, name: `Spare ${i}`, role: 'rookie', bilingual: false, gender: 'female', hours: 6, prefs: { ...emptyPrefs(), [home]: PREF.AVAIL } })
  );

  const res = generateSchedules(responders, { timeBudgetMs: 5000, reachoutBudgetMs: 30000, avoidancePairs: [] });
  const fix = res.reachout?.singleFixes?.[0];
  check('a single-shift fix is offered', !!fix);
  check('it lists multiple interchangeable unlockers', (fix?.people?.length || 0) >= 3);
  check('every unlocker carries its OWN valid schedule', !!fix && fix.people.every((p) => p.schedule?.valid));
  check('each unlocker actually appears on the opened shift', !!fix && fix.people.every((p) => (p.schedule?.slots?.[fix.slot] || []).some((x) => x.id === p.id)));
  const distinct = fix ? new Set(fix.people.map((p) => JSON.stringify(p.schedule.assignment))).size : 0;
  check('the shown schedules genuinely differ per person', !!fix && distinct === fix.people.length);
}

// ---------------------------------------------------------------------------
console.log('\n[3] Multiple gaps needing multiple different availabilities (multi-fix)');
{
  const responders = SAMPLE_RESPONDERS();
  for (let i = 0; i < 6; i++)
    responders.push({ id: `xsup${i}`, name: `Extra Sup ${i}`, role: 'supervisor', bilingual: true, gender: i % 2 ? 'male' : 'female', hours: 12, prefs: fullPrefs() });

  const targets = [slotId('Sat', 'day1'), slotId('Sun', 'day1')];
  targets.forEach((t) => makeShortByOne(responders, t));
  // Two spare 6h rookies with no base availability: completing the week needs
  // BOTH to open a DIFFERENT one of the two short (6h day) shifts. Being 6h,
  // one day shift fully meets each one's commitment.
  responders.push(
    { id: 'spA', name: 'Spare Alpha', role: 'rookie', bilingual: false, gender: 'male', hours: 6, prefs: emptyPrefs() },
    { id: 'spB', name: 'Spare Bravo', role: 'rookie', bilingual: false, gender: 'female', hours: 6, prefs: emptyPrefs() }
  );

  const res = generateSchedules(responders, { timeBudgetMs: 5000, reachoutBudgetMs: 30000, avoidancePairs: [] });
  const mf = res.reachout?.multiFix;
  check('a multi-change fix is found', !!mf);
  check('it asks two different people', mf && new Set(mf.asks.map((a) => a.person.id)).size === 2);
  check('for two different shifts', mf && new Set(mf.asks.map((a) => a.slot)).size === 2);
  check('and the combined change yields a valid schedule', mf?.schedule?.valid === true);
}

// ---------------------------------------------------------------------------
console.log('\n[4] A fix never puts a 12h person on only 6h (respects committed hours)');
{
  const responders = SAMPLE_RESPONDERS();
  for (let i = 0; i < 4; i++)
    responders.push({ id: `xsup${i}`, name: `Extra Sup ${i}`, role: 'supervisor', bilingual: true, gender: i % 2 ? 'male' : 'female', hours: 12, prefs: fullPrefs() });
  const gap = slotId('Sat', 'day2');
  makeShortByOne(responders, gap);
  // A 12h rookie who normally works one overnight (Wed) and is unavailable for
  // the day gap. If asked to open the gap, the only week they could form is that
  // single 6h day shift — which breaks their 12h commitment — so the fix must NOT
  // offer them. This is exactly the reported bug.
  responders.push({ id: 'only6', name: 'Only Sixer', role: 'rookie', bilingual: false, gender: 'male', hours: 12, prefs: { ...emptyPrefs(), [slotId('Wed', 'night')]: PREF.AVAIL } });
  // A legitimate fixer: a 6h rookie normally on another day shift who can move to
  // the gap and still meet their (6h) commitment.
  responders.push({ id: 'ok6', name: 'Okay Sixer', role: 'rookie', bilingual: false, gender: 'female', hours: 6, prefs: { ...emptyPrefs(), [slotId('Mon', 'day2')]: PREF.AVAIL } });

  const res = generateSchedules(responders, { timeBudgetMs: 5000, reachoutBudgetMs: 30000, avoidancePairs: [] });
  const fix = res.reachout?.singleFixes?.[0];
  const mf = res.reachout?.multiFix;
  const fixSchedules = [...(fix?.people?.map((p) => p.schedule) || []), mf?.schedule].filter(Boolean);

  const hoursWorked = (sched, r) =>
    (sched.assignment[r.id] || []).reduce((s, id) => s + (id.endsWith('night') ? 12 : 6), 0);

  check('a legitimate fix is still offered', fixSchedules.length > 0);
  check('every offered fix schedule is fully valid', fixSchedules.every((s) => s.valid));
  // The crux: in every offered fix, no 12h responder is scheduled below 12h.
  const twelve = responders.filter((r) => r.hours !== 6);
  const respectsHours = fixSchedules.every((sched) =>
    twelve.every((r) => {
      const h = hoursWorked(sched, r);
      return h === 0 || h >= 12; // placed people must hit 12h (0 = benched, disallowed too, but validity covers it)
    })
  );
  check('no offered fix schedules any 12h person at only 6h', respectsHours);
  // The 12h "Only Sixer" (only available at the gap) is never offered as an
  // unlocker, because opening one 6h shift can't give them a legal 12h week.
  const offeredOnly6 =
    (fix?.people || []).some((p) => p.id === 'only6') ||
    (mf?.asks || []).some((a) => a.person.id === 'only6');
  check('the un-completable 12h fixer is not offered', !offeredOnly6);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
