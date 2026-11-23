import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { findByCode, searchProducts } from './catalog.js';
import { offlineSignIn, rememberSignIn, forgetSignIn } from './offlineAuth.js';
import { addDraft, listDrafts, removeDraft, retryDraft, sendDrafts } from './outbox.js';
import { getValue, rawSaved, replaceDeviceKeyForTests, resetMemoryStore, setValue } from './store.js';

const products = [
  { id: 'a', name: 'Claw Hammer', sku: 'HAM-01', barcode: '4006381333931', categoryId: 'tools', stock: 10 },
  { id: 'b', name: 'Steel Nails 2in', sku: 'NAIL-02', barcode: 'NAIL2000', categoryId: 'tools', stock: 50 },
  { id: 'c', name: 'Wall Paint White', sku: 'PNT-01', barcode: '012345678905', categoryId: 'paint', stock: 4 }
];

beforeEach(() => resetMemoryStore());

test('offline search matches name, SKU or barcode words, by category, a page at a time', () => {
  assert.deepEqual(searchProducts(products, { q: 'nail' }).products.map((p) => p.id), ['b']);
  assert.deepEqual(searchProducts(products, { q: 'ham-01' }).products.map((p) => p.id), ['a']);
  assert.deepEqual(searchProducts(products, { q: 'wall white' }).products.map((p) => p.id), ['c']);
  assert.equal(searchProducts(products, { categoryId: 'tools' }).total, 2);
  const paged = searchProducts(products, { page: 2, pageSize: 2 });
  assert.equal(paged.total, 3);
  assert.deepEqual(paged.products.map((p) => p.id), ['c']);
});

test('offline barcode lookup accepts the same codes as the server', () => {
  assert.equal(findByCode(products, 'NAIL2000').id, 'b');
  assert.equal(findByCode(products, 'ham-01').id, 'a');
  // A UPC-A label and the same code read as EAN-13 with a leading zero.
  assert.equal(findByCode(products, '0012345678905').id, 'c');
  assert.equal(findByCode(products, 'UNKNOWN1'), null);
});

const saleBody = (id) => ({ clientRequestId: id, items: [{ productId: 'a', qty: 1 }], expectedTotal: 1500, payment: { method: 'Cash', amountTendered: 2000 } });
const fail = (status, message) => Object.assign(new Error(message), { status });

test('a draft is sent once, and a lost reply sent again gets the same bill back', async () => {
  await addDraft({ kind: 'sale', body: saleBody('11111111-1111-4111-8111-111111111111'), summary: { total: 1500 }, userId: 'u1' });
  const calls = [];
  // First attempt: the connection drops. The draft must stay waiting.
  await sendDrafts({ userId: 'u1', send: async (path, options) => { calls.push(path); throw fail(0, 'offline'); } });
  assert.equal((await listDrafts())[0].status, 'pending');
  // Second attempt: the server answers (on a real server, a replay returns the same bill).
  await sendDrafts({ userId: 'u1', send: async (path, options) => { calls.push(JSON.parse(options.body).clientRequestId); return { sale: { id: 's1', billNo: 'RM-INV-000007' } }; } });
  const [entry] = await listDrafts();
  assert.equal(entry.status, 'sent');
  assert.equal(entry.result.number, 'RM-INV-000007');
  assert.equal(calls.at(-1), '11111111-1111-4111-8111-111111111111');
  // Sending again does nothing: it is already sent.
  await sendDrafts({ userId: 'u1', send: async () => { throw new Error('must not be called'); } });
});

test('a refused draft is marked failed with the reason, and can be retried or removed', async () => {
  await addDraft({ kind: 'sale', body: saleBody('22222222-2222-4222-8222-222222222222'), summary: {}, userId: 'u1' });
  await sendDrafts({ userId: 'u1', send: async () => { throw fail(409, 'The total changed: prices were updated.'); } });
  let [entry] = await listDrafts();
  assert.equal(entry.status, 'failed');
  assert.match(entry.error, /total changed/);
  await retryDraft(entry.id, { userId: 'u1', send: async () => ({ sale: { id: 's2', billNo: 'RM-INV-000008' } }) });
  [entry] = await listDrafts();
  assert.equal(entry.status, 'sent');
  assert.equal(await removeDraft(entry.id), true);
  assert.equal((await listDrafts()).length, 0);
});

test('server restarts and expired sign-ins leave drafts waiting, not failed', async () => {
  await addDraft({ kind: 'quotation', body: { clientRequestId: '33333333-3333-4333-8333-333333333333', items: [] }, summary: {}, userId: 'u1' });
  for (const status of [401, 502, 503]) {
    await sendDrafts({ userId: 'u1', send: async () => { throw fail(status, 'later'); } });
    assert.equal((await listDrafts())[0].status, 'pending', `status ${status}`);
  }
});

test("a waiting draft can't be removed, and each person's drafts wait for that person", async () => {
  await addDraft({ kind: 'sale', body: saleBody('44444444-4444-4444-8444-444444444444'), summary: {}, userId: 'cashier-a' });
  assert.equal(await removeDraft('44444444-4444-4444-8444-444444444444'), false);
  await sendDrafts({ userId: 'cashier-b', send: async () => { throw new Error('must not be called'); } });
  assert.equal((await listDrafts())[0].status, 'pending');
});

test('two sends crossing each other count as one bill', async () => {
  await addDraft({ kind: 'sale', body: saleBody('55555555-5555-4555-8555-555555555555'), summary: {}, userId: 'u1' });
  let calls = 0;
  await sendDrafts({
    userId: 'u1',
    send: async () => {
      calls += 1;
      if (calls === 1) throw fail(409, 'This sale has already been recorded.');
      return { sale: { id: 's5', billNo: 'RM-INV-000009' } };
    }
  });
  const [entry] = await listDrafts();
  assert.equal(entry.status, 'sent');
  assert.equal(entry.result.number, 'RM-INV-000009');
});

test('offline sign-in needs the same password, a recent online sign-in, and stops after a password change', async () => {
  const user = { id: 'u1', username: 'cashier', email: 'cashier@staff.rm-pos.local', role: 'Cashier', permissions: ['pos.sell'] };
  await rememberSignIn('Cashier', 'Correct-horse-1', user);
  assert.equal((await offlineSignIn('cashier', 'Correct-horse-1')).id, 'u1');
  assert.equal((await offlineSignIn('cashier@staff.rm-pos.local', 'Correct-horse-1')).id, 'u1');
  assert.equal(await offlineSignIn('cashier', 'wrong-password'), null);
  assert.equal(await offlineSignIn('cashier', 'Correct-horse-1', Date.now() + 15 * 24 * 60 * 60 * 1000), null);
  await forgetSignIn(user);
  assert.equal(await offlineSignIn('cashier', 'Correct-horse-1'), null);
});

test('everything saved on the device is encrypted, and reads back as saved', async () => {
  await setValue('cart:u1', { customer: { name: 'Kamal Perera', phone: '0771234567' }, lines: [{ id: 'a', qty: 2 }] });
  const raw = await rawSaved.value('cart:u1');
  assert.equal(raw.sealed, 1);
  assert.doesNotMatch(Buffer.from(raw.data).toString('latin1'), /Kamal|0771234567/);
  assert.equal((await getValue('cart:u1')).customer.name, 'Kamal Perera');

  await addDraft({ kind: 'sale', body: saleBody('66666666-6666-4666-8666-666666666666'), summary: { customer: 'Kamal Perera', total: 1500 }, userId: 'u1' });
  const savedDraft = await rawSaved.entry('66666666-6666-4666-8666-666666666666');
  assert.deepEqual(Object.keys(savedDraft).sort(), ['box', 'createdAt', 'id', 'userId']);
  assert.doesNotMatch(Buffer.from(savedDraft.box.data).toString('latin1'), /Kamal|1500/);
  assert.equal((await listDrafts())[0].summary.customer, 'Kamal Perera');
});

test('if the device key changes, drafts are kept and shown as unreadable, never lost silently', async () => {
  await addDraft({ kind: 'sale', body: saleBody('77777777-7777-4777-8777-777777777777'), summary: {}, userId: 'u1' });
  await setValue('catalog', { products: products });
  replaceDeviceKeyForTests();
  const [entry] = await listDrafts();
  assert.equal(entry.id, '77777777-7777-4777-8777-777777777777');
  assert.equal(entry.status, 'failed');
  assert.match(entry.error, /key this device no longer has/);
  // It is never sent, and a person can remove it.
  await sendDrafts({ userId: 'u1', send: async () => { throw new Error('must not be called'); } });
  assert.equal(await removeDraft(entry.id), true);
  // Other saved values count as not saved, so they are simply downloaded again.
  assert.equal(await getValue('catalog'), undefined);
});
