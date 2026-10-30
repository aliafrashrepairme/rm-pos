import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { dateTime, money, quantity } from '../../app/format.js';
import { useDebounced, useListRequest } from '../../app/useListRequest.js';
import Modal from '../../components/Modal.jsx';
import Pager from '../../components/Pager.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

const REASONS = ['Damaged', 'Expired', 'Theft / Loss', 'Found stock', 'Supplier return', 'Internal use', 'Data correction'];

function AdjustmentForm({ onClose, onSaved }) {
  const { t } = useI18n();
  const toast = useToast();
  const [reason, setReason] = useState(REASONS[0]);
  const [note, setNote] = useState('');
  const [lines, setLines] = useState([]);
  const [typed, setTyped] = useState('');
  const search = useDebounced(typed);
  const [matches, setMatches] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!search) {
      setMatches([]);
      return undefined;
    }
    let current = true;
    api(`/api/inventory/adjustments/products?q=${encodeURIComponent(search)}`)
      .then(({ products }) => { if (current) setMatches(products); })
      .catch((failure) => { if (current) setError(failure.message); });
    return () => { current = false; };
  }, [search]);

  function addLine(product) {
    setLines((current) => (current.some((line) => line.id === product.id) ? current : [...current, { ...product, change: '-1' }]));
    setTyped('');
    setMatches([]);
  }

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { adjustment } = await api('/api/inventory/adjustments', {
        method: 'POST',
        body: JSON.stringify({ reason, note, lines: lines.map((line) => ({ productId: line.id, change: line.change })) })
      });
      toast(`${adjustment.adjustmentNo} · ${t('Stock updated')}`);
      onSaved();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <Modal wide title={t('New stock adjustment')} description={t('Choose a reason and the quantities to add (+) or remove (−).')} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-scroll">
          <div className="form-grid">
            <label className="field">{t('Reason')}
              <select name="reason" value={reason} onChange={(event) => setReason(event.target.value)}>
                {REASONS.map((item) => <option key={item} value={item}>{t(item)}</option>)}
              </select>
            </label>
            <label className="field">{t('Note')}
              <input name="note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder={t('What happened?')} />
            </label>
            <label className="field full">{t('Add product')}
              <input name="productSearch" value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={t('Search by product name, SKU or barcode…')} autoFocus />
            </label>
          </div>
          {matches.length > 0 && (
            <div className="pick-list">
              {matches.map((product) => (
                <button type="button" key={product.id} className="pick-row" onClick={() => addLine(product)}>
                  <b>{product.name}</b> <span className="muted">{product.sku} · {quantity(product.stock)} {t(product.unit)}</span>
                </button>
              ))}
            </div>
          )}
          {lines.map((line) => (
            <div className="category-row" key={line.id}>
              <span className="grow"><b>{line.name}</b><br /><span className="muted small-note">{quantity(line.stock)} {t('on hand')}</span></span>
              <input
                className="mini-input"
                type="number"
                step="any"
                aria-label={`${t('Qty +/−')} ${line.name}`}
                value={line.change}
                onChange={(event) => setLines((current) => current.map((item) => (item.id === line.id ? { ...item, change: event.target.value } : item)))}
                required
              />
              <button type="button" className="icon-btn" aria-label={t('Remove line')} onClick={() => setLines((current) => current.filter((item) => item.id !== line.id))}>×</button>
            </div>
          ))}
        </div>
        {error && <p className="form-error modal-error" role="alert">{t(error)}</p>}
        <div className="modal-actions-row">
          <button type="button" className="btn btn-outline" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || lines.length === 0}>{t('Save adjustment')}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function AdjustmentsTab() {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);
  const { data, error, reload } = useListRequest(`/api/inventory/adjustments?page=${page}`);

  return (
    <>
      <div className="tab-actions">
        <button type="button" className="btn btn-primary" onClick={() => setShowForm(true)}>＋ {t('New adjustment')}</button>
      </div>
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>{['Adj. no.', 'Date', 'By', 'Reason', 'Items', 'Value (cost)'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr>
          </thead>
          <tbody>
            {!data && !error && <tr><td colSpan="6"><div className="empty">{t('Loading…')}</div></td></tr>}
            {data?.adjustments.length === 0 && <tr><td colSpan="6"><div className="empty">{t('No records found.')}</div></td></tr>}
            {data?.adjustments.map((row) => (
              <tr key={row.id}>
                <td><b>{row.adjustmentNo}</b></td>
                <td>{dateTime(row.createdAt)}</td>
                <td>{row.user}</td>
                <td><span className="chip gray">{t(row.reason)}</span>{row.note && <><br /><span className="muted small-note">{row.note}</span></>}</td>
                <td>{row.lines.map((line) => <div key={line.product}>{line.product}: <b className={line.change < 0 ? 'qty-down' : 'qty-up'}>{line.change > 0 ? '+' : ''}{quantity(line.change)}</b></div>)}</td>
                <td>{money(row.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      {showForm && <AdjustmentForm onClose={() => setShowForm(false)} onSaved={() => { setShowForm(false); reload(); }} />}
    </>
  );
}
