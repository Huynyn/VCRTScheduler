import { useEffect, useRef, useState } from 'react';
import { Wand2, Loader2 } from 'lucide-react';
import { Card, CardBody } from '../common/Card.jsx';
import Button from '../common/Button.jsx';
import FeasibilityReport from './FeasibilityReport.jsx';
import ScheduleResults from './ScheduleResults.jsx';
import UnlockPanel from './UnlockPanel.jsx';
import { useResponders } from '../../context/ResponderContext.jsx';

// The solve runs in a Web Worker (keeps the UI responsive) and drives a real
// progress bar. It has two phases: first it hunts for the best complete
// schedule; then, if none is fully valid, it runs a thorough reach-out search —
// actually re-solving the week many times to find who to contact so a complete
// schedule becomes possible. Both get generous budgets: a correct, thorough
// answer is worth the wait, and the bar tells the user it's still working.
const TIME_BUDGET_MS = 8000; // phase 1: search for complete schedules
const REACHOUT_BUDGET_MS = 45000; // phase 2: reach-out search (only if needed)

export default function SchedulePanel() {
  const { responders, avoidancePairs, preferredPairs } = useResponders();
  const [status, setStatus] = useState('idle'); // idle | running | done
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState(0);
  const workerRef = useRef(null);

  // Tidy up the worker if the component unmounts mid-solve.
  useEffect(() => () => workerRef.current?.terminate(), []);

  const run = () => {
    workerRef.current?.terminate();
    setStatus('running');
    setResult(null);
    setProgress(0);

    const worker = new Worker(new URL('../../lib/solver.worker.js', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        setProgress(msg.fraction);
      } else if (msg.type === 'result') {
        setResult(msg.result);
        setProgress(1);
        setStatus('done');
        worker.terminate();
        workerRef.current = null;
      } else if (msg.type === 'error') {
        setResult({ ok: false, errors: [`Something went wrong while solving: ${msg.message}`], schedules: [] });
        setStatus('done');
        worker.terminate();
        workerRef.current = null;
      }
    };

    worker.postMessage({
      responders,
      options: {
        timeBudgetMs: TIME_BUDGET_MS,
        reachoutBudgetMs: REACHOUT_BUDGET_MS,
        avoidancePairs,
        preferredPairs,
      },
    });
  };

  const pct = Math.round(progress * 100);

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-secondary-700">Build the weekly schedule</h2>
              <p className="text-sm text-gray-500">
                Honours non-negotiables first, then high preferences, prioritising supervisors and
                bilingual responders, while respecting your pairing rules. Generates up to 20 of the
                best options; any that can't be fully staffed come with the exact change(s) that
                would make a complete schedule possible.
              </p>
            </div>
            <Button
              variant="primary"
              onClick={run}
              disabled={status === 'running' || responders.length === 0}
              className="shrink-0"
            >
              {status === 'running' ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> Building…
                </>
              ) : (
                <>
                  <Wand2 size={16} /> Generate schedule
                </>
              )}
            </Button>
          </div>

          {status === 'running' && (
            <div>
              <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary-500 transition-[width] duration-200 ease-out"
                  style={{ width: `${Math.max(pct, 4)}%` }}
                />
              </div>
              <div className="mt-1.5 flex items-center justify-between text-xs text-gray-500">
                <span>
                  {progress < 0.5
                    ? 'Searching for the best complete schedules…'
                    : 'Working out who to contact so every shift can be filled…'}
                </span>
                <span className="tabular-nums">{pct}%</span>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      {status === 'done' && result && (
        <>
          {(result.errors?.length > 0 || result.warnings?.length > 0) && (
            <FeasibilityReport errors={result.errors} warnings={result.warnings} />
          )}
          {result.schedules?.length > 0 && <ScheduleResults result={result} />}
          {!result.ok && <UnlockPanel result={result} />}
        </>
      )}
    </div>
  );
}
