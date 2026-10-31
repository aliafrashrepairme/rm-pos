import { selectAll } from '../db.js';
import { HttpError, unwrap } from '../errors.js';
import { writeAudit } from './audit.js';

export async function getLists({ database }) {
  const [categories, units, taxRates, products, sequences] = await Promise.all([
    selectAll(() => database.from('categories').select('id, name, active').order('name').order('id')),
    selectAll(() => database.from('units').select('code, allow_decimal_qty, active').order('code')),
    selectAll(() => database.from('tax_rates').select('id, name, rate, is_default, active').order('name')),
    selectAll(() => database.from('products').select('category_id, unit_code, tax_rate_id').eq('active', true).order('id')),
    selectAll(() => database.from('number_sequences').select('prefix').order('prefix'))
  ]);
  const tally = (key) => products.reduce((counts, row) => counts.set(row[key], (counts.get(row[key]) ?? 0) + 1), new Map());
  const [byCategory, byUnit, byTax] = [tally('category_id'), tally('unit_code'), tally('tax_rate_id')];
  return {
    categories: categories.map((row) => ({ id: row.id, name: row.name, active: row.active, products: byCategory.get(row.id) ?? 0 })),
    units: units.map((row) => ({ code: row.code, allowDecimal: row.allow_decimal_qty, active: row.active, products: byUnit.get(row.code) ?? 0 })),
    taxRates: taxRates.map((row) => ({ id: row.id, name: row.name, rate: Number(row.rate), isDefault: row.is_default, active: row.active, products: byTax.get(row.id) ?? 0 })),
    prefixes: sequences.map((row) => row.prefix)
  };
}

function unitCode(value) {
  const code = typeof value === 'string' ? value.trim() : '';
  if (!code || code.length > 30) throw new HttpError(400, 'Enter the unit name.');
  return code;
}

export async function addUnit(clients, user, body) {
  const code = unitCode(body?.code);
  const existing = unwrap(await clients.database.from('units').select('code').ilike('code', code).maybeSingle());
  if (existing) throw new HttpError(409, 'This unit already exists.');
  unwrap(await clients.database.from('units').insert({ code, allow_decimal_qty: body?.allowDecimal === true }).select('code').single());
  await writeAudit(clients.database, { user, action: 'Unit added', description: code, entityType: 'unit', entityId: code });
  return getLists(clients);
}

export async function updateUnit(clients, user, code, body) {
  const changes = {};
  for (const [key, column] of [['active', 'active'], ['allowDecimal', 'allow_decimal_qty']]) {
    if (body?.[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') throw new HttpError(400, 'Choose on or off.');
    changes[column] = body[key];
  }
  if (!Object.keys(changes).length) throw new HttpError(400, 'Nothing to change.');
  if (changes.active === false) {
    const { count, error } = await clients.database.from('products').select('id', { count: 'exact', head: true }).eq('unit_code', code).eq('active', true);
    unwrap({ error });
    if (count > 0) throw new HttpError(409, `${count} active product(s) use this unit. Move them first.`);
  }
  const row = unwrap(await clients.database.from('units').update(changes).eq('code', code).select('code').maybeSingle());
  if (!row) throw new HttpError(404, 'Unit not found.');
  await writeAudit(clients.database, { user, action: 'Unit changed', description: `${code}: ${JSON.stringify(changes)}`, entityType: 'unit', entityId: code });
  return getLists(clients);
}

export async function addTaxRate(clients, user, body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 60) throw new HttpError(400, 'Enter the tax rate name.');
  const rate = Number(body?.rate);
  if (body?.rate === '' || body?.rate === undefined || !Number.isFinite(rate) || rate < 0 || rate > 100) throw new HttpError(400, 'Enter a tax rate between 0 and 100.');
  const existing = unwrap(await clients.database.from('tax_rates').select('id').ilike('name', name).maybeSingle());
  if (existing) throw new HttpError(409, 'A tax rate with this name already exists.');
  const row = unwrap(await clients.database.from('tax_rates').insert({ name, rate: Math.round(rate * 100) / 100 }).select('id').single());
  await writeAudit(clients.database, { user, action: 'Tax rate added', description: `${name}: ${rate}%`, entityType: 'tax_rate', entityId: row.id });
  return getLists(clients);
}

export async function setTaxRateActive(clients, user, id, body) {
  if (typeof body?.active !== 'boolean') throw new HttpError(400, 'Choose on or off.');
  const row = unwrap(await clients.database.from('tax_rates').select('name, is_default').eq('id', id).maybeSingle());
  if (!row) throw new HttpError(404, 'Tax rate not found.');
  if (body.active === false) {
    if (row.is_default) throw new HttpError(409, 'Choose another default before turning this rate off.');
    const { count, error } = await clients.database.from('products').select('id', { count: 'exact', head: true }).eq('tax_rate_id', id).eq('active', true);
    unwrap({ error });
    if (count > 0) throw new HttpError(409, `${count} active product(s) use this tax rate. Move them first.`);
  }
  unwrap(await clients.database.from('tax_rates').update({ active: body.active }).eq('id', id).select('id').single());
  await writeAudit(clients.database, { user, action: 'Tax rate changed', description: `${row.name}: ${body.active ? 'on' : 'off'}`, entityType: 'tax_rate', entityId: id });
  return getLists(clients);
}
