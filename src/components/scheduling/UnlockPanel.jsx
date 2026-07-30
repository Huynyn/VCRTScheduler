import { useState } from 'react';
import { KeyRound, PhoneCall, UserPlus, Lock, ChevronDown, Users } from 'lucide-react';
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
          Their current availability can't form a full, legal week (a 12h responder needs two day
          shifts or one overnight; a 6h responder needs one day shift). Each needs to open up more
          availability - see the specific reason for each person in the report above.
        </div>
      </div>
    </div>
  );
}

// One shift that a single person could complete. Every person who could unlock
// it is a clickable chip: selecting one shows the exact schedule that results if
// THAT person is the one to open up the shift, so the coordinator can compare
// options before making a call.
function SingleFix({ fix, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const [selectedId, setSelectedId] = useState(fix.people[0]?.id);
  const selected = fix.people.find((p) => p.id === selectedId) || fix.people[0];
  // Each person carries their own resulting schedule; older results only had a
  // single shared one, so fall back to it.
  const shownSchedule = selected?.schedule || fix.schedule;
  return (
    <div className="rounded-lg border border-success-200 overflow-hidden">
      <div className="bg-success-50/60 px-3 py-2.5">
        <div className="text-sm text-secondary-700">
          {fix.indirect ? (
            <>
              Opening <span className="font-semibold">{fix.slotLabel}</span> completes the week - this
              shift isn&apos;t short itself, but opening it resolves the conflict that&apos;s blocking a
              full schedule. It works if <span className="font-semibold">any one</span> of these opens
              up that shift - <span className="font-medium">click a name</span> to see the schedule it
              produces:
            </>
          ) : (
            <>
              <span className="font-semibold">{fix.slotLabel}</span> is short {fix.needLabel}. It
              becomes possible if <span className="font-semibold">any one</span> of these opens up that
              shift - <span className="font-medium">click a name</span> to see the schedule it produces:
            </>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {fix.people.map((p) => {
            const isSel = p.id === selected?.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setSelectedId(p.id);
                  setOpen(true);
                }}
                aria-pressed={isSel}
                className={`inline-flex items-center rounded-md border px-2 py-0.5 text-sm transition-colors ${
                  isSel
                    ? 'border-success-500 bg-success-500 text-white'
                    : 'border-success-200 bg-white text-secondary-700 hover:bg-success-50'
                }`}
              >
                {p.name}
                {!isSel && <PersonTags person={p} />}
              </button>
            );
          })}
        </div>
      </div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-secondary-700 border-t border-success-100"
      >
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        {open ? 'Hide' : 'Show'} the schedule this creates (with{' '}
        <span className="font-medium">{selected?.name}</span> on {fix.slotLabel})
      </button>
      {open && shownSchedule && (
        <div className="p-3 border-t border-success-100">
          <ScheduleTable schedule={shownSchedule} />
        </div>
      )}
    </div>
  );
}

// When no single change is enough, the week needs SEVERAL shifts opened together.
// For each such shift we show EVERYONE who could open it as part of a complete fix
// (not one example), so the coordinator sees the full menu and can pick any one
// person per shift. Clicking a name shows the exact schedule that choice produces.
function MultiFix({ fix }) {
  const slots = fix.slots || [];
  const [open, setOpen] = useState(true);
  const [sel, setSel] = useState(() => {
    const first = slots.find((s) => s.people.length);
    return first ? { slot: first.slot, id: first.people[0].id } : null;
  });
  if (slots.length === 0) return null;

  let selPerson = null;
  for (const s of slots) {
    if (s.slot !== sel?.slot) continue;
    const p = s.people.find((x) => x.id === sel?.id);
    if (p) selPerson = { ...p, slotLabel: s.slotLabel };
  }
  const shown = selPerson?.schedule || fix.schedule;

  return (
    <div className="rounded-lg border border-success-200 overflow-hidden">
      <div className="bg-success-50/60 px-3 py-2.5">
        <div className="text-sm text-secondary-700 mb-2">
          No single change is enough - you&apos;ll need to open <span className="font-semibold">all {slots.length}</span>{' '}
          of these shifts. For each, here&apos;s <span className="font-semibold">everyone</span> who could open it
          as part of a complete fix - <span className="font-medium">click a name</span> to see the schedule it
          produces (pick any one person per shift):
        </div>
        <div className="space-y-2.5">
          {slots.map((s) => (
            <div key={s.slot}>
              <div className="text-xs font-semibold text-secondary-700 mb-1">
                {s.slotLabel}
                {s.count > 1 ? ` - needs ${s.count} people` : ''}{' '}
                <span className="font-normal text-gray-500">- any of ({s.people.length}):</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {s.people.map((p) => {
                  const isSel = sel?.id === p.id && sel?.slot === s.slot;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setSel({ slot: s.slot, id: p.id });
                        setOpen(true);
                      }}
                      aria-pressed={isSel}
                      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-sm transition-colors ${
                        isSel
                          ? 'border-success-500 bg-success-500 text-white'
                          : 'border-success-200 bg-white text-secondary-700 hover:bg-success-50'
                      }`}
                    >
                      {p.name}
                      {!isSel && <PersonTags person={p} />}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-secondary-700 border-t border-success-100"
      >
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        {open ? 'Hide' : 'Show'} the schedule this creates
        {selPerson ? ` (with ${selPerson.name} on ${selPerson.slotLabel})` : ''}
      </button>
      {open && shown && (
        <div className="p-3 border-t border-success-100">
          <ScheduleTable schedule={shown} />
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
// unlocks - "open this shift and THIS complete schedule becomes possible" - and
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
            subtitle="Even if everyone opened up all of their availability, the roster is too small to cover the week (e.g., not enough supervisor hours). At a minimum, add:"
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
            subtitle="Every shift is covered, but these responders can't be given a full, legal week from their current availability (a 12h responder needs two day shifts or one overnight). They'll each need to open up more availability to be included - the report above says exactly what each one needs."
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
            Below is an example shift that becomes possible if you ask these people to open up their
            availability. Every schedule shown still obeys all the original rules - including that
            each person works their <strong>exact</strong> weekly commitment (6h or 12h, never under
            or over).
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
