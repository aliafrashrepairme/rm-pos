import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useDebounced, useListRequest } from '../../app/useListRequest.js';
import Pager from '../../components/Pager.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import { LABEL_SIZES as SIZES, Label, MAX_COPIES, copiesOf, useLabelPrinter } from './labels.jsx';

export default function LabelsTab() {
  const { t } = useI18n();
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const search = useDebounced(typed);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState({});
  const [copies, setCopies] = useState(1);
  const [size, setSize] = useState(SIZES[0].key);
  const printer = useLabelPrinter();

  useEffect(() => { setPage(1); }, [search]);
  const params = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (search) params.set('q', search);
  const { data, error, reload } = useListRequest(`/api/products?${params}`);

  // Products saved without a barcode can't be labelled until one is generated for them.
  const [missing, setMissing] = useState(0);
  const [generating, setGenerating] = useState(false);
  const countMissing = () => api('/api/barcode/missing').then(({ count }) => setMissing(count)).catch(() => {});
  useEffect(() => { countMissing(); }, []);

  async function generateMissing() {
    setGenerating(true);
    try {
      const { generated } = await api('/api/barcode/generate-missing', { method: 'POST' });
      toast(t('Barcodes generated for {n} products.').replace('{n}', generated));
      await countMissing();
      reload();
    } catch (failure) {
      toast(t(failure.message));
    } finally {
      setGenerating(false);
    }
  }

  const chosen = Object.values(selected);
  const labels = chosen.flatMap((product) => copiesOf(product, copies));

  function toggle(product) {
    setSelected((current) => {
      const next = { ...current };
      if (next[product.id]) delete next[product.id];
      else next[product.id] = product;
      return next;
    });
  }

  async function print() {
    if (!labels.length) {
      toast(t('Select at least one product.'));
      return;
    }
    printer.print(labels, size);
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
      {missing > 0 && (
        <div className="light-note barcode-missing">
          <span>{t('{n} products have no barcode yet. Products that already have one keep it.').replace('{n}', missing)}</span>
          <button type="button" className="btn btn-primary btn-sm" disabled={generating} onClick={generateMissing}>{generating ? t('Generating…') : t('Generate missing barcodes')}</button>
        </div>
      )}
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <div className="seg label-picker">
        {data?.products.length === 0 && <div className="empty">{t('No matching products.')}</div>}
        {data?.products.map((product) => (
          <button type="button" key={product.id} disabled={!product.barcode} className={selected[product.id] ? 'active' : ''} onClick={() => toggle(product)}>
            {selected[product.id] ? '✓ ' : ''}{product.name}{!product.barcode && ` · ${t('no barcode')}`}
          </button>
        ))}
      </div>
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      <h3 className="dash-gap">{t('Preview')} · {labels.length}</h3>
      {labels.length === 0
        ? <div className="empty"><span>🏷</span>{t('Select at least one product.')}</div>
        : <div className={`label-grid ${size}`}>{labels.map(({ product, key }) => <Label key={key} product={product} size={size} />)}</div>}
      {printer.sheet}
    </div>
  );
}
