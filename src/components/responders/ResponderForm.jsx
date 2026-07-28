import { useState, useEffect, useMemo } from 'react';
import { UserPlus, Save, X, AlertTriangle } from 'lucide-react';
import { Card, CardHeader, CardBody } from '../common/Card.jsx';
import Button from '../common/Button.jsx';
import PreferenceGrid from './PreferenceGrid.jsx';
import { makeResponder } from '../../context/ResponderContext.jsx';
import { ROLES, GENDERS, FULL_HOURS, REDUCED_HOURS } from '../../constants/schedule.js';
import { buildPatterns } from '../../lib/patterns.js';
import { nonNegotiableFlags } from '../../lib/validation.js';

export default function ResponderForm({ editing, onSave, onCancel }) {
  const [draft, setDraft] = useState(() => makeResponder());

  useEffect(() => {
    setDraft(editing ? { ...makeResponder(), ...editing } : makeResponder());
  }, [editing]);

  const setField = (field, value) => setDraft((d) => ({ ...d, [field]: value }));
  const setPref = (slot, level) =>
    setDraft((d) => ({ ...d, prefs: { ...d.prefs, [slot]: level } }));

  const { patterns, reason } = useMemo(() => buildPatterns(draft), [draft]);
  const flags = useMemo(() => nonNegotiableFlags(draft), [draft]);
  const nameError = draft.name.trim() === '';

  const submit = () => {
    if (nameError) return;
    onSave({ ...draft, name: draft.name.trim() });
    if (!editing) setDraft(makeResponder());
  };

  return (
    <Card className="animate-fade-in">
      <CardHeader
        title={editing ? `Edit ${editing.name || 'responder'}` : 'Add a responder'}
        subtitle="Enter who they are, then mark their availability for each shift."
        actions={
          editing && (
            <Button variant="ghost" onClick={onCancel} aria-label="Cancel edit">
              <X size={16} /> Cancel
            </Button>
          )
        }
      />
      <CardBody>
        <div className="grid grid-cols-1 md:grid-cols-12 gap-x-4 gap-y-4 mb-5">
          <div className="md:col-span-6">
            <label className="form-label" htmlFor="resp-name">
              Full name
            </label>
            <input
              id="resp-name"
              className="form-input"
              placeholder="e.g. Jordan Tremblay"
              value={draft.name}
              onChange={(e) => setField('name', e.target.value)}
            />
          </div>

          <div className="md:col-span-3">
            <label className="form-label" htmlFor="resp-role">
              Role
            </label>
            <select
              id="resp-role"
              className="form-select"
              value={draft.role}
              onChange={(e) => setField('role', e.target.value)}
            >
              {ROLES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-3">
            <label className="form-label" htmlFor="resp-hours">
              Weekly hours
            </label>
            <select
              id="resp-hours"
              className="form-select"
              value={draft.hours}
              onChange={(e) => setField('hours', Number(e.target.value))}
            >
              <option value={FULL_HOURS}>12 hours</option>
              <option value={REDUCED_HOURS}>6 hours</option>
            </select>
          </div>

          {/* Gender and language sit side by side, with matching control
              heights and hints so the two columns stay vertically centred
              with respect to each other. */}
          <div className="md:col-span-6">
            <label className="form-label" htmlFor="resp-gender">
              Gender
            </label>
            <select
              id="resp-gender"
              className="form-select"
              value={draft.gender}
              onChange={(e) => setField('gender', e.target.value)}
            >
              {GENDERS.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
            </select>
            <p className="form-hint">Used only for the overnight-coverage preference.</p>
          </div>

          <div className="md:col-span-6">
            <span className="form-label">Language</span>
            <label
              className={`flex items-center gap-2.5 px-3 py-2 border rounded-lg shadow-sm cursor-pointer select-none transition-colors ${
                draft.bilingual
                  ? 'border-success-500 bg-success-50'
                  : 'border-gray-300 bg-white hover:bg-gray-50'
              }`}
            >
              <input
                type="checkbox"
                className="form-checkbox"
                checked={draft.bilingual}
                onChange={(e) => setField('bilingual', e.target.checked)}
              />
              <span className="text-sm font-medium text-gray-600">
                Bilingual (English &amp; French)
              </span>
            </label>
            <p className="form-hint">Unchecked = English speaker.</p>
          </div>
        </div>

        <label className="form-label">Availability &amp; preferences</label>
        <PreferenceGrid prefs={draft.prefs} onChange={setPref} />

        {patterns.length === 0 && (
          <div className="alert-warning mt-4 flex items-start gap-2 text-sm">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>
              This responder can&apos;t be scheduled as set up: {reason} Adjust their availability or
              hours.
            </span>
          </div>
        )}

        {flags.map((msg, i) => (
          <div key={i} className="alert-warning mt-3 flex items-start gap-2 text-sm">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>{msg}</span>
          </div>
        ))}

        <div className="flex items-center justify-end gap-2 mt-5">
          {editing && (
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button variant="primary" onClick={submit} disabled={nameError}>
            {editing ? (
              <>
                <Save size={16} /> Save changes
              </>
            ) : (
              <>
                <UserPlus size={16} /> Add responder
              </>
            )}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
