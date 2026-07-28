import {
  DAYS,
  SHIFTS,
  slotId,
  PREF,
  PREF_META,
  PREF_CYCLE,
} from '../../constants/schedule.js';

// Click a cell to cycle: Not available -> Available -> High -> Non-negotiable.
// Shift-click cycles backwards.
export default function PreferenceGrid({ prefs, onChange }) {
  const cycle = (current, backwards) => {
    const i = PREF_CYCLE.indexOf(current);
    const next = backwards
      ? (i - 1 + PREF_CYCLE.length) % PREF_CYCLE.length
      : (i + 1) % PREF_CYCLE.length;
    return PREF_CYCLE[next];
  };

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-1">
          <thead>
            <tr>
              <th className="text-left text-xs font-medium text-gray-500 px-2 py-1 w-28">Shift</th>
              {DAYS.map((d) => (
                <th key={d} className="text-xs font-medium text-gray-500 px-1 py-1 text-center">
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SHIFTS.map((shift) => (
              <tr key={shift.id}>
                <td className="text-xs text-gray-600 px-2 py-1 align-middle">
                  <div className="font-medium">{shift.short}</div>
                  <div className="text-[10px] text-gray-400 font-mono">{shift.label}</div>
                </td>
                {DAYS.map((day) => {
                  const id = slotId(day, shift.id);
                  const level = prefs[id] || PREF.UNAVAIL;
                  const meta = PREF_META[level];
                  return (
                    <td key={id} className="p-0">
                      <button
                        type="button"
                        title={`${day} ${shift.label}: ${meta.label} (click to change)`}
                        onClick={(e) => onChange(id, cycle(level, e.shiftKey))}
                        className={`w-full h-9 rounded-md text-[11px] font-semibold transition-colors ${meta.color} ${meta.textColor} hover:opacity-80 focus:outline-none focus:ring-2 ${meta.ring} focus:ring-offset-1`}
                      >
                        {meta.short}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3 mt-3 text-xs text-gray-500">
        <span className="font-medium text-gray-600">Levels:</span>
        {PREF_CYCLE.slice().reverse().map((lvl) => {
          const meta = PREF_META[lvl];
          return (
            <span key={lvl} className="inline-flex items-center gap-1.5">
              <span className={`inline-block w-3 h-3 rounded ${meta.color}`} />
              {meta.label}
            </span>
          );
        })}
        <span className="text-gray-400">· click to raise, shift-click to lower</span>
      </div>
    </div>
  );
}
