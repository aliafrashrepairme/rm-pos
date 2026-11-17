import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { money, quantity } from '../../app/format.js';
import { useDebounced, useListRequest } from '../../app/useListRequest.js';
import Pager from '../../components/Pager.jsx';
import Status from '../../components/Status.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

function stateOf(row) {
  if (row.stock <= 0) return 'Out of Stock';
  return row.stock <= row.minStock ? 'Low Stock' : 'In Stock';
}

export default function StockTab() {
  const { t } = useI18n();
  const [typed, setTyped] = useState('');
  const search = useDebounced(typed);
  const [state, setState] = useState('all');
  const [categoryId, setCategoryId] = useState('');
  const [page, setPage] = useState(1);
  const [categories, setCategories] = useState([]);

  useEffect(() => { setPage(1); }, [search, state, categoryId]);
  useEffect(() => {
    api('/api/products/options').then((options) => setCategories(options.categories)).catch(() => setCategories([]));
  }, []);

  const params = new URLSearchParams({ page: String(page), state });
  if (search) params.set('q', search);
  if (categoryId) params.set('categoryId', categoryId);
  const { data, error } = useListRequest(`/api/inventory/stock?${params}`);

  return (
    <>
      <div className="table-toolbar">
        <div className="search">
          <span>⌕</span>
          <input aria-label={t('Search by product name, SKU or barcode…')} placeholder={t('Search by product name, SKU or barcode…')} value={typed} onChange={(event) => setTyped(event.target.value)} />
        </div>
        <select className="filters" aria-label={t('Category')} value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
          <option value="">{t('All')}</option>
          {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
        <select className="filters" aria-label={t('Status')} value={state} onChange={(event) => setState(event.target.value)}>
          <option value="all">{t('All')}</option>
          <option value="in">{t('In Stock')}</option>
          <option value="low">{t('Low Stock')}</option>
          <option value="out">{t('Out of Stock')}</option>
        </select>
      </div>
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>{['Product', 'Category', 'Location', 'On hand', 'Reorder level', 'Value (cost)', 'Supplier', 'Status'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr>
          </thead>
          <tbody>
            {!data && !error && <tr><td colSpan="8"><div className="empty">{t('Loading…')}</div></td></tr>}
            {data?.products.length === 0 && <tr><td colSpan="8"><div className="empty">{t('No records found.')}</div></td></tr>}
            {data?.products.map((row) => (
              <tr key={row.id}>
                <td><b className="pname">{row.name}</b><br /><span className="muted small-note">{row.sku}</span></td>
                <td>{row.category}</td>
                <td>{row.location}</td>
                <td><b>{quantity(row.stock)}</b> <span className="muted">{t(row.unit)}</span></td>
                <td>{quantity(row.minStock)}</td>
                <td>{money(row.value)}</td>
                <td>{row.supplier}</td>
                <td><Status value={stateOf(row)} label={t(stateOf(row))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
    </>
  );
}
