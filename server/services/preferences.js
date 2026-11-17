import { HttpError, unwrap } from '../errors.js';

const LANGUAGES = ['en', 'ta', 'si'];
const THEMES = ['light', 'dark'];

export async function getPreferences({ database }, userId) {
  return unwrap(await database.from('user_preferences').select('language, theme').eq('user_id', userId).maybeSingle());
}

// Writes only the fields sent, in one statement, so quick changes can't overwrite each other.
// Only the person's own row can change, because the ID comes from their session.
export async function savePreferences({ database }, userId, change) {
  const fields = {};
  if (change?.language !== undefined) {
    if (!LANGUAGES.includes(change.language)) throw new HttpError(400, 'Unsupported language.');
    fields.language = change.language;
  }
  if (change?.theme !== undefined) {
    if (!THEMES.includes(change.theme)) throw new HttpError(400, 'Unsupported theme.');
    fields.theme = change.theme;
  }
  if (!Object.keys(fields).length) throw new HttpError(400, 'Nothing to save.');
  return unwrap(await database.from('user_preferences')
    .upsert({ user_id: userId, ...fields })
    .select('language, theme')
    .single());
}
