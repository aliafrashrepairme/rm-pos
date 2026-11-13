import { selectAll } from '../db.js';
import { HttpError, unwrap } from '../errors.js';
import { writeAudit } from './audit.js';
import { toCsv } from './csv.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function periodFrom(database, query) {
  if (!query.from && !query.to) return null;
  if (!DATE.test(query.from ?? '') || !DATE.test(query.to ?? '')) throw new HttpError(400, 'Choose a start and end date.');
  return unwrap(await database.rpc('report_period', { p_preset: 'custom', p_from: query.from, p_to: query.to }));
}

function within(request, period) {
  return period ? request.gte('created_at', period.start).lt('created_at', period.end) : request;
}

const amount = (value) => Number(value);
const money = (value) => Math.round(value * 100) / 100;

const productRows = (database) => selectAll(() => database.from('products')
  .select('sku, barcode, name, unit_code, cost_price, selling_price, stock_qty, min_stock, location, active, categories(name), tax_rates(name, rate), suppliers(name)')
  .order('name').order('id'));

const KINDS = {
  async products({ database }) {
    return {
      rows: (await productRows(database)).filter((row) => row.active),
      columns: [
        ['name', (row) => row.name], ['sku', (row) => row.sku], ['barcode', (row) => row.barcode],
        ['category', (row) => row.categories?.name], ['unit', (row) => row.unit_code],
        ['selling_price', (row) => amount(row.selling_price)], ['cost_price', (row) => amount(row.cost_price)],
        ['tax_rate', (row) => row.tax_rates?.name], ['stock', (row) => amount(row.stock_qty)],
        ['min_stock', (row) => amount(row.min_stock)], ['location', (row) => row.location], ['supplier', (row) => row.suppliers?.name]
      ]
    };
  },
  async bills({ database }, query) {
    const period = await periodFrom(database, query);
    return {
      rows: await selectAll(() => within(database.from('sales')
        .select('id, bill_no, status, customer_name, subtotal, discount_total, tax_total, grand_total, created_at, cashier:profiles!sales_cashier_id_fkey(full_name), payments(method_code), refunds(total)'), period)
        .order('created_at', { ascending: false }).order('id')),
      columns: [
        ['bill_no', (row) => row.bill_no], ['date', (row) => row.created_at], ['status', (row) => row.status],
        ['customer', (row) => row.customer_name], ['cashier', (row) => row.cashier?.full_name],
        ['payment', (row) => (row.payments ?? []).map((item) => item.method_code).join(' + ')],
        ['subtotal', (row) => amount(row.subtotal)], ['discount', (row) => amount(row.discount_total)], ['tax', (row) => amount(row.tax_total)],
        ['total', (row) => amount(row.grand_total)], ['refunded', (row) => (row.refunds ?? []).reduce((sum, item) => sum + amount(item.total), 0)]
      ]
    };
  },
  async ledger({ database }, query) {
    const period = await periodFrom(database, query);
    return {
      rows: await selectAll(() => within(database.from('inventory_ledger')
        .select('id, created_at, movement_type, previous_qty, change_qty, new_qty, unit_cost, reason, reference_no, products(sku, name), creator:profiles!inventory_ledger_created_by_fkey(full_name)'), period)
        .order('id', { ascending: false })),
      columns: [
        ['date', (row) => row.created_at], ['sku', (row) => row.products?.sku], ['product', (row) => row.products?.name], ['type', (row) => row.movement_type],
        ['previous', (row) => amount(row.previous_qty)], ['change', (row) => amount(row.change_qty)], ['balance', (row) => amount(row.new_qty)],
        ['unit_cost', (row) => (row.unit_cost === null ? '' : amount(row.unit_cost))], ['reference', (row) => row.reference_no], ['reason', (row) => row.reason], ['user', (row) => row.creator?.full_name]
      ]
    };
  },
  async valuation({ database }) {
    return {
      rows: (await productRows(database)).filter((row) => row.active),
      columns: [
        ['sku', (row) => row.sku], ['product', (row) => row.name], ['category', (row) => row.categories?.name], ['on_hand', (row) => amount(row.stock_qty)],
        ['unit_cost', (row) => amount(row.cost_price)], ['value_at_cost', (row) => money(amount(row.stock_qty) * amount(row.cost_price))],
        ['selling_price', (row) => amount(row.selling_price)], ['value_at_retail', (row) => money(amount(row.stock_qty) * amount(row.selling_price))]
      ]
    };
  }
};

export async function exportData(clients, user, kind, query) {
  const build = Object.hasOwn(KINDS, kind) ? KINDS[kind] : null;
  if (!build) throw new HttpError(404, 'Choose what to export.');
  const { rows, columns } = await build(clients, query);
  await writeAudit(clients.database, { user, action: 'Data exported', description: `${kind}: ${rows.length} rows`, entityType: 'export', entityId: kind });
  return toCsv(columns, rows);
}
