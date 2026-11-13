import { selectAll } from '../db.js';
import { HttpError, unwrap } from '../errors.js';
import { barcode as checkBarcode } from '../validation/products.js';
import { writeAudit } from './audit.js';
import { parseCsv } from './csv.js';

const MAX_ROWS = 2000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9+() -]{6,20}$/;

const COLUMNS = {
  products: ['name', 'sku', 'barcode', 'category', 'unit', 'selling_price', 'cost_price', 'tax_rate', 'opening_stock', 'min_stock', 'location', 'supplier', 'description'],
  customers: ['name', 'phone', 'email', 'address', 'loyalty_points'],
  suppliers: ['name', 'contact_person', 'phone', 'email', 'address', 'city', 'payment_terms', 'lead_time_days']
};
const REQUIRED = { products: ['name', 'category', 'unit', 'selling_price'], customers: ['name'], suppliers: ['name'] };
const EXAMPLES = {
  products: ['Claw Hammer 16oz', '', '', 'Hand Tools', 'Piece', '1450', '980', '', '10', '5', 'Rack A', '', ''],
  customers: ['Kumar Hardware Works', '0771234567', '', 'Jaffna', '0'],
  suppliers: ['Lanka Building Supplies', 'M. Silva', '0112345678', '', 'Colombo', 'Colombo', 'Credit 30 days', '5']
};

function requireType(type) {
  if (!COLUMNS[type]) throw new HttpError(404, 'Choose what to import.');
}

export function template(type) {
  requireType(type);
  return `﻿${COLUMNS[type].join(',')}\r\n${EXAMPLES[type].join(',')}\r\n`;
}

// A file we exported marks formula-like text with an apostrophe. That mark isn't part of the value.
const cleanCell = (value) => (value ?? '').trim().replace(/^'(?=[=+\-@])/, '');

function number(row, key, errors, { label, max = 9999999999, whole = false }) {
  if (row[key] === '') return null;
  const value = Number(row[key].replace(/,/g, ''));
  if (!Number.isFinite(value) || value < 0 || value > max || (whole && !Number.isInteger(value))) {
    errors.push(`${label} must be ${whole ? 'a whole number' : 'a number'}, zero or more.`);
    return null;
  }
  return value;
}

function text(row, key, errors, label, max) {
  if (row[key].length > max) errors.push(`${label} must be ${max} characters or fewer.`);
  return row[key];
}

const lowerKey = (value) => value.trim().toLowerCase();

async function loadContext({ database }, type) {
  const context = { seen: { sku: new Set(), barcode: new Set(), name: new Set(), phone: new Set() } };
  if (type === 'products') {
    const [categories, units, taxes, suppliers, products] = await Promise.all([
      selectAll(() => database.from('categories').select('id, name').eq('active', true).order('id')),
      selectAll(() => database.from('units').select('code, allow_decimal_qty').eq('active', true).order('code')),
      selectAll(() => database.from('tax_rates').select('id, name, is_default').eq('active', true).order('id')),
      selectAll(() => database.from('suppliers').select('id, name').eq('active', true).order('id')),
      selectAll(() => database.from('products').select('sku, barcode, name, active').order('id'))
    ]);
    context.categories = new Map(categories.map((row) => [lowerKey(row.name), row.id]));
    context.units = new Map(units.map((row) => [lowerKey(row.code), row]));
    context.taxes = new Map(taxes.map((row) => [lowerKey(row.name), row.id]));
    context.defaultTax = taxes.find((row) => row.is_default)?.id;
    context.suppliers = new Map(suppliers.map((row) => [lowerKey(row.name), row.id]));
    context.skus = new Set(products.map((row) => lowerKey(row.sku)));
    context.barcodes = new Set(products.map((row) => row.barcode).filter(Boolean));
    context.names = new Set(products.filter((row) => row.active).map((row) => lowerKey(row.name)));
  } else if (type === 'customers') {
    const customers = await selectAll(() => database.from('customers').select('name, phone').eq('active', true).order('id'));
    context.phones = new Set(customers.map((row) => row.phone).filter(Boolean));
    context.names = new Set(customers.filter((row) => !row.phone).map((row) => lowerKey(row.name)));
  } else {
    const suppliers = await selectAll(() => database.from('suppliers').select('name').eq('active', true).order('id'));
    context.names = new Set(suppliers.map((row) => lowerKey(row.name)));
  }
  return context;
}

function checkEmail(row, errors) {
  if (row.email && !EMAIL.test(row.email)) errors.push('Email is not valid.');
}

const VALIDATORS = {
  products(row, context, errors) {
    const name = text(row, 'name', errors, 'Name', 200);
    if (name && context.names.has(lowerKey(name))) errors.push('A product with this name already exists.');
    if (name && context.seen.name.has(lowerKey(name))) errors.push('This name is repeated in the file.');
    context.seen.name.add(lowerKey(name));

    if (row.sku) {
      if (!/^[A-Za-z0-9._/-]{2,40}$/.test(row.sku)) errors.push('SKU can only use letters, numbers and . _ / -');
      if (context.skus.has(lowerKey(row.sku))) errors.push('This SKU is already used by another product.');
      if (context.seen.sku.has(lowerKey(row.sku))) errors.push('This SKU is repeated in the file.');
      context.seen.sku.add(lowerKey(row.sku));
    }
    if (row.barcode) {
      try {
        checkBarcode(row.barcode);
      } catch (failure) {
        errors.push(failure.message);
      }
      if (context.barcodes.has(row.barcode)) errors.push('This barcode is already used by another product.');
      if (context.seen.barcode.has(row.barcode)) errors.push('This barcode is repeated in the file.');
      context.seen.barcode.add(row.barcode);
    }

    const categoryId = context.categories.get(lowerKey(row.category));
    if (row.category && !categoryId) errors.push(`Category "${row.category}" does not exist. Add it in List Management first.`);
    const unit = context.units.get(lowerKey(row.unit));
    if (row.unit && !unit) errors.push(`Unit "${row.unit}" does not exist. Add it in List Management first.`);
    const taxRateId = row.tax_rate ? context.taxes.get(lowerKey(row.tax_rate)) : context.defaultTax;
    if (!taxRateId) errors.push(`Tax rate "${row.tax_rate}" does not exist.`);
    const preferredSupplierId = row.supplier ? context.suppliers.get(lowerKey(row.supplier)) : null;
    if (row.supplier && !preferredSupplierId) errors.push(`Supplier "${row.supplier}" does not exist.`);

    const sellingPrice = number(row, 'selling_price', errors, { label: 'Selling price' });
    const costPrice = number(row, 'cost_price', errors, { label: 'Cost price' }) ?? 0;
    const openingStock = number(row, 'opening_stock', errors, { label: 'Opening stock', max: 999999999 }) ?? 0;
    const minStock = number(row, 'min_stock', errors, { label: 'Minimum stock', max: 999999999 }) ?? 0;
    if (unit && !unit.allow_decimal_qty && !Number.isInteger(openingStock)) errors.push(`Opening stock must be a whole number for unit ${unit.code}.`);

    return {
      name,
      sku: row.sku,
      barcode: row.barcode,
      categoryId,
      unitCode: unit?.code,
      taxRateId,
      preferredSupplierId,
      sellingPrice,
      costPrice,
      openingStock,
      minStock,
      location: text(row, 'location', errors, 'Location', 100),
      description: text(row, 'description', errors, 'Description', 2000)
    };
  },

  customers(row, context, errors) {
    const name = text(row, 'name', errors, 'Name', 120);
    if (row.phone) {
      if (!PHONE.test(row.phone)) errors.push('Phone number is not valid.');
      if (context.phones.has(row.phone)) errors.push('A customer with this phone number already exists.');
      if (context.seen.phone.has(row.phone)) errors.push('This phone number is repeated in the file.');
      context.seen.phone.add(row.phone);
    } else {
      if (name && context.names.has(lowerKey(name))) errors.push('A customer with this name and no phone already exists.');
      if (name && context.seen.name.has(lowerKey(name))) errors.push('This name is repeated in the file with no phone.');
      context.seen.name.add(lowerKey(name));
    }
    checkEmail(row, errors);
    return {
      name,
      phone: row.phone,
      email: text(row, 'email', errors, 'Email', 120),
      address: text(row, 'address', errors, 'Address', 300),
      loyaltyPoints: number(row, 'loyalty_points', errors, { label: 'Loyalty points', max: 1000000, whole: true }) ?? 0
    };
  },

  suppliers(row, context, errors) {
    const name = text(row, 'name', errors, 'Name', 120);
    if (name && context.names.has(lowerKey(name))) errors.push('An active supplier with this name already exists.');
    if (name && context.seen.name.has(lowerKey(name))) errors.push('This name is repeated in the file.');
    context.seen.name.add(lowerKey(name));
    checkEmail(row, errors);
    return {
      name,
      contactPerson: text(row, 'contact_person', errors, 'Contact person', 120),
      phone: text(row, 'phone', errors, 'Phone', 30),
      email: text(row, 'email', errors, 'Email', 120),
      address: text(row, 'address', errors, 'Address', 300),
      city: text(row, 'city', errors, 'City', 80),
      paymentTerms: text(row, 'payment_terms', errors, 'Payment terms', 40),
      leadTimeDays: number(row, 'lead_time_days', errors, { label: 'Lead time', max: 365, whole: true }) ?? 5
    };
  }
};

async function checkFile(clients, type, csv) {
  requireType(type);
  if (typeof csv !== 'string' || !csv.trim()) return { fileErrors: ['The file is empty.'], rows: [], total: 0, errorCount: 1 };
  const parsed = parseCsv(csv);
  if (parsed.error) return { fileErrors: [parsed.error], rows: [], total: 0, errorCount: 1 };
  const [head, ...body] = parsed.records;
  if (!head) return { fileErrors: ['The file is empty.'], rows: [], total: 0, errorCount: 1 };

  const headers = head.cells.map((name) => name.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const fileErrors = [];
  const unknown = headers.filter((name) => !COLUMNS[type].includes(name));
  if (unknown.length) fileErrors.push(`Unknown columns: ${unknown.join(', ')}.`);
  const missing = REQUIRED[type].filter((name) => !headers.includes(name));
  if (missing.length) fileErrors.push(`Missing columns: ${missing.join(', ')}.`);
  const repeated = headers.filter((name, index) => headers.indexOf(name) !== index);
  if (repeated.length) fileErrors.push(`Repeated columns: ${repeated.join(', ')}.`);
  if (!body.length) fileErrors.push('The file has no rows to import.');
  if (body.length > MAX_ROWS) fileErrors.push(`A file can have at most ${MAX_ROWS} rows. Split it into smaller files.`);
  if (fileErrors.length) return { fileErrors, rows: [], total: body.length, errorCount: fileErrors.length };

  const context = await loadContext(clients, type);
  const rows = body.map(({ line, cells }) => {
    const errors = [];
    if (cells.length > headers.length) errors.push('This row has more values than there are columns.');
    const row = Object.fromEntries(COLUMNS[type].map((name) => [name, '']));
    headers.forEach((name, index) => { row[name] = cleanCell(cells[index]); });
    for (const name of REQUIRED[type]) if (!row[name]) errors.push(`${name.replace(/_/g, ' ')} is required.`);
    const record = VALIDATORS[type](row, context, errors);
    return { line, name: row.name, errors, record };
  });
  return { fileErrors: [], rows, total: rows.length, errorCount: rows.filter((row) => row.errors.length).length };
}

export async function validateImport(clients, type, csv) {
  const { rows, ...report } = await checkFile(clients, type, csv);
  return { ...report, rows: rows.map(({ line, name, errors }) => ({ line, name, errors })) };
}

// The file is checked again here, in case it or the store's records changed after the preview.
export async function runImport(clients, user, type, csv) {
  const checked = await checkFile(clients, type, csv);
  if (checked.errorCount) throw new HttpError(422, 'This file has errors. Nothing was imported.');
  const imported = unwrap(await clients.database.rpc('import_records', { p_type: type, p_rows: checked.rows.map((row) => row.record), p_user: user.id }));
  await writeAudit(clients.database, { user, action: 'Data imported', description: `${type}: ${imported} rows`, entityType: 'import', entityId: type });
  return { imported };
}
