import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import Modal from '../../components/Modal.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

export default function QuickProductModal({ line, supplierId, onClose, onCreated }) {
  const { t } = useI18n();
  const [options, setOptions] = useState(null);
  const [values, setValues] = useState({ name: line.description, categoryId: '', unitCode: 'Piece', sellingPrice: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const field = (name) => ({ name, value: values[name], onChange: (event) => setValues((current) => ({ ...current, [name]: event.target.value })) });

  useEffect(() => {
    api('/api/products/options').then(setOptions).catch((failure) => setError(failure.message));
  }, []);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { product } = await api('/api/products', {
        method: 'POST',
        body: JSON.stringify({
          ...values,
          costPrice: line.unitCost === '' ? 0 : line.unitCost,
          taxRateId: options.taxRates.find((rate) => rate.isDefault)?.id,
          preferredSupplierId: supplierId || null,
          openingStock: 0
        })
      });
      onCreated(product);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={t('Create new product')} description={t('It starts with no stock. Stock arrives when the order is received.')} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label className="field full">{t('Product name')}<input {...field('name')} maxLength={160} required autoFocus /></label>
          <label className="field">{t('Category')}
            <select {...field('categoryId')} required>
              <option value="">{t('Choose a category')}</option>
              {options?.categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="field">{t('Unit')}
            <select {...field('unitCode')}>{options?.units.map((code) => <option key={code} value={code}>{t(code)}</option>)}</select>
          </label>
          <label className="field">{t('Selling price')}<input {...field('sellingPrice')} type="number" min="0" step="0.01" required /></label>
        </div>
        {error && <p className="form-error modal-error" role="alert">{t(error)}</p>}
        <div className="modal-actions-row">
          <button type="button" className="btn btn-outline" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !options}>{t('Save record')}</button>
        </div>
      </form>
    </Modal>
  );
}
