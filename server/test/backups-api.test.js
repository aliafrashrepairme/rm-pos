import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../app.js';
import { readConfig } from '../config.js';
import { createRequestLog } from '../middleware/requestLog.js';
import { DAY_MS, KEEP, startBackupSchedule } from '../services/backups.js';

const config = readConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' });
const PERMS = { manager: ['backups.manage', 'settings.manage'], cashier: ['pos.sell'] };
const SNAPSHOT = { format: 'rm-pos-backup', version: 1, created_at: '2026-11-18T00:00:00Z', tables: { categories: [{ id: 'c1', name: 'Tools' }] } };

// Keeps backup files and audit rows between requests, like Supabase would.
function fakeDatabase({ failUpload = false } = {}) {
  const files = new Map();
  const database = {
    files,
    audit: [],
    auth: { admin: {} },
    rpc: async (name) => (name === 'backup_snapshot' ? { data: SNAPSHOT, error: null } : { data: null, error: { message: 'unknown' } }),
    storage: {
      createBucket: async () => ({ error: { message: 'The resource already exists' } }),
      from: () => ({
        list: async () => ({ data: [...files.keys()].map((name) => ({ name, metadata: { size: files.get(name).length } })), error: null }),
        upload: async (path, bytes) => { if (failUpload) return { error: { message: 'down' } }; files.set(path, bytes); return { error: null }; },
        download: async (path) => (files.has(path) ? { data: new Blob([files.get(path)]), error: null } : { data: null, error: { message: 'Object not found' } }),
        remove: async (paths) => { paths.forEach((path) => files.delete(path)); return { error: null }; }
      })
    },
    from(table) {
      const call = { filters: [] };
      const chain = {
        select: () => chain, limit: () => chain, single: () => chain, maybeSingle: () => chain,
        insert: (row) => { call.insert = row; return chain; },
        eq: (column, value) => { call.filters.push([column, value]); return chain; },
        then(resolve) {
          if (table === 'profiles') {
            const id = call.filters.find(([column]) => column === 'id')?.[1];
            return resolve({ data: { id, username: id, full_name: id, role_code: id, email: `${id}@x`, active: true, must_change_password: false, roles: { role_permissions: (PERMS[id] || []).map((permission_code) => ({ permission_code })) } }, error: null });
          }
          if (table === 'audit_logs') { database.audit.push(call.insert); return resolve({ data: null, error: null }); }
          resolve({ data: [{ id: true }], error: null });
        }
      };
      return chain;
    }
  };
  return database;
}

const authClient = { auth: { getUser: async (token) => ({ data: { user: { id: token } }, error: null }) } };

async function serve(database, requestLog) {
  const app = createApp({ config, authClient, database, ...(requestLog ? { requestLog } : {}) });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { as, method = 'GET' } = {}) => fetch(base + path, { method, headers: as ? { Authorization: `Bearer ${as}` } : {} });
  return { call, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('a Manager makes, lists and downloads backups; others cannot', async () => {
  const database = fakeDatabase();
  const { call, close } = await serve(database);
  try {
    assert.equal((await call('/api/backups')).status, 401);
    assert.equal((await call('/api/backups', { as: 'cashier' })).status, 403);
    assert.equal((await call('/api/backups', { as: 'cashier', method: 'POST' })).status, 403);

    const made = await call('/api/backups', { as: 'manager', method: 'POST' });
    assert.equal(made.status, 201);
    const { backup } = await made.json();
    assert.match(backup.name, /^rm-pos-backup-.*\.json$/);
    assert.equal(database.audit.at(-1).action, 'Backup created');

    const { backups, keep } = await (await call('/api/backups', { as: 'manager' })).json();
    assert.equal(keep, KEEP);
    assert.deepEqual(backups.map((file) => file.name), [backup.name]);

    const file = await call(`/api/backups/${backup.name}/download`, { as: 'manager' });
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-disposition'), /attachment/);
    assert.deepEqual(await file.json(), SNAPSHOT);
    assert.equal(database.audit.at(-1).action, 'Backup downloaded');

    assert.equal((await call(`/api/backups/${backup.name}/download`, { as: 'cashier' })).status, 403);
    assert.equal((await call('/api/backups/..%2F.env/download', { as: 'manager' })).status, 404);
    assert.equal((await call('/api/backups/rm-pos-backup-2000-01-01T00-00-00-000Z.json/download', { as: 'manager' })).status, 404);
  } finally {
    await close();
  }
});

test('a failed upload is reported, not hidden', async () => {
  const { call, close } = await serve(fakeDatabase({ failUpload: true }));
  try {
    const response = await call('/api/backups', { as: 'manager', method: 'POST' });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /could not be saved/);
  } finally {
    await close();
  }
});

test('the schedule backs up once a day and keeps only the newest copies', async () => {
  const database = fakeDatabase();
  let clock = Date.parse('2026-11-01T02:00:00Z');
  const schedule = startBackupSchedule({ database }, { everyMs: 1e9, firstAfterMs: 1e9, now: () => clock, log: () => {} });
  try {
    await schedule.check();
    assert.equal(database.files.size, 1, 'first check makes a backup');
    clock += DAY_MS / 2;
    await schedule.check();
    assert.equal(database.files.size, 1, 'no second backup within a day');
    for (let day = 0; day < KEEP + 5; day += 1) {
      clock += DAY_MS;
      await schedule.check();
    }
    assert.equal(database.files.size, KEEP, 'old backups are removed');
    const newest = [...database.files.keys()].sort().at(-1);
    assert.equal(newest, `rm-pos-backup-${new Date(clock).toISOString().replace(/[:.]/g, '-')}.json`);
  } finally {
    schedule.stop();
  }
});

test('the request log records each call without query strings and feeds System status', async () => {
  const lines = [];
  const requestLog = createRequestLog({ log: (line) => lines.push(JSON.parse(line)) });
  const database = fakeDatabase();
  const { call, close } = await serve(database, requestLog);
  try {
    await call('/api/health');
    await call('/api/backups?token=secret', { as: 'cashier' });
    const status = await (await call('/api/system/status', { as: 'manager' })).json();
    assert.equal(status.database, 'connected');
    assert.equal(status.lastBackupAt, null);
    assert.equal(status.backupOverdue, true);
    assert.equal(status.requests, 1, 'health checks are not counted');
    assert.equal(status.serverErrors, 0);
    assert.deepEqual(lines[0], { level: 'info', event: 'request', method: 'GET', path: '/api/backups', status: 403, ms: lines[0].ms });
    assert.ok(!JSON.stringify(lines).includes('secret'));
    assert.equal((await call('/api/system/status', { as: 'cashier' })).status, 403);
  } finally {
    await close();
  }
});
