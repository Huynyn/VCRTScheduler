import {
  ALL_SLOTS,
  SHIFT_BY_ID,
  parseSlot,
  slotId,
  MIN_PER_SHIFT,
  MAX_PER_SHIFT,
  PREF,
  REDUCED_HOURS,
  PRIORITY_NIGHT_DAYS,
  SHIFTS,
} from '../constants/schedule.js';
import { buildPatterns, usableSlots } from './patterns.js';
import { nonNegotiableFlags } from './validation.js';

const NIGHT_SHIFT_ID = SHIFTS.find((s) => s.kind === 'night').id;

const slotHours = (id) => SHIFT_BY_ID[parseSlot(id).shift].hours;
const slotCapacityUnits = (r) => (r.hours === REDUCED_HOURS ? 1 : 2); // max slots one responder can occupy

// Returns { errors, warnings, stats }.
// `errors` are conditions that make a valid schedule provably impossible.
// `warnings` flag tight situations that may still be solvable.
export function checkFeasibility(responders, avoidancePairs = [], preferredPairs = []) {
  const errors = [];
  const warnings = [];

  if (responders.length === 0) {
    errors.push('No responders have been entered yet.');
    return { errors, warnings, stats: {} };
  }

  // 1) Every responder needs at least one feasible weekly pattern.
  const noPattern = [];
  for (const r of responders) {
    const { patterns, reason } = buildPatterns(r);
    if (patterns.length === 0) noPattern.push({ name: r.name, reason });
  }
  for (const { name, reason } of noPattern) {
    errors.push(`${name}: cannot be scheduled — ${reason}`);
  }

  // 2) Total hour capacity vs. the coverage window.
  const requiredHours = responders.reduce(
    (sum, r) => sum + (r.hours === REDUCED_HOURS ? REDUCED_HOURS : 12),
    0
  );
  const minNeeded = ALL_SLOTS.reduce((s, id) => s + slotHours(id) * MIN_PER_SHIFT, 0);
  const maxAllowed = ALL_SLOTS.reduce((s, id) => s + slotHours(id) * MAX_PER_SHIFT, 0);

  if (requiredHours < minNeeded) {
    errors.push(
      `Not enough total hours: responders supply ${requiredHours}h but covering every shift with ${MIN_PER_SHIFT} people needs at least ${minNeeded}h. Add more responders.`
    );
  }
  if (requiredHours > maxAllowed) {
    errors.push(
      `Too many total hours: responders must work ${requiredHours}h but the week can absorb at most ${maxAllowed}h (${MAX_PER_SHIFT} people per shift). Reduce hours or headcount.`
    );
  }

  // 3) Supervisor & bilingual slot-coverage capacity (each slot needs one of each).
  const supervisors = responders.filter((r) => r.role === 'supervisor');
  const bilinguals = responders.filter((r) => r.bilingual);
  const supUnits = supervisors.reduce((s, r) => s + slotCapacityUnits(r), 0);
  const bilUnits = bilinguals.reduce((s, r) => s + slotCapacityUnits(r), 0);
  const slotCount = ALL_SLOTS.length;

  if (supUnits < slotCount) {
    errors.push(
      `Not enough supervisor coverage: every one of the ${slotCount} shifts needs a supervisor, but supervisors can occupy at most ${supUnits} shift-slots in total.`
    );
  }
  if (bilUnits < slotCount) {
    errors.push(
      `Not enough bilingual coverage: every one of the ${slotCount} shifts needs a bilingual responder, but bilingual responders can occupy at most ${bilUnits} shift-slots in total.`
    );
  }

  // 4) Per-slot availability checks.
  const availableBySlot = {};
  const supBySlot = {};
  const bilBySlot = {};
  const maleBySlot = {};
  const femaleBySlot = {};
  const nonNegBySlot = {};
  for (const id of ALL_SLOTS) {
    availableBySlot[id] = 0;
    supBySlot[id] = 0;
    bilBySlot[id] = 0;
    maleBySlot[id] = 0;
    femaleBySlot[id] = 0;
    nonNegBySlot[id] = 0;
  }
  for (const r of responders) {
    for (const id of usableSlots(r)) {
      availableBySlot[id] += 1;
      if (r.role === 'supervisor') supBySlot[id] += 1;
      if (r.bilingual) bilBySlot[id] += 1;
      if (r.gender === 'male') maleBySlot[id] += 1;
      if (r.gender === 'female') femaleBySlot[id] += 1;
    }
    for (const id of ALL_SLOTS) {
      if (r.prefs[id] === PREF.NONNEG) nonNegBySlot[id] += 1;
    }
  }

  for (const id of ALL_SLOTS) {
    const { day, shift } = parseSlot(id);
    const label = `${day} ${SHIFT_BY_ID[shift].label}`;
    if (availableBySlot[id] < MIN_PER_SHIFT) {
      errors.push(
        `${label}: only ${availableBySlot[id]} responder(s) are available, but every shift needs ${MIN_PER_SHIFT}.`
      );
    }
    if (supBySlot[id] === 0) {
      errors.push(`${label}: no supervisor is available, so it can never be staffed.`);
    }
    if (bilBySlot[id] === 0) {
      errors.push(`${label}: no bilingual responder is available, so it can never be staffed.`);
    }
    if (nonNegBySlot[id] > MAX_PER_SHIFT) {
      errors.push(
        `${label}: ${nonNegBySlot[id]} responders marked it non-negotiable, but a shift holds at most ${MAX_PER_SHIFT}.`
      );
    }
    if (availableBySlot[id] === MIN_PER_SHIFT) {
      warnings.push(`${label}: exactly ${MIN_PER_SHIFT} responders available — they must all be scheduled here.`);
    }
  }

  // Soft rule: priority overnight shifts (Thu/Fri/weekend) should be able to
  // include at least one male and one female responder. Warn when none of a
  // gender is even available.
  for (const day of PRIORITY_NIGHT_DAYS) {
    const id = slotId(day, NIGHT_SHIFT_ID);
    const label = `${day} ${SHIFT_BY_ID[NIGHT_SHIFT_ID].label}`;
    if (maleBySlot[id] === 0) {
      warnings.push(
        `${label}: no male responder is available for this overnight shift, so the "at least one male overnight" preference can't be met here.`
      );
    }
    if (femaleBySlot[id] === 0) {
      warnings.push(
        `${label}: no female responder is available for this overnight shift, so the "at least one female overnight" preference can't be met here.`
      );
    }
  }

  // Soft rule: flag questionable use of non-negotiables (per responder).
  for (const r of responders) {
    for (const msg of nonNegotiableFlags(r)) {
      warnings.push(`${r.name || 'Unnamed responder'}: ${msg}`);
    }
  }

  // Avoidance pairs: warn when both people can only work together (i.e. the
  // intersection of their usable slots is very small).
  if (avoidancePairs.length > 0) {
    const byId = Object.fromEntries(responders.map((r) => [r.id, r]));
    for (const [a, b] of avoidancePairs) {
      const rA = byId[a];
      const rB = byId[b];
      if (!rA || !rB) continue;
      const usableA = new Set(usableSlots(rA));
      const overlap = usableSlots(rB).filter((id) => usableA.has(id));
      if (overlap.length === 0) continue;
      // If A and B each have only one possible pattern and it shares slots,
      // an overlap is unavoidable — flag it.
      const patsA = buildPatterns(rA).patterns;
      const patsB = buildPatterns(rB).patterns;
      if (patsA.length === 1 && patsB.length === 1) {
        const shared = patsA[0].filter((id) => patsB[0].includes(id));
        if (shared.length > 0) {
          warnings.push(
            `${rA.name} & ${rB.name}: their only possible patterns overlap on ${shared
              .map((id) => id.replace('|', ' '))
              .join(', ')} — the "avoid together" preference can't be met.`
          );
        }
      }
    }
  }

  // Preferred ("schedule together") pairs: warn when the two people share no
  // usable slot at all, so the preference can never be honoured.
  if (preferredPairs.length > 0) {
    const byId = Object.fromEntries(responders.map((r) => [r.id, r]));
    for (const [a, b] of preferredPairs) {
      const rA = byId[a];
      const rB = byId[b];
      if (!rA || !rB) continue;
      const usableA = new Set(usableSlots(rA));
      const overlap = usableSlots(rB).filter((id) => usableA.has(id));
      if (overlap.length === 0) {
        warnings.push(
          `${rA.name} & ${rB.name}: they share no overlapping availability, so the "schedule together" preference can't be met.`
        );
      }
    }
  }

  const stats = {
    responderCount: responders.length,
    supervisorCount: supervisors.length,
    bilingualCount: bilinguals.length,
    reducedCount: responders.filter((r) => r.hours === REDUCED_HOURS).length,
    requiredHours,
    minNeeded,
    maxAllowed,
  };

  return { errors, warnings, stats };
}
