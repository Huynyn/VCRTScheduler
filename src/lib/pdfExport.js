import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { DAYS, DAY_LABELS, SHIFTS, slotId, MAX_PER_SHIFT } from '../constants/schedule.js';
import logoUrl from '../assets/vcrt-logo-transparent.png';

// ---------------------------------------------------------------------------
// PDF export styled after the official "Weekly Schedule — VCRT-ÉBIC" sheet:
// crest top-left; big blue "Weekly Schedule" + garnet "VCRT-ÉBIC" top-right;
// black-bordered grid with a blue header row and a narrow Time column;
// one striped line per name; (S) = supervisor, blue (R) = rookie,
// italics = bilingual; coloured legend bottom-left.
// ---------------------------------------------------------------------------

const TITLE_BLUE = [21, 88, 235];
const HEADER_BLUE = [16, 44, 190];
const NEW_MEMBER_BLUE = [37, 99, 235];
const LEGEND_RED = [176, 24, 32];
const GARNET = [141, 29, 44];
const BLACK = [20, 20, 20];
const MUTED = [100, 116, 139];
const STRIPE_GRAY = [222, 222, 222];

const MARGIN = 42;
const LINE_H = 15; // height of one striped name row, pt
const NAME_ROWS = MAX_PER_SHIFT + 1; // matches the sheet's spare empty stripe

// Fetch the crest once and cache it as a data URL for jsPDF.
let logoDataUrl = null;
async function getLogo() {
  if (logoDataUrl) return logoDataUrl;
  try {
    const blob = await (await fetch(logoUrl)).blob();
    logoDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    logoDataUrl = null; // export still works without the crest
  }
  return logoDataUrl;
}

// The two terms VCRT schedules for. Winter runs Jan–Apr, Fall Sep–Dec, so from
// May onwards the next schedule being built is the Fall one.
export const SEMESTERS = ['Fall', 'Winter'];

export function currentTerm(date = new Date()) {
  const month = date.getMonth() + 1;
  const semester = month >= 5 && month <= 12 ? 'Fall' : 'Winter';
  return { semester, year: date.getFullYear() };
}

export const termLabel = ({ semester, year }) => `${semester} ${year}`;

function nameStyle(person) {
  return {
    fontStyle: person.bilingual ? 'italic' : 'normal',
    color: person.role === 'rookie' ? NEW_MEMBER_BLUE : BLACK,
    suffix: person.role === 'supervisor' ? ' (S)' : person.role === 'rookie' ? ' (R)' : '',
  };
}

// Shrink a name until "name + suffix" fits on a single line of the cell.
function fittedName(doc, person, maxWidth, baseSize) {
  const { fontStyle, suffix } = nameStyle(person);
  let size = baseSize;
  doc.setFont('helvetica', fontStyle);
  while (size > 5.6) {
    doc.setFontSize(size);
    if (doc.getTextWidth(person.name + suffix) <= maxWidth) break;
    size -= 0.4;
  }
  return size;
}

function drawHeader(doc, logo, { term, optionLabel, generatedAt, partial }) {
  const pageW = doc.internal.pageSize.getWidth();

  if (logo) {
    doc.addImage(logo, 'PNG', MARGIN, 20, 78, 78);
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(30);
  doc.setTextColor(...TITLE_BLUE);
  doc.text('Weekly Schedule', pageW - MARGIN, 52, { align: 'right' });

  doc.setFontSize(21);
  doc.setTextColor(...GARNET);
  doc.text('VCRT-ÉBIC', pageW - MARGIN, 76, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(13);
  doc.setTextColor(...BLACK);
  doc.text(term, pageW - MARGIN, 96, { align: 'right' });

  doc.setFontSize(8.5);
  doc.setTextColor(...MUTED);
  const bits = [optionLabel, generatedAt ? `Generated ${generatedAt}` : null].filter(Boolean);
  if (bits.length) doc.text(bits.join('   ·   '), MARGIN + (logo ? 84 : 0), 96);
  if (partial) {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...GARNET);
    doc.text('PARTIAL SCHEDULE — see contact list on the last page', MARGIN + (logo ? 84 : 0), 84);
    doc.setFont('helvetica', 'normal');
  }
  doc.setTextColor(...BLACK);
}

function drawScheduleGrid(doc, schedule, startY) {
  const head = [['Time', ...DAYS.map((d) => DAY_LABELS[d])]];

  const cellPeople = [];
  const body = SHIFTS.map((shift, rowIdx) => {
    cellPeople[rowIdx] = {};
    const time = shift.label.split('–')[0].trim().replace(/^0/, '');
    const row = [time];
    DAYS.forEach((day, dIdx) => {
      cellPeople[rowIdx][dIdx + 1] = schedule.slots[slotId(day, shift.id)] || [];
      row.push('');
    });
    return row;
  });

  autoTable(doc, {
    head,
    body,
    startY,
    margin: { left: MARGIN, right: MARGIN },
    theme: 'grid',
    styles: {
      font: 'helvetica',
      fontSize: 9,
      cellPadding: 0,
      valign: 'middle',
      lineColor: BLACK,
      lineWidth: 0.9,
      textColor: BLACK,
      minCellHeight: NAME_ROWS * LINE_H,
    },
    headStyles: {
      fillColor: HEADER_BLUE,
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      halign: 'center',
      valign: 'middle',
      fontSize: 10.5,
      minCellHeight: 24,
      lineColor: BLACK,
      lineWidth: 0.9,
    },
    columnStyles: {
      0: { cellWidth: 46, halign: 'center', fontStyle: 'bold', fontSize: 10.5 },
    },
    didDrawCell: (data) => {
      if (data.section !== 'body' || data.column.index === 0) return;
      const people = cellPeople[data.row.index]?.[data.column.index] || [];
      const { x, y, width, height } = data.cell;
      const rows = Math.max(NAME_ROWS, people.length);
      const rowH = height / rows;

      for (let i = 0; i < rows; i++) {
        // Alternating stripe (white / light gray), like the official sheet.
        if (i % 2 === 1) {
          doc.setFillColor(...STRIPE_GRAY);
          doc.rect(x + 0.45, y + i * rowH + (i === 0 ? 0.45 : 0), width - 0.9, rowH, 'F');
        }
        const p = people[i];
        if (!p) continue;
        const { fontStyle, color, suffix } = nameStyle(p);
        const size = fittedName(doc, p, width - 7, 8.6);
        doc.setFont('helvetica', fontStyle);
        doc.setFontSize(size);
        doc.setTextColor(...color);
        doc.text(p.name + suffix, x + 3.5, y + i * rowH + rowH / 2, { baseline: 'middle' });
      }
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...BLACK);
    },
  });

  return doc.lastAutoTable.finalY;
}

function drawLegend(doc, y) {
  const left = MARGIN;
  doc.setFont('helvetica', 'bolditalic');
  doc.setFontSize(11);
  doc.setTextColor(...LEGEND_RED);
  doc.text('Legend:', left, y);

  doc.setFontSize(9);
  let ly = y + 12;

  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...BLACK);
  doc.text('(S):', left, ly);
  doc.setFont('helvetica', 'normal');
  doc.text('Shift supervisor', left + 18, ly);
  ly += 11;

  doc.setTextColor(...NEW_MEMBER_BLUE);
  doc.text('(R): Rookie', left, ly);
  ly += 11;

  doc.setFont('helvetica', 'italic');
  doc.setTextColor(...BLACK);
  doc.text('Name in Italics: French + English speaker (Bilingual)', left, ly);
  ly += 11;

  doc.setFont('helvetica', 'normal');
  doc.text('Name non-italicized: English speaker', left, ly);
  return ly;
}

export async function exportSchedulesPdf(result, meta = {}) {
  if (!result?.schedules?.length) return;
  const logo = await getLogo();
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  const term =
    typeof meta.term === 'string' && meta.term.trim()
      ? meta.term.trim()
      : termLabel(currentTerm());

  // The "Option X of Y · Generated <date>" line is optional (some coordinators
  // print a clean copy without it). It defaults to on for backwards behaviour.
  const showMeta = meta.showMeta !== false;

  result.schedules.forEach((schedule, idx) => {
    if (idx > 0) doc.addPage();
    const partial = schedule.valid === false;
    drawHeader(doc, logo, {
      term,
      optionLabel:
        showMeta && result.schedules.length > 1
          ? `Option ${schedule.rank} of ${result.schedules.length}`
          : null,
      generatedAt: showMeta ? meta.generatedAt : null,
      partial,
    });
    const afterGrid = drawScheduleGrid(doc, schedule, 110);
    drawLegend(doc, afterGrid + 22);
  });

  // Partial mode: append a "who to contact" page.
  const sugg = result.suggestions;
  if (sugg && (sugg.people?.length || sugg.gaps?.length)) {
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    doc.addPage();
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(17);
    doc.setTextColor(...GARNET);
    doc.text('Contact for extra availability', MARGIN, 44);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...MUTED);
    doc.text(
      'Ranked by impact. You can only ask people to change their AVAILABILITY — role, languages and',
      MARGIN,
      60
    );
    doc.text('gender are fixed. Reaching out to the people at the top helps the most.', MARGIN, 72);
    doc.setTextColor(...BLACK);

    let y = 96;

    // Person-level impact ranking (most impactful first).
    if (sugg.people?.length) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.setTextColor(...HEADER_BLUE);
      doc.text('Most impactful people to contact', MARGIN, y);
      doc.setTextColor(...BLACK);
      y += 18;

      sugg.people.forEach((p, idx) => {
        if (y > pageH - 48) {
          doc.addPage();
          y = 44;
        }
        const tags = [];
        if (p.role === 'supervisor') tags.push('supervisor');
        if (p.bilingual) tags.push('bilingual');
        const tagStr = tags.length ? ` (${tags.join(', ')})` : '';
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.text(`${idx + 1}. ${p.name}${tagStr}`, MARGIN + 4, y);
        y += 12;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(...MUTED);
        const lines = doc.splitTextToSize(p.summary, pageW - 2 * MARGIN - 30);
        doc.text(lines, MARGIN + 14, y);
        y += lines.length * 10;
        const slotList = p.unlocks.map((u) => u.label).join(', ');
        if (slotList) {
          const sl = doc.splitTextToSize(`Shifts to open: ${slotList}`, pageW - 2 * MARGIN - 30);
          doc.text(sl, MARGIN + 14, y);
          y += sl.length * 10;
        }
        doc.setTextColor(...BLACK);
        y += 6;
      });
      y += 8;
    }

    if (sugg.gaps?.length) {
      if (y > pageH - 60) {
        doc.addPage();
        y = 44;
      }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.setTextColor(...HEADER_BLUE);
      doc.text('Gaps shift by shift', MARGIN, y);
      doc.setTextColor(...BLACK);
      y += 18;
    }
    for (const g of sugg.gaps || []) {
      if (y > pageH - 60) {
        doc.addPage();
        y = 44;
      }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      doc.text(`${g.label}`, MARGIN, y);
      doc.setFont('helvetica', 'normal');
      y += 16;

      for (const ask of g.asks || []) {
        if (y > pageH - 48) {
          doc.addPage();
          y = 44;
        }
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(9);
        doc.setTextColor(...MUTED);
        const qLines = doc.splitTextToSize(ask.question, pageW - 2 * MARGIN - 20);
        doc.text(qLines, MARGIN + 10, y);
        doc.setTextColor(...BLACK);
        y += qLines.length * 11 + 2;

        if (!ask.candidates.length) {
          doc.setFont('helvetica', 'italic');
          doc.setFontSize(8.5);
          doc.text('No one can fill this by opening availability — bring in someone new.', MARGIN + 20, y);
          doc.setFont('helvetica', 'normal');
          y += 13;
          continue;
        }
        for (const c of ask.candidates) {
          if (y > pageH - 34) {
            doc.addPage();
            y = 44;
          }
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(9.5);
          const tags = [];
          if (c.role === 'supervisor') tags.push('supervisor');
          if (c.bilingual) tags.push('bilingual');
          const tagStr = tags.length ? ` (${tags.join(', ')})` : '';
          doc.text(`- ${c.name}${tagStr}`, MARGIN + 20, y);
          y += 12;
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8.5);
          doc.setTextColor(...MUTED);
          const lines = doc.splitTextToSize(c.reason, pageW - 2 * MARGIN - 46);
          doc.text(lines, MARGIN + 30, y);
          doc.setTextColor(...BLACK);
          y += lines.length * 10 + 3;
        }
        y += 3;
      }
      y += 6;
    }
  }

  const filename = `VCRT-schedule-${term.replace(/\s+/g, '')}${result.ok ? '' : '-partial'}.pdf`;
  doc.save(filename);
}
