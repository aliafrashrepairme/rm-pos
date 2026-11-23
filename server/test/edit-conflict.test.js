import assert from 'node:assert/strict';
import test from 'node:test';
import { assertUnchanged, EDIT_CONFLICT } from '../services/editConflict.js';

// A stand-in for database.from(table).select().eq().maybeSingle() that returns one row.
const databaseWith = (row) => ({
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) })
});

test('a save is refused when the record changed after the form was opened', async () => {
  const database = databaseWith({ updated_at: '2026-11-23T05:10:13.123456+00:00' });
  await assert.doesNotReject(assertUnchanged(database, 'products', 'id', '2026-11-23T05:10:13.123456+00:00', 'Missing.'));
  await assert.rejects(
    assertUnchanged(database, 'products', 'id', '2026-11-23T05:09:00.000000+00:00', 'Missing.'),
    (error) => error.status === 409 && error.code === EDIT_CONFLICT
  );
});

test('the local database gives Date objects; the same moment still matches', async () => {
  const database = databaseWith({ updated_at: new Date('2026-11-23T05:10:13.123Z') });
  await assert.doesNotReject(assertUnchanged(database, 'customers', 'id', '2026-11-23T05:10:13.123Z', 'Missing.'));
});

test('no edit time means no check, a bad one is refused, and a missing record is 404', async () => {
  await assert.doesNotReject(assertUnchanged(databaseWith(null), 'suppliers', 'id', undefined, 'Missing.'));
  await assert.rejects(assertUnchanged(databaseWith({ updated_at: 'x' }), 'suppliers', 'id', 'yesterday', 'Missing.'), (error) => error.status === 400);
  await assert.rejects(assertUnchanged(databaseWith(null), 'suppliers', 'id', '2026-11-23T05:10:13Z', 'Supplier not found.'), (error) => error.status === 404);
});
