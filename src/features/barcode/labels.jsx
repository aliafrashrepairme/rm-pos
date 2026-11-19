import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api.js';
import { money } from '../../app/format.js';
import { useStoreLogo } from '../../app/storeLogo.js';
import BarcodeImage from '../../components/BarcodeImage.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

// Label sizes the shop's printers take. `page` sets the printed page to exactly one label,
// so a label printer neither shrinks the label nor leaves a margin. `barcodeMm` is the width a barcode may use.
export const LABEL_SIZES = [
  { key: 'roll-50', label: '50×25 mm roll', page: '50mm 25mm', barcodeMm: 48 },
  { key: 'roll-38', label: '38×25 mm roll', page: '38mm 25mm', barcodeMm: 36 },
  { key: 'sheet', label: 'A4 sheet (3 across)', page: 'A4', barcodeMm: 60 }
];
export const MAX_COPIES = 50;

// The store name and phone for the label header, fetched once and shared by every label.
let storeInfo = null;
let storeRequest = null;
function useLabelStore() {
  const [store, setStore] = useState(storeInfo);
  useEffect(() => {
    if (storeInfo) return undefined;
    let current = true;
    storeRequest ||= api('/api/barcode/label-store').then(({ store: found }) => { storeInfo = found; return found; }).catch(() => null);
    storeRequest.then((found) => { if (current && found) setStore(found); });
    return () => { current = false; };
  }, []);
  return store;
}

// dd/mm/yyyy, the way dates are written in Sri Lanka.
export function labelDate(date = new Date()) {
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
}

// One shelf or product label: the store's logo and name, the product name, a scannable barcode with its digits,
// price per unit, and the SKU, store phone and the date the label was printed.
export function Label({ product, size }) {
  const { t } = useI18n();
  const logo = useStoreLogo();
  const store = useLabelStore();
  const unit = product.unitCode || product.unit;
  const { barcodeMm } = LABEL_SIZES.find((option) => option.key === size) ?? LABEL_SIZES[0];
  const small = size === 'roll-38';
  return (
    <div className={`bc-label ${size}`}>
      <div className="lhead">
        {logo ? <img className="llogo" src={logo} alt="" /> : <span className="llogo-mark">RM</span>}
        <span className="lstore">{store?.name || 'RM Hardware Store'}</span>
      </div>
      <b className="pname">{product.name}</b>
      <BarcodeImage code={product.barcode} printWidthMm={barcodeMm} />
      <div className="lp">{money(product.sellingPrice ?? product.price)}{unit ? <span className="lu"> / {t(unit)}</span> : null}</div>
      <div className="lfoot">
        {!small && product.sku && <span>{product.sku}</span>}
        {!small && store?.phone && <span>☎ {store.phone}</span>}
        <span>{labelDate()}</span>
      </div>
    </div>
  );
}

// Prints labels on their own page size, records the print in the audit log, then tidies up.
export function useLabelPrinter() {
  const [job, setJob] = useState(null);

  useEffect(() => {
    if (!job) return undefined;
    const page = document.createElement('style');
    const size = LABEL_SIZES.find((option) => option.key === job.size) ?? LABEL_SIZES[0];
    page.textContent = `@media print { @page { size: ${size.page}; margin: ${size.key === 'sheet' ? '8mm' : '0'}; } }`;
    document.head.append(page);
    const finish = () => {
      document.body.classList.remove('print-labels');
      page.remove();
      setJob(null);
    };
    document.body.classList.add('print-labels');
    window.addEventListener('afterprint', finish);
    // In the desktop app, labels go to the label printer chosen in Printers.
    if (window.rmpos?.print) window.rmpos.print(undefined, 'label').catch(() => {}).finally(finish);
    else window.print();
    return () => {
      window.removeEventListener('afterprint', finish);
      document.body.classList.remove('print-labels');
      page.remove();
    };
  }, [job]);

  async function print(labels, size) {
    try {
      await api('/api/barcode/labels-printed', { method: 'POST', body: JSON.stringify({ labels: labels.length }) });
    } catch (failure) {
      console.error('Could not record printed labels:', failure.message);
    }
    setJob({ labels, size });
  }

  const sheet = job && createPortal(
    <div id="printArea" className={`print-${job.size}`}>
      <div className={`label-grid ${job.size}`}>{job.labels.map(({ product, key }) => <Label key={key} product={product} size={job.size} />)}</div>
    </div>,
    document.body
  );

  return { print, sheet };
}

export const copiesOf = (product, copies) => {
  const count = Math.min(Math.max(Math.trunc(Number(copies)) || 1, 1), MAX_COPIES);
  return Array.from({ length: count }, (_, index) => ({ product, key: `${product.id}-${index}` }));
};
