import { randomUUID } from 'node:crypto';
import { selectAll } from '../db.js';
import { HttpError, unwrap } from '../errors.js';
import { writeAudit } from './audit.js';
import { ExtractionError } from './invoiceExtractor.js';

const BUCKET = 'invoice-scans';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STALE_MS = 5 * 60 * 1000;
const MAX_IMAGE_BYTES = 3.7 * 1024 * 1024;
const MAX_PDF_BYTES = 15 * 1024 * 1024;

const FILE_TYPES = {
  'image/jpeg': { extension: 'jpg', max: MAX_IMAGE_BYTES, matches: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  'image/png': { extension: 'png', max: MAX_IMAGE_BYTES, matches: (bytes) => bytes.subarray(0, 4).toString('hex') === '89504e47' },
  'image/webp': { extension: 'webp', max: MAX_IMAGE_BYTES, matches: (bytes) => bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' },
  'application/pdf': { extension: 'pdf', max: MAX_PDF_BYTES, matches: (bytes) => bytes.subarray(0, 5).toString() === '%PDF-' }
};

export const ACCEPTED_FILE_TYPES = Object.keys(FILE_TYPES);
export const FILE_BODY_LIMIT = MAX_PDF_BYTES;

const SCAN_COLUMNS = 'id, file_name, mime_type, status, provider, error_message, supplier_text, supplier_id, invoice_no, invoice_date, overall_confidence, raw_result, purchase_id, created_at, updated_at, purchases(po_no)';

function requireId(id) {
  if (!UUID.test(id)) throw new HttpError(404, 'Invoice scan not found.');
}

function asSummary(row) {
  return {
    id: row.id,
    fileName: row.file_name,
    status: row.status,
    invoiceNo: row.invoice_no,
    supplierText: row.supplier_text,
    confidence: row.overall_confidence === null ? null : Number(row.overall_confidence),
    poNo: row.purchases?.po_no ?? null,
    createdAt: row.created_at
  };
}

export function status({ extractor }) {
  return { connected: Boolean(extractor), provider: extractor?.provider ?? null };
}

export async function listScans({ database }) {
  const rows = unwrap(await database.from('invoice_scans').select(SCAN_COLUMNS).order('created_at', { ascending: false }).order('id').limit(25));
  return rows.map(asSummary);
}

export async function options({ database }) {
  const [suppliers, products] = await Promise.all([
    selectAll(() => database.from('suppliers').select('id, name').eq('active', true).order('name').order('id')),
    selectAll(() => database.from('products').select('id, name, sku, cost_price').eq('active', true).order('name').order('id'))
  ]);
  return {
    suppliers,
    products: products.map((row) => ({ id: row.id, name: row.name, sku: row.sku, cost: Number(row.cost_price) }))
  };
}

export async function getScan({ database }, id) {
  requireId(id);
  const row = unwrap(await database.from('invoice_scans').select(SCAN_COLUMNS).eq('id', id).maybeSingle());
  if (!row) throw new HttpError(404, 'Invoice scan not found.');
  const lines = unwrap(await database.from('invoice_scan_lines')
    .select('id, line_no, raw_text, qty, unit_cost, confidence, matched_product_id, match_score')
    .eq('invoice_scan_id', id)
    .order('line_no'));
  let duplicate = null;
  if (row.invoice_no && row.supplier_id && row.status === 'Extracted') {
    const found = unwrap(await database.from('purchases').select('po_no').eq('supplier_id', row.supplier_id).eq('supplier_invoice_no', row.invoice_no).neq('status', 'Cancelled').maybeSingle());
    duplicate = found?.po_no ?? null;
  }
  return {
    ...asSummary(row),
    mimeType: row.mime_type,
    provider: row.provider,
    error: row.error_message,
    supplierId: row.supplier_id,
    invoiceDate: row.invoice_date,
    purchaseId: row.purchase_id,
    totals: row.raw_result ? { subtotal: row.raw_result.subtotal, tax: row.raw_result.tax, total: row.raw_result.total } : null,
    duplicate,
    lines: lines.map((line) => ({
      id: line.id,
      description: line.raw_text,
      qty: line.qty === null ? null : Number(line.qty),
      unitCost: line.unit_cost === null ? null : Number(line.unit_cost),
      confidence: line.confidence === null ? null : Number(line.confidence),
      productId: line.matched_product_id,
      matchScore: line.match_score === null ? null : Number(line.match_score)
    }))
  };
}

async function runExtraction(clients, user, row, bytes) {
  const { database, extractor } = clients;
  try {
    const result = await extractor.extract({ bytes, mimeType: row.mime_type });
    unwrap(await database.rpc('save_invoice_extraction', { p_scan: row.id, p_result: result, p_provider: extractor.provider }));
    await writeAudit(database, { user, action: 'Invoice scanned', description: `${row.file_name} · ${result.invoiceNo ?? 'no invoice number'} · ${result.lines.length} lines`, entityType: 'invoice_scan', entityId: row.id });
  } catch (error) {
    const message = error instanceof ExtractionError ? error.message : 'The invoice could not be read. Try again.';
    if (!(error instanceof ExtractionError)) console.error('Could not save the scan:', error);
    unwrap(await database.from('invoice_scans').update({ status: 'Failed', provider: extractor.provider, error_message: message, updated_at: new Date().toISOString() }).eq('id', row.id).select('id').single());
    await writeAudit(database, { user, action: 'Invoice scan failed', description: `${row.file_name} · ${message}`, entityType: 'invoice_scan', entityId: row.id });
  }
}

function requireExtractor({ extractor }) {
  if (!extractor) throw new HttpError(503, 'Invoice scanning is not connected. Add the API key to the server settings first.', 'SCAN_NOT_CONNECTED');
}

export async function uploadScan(clients, user, contentType, name, bytes) {
  requireExtractor(clients);
  const { database } = clients;
  const type = FILE_TYPES[contentType];
  if (!type || !Buffer.isBuffer(bytes) || !bytes.length) throw new HttpError(415, 'Choose a JPG, PNG, WebP or PDF file.');
  if (!type.matches(bytes)) throw new HttpError(415, 'This file is not a valid image or PDF.');
  if (bytes.length > type.max) throw new HttpError(413, 'This file is too large. Use a smaller photo or PDF.');

  const id = randomUUID();
  const path = `scans/${id}.${type.extension}`;
  try {
    const bucket = await database.storage.createBucket(BUCKET, { public: false, fileSizeLimit: MAX_PDF_BYTES, allowedMimeTypes: ACCEPTED_FILE_TYPES });
    if (bucket.error && !/already exists/i.test(bucket.error.message)) throw bucket.error;
    const { error } = await database.storage.from(BUCKET).upload(path, bytes, { contentType });
    if (error) throw error;
  } catch (error) {
    console.error('Invoice upload failed:', error);
    throw new HttpError(502, 'The file could not be saved. Try again.');
  }

  const fileName = (typeof name === 'string' ? name : '').replace(/[^\p{L}\p{N} ._()-]/gu, '').trim().slice(0, 120) || `invoice.${type.extension}`;
  const row = unwrap(await database.from('invoice_scans')
    .insert({ id, file_path: path, file_name: fileName, mime_type: contentType, status: 'Processing', created_by: user.id })
    .select('id, file_name, mime_type')
    .single());
  await runExtraction(clients, user, row, bytes);
  return getScan(clients, id);
}

export async function retryScan(clients, user, id) {
  requireExtractor(clients);
  requireId(id);
  const { database } = clients;
  const current = unwrap(await database.from('invoice_scans').select('id, status, updated_at, file_path, file_name, mime_type').eq('id', id).maybeSingle());
  if (!current) throw new HttpError(404, 'Invoice scan not found.');
  const stuck = current.status === 'Processing' && Date.now() - new Date(current.updated_at).getTime() > STALE_MS;
  if (current.status !== 'Failed' && !stuck) throw new HttpError(409, 'Only a failed scan can be tried again.');

  // Changing the status only if it hasn't moved means two people can't both pay to read it.
  const claimed = unwrap(await database.from('invoice_scans')
    .update({ status: 'Processing', error_message: null, updated_at: new Date().toISOString() })
    .eq('id', id).eq('status', current.status).eq('updated_at', current.updated_at)
    .select('id').maybeSingle());
  if (!claimed) throw new HttpError(409, 'This scan is already being read.');

  const { data, error } = await database.storage.from(BUCKET).download(current.file_path);
  if (error) {
    console.error('Could not read the stored invoice:', error);
    unwrap(await database.from('invoice_scans').update({ status: 'Failed', error_message: 'The stored file could not be opened.' }).eq('id', id).select('id').single());
    return getScan(clients, id);
  }
  await runExtraction(clients, user, current, Buffer.from(await data.arrayBuffer()));
  return getScan(clients, id);
}

export async function scanFile({ database }, id) {
  requireId(id);
  const row = unwrap(await database.from('invoice_scans').select('file_path, file_name, mime_type').eq('id', id).maybeSingle());
  if (!row) throw new HttpError(404, 'Invoice scan not found.');
  const { data, error } = await database.storage.from(BUCKET).download(row.file_path);
  if (error) {
    console.error('Could not read the stored invoice:', error);
    throw new HttpError(502, 'The stored file could not be opened.');
  }
  return { bytes: Buffer.from(await data.arrayBuffer()), mimeType: row.mime_type };
}

function reviewFrom(body) {
  if (!Array.isArray(body?.lines)) throw new HttpError(400, 'Keep at least one line on the invoice.');
  if (body.lines.length > 500) throw new HttpError(400, 'This invoice has too many lines.');
  const invoiceNo = typeof body.invoiceNo === 'string' ? body.invoiceNo.trim() : '';
  if (invoiceNo.length > 60) throw new HttpError(400, 'The invoice number must be 60 characters or fewer.');
  const invoiceDate = body.invoiceDate || '';
  if (invoiceDate && !(typeof invoiceDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(invoiceDate) && !Number.isNaN(new Date(invoiceDate).getTime()))) {
    throw new HttpError(400, 'Enter a valid invoice date.');
  }
  const supplierId = body.supplierId || '';
  if (supplierId && !UUID.test(supplierId)) throw new HttpError(400, 'Choose a valid supplier.');
  const lines = body.lines.map((line) => {
    const description = typeof line?.description === 'string' ? line.description.trim() : '';
    if (!description || description.length > 300) throw new HttpError(400, 'Every line needs a description.');
    const number = (value, valid) => {
      if (value === '' || value === null || value === undefined) return null;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || !valid(parsed)) throw new HttpError(400, 'Enter a valid quantity and unit cost for every line.');
      return parsed;
    };
    const productId = line.productId || '';
    if (productId && !UUID.test(productId)) throw new HttpError(400, 'Choose a valid product.');
    return {
      description,
      qty: number(line.qty, (value) => value > 0 && value <= 999999 && value === Math.round(value * 1000) / 1000),
      unitCost: number(line.unitCost, (value) => value >= 0 && value <= 99999999),
      confidence: line.confidence ?? null,
      matchScore: line.matchScore ?? null,
      productId
    };
  });
  return { supplierId, invoiceNo, invoiceDate, lines };
}

export async function saveReview(clients, user, id, body) {
  requireId(id);
  unwrap(await clients.database.rpc('save_invoice_review', { p_scan: id, p_review: reviewFrom(body) }));
  return getScan(clients, id);
}

export async function approveScan(clients, user, id, body) {
  requireId(id);
  const result = unwrap(await clients.database.rpc('approve_invoice_scan', { p_scan: id, p_review: reviewFrom(body), p_user: user.id }));
  await writeAudit(clients.database, { user, action: 'Invoice approved', description: `${result.poNo} · ${body.invoiceNo}`, entityType: 'invoice_scan', entityId: id });
  return { scan: await getScan(clients, id), purchaseId: result.purchaseId, poNo: result.poNo };
}

export async function rejectScan(clients, user, id) {
  requireId(id);
  const row = unwrap(await clients.database.from('invoice_scans')
    .update({ status: 'Rejected', updated_at: new Date().toISOString() })
    .eq('id', id).in('status', ['Extracted', 'Failed'])
    .select('file_name').maybeSingle());
  if (!row) throw new HttpError(409, 'This scan can no longer be rejected.');
  await writeAudit(clients.database, { user, action: 'Invoice rejected', description: row.file_name, entityType: 'invoice_scan', entityId: id });
  return getScan(clients, id);
}
