import { DAYS, DAY_LABELS, SHIFTS, slotId, MIN_PER_SHIFT, MAX_PER_SHIFT } from '../../constants/schedule.js';

// Renders one schedule as a weekly grid, mirroring the printed PDF:
//   (S) suffix   = shift supervisor
//   (R) + blue   = new member (rookie)
//   italic name  = bilingual (French + English)
// Names never wrap: each day column has a fixed, generous width and every
// name sits on its own single striped line.
function ResponderName({ r }) {
  const isSup = r.role === 'supervisor';
  const isNew = r.role === 'rookie';
  const cls = [
    isNew ? 'text-primary-600' : 'text-secondary-700',
    isSup ? 'font-semibold' : '',
    r.bilingual ? 'italic' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const suffix = isSup ? ' (S)' : isNew ? ' (R)' : '';
  return (
    <span className={`${cls} whitespace-nowrap`} title={`${r.name}${suffix}`}>
      {r.name}
      {suffix && <span className="not-italic">{suffix}</span>}
      {r.hours === 6 && (
        <span className="not-italic font-normal text-gray-400 text-[10px]"> · 6h</span>
      )}
    </span>
  );
}

// Flag the cells where one person works back-to-back shifts worth a second look:
//   - two day shifts in a row (same day 08:00–14:00 + 14:00–20:00 = a 12h day), or
//   - an afternoon (14:00–20:00) followed by the next morning (08:00–14:00).
// Returns a map of `${responderId}::${slotId}` -> reason string.
function backToBackFlags(schedule) {
  const flags = {};
  const mark = (rid, slot, reason) => {
    flags[`${rid}::${slot}`] = reason;
  };
  for (const [rid, pattern] of Object.entries(schedule.assignment || {})) {
    const set = new Set(pattern);
    for (let i = 0; i < DAYS.length; i++) {
      const d = DAYS[i];
      const morning = slotId(d, 'day1');
      const afternoon = slotId(d, 'day2');
      if (set.has(morning) && set.has(afternoon)) {
        const reason = 'Two day shifts in a row (08:00–20:00 the same day)';
        mark(rid, morning, reason);
        mark(rid, afternoon, reason);
      }
      if (i < DAYS.length - 1) {
        const nextMorning = slotId(DAYS[i + 1], 'day1');
        if (set.has(afternoon) && set.has(nextMorning)) {
          const reason = 'Afternoon shift then next morning (short rest)';
          mark(rid, afternoon, reason);
          mark(rid, nextMorning, reason);
        }
      }
    }
  }
  return flags;
}

export default function ScheduleTable({ schedule }) {
  // Slot -> number of avoidance-pair conflicts on that slot.
  const conflictsBySlot = {};
  for (const v of schedule.metrics?.issues?.avoidanceViolations || []) {
    for (const id of v.slots) conflictsBySlot[id] = (conflictsBySlot[id] || 0) + 1;
  }

  const b2bFlags = backToBackFlags(schedule);

  const timeLabel = (shift) => shift.label.split('–')[0].trim().replace(/^0/, '');

  return (
    <div className="overflow-x-auto rounded-lg border border-secondary-200">
      <table className="w-full min-w-[1260px] table-fixed border-collapse">
        <colgroup>
          <col className="w-[72px]" />
          {DAYS.map((d) => (
            <col key={d} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="bg-primary-700 text-white text-sm font-semibold py-2.5 px-2 border border-primary-800">
              Time
            </th>
            {DAYS.map((d) => (
              <th
                key={d}
                className="bg-primary-700 text-white text-sm font-semibold py-2.5 px-2 border border-primary-800"
              >
                {DAY_LABELS[d]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SHIFTS.map((shift) => (
            <tr key={shift.id}>
              <td className="bg-secondary-50 border border-secondary-200 text-center align-middle">
                <div className="font-bold text-secondary-700 text-sm">{timeLabel(shift)}</div>
                <div className="text-[10px] text-gray-400">{shift.short}</div>
              </td>
              {DAYS.map((day) => {
                const id = slotId(day, shift.id);
                const people = schedule.slots[id] || [];
                const hasSup = people.some((p) => p.role === 'supervisor');
                const hasBil = people.some((p) => p.bilingual);
                const hasMale = people.some((p) => p.gender === 'male');
                const hasFemale = people.some((p) => p.gender === 'female');
                const isNight = shift.kind === 'night';
                const short = people.length < MIN_PER_SHIFT;
                const broken = short || !hasSup || !hasBil;
                const rows = Math.max(MAX_PER_SHIFT, people.length);
                return (
                  <td
                    key={day}
                    className={`align-top border p-0 ${
                      broken ? 'border-danger-300 ring-1 ring-inset ring-danger-300' : 'border-secondary-200'
                    }`}
                  >
                    <div>
                      {Array.from({ length: rows }).map((_, i) => {
                        const person = people[i];
                        const flag = person && b2bFlags[`${person.id}::${id}`];
                        return (
                          <div
                            key={i}
                            className={`px-2 h-6 flex items-center text-xs leading-none ${
                              i % 2 === 1 ? 'bg-gray-100' : broken ? 'bg-danger-50' : 'bg-white'
                            }`}
                          >
                            {person ? (
                              <span
                                className={`truncate w-full ${
                                  flag
                                    ? 'bg-warning-100 ring-1 ring-warning-300 rounded px-1 -mx-0.5'
                                    : ''
                                }`}
                                title={flag || undefined}
                              >
                                <ResponderName r={person} />
                              </span>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                    <div
                      className={`px-2 py-1 flex items-center gap-1.5 text-[10px] border-t ${
                        broken
                          ? 'bg-danger-50 border-danger-200 text-danger-600'
                          : 'bg-secondary-50 border-secondary-100 text-gray-400'
                      }`}
                    >
                      <span className="font-medium">{people.length} ppl</span>
                      <span className={hasSup ? 'text-success-600' : 'text-danger-600'}>S</span>
                      <span className={hasBil ? 'text-success-600' : 'text-danger-600'}>B</span>
                      {isNight && (
                        <>
                          <span
                            className={hasMale ? 'text-success-600' : 'text-warning-600'}
                            title="At least one male on overnight (preference)"
                          >
                            M
                          </span>
                          <span
                            className={hasFemale ? 'text-success-600' : 'text-warning-600'}
                            title="At least one female on overnight (preference)"
                          >
                            F
                          </span>
                        </>
                      )}
                      {conflictsBySlot[id] > 0 && (
                        <span className="text-warning-600" title="Avoidance-pair conflict on this shift">
                          ⚠ pair
                        </span>
                      )}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
