import { useState } from 'react';
import { KeyRound, PhoneCall, UserPlus, ArrowRight, Lock, ChevronDown, Users } from 'lucide-react';
import { Card, CardHeader, CardBody } from '../common/Card.jsx';
import ScheduleTable from './ScheduleTable.jsx';

function PersonTags({ person }) {
  return (
    <>
      {person.role === 'supervisor' && (
        <span className="ml-1 text-[11px] text-primary-600 font-medium">Supervisor</span>
      )}
      {person.bilingual && (
        <span className="ml-1 text-[11px] text-success-600 font-medium italic">Bilingual</span>
      )}
    </>
  );
}

function UnplacedNote({ unplaced }) {
  if (!unplaced?.length) return null;
  return (
    <div className="mt-4 flex items-start gap-2 rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-secondary-700">
      <UserPlus size={15} className="mt-0.5 shrink-0 text-warning-600" />
      <div>
        <span className="font-semibold">Not scheduled at all:</span>{' '}
        {unplaced.map((p) => p.name).join(', ')}.
        <div className="text-xs text-gray-500 mt-0.5">
          They have no availability that fits an open shift, so they'll each need to open up at
          least one shift to be included.
        </div>
      </div>
    </div>
  );
}

// One shift that a single person could complete, with everyone who could and a
// sample of the schedule it produces.
function SingleFix({ fix, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-success-200 overflow-hidden">
      <div className="bg-success-50/60 px-3 py-2.5">
        <div className="text-sm text-secondary-700">
          <span className="font-semibold">{fix.slotLabel}</span> is short {fix.needLabel}. It becomes
          possible if <span className="font-semibold">any one</span> of these opens up that shift:
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {fix.people.map((p) => (
            <span
              key={p.id}
              className="inline-flex items-center rounded-md border border-success-200 bg-white px-2 py-0.5 text-sm text-secondary-700"
            >
              {p.name}
              <PersonTags person={p} />
            </span>
          ))}
        </div>
      </div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-secondary-700 border-t border-success-100"
      >
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        {open ? 'Hide' : 'Show'} the schedule this creates (with {fix.people[0].name} on{' '}
        {fix.slotLabel})
      </button>
      {open && (
        <div className="p-3 border-t border-success-100">
          <ScheduleTable schedule={fix.schedule} />
        </div>
      )}
    </div>
  );
}

// A minimal SET of changes (one person per short shift) that together completes
// the week — shown when no single change is enough on its own.
function MultiFix({ fix }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-lg border border-success-200 overflow-hidden">
      <div className="bg-success-50/60 px-3 py-2.5">
        <div className="text-sm font-medium text-secondary-700 mb-1">
          No single change is enough, but these {fix.asks.length} together complete the week:
        </div>
        <ul className="space-y-1">
          {fix.asks.map((a) => (
            <li key={a.slot} className="flex items-start gap-2 text-sm text-secondary-700">
              <ArrowRight size={15} className="mt-0.5 shrink-0 text-success-600" />
              <span>
                Ask <span className="font-semibold">{a.person.name}</span>
                <PersonTags person={a.person} /> to open{' '}
                <span className="font-semibold">{a.slotLabel}</span> (a {a.addedHours}h shift).
              </span>
            </li>
          ))}
        </ul>
      </div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-secondary-700 border-t border-success-100"
      >
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        {open ? 'Hide' : 'Show'} the schedule this creates
      </button>
      {open && (
        <div className="p-3 border-t border-success-100">
          <ScheduleTable schedule={fix.schedule} />
        </div>
      )}
    </div>
  );
}

// A short, plain-language list of the extra people the roster is missing when a
// complete schedule is impossible no matter how availability is rearranged.
function CapacityShortfall({ capacity }) {
  if (!capacity?.reasons?.length) return null;
  return (
    <ul className="space-y-1.5">
      {capacity.reasons.map((reason) => (
        <li key={reason} className="flex items-start gap-2 text-sm text-secondary-700">
          <UserPlus size={15} className="mt-0.5 shrink-0 text-warning-600" />
          <span>{reason}</span>
        </li>
      ))}
    </ul>
  );
}

// Shown when no complete schedule is possible. Leads with concrete, verified
// unlocks — "open this shift and THIS complete schedule becomes possible" — and
// otherwise says plainly what stands in the way (either a hard shortage of
// people, or that no availability change on the current roster is enough).
export default function UnlockPanel({ result }) {
  const reach = result.reachout;
  if (!reach) return null;

  const {
    singleFixes = [],
    multiFix = null,
    unplaced = [],
    gapCount = 0,
    capacity = { feasible: true, reasons: [] },
  } = reach;
  const hasFix = singleFixes.length > 0 || multiFix;

  // Nothing completes the week by opening availability. Explain why, honestly.
  if (!hasFix) {
    // 1) A hard head-count / role shortage: no availability change can ever fix
    //    it, and we can say exactly how many more people (and of what kind).
    if (!capacity.feasible) {
      return (
        <Card className="animate-fade-in border-warning-200">
          <CardHeader
            title={
              <span className="inline-flex items-center gap-2">
                <Users size={18} className="text-warning-600" /> You&apos;ll need to bring in more
                responders
              </span>
            }
            subtitle="Even if everyone opened up all of their availability, the roster is too small to cover the week. This isn't something a phone call can fix; you need more people. At a minimum, add:"
          />
          <CardBody className="space-y-4">
            <CapacityShortfall capacity={capacity} />
            <UnplacedNote unplaced={unplaced} />
          </CardBody>
        </Card>
      );
    }

    // 2) Everyone's placed and every shift is covered, but a responder can't be
    //    slotted anywhere they're available.
    if (gapCount === 0 && unplaced.length > 0) {
      return (
        <Card className="animate-fade-in border-warning-200">
          <CardHeader
            title={
              <span className="inline-flex items-center gap-2">
                <UserPlus size={18} className="text-warning-600" /> A few people can&apos;t be placed
              </span>
            }
            subtitle="Every shift is covered, but these responders have no availability that fits an open shift. They'll each need to open up at least one shift to be included."
          />
          <CardBody>
            <UnplacedNote unplaced={unplaced} />
          </CardBody>
        </Card>
      );
    }

    // 3) The roster is big enough in principle, but a thorough search found no
    //    combination of availability changes that completes the week.
    return (
      <Card className="animate-fade-in border-warning-200">
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <PhoneCall size={18} className="text-warning-600" /> Make a complete schedule possible
            </span>
          }
          subtitle={`The week is short in ${gapCount} ${
            gapCount === 1 ? 'place' : 'places'
          }. We searched the whole roster and every combination of availability changes we could, and none of them completes the week, so you'll likely need to bring in another responder.`}
        />
        <CardBody>
          <UnplacedNote unplaced={unplaced} />
        </CardBody>
      </Card>
    );
  }

  const fixableCount = singleFixes.length;

  return (
    <Card className="animate-fade-in border-success-200">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <KeyRound size={18} className="text-success-600" /> Make a complete schedule possible
          </span>
        }
        subtitle={
          fixableCount > 0
            ? `The week can't be fully staffed as-is, but ${
                fixableCount === 1 ? 'one shift can be' : `${fixableCount} shifts can each be`
              } covered by asking one person to open up their availability. Below is everyone who could complete ${
                fixableCount === 1 ? 'it' : 'each one'
              }, and the schedule that results.`
            : 'The week can’t be fully staffed as-is, but the small set of changes below completes it.'
        }
      />
      <CardBody className="space-y-3">
        <div className="flex items-start gap-2 text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
          <Lock size={14} className="mt-0.5 shrink-0 text-gray-400" />
          <span>
            Every ask below is only to <strong>open up one more shift</strong>, never to work extra
            hours beyond their week, and never to change their role, languages or gender. Each
            resulting schedule is fully staffed and keeps everyone within their weekly hours.
          </span>
        </div>

        {singleFixes.map((fix, i) => (
          <SingleFix key={fix.slot} fix={fix} defaultOpen={i === 0} />
        ))}

        {multiFix && <MultiFix fix={multiFix} />}

        <UnplacedNote unplaced={unplaced} />
      </CardBody>
    </Card>
  );
}
