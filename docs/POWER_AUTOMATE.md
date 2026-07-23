# Microsoft Form → Excel → Scheduler

Yes, this works end to end, and it needs no code on the Microsoft side — one
Power Automate flow with three actions.

```
Microsoft Form            Power Automate                Excel (SharePoint/OneDrive)        VCRT Scheduler
┌──────────────┐          ┌───────────────────┐         ┌────────────────────────┐         ┌───────────────────┐
│ responder    │  submit  │ 1 new response    │         │ VCRT-availability-     │  down-  │ Import from       │
│ fills in     ├─────────►│ 2 get details     ├────────►│ responses.xlsx         ├────────►│ Microsoft Forms   │
│ availability │          │ 3 add row → table │  1 row  │ table "Responses"      │  load   │ → review requests │
└──────────────┘          └───────────────────┘         └────────────────────────┘         └───────────────────┘
```

Three files matter:

| File | What it is |
|---|---|
| `docs/VCRT-availability-responses-template.xlsx` | The workbook the flow writes into. Sheet **Responses**, table **Responses**. Upload it to SharePoint/OneDrive as-is. |
| This document | The form questions and the flow. |
| `src/lib/formImport.js` | The scheduler's parser. It matches on **header text**, so keep the headers as they are. |

---

## 1. Build the Microsoft Form

Create a form called **VCRT availability — [Semester] [Year]**. Turn on
*Settings → Record name* (or add an email question) so responses are identifiable.

| # | Question | Type | Choices / notes |
|---|---|---|---|
| 1 | Full name | Text (required) | Must match exactly how you'll refer to them — pairing requests are matched by name. |
| 2 | uOttawa email | Text (required) | |
| 3 | Role | Choice (required) | `Supervisor`, `Returner`, `New member` |
| 4 | Are you a French + English (bilingual) speaker? | Choice (required) | `Yes`, `No` |
| 5 | Gender | Choice | `Male`, `Female`, `Other`, `Prefer not to say` — used only for the overnight-mix preference. |
| 6 | How many hours can you work this term? | Choice (required) | `12 hours`, `6 hours (reduced)` — **6h is a flagged request.** |
| 7 | If you asked for 6 hours, why? | Long text | |
| 8 | Which shifts **can** you work? | **Choice, multiple answers** (required) | The 21 shift labels — copy them from the **Shift options** sheet of the template. |
| 9 | Which shifts would you **most like** to work? | **Choice, multiple answers** | Same 21 choices. High preference. |
| 10 | Are any shifts **non-negotiable** (you can work nothing else)? | **Choice, multiple answers** | Same 21 choices. **Flagged request.** Add the help text: *"Only use this if you genuinely have no other option."* |
| 11 | Why are those shifts non-negotiable? | Long text | |
| 12 | Is there someone you'd like to be scheduled **with**? | Text | Full name. **Flagged request.** |
| 13 | Is there someone you'd rather **not** be scheduled with? | Text | Full name. **Flagged request.** |
| 14 | If so, briefly, why? | Long text | Goes to the coordinator only. |
| 15 | Anything else we should know? | Long text | |

Questions 8–10 must be **"Multiple answers"** choice questions. That's what
makes Forms hand Power Automate a list, which the flow joins into one cell.

---

## 2. Put the workbook somewhere the flow can reach

1. Upload `VCRT-availability-responses-template.xlsx` to the team's SharePoint
   site or OneDrive for Business (not a personal OneDrive if others need it).
2. Rename it to something like `VCRT-availability-Fall2026.xlsx` — one workbook
   per term.
3. Open it once in Excel Online and **delete the grey example row**. Leave the
   header row and the table itself alone.

The table is already defined and named `Responses`; Power Automate can only add
rows to a real Excel *table*, which is why the template exists.

---

## 3. Build the flow

**Power Automate → Create → Automated cloud flow.**

### Trigger — *Microsoft Forms: When a new response is submitted*
- **Form Id**: your form.

### Action 1 — *Microsoft Forms: Get response details*
- **Form Id**: the same form.
- **Response Id**: the `Response Id` dynamic token from the trigger.

### Action 2 — *Excel Online (Business): Add a row into a table*
- **Location**: the SharePoint site (or OneDrive).
- **Document Library**: `Documents` (or wherever you uploaded it).
- **File**: `VCRT-availability-Fall2026.xlsx`.
- **Table**: `Responses`.

Then map the columns. Single-answer questions are drag-and-drop dynamic
content. The three multi-answer questions need one expression each, because
Forms returns them as a JSON array.

| Excel column | Value |
|---|---|
| Submitted at | dynamic: **Submission time** |
| Email | dynamic: **Responders' Email** (or your email question) |
| Full name | dynamic: *Full name* |
| Role | dynamic: *Role* |
| Bilingual | dynamic: *bilingual speaker* |
| Gender | dynamic: *Gender* |
| Weekly hours | dynamic: *How many hours…* |
| Reduced hours reason | dynamic: *If you asked for 6 hours, why?* |
| Available shifts | **expression** (below) |
| High preference shifts | **expression** (below) |
| Non-negotiable shifts | **expression** (below) |
| Non-negotiable reason | dynamic: *Why are those shifts non-negotiable?* |
| Prefer to work with | dynamic: *scheduled with* |
| Prefer not to work with | dynamic: *rather not be scheduled with* |
| Prefer not to work with reason | dynamic: *If so, briefly, why?* |
| Notes | dynamic: *Anything else…* |

### The expression for a multi-answer question

In the value box choose **Expression** and paste this, then swap in the right
question:

```
if(
  empty(outputs('Get_response_details')?['body/r1a2b3c4d5e6f']),
  '',
  join(json(outputs('Get_response_details')?['body/r1a2b3c4d5e6f']), '; ')
)
```

- `r1a2b3c4d5e6f` is the **question id**. Don't type it from memory: put the
  cursor inside the expression, switch to the **Dynamic content** tab, click the
  question, and Power Automate pastes the correct `outputs(...)` reference for
  you — then wrap it in `if(empty(…), '', join(json(…), '; '))`.
- If you renamed the *Get response details* action, use its name with spaces
  replaced by underscores.
- `json()` turns Forms' `["Monday 08:00 - 14:00","Friday 20:00 - 08:00"]` into a
  real array; `join(…, '; ')` collapses it into the single cell the importer
  expects. The separator must be `;` (the importer also tolerates newlines and
  `|`).

Save, submit a test response, and confirm a row lands in the table.

### Optional — Action 3: tell the coordinator when something needs a decision

Add *Office 365 Outlook: Send an email (V2)* after the Excel step, wrapped in a
**Condition** with this expression set to `is equal to` `true`:

```
or(
  contains(outputs('Get_response_details')?['body/<hours question id>'], '6 hours'),
  not(empty(outputs('Get_response_details')?['body/<non-negotiable question id>'])),
  not(empty(outputs('Get_response_details')?['body/<work with question id>'])),
  not(empty(outputs('Get_response_details')?['body/<not work with question id>']))
)
```

This is only a heads-up. The decision itself happens in the scheduler, where
you can see the request in the context of everyone else's.

---

## 4. Import into the scheduler

When the form closes: **Download a copy** of the workbook, open the scheduler,
and drop the file on **Import from Microsoft Forms** (step 1).

What the importer does with each answer:

| Answer | Effect |
|---|---|
| Name, role, bilingual, gender | Applied directly. |
| "Which shifts can you work" | → **Available** |
| "Which shifts would you most like" | → **High preference** (implies available) |
| **6-hour week** | **Held.** Approve → 6h. Decline → standard 12h week. |
| **Non-negotiable shifts** | **Held.** Approve → locked in. Decline → downgraded to **high preference**, never silently dropped. |
| **Prefer to work with X** | **Held.** Approve → a *Schedule together* rule. |
| **Prefer not to work with X** | **Held.** Approve → a *Keep apart* rule. |

The four held items appear as a **review list** with the person's stated reason
and the row number they came from. Nothing takes effect until you Approve or
Decline it, and anything you leave undecided is treated as declined — a request
can never sneak into the schedule unreviewed. Approve or decline them one at a
time, or use *Approve all* / *Decline all*.

The importer also reports anything it couldn't read: a shift label it didn't
recognise, or a "work with" name that isn't among the responses (usually a
typo, or someone who never submitted the form).

**Importing replaces the roster.** Import first, then hand-edit anyone whose
answers need fixing.

---

## Notes and limits

- **Names are the join key.** "Ben Okafor" and "ben okafor" match; "B. Okafor"
  does not. Asking for full names on the form (question 1) is what keeps the
  pairing requests resolvable.
- **Duplicate submissions**: the flow appends a row every time. If someone
  submits twice, delete the older row from the table before downloading.
- **CSV works too.** If you'd rather export the form straight to CSV, the
  importer accepts it — the column headers just have to match.
- **Header matching is forgiving.** Case, punctuation and any trailing
  parenthetical are ignored, so `Bilingual (English & French)` still matches the
  `Bilingual` column. Adding extra columns is fine; they're ignored.
