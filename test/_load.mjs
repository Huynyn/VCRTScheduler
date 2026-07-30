import ExcelJS from 'exceljs';
import {
  ALL_SLOTS, PREF, REDUCED_HOURS, FULL_HOURS, DAYS, DAY_LABELS, SHIFTS, slotId, ROLES, GENDERS,
} from '../src/constants/schedule.js';

const TEXT_TO_PREF = {
  available: PREF.AVAIL, avail: PREF.AVAIL, 'high preference': PREF.HIGH, high: PREF.HIGH,
  'non-negotiable': PREF.NONNEG, 'non negotiable': PREF.NONNEG, nonnegotiable: PREF.NONNEG,
  'not available': PREF.UNAVAIL, unavailable: PREF.UNAVAIL, unavail: PREF.UNAVAIL,
  '-': PREF.UNAVAIL, '-': PREF.UNAVAIL, '': PREF.UNAVAIL,
};
const PREF_FILL = { [PREF.AVAIL]: '16A34A', [PREF.HIGH]: '2563EB', [PREF.NONNEG]: 'DC2626' };
const FILL_TO_PREF = Object.fromEntries(Object.entries(PREF_FILL).map(([p, h]) => [h.toUpperCase(), p]));
const ROLE_FROM_LABEL = (() => { const m = {}; for (const r of ROLES) m[r.label.toLowerCase()] = r.id; m['new member'] = 'rookie'; m['new'] = 'rookie'; return m; })();
const GENDER_FROM_LABEL = (() => { const m = {}; for (const g of GENDERS) m[g.label.toLowerCase()] = g.id; m['prefer not to say'] = 'unspecified'; return m; })();
const norm = (v) => String(v ?? '').trim();
const normLower = (v) => norm(v).toLowerCase();
function cellText(cell) { if (!cell) return ''; const v = cell.value; if (v == null) return ''; if (typeof v === 'object') { if (v.richText) return v.richText.map((t) => t.text).join(''); if (v.text != null) return String(v.text); if (v.result != null) return String(v.result); return ''; } return String(v); }
function cellFillHex(cell) { const a = cell?.fill?.fgColor?.argb; return a ? a.slice(-6).toUpperCase() : null; }
function readPref(cell) { const t = normLower(cellText(cell)); if (t in TEXT_TO_PREF) return TEXT_TO_PREF[t]; const h = cellFillHex(cell); return h && FILL_TO_PREF[h] ? FILL_TO_PREF[h] : PREF.UNAVAIL; }
function parseSheet(ws) {
  const labels = {}; let dayHeaderRow = null;
  ws.eachRow((row, rn) => { const k = normLower(cellText(row.getCell(1))); if (!k) return; if (!(k in labels)) labels[k] = rn; if (k === 'day') dayHeaderRow = rn; });
  if (!('name' in labels) || dayHeaderRow == null) return null;
  const valueOf = (l) => { const rn = labels[l]; return rn ? norm(cellText(ws.getRow(rn).getCell(2))) : ''; };
  const name = valueOf('name'); if (!name) return null;
  const role = ROLE_FROM_LABEL[normLower(valueOf('role'))] || 'rookie';
  const gender = GENDER_FROM_LABEL[normLower(valueOf('gender'))] || 'unspecified';
  const bilingual = ['yes', 'true', 'y', '1'].includes(normLower(valueOf('bilingual')));
  const hoursNum = parseInt(valueOf('weekly hours').replace(/[^\d]/g, ''), 10);
  const hours = hoursNum === REDUCED_HOURS ? REDUCED_HOURS : FULL_HOURS;
  const prefs = {}; for (const id of ALL_SLOTS) prefs[id] = PREF.UNAVAIL;
  const dayByLabel = {}; for (const d of DAYS) dayByLabel[DAY_LABELS[d].toLowerCase()] = d;
  for (let rn = dayHeaderRow + 1; rn <= ws.rowCount; rn++) { const row = ws.getRow(rn); const day = dayByLabel[normLower(cellText(row.getCell(1)))]; if (!day) continue; SHIFTS.forEach((sh, si) => { prefs[slotId(day, sh.id)] = readPref(row.getCell(2 + si)); }); }
  return { id: `r_${name.replace(/\s+/g, '_')}`, name, role, bilingual, gender, hours, prefs };
}

export async function loadRoster(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const responders = [];
  wb.eachSheet((ws) => { if (ws.name.toLowerCase() === 'summary') return; const r = parseSheet(ws); if (r) responders.push(r); });
  return responders;
}

export const DEFAULT_FILE = 'C:\\Users\\huy21\\Downloads\\VCRT-responders-2026-07-28.xlsx';
