import { useState } from 'react';
import { api } from '../../api.js';
import Modal from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function initialValues(product, options) {
  if (product) {
    return {
      name: product.name,
      description: product.description,
      categoryId: product.categoryId,
      unitCode: product.unitCode,
      taxRateId: product.taxRateId,
      costPrice: String(product.costPrice),
      sellingPrice: String(product.sellingPrice),
      minStock: String(product.minStock),
      location: product.location,
      preferredSupplierId: product.preferredSupplierId ?? '',
      sku: product.sku,
      barcode: product.barcode ?? ''
    };
  }
  return {
    name: '',
    description: '',
    categoryId: options.categories.find((category) => category.active)?.id ?? '',
    unitCode: options.units[0] ?? '',
    taxRateId: options.taxRates.find((rate) => rate.isDefault)?.id ?? options.taxRates[0]?.id ?? '',
    costPrice: '',
    sellingPrice: '',
    openingStock: '0',
    minStock: '10',
    location: '',
    preferredSupplierId: '',
    sku: '',
    barcode: ''
  };
}

export default function ProductForm({ product, options, onClose, onSaved }) {
  const { t } = useI18n();
  const toast = useToast();
  const [values, setValues] = useState(() => initialValues(product, options));
  const [photo, setPhoto] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const field = (name) => ({
    name,
    value: values[name],
    onChange: (event) => setValues((current) => ({ ...current, [name]: event.target.value }))
  });

  function choosePhoto(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) {
      setError('Choose a JPG, PNG or WebP image.');
    } else if (file.size > MAX_IMAGE_BYTES) {
      setError('The photo must be 2 MB or smaller.');
    } else {
      setError('');
      setPhoto(file);
    }
  }

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { product: saved } = await api(product ? `/api/products/${product.id}` : '/api/products', {
        method: product ? 'PATCH' : 'POST',
        body: JSON.stringify(values)
      });
      if (photo) {
        try {
          await api(`/api/products/${saved.id}/image`, { method: 'PUT', headers: { 'Content-Type': photo.type }, body: photo });
        } catch (failure) {
          // The details are saved, so say what didn't happen rather than reporting a failed save.
          toast(`${saved.sku}: ${t(failure.message)}`);
          onSaved();
          return;
        }
      }
      toast(`${t(product ? 'Product updated.' : 'Product added.')} ${saved.sku}`);
      onSaved();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  const activeCategories = options.categories.filter((category) => category.active || category.id === values.categoryId);

  return (
    <Modal
      wide
      title={t(product ? 'Edit product' : 'Add product')}
      description={t(product ? 'Stock changes go through Stock Adjustments.' : 'Leave SKU and barcode blank to generate them automatically.')}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="modal-scroll">
          <div className="form-grid">
            <label className="field full">{t('Product name')}<input {...field('name')} required maxLength={200} autoFocus /></label>
            <label className="field">{t('Category')}
              <select {...field('categoryId')} required>
                {activeCategories.length === 0 && <option value="">{t('Add a category first')}</option>}
                {activeCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select>
            </label>
            <label className="field">{t('Unit')}
              <select {...field('unitCode')} required>
                {options.units.map((unit) => <option key={unit} value={unit}>{t(unit)}</option>)}
              </select>
            </label>
            <label className="field">{t('Cost price (LKR)')}<input {...field('costPrice')} type="number" min="0" step="0.01" required /></label>
            <label className="field">{t('Selling price (LKR)')}<input {...field('sellingPrice')} type="number" min="0" step="0.01" required /></label>
            <label className="field">{t('Tax')}
              <select {...field('taxRateId')} required>
                {options.taxRates.map((rate) => <option key={rate.id} value={rate.id}>{rate.name} ({rate.rate}%)</option>)}
              </select>
            </label>
            {!product && <label className="field">{t('Opening stock')}<input {...field('openingStock')} type="number" min="0" step="any" /></label>}
            <label className="field">{t('Reorder level')}<input {...field('minStock')} type="number" min="0" step="any" /></label>
            <label className="field">{t('Location')}<input {...field('location')} maxLength={100} /></label>
            <label className="field">{t('Preferred supplier')}
              <select {...field('preferredSupplierId')}>
                <option value="">—</option>
                {options.suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
              </select>
            </label>
            <label className="field">{t('SKU')}<input {...field('sku')} required={Boolean(product)} maxLength={40} /></label>
            <label className="field">{t('Barcode')}<input {...field('barcode')} required={Boolean(product)} maxLength={32} /></label>
            <label className="field full">{t('Description')}<textarea {...field('description')} rows="2" maxLength={2000} /></label>
            <div className="field full">
              {t('Product photo (optional)')}
              <div className="photo-row">
                {product?.imageUrl && !photo && <img className="product-photo large" src={product.imageUrl} alt="" />}
                <input type="file" aria-label={t('Product photo (optional)')} accept={IMAGE_TYPES.join(',')} onChange={choosePhoto} />
              </div>
            </div>
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
