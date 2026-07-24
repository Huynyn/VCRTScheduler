## Quick start
Need [Node.js](https://nodejs.org/) 18 or newer.

```bash
npm install      # install dependencies (first time only)
npm run dev       # start the local dev server
```

Then open the URL it prints (default **http://localhost:5173**).

Tests (plain Node, no framework):

```bash
node test/solve.mjs    # solver: coverage, rules, pairing, best-effort mode
node test/import.mjs   # Microsoft Forms / Excel importer
```

To try it immediately:

1. Click **Load sample team** to populate a realistic 48-person roster.
2. Click **Generate schedule**.
3. Click **Download PDF** to save the top three schedules.

Other commands:

```bash
npm run build     # production build into dist/
npm run preview   # preview the production build locally
```

---
### Special requests are flagged, never auto-applied

Four answers are treated as **requests that need a coordinator's decision**, and
the importer holds them:

| Request | Approve | Decline |
|---|---|---|
| **6-hour week** | one 6h day shift | standard 12h week |
| **Non-negotiable ("super high priority") shifts** | locked in — always scheduled | downgraded to **high preference** (not discarded) |
| **Would like to work with X** | adds a *Schedule together* rule | no rule |
| **Would rather not work with X** | adds a *Keep apart* rule | no rule |


---
## How it works

### The rules it enforces

- **Shifts.** Each day has three shifts: `08:00–14:00` (6h), `14:00–20:00`
  (6h), and `20:00–08:00` overnight (12h). Seven days × three shifts = 21
  shifts per week.
- **Hours.** Every responder works **exactly 12 hours**, which means either
  **two day shifts** or **one overnight shift**. A few designated people work
  **6 hours** (one day shift).
- **Coverage.** Every shift must have **3 or 4 responders**, including **at
  least one supervisor** and **at least one bilingual** responder (one person
  can satisfy both).
- **Preferences.** Four levels per slot: **non-negotiable**, **high
  preference**, **available**, and **not available** (the default). A
  responder is never placed in a "not available" slot, and every
  "non-negotiable" slot they mark is always honoured.

### Soft rules (preferences, not hard requirements)

These nudge the schedule and ranking but never block generation:

- **A balanced gender mix on every overnight.** Each `20:00–08:00` shift
  should ideally include **at least one male and at least one female**
  responder. It's treated as nice-to-have on any night and a **priority on
  Thursday, Friday, Saturday and Sunday**. The solver actively fills these gaps
  and the top-three ranking favours schedules that satisfy them; the on-screen
  grid and the PDF show **M** / **F** indicators and "overnights with a male /
  female" counts. (A `Gender` field on each responder feeds this rule only.)
- **Pairing rules.** The **Pairing rules** panel (step 2, below the roster) has
  two sides, both soft:
  - **Keep apart** — pairs who should not share a shift. The solver avoids
    putting them together, breaks the rule only when nothing else works, and
    calls out any remaining overlaps in the weekly grid ("⚠ pair").
  - **Schedule together** — pairs the coordinator would *like* on the same
    shift. A pair counts as matched as soon as they **share one shift**; for a
    12h responder working two day shifts, matching only one of the two is
    enough. It is deliberately the weakest rule in the model: it is worth
    slightly more than one honoured high preference, so the solver will trade at
    most one person's high-preference slot to bring a pair together, and it will
    **never** trade coverage, a supervisor, a bilingual responder or a "keep
    apart" rule for it. Unmatched pairs are simply reported (the
    "Pairs scheduled together" metric, e.g. `4/5`) rather than blocking
    anything.
- **Weekend doubles.** The solver avoids giving anyone **two weekend day
  shifts** in the same week (i.e. both of their two day shifts landing on
  Sat/Sun). This is a soft preference, tracked in the "weekend doubles" tally.

### Hard rule: rest period between shifts

Nobody is ever placed on a **14:00–20:00 shift followed by the next
morning's 08:00–14:00** — the ~12 hours between them is too short for a
reasonable turnaround. This is enforced by removing those pattern
combinations from a responder's set of possible weekly patterns. If a
responder's non-negotiables force such a pairing, the feasibility report
flags them as unschedulable so the coordinator can adjust their
availability.

### When a valid schedule isn't possible: best-effort mode

If no schedule can be built that satisfies every hard rule, the solver
**doesn't stop** — it returns the **closest partial schedules** so the
coordinator can see how bad the gap is, and a **"who to contact"** panel
listing the responders most likely to unlock a valid schedule if they add
some availability. Priorities when suggesting contacts:

1. Missing supervisor on a shift (hardest to substitute).
2. Missing bilingual on a shift.
3. Not enough people on a shift.

- **Sensible use of non-negotiables.** A responder is **flagged** (a warning,
  not an error) if their non-negotiables look over-used — specifically if they
  mark **more than 12h** as non-negotiable, or mark **6h+** non-negotiable
  while still listing **more than 12h of other availability**. The idea is that
  "non-negotiable" should mean "I have no other option," so the flag prompts
  the coordinator to double-check. Flags appear live in the form, on the
  roster card, and in the feasibility report.

### The matching strategy (requirement 6)

The scheduler places people in priority order:

1. **Non-negotiables first** — these are locked in before anything else.
2. **Supervisors and bilingual responders first**, because they're the
   scarcest resource (every shift needs them). This keeps the schedule from
   painting itself into a corner.
3. **High-preference slots** are strongly favoured when filling the rest.

**Randomized greedy solver with restarts and a repair
pass**. It builds many candidate schedules, keeps only the fully valid ones,
de-duplicates them, scores each (rewarding honoured high-preferences and
balanced coverage), and returns the three best distinct schedules.

"Schedule together" pairs get two extra nudges, because a plain greedy
actively *spreads* people out (an empty shift is always hungrier than one your
partner is already on):

1. **Partner-adjacent ordering** — a pair's second member is placed immediately
   after the first, while their partner's shift still has room.
2. **A polish pass on the best candidates** — for any still-unmatched pair the
   solver tries (a) **swapping** two responders' whole weekly patterns, which
   leaves every shift's head count untouched, and (b) moving one member across
   and letting the repair pass backfill. A change is kept **only if the full
   schedule score improves**, so a pairing can never quietly cost coverage.

> **Note on the approach.** This is a fast heuristic, not an exhaustive
> optimizer. For a 45–50 person team with reasonable availability it finds
> valid schedules reliably. If the constraints are genuinely impossible (e.g.
> not enough supervisors available overnight), it won't invent a solution —
> it tells you *why* (see below).

### When no schedule is possible (requirement 7)

Before solving, the app runs a **feasibility check** that catches provable
dead-ends and explains them in plain language, for example:

- a responder whose marked slots can't add up to a legal 12h/6h pattern,
- not enough total available hours to cover all 21 shifts,
- a shift with no available supervisor or no available bilingual responder,
- too few people available for a given shift.

It also surfaces **warnings** (e.g. a shift with exactly the minimum number
of available people) so you can loosen those slots before generating.

If the solver still can't assemble a schedule after exhausting its attempts,
it reports that and suggests opening up more "not available" slots —
especially overnight and weekend shifts, which are usually the tightest.

---

## Project structure

```
vcrt-scheduler/
├── index.html
├── package.json
├── docs/
│   ├── POWER_AUTOMATE.md                       ← Form → Excel → scheduler setup
│   └── VCRT-availability-responses-template.xlsx
├── vite.config.js
├── tailwind.config.js        ← colours, fonts (rebrand here)
├── postcss.config.js
└── src/
    ├── main.jsx               app entry
    ├── App.jsx                layout + top-level state
    ├── index.css              Tailwind layers + component classes
    ├── constants/
    │   └── schedule.js        shifts, days, hours, preference levels, limits
    ├── context/
    │   └── ResponderContext.jsx  roster state + localStorage persistence
    ├── hooks/
    │   └── useLocalStorage.js
    ├── data/
    │   └── sampleData.js      "Load sample team" generator (48 people)
    ├── lib/                   ← the scheduling engine (no UI)
    │   ├── formImport.js      Microsoft Forms / Excel importer + request flagging
    │   ├── patterns.js        legal 12h/6h shift combinations per person
    │   ├── feasibility.js     provable-impossibility checks + warnings
    │   ├── scheduler.js       the solver (greedy + restarts + repair)
    │   ├── scoring.js         schedule scoring + de-duplication
    │   ├── suggestions.js     "who to contact" list for best-effort mode
    │   └── pdfExport.js       VCRT-ÉBIC weekly-grid PDF
    └── components/
        ├── common/            Badge, Button, Card
        ├── layout/            Header (garnet bar), Footer
        ├── responders/        ResponderForm, PreferenceGrid, ResponderList,
        │                      PairingRules (keep apart / schedule together),
        │                      ImportPanel (Forms/Excel import + request review)…
        └── scheduling/        SchedulePanel, ScheduleResults, FeasibilityReport…
```

### Where to change things

- **Change shift times, hours, or coverage limits** → `src/constants/schedule.js`.
- **Tune the solver** (how hard it tries, how it scores) →
  `src/lib/scheduler.js` and `src/lib/scoring.js`.
- **Change the PDF layout or legend** → `src/lib/pdfExport.js`.
- **Add a new responder attribute** → extend `makeResponder` in
  `src/context/ResponderContext.jsx` and the form in
  `src/components/responders/ResponderForm.jsx`.

---
