import { selectAll } from '../db.js';
import { HttpError, unwrap } from '../errors.js';
import { dateRange } from '../validation/common.js';
import { writeAudit } from './audit.js';

const REASONS = ['Damaged', 'Expired', 'Theft / Loss', 'Found stock', 'Supplier return', 'Internal use', 'Data correction'];
const MOVEMENT_TYPES = ['Opening', 'Sale', 'Refund', 'Void', 'Purchase', 'Adjustment', 'Count', 'Import'];
const MAX_QUANTITY = 999999999;

function paging(query, defaultSize = 25) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize, 10) || defaultSize, 1), 100);
  return { page, pageSize, from: (page - 1) * pageSize };
}

function cleanSearch(value) {
  return typeof value === 'string' ? value.replace(/[%*_\\"]/g, ' ').trim().slice(0, 100) : '';
}

export async function listStock({ database }, query) {
  const { page, pageSize, from } = paging(query);
  const state = ['all', 'low', 'out', 'in'].includes(query.state) ? query.state : 'all';
  const result = unwrap(await database.rpc('inventory_list', {
    p_search: cleanSearch(query.q),
    p_category_id: query.categoryId || null,
    p_state: state,
    p_limit: pageSize,
    p_offset: from
  }));
  return { products: result.rows, total: result.total, page, pageSize };
}

export async function stockSummary({ database }) {
  return unwrap(await database.rpc('inventory_summary'));
}

export async function listMovements({ database }, query) {
  const { page, pageSize, from } = paging(query);
  const range = dateRange(query);
  let request = database.from('inventory_ledger')
    .select('*, products(name, sku, unit_code), profiles(full_name)', { count: 'exact' });
  if (query.productId) request = request.eq('product_id', query.productId);
  if (MOVEMENT_TYPES.includes(query.type)) request = request.eq('movement_type', query.type);
  if (range.start) request = request.gte('created_at', range.start);
  if (range.end) request = request.lte('created_at', range.end);
  const result = await request.order('id', { ascending: false }).range(from, from + pageSize - 1);
  return {
    movements: unwrap(result).map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      product: row.products?.name || '',
      sku: row.products?.sku || '',
      unit: row.products?.unit_code || '',
      type: row.movement_type,
      previous: Number(row.previous_qty),
      change: Number(row.change_qty),
      next: Number(row.new_qty),
      reason: row.reason,
      reference: row.reference_no,
      user: row.profiles?.full_name || ''
    })),
    total: result.count ?? 0,
    page,
    pageSize
  };
}

function adjustmentLines(lines) {
  if (!Array.isArray(lines) || !lines.length) throw new HttpError(400, 'Add at least one product.');
  if (new Set(lines.map((line) => line?.productId)).size !== lines.length) throw new HttpError(400, 'Each product can only appear once.');
  return lines.map((line) => {
    const change = Number(line?.change);
    if (typeof line?.productId !== 'string' || !line.productId) throw new HttpError(400, 'Choose a product for every line.');
    if (!Number.isFinite(change) || change === 0 || Math.abs(change) > MAX_QUANTITY) throw new HttpError(400, 'Enter a non-zero quantity on every line.');
    return { productId: line.productId, change: Math.round(change * 1000) / 1000 };
  });
}

export async function createAdjustment({ database }, user, body) {
  if (!REASONS.includes(body?.reason)) throw new HttpError(400, 'Choose a reason.');
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : '';
  const lines = adjustmentLines(body?.lines);
  const id = unwrap(await database.rpc('post_stock_adjustment', { p_reason: body.reason, p_note: note, p_lines: lines, p_created_by: user.id }));
  const adjustment = unwrap(await database.from('stock_adjustments').select('id, adjustment_no').eq('id', id).single());
  await writeAudit(database, {
    user,
    action: 'Stock adjustment',
    description: `${adjustment.adjustment_no} · ${body.reason} · ${lines.length} product(s)`,
    entityType: 'stock_adjustment',
    entityId: id
  });
  return { id, adjustmentNo: adjustment.adjustment_no };
}

export async function listAdjustments({ database }, query) {
  const { page, pageSize, from } = paging(query);
  const result = await database.from('stock_adjustments')
    .select('*, creator:profiles!stock_adjustments_created_by_fkey(full_name), stock_adjustment_lines(change_qty, products(name, cost_price))', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, from + pageSize - 1);
  return {
    adjustments: unwrap(result).map((row) => ({
      id: row.id,
      adjustmentNo: row.adjustment_no,
      createdAt: row.created_at,
      reason: row.reason,
      note: row.note,
      status: row.status,
      user: row.creator?.full_name || '',
      lines: row.stock_adjustment_lines.map((line) => ({ product: line.products?.name || '', change: Number(line.change_qty) })),
      value: row.stock_adjustment_lines.reduce((sum, line) => sum + Number(line.change_qty) * Number(line.products?.cost_price || 0), 0)
    })),
    total: result.count ?? 0,
    page,
    pageSize
  };
}

export async function listCounts({ database }, query) {
  const { page, pageSize, from } = paging(query);
  const result = await database.from('stock_counts')
    .select('*, creator:profiles!stock_counts_created_by_fkey(full_name), stock_count_lines(counted_qty)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, from + pageSize - 1);
  return {
    counts: unwrap(result).map((row) => ({
      id: row.id,
      countNo: row.count_no,
      name: row.name,
      scope: row.scope,
      blind: row.blind,
      status: row.status,
      createdAt: row.created_at,
      user: row.creator?.full_name || '',
      counted: row.stock_count_lines.filter((line) => line.counted_qty !== null).length,
      lines: row.stock_count_lines.length
    })),
    total: result.count ?? 0,
    page,
    pageSize
  };
}

// A blind count hides expected quantities from the person counting, on the server as well as the screen.
function canSeeExpected(count, user) {
  if (!count.blind) return true;
  return count.status !== 'In Progress' && user.permissions.includes('counts.approve');
}

export async function getCount({ database }, user, id) {
  const count = unwrap(await database.from('stock_counts')
    .select('*, creator:profiles!stock_counts_created_by_fkey(full_name)')
    .eq('id', id)
    .maybeSingle());
  if (!count) throw new HttpError(404, 'Stock count not found.');
  const lines = await selectAll(() => database.from('stock_count_lines')
    .select('product_id, system_qty, counted_qty, products(name, sku, barcode, location, unit_code, cost_price)')
    .eq('stock_count_id', id)
    .order('id'));
  const showExpected = canSeeExpected(count, user);
  return {
    id: count.id,
    countNo: count.count_no,
    name: count.name,
    scope: count.scope,
    blind: count.blind,
    status: count.status,
    createdAt: count.created_at,
    user: count.creator?.full_name || '',
    showExpected,
    lines: lines.map((line) => {
      const counted = line.counted_qty === null ? null : Number(line.counted_qty);
      const expected = Number(line.system_qty);
      return {
        productId: line.product_id,
        name: line.products?.name || '',
        sku: line.products?.sku || '',
        barcode: line.products?.barcode || '',
        location: line.products?.location || '',
        unit: line.products?.unit_code || '',
        counted,
        ...(showExpected ? {
          expected,
          variance: counted === null ? null : counted - expected,
          varianceValue: counted === null ? null : (counted - expected) * Number(line.products?.cost_price || 0)
        } : {})
      };
    })
  };
}

export async function startCount({ database }, user, body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 120) throw new HttpError(400, 'Enter a count name of up to 120 characters.');
  const scope = body?.scope;
  const id = unwrap(await database.rpc('start_stock_count', {
    p_name: name,
    p_category_id: scope !== 'all' && scope !== 'low' && scope ? scope : null,
    p_low_only: scope === 'low',
    p_blind: body?.blind !== false,
    p_created_by: user.id
  }));
  await writeAudit(database, { user, action: 'Stock count started', description: name, entityType: 'stock_count', entityId: id });
  return getCount({ database }, user, id);
}

export async function setCountLine({ database }, countId, productId, value) {
  let counted = null;
  if (value !== null && value !== '' && value !== undefined) {
    counted = Number(value);
    if (!Number.isFinite(counted) || counted < 0 || counted > MAX_QUANTITY) throw new HttpError(400, 'Enter a quantity of zero or more.');
  }
  unwrap(await database.rpc('set_stock_count_line', { p_count_id: countId, p_product_id: productId, p_counted: counted }));
}

export async function submitCount({ database }, user, id) {
  unwrap(await database.rpc('submit_stock_count', { p_count_id: id }));
  await writeAudit(database, { user, action: 'Stock count submitted', entityType: 'stock_count', entityId: id });
  return getCount({ database }, user, id);
}

export async function reopenCount({ database }, user, id) {
  unwrap(await database.rpc('reopen_stock_count', { p_count_id: id }));
  await writeAudit(database, { user, action: 'Stock count re-opened', entityType: 'stock_count', entityId: id });
  return getCount({ database }, user, id);
}

export async function approveCount({ database }, user, id) {
  const posted = unwrap(await database.rpc('approve_stock_count', { p_count_id: id, p_decided_by: user.id }));
  await writeAudit(database, {
    user,
    action: 'Stock count approved',
    description: `${posted} variance(s) posted`,
    entityType: 'stock_count',
    entityId: id
  });
  return { posted, count: await getCount({ database }, user, id) };
}

export async function productPicker({ database }, query) {
  const search = cleanSearch(query.q);
  let request = database.from('products').select('id, name, sku, stock_qty, unit_code').eq('active', true);
  if (search) {
    const pattern = `"*${search}*"`;
    request = request.or(`name.ilike.${pattern},sku.ilike.${pattern},barcode.ilike.${pattern}`);
  }
  const rows = unwrap(await request.order('name').limit(20));
  return rows.map((row) => ({ id: row.id, name: row.name, sku: row.sku, stock: Number(row.stock_qty), unit: row.unit_code }));
}
