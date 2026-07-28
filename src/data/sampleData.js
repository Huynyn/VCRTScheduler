import {
  ALL_SLOTS,
  DAYS,
  SHIFTS,
  SHIFT_BY_ID,
  slotId,
  parseSlot,
  PREF,
  FULL_HOURS,
  REDUCED_HOURS,
} from '../constants/schedule.js';
import { makeRng } from '../lib/scoring.js';

const FIRST = [
  'Olivier', 'Émilie', 'Liam', 'Sophie', 'Noah', 'Camille', 'Ethan', 'Chloé',
  'Lucas', 'Maya', 'Jacob', 'Léa', 'Aiden', 'Zoé', 'Gabriel', 'Aaliyah',
  'William', 'Charlotte', 'Mathis', 'Amélie', 'Owen', 'Sarah', 'Felix', 'Anaïs',
  'Nathan', 'Hannah', 'Samuel', 'Juliette', 'Adam', 'Mia', 'Thomas', 'Florence',
  'Marc', 'Priya', 'Daniel', 'Aisha', 'Hugo', 'Maeve', 'Élodie', 'Ravi',
  'Simon', 'Nadia', 'Caleb', 'Yara', 'Antoine', 'Grace', 'Diego', 'Fatima',
];

const LAST = [
  'Tremblay', 'Roy', 'Gagnon', 'Bouchard', 'Côté', 'Lavoie', 'Fortin', 'Gauthier',
  'Morin', 'Lefebvre', 'Bélanger', 'Pelletier', 'Lévesque', 'Bergeron', 'Leblanc',
  'Patel', 'Nguyen', 'Singh', 'Okafor', 'Hassan', 'Smith', 'Johnson', 'Brown',
  'Martin', 'Dubois', 'Moreau', 'Laurent', 'Girard', 'Caron', 'Fournier',
];

// Build a fresh sample roster (new ids each call) that is guaranteed solvable:
// broad availability with enough supervisors and bilingual responders spread
// across every shift, plus a sprinkling of high preferences and non-negotiables.
export function SAMPLE_RESPONDERS() {
  const rand = makeRng(20240517);
  const dayShiftIds = SHIFTS.filter((s) => s.kind === 'day').map((s) => s.id);
  const nightShiftId = SHIFTS.find((s) => s.kind === 'night').id;
  const nonNegPerSlot = Object.fromEntries(ALL_SLOTS.map((id) => [id, 0]));

  const people = [];
  for (let i = 0; i < 48; i++) {
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7 + 3) % LAST.length];
    const name = `${first} ${last}`;

    // 14 supervisors, 16 returners, 18 rookies.
    let role = 'rookie';
    if (i < 14) role = 'supervisor';
    else if (i < 30) role = 'returner';

    const bilingual = rand() < 0.42;
    // Roughly balanced genders so the overnight-male rule is satisfiable.
    const g = rand();
    const gender = g < 0.48 ? 'male' : g < 0.94 ? 'female' : 'unspecified';
    // Four reduced-hours volunteers, all among the rookies.
    const hours = i >= 44 ? REDUCED_HOURS : FULL_HOURS;

    // Generous availability so a valid schedule always exists.
    const prefs = {};
    for (const id of ALL_SLOTS) {
      prefs[id] = rand() < 0.82 ? PREF.AVAIL : PREF.UNAVAIL;
    }

    // Guarantee schedulability.
    const availDays = ALL_SLOTS.filter(
      (id) => prefs[id] === PREF.AVAIL && SHIFT_BY_ID[parseSlot(id).shift].kind === 'day'
    );
    if (hours === REDUCED_HOURS) {
      if (availDays.length === 0) {
        const id = slotId(DAYS[i % 7], dayShiftIds[0]);
        prefs[id] = PREF.AVAIL;
        availDays.push(id);
      }
    } else if (availDays.length < 2) {
      // ensure at least two available day shifts for a 12h responder
      for (const d of DAYS) {
        for (const s of dayShiftIds) {
          prefs[slotId(d, s)] = PREF.AVAIL;
          if (!availDays.includes(slotId(d, s))) availDays.push(slotId(d, s));
          if (availDays.length >= 2) break;
        }
        if (availDays.length >= 2) break;
      }
    }

    // Upgrade a few available slots to "high preference".
    const avail = ALL_SLOTS.filter((id) => prefs[id] === PREF.AVAIL);
    const highCount = 2 + Math.floor(rand() * 3);
    for (let k = 0; k < highCount && avail.length; k++) {
      const id = avail[Math.floor(rand() * avail.length)];
      prefs[id] = PREF.HIGH;
    }

    // ~22% of responders get one non-negotiable slot (kept feasible & uncrowded).
    if (rand() < 0.22) {
      const pool =
        hours === REDUCED_HOURS
          ? availDays
          : rand() < 0.45
          ? ALL_SLOTS.filter(
              (id) =>
                prefs[id] !== PREF.UNAVAIL &&
                SHIFT_BY_ID[parseSlot(id).shift].kind === 'night'
            )
          : availDays;
      const candidates = pool.filter((id) => nonNegPerSlot[id] < 3);
      if (candidates.length) {
        const id = candidates[Math.floor(rand() * candidates.length)];
        prefs[id] = PREF.NONNEG;
        nonNegPerSlot[id] += 1;
      }
    }

    people.push({
      id: `sample_${i}`,
      name,
      role,
      bilingual,
      gender,
      hours,
      prefs,
    });
  }

  return people;
}

// A pair of avoidance-pair examples using stable sample ids.
export function SAMPLE_AVOIDANCE_PAIRS() {
  return [
    ['sample_5', 'sample_11'],
    ['sample_20', 'sample_31'],
  ];
}

// "Schedule together" examples using stable sample ids.
export function SAMPLE_PREFERRED_PAIRS() {
  return [
    ['sample_2', 'sample_35'],
    ['sample_14', 'sample_40'],
  ];
}
