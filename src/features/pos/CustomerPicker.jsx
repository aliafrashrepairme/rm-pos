import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useDebounced } from '../../app/useListRequest.js';
import Modal from '../../components/Modal.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

function NewCustomerModal({ onClose, onCreated }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { customer } = await api('/api/pos/customers', { method: 'POST', body: JSON.stringify({ name, phone }) });
      onCreated(customer);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={t('New customer')} description={t('First-time buyers get coupon WELCOME10 (10% off) on this purchase.')} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label className="field full">{t('Customer name')}<input name="customerName" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required autoFocus /></label>
          <label className="field full">{t('Phone')}<input name="customerPhone" value={phone} onChange={(event) => setPhone(event.target.value)} maxLength={20} required /></label>
        </div>
        {error && <p className="form-error modal-error" role="alert">{t(error)}</p>}
        <div className="modal-actions-row">
          <button type="button" className="btn btn-outline" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{t('Save record')}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function CustomerPicker({ customer, canCreate, onChoose }) {
  const { t } = useI18n();
  const [typed, setTyped] = useState('');
  const search = useDebounced(typed);
  const [matches, setMatches] = useState([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!search.trim()) {
      setMatches([]);
      return undefined;
    }
    let current = true;
    api(`/api/pos/customers?q=${encodeURIComponent(search)}`)
      .then(({ customers }) => { if (current) setMatches(customers); })
      .catch(() => { if (current) setMatches([]); });
    return () => { current = false; };
  }, [search]);

  function choose(next, details) {
    setTyped('');
    setMatches([]);
    onChoose(next, details);
  }

  return (
    <div className="field customer-field">
      {t('Customer')}
      {customer ? (
        <div className="customer-chosen">
          <span><b>{customer.name}</b> <span className="muted small-note">{customer.phone}</span></span>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => choose(null)}>{t('Walk-in Customer')}</button>
        </div>
      ) : (
        <div className="customer-search">
          <input
            name="customerSearch"
            aria-label={t('Customer')}
            placeholder={t('Walk-in Customer')}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
          />
          {canCreate && <button type="button" className="btn btn-outline btn-sm" onClick={() => setCreating(true)}>＋ {t('New')}</button>}
        </div>
      )}
      {matches.length > 0 && (
        <div className="pick-list">
          {matches.map((item) => (
            <button type="button" key={item.id} className="pick-row" onClick={() => choose(item)}>
              <b>{item.name}</b> <span className="muted">{item.phone} · {item.loyaltyPoints} {t('points')}</span>
            </button>
          ))}
        </div>
      )}
      {creating && (
        <NewCustomerModal
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            choose(created, { isNew: true });
          }}
        />
      )}
    </div>
  );
}
