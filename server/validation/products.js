import { HttpError } from '../errors.js';
import { requiredText } from './common.js';

function amount(value, label) {
  const number = Number(value);
  if (value === '' || value === null || !Number.isFinite(number) || number < 0) throw new HttpError(400, `${label} must be zero or more.`);
  if (number > 9999999999) throw new HttpError(400, `${label} is too large.`);
  return Math.round(number * 100) / 100;
}

function stockQuantity(value, label) {
  const number = Number(value);
  if (value === '' || value === null || !Number.isFinite(number) || number < 0) throw new HttpError(400, `${label} must be zero or more.`);
  if (number > 999999999) throw new HttpError(400, `${label} is too large.`);
  return Math.round(number * 1000) / 1000;
}

function optionalText(value, label, max = 500) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be text.`);
  if (value.length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer.`);
  return value.trim();
}

function sku(value) {
  const text = requiredText(value, 'SKU');
  if (!/^[A-Za-z0-9._/-]{2,40}$/.test(text)) throw new HttpError(400, 'SKU can only use letters, numbers and . _ / -');
  return text;
}

export function barcode(value) {
  const text = requiredText(value, 'Barcode');
  if (!/^[0-9A-Za-z-]{4,32}$/.test(text)) throw new HttpError(400, 'Barcode must be 4 to 32 letters, numbers or dashes.');
  if (/^\d{13}$/.test(text)) {
    const sum = [...text.slice(0, 12)].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
    if ((10 - (sum % 10)) % 10 !== Number(text[12])) throw new HttpError(400, 'This EAN-13 barcode has a wrong check digit. Check for a typing mistake.');
  }
  return text;
}

function name(value) {
  const text = requiredText(value, 'Product name');
  if (text.length > 200) throw new HttpError(400, 'Product name must be 200 characters or fewer.');
  return text;
}

export function newProduct(body) {
  return {
    name: name(body?.name),
    description: optionalText(body?.description, 'Description', 2000),
    categoryId: requiredText(body?.categoryId, 'Category'),
    unitCode: requiredText(body?.unitCode, 'Unit'),
    taxRateId: requiredText(body?.taxRateId, 'Tax rate'),
    costPrice: amount(body?.costPrice ?? 0, 'Cost price'),
    sellingPrice: amount(body?.sellingPrice, 'Selling price'),
    openingStock: stockQuantity(body?.openingStock ?? 0, 'Opening stock'),
    minStock: stockQuantity(body?.minStock ?? 0, 'Minimum stock'),
    location: optionalText(body?.location, 'Location', 100),
    preferredSupplierId: body?.preferredSupplierId || null,
    sku: body?.sku ? sku(body.sku) : null,
    barcode: body?.barcode ? barcode(body.barcode) : null
  };
}

// Only the fields sent are changed. Stock is left out on purpose: it moves through the ledger.
export function productChanges(body) {
  const changes = {};
  if (body?.name !== undefined) changes.name = name(body.name);
  if (body?.description !== undefined) changes.description = optionalText(body.description, 'Description', 2000);
  if (body?.categoryId !== undefined) changes.category_id = requiredText(body.categoryId, 'Category');
  if (body?.unitCode !== undefined) changes.unit_code = requiredText(body.unitCode, 'Unit');
  if (body?.taxRateId !== undefined) changes.tax_rate_id = requiredText(body.taxRateId, 'Tax rate');
  if (body?.costPrice !== undefined) changes.cost_price = amount(body.costPrice, 'Cost price');
  if (body?.sellingPrice !== undefined) changes.selling_price = amount(body.sellingPrice, 'Selling price');
  if (body?.minStock !== undefined) changes.min_stock = stockQuantity(body.minStock, 'Minimum stock');
  if (body?.location !== undefined) changes.location = optionalText(body.location, 'Location', 100);
  if (body?.preferredSupplierId !== undefined) changes.preferred_supplier_id = body.preferredSupplierId || null;
  if (body?.sku !== undefined) changes.sku = sku(body.sku);
  if (body?.barcode !== undefined) changes.barcode = barcode(body.barcode);
  if (body?.active !== undefined) {
    if (typeof body.active !== 'boolean') throw new HttpError(400, 'Active must be true or false.');
    changes.active = body.active;
  }
  if (!Object.keys(changes).length) throw new HttpError(400, 'Nothing to change.');
  return changes;
}

const SORTS = { name: 'name', sku: 'sku', price: 'selling_price', stock: 'stock_qty', updated: 'updated_at' };

export function productListQuery(query) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize, 10) || 25, 1), 100);
  const status = ['active', 'inactive', 'all'].includes(query.status) ? query.status : 'active';
  return {
    page,
    pageSize,
    status,
    // Characters with a special meaning in search patterns are treated as spaces.
    search: typeof query.q === 'string' ? query.q.replace(/[%*_\\"]/g, ' ').trim().slice(0, 100) : '',
    categoryId: typeof query.categoryId === 'string' && query.categoryId ? query.categoryId : null,
    sort: SORTS[query.sort] || 'name',
    ascending: query.direction !== 'desc'
  };
}

export function categoryName(value) {
  const text = requiredText(value, 'Category name');
  if (text.length > 80) throw new HttpError(400, 'Category name must be 80 characters or fewer.');
  return text;
}
