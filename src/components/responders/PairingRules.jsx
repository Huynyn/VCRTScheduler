import { useMemo, useState } from 'react';
import { UserX, UserCheck, Plus, X } from 'lucide-react';
import { Card, CardHeader, CardBody } from '../common/Card.jsx';
import Button from '../common/Button.jsx';
import { useResponders } from '../../context/ResponderContext.jsx';

// One section = one kind of pairing rule (avoid together / schedule together).
// Both are soft rules: the solver honours them when possible.
function PairSection({ icon, tone, title, hint, pairs, byId, sorted, onAdd, onRemove }) {
  const [aId, setAId] = useState('');
  const [bId, setBId] = useState('');
  const canAdd = aId && bId && aId !== bId;

  const submit = () => {
    if (!canAdd) return;
    onAdd(aId, bId);
    setAId('');
    setBId('');
  };

  const toneStyles =
    tone === 'danger'
      ? { chip: 'bg-danger-50 border-danger-200', joiner: 'text-danger-500', icon: 'text-danger-600 bg-danger-50' }
      : { chip: 'bg-success-50 border-success-200', joiner: 'text-success-600', icon: 'text-success-700 bg-success-50' };

  return (
    <div className="flex-1 min-w-[280px]">
      <div className="flex items-center gap-2.5 mb-1">
        <span className={`h-8 w-8 rounded-lg flex items-center justify-center ${toneStyles.icon}`}>
          {icon}
        </span>
        <div>
          <h3 className="text-sm font-semibold text-secondary-700 leading-tight">{title}</h3>
          <p className="text-xs text-gray-500 leading-tight">{hint}</p>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <select
          className="form-select flex-1 !py-1.5 text-sm"
          value={aId}
          onChange={(e) => setAId(e.target.value)}
          aria-label={`${title}: first responder`}
        >
          <option value="">Select…</option>
          {sorted.map((r) => (
            <option key={r.id} value={r.id} disabled={r.id === bId}>
              {r.name}
            </option>
          ))}
        </select>
        <span className="text-gray-400 text-sm shrink-0">&amp;</span>
        <select
          className="form-select flex-1 !py-1.5 text-sm"
          value={bId}
          onChange={(e) => setBId(e.target.value)}
          aria-label={`${title}: second responder`}
        >
          <option value="">Select…</option>
          {sorted.map((r) => (
            <option key={r.id} value={r.id} disabled={r.id === aId}>
              {r.name}
            </option>
          ))}
        </select>
        <Button
          variant={tone === 'danger' ? 'outline' : 'success'}
          className="!px-3 !py-1.5 shrink-0"
          onClick={submit}
          disabled={!canAdd}
          aria-label={`Add ${title.toLowerCase()} pair`}
        >
          <Plus size={15} /> Add
        </Button>
      </div>

      {pairs.length === 0 ? (
        <p className="mt-3 text-xs text-gray-400 italic">No pairs yet.</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {pairs.map(([a, b]) => {
            const rA = byId[a];
            const rB = byId[b];
            if (!rA || !rB) return null;
            return (
              <li
                key={`${a}::${b}`}
                className={`flex items-center justify-between gap-2 pl-3 pr-1.5 py-1.5 rounded-md border ${toneStyles.chip}`}
              >
                <div className="text-sm text-secondary-700 truncate">
                  <span className="font-medium">{rA.name}</span>
                  <span className={`mx-1.5 font-semibold ${toneStyles.joiner}`}>
                    {tone === 'danger' ? '×' : '+'}
                  </span>
                  <span className="font-medium">{rB.name}</span>
                </div>
                <button
                  className="p-1 rounded text-gray-400 hover:text-danger-600 hover:bg-white/70 shrink-0"
                  onClick={() => onRemove(a, b)}
                  aria-label={`Remove ${rA.name} and ${rB.name}`}
                >
                  <X size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function PairingRules() {
  const {
    responders,
    avoidancePairs,
    preferredPairs,
    addAvoidancePair,
    removeAvoidancePair,
    addPreferredPair,
    removePreferredPair,
  } = useResponders();

  const byId = useMemo(() => Object.fromEntries(responders.map((r) => [r.id, r])), [responders]);
  const sorted = useMemo(
    () => [...responders].sort((a, b) => a.name.localeCompare(b.name)),
    [responders]
  );

  return (
    <Card>
      <CardHeader
        title="Pairing rules"
        subtitle="Both rules are preferences, not guarantees. The scheduler honours them whenever a valid schedule allows."
      />
      <CardBody>
        {responders.length < 2 ? (
          <p className="text-sm text-gray-400 italic">
            Add at least two responders to set pairing rules.
          </p>
        ) : (
          <div className="flex flex-col lg:flex-row gap-8 lg:divide-x lg:divide-gray-100">
            <PairSection
              icon={<UserX size={17} />}
              tone="danger"
              title="Keep apart"
              hint="These two should not share any shift."
              pairs={avoidancePairs}
              byId={byId}
              sorted={sorted}
              onAdd={addAvoidancePair}
              onRemove={removeAvoidancePair}
            />
            <div className="lg:pl-8 flex-1 flex">
              <PairSection
                icon={<UserCheck size={17} />}
                tone="success"
                title="Schedule together"
                hint="Try to put these two on the same shift — matching even one shift counts."
                pairs={preferredPairs}
                byId={byId}
                sorted={sorted}
                onAdd={addPreferredPair}
                onRemove={removePreferredPair}
              />
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
