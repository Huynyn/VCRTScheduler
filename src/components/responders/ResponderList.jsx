import { useState, useMemo, useRef } from 'react';
import { Users, Trash2, Database, Download, Upload, AlertTriangle } from 'lucide-react';
import { Card, CardHeader, CardBody } from '../common/Card.jsx';
import Button from '../common/Button.jsx';
import Badge from '../common/Badge.jsx';
import ResponderCard from './ResponderCard.jsx';
import { useResponders } from '../../context/ResponderContext.jsx';
import { REDUCED_HOURS } from '../../constants/schedule.js';
import { exportRosterXlsx, importRosterXlsx } from '../../lib/xlsxRoster.js';
import {
  SAMPLE_RESPONDERS,
  SAMPLE_AVOIDANCE_PAIRS,
  SAMPLE_PREFERRED_PAIRS,
} from '../../data/sampleData.js';

export default function ResponderList({ onEdit, editingId }) {
  const { responders, removeResponder, clearAll, loadAll } = useResponders();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null); // { type: 'error' | 'warning' | 'success', lines: [] }
  const fileInputRef = useRef(null);

  const handleExport = async () => {
    setNotice(null);
    setBusy(true);
    try {
      await exportRosterXlsx(responders);
    } catch (err) {
      setNotice({ type: 'error', lines: [`Export failed: ${err.message}`] });
    } finally {
      setBusy(false);
    }
  };

  const handleImportFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-importing the same file
    if (!file) return;
    if (
      responders.length > 0 &&
      !window.confirm(
        `Importing replaces the current roster of ${responders.length} responder${
          responders.length === 1 ? '' : 's'
        }. Continue?`
      )
    ) {
      return;
    }
    setNotice(null);
    setBusy(true);
    try {
      const { responders: imported, warnings } = await importRosterXlsx(file);
      // Importing generates fresh ids, so any existing pairing rules (keyed by
      // id) would dangle — clear them alongside the roster.
      loadAll(imported, [], []);
      setNotice({
        type: warnings.length ? 'warning' : 'success',
        lines: [
          `Imported ${imported.length} responder${imported.length === 1 ? '' : 's'}.`,
          ...warnings,
        ],
      });
    } catch (err) {
      setNotice({ type: 'error', lines: [`Import failed: ${err.message}`] });
    } finally {
      setBusy(false);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? responders.filter((r) => r.name.toLowerCase().includes(q)) : responders;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [responders, query]);

  const supervisors = responders.filter((r) => r.role === 'supervisor').length;
  const bilingual = responders.filter((r) => r.bilingual).length;
  const reduced = responders.filter((r) => r.hours === REDUCED_HOURS).length;

  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Users size={18} /> Roster
          </span>
        }
        subtitle={`${responders.length} responder${responders.length === 1 ? '' : 's'} entered`}
        actions={
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {responders.length === 0 && (
              <Button
                variant="outline"
                onClick={() =>
                  loadAll(SAMPLE_RESPONDERS(), SAMPLE_AVOIDANCE_PAIRS(), SAMPLE_PREFERRED_PAIRS())
                }
              >
                <Database size={15} /> Load sample team
              </Button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={handleImportFile}
            />
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={15} /> Import
            </Button>
            {responders.length > 0 && (
              <Button variant="outline" disabled={busy} onClick={handleExport}>
                <Download size={15} /> Export
              </Button>
            )}
            {responders.length > 0 && (
              <Button
                variant="ghost"
                onClick={() => {
                  if (window.confirm('Remove all responders? This cannot be undone.')) clearAll();
                }}
              >
                <Trash2 size={15} /> Clear all
              </Button>
            )}
          </div>
        }
      />
      <CardBody className="!px-0 !py-0">
        {notice && (
          <div
            className={`px-4 py-3 border-b text-sm flex items-start gap-2 ${
              notice.type === 'error'
                ? 'bg-danger-50 text-danger-700 border-danger-100'
                : notice.type === 'warning'
                ? 'bg-warning-50 text-warning-700 border-warning-100'
                : 'bg-success-50 text-success-700 border-success-100'
            }`}
          >
            {notice.type !== 'success' && <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
            <div className="space-y-0.5">
              {notice.lines.map((line, i) => (
                <p key={i} className={i === 0 ? 'font-medium' : ''}>
                  {line}
                </p>
              ))}
            </div>
            <button
              className="ml-auto text-xs underline opacity-70 hover:opacity-100"
              onClick={() => setNotice(null)}
            >
              Dismiss
            </button>
          </div>
        )}
        {responders.length > 0 && (
          <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2 flex-wrap">
            <Badge color="blue">{supervisors} supervisors</Badge>
            <Badge color="green">{bilingual} bilingual</Badge>
            <Badge color="amber">{reduced} at 6h</Badge>
            <input
              className="form-input ml-auto max-w-[220px] !py-1.5 text-sm"
              placeholder="Search by name…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-gray-400">
            {responders.length === 0
              ? 'No responders yet. Add them above, or load the sample team to try the scheduler.'
              : 'No responders match your search.'}
          </div>
        ) : (
          <div className="divide-y divide-gray-100 max-h-[460px] overflow-y-auto">
            {filtered.map((r) => (
              <div key={r.id} className={editingId === r.id ? 'bg-primary-50' : ''}>
                <ResponderCard responder={r} onEdit={onEdit} onRemove={removeResponder} />
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
