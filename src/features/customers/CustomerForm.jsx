import { useState } from 'react';
import { api } from '../../api.js';
import { can } from '../../app/access.js';
import Modal from '../../components/Modal.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

export default function CustomerForm({ customer, user, onClose, onSaved }) {
  const { t } = useI18n();
  const [values, setValues] = useState({
    name: customer?.name ?? '',
    phone: customer?.phone ?? '',
    email: customer?.email ?? '',
    address: customer?.address ?? '',
    loyaltyPoints: '0'
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const field = (name) => ({ name, value: values[name], onChange: (event) => setValues((current) => ({ ...current, [name]: event.target.value })) });

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    const { loyaltyPoints, ...details } = values;
    try {
      const { customer: saved } = await api(customer ? `/api/customers/${customer.id}` : '/api/customers', {
        method: customer ? 'PATCH' : 'POST',
        body: JSON.stringify(customer ? details : { ...details, loyaltyPoints })
      });
      onSaved(saved);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={t(customer ? 'Edit customer' : 'Add customer')} description={t('Create a customer profile.')} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label className="field full">{t('Customer name')}<input {...field('name')} maxLength={120} required autoFocus /></label>
          <label className="field">{t('Phone')}<input {...field('phone')} maxLength={20} /></label>
          <label className="field">{t('Email')}<input {...field('email')} type="email" maxLength={120} /></label>
          <label className="field full">{t('Address')}<input {...field('address')} maxLength={300} /></label>
          {!customer && can(user, 'customers.points') && (
            <label className="field">{t('Opening loyalty points')}<input {...field('loyaltyPoints')} type="number" min="0" step="1" /></label>
          )}
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
