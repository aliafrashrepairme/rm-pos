import { selectAll } from '../db.js';
import { dateRange } from '../validation/common.js';

// The Reports screens still use their original labels. Phase 15 moves them to the new values.
const SCREEN_STATUS = { Paid: 'Completed', 'Partially Refunded': 'Completed', Refunded: 'Refunded', Voided: 'Cancelled' };
const SCREEN_PAYMENT = { 'Bank transfer': 'Bank Transfer' };

function asProduct(row) {
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    category: row.categories?.name || '',
    unitCost: Number(row.cost_price),
    unitPrice: Number(row.selling_price),
    stock: Number(row.stock_qty),
    reorderLevel: Number(row.min_stock),
    updatedAt: row.updated_at
  };
}

function asSale(row) {
  const method = row.payments?.[0]?.method_code || '';
  return {
    orderId: row.bill_no,
    transactionId: row.id,
    date: row.created_at,
    items: (row.sale_items || []).map((item) => ({
      productId: item.product_id,
      name: item.name,
      category: item.category_name,
      qty: Number(item.qty),
      unitPrice: Number(item.unit_price),
      lineTotal: Number(item.line_total)
    })),
    total: Number(row.grand_total),
    status: SCREEN_STATUS[row.status] || row.status,
    paymentMethod: SCREEN_PAYMENT[method] || method,
    customer: row.customer_name
  };
}

function asMovement(row) {
  const change = Number(row.change_qty);
  return {
    id: row.id,
    date: row.created_at,
    productId: row.product_id,
    name: row.products?.name || '',
    type: change > 0 ? 'Stock In' : 'Stock Out',
    quantity: Math.abs(change),
    referenceId: row.reference_no,
    note: row.reason
  };
}

function withinRange(query, column, range) {
  let filtered = query;
  if (range.start) filtered = filtered.gte(column, range.start);
  if (range.end) filtered = filtered.lte(column, range.end);
  return filtered;
}

export async function listProducts({ database }) {
  const rows = await selectAll(() => database.from('products')
    .select('*, categories(name)')
    .order('name')
    .order('id'));
  return rows.map(asProduct);
}

export async function listSales({ database }, query) {
  const range = dateRange(query);
  const rows = await selectAll(() => withinRange(
    database.from('sales').select('*, sale_items(*), payments(method_code)'), 'created_at', range
  ).order('created_at', { ascending: false }).order('id'));
  return rows.map(asSale);
}

export async function listMovements({ database }, query) {
  const range = dateRange(query);
  const rows = await selectAll(() => withinRange(
    database.from('inventory_ledger').select('*, products(name)'), 'created_at', range
  ).order('id', { ascending: false }));
  return rows.map(asMovement);
}
