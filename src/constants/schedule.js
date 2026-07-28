// ---------------------------------------------------------------------------
// Domain constants for the VCRT weekly schedule.
// Everything else (solver, UI, PDF) derives from the definitions here, so the
// model can be extended by editing this single file.
// ---------------------------------------------------------------------------

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const DAY_LABELS = {
  Mon: 'Monday',
  Tue: 'Tuesday',
  Wed: 'Wednesday',
  Thu: 'Thursday',
  Fri: 'Friday',
  Sat: 'Saturday',
  Sun: 'Sunday',
};

// The three daily shift blocks. Two 6h day blocks + one 12h overnight block.
export const SHIFTS = [
  { id: 'day1', label: '08:00 – 14:00', short: 'Morning', hours: 6, kind: 'day' },
  { id: 'day2', label: '14:00 – 20:00', short: 'Afternoon', hours: 6, kind: 'day' },
  { id: 'night', label: '20:00 – 08:00', short: 'Overnight', hours: 12, kind: 'night' },
];

export const SHIFT_BY_ID = Object.fromEntries(SHIFTS.map((s) => [s.id, s]));

// A "slot" is one shift on one day, e.g. "Mon|day1".
export const slotId = (day, shift) => `${day}|${shift}`;
export const parseSlot = (id) => {
  const [day, shift] = id.split('|');
  return { day, shift };
};

// All 21 slots in the week, in display order.
export const ALL_SLOTS = DAYS.flatMap((day) =>
  SHIFTS.map((s) => slotId(day, s.id))
);

// Coverage rules per shift.
export const MIN_PER_SHIFT = 3;
export const MAX_PER_SHIFT = 4;

// Weekly hour requirements.
export const FULL_HOURS = 12;
export const REDUCED_HOURS = 6;

// Responder roles.
export const ROLES = [
  { id: 'supervisor', label: 'Supervisor' },
  { id: 'returner', label: 'Returner' },
  { id: 'rookie', label: 'Rookie' },
];
export const ROLE_LABELS = Object.fromEntries(ROLES.map((r) => [r.id, r.label]));

// Responder gender. Used only for the soft overnight-coverage rule below
// (every overnight shift should ideally have at least one male responder).
export const GENDERS = [
  { id: 'unspecified', label: 'Prefer not to say' },
  { id: 'male', label: 'Male' },
  { id: 'female', label: 'Female' },
  { id: 'other', label: 'Other' },
];
export const GENDER_LABELS = Object.fromEntries(GENDERS.map((g) => [g.id, g.label]));

// Weekend days (used by the "avoid two weekend day shifts" soft rule).
export const WEEKEND_DAYS = ['Sat', 'Sun'];

// Hard rule: no responder may work a 14:00-20:00 shift followed by an
// 08:00-14:00 the next morning (only ~12 hours off, most of it commute + sleep).
// Enumerated pairs, no Sunday->Monday wraparound within a single week.
export const FORBIDDEN_BACK_TO_BACK = (() => {
  const pairs = [];
  for (let i = 0; i < DAYS.length - 1; i++) {
    pairs.push([`${DAYS[i]}|day2`, `${DAYS[i + 1]}|day1`]);
  }
  return pairs;
})();

// Soft rule: overnight shifts should have >= 1 male AND >= 1 female responder.
// It is "nice to have" on any night but a priority on Thursday, Friday and the
// weekend.
export const NIGHT_MALE_TARGET = 1;
export const NIGHT_FEMALE_TARGET = 1;
export const PRIORITY_NIGHT_DAYS = ['Thu', 'Fri', 'Sat', 'Sun'];

// Soft rule on non-negotiables: a responder should mark a slot non-negotiable
// only when their availability is genuinely constrained. We flag a responder if
//   - their non-negotiable hours alone exceed a normal week (NONNEG_HOURS_LIMIT), or
//   - they have a meaningful block of non-negotiables (>= NONNEG_FLAG_TRIGGER)
//     yet still list more than OTHER_AVAIL_HOURS_LIMIT hours of *other*
//     availability (i.e. they clearly had other options).
export const NONNEG_HOURS_LIMIT = 12;
export const NONNEG_FLAG_TRIGGER = 6;
export const OTHER_AVAIL_HOURS_LIMIT = 12;

// Preference levels for each slot, ordered strongest -> weakest.
// "unavail" is the implicit default for any slot not set by the responder.
export const PREF = {
  NONNEG: 'nonneg',
  HIGH: 'high',
  AVAIL: 'avail',
  UNAVAIL: 'unavail',
};

export const PREF_META = {
  [PREF.NONNEG]: {
    label: 'Non-negotiable',
    short: 'Non-neg',
    weight: 1000, // forced assignment
    color: 'bg-danger-500',
    textColor: 'text-white',
    ring: 'ring-danger-500',
    desc: 'Must be scheduled for this slot.',
  },
  [PREF.HIGH]: {
    label: 'High preference',
    short: 'High',
    weight: 10,
    color: 'bg-primary-500',
    textColor: 'text-white',
    ring: 'ring-primary-500',
    desc: 'Strongly prefers this slot.',
  },
  [PREF.AVAIL]: {
    label: 'Available',
    short: 'Avail',
    weight: 1,
    color: 'bg-success-500',
    textColor: 'text-white',
    ring: 'ring-success-500',
    desc: 'Can work this slot if needed.',
  },
  [PREF.UNAVAIL]: {
    label: 'Not available',
    short: '—',
    weight: 0,
    color: 'bg-gray-100',
    textColor: 'text-gray-400',
    ring: 'ring-gray-300',
    desc: 'Cannot work this slot.',
  },
};

// Cycle order used when a preference cell is clicked in the grid.
export const PREF_CYCLE = [PREF.UNAVAIL, PREF.AVAIL, PREF.HIGH, PREF.NONNEG];
