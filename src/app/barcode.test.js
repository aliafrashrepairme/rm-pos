import assert from 'node:assert/strict';
import test from 'node:test';
import { code128Modules, createDuplicateFilter, createScannerBuffer, ean13Modules, isValidEan13 } from './barcode.js';

test('EAN-13 check digits are verified', () => {
  assert.equal(isValidEan13('4006381333931'), true);
  assert.equal(isValidEan13('4006381333932'), false);
  assert.equal(isValidEan13('400638133393'), false);
  assert.equal(isValidEan13('ABCDEFGHIJKLM'), false);
});

test('an EAN-13 symbol has the standard shape', () => {
  const bits = ean13Modules('4006381333931');
  assert.equal(bits.length, 95);
  assert.equal(bits.slice(0, 3), '101');
  assert.equal(bits.slice(45, 50), '01010');
  assert.equal(bits.slice(92), '101');
  // The first digit 4 sets the parity LGLLGG, so the second digit 0 is an L pattern.
  assert.equal(bits.slice(3, 10), '0001101');
  assert.throws(() => ean13Modules('4006381333932'));
});

test('a Code 128 symbol starts and stops correctly and has the right length', () => {
  const bits = code128Modules('RM-1');
  assert.equal(bits.slice(0, 11), '11010010000');
  assert.equal(bits.slice(-13), '1100011101011');
  assert.equal(bits.length, 11 + 4 * 11 + 11 + 13);
  assert.throws(() => code128Modules('தமிழ்'));
});

test('fast keystrokes ending in Enter count as a scan; slow typing does not', () => {
  let time = 0;
  const feed = createScannerBuffer({ now: () => time });
  const type = (text, gap) => {
    let result = null;
    for (const key of [...text, 'Enter']) {
      time += gap;
      result = feed(key);
    }
    return result;
  };
  assert.equal(type('4006381333931', 10), '4006381333931');
  time += 1000;
  assert.equal(type('hello world', 200), null);
  time += 1000;
  assert.equal(type('123', 10), null, 'too short');
  time += 1000;
  assert.equal(type('2000000000015', 10), '2000000000015', 'recovers after rejecting input');
});

test('a repeat within the window is ignored, later or different codes are not', () => {
  let time = 0;
  const isNew = createDuplicateFilter({ windowMs: 2000, now: () => time });
  assert.equal(isNew('A'), true);
  time = 500;
  assert.equal(isNew('A'), false);
  time = 1000;
  assert.equal(isNew('B'), true);
  time = 1100;
  assert.equal(isNew('A'), true);
  time = 4000;
  assert.equal(isNew('A'), true);
});
