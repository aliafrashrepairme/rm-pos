import { useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import { LABEL_SIZES, Label, MAX_COPIES, copiesOf, useLabelPrinter } from './labels.jsx';

// Prints labels for one product straight from a scan, for example right after it was added.
export default function PrintLabelModal({ product, title, onClose }) {
  const { t } = useI18n();
  const [size, setSize] = useState(LABEL_SIZES[0].key);
  const [copies, setCopies] = useState(1);
  const printer = useLabelPrinter();

  return (
    <Modal title={t(title || 'Print barcode label')} description={t('Check the label, choose the label size of your printer, then print.')} onClose={onClose}>
      <div className="quick-label">
        <div className={`label-grid ${size}`}><Label product={product} size={size} /></div>
      </div>
      <div className="toolbar quick-label-controls">
        <select className="filters" aria-label={t('Label size')} value={size} onChange={(event) => setSize(event.target.value)}>
          {LABEL_SIZES.map((option) => <option key={option.key} value={option.key}>{t(option.label)}</option>)}
        </select>
        <label className="field copies-field">{t('Copies')}
          <input className="mini-input" name="copies" type="number" min="1" max={MAX_COPIES} value={copies} onChange={(event) => setCopies(event.target.value)} />
        </label>
      </div>
      <div className="modal-actions-row">
        <button type="button" className="btn btn-outline" onClick={onClose}>{t('Close')}</button>
        <button type="button" className="btn btn-primary" onClick={() => printer.print(copiesOf(product, copies), size)}>⎙ {t('Print labels')}</button>
      </div>
      {printer.sheet}
    </Modal>
  );
}
