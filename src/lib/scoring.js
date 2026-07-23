import {
  ALL_SLOTS,
  PREF,
  SHIFTS,
  parseSlot,
  MIN_PER_SHIFT,
  MAX_PER_SHIFT,
  PRIORITY_NIGHT_DAYS,
  WEEKEND_DAYS,
} from '../constants/schedule.js';
import { pairKey, makePair } from './pair.js';

const NIGHT_SHIFT_ID = SHIFTS.find((s) => s.kind === 'night').id;
const isNight = (id) => parseSlot(id).shift === NIGHT_SHIFT_ID;
const isPriorityNight = (id) =>
  isNight(id) && PRIORITY_NIGHT_DAYS.includes(parseSlot(id).day);
const isWeekendDay = (id) => {
  const { day, shift } = parseSlot(id);
  return WEEKEND_DAYS.includes(day) && shift !== NIGHT_SHIFT_ID;
};

// Positive bonuses (nice-to-haves).
const PRIORITY_NIGHT_GENDER = 250;
const GENERAL_NIGHT_GENDER = 80;

// Heavy penalties for hard-rule violations. Chosen so that a valid schedule
// always outranks any invalid one and rankings degrade gracefully as more
// things break, so the "least broken" partial schedule surfaces first.
const UNDER_MIN_PENALTY = 100000; // per person short at a shift
const MISSING_SUP_PENALTY = 60000; // per shift missing a supervisor
const MISSING_BIL_PENALTY = 60000; // per shift missing a bilingual
const OVER_MAX_PENALTY = 40000; // per person over the ceiling
const UNPLACED_PENALTY = 70000; // per responder left off the schedule entirely (< 6h)

// Soft-rule penalties (small, so honouring these is a preference not a rule).
const AVOIDANCE_PENALTY = 400; // per shift a conflicting pair shares
const WEEKEND_DOUBLE_PENALTY = 200; // per responder doing 2 weekend day shifts

// Soft-rule bonuses.
// "Schedule together" pairs: a pair counts as matched when the two share at
// least one shift (matching one of two shifts is enough). Extra shared shifts
// earn a small additional bonus.
// Worth a little more than one honoured high-preference slot (1000), so the
// solver will trade at most one person's high preference to bring a pair
// together — never coverage, roles or "keep apart" rules, which cost far more.
const PREFERRED_MATCH_BONUS = 1200; // per pair sharing >= 1 shift
const PREFERRED_EXTRA_BONUS = 60; // per additional shared shift beyond the first

// Deterministic PRNG so attempts are reproducible (mulberry32).
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Detailed issue report for an assignment. Used both for scoring and for the
// "what's still broken" summary shown to the user.
export function analyzeIssues(assignment, responders, avoidancePairs = []) {
  const byId = Object.fromEntries(responders.map((r) => [r.id, r]));

  const counts = {};
  const supBy = {};
  const bilBy = {};
  for (const id of ALL_SLOTS) {
    counts[id] = 0;
    supBy[id] = 0;
    bilBy[id] = 0;
  }
  for (const [rid, slots] of Object.entries(assignment)) {
    const r = byId[rid];
    if (!r) continue;
    for (const id of slots) {
      counts[id] += 1;
      if (r.role === 'supervisor') supBy[id] += 1;
      if (r.bilingual) bilBy[id] += 1;
    }
  }

  const underMin = [];
  const overMax = [];
  const missingSup = [];
  const missingBil = [];
  let peopleShort = 0;
  let peopleOver = 0;

  for (const id of ALL_SLOTS) {
    if (counts[id] < MIN_PER_SHIFT) {
      underMin.push({ slot: id, have: counts[id], need: MIN_PER_SHIFT });
      peopleShort += MIN_PER_SHIFT - counts[id];
    }
    if (counts[id] > MAX_PER_SHIFT) {
      overMax.push({ slot: id, have: counts[id] });
      peopleOver += counts[id] - MAX_PER_SHIFT;
    }
    if (supBy[id] === 0) missingSup.push(id);
    if (bilBy[id] === 0) missingBil.push(id);
  }

  // Avoidance-pair overlaps: how many shifts each conflicting pair share.
  const pairSet = new Set(avoidancePairs.map((p) => pairKey(makePair(p[0], p[1]))));
  const avoidanceViolations = [];
  if (pairSet.size > 0) {
    // Build slot -> set of responder ids so we can spot pair overlaps.
    const slotMembers = {};
    for (const id of ALL_SLOTS) slotMembers[id] = new Set();
    for (const [rid, slots] of Object.entries(assignment)) {
      for (const id of slots) slotMembers[id].add(rid);
    }
    const perPair = new Map();
    for (const id of ALL_SLOTS) {
      const arr = [...slotMembers[id]];
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const key = pairKey(makePair(arr[i], arr[j]));
          if (!pairSet.has(key)) continue;
          if (!perPair.has(key)) perPair.set(key, { pair: makePair(arr[i], arr[j]), slots: [] });
          perPair.get(key).slots.push(id);
        }
      }
    }
    for (const entry of perPair.values()) avoidanceViolations.push(entry);
  }

  // Weekend doubles: 12h responders whose two shifts are both weekend day shifts.
  const weekendDoubles = [];
  for (const [rid, slots] of Object.entries(assignment)) {
    if (slots.length < 2) continue;
    if (slots.every(isWeekendDay)) weekendDoubles.push(rid);
  }

  return {
    underMin,
    overMax,
    missingSup,
    missingBil,
    peopleShort,
    peopleOver,
    avoidanceViolations,
    weekendDoubles,
  };
}

// Count, for each declared pair, how many shifts the two responders share.
// Returns [{ pair, shared }] in the same order as `pairs`.
export function pairOverlaps(assignment, pairs = []) {
  return pairs.map(([a, b]) => {
    const slotsA = new Set(assignment[a] || []);
    const shared = (assignment[b] || []).filter((id) => slotsA.has(id)).length;
    return { pair: makePair(a, b), shared };
  });
}

// Tally how well a completed assignment satisfies preferences AND how many hard
// rules it breaks. Returns a rich metrics object; higher score = better.
export function evaluate(assignment, responders, avoidancePairs = [], preferredPairs = []) {
  const byId = Object.fromEntries(responders.map((r) => [r.id, r]));
  let high = 0;
  let avail = 0;
  let nonNeg = 0;
  let withHigh = 0;

  for (const r of responders) {
    const slots = assignment[r.id] || [];
    let gotHigh = false;
    for (const id of slots) {
      const p = r.prefs[id];
      if (p === PREF.NONNEG) nonNeg += 1;
      else if (p === PREF.HIGH) {
        high += 1;
        gotHigh = true;
      } else if (p === PREF.AVAIL) avail += 1;
    }
    if (gotHigh) withHigh += 1;
  }

  // Overnight gender coverage (soft rule).
  const maleBySlot = {};
  const femaleBySlot = {};
  for (const [rid, slots] of Object.entries(assignment)) {
    const g = byId[rid]?.gender;
    if (g !== 'male' && g !== 'female') continue;
    const target = g === 'male' ? maleBySlot : femaleBySlot;
    for (const id of slots) target[id] = (target[id] || 0) + 1;
  }
  const nightSlots = ALL_SLOTS.filter(isNight);
  const prioNightSlots = nightSlots.filter(isPriorityNight);
  const nightsWithMale = nightSlots.filter((id) => (maleBySlot[id] || 0) > 0).length;
  const prioNightsWithMale = prioNightSlots.filter((id) => (maleBySlot[id] || 0) > 0).length;
  const nightsWithFemale = nightSlots.filter((id) => (femaleBySlot[id] || 0) > 0).length;
  const prioNightsWithFemale = prioNightSlots.filter((id) => (femaleBySlot[id] || 0) > 0).length;

  const genderBonus = (prio, total) =>
    prio * PRIORITY_NIGHT_GENDER + (total - prio) * GENERAL_NIGHT_GENDER;
  const coverageBonus =
    genderBonus(prioNightsWithMale, nightsWithMale) +
    genderBonus(prioNightsWithFemale, nightsWithFemale);

  // Issues (hard + soft violations).
  const issues = analyzeIssues(assignment, responders, avoidancePairs);
  const avoidanceCount = issues.avoidanceViolations.reduce((s, v) => s + v.slots.length, 0);

  // Everyone should get at least one shift (>= 6h). Anyone left off entirely is
  // a hard problem: a complete schedule has no one benched.
  const unplacedIds = responders
    .filter((r) => !assignment[r.id] || assignment[r.id].length === 0)
    .map((r) => r.id);
  const unplaced = unplacedIds.length;

  // "Schedule together" pairs (soft, nice-to-have).
  const overlaps = pairOverlaps(assignment, preferredPairs);
  const preferredMatched = overlaps.filter((o) => o.shared > 0).length;
  const preferredExtraShared = overlaps.reduce(
    (s, o) => s + Math.max(0, o.shared - 1),
    0
  );

  // Spread of shift sizes (tie-breaker only).
  const countsArr = ALL_SLOTS.map((id) => {
    let c = 0;
    for (const [, slots] of Object.entries(assignment)) if (slots.includes(id)) c += 1;
    return c;
  });
  const mean = countsArr.reduce((s, c) => s + c, 0) / countsArr.length;
  const variance = countsArr.reduce((s, c) => s + (c - mean) ** 2, 0) / countsArr.length;

  const score =
    high * 1000 +
    withHigh * 100 +
    coverageBonus +
    avail * 1 +
    preferredMatched * PREFERRED_MATCH_BONUS +
    preferredExtraShared * PREFERRED_EXTRA_BONUS -
    variance * 0.5 -
    issues.peopleShort * UNDER_MIN_PENALTY -
    issues.missingSup.length * MISSING_SUP_PENALTY -
    issues.missingBil.length * MISSING_BIL_PENALTY -
    issues.peopleOver * OVER_MAX_PENALTY -
    unplaced * UNPLACED_PENALTY -
    avoidanceCount * AVOIDANCE_PENALTY -
    issues.weekendDoubles.length * WEEKEND_DOUBLE_PENALTY;

  const valid =
    issues.peopleShort === 0 &&
    issues.peopleOver === 0 &&
    issues.missingSup.length === 0 &&
    issues.missingBil.length === 0 &&
    unplaced === 0;

  return {
    score,
    valid,
    high,
    avail,
    nonNeg,
    withHigh,
    variance,
    nightsWithMale,
    nightsWithFemale,
    nightTotal: nightSlots.length,
    prioNightsWithMale,
    prioNightsWithFemale,
    prioNightTotal: prioNightSlots.length,
    avoidanceCount,
    weekendDoubles: issues.weekendDoubles.length,
    preferredMatched,
    preferredTotal: preferredPairs.length,
    preferredOverlaps: overlaps,
    unplaced,
    unplacedIds,
    issues,
  };
}

// Stable signature so we can de-duplicate identical schedules.
export function signature(assignment) {
  return Object.keys(assignment)
    .sort()
    .map((id) => `${id}:${[...assignment[id]].sort().join('+')}`)
    .join('|');
}
