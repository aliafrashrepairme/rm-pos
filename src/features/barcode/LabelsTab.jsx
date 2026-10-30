import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api.js';
import { money } from '../../app/format.js';
import { useDebounced, useListRequest } from '../../app/useListRequest.js';
import BarcodeImage from '../../components/BarcodeImage.jsx';
import Pager from '../../components/Pager.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

const SIZES = [
  { key: 'roll-50', label: '50×25 mm roll' },
  { key: 'roll-38', label: '38×25 mm roll' },
  { key: 'sheet', label: 'A4 sheet (3 across)' }
];
const MAX_COPIES = 50;

function Label({ product, size }) {
  return (
    <div className={`bc-label ${size}`}>
      <b className="pname">{product.name}</b>
      <BarcodeImage code={product.barcode} height={44} />
      <div className="lp">{money(product.sellingPrice)}</div>
    </div>
  );
}

export default function LabelsTab() {
  const { t } = useI18n();
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const search = useDebounced(typed);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState({});
  const [copies, setCopies] = useState(1);
  const [size, setSize] = useState(SIZES[0].key);
  const [printing, setPrinting] = useState(false);

  useEffect(() => { setPage(1); }, [search]);
  const params = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (search) params.set('q', search);
  const { data, error } = useListRequest(`/api/products?${params}`);

  const chosen = Object.values(selected);
  const copyCount = Math.min(Math.max(Math.trunc(Number(copies)) || 1, 1), MAX_COPIES);
  const labels = chosen.flatMap((product) => Array.from({ length: copyCount }, (_, index) => ({ product, key: `${product.id}-${index}` })));

  function toggle(product) {
    setSelected((current) => {
      const next = { ...current };
      if (next[product.id]) delete next[product.id];
      else next[product.id] = product;
      return next;
    });
  }

  useEffect(() => {
    if (!printing) return undefined;
    const finish = () => {
      document.body.classList.remove('print-labels');
      setPrinting(false);
    };
    document.body.classList.add('print-labels');
    window.addEventListener('afterprint', finish);
    window.print();
    return () => {
      window.removeEventListener('afterprint', finish);
      document.body.classList.remove('print-labels');
    };
  }, [printing]);

  async function print() {
    if (!labels.length) {
      toast(t('Select at least one product.'));
      return;
    }
    try {
      await api('/api/barcode/labels-printed', { method: 'POST', body: JSON.stringify({ labels: labels.length }) });
    } catch (failure) {
      console.error('Could not record printed labels:', failure.message);
    }
    setPrinting(true);
  }

  return (
    <div className="card">
      <div className="section-row">
        <div>
          <h3>{t('Generate & print barcode labels')}</h3>
          <div className="sub">{t('Select products, choose a size, then print.')}</div>
        </div>
        <div className="toolbar head-actions">
          <select className="filters" aria-label={t('Label size')} value={size} onChange={(event) => setSize(event.target.value)}>
            {SIZES.map((option) => <option key={option.key} value={option.key}>{t(option.label)}</option>)}
          </select>
          <label className="field copies-field">{t('Copies')}
            <input className="mini-input" name="copies" type="number" min="1" max={MAX_COPIES} value={copies} onChange={(event) => setCopies(event.target.value)} />
          </label>
          <button type="button" className="btn btn-outline btn-sm" disabled={!chosen.length} onClick={() => setSelected({})}>{t('Clear')}</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={print}>⎙ {t('Print labels')}</button>
        </div>
      </div>
      <div className="table-toolbar">
        <div className="search">
          <span>⌕</span>
          <input aria-label={t('Search by product name, SKU or barcode…')} placeholder={t('Search by product name, SKU or barcode…')} value={typed} onChange={(event) => setTyped(event.target.value)} />
        </div>
      </div>
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <div className="seg label-picker">
        {data?.products.length === 0 && <div className="empty">{t('No matching products.')}</div>}
        {data?.products.map((product) => (
          <button type="button" key={product.id} disabled={!product.barcode} className={selected[product.id] ? 'active' : ''} onClick={() => toggle(product)}>
            {selected[product.id] ? '✓ ' : ''}{product.name}
          </button>
        ))}
      </div>
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      <h3 className="dash-gap">{t('Preview')} · {labels.length}</h3>
      {labels.length === 0
        ? <div className="empty"><span>🏷</span>{t('Select at least one product.')}</div>
        : <div className={`label-grid ${size}`}>{labels.map(({ product, key }) => <Label key={key} product={product} size={size} />)}</div>}
      {printing && createPortal(
        <div id="printArea" className={`print-${size}`}>
          <div className={`label-grid ${size}`}>{labels.map(({ product, key }) => <Label key={key} product={product} size={size} />)}</div>
        </div>,
        document.body
      )}
    </div>
  );
}
