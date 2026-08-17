import ExcelJS from 'exceljs';

export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Build a single-sheet workbook.
 * columns: [{ header, key, width, numFmt }]
 */
export async function buildWorkbook({ sheetName = 'Sheet1', title, columns, rows, notes = [] }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Quantum Driver Management';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName, {
    views: [{ state: 'frozen', ySplit: title ? 2 : 1 }],
  });

  if (title) {
    ws.mergeCells(1, 1, 1, columns.length);
    const cell = ws.getCell(1, 1);
    cell.value = title;
    cell.font = { bold: true, size: 13 };
    cell.alignment = { vertical: 'middle' };
    ws.getRow(1).height = 22;
  }

  const headerRowIdx = title ? 2 : 1;
  ws.getRow(headerRowIdx).values = columns.map((c) => c.header);
  ws.columns = columns.map((c) => ({ key: c.key, width: c.width || 16 }));

  const header = ws.getRow(headerRowIdx);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3B57' } };
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  header.height = 24;

  rows.forEach((r) => {
    const row = ws.addRow(columns.map((c) => r[c.key] ?? ''));
    columns.forEach((c, i) => {
      if (c.numFmt) row.getCell(i + 1).numFmt = c.numFmt;
    });
  });

  ws.autoFilter = {
    from: { row: headerRowIdx, column: 1 },
    to: { row: headerRowIdx, column: columns.length },
  };

  if (notes.length) {
    ws.addRow([]);
    notes.forEach((n) => {
      const row = ws.addRow([n]);
      row.getCell(1).font = { italic: true, color: { argb: 'FF666666' } };
    });
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Read the first worksheet of an uploaded workbook into objects keyed by header. */
export async function readWorkbook(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };

  // Find the header row: the first row that has at least two non-empty cells.
  let headerRowIdx = 1;
  for (let i = 1; i <= Math.min(ws.rowCount, 10); i += 1) {
    const vals = (ws.getRow(i).values || []).filter((v) => v !== null && v !== undefined && v !== '');
    if (vals.length >= 2) {
      headerRowIdx = i;
      break;
    }
  }

  const headerRow = ws.getRow(headerRowIdx);
  const headers = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = String(cellText(cell) || '').trim();
  });

  const rows = [];
  for (let i = headerRowIdx + 1; i <= ws.rowCount; i += 1) {
    const row = ws.getRow(i);
    const obj = {};
    let hasValue = false;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const key = headers[col];
      if (!key) return;
      const v = cellText(cell);
      if (v !== '' && v !== null && v !== undefined) hasValue = true;
      obj[key] = v;
    });
    if (hasValue) rows.push({ __row: i, ...obj });
  }
  return { headers: headers.filter(Boolean), rows };
}

function cellText(cell) {
  const v = cell?.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if ('text' in v) return v.text;
    if ('result' in v) return v.result;
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('hyperlink' in v) return v.text ?? v.hyperlink;
  }
  return v;
}
