import { useState } from 'react';
import { api } from '../../api.js';
import Modal from '../../components/Modal.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

const TERMS = ['Cash', 'Credit 14 days', 'Credit 30 days', 'Credit 60 days'];

export default function SupplierForm({ supplier, onClose, onSaved }) {
  const { t } = useI18n();
  const [values, setValues] = useState({
    name: supplier?.name ?? '',
    contactPerson: supplier?.contactPerson ?? '',
    phone: supplier?.phone ?? '',
    email: supplier?.email ?? '',
    address: supplier?.address ?? '',
    city: supplier?.city ?? '',
    paymentTerms: supplier?.paymentTerms ?? 'Cash',
    leadTimeDays: String(supplier?.leadTimeDays ?? 5),
    rating: supplier?.rating === null || supplier?.rating === undefined ? '' : String(supplier.rating)
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const field = (name) => ({ name, value: values[name], onChange: (event) => setValues((current) => ({ ...current, [name]: event.target.value })) });
  // A term set some other way stays selectable when editing.
  const terms = TERMS.includes(values.paymentTerms) ? TERMS : [...TERMS, values.paymentTerms];

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { supplier: saved } = await api(supplier ? `/api/suppliers/${supplier.id}` : '/api/suppliers', {
        method: supplier ? 'PATCH' : 'POST',
        body: JSON.stringify(values)
      });
      onSaved(saved);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <Modal wide title={t(supplier ? 'Edit supplier' : 'Add supplier')} description={t('Save supplier contact, payment terms and lead time.')} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-scroll">
          <div className="form-grid">
            <label className="field full">{t('Supplier name')}<input {...field('name')} maxLength={120} required autoFocus /></label>
            <label className="field">{t('Contact person')}<input {...field('contactPerson')} maxLength={120} /></label>
            <label className="field">{t('Phone')}<input {...field('phone')} maxLength={30} /></label>
            <label className="field">{t('Email')}<input {...field('email')} type="email" maxLength={120} /></label>
            <label className="field">{t('City')}<input {...field('city')} maxLength={80} /></label>
            <label className="field full">{t('Address')}<input {...field('address')} maxLength={300} /></label>
            <label className="field">{t('Payment terms')}
              <select {...field('paymentTerms')}>{terms.map((term) => <option key={term} value={term}>{t(term)}</option>)}</select>
            </label>
            <label className="field">{t('Lead time (days)')}<input {...field('leadTimeDays')} type="number" min="0" max="365" step="1" /></label>
            {supplier && <label className="field">{t('Your rating (0 to 5)')}<input {...field('rating')} type="number" min="0" max="5" step="0.1" /></label>}
          </div>
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
