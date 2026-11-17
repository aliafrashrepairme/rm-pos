import assert from 'node:assert/strict';
import test from 'node:test';
import { toCsv } from './reportExport.js';

const columns = [
  { label: 'Name', value: (row) => row.name },
  { label: 'Total', value: (row) => `LKR ${row.total}`, csv: (row) => row.total }
];

test('a CSV starts with the marker Excel needs, and uses raw numbers', () => {
  const csv = toCsv(columns, [{ name: 'சுத்தியல்', total: 118.5 }]);
  assert.equal(csv, '﻿Name,Total\r\nசுத்தியல்,118.5');
});

test('commas, quotes and line breaks stay inside one cell', () => {
  const csv = toCsv(columns, [{ name: 'Nail, "big"\nbox', total: 1 }]);
  assert.ok(csv.endsWith('"Nail, ""big""\nbox",1'), csv);
});

test('a typed name cannot run as a spreadsheet formula', () => {
  for (const name of ['=HYPERLINK("x")', '+1+1', '-2', '@SUM(A1)']) {
    assert.ok(toCsv(columns, [{ name, total: 1 }]).split('\r\n')[1].replace(/^"/, '').startsWith(`'${name[0]}`), name);
  }
});

test('negative numbers stay usable as numbers', () => {
  assert.ok(toCsv(columns, [{ name: 'A', total: -5 }]).endsWith('A,-5'));
});
