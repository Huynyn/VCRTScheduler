import {
  ALL_SLOTS,
  SHIFTS,
  SHIFT_BY_ID,
  parseSlot,
  PREF,
  FULL_HOURS,
  REDUCED_HOURS,
  FORBIDDEN_BACK_TO_BACK,
} from '../constants/schedule.js';

// A "pattern" is a concrete set of slots a responder could be assigned to that
// (a) totals exactly their required weekly hours,
// (b) uses only slots they are at least "available" for,
// (c) includes every slot they marked "non-negotiable", and
// (d) never pairs a 14:00-20:00 shift with the following morning's 08:00-14:00
//     (a hard rest-period rule).
//
// For a 12h responder a pattern is either a single overnight slot, or any pair
// of distinct day slots (08:00-14:00 / 14:00-20:00) across the week.
// For a 6h responder a pattern is a single day slot.
//
// Returns { patterns: string[][], reason: string|null }. When no pattern is
// possible, `reason` explains why (used by the feasibility report).

const dayShiftIds = SHIFTS.filter((s) => s.kind === 'day').map((s) => s.id);
const nightShiftId = SHIFTS.find((s) => s.kind === 'night').id;

const forbiddenPairSet = new Set(FORBIDDEN_BACK_TO_BACK.map(([a, b]) => `${a}|${b}`));

// True when the pattern contains a forbidden 14:00-20:00 -> next-morning pair.
function violatesRest(pattern) {
  for (let i = 0; i < pattern.length; i++) {
    for (let j = 0; j < pattern.length; j++) {
      if (i === j) continue;
      if (forbiddenPairSet.has(`${pattern[i]}|${pattern[j]}`)) return true;
    }
  }
  return false;
}

export function usableSlots(responder) {
  return ALL_SLOTS.filter((id) => {
    const p = responder.prefs[id];
    return p === PREF.NONNEG || p === PREF.HIGH || p === PREF.AVAIL;
  });
}

export function nonNegSlots(responder) {
  return ALL_SLOTS.filter((id) => responder.prefs[id] === PREF.NONNEG);
}

function isDaySlot(id) {
  return SHIFT_BY_ID[parseSlot(id).shift].kind === 'day';
}
function isNightSlot(id) {
  return SHIFT_BY_ID[parseSlot(id).shift].kind === 'night';
}

export function buildPatterns(responder) {
  const required = responder.hours === REDUCED_HOURS ? REDUCED_HOURS : FULL_HOURS;
  const usable = new Set(usableSlots(responder));
  const nonNeg = nonNegSlots(responder);

  const patterns = [];

  if (required === REDUCED_HOURS) {
    // Exactly one 6h day slot.
    if (nonNeg.length > 1) {
      return { patterns: [], reason: 'Has more than one non-negotiable slot but only works 6h (one day shift).' };
    }
    if (nonNeg.length === 1) {
      const id = nonNeg[0];
      if (!isDaySlot(id)) {
        return { patterns: [], reason: 'Non-negotiable slot is an overnight (12h) shift but responder only works 6h.' };
      }
      return { patterns: [[id]], reason: null };
    }
    for (const id of usable) {
      if (isDaySlot(id)) patterns.push([id]);
    }
    if (patterns.length === 0) {
      return { patterns: [], reason: 'No available 6h day shifts.' };
    }
    return { patterns, reason: null };
  }

  // 12h responder.
  const nonNegNights = nonNeg.filter(isNightSlot);
  const nonNegDays = nonNeg.filter(isDaySlot);

  if (nonNegNights.length > 1) {
    return { patterns: [], reason: 'Has more than one non-negotiable overnight shift (only one fits in 12h).' };
  }
  if (nonNegNights.length === 1 && nonNegDays.length > 0) {
    return { patterns: [], reason: 'Has a non-negotiable overnight shift plus a non-negotiable day shift (exceeds 12h).' };
  }
  if (nonNegDays.length > 2) {
    return { patterns: [], reason: 'Has more than two non-negotiable day shifts (exceeds 12h).' };
  }

  // Option A: a single overnight shift.
  if (nonNegDays.length === 0) {
    if (nonNegNights.length === 1) {
      patterns.push([nonNegNights[0]]);
    } else {
      for (const id of usable) {
        if (isNightSlot(id)) patterns.push([id]);
      }
    }
  }

  // Option B: two day shifts.
  if (nonNegNights.length === 0) {
    const usableDays = [...usable].filter(isDaySlot);
    if (nonNegDays.length === 2) {
      patterns.push([nonNegDays[0], nonNegDays[1]]);
    } else if (nonNegDays.length === 1) {
      const fixed = nonNegDays[0];
      for (const other of usableDays) {
        if (other !== fixed) patterns.push([fixed, other].sort());
      }
    } else {
      for (let i = 0; i < usableDays.length; i++) {
        for (let j = i + 1; j < usableDays.length; j++) {
          patterns.push([usableDays[i], usableDays[j]]);
        }
      }
    }
  }

  // De-duplicate patterns (same set of slots) and drop any that would put the
  // responder on a 14:00-20:00 shift followed by the next morning's 08:00-14:00.
  const seen = new Set();
  const unique = [];
  let restViolations = 0;
  for (const p of patterns) {
    const sorted = [...p].sort();
    const key = sorted.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    if (violatesRest(sorted)) {
      restViolations += 1;
      continue;
    }
    unique.push(sorted);
  }

  if (unique.length === 0) {
    // Fallback: a full 12h week can't be built, but we would rather give them a
    // single 6h day shift than bench them entirely (nobody should be missing
    // from the schedule). Only possible when no non-negotiable overnight forces
    // 12h and at most one non-negotiable day shift needs to be honoured.
    if (nonNegNights.length === 0 && nonNegDays.length <= 1) {
      const usableDays = [...usable].filter(isDaySlot);
      const fallbackDays =
        nonNegDays.length === 1 ? usableDays.filter((id) => id === nonNegDays[0]) : usableDays;
      if (fallbackDays.length > 0) {
        return { patterns: fallbackDays.map((id) => [id]), reason: null, reduced: true };
      }
    }
    // If we dropped patterns purely for the rest rule, surface that specifically.
    if (restViolations > 0 && nonNegDays.length > 0) {
      return {
        patterns: [],
        reason:
          'The only possible pattern would put them on a 14:00-20:00 shift immediately followed by the next morning\u2019s 08:00-14:00, which is not allowed.',
      };
    }
    return { patterns: [], reason: 'No combination of available shifts adds up to 12h.' };
  }
  return { patterns: unique, reason: null };
}

// Count how many of a pattern's slots are high-preference for the responder.
export function highPrefCount(responder, pattern) {
  return pattern.filter((id) => responder.prefs[id] === PREF.HIGH).length;
}
