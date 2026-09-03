import ExcelJS from 'exceljs';

export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Build a single-sheet workbook.
 *
 * columns: [{ header, key, width, numFmt }]
 * freezeColumns: how many leading columns to keep on screen when the sheet is
 *   scrolled sideways. A register with a column per day of the month runs well
 *   past the width of a screen, and without this the driver's name and
 *   registration number scroll away and the codes belong to nobody.
 */
export async function buildWorkbook({
  sheetName = 'Sheet1', title, columns, rows, notes = [], freezeColumns = 0,
}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Quantum Driver Management';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName, {
    views: [{ state: 'frozen', xSplit: freezeColumns, ySplit: title ? 2 : 1 }],
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

  // Find the header row: the first row with at least two *different* non-empty
  // cells. The workbooks this app generates open with a merged title row, and a
  // merged cell reports the same value in every column it spans — so a row of
  // identical values is a title, not a header.
  let headerRowIdx = 1;
  for (let i = 1; i <= Math.min(ws.rowCount, 10); i += 1) {
    const vals = (ws.getRow(i).values || [])
      .filter((v) => v !== null && v !== undefined && v !== '')
      .map((v) => String(cellValueText(v)).trim());
    if (vals.length >= 2 && new Set(vals).size >= 2) {
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

  // Every workbook this app generates ends with a few lines of instructions,
  // written into the first column below the data. Excel hands those back as
  // ordinary rows, and without this they are read as records — an upload of an
  // unmodified download would report the instructions as missing drivers.
  // A genuine row in any of these registers carries several columns, so a
  // trailing row with only one populated cell is a note, not data.
  while (rows.length && populatedFields(rows[rows.length - 1]) <= 1) rows.pop();

  return { headers: headers.filter(Boolean), rows };
}

/** How many real values a parsed row carries, ignoring the row-number marker. */
function populatedFields(row) {
  return Object.entries(row).filter(
    ([k, v]) => k !== '__row' && v !== '' && v !== null && v !== undefined,
  ).length;
}

const cellText = (cell) => cellValueText(cell?.value);

/** Flatten whatever ExcelJS put in a cell into something comparable. */
function cellValueText(v) {
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
