import { HttpError, unwrap } from '../errors.js';
import { writeAudit } from './audit.js';
import { getProduct } from './products.js';

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

// The same printed code can reach us as 12 digits (UPC) or 13 (EAN with a leading zero).
function equivalents(code) {
  const codes = new Set([code, code.toUpperCase()]);
  if (/^\d{12}$/.test(code)) codes.add(`0${code}`);
  if (/^0\d{12}$/.test(code)) codes.add(code.slice(1));
  return [...codes];
}

export async function findProductIdByCode({ database }, code) {
  const filters = equivalents(code).flatMap((value) => [`barcode.eq."${value}"`, `sku.eq."${value}"`]).join(',');
  const rows = unwrap(await database.from('products').select('id').or(filters).limit(1));
  if (!rows.length) throw new HttpError(404, `No product has the code ${code}.`, 'UNKNOWN_BARCODE');
  return rows[0].id;
}

export async function lookup(clients, user, rawCode) {
  const code = cleanCode(rawCode);
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
