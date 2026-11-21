import { HttpError, unwrap } from '../errors.js';
import { writeAudit } from './audit.js';
import { codeEquivalents, getProduct } from './products.js';
import { getBill } from './transactions.js';

const CODE_FORMAT = /^[0-9A-Za-z._/-]{1,40}$/;

export function cleanCode(value) {
  const code = typeof value === 'string' ? value.trim() : '';
  if (!code) throw new HttpError(400, 'Enter or scan a barcode.');
  if (!CODE_FORMAT.test(code)) throw new HttpError(400, 'This is not a valid barcode.');
  if (/^\d{13}$/.test(code)) {
    const sum = [...code.slice(0, 12)].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
    if ((10 - (sum % 10)) % 10 !== Number(code[12])) throw new HttpError(400, 'This barcode failed its check digit. Scan it again.');
  }
  return code;
}

export async function findProductIdByCode({ database }, code) {
  const filters = codeEquivalents(code).flatMap((value) => [`barcode.eq."${value}"`, `sku.eq."${value}"`]).join(',');
  const rows = unwrap(await database.from('products').select('id').or(filters).limit(1));
  if (!rows.length) throw new HttpError(404, `No product has the code ${code}.`, 'UNKNOWN_BARCODE');
  return rows[0].id;
}

export async function lookup(clients, user, rawCode, { productOnly = false } = {}) {
  const code = cleanCode(rawCode);
  if (!productOnly && user.permissions.includes('bills.view')) {
    const sale = unwrap(await clients.database.from('sales').select('id').eq('bill_no', code).maybeSingle());
    if (sale) return { code, bill: await getBill(clients, sale.id) };
  }
  const product = await getProduct(clients, await findProductIdByCode(clients, code));
  if (!user.permissions.includes('products.view')) delete product.costPrice;
  return { code, product };
}

export async function scanIntoCount(clients, user, countId, rawCode) {
  const code = cleanCode(rawCode);
  const product = await getProduct(clients, await findProductIdByCode(clients, code));
  if (!product.active) throw new HttpError(409, `${product.name} is inactive and cannot be counted.`);
  const counted = Number(unwrap(await clients.database.rpc('scan_stock_count', { p_count_id: countId, p_product_id: product.id })));
  return { code, productId: product.id, name: product.name, counted };
}

export async function recordLabelsPrinted({ database }, user, labels) {
  const count = Number(labels);
  if (!Number.isInteger(count) || count < 1) throw new HttpError(400, 'Choose at least one label.');
  await writeAudit(database, { user, action: 'Barcode labels printed', description: `${count} label(s)` });
}

// How many products still have no barcode, for the Barcode labels screen.
export async function missingBarcodeCount({ database }) {
  const { count, error } = await database.from('products').select('id', { count: 'exact', head: true }).is('barcode', null);
  if (error) throw error;
  return count ?? 0;
}

// Gives every product without a barcode a new store barcode; products with one keep theirs.
export async function generateMissingBarcodes({ database }, user) {
  const generated = Number(unwrap(await database.rpc('fill_missing_barcodes')));
  if (generated) {
    await writeAudit(database, { user, action: 'Barcodes generated', description: `${generated} product(s) had no barcode`, entityType: 'product' });
  }
  return generated;
}

// The store name and phone for label headers, and the regular-customer price line when that discount is on.
export async function labelStore({ database }) {
  const row = unwrap(await database.from('store_settings').select('*').single());
  const regular = row.regular_discount_enabled ? { rate: Number(row.regular_discount_rate) } : null;
  return { name: row.store_name, phone: row.phone, regularDiscount: regular };
}
