import {
  DAYS,
  DAY_LABELS,
  SHIFTS,
  slotId,
  parseSlot,
  ALL_SLOTS,
  PREF,
  ROLE_LABELS,
  ROLES,
  GENDERS,
  GENDER_LABELS,
  FULL_HOURS,
  REDUCED_HOURS,
} from '../constants/schedule.js';
import { makeResponder } from '../context/ResponderContext.jsx';

// ---------------------------------------------------------------------------
// Excel import / export for the responder roster.
//
// Export produces one workbook with:
//   • a "Summary" sheet — every responder as a row (ordered by scheduling
//     importance) and one column per shift, each cell a coloured box:
//       green = available, blue = high preference, red = non-negotiable.
//   • one sheet per responder — their details plus a day × shift availability
//     grid, each cell coloured the same way and labelled in text.
//
// Import reads that same workbook back. The per-responder sheets are the
// source of truth (they carry role, gender and hours, which the summary sheet
// does not), so the Summary sheet is skipped on the way in. Cells are read from
// their text label first, falling back to their fill colour.
// ---------------------------------------------------------------------------

// ExcelJS is a heavy dependency, only needed when the user actually imports or
// exports. Load it on demand so it stays out of the initial app bundle.
let _ExcelJS = null;
async function getExcelJS() {
  if (!_ExcelJS) _ExcelJS = (await import('exceljs')).default;
  return _ExcelJS;
}

const SUMMARY_SHEET = 'Summary';

// Cell fills, keyed by preference. These mirror the app's Tailwind palette
// (success-500 / primary-500 / danger-500) so the sheet matches the UI.
const PREF_FILL = {
  [PREF.AVAIL]: '16A34A', // green
  [PREF.HIGH]: '2563EB', // blue
  [PREF.NONNEG]: 'DC2626', // red
};

// Text written into each availability cell (per-responder sheets). Kept in sync
// with TEXT_TO_PREF below for round-tripping.
const PREF_TEXT = {
  [PREF.AVAIL]: 'Available',
  [PREF.HIGH]: 'High preference',
  [PREF.NONNEG]: 'Non-negotiable',
  [PREF.UNAVAIL]: '—',
};

const argb = (hex) => `FF${hex}`;
const WHITE = 'FFFFFFFF';
const GRID_BORDER = { style: 'thin', color: { argb: 'FFCBD5E1' } };
const ALL_BORDERS = {
  top: GRID_BORDER,
  left: GRID_BORDER,
  bottom: GRID_BORDER,
  right: GRID_BORDER,
};

// Leading (non-shift) columns on the Summary sheet.
const LEAD_COLS = ['Name', 'Role', 'Bilingual'];

// --- ordering ---------------------------------------------------------------

const ROLE_RANK = { supervisor: 0, returner: 1, rookie: 2 };

// Scheduling-importance tier, strongest first:
//   supervisor+bilingual, supervisor, returner+bilingual, returner,
//   rookie+bilingual, rookie.
export function importanceTier(r) {
  const role = ROLE_RANK[r.role] ?? ROLE_RANK.rookie;
  return role * 2 + (r.bilingual ? 0 : 1);
}

function byImportance(a, b) {
  const t = importanceTier(a) - importanceTier(b);
  if (t !== 0) return t;
  return (a.name || '').localeCompare(b.name || '');
}

// --- lookups for import -----------------------------------------------------

const TEXT_TO_PREF = {
  available: PREF.AVAIL,
  avail: PREF.AVAIL,
  'high preference': PREF.HIGH,
  high: PREF.HIGH,
  'non-negotiable': PREF.NONNEG,
  'non negotiable': PREF.NONNEG,
  nonnegotiable: PREF.NONNEG,
  'not available': PREF.UNAVAIL,
  unavailable: PREF.UNAVAIL,
  unavail: PREF.UNAVAIL,
  '—': PREF.UNAVAIL,
  '-': PREF.UNAVAIL,
  '': PREF.UNAVAIL,
};

const FILL_TO_PREF = Object.fromEntries(
  Object.entries(PREF_FILL).map(([pref, hex]) => [hex.toUpperCase(), pref])
);

// "Supervisor" -> "supervisor"; tolerant of the form's "New member" wording.
const ROLE_FROM_LABEL = (() => {
  const map = {};
  for (const r of ROLES) map[r.label.toLowerCase()] = r.id;
  map['new member'] = 'rookie';
  map['new'] = 'rookie';
  return map;
})();

const GENDER_FROM_LABEL = (() => {
  const map = {};
  for (const g of GENDERS) map[g.label.toLowerCase()] = g.id;
  map['prefer not to say'] = 'unspecified';
  return map;
})();

const norm = (v) => String(v ?? '').trim();
const normLower = (v) => norm(v).toLowerCase();

// --- export -----------------------------------------------------------------

function styleHeaderCell(cell) {
  cell.font = { bold: true, color: { argb: WHITE }, size: 11 };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb('475569') } };
  cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  cell.border = ALL_BORDERS;
}

function paintPrefCell(cell, pref, { withText } = {}) {
  cell.alignment = { horizontal: 'center', vertical: 'middle' };
  cell.border = ALL_BORDERS;
  if (pref === PREF.UNAVAIL) {
    if (withText) {
      cell.value = PREF_TEXT[PREF.UNAVAIL];
      cell.font = { color: { argb: argb('94A3B8') } };
    }
    return;
  }
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(PREF_FILL[pref]) } };
  cell.font = { color: { argb: WHITE }, bold: true, size: withText ? 10 : 11 };
  if (withText) cell.value = PREF_TEXT[pref];
}

function buildSummarySheet(wb, ordered) {
  const ws = wb.addWorksheet(SUMMARY_SHEET, {
    views: [{ state: 'frozen', xSplit: LEAD_COLS.length, ySplit: 4 }],
  });
  const firstShiftCol = LEAD_COLS.length + 1; // 1-based

  // Row 1: title across the whole grid.
  const totalCols = LEAD_COLS.length + ALL_SLOTS.length;
  ws.mergeCells(1, 1, 1, totalCols);
  const title = ws.getCell(1, 1);
  title.value = 'VCRT Responders — Availability & Preferences';
  title.font = { bold: true, size: 14, color: { argb: argb('8D1D2C') } };
  title.alignment = { horizontal: 'left', vertical: 'middle' };

  // Row 2: colour legend.
  ws.mergeCells(2, 1, 2, totalCols);
  const legend = ws.getCell(2, 1);
  legend.value =
    'Legend:   green = Available    blue = High preference    red = Non-negotiable    blank = Not available';
  legend.font = { italic: true, size: 10, color: { argb: argb('475569') } };
  legend.alignment = { horizontal: 'left', vertical: 'middle' };

  // Rows 3-4: header. Row 3 groups the three shift columns under each day and
  // spans the lead columns; row 4 names each individual column.
  ws.mergeCells(3, 1, 3, LEAD_COLS.length);
  const respHdr = ws.getCell(3, 1);
  respHdr.value = 'Responder (ordered by scheduling priority)';
  styleHeaderCell(respHdr);

  LEAD_COLS.forEach((label, i) => {
    const cell = ws.getCell(4, i + 1);
    cell.value = label;
    styleHeaderCell(cell);
  });

  DAYS.forEach((day, di) => {
    const left = firstShiftCol + di * SHIFTS.length;
    const right = left + SHIFTS.length - 1;
    ws.mergeCells(3, left, 3, right);
    const dayCell = ws.getCell(3, left);
    dayCell.value = DAY_LABELS[day];
    styleHeaderCell(dayCell);
    SHIFTS.forEach((shift, si) => {
      const cell = ws.getCell(4, left + si);
      cell.value = shift.short;
      styleHeaderCell(cell);
    });
  });

  // Data rows.
  ordered.forEach((r, ri) => {
    const rowIdx = 5 + ri;
    ws.getCell(rowIdx, 1).value = r.name;
    ws.getCell(rowIdx, 2).value = ROLE_LABELS[r.role] || r.role;
    ws.getCell(rowIdx, 3).value = r.bilingual ? 'Yes' : '';
    for (let c = 1; c <= LEAD_COLS.length; c++) {
      const cell = ws.getCell(rowIdx, c);
      cell.border = ALL_BORDERS;
      cell.alignment = { horizontal: c === 1 ? 'left' : 'center', vertical: 'middle' };
    }
    DAYS.forEach((day, di) => {
      SHIFTS.forEach((shift, si) => {
        const col = firstShiftCol + di * SHIFTS.length + si;
        const pref = r.prefs?.[slotId(day, shift.id)] || PREF.UNAVAIL;
        paintPrefCell(ws.getCell(rowIdx, col), pref, { withText: false });
      });
    });
  });

  // Column widths.
  ws.getColumn(1).width = 24;
  ws.getColumn(2).width = 12;
  ws.getColumn(3).width = 10;
  for (let c = firstShiftCol; c <= totalCols; c++) ws.getColumn(c).width = 6.5;
  ws.getRow(1).height = 22;
  ws.getRow(2).height = 18;
}

// Excel forbids : \ / ? * [ ] in sheet names and caps them at 31 chars. Keep
// them unique so two responders with the same name don't collide.
function makeSheetName(name, used) {
  let base = norm(name).replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!base) base = 'Responder';
  base = base.slice(0, 31);
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase()) || candidate.toLowerCase() === SUMMARY_SHEET.toLowerCase()) {
    const suffix = ` (${n})`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    n += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function buildResponderSheet(wb, r, sheetName) {
  const ws = wb.addWorksheet(sheetName);

  const titleCell = ws.getCell('A1');
  titleCell.value = 'VCRT Responder';
  titleCell.font = { bold: true, size: 13, color: { argb: argb('8D1D2C') } };
  ws.mergeCells('A1:D1');

  const info = [
    ['Name', r.name],
    ['Role', ROLE_LABELS[r.role] || r.role],
    ['Bilingual', r.bilingual ? 'Yes' : 'No'],
    ['Gender', GENDER_LABELS[r.gender] || r.gender],
    ['Weekly hours', r.hours],
  ];
  info.forEach(([label, value], i) => {
    const row = 2 + i;
    const l = ws.getCell(row, 1);
    l.value = label;
    l.font = { bold: true, color: { argb: argb('334155') } };
    ws.getCell(row, 2).value = value;
  });

  // Availability grid header (row 8): "Day" + one column per shift.
  const HEADER_ROW = 8;
  const dayHdr = ws.getCell(HEADER_ROW, 1);
  dayHdr.value = 'Day';
  styleHeaderCell(dayHdr);
  SHIFTS.forEach((shift, si) => {
    const cell = ws.getCell(HEADER_ROW, 2 + si);
    cell.value = `${shift.short}\n${shift.label}`;
    styleHeaderCell(cell);
  });

  // One row per day; columns follow SHIFTS order.
  DAYS.forEach((day, di) => {
    const row = HEADER_ROW + 1 + di;
    const dayCell = ws.getCell(row, 1);
    dayCell.value = DAY_LABELS[day];
    dayCell.font = { bold: true, color: { argb: argb('334155') } };
    dayCell.border = ALL_BORDERS;
    dayCell.alignment = { vertical: 'middle' };
    SHIFTS.forEach((shift, si) => {
      const pref = r.prefs?.[slotId(day, shift.id)] || PREF.UNAVAIL;
      paintPrefCell(ws.getCell(row, 2 + si), pref, { withText: true });
    });
  });

  ws.getColumn(1).width = 16;
  for (let c = 2; c <= 1 + SHIFTS.length; c++) ws.getColumn(c).width = 20;
  ws.getRow(HEADER_ROW).height = 30;
}

function fileStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

// Build the workbook in memory (no download). Exposed for testing/round-trips.
export async function buildRosterWorkbook(responders) {
  const ExcelJS = await getExcelJS();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VCRT Scheduler';
  wb.created = new Date();

  const ordered = [...responders].sort(byImportance);
  buildSummarySheet(wb, ordered);

  const used = new Set();
  for (const r of ordered) {
    buildResponderSheet(wb, r, makeSheetName(r.name, used));
  }
  return wb;
}

export async function exportRosterXlsx(responders) {
  const wb = await buildRosterWorkbook(responders);

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `VCRT-responders-${fileStamp()}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// --- import -----------------------------------------------------------------

function cellText(cell) {
  if (!cell) return '';
  const v = cell.value;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text != null) return String(v.text);
    if (v.result != null) return String(v.result);
    return '';
  }
  return String(v);
}

function cellFillHex(cell) {
  const argbVal = cell?.fill?.fgColor?.argb;
  if (!argbVal) return null;
  // Strip alpha; compare on the last 6 hex digits.
  return argbVal.slice(-6).toUpperCase();
}

function readPref(cell) {
  const text = normLower(cellText(cell));
  if (text in TEXT_TO_PREF) return TEXT_TO_PREF[text];
  const hex = cellFillHex(cell);
  if (hex && FILL_TO_PREF[hex]) return FILL_TO_PREF[hex];
  return PREF.UNAVAIL;
}

// Map each worksheet row's first-column label to help find the info fields and
// the availability grid regardless of small manual edits to the layout.
function parseResponderSheet(ws) {
  const labels = {}; // lower(label) -> row number
  let dayHeaderRow = null;

  ws.eachRow((row, rowNumber) => {
    const key = normLower(cellText(row.getCell(1)));
    if (!key) return;
    if (!(key in labels)) labels[key] = rowNumber;
    if (key === 'day') dayHeaderRow = rowNumber;
  });

  // A responder sheet must have a Name field and a Day grid; anything else
  // (e.g. the Summary sheet) is skipped.
  if (!('name' in labels) || dayHeaderRow == null) return null;

  const valueOf = (label) => {
    const rn = labels[label];
    return rn ? norm(cellText(ws.getRow(rn).getCell(2))) : '';
  };

  const name = valueOf('name');
  if (!name) return null;

  const roleRaw = normLower(valueOf('role'));
  const role = ROLE_FROM_LABEL[roleRaw] || 'rookie';

  const genderRaw = normLower(valueOf('gender'));
  const gender = GENDER_FROM_LABEL[genderRaw] || 'unspecified';

  const bilingual = ['yes', 'true', 'y', '1'].includes(normLower(valueOf('bilingual')));

  const hoursNum = parseInt(valueOf('weekly hours').replace(/[^\d]/g, ''), 10);
  const hours = hoursNum === REDUCED_HOURS ? REDUCED_HOURS : FULL_HOURS;

  // Availability grid: rows after the Day header whose first column is a day.
  const prefs = {};
  for (const id of ALL_SLOTS) prefs[id] = PREF.UNAVAIL;

  const dayByLabel = {};
  for (const d of DAYS) dayByLabel[DAY_LABELS[d].toLowerCase()] = d;

  const lastRow = ws.rowCount;
  for (let rn = dayHeaderRow + 1; rn <= lastRow; rn++) {
    const row = ws.getRow(rn);
    const dayKey = normLower(cellText(row.getCell(1)));
    const day = dayByLabel[dayKey];
    if (!day) continue;
    SHIFTS.forEach((shift, si) => {
      prefs[slotId(day, shift.id)] = readPref(row.getCell(2 + si));
    });
  }

  return makeResponder({ name, role, bilingual, gender, hours, prefs });
}

// Parse an already-loaded workbook into responders. Exposed for testing.
export function parseRosterWorkbook(wb) {
  const responders = [];
  const warnings = [];

  wb.eachSheet((ws) => {
    if (ws.name.toLowerCase() === SUMMARY_SHEET.toLowerCase()) return;
    try {
      const r = parseResponderSheet(ws);
      if (r) responders.push(r);
    } catch (err) {
      warnings.push(`Could not read sheet "${ws.name}": ${err.message}`);
    }
  });

  if (responders.length === 0) {
    throw new Error(
      'No responder sheets found. Expected a workbook exported by this app (one sheet per responder).'
    );
  }

  // Flag duplicate names — imports are matched by name elsewhere in the app.
  const seen = new Map();
  for (const r of responders) {
    const key = r.name.toLowerCase();
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  for (const [key, count] of seen) {
    if (count > 1) warnings.push(`Duplicate name imported ${count} times: "${key}".`);
  }

  return { responders, warnings };
}

export async function importRosterXlsx(file) {
  const ExcelJS = await getExcelJS();
  const buffer = await file.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return parseRosterWorkbook(wb);
}
