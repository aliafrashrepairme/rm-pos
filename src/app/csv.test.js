import assert from 'node:assert/strict';
import test from 'node:test';
import { toCsv } from './csv.js';

test('values are quoted, and Excel gets the encoding marker for Tamil and Sinhala', () => {
  const text = toCsv([['Bill', 'Total'], ['a"b', 12.5], ['தமிழ்', null]]);
  assert.equal(text, '﻿"Bill","Total"\r\n"a""b","12.5"\r\n"தமிழ்",""');
});

test('text that a spreadsheet would run as a formula is neutralised, but negative numbers stay numbers', () => {
  const text = toCsv([['=HYPERLINK("http://x")', '+1+1', '@cmd', '-2.50', '-x']]);
  assert.ok(text.includes(`"'=HYPERLINK(""http://x"")"`));
  assert.ok(text.includes(`"'+1+1"`));
  assert.ok(text.includes(`"'@cmd"`));
  assert.ok(text.includes('"-2.50"'));
  assert.ok(text.includes(`"'-x"`));
});
