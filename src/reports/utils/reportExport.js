// CSV is plain delimited text, so this needs no extra library.
function escapeCsvValue(value) {
  let text = String(value ?? '');
  // A spreadsheet would run a typed name starting with these as a formula. Plain numbers stay numbers.
  if (/^[=+\-@\t\r]/.test(text) && typeof value !== 'number') text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(columns, rows) {
  const header = columns.map((column) => escapeCsvValue(column.label)).join(',');
  const body = rows.map((row) => columns.map((column) => escapeCsvValue(column.csv ? column.csv(row) : column.value(row))).join(','));
  // The byte order mark lets Excel read Tamil and Sinhala correctly.
  return `﻿${[header, ...body].join('\r\n')}`;
}

export function downloadCsv(filename, columns, rows) {
  const blob = new Blob([toCsv(columns, rows)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
