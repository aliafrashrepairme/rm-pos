import { HttpError, unwrap } from '../errors.js';

// Two people editing the same record: an edit form sends the record's updatedAt from when it was opened.
// If the record has been saved since, the second save is refused instead of silently overwriting the first.
// Without an expectedUpdatedAt (older screens, one-click actions) nothing is checked, as before.
export const EDIT_CONFLICT = 'EDIT_CONFLICT';
export const EDIT_CONFLICT_MESSAGE = 'Someone else changed this while you were editing. Close it and open it again to see their changes.';

const asTime = (value) => (value instanceof Date ? value.getTime() : Date.parse(value));

export async function assertUnchanged(database, table, id, expected, notFoundMessage) {
  if (expected === undefined || expected === null) return;
  if (typeof expected !== 'string' || Number.isNaN(Date.parse(expected))) {
    throw new HttpError(400, 'The edit time is not valid.');
  }
  const row = unwrap(await database.from(table).select('updated_at').eq('id', id).maybeSingle());
  if (!row) throw new HttpError(404, notFoundMessage);
  if (asTime(row.updated_at) !== asTime(expected)) throw new HttpError(409, EDIT_CONFLICT_MESSAGE, EDIT_CONFLICT);
}
