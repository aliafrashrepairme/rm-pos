import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { can } from '../../app/access.js';
import { money, quantity } from '../../app/format.js';
import { useDebounced } from '../../app/useListRequest.js';
import Modal from '../../components/Modal.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

function localDatePlus(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function NewSupplierForm({ onCreated, onCancel }) {
  const { t } = useI18n();
  const [values, setValues] = useState({ name: '', contactPerson: '', phone: '', paymentTerms: 'Cash', leadTimeDays: '5' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const field = (name) => ({ name: `supplier-${name}`, value: values[name], onChange: (event) => setValues((current) => ({ ...current, [name]: event.target.value })) });

  async function submit() {
    setError('');
    setBusy(true);
    try {
      const { supplier } = await api('/api/suppliers', { method: 'POST', body: JSON.stringify(values) });
      onCreated(supplier);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <div className="inline-panel">
      <div className="form-grid">
        <label className="field full">{t('Supplier name')}<input {...field('name')} maxLength={120} autoFocus /></label>
        <label className="field">{t('Contact person')}<input {...field('contactPerson')} maxLength={120} /></label>
        <label className="field">{t('Phone')}<input {...field('phone')} maxLength={30} /></label>
        <label className="field">{t('Payment terms')}
          <select {...field('paymentTerms')}>
            {['Cash', 'Credit 14 days', 'Credit 30 days', 'Credit 60 days'].map((term) => <option key={term} value={term}>{t(term)}</option>)}
          </select>
        </label>
        <label className="field">{t('Lead time (days)')}<input {...field('leadTimeDays')} type="number" min="0" /></label>
      </div>
      {error && <p className="form-error modal-error" role="alert">{t(error)}</p>}
      <div className="modal-actions-row">
        <button type="button" className="btn btn-outline btn-sm" onClick={onCancel}>{t('Cancel')}</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={submit}>{t('Add supplier')}</button>
      </div>
    </div>
  );
}

export default function NewOrderModal({ user, initialSupplierId, onClose, onCreated }) {
  const { t } = useI18n();
  const [suppliers, setSuppliers] = useState([]);
  const [supplierId, setSupplierId] = useState('');
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [expectedAt, setExpectedAt] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [lines, setLines] = useState([]);
  const [typed, setTyped] = useState('');
  const search = useDebounced(typed);
  const [matches, setMatches] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const latestSuggestions = useRef(0);

  useEffect(() => {
    api('/api/purchases/options')
      .then((options) => {
        setSuppliers(options.suppliers);
        const first = options.suppliers.find((item) => item.id === initialSupplierId) ?? options.suppliers[0];
        if (first) chooseSupplier(first.id, options.suppliers);
      })
      .catch((failure) => setError(failure.message));
    // Runs once, when the form opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!search.trim()) {
      setMatches([]);
      return undefined;
    }
    let current = true;
    api(`/api/purchases/products?q=${encodeURIComponent(search)}`)
      .then(({ products }) => { if (current) setMatches(products); })
      .catch((failure) => { if (current) setError(failure.message); });
    return () => { current = false; };
  }, [search]);

  function chooseSupplier(id, list = suppliers) {
    setSupplierId(id);
    const supplier = list.find((item) => item.id === id);
    if (supplier) setExpectedAt(localDatePlus(supplier.leadTimeDays));
    // Low-stock items for this supplier are suggested, as in the prototype.
    // A slow reply for a supplier no longer selected must not replace this order's lines.
    const request = ++latestSuggestions.current;
    setLines([]);
    api(`/api/purchases/suggestions?supplierId=${id}`)
      .then(({ suggestions }) => {
        if (request === latestSuggestions.current) {
          setLines(suggestions.map((item) => ({ ...item, qty: String(item.qty), unitCost: String(item.unitCost) })));
        }
      })
      .catch((failure) => {
        if (request === latestSuggestions.current) setError(failure.message);
      });
  }

  function addProduct(product) {
    setLines((current) => (current.some((line) => line.productId === product.productId) ? current : [...current, { ...product, qty: '1', unitCost: String(product.unitCost) }]));
    setTyped('');
    setMatches([]);
  }

  const change = (id, name, value) => setLines((current) => current.map((line) => (line.productId === id ? { ...line, [name]: value } : line)));
  const total = lines.reduce((sum, line) => sum + Math.round(Number(line.qty || 0) * Number(line.unitCost || 0) * 100) / 100, 0);
  const supplier = suppliers.find((item) => item.id === supplierId);

  async function save(status) {
    setError('');
    setBusy(true);
    try {
      const { purchase } = await api('/api/purchases', {
        method: 'POST',
        body: JSON.stringify({
          supplierId,
          status,
          expectedAt,
          supplierInvoiceNo: invoiceNo,
          items: lines.map((line) => ({ productId: line.productId, qty: line.qty, unitCost: line.unitCost }))
        })
      });
      onCreated(purchase);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <Modal wide title={t('New purchase order')} description={t('Low-stock items for the selected supplier are suggested automatically.')} onClose={onClose}>
      <div className="modal-scroll">
        <div className="form-grid">
          <label className="field">{t('Supplier')}
            <select name="supplierId" value={supplierId} onChange={(event) => chooseSupplier(event.target.value)}>
              {suppliers.length === 0 && <option value="">{t('Add a supplier first')}</option>}
              {suppliers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            {supplier && <span className="sub">{t('Lead time')} {supplier.leadTimeDays} {t('days')} · {t(supplier.terms)}</span>}
          </label>
          <label className="field">{t('Expected delivery')}<input name="expectedAt" type="date" value={expectedAt} onChange={(event) => setExpectedAt(event.target.value)} /></label>
          <label className="field">{t('Supplier invoice no.')}<input name="invoiceNo" value={invoiceNo} onChange={(event) => setInvoiceNo(event.target.value)} maxLength={60} /></label>
          {can(user, 'suppliers.manage') && !addingSupplier && (
            <div className="field supplier-add"><button type="button" className="btn btn-outline btn-sm" onClick={() => setAddingSupplier(true)}>＋ {t('Add supplier')}</button></div>
          )}
        </div>
        {addingSupplier && (
          <NewSupplierForm
            onCancel={() => setAddingSupplier(false)}
            onCreated={(created) => {
              const next = [...suppliers, created].sort((a, b) => a.name.localeCompare(b.name));
              setSuppliers(next);
              setAddingSupplier(false);
              chooseSupplier(created.id, next);
            }}
          />
        )}
        <label className="field order-search">{t('Add product')}
          <input name="productSearch" value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={t('Search by product name, SKU or barcode…')} autoComplete="off" />
        </label>
        {matches.length > 0 && (
          <div className="pick-list">
            {matches.map((product) => (
              <button type="button" key={product.productId} className="pick-row" onClick={() => addProduct(product)}>
                <b>{product.name}</b> <span className="muted">{product.sku} · {quantity(product.stock)} {t('in stock')}</span>
              </button>
            ))}
          </div>
        )}
        <div className="table-wrap order-lines">
          <table>
            <thead><tr>{['Product', 'Qty', 'Unit cost', 'Line total', ''].map((heading) => <th key={heading || 'remove'}>{heading && t(heading)}</th>)}</tr></thead>
            <tbody>
              {lines.length === 0 && <tr><td colSpan="5"><div className="empty">{t('Add at least one product.')}</div></td></tr>}
              {lines.map((line) => (
                <tr key={line.productId}>
                  <td><b className="pname">{line.name}</b><br /><span className="muted small-note">{line.sku} · {quantity(line.stock)} {t('in stock')}</span></td>
                  <td><input className="mini-input" type="number" min="0" step="any" aria-label={`${t('Qty')} ${line.name}`} value={line.qty} onChange={(event) => change(line.productId, 'qty', event.target.value)} /></td>
                  <td><input className="mini-input" type="number" min="0" step="0.01" aria-label={`${t('Unit cost')} ${line.name}`} value={line.unitCost} onChange={(event) => change(line.productId, 'unitCost', event.target.value)} /></td>
                  <td>{money(Number(line.qty || 0) * Number(line.unitCost || 0))}</td>
                  <td><button type="button" className="icon-btn" aria-label={t('Remove line')} onClick={() => setLines((current) => current.filter((item) => item.productId !== line.productId))}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="total-row grand order-total"><span>{t('Order total')}</span><span>{money(total)}</span></div>
      </div>
      {error && <p className="form-error modal-error" role="alert">{t(error)}</p>}
      <div className="modal-actions-row">
        <button type="button" className="btn btn-outline" onClick={onClose}>{t('Cancel')}</button>
        <button type="button" className="btn btn-outline" disabled={busy || !supplierId || !lines.length} onClick={() => save('Draft')}>{t('Save as draft')}</button>
        <button type="button" className="btn btn-primary" disabled={busy || !supplierId || !lines.length} onClick={() => save('Ordered')}>{t('Create & send PO')}</button>
      </div>
    </Modal>
  );
}
