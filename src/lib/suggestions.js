import {
  ALL_SLOTS,
  DAYS,
  SHIFTS,
  SHIFT_BY_ID,
  parseSlot,
  slotId,
  PREF,
  FULL_HOURS,
  REDUCED_HOURS,
} from '../constants/schedule.js';

const NIGHT_SHIFT_ID = SHIFTS.find((s) => s.kind === 'night').id;
const isNight = (id) => parseSlot(id).shift === NIGHT_SHIFT_ID;

const shiftLabel = (id) => {
  const { day, shift } = parseSlot(id);
  return `${day} ${SHIFT_BY_ID[shift].label}`;
};

// Duration (hours) of a single slot, and a responder's weekly-hours target.
const slotHours = (id) => SHIFT_BY_ID[parseSlot(id).shift].hours;
const targetHours = (r) => (r.hours === REDUCED_HOURS ? REDUCED_HOURS : FULL_HOURS);

// Slots one calendar day before/after the target slot (any shift), used to
// judge how "close" someone's existing availability is to a gap.
function nearbySlots(target) {
  const { day } = parseSlot(target);
  const dIdx = DAYS.indexOf(day);
  const days = [];
  if (dIdx > 0) days.push(DAYS[dIdx - 1]);
  days.push(day);
  if (dIdx < DAYS.length - 1) days.push(DAYS[dIdx + 1]);
  const out = [];
  for (const d of days) for (const s of SHIFTS) out.push(slotId(d, s.id));
  return out;
}

const isAvail = (r, id) => r.prefs[id] === PREF.AVAIL || r.prefs[id] === PREF.HIGH;

// How many hours of the responder's week are already assigned in THIS schedule.
// A person a full pattern (12h) has no room left, so asking them to open up
// another slot would push them over their weekly cap — we never do that.
function assignedHoursMap(schedule, responders) {
  const m = {};
  for (const r of responders) {
    const pattern = schedule.assignment?.[r.id] || [];
    m[r.id] = pattern.reduce((s, id) => s + slotHours(id), 0);
  }
  return m;
}

// Plain-language reason a specific responder is a good ask for a slot. Always
// framed around AVAILABILITY only, and only ever suggested when they have the
// unused weekly hours to actually take the shift.
function reasonPhrase(responder, slot, remaining) {
  const sh = slotHours(slot);
  const near = nearbySlots(slot).filter((id) => id !== slot && isAvail(responder, id));
  if (near.length > 0) {
    return `Already available ${shiftLabel(near[0])}; this ${sh}h shift fits their ${remaining}h of unused time.`;
  }
  return `Has ${remaining}h of unused availability this week — room for this ${sh}h shift.`;
}

// Weights for the person-level "who to contact" impact ranking. A missing
// supervisor is the hardest gap to substitute, then a missing bilingual, then a
// plain head-count shortfall. Only availability can be asked for — a responder
// only counts toward a role gap when they ALREADY hold that fixed attribute
// (supervisor role, bilingual), so this list never implies changing someone's
// designation, languages spoken or gender.
const IMPACT_SUP = 100; // this responder could cover a missing-supervisor shift
const IMPACT_BIL = 80; // ...a missing-bilingual shift
const IMPACT_PEOPLE = 40; // ...a shift that is simply short of the minimum
const IMPACT_PROXIMITY = 5; // per nearby slot they are already available for (max 3)

// Given a (partial) schedule, rank the roster by how much a change to *their
// availability* would help. Returns people sorted most-impactful first, each
// with the specific gaps they could unlock and a plain-language summary. This is
// the "if you reach out to this person and they open up more availability, these
// things could change" list.
//
// Crucially, a person's impact is capped by the hours they have LEFT in their
// week: if they already work their full 12h, they are dropped entirely, and
// otherwise we only count as many gap shifts as fit in their remaining hours.
function buildImpactRanking(gapMap, responders, assigned) {
  const people = [];
  for (const r of responders) {
    const remaining = targetHours(r) - (assigned[r.id] || 0);
    if (remaining <= 0) continue; // already at their weekly hours — can't help without overloading them

    // Every gap slot they could take: right fixed attributes, currently
    // unavailable (so opening it is a real change), and short enough to fit
    // their remaining hours.
    const candidateGaps = [];
    for (const [slot, need] of gapMap.entries()) {
      if (r.prefs[slot] !== PREF.UNAVAIL) continue;
      const sh = slotHours(slot);
      if (sh > remaining) continue;

      const matched = [];
      let w = 0;
      if (need.sup && r.role === 'supervisor') {
        w += IMPACT_SUP;
        matched.push('sup');
      }
      if (need.bil && r.bilingual) {
        w += IMPACT_BIL;
        matched.push('bil');
      }
      if (need.people > 0) {
        w += IMPACT_PEOPLE;
        matched.push('people');
      }
      if (w === 0) continue; // their fixed attributes don't fit any need here

      const near = nearbySlots(slot).filter((id) => id !== slot && isAvail(r, id)).length;
      w += Math.min(near, 3) * IMPACT_PROXIMITY;
      candidateGaps.push({ slot, label: shiftLabel(slot), sh, w, matched });
    }
    if (candidateGaps.length === 0) continue;

    // Greedily fill their unused hours with the highest-value gaps first, so the
    // impact reflects what they could ACTUALLY take on — never more than their
    // weekly hours allow.
    candidateGaps.sort((a, b) => b.w - a.w);
    let hoursLeft = remaining;
    let impact = 0;
    let supGaps = 0;
    let bilGaps = 0;
    let peopleGaps = 0;
    const unlocks = [];
    for (const g of candidateGaps) {
      if (g.sh > hoursLeft) continue;
      hoursLeft -= g.sh;
      impact += g.w;
      unlocks.push({ slot: g.slot, label: g.label, needs: g.matched });
      if (g.matched.includes('sup')) supGaps += 1;
      if (g.matched.includes('bil')) bilGaps += 1;
      if (g.matched.includes('people')) peopleGaps += 1;
      if (hoursLeft <= 0) break;
    }
    if (impact <= 0) continue;

    const parts = [];
    if (supGaps) parts.push(`${supGaps} missing-supervisor shift${supGaps === 1 ? '' : 's'}`);
    if (bilGaps) parts.push(`${bilGaps} missing-bilingual shift${bilGaps === 1 ? '' : 's'}`);
    if (peopleGaps) parts.push(`${peopleGaps} short-staffed shift${peopleGaps === 1 ? '' : 's'}`);
    const summary = `With ${remaining}h of unused availability this week, opening up could help cover ${parts.join(
      ', '
    )}.`;

    people.push({
      id: r.id,
      name: r.name,
      role: r.role,
      bilingual: r.bilingual,
      gender: r.gender,
      remaining,
      impact,
      supGaps,
      bilGaps,
      peopleGaps,
      unlocks,
      summary,
    });
  }

  people.sort((a, b) => b.impact - a.impact || a.name.localeCompare(b.name));
  return people;
}

// The four ways a gap can be filled, phrased as the exact question to put to the
// roster. The candidate pool for each only ever contains people who ALREADY hold
// the required fixed attributes — we can ask them to change their availability,
// never their role, languages or gender.
const ASK_META = {
  bilsup: {
    question: 'Can one of these bilingual supervisors fill this shift?',
    filter: (r) => r.role === 'supervisor' && r.bilingual,
  },
  sup: {
    question: 'Can one of these supervisors take this shift?',
    filter: (r) => r.role === 'supervisor',
  },
  bil: {
    question: 'Can one of these bilingual supervisors or rookies fill this shift?',
    filter: (r) => r.bilingual,
  },
  anyone: {
    question: 'Can one of these supervisors or rookies fill this shift?',
    filter: () => true,
  },
};

// Given the best partial schedule, produce a prioritised list of "who to
// contact for extra availability" suggestions, plus a person-level impact
// ranking (most impactful availability change first). Softest rules (avoidance,
// weekend doubles, overnight gender mix) are treated as nice-to-haves and are
// not reported as gaps here — this list is strictly for the hard-rule gaps that
// keep the schedule from being valid.
export function buildSuggestions(schedule, responders, avoidancePairs, patternMap) {
  if (!schedule) return { gapCount: 0, gaps: [], people: [] };

  const gaps = [];
  const assigned = assignedHoursMap(schedule, responders);
  const issues = schedule.metrics.issues;

  // Union of every shift with any hard-rule problem, with the specific needs.
  const gapMap = new Map(); // slot -> { people, sup, bil }
  for (const g of issues.underMin) {
    if (!gapMap.has(g.slot)) gapMap.set(g.slot, { people: 0, sup: false, bil: false });
    gapMap.get(g.slot).people = g.need - g.have;
  }
  for (const id of issues.missingSup) {
    if (!gapMap.has(id)) gapMap.set(id, { people: 0, sup: false, bil: false });
    gapMap.get(id).sup = true;
  }
  for (const id of issues.missingBil) {
    if (!gapMap.has(id)) gapMap.set(id, { people: 0, sup: false, bil: false });
    gapMap.get(id).bil = true;
  }

  // Priority order for tackling gaps: missing supervisor > missing bilingual >
  // under-min. This mirrors what's hardest to substitute.
  const gapEntries = [...gapMap.entries()].sort((a, b) => {
    const [, ga] = a;
    const [, gb] = b;
    const sa = (ga.sup ? 100 : 0) + (ga.bil ? 50 : 0) + ga.people * 10;
    const sb = (gb.sup ? 100 : 0) + (gb.bil ? 50 : 0) + gb.people * 10;
    return sb - sa;
  });

  // Candidates for a given ask on a given slot: currently unavailable for it
  // (so we're asking them to open up), with the unused weekly hours to take the
  // shift, and holding the required fixed attribute.
  const gatherCandidates = (slot, filterFn) => {
    const sh = slotHours(slot);
    return responders
      .filter((r) => r.prefs[slot] === PREF.UNAVAIL)
      .filter((r) => targetHours(r) - (assigned[r.id] || 0) >= sh)
      .filter(filterFn)
      .map((r) => ({
        r,
        remaining: targetHours(r) - (assigned[r.id] || 0),
        near: nearbySlots(slot).filter((id) => id !== slot && isAvail(r, id)).length,
      }))
      .sort((a, b) => b.near - a.near || b.remaining - a.remaining || a.r.name.localeCompare(b.r.name))
      .slice(0, 4)
      .map(({ r, remaining }) => ({
        id: r.id,
        name: r.name,
        role: r.role,
        bilingual: r.bilingual,
        reason: reasonPhrase(r, slot, remaining),
      }));
  };

  for (const [slot, need] of gapEntries) {
    const asks = [];
    const addAsk = (kind) => {
      const meta = ASK_META[kind];
      asks.push({ kind, question: meta.question, candidates: gatherCandidates(slot, meta.filter) });
    };

    // A shift missing BOTH a supervisor and a bilingual is best solved by one
    // bilingual supervisor; otherwise ask for each missing attribute on its own.
    if (need.sup && need.bil) {
      addAsk('bilsup');
    } else {
      if (need.sup) addAsk('sup');
      if (need.bil) addAsk('bil');
    }
    if (need.people > 0) addAsk('anyone');

    gaps.push({ slot, label: shiftLabel(slot), asks });
  }

  const people = buildImpactRanking(gapMap, responders, assigned);

  return { gapCount: gaps.length, gaps, people };
}
