import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../app.js';
import { readConfig } from '../config.js';
import { parseCsv, toCsv } from '../services/csv.js';

const config = readConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' });
const PERMS = { manager: ['import_export.use', 'lists.manage', 'audit.view'], cashier: ['pos.sell'], owner: ['reports.sales'], stock: ['products.manage'] };
const TABLES = {
  categories: [{ id: 'c1', name: 'Tools', active: true }],
  units: [{ code: 'Piece', allow_decimal_qty: false, active: true }, { code: 'Metre', allow_decimal_qty: true, active: true }],
  tax_rates: [{ id: 't1', name: 'Standard VAT', rate: '18.00', is_default: true, active: true }],
  suppliers: [{ id: 's1', name: 'Lanka', active: true }],
  products: [{ sku: 'OLD-1', barcode: '4791234000017', name: 'Old Hammer', active: true, category_id: 'c1', unit_code: 'Piece', tax_rate_id: 't1' }],
  customers: [{ name: 'Ravi', phone: '0771111111', active: true }],
  number_sequences: [{ prefix: 'RM-INV-' }]
};

function fakeDatabase({ count = 0 } = {}) {
  const database = {
    rpcCalls: [],
    audits: [],
    inserts: [],
    updates: [],
    filters: [],
    auth: { admin: {} },
    rpc: async (name, args) => {
      database.rpcCalls.push([name, args]);
      if (name === 'import_records') return { data: args.p_rows.length, error: null };
      if (name === 'report_period') return { data: { from: 'a', to: 'b', start: 's', end: 'e', timeZone: 'Asia/Colombo' }, error: null };
      if (name === 'audit_actions') return { data: ['User login'], error: null };
      return { data: null, error: null };
    },
    from(table) {
      const call = { filters: [] };
      const chain = {
        select: () => chain,
        order: () => chain,
        range: () => chain,
        gte: () => chain,
        lt: () => chain,
        or: (text) => { database.filters.push(text); return chain; },
        ilike: (column, value) => { call.filters.push(['ilike', value]); return chain; },
        insert: (value) => { if (table === 'audit_logs') database.audits.push(value); else { call.insert = value; database.inserts.push([table, value]); } return chain; },
        update: (value) => { call.update = value; database.updates.push([table, value]); return chain; },
        eq: (column, value) => { call.filters.push([column, value]); return chain; },
        maybeSingle: () => { call.single = true; return chain; },
        single: () => { call.single = true; return chain; },
        then(resolve) {
          if (table === 'profiles') {
            const id = call.filters[0][1];
            return resolve({ data: { id, username: id, full_name: id, role_code: id, email: 'x', active: true, must_change_password: false, roles: { role_permissions: (PERMS[id] || []).map((permission_code) => ({ permission_code })) } }, error: null });
          }
          if (table === 'audit_logs') return resolve({ data: [{ id: 1, created_at: 't', user_name: 'A', action: 'User login', description: '=cmd', entity_type: '', entity_id: '' }], count: 1, error: null });
          if (call.insert || call.update) return resolve({ data: call.insert ?? call.update, count, error: null });
          if (call.single) {
            const lookup = call.filters.find(([column]) => column === 'ilike')?.[1];
            if (lookup) return resolve({ data: (TABLES[table] ?? []).find((row) => (row.code ?? row.name).toLowerCase() === lookup.toLowerCase()) ?? null, error: null });
            return resolve({ data: { name: 'Standard VAT', is_default: true, ...(TABLES[table]?.[0] ?? {}) }, error: null });
          }
          resolve({ data: TABLES[table] ?? [], count, error: null });
        }
      };
      return chain;
    }
  };
  return database;
}

const authClient = { auth: { getUser: async (token) => ({ data: { user: { id: token } }, error: null }) } };

async function withApi(run, options) {
  const database = fakeDatabase(options);
  const server = createApp({ config, authClient, database, extractor: null }).listen(0);
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

const csv = (body) => ({ method: 'POST', body, headers: { 'Content-Type': 'text/csv' } });
const validate = async (as, type, body) => (await as('manager', `/api/data/import/${type}/validate`, csv(body))).json();
const HEAD = 'name,sku,barcode,category,unit,selling_price,cost_price,tax_rate,opening_stock,min_stock,location,supplier,description';

test('CSV reading handles quotes, line breaks, commas and Excel markers', () => {
  const { records } = parseCsv('﻿a,b\r\n"x, ""y""","line\nbreak"\r\n\r\n,\r\nlast,row');
  assert.deepEqual(records.map((row) => row.cells), [['a', 'b'], ['x, "y"', 'line\nbreak'], ['last', 'row']]);
  assert.equal(records[2].line, 6, 'line numbers count every line in the file');
  assert.match(parseCsv('a,"never closed').error, /never closed/);
});

test('CSV writing is safe to open in a spreadsheet', () => {
  const out = toCsv([['n', (row) => row.n]], [{ n: '=HYPERLINK("x")' }, { n: -5 }, { n: 'a,b' }]);
  assert.ok(out.startsWith('﻿n\r\n'));
  assert.ok(out.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(out.includes('\r\n-5\r\n'));
  assert.ok(out.includes('"a,b"'));
});

test('only a Manager reaches import, export, lists and the audit log', async () => {
  await withApi(async (as) => {
    for (const user of ['cashier', 'owner', 'stock']) {
      for (const path of ['/api/data/export/products', '/api/data/import/products/template', '/api/lists', '/api/audit', '/api/audit/export']) {
        assert.equal((await as(user, path)).status, 403, `${user} ${path}`);
      }
      assert.equal((await as(user, '/api/data/import/products', csv('x'))).status, 403, user);
      assert.equal((await as(user, '/api/lists/units', { method: 'POST', body: '{}' })).status, 403, user);
    }
    assert.equal((await as('manager', '/api/lists')).status, 200);
    assert.equal((await as('manager', '/api/audit')).status, 200);
  });
});

test('there is no way to change the audit log through the API', async () => {
  await withApi(async (as) => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      assert.equal((await as('manager', '/api/audit', { method, body: method === 'DELETE' ? undefined : '{}' })).status, 404, method);
    }
  });
});

test('a good product file passes and imports with names turned into ids', async () => {
  await withApi(async (as, database) => {
    const file = `${HEAD}\nNew Saw,NS-1,,tools,piece,"1,500",900,,4,2,Rack,lanka,Nice\nNew Tape,,,Tools,Metre,20,,,2.5,,,,`;
    const report = await validate(as, 'products', file);
    assert.deepEqual([report.total, report.errorCount, report.fileErrors], [2, 0, []]);
    const response = await as('manager', '/api/data/import/products', csv(file));
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { imported: 2 });
    const [name, args] = database.rpcCalls.find(([called]) => called === 'import_records');
    assert.equal(name, 'import_records');
    assert.equal(args.p_user, 'manager');
    const first = args.p_rows[0];
    assert.deepEqual([first.categoryId, first.unitCode, first.taxRateId, first.preferredSupplierId, first.sellingPrice, first.openingStock], ['c1', 'Piece', 't1', 's1', 1500, 4]);
    assert.deepEqual(database.audits.map((row) => row.action), ['Data imported']);
  });
});

test('every problem is reported against its line', async () => {
  await withApi(async (as) => {
    const file = [
      HEAD,
      ',,,Tools,Piece,10,,,,,,,',
      'Old Hammer,OLD-1,4791234000017,Tools,Piece,10,,,,,,,',
      'Twin,TW-1,,Tools,Piece,10,,,,,,,',
      'twin,tw-1,,Tools,Piece,10,,,,,,,',
      'Bad,B-1,123,Nope,Bag,abc,-1,Luxury,1.5,,,Ghost,',
      'Whole,W-1,,Tools,Piece,10,,,1.5,,,,',
      'Check,C-1,4791234000018,Tools,Piece,10,,,,,,,',
      'Extra,E-1,,Tools,Piece,10,,,,,,,,one too many'
    ].join('\n');
    const { rows, errorCount } = await validate(as, 'products', file);
    assert.equal(errorCount, 7);
    const errorsOn = (line) => rows.find((row) => row.line === line).errors.join(' | ');
    assert.match(errorsOn(2), /name is required/);
    assert.match(errorsOn(3), /name already exists/);
    assert.match(errorsOn(3), /SKU is already used/);
    assert.match(errorsOn(3), /barcode is already used/);
    assert.equal(errorsOn(4), '');
    assert.match(errorsOn(5), /name is repeated/);
    assert.match(errorsOn(5), /SKU is repeated/);
    for (const pattern of [/Barcode must be/, /Category "Nope"/, /Unit "Bag"/, /Selling price/, /Cost price/, /Tax rate "Luxury"/, /Supplier "Ghost"/]) assert.match(errorsOn(6), pattern);
    assert.match(errorsOn(7), /whole number for unit Piece/);
    assert.match(errorsOn(8), /check digit/);
    assert.match(errorsOn(9), /more values/);
  });
});

test('a file with any error imports nothing', async () => {
  await withApi(async (as, database) => {
    const response = await as('manager', '/api/data/import/products', csv(`${HEAD}\nGood,G-1,,Tools,Piece,10,,,,,,,\n,,,Tools,Piece,10,,,,,,,`));
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /Nothing was imported/);
    assert.ok(!database.rpcCalls.some(([name]) => name === 'import_records'));
    assert.equal(database.audits.length, 0);
  });
});

test('bad files get clear messages', async () => {
  await withApi(async (as) => {
    assert.match((await validate(as, 'products', '  ')).fileErrors[0], /empty/);
    assert.match((await validate(as, 'products', 'name,category,unit,selling_price')).fileErrors[0], /no rows/);
    assert.match((await validate(as, 'products', 'name,wrong\nA,B')).fileErrors.join(), /Unknown columns: wrong.*Missing columns: category, unit, selling_price/);
    assert.match((await validate(as, 'customers', 'name,name\nA,B')).fileErrors[0], /Repeated columns/);
    assert.match((await validate(as, 'customers', `name\n${'A\n'.repeat(2001)}`)).fileErrors[0], /at most 2000/);
    assert.equal((await as('manager', '/api/data/import/users/validate', csv('name\nA'))).status, 404);
  });
});

test('customers and suppliers refuse duplicates', async () => {
  await withApi(async (as) => {
    const people = await validate(as, 'customers', 'name,phone,email,loyalty_points\nA,0771111111,,\nB,0772222222,bad,1.5\nC,0772222222,,\nD,abc,,');
    assert.match(people.rows[0].errors.join(), /phone number already exists/);
    assert.match(people.rows[1].errors.join(), /Email is not valid.*Loyalty points/);
    assert.match(people.rows[2].errors.join(), /repeated in the file/);
    assert.match(people.rows[3].errors.join(), /Phone number is not valid/);
    const firms = await validate(as, 'suppliers', 'name,lead_time_days\nLanka,\nNew,999\nnew,');
    assert.match(firms.rows[0].errors.join(), /already exists/);
    assert.match(firms.rows[1].errors.join(), /Lead time/);
    assert.match(firms.rows[2].errors.join(), /repeated/);
  });
});

test('templates import cleanly in shape, and exports are recorded', async () => {
  await withApi(async (as, database) => {
    const template = await (await as('manager', '/api/data/import/customers/template')).text();
    assert.deepEqual((await validate(as, 'customers', template)).fileErrors, []);
    for (const kind of ['products', 'bills', 'ledger', 'valuation']) {
      const response = await as('manager', `/api/data/export/${kind}`);
      assert.equal(response.status, 200, kind);
      assert.match(response.headers.get('content-type'), /text\/csv/);
    }
    assert.equal(database.audits.filter((row) => row.action === 'Data exported').length, 4);
    assert.equal((await as('manager', '/api/data/export/constructor')).status, 404);
    assert.equal((await as('manager', '/api/data/export/bills?from=soon&to=later')).status, 400);
  });
});

test('audit search cannot break out, and its export is safe', async () => {
  await withApi(async (as, database) => {
    await as('manager', '/api/audit?q=a%22,action.eq.x');
    assert.ok(!database.filters[0].includes('a"'), database.filters[0]);
    const text = await (await as('manager', '/api/audit/export')).text();
    assert.ok(text.includes(`'=cmd`));
    assert.equal(database.audits.at(-1).action, 'Data exported');
  });
});

test('lists refuse duplicates and anything still in use', async () => {
  await withApi(async (as) => {
    const post = (path, body) => as('manager', `/api/lists/${path}`, { method: 'POST', body: JSON.stringify(body) });
    const patch = (path, body) => as('manager', `/api/lists/${path}`, { method: 'PATCH', body: JSON.stringify(body) });
    assert.equal((await post('units', { code: ' ' })).status, 400);
    assert.equal((await post('units', { code: 'piece' })).status, 409);
    assert.equal((await post('units', { code: 'Box' })).status, 201);
    assert.equal((await post('tax-rates', { name: 'X', rate: 500 })).status, 400);
    assert.equal((await post('tax-rates', { name: 'standard vat', rate: 5 })).status, 409);
    assert.equal((await patch('units/Piece', { active: 'no' })).status, 400);
    assert.equal((await patch('tax-rates/t1', { active: false })).status, 409, 'the default rate stays on');
  });
  await withApi(async (as) => {
    const response = await as('manager', '/api/lists/units/Piece', { method: 'PATCH', body: JSON.stringify({ active: false }) });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /3 active product/);
  }, { count: 3 });
});
