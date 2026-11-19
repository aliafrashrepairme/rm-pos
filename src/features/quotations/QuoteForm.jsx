import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { money, quantity } from '../../app/format.js';
import { useDebounced } from '../../app/useListRequest.js';
import Modal from '../../components/Modal.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

function localDatePlus(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const lineTotal = (line) => Math.round(Number(line.qty || 0) * line.price * 100) / 100;
const lineTax = (line) => Math.round(lineTotal(line) * line.taxRate) / 100;

// Creates a quotation, or edits a draft when `quote` is given.
export default function QuoteForm({ quote, onClose, onSaved }) {
  const { t } = useI18n();
  const [customer, setCustomer] = useState(quote?.customerId ? { id: quote.customerId, name: quote.customerName, phone: quote.customerPhone } : null);
  const [customerName, setCustomerName] = useState(quote?.customerId ? '' : quote?.customerName ?? '');
  const [customerPhone, setCustomerPhone] = useState(quote?.customerId ? '' : quote?.customerPhone ?? '');
  const [validUntil, setValidUntil] = useState(quote?.validUntil ?? localDatePlus(14));
  const [note, setNote] = useState(quote?.note ?? '');
  const [lines, setLines] = useState(() => (quote?.lines ?? []).map((line) => ({
    productId: line.productId, name: line.name, sku: line.sku, unit: line.unit, stock: line.stock,
    price: line.currentPrice, taxRate: line.currentTaxRate, qty: String(line.qty)
  })));
  const [typed, setTyped] = useState('');
  const search = useDebounced(typed);
  const [matches, setMatches] = useState([]);
  const [customerTyped, setCustomerTyped] = useState('');
  const customerSearch = useDebounced(customerTyped);
  const [customerMatches, setCustomerMatches] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!search.trim()) { setMatches([]); return undefined; }
    let current = true;
    api(`/api/quotations/products?q=${encodeURIComponent(search)}`)
      .then(({ products }) => { if (current) setMatches(products); })
      .catch((failure) => { if (current) setError(failure.message); });
    return () => { current = false; };
  }, [search]);

  useEffect(() => {
    if (!customerSearch.trim()) { setCustomerMatches([]); return undefined; }
    let current = true;
    api(`/api/customers?pageSize=8&q=${encodeURIComponent(customerSearch)}`)
      .then(({ customers }) => { if (current) setCustomerMatches(customers); })
      .catch(() => { if (current) setCustomerMatches([]); });
    return () => { current = false; };
  }, [customerSearch]);

  function addProduct(product) {
    setLines((current) => (current.some((line) => line.productId === product.productId) ? current : [...current, { ...product, qty: '1' }]));
    setTyped('');
    setMatches([]);
  }

  const change = (id, qty) => setLines((current) => current.map((line) => (line.productId === id ? { ...line, qty } : line)));
  const subtotal = lines.reduce((sum, line) => sum + lineTotal(line), 0);
  const tax = lines.reduce((sum, line) => sum + lineTax(line), 0);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const body = {
        customerId: customer?.id ?? null,
        customerName: customer ? customer.name : customerName,
        customerPhone: customer ? customer.phone : customerPhone,
        validUntil,
        note,
        items: lines.map((line) => ({ productId: line.productId, qty: line.qty }))
      };
      const { quotation } = await api(quote ? `/api/quotations/${quote.id}` : '/api/quotations', { method: quote ? 'PUT' : 'POST', body: JSON.stringify(body) });
      onSaved(quotation);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <Modal wide title={quote ? `${t('Edit quotation')} · ${quote.quoteNo}` : t('New quotation')} description={t('Prices are taken from the product list. A quotation does not change stock.')} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-scroll">
          <div className="form-grid">
            <div className="field full">{t('Customer')}
              {customer ? (
                <div className="customer-chosen">
                  <span><b>{customer.name}</b> <span className="muted small-note">{customer.phone}</span></span>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setCustomer(null)}>{t('Change')}</button>
                </div>
              ) : (
                <>
                  <input name="customerSearch" placeholder={t('Search saved customers, or type a new name below')} value={customerTyped} onChange={(event) => setCustomerTyped(event.target.value)} autoComplete="off" />
                  {customerMatches.length > 0 && (
                    <div className="pick-list">
                      {customerMatches.map((item) => (
                        <button type="button" key={item.id} className="pick-row" onClick={() => { setCustomer(item); setCustomerTyped(''); setCustomerMatches([]); }}>
                          <b>{item.name}</b> <span className="muted">{item.code} · {item.phone}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
            {!customer && <label className="field">{t('Customer name')}<input name="customerName" value={customerName} onChange={(event) => setCustomerName(event.target.value)} maxLength={120} required /></label>}
            {!customer && <label className="field">{t('Phone')}<input name="customerPhone" value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} maxLength={30} /></label>}
            <label className="field">{t('Valid until')}<input name="validUntil" type="date" min={localDatePlus(0)} value={validUntil} onChange={(event) => setValidUntil(event.target.value)} required /></label>
            <label className="field full">{t('Note')}<input name="note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder={t('Delivery, payment terms…')} /></label>
          </div>
          <label className="field order-search">{t('Add product')}
            <input name="productSearch" value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={t('Search by product name, SKU or barcode…')} autoComplete="off" />
          </label>
          {matches.length > 0 && (
            <div className="pick-list">
              {matches.map((product) => (
                <button type="button" key={product.productId} className="pick-row" onClick={() => addProduct(product)}>
                  <b>{product.name}</b> <span className="muted">{product.sku} · {money(product.price)} · {quantity(product.stock)} {t('in stock')}</span>
                </button>
              ))}
            </div>
          )}
          <div className="table-wrap order-lines">
            <table>
              <thead><tr>{['Product', 'Qty', 'Unit price', 'VAT', 'Line total', ''].map((heading) => <th key={heading || 'remove'}>{heading && t(heading)}</th>)}</tr></thead>
              <tbody>
                {lines.length === 0 && <tr><td colSpan="6"><div className="empty">{t('Add at least one product.')}</div></td></tr>}
                {lines.map((line) => (
                  <tr key={line.productId}>
                    <td><b className="pname">{line.name}</b><br /><span className="muted small-note">{line.sku} · {quantity(line.stock)} {t('in stock')}</span></td>
                    <td><input className="mini-input" type="number" min="0" step="any" aria-label={`${t('Qty')} ${line.name}`} value={line.qty} onChange={(event) => change(line.productId, event.target.value)} /></td>
                    <td>{money(line.price)}</td>
                    <td>{line.taxRate}%</td>
                    <td>{money(lineTotal(line))}</td>
                    <td><button type="button" className="icon-btn" aria-label={t('Remove line')} onClick={() => setLines((current) => current.filter((item) => item.productId !== line.productId))}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="cart-totals">
            <div className="total-row"><span>{t('Subtotal')}</span><b>{money(subtotal)}</b></div>
            <div className="total-row"><span>{t('VAT')}</span><b>{money(tax)}</b></div>
            <div className="total-row grand"><span>{t('Total')}</span><span>{money(subtotal + tax)}</span></div>
          </div>
        </div>
        {error && <p className="form-error modal-error" role="alert">{t(error)}</p>}
        <div className="modal-actions-row">
          <button type="button" className="btn btn-outline" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || lines.length === 0}>{t(quote ? 'Save changes' : 'Save as draft')}</button>
        </div>
      </form>
    </Modal>
  );
}
