import {
  ALL_SLOTS,
  SHIFT_BY_ID,
  parseSlot,
  PREF,
  NONNEG_HOURS_LIMIT,
  NONNEG_FLAG_TRIGGER,
  OTHER_AVAIL_HOURS_LIMIT,
} from '../constants/schedule.js';

const slotHours = (id) => SHIFT_BY_ID[parseSlot(id).shift].hours;

// Tally the weekly hours a responder has marked at each preference level.
export function preferenceHours(responder) {
  let nonNeg = 0;
  let high = 0;
  let avail = 0;
  for (const id of ALL_SLOTS) {
    const h = slotHours(id);
    switch (responder.prefs[id]) {
      case PREF.NONNEG:
        nonNeg += h;
        break;
      case PREF.HIGH:
        high += h;
        break;
      case PREF.AVAIL:
        avail += h;
        break;
      default:
        break;
    }
  }
  // "Other availability" = everything they offered that isn't a non-negotiable.
  return { nonNeg, high, avail, other: high + avail };
}

// Soft flags about how a responder used non-negotiables. These never block a
// schedule from being generated — they prompt the coordinator to double-check
// that the non-negotiables are genuinely necessary.
//
// Returns string[] (empty when nothing is off).
export function nonNegotiableFlags(responder) {
  const flags = [];
  const { nonNeg, other } = preferenceHours(responder);

  if (nonNeg > NONNEG_HOURS_LIMIT) {
    flags.push(
      `${nonNeg}h marked non-negotiable — that already exceeds a ${NONNEG_HOURS_LIMIT}h week, so they can't all be honoured. Keep only the shifts that are truly mandatory.`
    );
  } else if (nonNeg >= NONNEG_FLAG_TRIGGER && other > OTHER_AVAIL_HOURS_LIMIT) {
    flags.push(
      `Has ${nonNeg}h non-negotiable but also ${other}h of other availability. Non-negotiables are meant for responders with no other option — consider lowering some to "high preference".`
    );
  }

  return flags;
}

export function hasNonNegotiableFlag(responder) {
  return nonNegotiableFlags(responder).length > 0;
}
