import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { can } from '../../app/access.js';
import { money, quantity } from '../../app/format.js';
import Pager from '../../components/Pager.jsx';
import Status from '../../components/Status.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import CategoriesModal from './CategoriesModal.jsx';
import ProductForm from './ProductForm.jsx';

const PAGE_SIZE = 25;
const SEARCH_DELAY_MS = 300;

function stockState(product) {
  if (product.stock <= 0) return 'Out of Stock';
  return product.stock <= product.minStock ? 'Low Stock' : 'In Stock';
}

function margin(product) {
  if (!product.sellingPrice) return '—';
  return `${Math.round(((product.sellingPrice - product.costPrice) / product.sellingPrice) * 100)}%`;
}

export default function ProductsPage({ user }) {
  const { t } = useI18n();
  const toast = useToast();
  const canManage = can(user, 'products.manage');
  const [options, setOptions] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(null);
  const [showCategories, setShowCategories] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(typed.trim());
      setPage(1);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  const loadOptions = useCallback(() => {
    api('/api/products/options').then(setOptions).catch((failure) => setError(failure.message));
  }, []);

  const loadProducts = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), status });
    if (search) params.set('q', search);
    if (categoryId) params.set('categoryId', categoryId);
    try {
      setResult(await api(`/api/products?${params}`));
      setError('');
    } catch (failure) {
      setError(failure.message);
    }
  }, [page, status, search, categoryId]);

  useEffect(loadOptions, [loadOptions]);
  useEffect(() => { loadProducts(); }, [loadProducts]);

  async function setActive(product, active) {
    try {
      await api(`/api/products/${product.id}`, { method: 'PATCH', body: JSON.stringify({ active }) });
      toast(`${product.name}: ${t(active ? 'Active' : 'Inactive')}`);
      loadProducts();
    } catch (failure) {
      toast(t(failure.message));
    }
  }

  const rows = result?.products ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Products')}</h1>
        </div>
        {canManage && (
          <div className="toolbar head-actions">
            <button type="button" className="btn btn-outline" onClick={() => setShowCategories(true)}>{t('Product categories')}</button>
            <button type="button" className="btn btn-primary" disabled={!options} onClick={() => setEditing({})}>＋ {t('Add product')}</button>
          </div>
        )}
      </div>

      <div className="table-toolbar">
        <div className="search">
          <span>⌕</span>
          <input
            aria-label={t('Search by product name, SKU or barcode…')}
            placeholder={t('Search by product name, SKU or barcode…')}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        <select className="filters" aria-label={t('Category')} value={categoryId} onChange={(event) => { setCategoryId(event.target.value); setPage(1); }}>
          <option value="">{t('All')}</option>
          {options?.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
        <select className="filters" aria-label={t('Status')} value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
          <option value="active">{t('Active')}</option>
          <option value="inactive">{t('Inactive')}</option>
          <option value="all">{t('All')}</option>
        </select>
      </div>

      {error && <p className="form-error" role="alert">{t(error)}</p>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {['SKU / Code', 'Product', 'Category', 'Barcode', 'Cost', 'Price', 'Margin', 'Stock', 'Status'].map((heading) => <th key={heading}>{t(heading)}</th>)}
              {canManage && <th>{t('Action')}</th>}
            </tr>
          </thead>
          <tbody>
            {result && rows.length === 0 && (
              <tr><td colSpan={canManage ? 10 : 9}><div className="empty">{t(search || categoryId ? 'No matching products.' : 'No products yet. Add your first product.')}</div></td></tr>
            )}
            {!result && !error && <tr><td colSpan={canManage ? 10 : 9}><div className="empty">{t('Loading…')}</div></td></tr>}
            {rows.map((product) => (
              <tr key={product.id} className={product.active ? '' : 'inactive-row'}>
                <td><b>{product.sku}</b></td>
                <td>
                  <span className="product-cell">
                    {product.imageUrl
                      ? <img className="product-photo" src={product.imageUrl} alt="" />
                      : <span className="product-photo placeholder" aria-hidden="true">▨</span>}
                    <b className="pname">{product.name}</b>
                  </span>
                </td>
                <td>{product.category}</td>
                <td><span className="muted mono">{product.barcode}</span></td>
                <td>{money(product.costPrice)}</td>
                <td>{money(product.sellingPrice)}</td>
                <td><b>{margin(product)}</b></td>
                <td>{quantity(product.stock)} <span className="muted">{t(product.unitCode)}</span></td>
                <td>{product.active ? <Status value={stockState(product)} label={t(stockState(product))} /> : <Status value="Inactive" label={t('Inactive')} />}</td>
                {canManage && (
                  <td>
                    <span className="table-actions">
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => setEditing(product)}>{t('Edit')}</button>{' '}
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => setActive(product, !product.active)}>{t(product.active ? 'Deactivate' : 'Reactivate')}</button>
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result && <Pager page={result.page} pageSize={result.pageSize} total={result.total} onPage={setPage} />}

      {editing && options && (
        <ProductForm
          product={editing.id ? editing : null}
          options={options}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            loadProducts();
          }}
        />
      )}
      {showCategories && (
        <CategoriesModal
          categories={options?.categories ?? []}
          onChanged={loadOptions}
          onClose={() => setShowCategories(false)}
        />
      )}
    </>
  );
}
