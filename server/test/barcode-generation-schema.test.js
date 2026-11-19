import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { bundleMigrations } from '../scripts/bundle-migrations.js';

const validEan13 = (code) => /^\d{13}$/.test(code)
  && (10 - ([...code.slice(0, 12)].reduce((sum, digit, i) => sum + Number(digit) * (i % 2 ? 3 : 1), 0) % 10)) % 10 === Number(code[12]);

test('missing barcodes are generated; existing barcodes are kept and never duplicated', async () => {
  const { sql } = await bundleMigrations();
  const db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema extensions;
    create table auth.users (id uuid primary key);
  `);
  await db.exec(sql);
  await db.exec(`
    insert into public.categories (name) values ('Tools');
    insert into public.products (sku, barcode, name, category_id, unit_code, selling_price, tax_rate_id)
    select v.sku, v.barcode, v.name, c.id, u.code, 100, t.id
    from (values ('S1', '4799000100013', 'Has maker barcode'), ('S2', null, 'No barcode A'), ('S3', null, 'No barcode B')) as v(sku, barcode, name)
    cross join (select id from public.categories limit 1) c
    cross join (select code from public.units limit 1) u
    cross join (select id from public.tax_rates limit 1) t;
  `);

  const filled = (await db.query('select public.fill_missing_barcodes() as n')).rows[0].n;
  assert.equal(filled, 2);
  const rows = (await db.query('select sku, barcode from public.products order by sku')).rows;
  assert.equal(rows[0].barcode, '4799000100013', 'a product that had a barcode keeps it');
  for (const row of rows.slice(1)) {
    assert.ok(row.barcode.startsWith('20'), 'store barcodes start with 20');
    assert.ok(validEan13(row.barcode), `${row.barcode} is a valid EAN-13`);
  }
  assert.equal(new Set(rows.map((row) => row.barcode)).size, 3, 'no two products share a barcode');

  assert.equal((await db.query('select public.fill_missing_barcodes() as n')).rows[0].n, 0, 'running again changes nothing');
  await assert.rejects(db.exec(`update public.products set barcode = '4799000100013' where sku = 'S2'`), /products_barcode_key/);
});
