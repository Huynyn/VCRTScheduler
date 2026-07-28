import { useState } from 'react';
import { Users, ChevronDown, Unlock } from 'lucide-react';
import { Card, CardHeader, CardBody } from '../common/Card.jsx';
import ScheduleTable from './ScheduleTable.jsx';

// Shown when the "keep apart" rules are themselves what's blocking a complete
// schedule: a fully valid week IS possible, but only if one or more keep-apart
// pairs are relaxed. Keep-apart is a hard rule, so we never silently break it —
// instead we tell the coordinator exactly which decision to reconsider and show
// the complete schedule that relaxing it unlocks.
export default function ApartBlockPanel({ apartBlock }) {
  const [open, setOpen] = useState(true);
  if (!apartBlock?.pairs?.length) return null;
  const { pairs, schedule } = apartBlock;
  const many = pairs.length > 1;

  return (
    <Card className="animate-fade-in border-warning-200">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Unlock size={18} className="text-warning-600" /> A “keep apart” rule is blocking a
            complete schedule
          </span>
        }
        subtitle={
          many
            ? 'A fully valid schedule is possible, but only if you relax keeping these pairs apart. Keep-apart is a hard rule, so nothing below forces them together — this is a decision for you to make.'
            : 'A fully valid schedule is possible, but only if you relax keeping this pair apart. Keep-apart is a hard rule, so nothing below forces them together — this is a decision for you to make.'
        }
      />
      <CardBody className="space-y-3">
        <ul className="space-y-1.5">
          {pairs.map((p) => (
            <li
              key={`${p.a}|${p.b}`}
              className="flex items-start gap-2 text-sm text-secondary-700"
            >
              <Users size={15} className="mt-0.5 shrink-0 text-warning-600" />
              <span>
                <span className="font-semibold">{p.names}</span> — their availability leaves no way
                to cover the week while also keeping them apart.
              </span>
            </li>
          ))}
        </ul>

        <div className="text-sm text-secondary-700">
          Your options: relax {many ? 'one of these keep-apart rules' : 'this keep-apart rule'}, or
          open up more availability (add hours for the people involved, or bring in another
          responder) so they no longer have to share a shift.
        </div>

        {schedule && (
          <div className="rounded-lg border border-success-200 overflow-hidden">
            <button
              onClick={() => setOpen((v) => !v)}
              className="w-full flex items-center gap-1 px-3 py-2 text-xs font-medium text-gray-600 hover:text-secondary-700 bg-success-50/60"
            >
              <ChevronDown
                size={14}
                className={`transition-transform ${open ? 'rotate-180' : ''}`}
              />
              {open ? 'Hide' : 'Show'} the complete schedule that relaxing{' '}
              {many ? 'these rules' : 'this rule'} unlocks
            </button>
            {open && (
              <div className="p-3 border-t border-success-100">
                <ScheduleTable schedule={schedule} />
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
