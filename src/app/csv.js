// A leading = + - or @ would run as a formula when the file opens in a spreadsheet.
function cell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(rows) {
  return `﻿${rows.map((row) => row.map(cell).join(',')).join('\r\n')}`;
}

export function downloadCsv(fileName, rows) {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
