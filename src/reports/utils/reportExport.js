// CSV export + print helpers. No extra dependency needed — CSV is just
// delimited text, and print uses the browser's native print dialog.

function escapeCsvValue(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function toCsv(columns, rows) {
  const header = columns.map((c) => escapeCsvValue(c.label)).join(',');
  const body = rows
    .map((row) => columns.map((c) => escapeCsvValue(typeof c.value === 'function' ? c.value(row) : row[c.value])).join(','))
    .join('\n');
  return `${header}\n${body}`;
}

export function downloadCsv(filename, columns, rows) {
  const csv = toCsv(columns, rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function printReport() {
  window.print();
}
