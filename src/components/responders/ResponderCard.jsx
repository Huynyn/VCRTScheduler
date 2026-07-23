import { Pencil, Trash2, Globe, AlertTriangle } from 'lucide-react';
import Badge from '../common/Badge.jsx';
import { ALL_SLOTS, PREF, ROLE_LABELS, REDUCED_HOURS } from '../../constants/schedule.js';
import { buildPatterns } from '../../lib/patterns.js';
import { hasNonNegotiableFlag } from '../../lib/validation.js';

const roleColor = { supervisor: 'blue', returner: 'slate', rookie: 'gray' };

export default function ResponderCard({ responder, onEdit, onRemove }) {
  const counts = { [PREF.NONNEG]: 0, [PREF.HIGH]: 0, [PREF.AVAIL]: 0 };
  for (const id of ALL_SLOTS) {
    const p = responder.prefs[id];
    if (p in counts) counts[p] += 1;
  }
  const { patterns } = buildPatterns(responder);
  const schedulable = patterns.length > 0;
  const flagged = hasNonNegotiableFlag(responder);

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-gray-50 transition-colors">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-secondary-700 truncate">
            {responder.name || <span className="italic text-gray-400">Unnamed</span>}
          </span>
          <Badge color={roleColor[responder.role]}>{ROLE_LABELS[responder.role]}</Badge>
          {responder.bilingual && (
            <Badge color="green">
              <Globe size={11} /> Bilingual
            </Badge>
          )}
          <Badge color={responder.hours === REDUCED_HOURS ? 'amber' : 'gray'}>
            {responder.hours}h/wk
          </Badge>
          {responder.gender === 'male' && <Badge color="slate">Male</Badge>}
          {!schedulable && <Badge color="red">Not schedulable</Badge>}
          {schedulable && flagged && (
            <Badge color="amber">
              <AlertTriangle size={11} /> Review non-neg
            </Badge>
          )}
        </div>
        <div className="text-xs text-gray-500 mt-1">
          <span className="text-danger-600 font-medium">{counts[PREF.NONNEG]}</span> non-neg ·{' '}
          <span className="text-primary-600 font-medium">{counts[PREF.HIGH]}</span> high ·{' '}
          <span className="text-success-600 font-medium">{counts[PREF.AVAIL]}</span> available
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={() => onEdit(responder)}
          className="p-2 rounded-md text-gray-400 hover:text-primary-600 hover:bg-primary-50"
          aria-label={`Edit ${responder.name}`}
        >
          <Pencil size={16} />
        </button>
        <button
          onClick={() => onRemove(responder.id)}
          className="p-2 rounded-md text-gray-400 hover:text-danger-600 hover:bg-danger-50"
          aria-label={`Remove ${responder.name}`}
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}
