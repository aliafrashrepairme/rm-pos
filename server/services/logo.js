import { randomUUID } from 'node:crypto';
import { HttpError, unwrap } from '../errors.js';
import { writeAudit } from './audit.js';
import { IMAGE_TYPES } from './products.js';

const BUCKET = 'store-logo';
const MAX_LOGO_BYTES = 1024 * 1024;

export const ACCEPTED_LOGO_TYPES = Object.keys(IMAGE_TYPES);
export const LOGO_BODY_LIMIT = MAX_LOGO_BYTES;

async function ensureBucket(database) {
  const { error } = await database.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: MAX_LOGO_BYTES,
    allowedMimeTypes: ACCEPTED_LOGO_TYPES
  });
  if (error && !/already exists/i.test(error.message)) throw error;
}

async function currentPath(database) {
  return unwrap(await database.from('store_settings').select('logo_path').eq('id', true).single()).logo_path;
}

// Null means the app shows its built-in logo.
export async function getLogo({ database }) {
  const path = await currentPath(database);
  if (!path) return null;
  const { data, error } = await database.storage.from(BUCKET).download(path);
  if (error || !data) {
    console.error('Could not read the store logo:', error);
    return null;
  }
  const extension = path.split('.').pop();
  const contentType = ACCEPTED_LOGO_TYPES.find((type) => IMAGE_TYPES[type].extension === extension);
  return { bytes: Buffer.from(await data.arrayBuffer()), contentType };
}

export async function setLogo({ database }, user, contentType, bytes) {
  const type = IMAGE_TYPES[contentType];
  if (!type || !Buffer.isBuffer(bytes) || !bytes.length) throw new HttpError(415, 'Choose a JPG, PNG or WebP image.');
  if (!type.matches(bytes)) throw new HttpError(415, 'This file is not a valid image.');

  const before = await currentPath(database);
  const path = `logo/${randomUUID()}.${type.extension}`;
  try {
    await ensureBucket(database);
    const { error } = await database.storage.from(BUCKET).upload(path, bytes, { contentType });
    if (error) throw error;
  } catch (error) {
    console.error('Logo upload failed:', error);
    throw new HttpError(502, 'The logo could not be saved. Try again.');
  }
  unwrap(await database.from('store_settings').update({ logo_path: path }).eq('id', true));
  if (before) {
    const removed = await database.storage.from(BUCKET).remove([before]);
    if (removed.error) console.error('Could not remove the old logo:', removed.error);
  }
  await writeAudit(database, { user, action: 'Store logo changed', entityType: 'settings' });
}

export async function removeLogo({ database }, user) {
  const before = await currentPath(database);
  if (!before) return;
  unwrap(await database.from('store_settings').update({ logo_path: '' }).eq('id', true));
  const removed = await database.storage.from(BUCKET).remove([before]);
  if (removed.error) console.error('Could not remove the old logo:', removed.error);
  await writeAudit(database, { user, action: 'Store logo removed', entityType: 'settings' });
}
