import { useState } from 'react';
import { FileDown, Trophy, Users, Check, X } from 'lucide-react';
import { Card, CardHeader, CardBody } from '../common/Card.jsx';
import Button from '../common/Button.jsx';
import ScheduleTable from './ScheduleTable.jsx';
import { useResponders } from '../../context/ResponderContext.jsx';
import { exportSchedulesPdf, currentTerm, termLabel, SEMESTERS } from '../../lib/pdfExport.js';

// "Schedule together" status for each preferred pair — clearly shows when a pair
// is together in this option, and when they simply can't be paired this week.
function TogetherPanel({ schedule, result, nameById }) {
  const overlaps = schedule.metrics.preferredOverlaps || [];
  if (overlaps.length === 0) return null;

  const matchedSomewhere = (key) =>
    result.schedules.some((s) =>
      (s.metrics.preferredOverlaps || []).some((o) => o.pair.join('|') === key && o.shared > 0)
    );

  return (
    <div className="mb-4 rounded-lg border border-gray-200 overflow-hidden">
      <div className="bg-gray-50 px-3 py-2 text-sm font-semibold text-secondary-700 inline-flex items-center gap-2">
        <Users size={15} className="text-primary-500" /> Scheduled together
      </div>
      <ul className="divide-y divide-gray-100">
        {overlaps.map((o) => {
          const [a, b] = o.pair;
          const names = `${nameById[a] || 'Unknown'} & ${nameById[b] || 'Unknown'}`;
          const key = o.pair.join('|');
          const together = o.shared > 0;
          const anywhere = together || matchedSomewhere(key);
          return (
            <li key={key} className="px-3 py-2 flex items-start gap-2 text-sm">
              {together ? (
                <Check size={15} className="mt-0.5 shrink-0 text-success-600" />
              ) : (
                <X size={15} className="mt-0.5 shrink-0 text-danger-500" />
              )}
              <div>
                <span className="font-medium text-secondary-700">{names}</span>
                {together ? (
                  <span className="text-gray-500">
                    {' '}
                    — together on {o.shared} shared shift{o.shared === 1 ? '' : 's'} in this option.
                  </span>
                ) : anywhere ? (
                  <span className="text-gray-500">
                    {' '}
                    — not together in this option, but they are paired up in another option below.
                  </span>
                ) : (
                  <span className="text-danger-600">
                    {' '}
                    — couldn&apos;t be scheduled together in any of the {result.schedules.length}{' '}
                    options. Their availability doesn&apos;t overlap on a shift with room for both.
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
      <span className="font-semibold text-garnet-500 italic">Legend:</span>
      <span className="text-secondary-700 font-semibold">(S) = Shift supervisor</span>
      <span className="text-primary-600">(R) = New member</span>
      <span className="italic">Italics = French + English (bilingual)</span>
      <span>Non-italicized = English speaker</span>
      <span className="text-gray-400">S / B / M / F chips = supervisor · bilingual · male · female present</span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded-sm bg-warning-100 ring-1 ring-warning-300" />
        Amber name = back-to-back shifts (two day shifts in a row, or afternoon → next morning)
      </span>
    </div>
  );
}

export default function ScheduleResults({ result }) {
  const { responders } = useResponders();
  const [active, setActive] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [term, setTerm] = useState(() => currentTerm());
  const [showMeta, setShowMeta] = useState(true);
  if (!result?.schedules?.length) return null;
  const schedule = result.schedules[active];
  const nameById = Object.fromEntries(responders.map((r) => [r.id, r.name]));

  const download = async () => {
    setExporting(true);
    try {
      await exportSchedulesPdf(result, {
        generatedAt: new Date().toLocaleString(),
        term: termLabel(term),
        showMeta,
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card className="animate-fade-in">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Trophy size={18} className="text-warning-500" />
            {result.ok ? 'Top schedules' : 'Best possible schedules (partial)'}
          </span>
        }
        subtitle={
          result.ok
            ? `Found ${result.stats.validFound} valid schedule${
                result.stats.validFound === 1 ? '' : 's'
              } · showing the best ${result.schedules.length}`
            : `No fully valid schedule was possible. The ${result.schedules.length} closest option${
                result.schedules.length === 1 ? ' is' : 's are'
              } shown below, with gaps highlighted in red. See “Make a complete schedule possible” underneath for who to contact.`
        }
        actions={
          <div className="flex items-end gap-2">
            <div>
              <label className="form-label" htmlFor="term-semester">
                Semester
              </label>
              <select
                id="term-semester"
                className="form-select !py-2 text-sm"
                value={term.semester}
                onChange={(e) => setTerm((t) => ({ ...t, semester: e.target.value }))}
              >
                {SEMESTERS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="form-label" htmlFor="term-year">
                Year
              </label>
              <input
                id="term-year"
                type="number"
                min="2020"
                max="2100"
                step="1"
                className="form-input !py-2 w-24 text-sm"
                value={term.year}
                onChange={(e) => setTerm((t) => ({ ...t, year: Number(e.target.value) || t.year }))}
              />
            </div>
            <label className="flex items-center gap-1.5 text-xs text-gray-600 pb-3 select-none cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={showMeta}
                onChange={(e) => setShowMeta(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-gray-300 text-primary-500 focus:ring-primary-500"
              />
              Show “Option / Generated” line
            </label>
            <Button variant="primary" onClick={download} disabled={exporting} className="!py-2.5">
              <FileDown size={16} /> {exporting ? 'Preparing…' : 'Download PDF'}
            </Button>
          </div>
        }
      />
      <CardBody>
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          {result.schedules.map((s, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors inline-flex items-center gap-1.5 ${
                i === active
                  ? 'bg-primary-500 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              Option {s.rank}
              {!s.valid && (
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
                    i === active ? 'bg-white/25' : 'bg-warning-100 text-warning-700'
                  }`}
                >
                  partial
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
          <Metric label="High-pref shifts honoured" value={schedule.metrics.high} />
          <Metric label="Non-negotiables met" value={schedule.metrics.nonNeg} />
          <Metric
            label="Overnights w/ male"
            value={`${schedule.metrics.nightsWithMale}/${schedule.metrics.nightTotal}`}
            sub={`Thu–Sun: ${schedule.metrics.prioNightsWithMale}/${schedule.metrics.prioNightTotal}`}
          />
          <Metric
            label="Overnights w/ female"
            value={`${schedule.metrics.nightsWithFemale}/${schedule.metrics.nightTotal}`}
            sub={`Thu–Sun: ${schedule.metrics.prioNightsWithFemale}/${schedule.metrics.prioNightTotal}`}
          />
          <Metric
            label="Soft-rule breaches"
            value={schedule.metrics.avoidanceCount + schedule.metrics.weekendDoubles}
            sub={`avoidance: ${schedule.metrics.avoidanceCount} · weekend doubles: ${schedule.metrics.weekendDoubles}`}
          />
          {schedule.metrics.preferredTotal > 0 && (
            <Metric
              label="Pairs scheduled together"
              value={`${schedule.metrics.preferredMatched}/${schedule.metrics.preferredTotal}`}
              sub="share at least one shift"
            />
          )}
        </div>

        {!schedule.valid && (
          <div className="alert-warning mb-3 text-sm">
            <strong>Partial schedule.</strong>{' '}
            {schedule.metrics.issues.peopleShort > 0 &&
              `${schedule.metrics.issues.peopleShort} person-slot(s) short of the minimum. `}
            {schedule.metrics.issues.missingSup.length > 0 &&
              `${schedule.metrics.issues.missingSup.length} shift(s) with no supervisor. `}
            {schedule.metrics.issues.missingBil.length > 0 &&
              `${schedule.metrics.issues.missingBil.length} shift(s) with no bilingual. `}
            See the highlighted cells below and the contact list further down.
          </div>
        )}

        <TogetherPanel schedule={schedule} result={result} nameById={nameById} />

        <div className="mb-3">
          <Legend />
        </div>

        <ScheduleTable schedule={schedule} />
      </CardBody>
    </Card>
  );
}

function Metric({ label, value, sub }) {
  return (
    <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2">
      <div className="text-xl font-semibold text-secondary-700">{value}</div>
      <div className="text-[11px] text-gray-500 leading-tight">{label}</div>
      {sub && <div className="text-[10px] text-gray-400 leading-tight mt-0.5">{sub}</div>}
    </div>
  );
}
