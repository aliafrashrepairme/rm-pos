import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCK_MS, MAX_FAILURES, cleanPin, createPinGuard, hashPin, pinMatches } from '../services/pins.js';

test('a counter PIN is 4 to 6 digits', () => {
  assert.equal(cleanPin(' 1234 '), '1234');
  assert.equal(cleanPin('123456'), '123456');
  for (const bad of ['123', '1234567', '12a4', '', null, 1234]) assert.throws(() => cleanPin(bad), /4 to 6 digits/);
});

test('only a salted hash is stored, and only the right PIN matches it', async () => {
  const stored = await hashPin('4821');
  assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.ok(!stored.includes('4821'));
  assert.notEqual(stored, await hashPin('4821'));
  assert.equal(await pinMatches('4821', stored), true);
  assert.equal(await pinMatches('4822', stored), false);
  assert.equal(await pinMatches('4821', 'not-a-hash'), false);
});

test(`${MAX_FAILURES} wrong PINs lock the counter for a while, then it opens again`, () => {
  let time = 1_000_000;
  const guard = createPinGuard({ now: () => time });
  for (let i = 1; i < MAX_FAILURES; i += 1) guard.failed('c1');
  assert.doesNotThrow(() => guard.assertOpen('c1'));
  guard.failed('c1');
  assert.throws(() => guard.assertOpen('c1'), /Too many wrong PINs/);
  assert.doesNotThrow(() => guard.assertOpen('c2'));
  time += LOCK_MS + 1;
  assert.doesNotThrow(() => guard.assertOpen('c1'));
  guard.failed('c1');
  assert.doesNotThrow(() => guard.assertOpen('c1'));
  guard.succeeded('c1');
  assert.doesNotThrow(() => guard.assertOpen('c1'));
});
