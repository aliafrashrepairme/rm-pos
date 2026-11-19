import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../app.js';
import { readConfig } from '../config.js';

const config = readConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' });
const PERMS = {
  owner: ['settings.logo', 'reports.sales'],
  manager: ['settings.manage', 'users.manage'],
  cashier: ['pos.sell']
};
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

// Keeps the logo path and stored files between requests, like Supabase would.
function fakeDatabase() {
  const files = new Map();
  const database = {
    logoPath: '',
    files,
    audit: [],
    auth: { admin: {} },
    storage: {
      createBucket: async () => ({ error: { message: 'The resource already exists' } }),
      from: () => ({
        upload: async (path, bytes) => { files.set(path, bytes); return { error: null }; },
        download: async (path) => (files.has(path)
          ? { data: new Blob([files.get(path)]), error: null }
          : { data: null, error: { message: 'Object not found' } }),
        remove: async (paths) => { paths.forEach((path) => files.delete(path)); return { error: null }; }
      })
    },
    from(table) {
      const call = { filters: [] };
      const chain = {
        select: () => chain,
        update: (change) => { call.update = change; return chain; },
        insert: (row) => { call.insert = row; return chain; },
        eq: (column, value) => { call.filters.push([column, value]); return chain; },
        single: () => chain,
        maybeSingle: () => chain,
        then(resolve) {
          if (table === 'profiles') {
            const id = call.filters.find(([column]) => column === 'id')?.[1];
            return resolve({ data: { id, username: id, full_name: id, role_code: id, email: `${id}@x`, active: true, must_change_password: false, roles: { role_permissions: (PERMS[id] || []).map((permission_code) => ({ permission_code })) } }, error: null });
          }
          if (table === 'audit_logs') { database.audit.push(call.insert); return resolve({ data: null, error: null }); }
          if (table === 'store_settings') {
            if (call.update) database.logoPath = call.update.logo_path;
            return resolve({ data: { logo_path: database.logoPath }, error: null });
          }
          resolve({ data: [], error: null });
        }
      };
      return chain;
    }
  };
  return database;
}

const authClient = { auth: { getUser: async (token) => ({ data: { user: { id: token } }, error: null }) } };

async function withApi(run) {
  const database = fakeDatabase();
  const server = createApp({ config, authClient, database }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, init = {}) => fetch(base + path, init);
  const as = (user, path, init = {}) => call(path, { ...init, headers: { Authorization: `Bearer ${user}`, ...init.headers } });
  try {
    await run({ call, as, database });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const upload = (body, type = 'image/png') => ({ method: 'PUT', headers: { 'Content-Type': type }, body });

test('with no logo set, anyone gets an empty answer and the app uses its own', async () => {
  await withApi(async ({ call }) => {
    const response = await call('/api/logo');
    assert.equal(response.status, 204);
  });
});

test('only the Owner can change or remove the logo', async () => {
  await withApi(async ({ call, as, database }) => {
    assert.equal((await call('/api/logo', upload(PNG))).status, 401);
    for (const user of ['manager', 'cashier']) {
      assert.equal((await as(user, '/api/logo', upload(PNG))).status, 403, user);
      assert.equal((await as(user, '/api/logo', { method: 'DELETE' })).status, 403, user);
    }
    assert.equal(database.logoPath, '');
    assert.equal(database.files.size, 0);
  });
});

test('the Owner sets a logo, everyone can read it, and removing it brings the default back', async () => {
  await withApi(async ({ call, as, database }) => {
    assert.equal((await as('owner', '/api/logo', upload(PNG))).status, 204);
    assert.match(database.logoPath, /^logo\/.+\.png$/);
    const shown = await call('/api/logo');
    assert.equal(shown.status, 200);
    assert.equal(shown.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await shown.arrayBuffer()), PNG);

    // A new logo replaces the old file rather than leaving it behind.
    assert.equal((await as('owner', '/api/logo', upload(PNG))).status, 204);
    assert.equal(database.files.size, 1);

    assert.equal((await as('owner', '/api/logo', { method: 'DELETE' })).status, 204);
    assert.equal(database.logoPath, '');
    assert.equal(database.files.size, 0);
    assert.equal((await call('/api/logo')).status, 204);
    assert.deepEqual(database.audit.map((row) => row.action), ['Store logo changed', 'Store logo changed', 'Store logo removed']);
  });
});

test('only real JPG, PNG or WebP images up to 1 MB are accepted', async () => {
  await withApi(async ({ as, database }) => {
    assert.equal((await as('owner', '/api/logo', upload(Buffer.from('not an image')))).status, 415);
    assert.equal((await as('owner', '/api/logo', upload(PNG, 'image/gif'))).status, 415);
    assert.equal((await as('owner', '/api/logo', upload(Buffer.alloc(1024 * 1024 + 10, 0x89)))).status, 413);
    assert.equal(database.logoPath, '');
  });
});
