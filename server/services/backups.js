import { HttpError, unwrap } from '../errors.js';
import { writeAudit } from './audit.js';

// Automated backups: a full, consistent copy of the database as one JSON file in a private
// storage bucket. One is made each day (see startBackupSchedule), the newest KEEP are kept,
// and a Manager can make one on demand or download a copy to keep somewhere else.
const BUCKET = 'backups';
export const KEEP = 14;
export const DAY_MS = 24 * 60 * 60 * 1000;
const NAME = /^rm-pos-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/;

const nameFor = (date) => `rm-pos-backup-${date.toISOString().replace(/[:.]/g, '-')}.json`;
// The name holds the time it was made, so it sorts and dates without extra lookups.
const timeOf = (name) => {
  const [, d, h, m, s, ms] = name.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  return `${d}T${h}:${m}:${s}.${ms}Z`;
};

async function ensureBucket(database) {
  const { error } = await database.storage.createBucket(BUCKET, { public: false });
  if (error && !/already exists/i.test(error.message)) throw error;
}

export async function listBackups({ database }) {
  await ensureBucket(database);
  const { data, error } = await database.storage.from(BUCKET).list('', { limit: 100 });
  if (error) throw error;
  return (data ?? [])
    .filter((file) => NAME.test(file.name))
    .map((file) => ({ name: file.name, size: file.metadata?.size ?? 0, createdAt: timeOf(file.name) }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

async function removeOld(database) {
  const old = (await listBackups({ database })).slice(KEEP).map((file) => file.name);
  if (!old.length) return;
  const { error } = await database.storage.from(BUCKET).remove(old);
  if (error) console.error('Could not remove old backups:', error);
}

export async function createBackup({ database }, { user = null, reason = 'Scheduled', now = new Date() } = {}) {
  const snapshot = unwrap(await database.rpc('backup_snapshot'));
  const body = Buffer.from(JSON.stringify(snapshot));
  const name = nameFor(now);
  await ensureBucket(database);
  const { error } = await database.storage.from(BUCKET).upload(name, body, { contentType: 'application/json' });
  if (error) {
    console.error('Backup upload failed:', error);
    throw new HttpError(502, 'The backup could not be saved. Try again.');
  }
  await removeOld(database);
  await writeAudit(database, { user, userName: 'System', action: 'Backup created', description: `${reason}: ${name}`, entityType: 'backup' });
  return { name, size: body.length, createdAt: timeOf(name) };
}

export async function downloadBackup({ database }, user, name) {
  if (!NAME.test(name ?? '')) throw new HttpError(404, 'That backup was not found.');
  const { data, error } = await database.storage.from(BUCKET).download(name);
  if (error || !data) throw new HttpError(404, 'That backup was not found.');
  await writeAudit(database, { user, action: 'Backup downloaded', description: name, entityType: 'backup' });
  return Buffer.from(await data.arrayBuffer());
}

// Checks every hour and makes a backup when the newest one is a day old or there is none.
// A free Render server sleeps when idle; the check then runs as soon as it wakes.
export function startBackupSchedule(clients, { everyMs = 60 * 60 * 1000, firstAfterMs = 60 * 1000, now = () => Date.now(), log = console.log } = {}) {
  let running = false;
  const check = async () => {
    if (running) return;
    running = true;
    try {
      const [latest] = await listBackups(clients);
      if (!latest || now() - Date.parse(latest.createdAt) >= DAY_MS) {
        const made = await createBackup(clients, { reason: 'Scheduled', now: new Date(now()) });
        log(JSON.stringify({ level: 'info', event: 'backup.created', name: made.name, bytes: made.size }));
      }
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'backup.failed', message: error.message }));
    } finally {
      running = false;
    }
  };
  const first = setTimeout(check, firstAfterMs);
  const timer = setInterval(check, everyMs);
  first.unref?.();
  timer.unref?.();
  return { check, stop: () => { clearTimeout(first); clearInterval(timer); } };
}
