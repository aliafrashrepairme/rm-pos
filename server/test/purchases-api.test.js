import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../app.js';
import { readConfig } from '../config.js';

const config = readConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' });
const PERMS = {
  manager: ['purchases.view', 'purchases.manage', 'supplier_payments.manage', 'suppliers.manage'],
  stock: ['purchases.view', 'purchases.manage', 'suppliers.manage'],
  cashier: ['pos.sell'],
  owner: ['reports.sales']
};
const ID = randomUUID();
const PO = {
  id: ID, po_no: 'PO-1', status: 'Ordered', source: 'Manual', supplier_invoice_no: null, note: '', ordered_at: 't', expected_at: null, created_at: 't', total: '100.00', paid_total: '0.00',
  suppliers: { id: 's', name: 'Lanka', contact_person: 'M', phone: '1', payment_terms: 'Cash' }, creator: { full_name: 'R' },
  purchase_items: [{ id: 'l1', line_no: 1, product_id: 'p', qty_ordered: '10.000', qty_received: '0.000', unit_cost: '10.00', products: { name: 'Nail', sku: 'S', barcode: 'B', unit_code: 'Piece' } }],
  goods_receipts: [],
  supplier_payments: []
};

function fakeDatabase({ updated = { id: ID } } = {}) {
  const database = {
    rpcCalls: [],
    audits: [],
    updates: [],
    auth: { admin: {} },
    rpc: async (name, args) => {
      database.rpcCalls.push([name, args]);
      if (name === 'receive_purchase') return { data: { id: 'g', grnNo: 'GRN-1', status: 'Received', replayed: false }, error: null };
      if (name === 'pay_supplier') return { data: { paymentNo: 'SP-1' }, error: null };
      if (name === 'auto_reorder') return { data: { created: ['PO-2'], withoutSupplier: 1 }, error: null };
      if (name === 'reorder_suggestions') return { data: [], error: null };
      return { data: ID, error: null };
    },
    from(table) {
      const call = { filters: [] };
      const chain = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        or: () => chain,
        range: () => chain,
        insert: (row) => { if (table === 'audit_logs') database.audits.push(row); return chain; },
        update: (change) => { call.update = change; database.updates.push([table, change]); return chain; },
        eq: (column, value) => { call.filters.push([column, value]); return chain; },
        in: (column, value) => { call.filters.push([column, value]); return chain; },
        maybeSingle: () => { call.single = true; return chain; },
        single: () => { call.single = true; return chain; },
        then(resolve) {
          if (table === 'profiles') {
            const id = call.filters[0][1];
            return resolve({ data: { id, username: id, full_name: id, role_code: id, email: 'x', active: true, must_change_password: false, roles: { role_permissions: (PERMS[id] || []).map((permission_code) => ({ permission_code })) } }, error: null });
          }
          if (table === 'purchases') {
            if (call.update) return resolve({ data: updated, error: null });
            return resolve({ data: call.single ? PO : [PO], count: 1, error: null });
          }
          if (table === 'store_settings') return resolve({ data: { store_name: 'RM', address: 'A', phone: 'P' }, error: null });
          if (table === 'suppliers') return resolve({ data: call.single ? { id: ID, code: 'SUP-1', name: 'New', payment_terms: 'Cash', lead_time_days: 5 } : [], error: null });
          resolve({ data: call.single ? null : [], error: null });
        }
      };
      return chain;
    }
  };
  return database;
}

const authClient = { auth: { getUser: async (token) => ({ data: { user: { id: token } }, error: null }) } };

async function withApi(options, run) {
  const database = fakeDatabase(options);
  const server = createApp({ config, authClient, database }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const as = (user, path, init = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user}` }
  });
  try {
    await run(as, database);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (body = {}) => ({ method: 'POST', body: JSON.stringify(body) });
const order = () => ({ supplierId: randomUUID(), items: [{ productId: randomUUID(), qty: 2, unitCost: 10 }] });
const delivery = () => ({ clientRequestId: randomUUID(), lines: [{ purchaseItemId: randomUUID(), qty: 1 }] });

test('each role reaches only what it should', async () => {
  await withApi({}, async (as) => {
    const expect = async (user, path, status, init) => assert.equal((await as(user, path, init)).status, status, `${user} ${path}`);
    for (const path of ['/api/purchases', '/api/purchases/summary', '/api/purchases/options', `/api/purchases/${ID}`]) {
      await expect('manager', path, 200);
      await expect('stock', path, 200);
      await expect('cashier', path, 403);
      await expect('owner', path, 403);
    }
    for (const user of ['cashier', 'owner']) {
      await expect(user, '/api/purchases', 403, post(order()));
      await expect(user, `/api/purchases/${ID}/receive`, 403, post(delivery()));
      await expect(user, `/api/purchases/${ID}/pay`, 403, post({ amount: 1, method: 'Cash' }));
      await expect(user, '/api/suppliers', 403, post({ name: 'S' }));
    }
    await expect('stock', '/api/purchases', 201, post(order()));
    await expect('stock', `/api/purchases/${ID}/receive`, 201, post(delivery()));
    await expect('stock', `/api/purchases/${ID}/pay`, 403, post({ amount: 1, method: 'Cash' }));
    await expect('manager', `/api/purchases/${ID}/pay`, 200, post({ amount: 1, method: 'Cash' }));
    await expect('stock', '/api/suppliers', 201, post({ name: 'S' }));
  });
});

test('orders use the session user and only accepted fields, and never start as received', async () => {
  await withApi({}, async (as, database) => {
    await as('stock', '/api/purchases', post({ ...order(), status: 'Received', created_by: 'x', paid_total: 500, total: 1 }));
    const [name, args] = database.rpcCalls[0];
    assert.equal(name, 'create_purchase');
    assert.equal(args.p_user, 'stock');
    assert.equal(args.p_purchase.status, 'Ordered');
    assert.equal(args.p_purchase.paid_total, undefined);
    assert.equal(args.p_purchase.total, undefined);
    assert.equal(args.p_purchase.source, 'Manual');
  });
});

test('bad orders, deliveries and payments stop before the database', async () => {
  await withApi({}, async (as, database) => {
    const create = (change) => as('manager', '/api/purchases', post({ ...order(), ...change }));
    assert.equal((await create({ supplierId: 'x' })).status, 400);
    assert.equal((await create({ items: [] })).status, 400);
    assert.equal((await create({ items: [{ productId: 'x', qty: 1, unitCost: 1 }] })).status, 400);
    assert.equal((await create({ items: [{ productId: randomUUID(), qty: 0, unitCost: 1 }] })).status, 400);
    assert.equal((await create({ items: [{ productId: randomUUID(), qty: 1, unitCost: -1 }] })).status, 400);
    assert.equal((await create({ expectedAt: 'soon' })).status, 400);
    const receive = (body) => as('manager', `/api/purchases/${ID}/receive`, post(body));
    assert.equal((await receive({ ...delivery(), clientRequestId: 'x' })).status, 400);
    assert.equal((await receive({ ...delivery(), lines: [] })).status, 400);
    assert.equal((await receive({ ...delivery(), lines: [{ purchaseItemId: randomUUID(), qty: -1 }] })).status, 400);
    assert.equal((await as('manager', `/api/purchases/${ID}/pay`, post({ amount: 0, method: 'Cash' }))).status, 400);
    assert.equal((await as('manager', `/api/purchases/${ID}/pay`, post({ amount: 'lots', method: 'Cash' }))).status, 400);
    assert.equal((await as('manager', '/api/suppliers', post({}))).status, 400);
    assert.equal((await as('manager', '/api/suppliers', post({ name: 'S', leadTimeDays: 2.5 }))).status, 400);
    assert.equal(database.rpcCalls.length, 0);
    assert.equal((await as('manager', '/api/purchases/not-an-id')).status, 404);
  });
});

test('send and cancel only apply to the right status', async () => {
  await withApi({ updated: null }, async (as) => {
    assert.equal((await as('manager', `/api/purchases/${ID}/send`, post())).status, 409);
    assert.equal((await as('manager', `/api/purchases/${ID}/cancel`, post())).status, 409);
  });
  await withApi({}, async (as, database) => {
    assert.equal((await as('manager', `/api/purchases/${ID}/send`, post())).status, 200);
    assert.equal(database.updates.at(-1)[1].status, 'Ordered');
    assert.deepEqual(database.audits.map((row) => row.action), ['Purchase order sent']);
  });
});

test('key actions reach the audit log', async () => {
  await withApi({}, async (as, database) => {
    await as('manager', '/api/purchases', post(order()));
    await as('manager', `/api/purchases/${ID}/receive`, post(delivery()));
    await as('manager', `/api/purchases/${ID}/pay`, post({ amount: 5, method: 'Cash' }));
    await as('manager', '/api/purchases/auto-reorder', post());
    assert.deepEqual(database.audits.map((row) => row.action), ['Purchase order created', 'Goods received', 'Supplier payment', 'Auto-reorder drafts']);
  });
});

test('the list shows received share and payment state', async () => {
  await withApi({}, async (as) => {
    const { purchases } = await (await as('stock', '/api/purchases?status=Ordered&q=a%22')).json();
    assert.equal(purchases[0].poNo, 'PO-1');
    assert.equal(purchases[0].receivedPercent, 0);
    assert.equal(purchases[0].paymentStatus, 'Unpaid');
    assert.equal(purchases[0].balance, 100);
  });
});
