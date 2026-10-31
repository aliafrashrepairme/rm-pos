// CSV reading and writing, with quoted cells and line breaks handled. No extra library is needed.
export function parseCsv(text) {
  const source = text.replace(/^﻿/, '');
  const records = [];
  let record = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        if (char === '\n') line += 1;
        cell += char;
      }
    } else if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === ',') {
      record.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      record.push(cell);
      records.push({ line: recordLine, cells: record });
      record = [];
      cell = '';
      line += 1;
      recordLine = line;
    } else {
      cell += char;
    }
  }
  if (quoted) return { error: 'A quoted value in this file is never closed.', records: [] };
  if (cell !== '' || record.length) {
    record.push(cell);
    records.push({ line: recordLine, cells: record });
  }
  return { records: records.filter((row) => row.cells.some((value) => value.trim() !== '')) };
}

function csvCell(value) {
  let text = String(value ?? '');
  // A spreadsheet would run a typed name starting with these as a formula. Plain numbers stay numbers.
  if (/^[=+\-@\t\r]/.test(text) && typeof value !== 'number') text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns, rows) {
  const body = rows.map((row) => columns.map(([, read]) => csvCell(read(row))).join(','));
  return `﻿${[columns.map(([label]) => csvCell(label)).join(','), ...body].join('\r\n')}\r\n`;
}
