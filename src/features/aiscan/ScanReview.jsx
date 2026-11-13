import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { money } from '../../app/format.js';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import QuickProductModal from './QuickProductModal.jsx';

const LOW_CONFIDENCE = 80;

function confidenceChip(value, t) {
  if (value === null || value === undefined) return null;
  const low = value < LOW_CONFIDENCE;
  return <span className={`conf ${low ? 'low' : ''}`}>{Math.round(value)}%{low && ` · ${t('Check')}`}</span>;
}

export default function ScanReview({ scan, options, onReload, onApproved, onRejected, onError }) {
  const { t } = useI18n();
  const [supplierId, setSupplierId] = useState(scan.supplierId ?? '');
  const [invoiceNo, setInvoiceNo] = useState(scan.invoiceNo ?? '');
  const [invoiceDate, setInvoiceDate] = useState(scan.invoiceDate ?? '');
  const [lines, setLines] = useState(() => scan.lines.map((line, index) => ({ ...line, key: index, qty: line.qty ?? '', unitCost: line.unitCost ?? '', productId: line.productId ?? '' })));
  const [creatingFor, setCreatingFor] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setSupplierId(scan.supplierId ?? ''); }, [scan.supplierId]);

  const products = useMemo(() => new Map(options.products.map((product) => [product.id, product])), [options.products]);
  const change = (key, name, value) => setLines((current) => current.map((line) => (line.key === key ? { ...line, [name]: value } : line)));
  const linesTotal = lines.reduce((sum, line) => sum + Math.round(Number(line.qty || 0) * Number(line.unitCost || 0) * 100) / 100, 0);
  const printedTotal = scan.totals?.subtotal ?? scan.totals?.total ?? null;
  const totalDiffers = printedTotal !== null && Math.abs(printedTotal - linesTotal) > Math.max(1, printedTotal * 0.01);
  const unmatched = lines.filter((line) => !line.productId).length;
  const lowCount = lines.filter((line) => line.confidence !== null && line.confidence < LOW_CONFIDENCE).length;
  const repeats = new Set(lines.map((line) => line.productId).filter(Boolean)).size !== lines.filter((line) => line.productId).length;

  const review = () => ({
    supplierId,
    invoiceNo,
    invoiceDate,
    lines: lines.map(({ description, qty, unitCost, productId, confidence, matchScore }) => ({ description, qty, unitCost, productId, confidence, matchScore }))
  });

  async function approve() {
    setBusy(true);
    try {
      onApproved(await api(`/api/invoice-scans/${scan.id}/approve`, { method: 'POST', body: JSON.stringify(review()) }));
    } catch (failure) {
      onError(failure.message);
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    try {
      await api(`/api/invoice-scans/${scan.id}/reject`, { method: 'POST' });
      onRejected();
    } catch (failure) {
      onError(failure.message);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card scan-section">
        <div className="section-row">
          <div><h3>{t('Extracted details')}</h3><div className="sub">{t('Review and edit before posting')}</div></div>
          {confidenceChip(scan.confidence, t)}
        </div>
        {scan.duplicate && <p className="form-error" role="alert">{t('This invoice number is already on order')} {scan.duplicate}.</p>}
        {lowCount > 0 && <p className="light-note">{t('Some values were hard to read. Check the lines marked below against the document.')}</p>}
        <div className="form-grid">
          <label className="field">{t('Supplier')}
            <select name="scanSupplier" value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
              <option value="">{t('Choose a supplier')}</option>
              {options.suppliers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            {scan.supplierText && <span className="sub">{t('On the invoice')}: {scan.supplierText}</span>}
          </label>
          <label className="field">{t('Invoice number')}<input name="scanInvoiceNo" value={invoiceNo} maxLength={60} onChange={(event) => setInvoiceNo(event.target.value)} /></label>
          <label className="field">{t('Invoice date')}<input name="scanInvoiceDate" type="date" value={invoiceDate} onChange={(event) => setInvoiceDate(event.target.value)} /></label>
        </div>
      </div>

      <div className="card scan-section">
        <h3>{t('Line items')}</h3>
        <div className="sub">{lines.length} {t('lines')}{unmatched > 0 && ` · ${unmatched} ${t('not matched yet')}`}</div>
        <div className="table-wrap scan-lines">
          <table>
            <thead><tr>{['Invoice text', 'Matched product', 'Qty', 'Unit cost', 'Total', 'Read', ''].map((heading) => <th key={heading || 'remove'}>{heading && t(heading)}</th>)}</tr></thead>
            <tbody>
              {lines.map((line) => {
                const product = products.get(line.productId);
                const cost = Number(line.unitCost);
                const moved = product && product.cost > 0 && line.unitCost !== '' ? Math.round(((cost - product.cost) / product.cost) * 1000) / 10 : 0;
                return (
                  <tr key={line.key}>
                    <td><input className="inp scan-text" aria-label={t('Invoice text')} value={line.description} maxLength={300} onChange={(event) => change(line.key, 'description', event.target.value)} /></td>
                    <td>
                      <select className="inp scan-product" aria-label={`${t('Matched product')} ${line.description}`} value={line.productId} onChange={(event) => (event.target.value === 'NEW' ? setCreatingFor(line) : change(line.key, 'productId', event.target.value))}>
                        <option value="">{t('Choose a product')}</option>
                        <option value="NEW">＋ {t('Create new product')}</option>
                        {options.products.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.sku})</option>)}
                      </select>
                      {moved !== 0 && <div className={`small-note ${moved > 0 ? 'qty-down' : 'muted'}`}>{moved > 0 ? '+' : ''}{moved}% {t('from last cost')} {money(product.cost)}</div>}
                    </td>
                    <td><input className="mini-input" type="number" min="0" step="any" aria-label={`${t('Qty')} ${line.description}`} value={line.qty} onChange={(event) => change(line.key, 'qty', event.target.value)} /></td>
                    <td><input className="mini-input" type="number" min="0" step="0.01" aria-label={`${t('Unit cost')} ${line.description}`} value={line.unitCost} onChange={(event) => change(line.key, 'unitCost', event.target.value)} /></td>
                    <td>{money(Number(line.qty || 0) * Number(line.unitCost || 0))}</td>
                    <td>{confidenceChip(line.confidence, t)}</td>
                    <td><button type="button" className="icon-btn" aria-label={t('Remove line')} disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))}>×</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="total-row grand order-total"><span>{t('Order total')}</span><span>{money(linesTotal)}</span></div>
        {printedTotal !== null && <div className={`total-row ${totalDiffers ? 'qty-down' : ''}`}><span>{t('Total printed on the invoice')}{totalDiffers && ` · ${t('Does not match the lines')}`}</span><b>{money(printedTotal)}</b></div>}
        {repeats && <p className="form-error" role="alert">{t('A product appears twice. Combine those lines before approving.')}</p>}
      </div>

      <div className="modal-actions-row">
        <button type="button" className="btn btn-outline" disabled={busy} onClick={reject}>{t('Reject')}</button>
        <button type="button" className="btn btn-primary" disabled={busy || unmatched > 0 || repeats || !supplierId || !invoiceNo.trim()} onClick={approve}>{t('Approve and create order')}</button>
      </div>
      <p className="sub scan-note">{t('Approving creates a purchase order. Stock only changes when you receive it.')}</p>

      {creatingFor && (
        <QuickProductModal
          line={creatingFor}
          supplierId={supplierId}
          onClose={() => setCreatingFor(null)}
          onCreated={(product) => {
            const key = creatingFor.key;
            onReload().then(() => change(key, 'productId', product.id));
            setCreatingFor(null);
          }}
        />
      )}
    </>
  );
}
