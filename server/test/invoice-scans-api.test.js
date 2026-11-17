import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../app.js';
import { readConfig } from '../config.js';
import { ExtractionError } from '../services/invoiceExtractor.js';

const config = readConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' });
const PERMS = { manager: ['ai_scan.use'], stock: ['purchases.manage'], cashier: ['pos.sell'], owner: ['reports.sales'] };
const ID = randomUUID();
const PNG = Buffer.from('89504e470d0a1a0a00', 'hex');
const RESULT = { supplierName: 'Lanka', invoiceNo: 'INV-1', invoiceDate: null, subtotal: null, tax: null, total: 100, confidence: 90, lines: [{ description: 'Nail', qty: 1, unitCost: 100, lineTotal: 100, confidence: 90 }] };

function fakeDatabase({ status = 'Extracted', updated = 't', claim = { id: ID } } = {}) {
  const database = {
    rpcCalls: [],
    audits: [],
    updates: [],
    uploads: [],
    auth: { admin: {} },
    storage: {
      createBucket: async () => ({ error: { message: 'already exists' } }),
      from: () => ({
        upload: async (path, bytes) => { database.uploads.push(path); return { error: null, bytes }; },
        download: async () => ({ data: new Blob([PNG]), error: null })
      })
    },
    rpc: async (name, args) => {
      database.rpcCalls.push([name, args]);
      if (name === 'approve_invoice_scan') return { data: { purchaseId: 'po-id', poNo: 'PO-1' }, error: null };
      return { data: null, error: null };
    },
    from(table) {
      const call = { filters: [] };
      const chain = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        neq: () => chain,
        in: (column, values) => { call.filters.push([column, values]); return chain; },
        insert: (value) => { if (table === 'audit_logs') database.audits.push(value); else call.insert = value; return chain; },
        update: (value) => { call.update = value; database.updates.push(value); return chain; },
        eq: (column, value) => { call.filters.push([column, value]); return chain; },
        maybeSingle: () => { call.single = true; return chain; },
        single: () => { call.single = true; return chain; },
        then(resolve) {
          if (table === 'profiles') {
            const id = call.filters[0][1];
            return resolve({ data: { id, username: id, full_name: id, role_code: id, email: 'x', active: true, must_change_password: false, roles: { role_permissions: (PERMS[id] || []).map((permission_code) => ({ permission_code })) } }, error: null });
          }
          if (table === 'invoice_scans') {
            if (call.update) return resolve({ data: claim && { id: ID, file_name: 'inv.png' }, error: null });
            if (call.insert) return resolve({ data: { id: call.insert.id, file_name: call.insert.file_name, mime_type: call.insert.mime_type }, error: null });
            const row = { id: ID, file_path: 'p', file_name: 'inv.png', mime_type: 'image/png', status, updated_at: updated, provider: 'Claude', error_message: null, invoice_no: 'INV-1', supplier_id: null, overall_confidence: '90.00', raw_result: RESULT, purchases: null };
            return resolve({ data: call.single ? row : [row], error: null });
          }
          if (table === 'invoice_scan_lines') return resolve({ data: [{ id: 'l1', raw_text: 'Nail', qty: '1.000', unit_cost: '100.00', confidence: '90.00', matched_product_id: null, match_score: null }], error: null });
          resolve({ data: call.single ? null : [], error: null });
        }
      };
      return chain;
    }
  };
  return database;
}

const authClient = { auth: { getUser: async (token) => ({ data: { user: { id: token } }, error: null }) } };
const working = (result = RESULT) => {
  const calls = [];
  return { provider: 'Claude', calls, extract: async (input) => { calls.push(input); if (result instanceof Error) throw result; return result; } };
};

async function withApi(extractor, options, run) {
  const database = fakeDatabase(options);
  const server = createApp({ config, authClient, database, extractor }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const as = (user, path, init = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user}`, ...init.headers }
  });
  try {
    await run(as, database);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const upload = (body = PNG, type = 'image/png') => ({ method: 'POST', body, headers: { 'Content-Type': type } });
const post = (body) => ({ method: 'POST', body: JSON.stringify(body) });
const REVIEW = { supplierId: randomUUID(), invoiceNo: 'INV-1', invoiceDate: '2026-03-02', lines: [{ description: 'Nail', qty: 1, unitCost: 100, productId: randomUUID() }] };

test('only people with the scan permission reach anything', async () => {
  await withApi(working(), {}, async (as) => {
    for (const user of ['stock', 'cashier', 'owner']) {
      for (const path of ['/api/invoice-scans', '/api/invoice-scans/status', '/api/invoice-scans/options', `/api/invoice-scans/${ID}`, `/api/invoice-scans/${ID}/file`]) {
        assert.equal((await as(user, path)).status, 403, `${user} ${path}`);
      }
      assert.equal((await as(user, '/api/invoice-scans', upload())).status, 403, user);
      assert.equal((await as(user, `/api/invoice-scans/${ID}/approve`, post(REVIEW))).status, 403, user);
    }
    assert.equal((await as('manager', '/api/invoice-scans')).status, 200);
  });
});

test('with no service connected it says so and stores nothing', async () => {
  await withApi(null, {}, async (as, database) => {
    assert.deepEqual(await (await as('manager', '/api/invoice-scans/status')).json(), { connected: false, provider: null });
    const response = await as('manager', '/api/invoice-scans', upload());
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, 'SCAN_NOT_CONNECTED');
    assert.match(body.error, /not connected/);
    assert.equal(database.uploads.length, 0);
    assert.equal(database.rpcCalls.length, 0);
  });
});

test('files are checked by their content, not their label', async () => {
  const extractor = working();
  await withApi(extractor, {}, async (as, database) => {
    assert.equal((await as('manager', '/api/invoice-scans', upload(Buffer.from('not a png')))).status, 415);
    assert.equal((await as('manager', '/api/invoice-scans', upload(PNG, 'application/pdf'))).status, 415);
    assert.equal((await as('manager', '/api/invoice-scans', upload(PNG, 'text/plain'))).status, 415);
    assert.equal((await as('manager', '/api/invoice-scans', upload(Buffer.alloc(4 * 1024 * 1024, 0x89).fill(PNG, 0, 8)))).status, 413);
    assert.equal(database.uploads.length, 0);
    assert.equal(extractor.calls.length, 0);
  });
});

test('a good upload is read, saved and audited', async () => {
  const extractor = working();
  await withApi(extractor, {}, async (as, database) => {
    const response = await as('manager', '/api/invoice-scans?name=My%20Invoice%3Cscript%3E.png', upload());
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(extractor.calls[0].mimeType, 'image/png');
    assert.equal(database.rpcCalls[0][0], 'save_invoice_extraction');
    assert.equal(database.rpcCalls[0][1].p_provider, 'Claude');
    assert.deepEqual(database.audits.map((row) => row.action), ['Invoice scanned']);
    assert.match(database.audits[0].description, /^My Invoicescript\.png/);
    assert.equal(database.uploads.length, 1);
  });
});

test('a failed reading is kept as Failed with its message, not an error page', async (t) => {
  t.mock.method(console, 'error', () => {});
  await withApi(working(new ExtractionError('Try a clearer photo.')), {}, async (as, database) => {
    const response = await as('manager', '/api/invoice-scans', upload());
    assert.equal(response.status, 201);
    assert.equal(database.updates[0].status, 'Failed');
    assert.equal(database.updates[0].error_message, 'Try a clearer photo.');
    assert.equal(database.rpcCalls.length, 0);
    assert.deepEqual(database.audits.map((row) => row.action), ['Invoice scan failed']);
  });
  await withApi(working(new Error('secret detail')), {}, async (as, database) => {
    await as('manager', '/api/invoice-scans', upload());
    assert.ok(!database.updates[0].error_message.includes('secret'));
  });
});

test('only a failed scan can be tried again, once', async () => {
  await withApi(working(), { status: 'Extracted' }, async (as) => {
    assert.equal((await as('manager', `/api/invoice-scans/${ID}/retry`, post({}))).status, 409);
  });
  const extractor = working();
  await withApi(extractor, { status: 'Failed' }, async (as) => {
    assert.equal((await as('manager', `/api/invoice-scans/${ID}/retry`, post({}))).status, 200);
    assert.equal(extractor.calls.length, 1);
  });
  const raced = working();
  await withApi(raced, { status: 'Failed', claim: null }, async (as) => {
    assert.equal((await as('manager', `/api/invoice-scans/${ID}/retry`, post({}))).status, 409);
    assert.equal(raced.calls.length, 0, 'nobody pays to read it twice');
  });
});

test('reviews are validated before the database', async () => {
  await withApi(working(), {}, async (as, database) => {
    const send = (change) => as('manager', `/api/invoice-scans/${ID}/approve`, post({ ...REVIEW, ...change }));
    const line = REVIEW.lines[0];
    assert.equal((await send({ supplierId: 'x' })).status, 400);
    assert.equal((await send({ invoiceDate: 'soon' })).status, 400);
    assert.equal((await send({ invoiceNo: 'x'.repeat(61) })).status, 400);
    assert.equal((await send({ lines: 'nope' })).status, 400);
    assert.equal((await send({ lines: [{ ...line, description: ' ' }] })).status, 400);
    assert.equal((await send({ lines: [{ ...line, qty: -1 }] })).status, 400);
    assert.equal((await send({ lines: [{ ...line, unitCost: 'lots' }] })).status, 400);
    assert.equal((await send({ lines: [{ ...line, productId: 'x' }] })).status, 400);
    assert.equal(database.rpcCalls.length, 0);
    assert.equal((await as('manager', '/api/invoice-scans/not-an-id')).status, 404);
  });
});

test('approval uses the session user and reaches the audit log', async () => {
  await withApi(working(), {}, async (as, database) => {
    const response = await as('manager', `/api/invoice-scans/${ID}/approve`, post({ ...REVIEW, created_by: 'hacker' }));
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.poNo, 'PO-1');
    const [name, args] = database.rpcCalls[0];
    assert.equal(name, 'approve_invoice_scan');
    assert.equal(args.p_user, 'manager');
    assert.equal(args.p_review.created_by, undefined);
    assert.deepEqual(database.audits.map((row) => row.action), ['Invoice approved']);
  });
});

test('the stored file comes back with its own type and cannot be sniffed', async () => {
  await withApi(working(), {}, async (as) => {
    const response = await as('manager', `/api/invoice-scans/${ID}/file`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  });
});

test('the API key never reaches a reply', async () => {
  const secret = 'sk-ant-secret-value';
  const keyed = readConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's', ANTHROPIC_API_KEY: secret });
  assert.equal(keyed.anthropicApiKey, secret);
  await withApi(working(), {}, async (as) => {
    const text = await (await as('manager', '/api/invoice-scans/status')).text();
    assert.ok(!text.includes(secret));
    assert.deepEqual(JSON.parse(text), { connected: true, provider: 'Claude' });
  });
});
