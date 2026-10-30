import { HttpError, unwrap } from '../errors.js';
import { writeAudit } from './audit.js';

const STATUSES = ['Draft', 'Ordered', 'Partially Received', 'Received', 'Cancelled'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireId(id) {
  if (!UUID.test(id)) throw new HttpError(404, 'Purchase order not found.');
}

function searchText(value) {
  return typeof value === 'string' ? value.replace(/[%*_\\"]/g, ' ').trim().slice(0, 100) : '';
}

function paymentStatus(total, paid) {
  if (paid >= total && total > 0) return 'Paid';
  return paid > 0 ? 'Part Paid' : 'Unpaid';
}

export async function listPurchases({ database }, query) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize, 10) || 25, 1), 100);
  const from = (page - 1) * pageSize;
  let request = database.from('purchases')
    .select('id, po_no, status, source, supplier_invoice_no, expected_at, total, paid_total, created_at, suppliers(name), purchase_items(qty_ordered, qty_received)', { count: 'exact' });
  if (STATUSES.includes(query.status)) request = request.eq('status', query.status);
  const search = searchText(query.q);
  if (search) request = request.or(`po_no.ilike."*${search}*",supplier_invoice_no.ilike."*${search}*"`);
  const result = await request.order('created_at', { ascending: false }).order('id').range(from, from + pageSize - 1);
  return {
    purchases: unwrap(result).map((row) => {
      const ordered = row.purchase_items.reduce((sum, item) => sum + Number(item.qty_ordered), 0);
      const received = row.purchase_items.reduce((sum, item) => sum + Number(item.qty_received), 0);
      const total = Number(row.total);
      const paid = Number(row.paid_total);
      return {
        id: row.id,
        poNo: row.po_no,
        status: row.status,
        source: row.source,
        invoiceNo: row.supplier_invoice_no,
        supplier: row.suppliers?.name || '',
        expectedAt: row.expected_at,
        total,
        paid,
        balance: total - paid,
        paymentStatus: paymentStatus(total, paid),
        receivedPercent: ordered ? Math.round((received / ordered) * 100) : 0
      };
    }),
    total: result.count ?? 0,
    page,
    pageSize
  };
}

export async function getPurchase({ database }, id) {
  requireId(id);
  const row = unwrap(await database.from('purchases')
    .select(`*, suppliers(id, name, contact_person, phone, email, payment_terms),
      creator:profiles!purchases_created_by_fkey(full_name),
      purchase_items(id, line_no, product_id, qty_ordered, qty_received, unit_cost, products(name, sku, barcode, unit_code)),
      goods_receipts(grn_no, received_at, note, receiver:profiles!goods_receipts_received_by_fkey(full_name)),
      supplier_payments(payment_no, amount, method, reference, created_at)`)
    .eq('id', id)
    .maybeSingle());
  if (!row) throw new HttpError(404, 'Purchase order not found.');
  const store = unwrap(await database.from('store_settings').select('store_name, address, phone').single());
  const total = Number(row.total);
  const paid = Number(row.paid_total);
  return {
    id: row.id,
    poNo: row.po_no,
    status: row.status,
    source: row.source,
    invoiceNo: row.supplier_invoice_no,
    note: row.note,
    orderedAt: row.ordered_at,
    expectedAt: row.expected_at,
    createdAt: row.created_at,
    createdBy: row.creator?.full_name || '',
    total,
    paid,
    balance: total - paid,
    paymentStatus: paymentStatus(total, paid),
    supplier: {
      id: row.suppliers?.id,
      name: row.suppliers?.name || '',
      contact: row.suppliers?.contact_person || '',
      phone: row.suppliers?.phone || '',
      terms: row.suppliers?.payment_terms || ''
    },
    lines: [...row.purchase_items].sort((a, b) => a.line_no - b.line_no).map((item) => ({
      id: item.id,
      productId: item.product_id,
      name: item.products?.name || '',
      sku: item.products?.sku || '',
      barcode: item.products?.barcode || '',
      unit: item.products?.unit_code || '',
      ordered: Number(item.qty_ordered),
      received: Number(item.qty_received),
      unitCost: Number(item.unit_cost)
    })),
    receipts: [...row.goods_receipts].sort((a, b) => a.received_at.localeCompare(b.received_at)).map((receipt) => ({
      grnNo: receipt.grn_no,
      receivedAt: receipt.received_at,
      note: receipt.note,
      by: receipt.receiver?.full_name || ''
    })),
    payments: [...row.supplier_payments].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((payment) => ({
      paymentNo: payment.payment_no,
      amount: Number(payment.amount),
      method: payment.method,
      reference: payment.reference,
      createdAt: payment.created_at
    })),
    store: { name: store.store_name, address: store.address, phone: store.phone }
  };
}

export async function createPurchase(clients, user, body) {
  if (typeof body?.supplierId !== 'string' || !UUID.test(body.supplierId)) throw new HttpError(400, 'Choose an active supplier.');
  if (!Array.isArray(body?.items) || !body.items.length) throw new HttpError(400, 'Add at least one product.');
  if (body.items.length > 200) throw new HttpError(400, 'This order has too many lines.');
  const items = body.items.map((item) => {
    const qty = Number(item?.qty);
    const unitCost = Number(item?.unitCost);
    if (typeof item?.productId !== 'string' || !UUID.test(item.productId)) throw new HttpError(400, 'A product on this order is not valid.');
    if (!Number.isFinite(qty) || qty <= 0 || qty > 999999999) throw new HttpError(400, 'Enter a valid quantity for every product.');
    if (!Number.isFinite(unitCost) || unitCost < 0 || unitCost > 9999999999) throw new HttpError(400, 'Enter a valid cost for every product.');
    return { productId: item.productId, qty, unitCost: Math.round(unitCost * 100) / 100 };
  });
  if (body.expectedAt && !/^\d{4}-\d{2}-\d{2}$/.test(body.expectedAt)) throw new HttpError(400, 'Invalid expected date.');
  const status = body.status === 'Draft' ? 'Draft' : 'Ordered';
  const id = unwrap(await clients.database.rpc('create_purchase', {
    p_purchase: {
      supplierId: body.supplierId,
      status,
      source: 'Manual',
      items,
      expectedAt: body.expectedAt || null,
      supplierInvoiceNo: typeof body.supplierInvoiceNo === 'string' ? body.supplierInvoiceNo.trim().slice(0, 60) : null,
      note: typeof body.note === 'string' ? body.note.trim().slice(0, 500) : ''
    },
    p_user: user.id
  }));
  const purchase = await getPurchase(clients, id);
  await writeAudit(clients.database, { user, action: 'Purchase order created', description: `${purchase.poNo} · ${purchase.supplier.name} · ${status}`, entityType: 'purchase', entityId: id });
  return purchase;
}

// The status test is part of the update, so two people can't both act on the same order.
export async function sendPurchase(clients, user, id) {
  requireId(id);
  const row = unwrap(await clients.database.from('purchases')
    .update({ status: 'Ordered', ordered_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'Draft').select('id').maybeSingle());
  if (!row) throw new HttpError(409, 'Only a draft can be sent.');
  const purchase = await getPurchase(clients, id);
  await writeAudit(clients.database, { user, action: 'Purchase order sent', description: purchase.poNo, entityType: 'purchase', entityId: id });
  return purchase;
}

export async function cancelPurchase(clients, user, id) {
  requireId(id);
  const row = unwrap(await clients.database.from('purchases')
    .update({ status: 'Cancelled' })
    .eq('id', id).in('status', ['Draft', 'Ordered']).eq('paid_total', 0).select('id').maybeSingle());
  if (!row) throw new HttpError(409, 'Only an order with nothing received or paid can be cancelled.');
  const purchase = await getPurchase(clients, id);
  await writeAudit(clients.database, { user, action: 'Purchase order cancelled', description: purchase.poNo, entityType: 'purchase', entityId: id });
  return purchase;
}

export async function receivePurchase(clients, user, id, body) {
  requireId(id);
  if (typeof body?.clientRequestId !== 'string' || !UUID.test(body.clientRequestId)) throw new HttpError(400, 'A request ID is required.');
  if (!Array.isArray(body?.lines) || !body.lines.length) throw new HttpError(400, 'Enter the quantity delivered for at least one product.');
  const lines = body.lines.map((line) => {
    const qty = Number(line?.qty);
    if (typeof line?.purchaseItemId !== 'string' || !UUID.test(line.purchaseItemId)) throw new HttpError(400, 'A product on this delivery is not valid.');
    if (!Number.isFinite(qty) || qty <= 0) throw new HttpError(400, 'Enter a valid quantity for every product.');
    return { purchaseItemId: line.purchaseItemId, qty };
  });
  const result = unwrap(await clients.database.rpc('receive_purchase', {
    p_receipt: {
      clientRequestId: body.clientRequestId,
      purchaseId: id,
      lines,
      note: typeof body.note === 'string' ? body.note.trim().slice(0, 500) : ''
    },
    p_user: user.id
  }));
  const purchase = await getPurchase(clients, id);
  if (!result.replayed) {
    await writeAudit(clients.database, { user, action: 'Goods received', description: `${result.grnNo} · ${purchase.poNo}`, entityType: 'purchase', entityId: id });
  }
  return { purchase, grnNo: result.grnNo, replayed: result.replayed };
}

export async function paySupplier(clients, user, id, body) {
  requireId(id);
  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'Enter a valid amount.');
  const result = unwrap(await clients.database.rpc('pay_supplier', {
    p_payment: {
      purchaseId: id,
      amount: Math.round(amount * 100) / 100,
      method: body?.method,
      reference: typeof body?.reference === 'string' ? body.reference.trim().slice(0, 100) : ''
    },
    p_user: user.id
  }));
  const purchase = await getPurchase(clients, id);
  await writeAudit(clients.database, { user, action: 'Supplier payment', description: `${result.paymentNo} · ${purchase.poNo} · ${amount.toFixed(2)}`, entityType: 'purchase', entityId: id });
  return purchase;
}

export async function autoReorder({ database }, user) {
  const result = unwrap(await database.rpc('auto_reorder', { p_user: user.id }));
  if (result.created.length) {
    await writeAudit(database, { user, action: 'Auto-reorder drafts', description: result.created.join(', '), entityType: 'purchase' });
  }
  return result;
}

export async function options({ database }) {
  const suppliers = unwrap(await database.from('suppliers').select('id, name, payment_terms, lead_time_days').eq('active', true).order('name'));
  return {
    suppliers: suppliers.map((row) => ({ id: row.id, name: row.name, terms: row.payment_terms, leadTimeDays: row.lead_time_days }))
  };
}

export async function suggestions({ database }, supplierId) {
  if (!UUID.test(supplierId ?? '')) throw new HttpError(400, 'Choose an active supplier.');
  return unwrap(await database.rpc('reorder_suggestions', { p_supplier: supplierId }));
}

export async function productPicker({ database }, query) {
  const search = searchText(query.q);
  let request = database.from('products').select('id, name, sku, barcode, unit_code, stock_qty, cost_price').eq('active', true);
  if (search) request = request.or(`name.ilike."*${search}*",sku.ilike."*${search}*",barcode.ilike."*${search}*"`);
  return unwrap(await request.order('name').limit(20)).map((row) => ({
    productId: row.id,
    name: row.name,
    sku: row.sku,
    unit: row.unit_code,
    stock: Number(row.stock_qty),
    unitCost: Number(row.cost_price)
  }));
}

export async function recordPrinted({ database }, user, id, kind) {
  requireId(id);
  const row = unwrap(await database.from('purchases').select('po_no').eq('id', id).maybeSingle());
  if (!row) throw new HttpError(404, 'Purchase order not found.');
  await writeAudit(database, { user, action: kind === 'pdf' ? 'Purchase bill PDF' : 'Purchase bill printed', description: row.po_no, entityType: 'purchase', entityId: id });
}

export async function summary({ database }) {
  return unwrap(await database.rpc('purchases_summary'));
}
