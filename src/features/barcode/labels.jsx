import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api.js';
import { money } from '../../app/format.js';
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

// One shelf or product label: name, scannable barcode with its digits, price per unit, SKU.
export function Label({ product, size }) {
  const { t } = useI18n();
  const unit = product.unitCode || product.unit;
  const { barcodeMm } = LABEL_SIZES.find((option) => option.key === size) ?? LABEL_SIZES[0];
  return (
    <div className={`bc-label ${size}`}>
      <b className="pname">{product.name}</b>
      <BarcodeImage code={product.barcode} printWidthMm={barcodeMm} />
      <div className="lp">{money(product.sellingPrice ?? product.price)}{unit ? <span className="lu"> / {t(unit)}</span> : null}</div>
      {size !== 'roll-38' && product.sku && <div className="lsku">{product.sku}</div>}
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
    window.print();
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
