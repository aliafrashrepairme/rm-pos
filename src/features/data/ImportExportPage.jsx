import { useState } from 'react';
import { api, apiFile } from '../../api.js';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import { saveFile } from './saveFile.js';

const IMPORT_TYPES = { products: 'Products', customers: 'Customers', suppliers: 'Suppliers' };
const EXPORTS = [
  ['products', 'Product master', 'SKU, barcode, cost, price, tax and stock', false],
  ['bills', 'Bills register', 'Bill totals and statuses', true],
  ['ledger', 'Inventory ledger', 'Stock movement history', true],
  ['valuation', 'Stock valuation', 'Value at cost and retail', false]
];

export default function ImportExportPage() {
  const { t } = useI18n();
  const toast = useToast();
  const [type, setType] = useState('products');
  const [file, setFile] = useState(null);
  const [text, setText] = useState('');
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [fileKey, setFileKey] = useState(0);

  function clearFile() {
    setFile(null);
    setText('');
    setReport(null);
    setError('');
    setFileKey((current) => current + 1);
  }

  async function chooseFile(chosen) {
    setReport(null);
    setError('');
    setFile(chosen ?? null);
    setText(chosen ? await chosen.text() : '');
  }

  async function validate() {
    setBusy(true);
    setError('');
    setReport(null);
    try {
      setReport(await api(`/api/data/import/${type}/validate`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text }));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    setBusy(true);
    setError('');
    try {
      const { imported } = await api(`/api/data/import/${type}`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text });
      toast(`${imported} ${t('records imported.')}`);
      clearFile();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function download(path, name) {
    try {
      saveFile(await apiFile(path), name);
    } catch (failure) {
      toast(t(failure.message));
    }
  }

  const dates = from && to ? `?from=${from}&to=${to}` : '';
  const badRows = report?.rows.filter((row) => row.errors.length) ?? [];
  const canImport = report && report.errorCount === 0;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Import / Export')}</h1>
          <p>{t('Import and export product, customer and store records.')}</p>
        </div>
      </div>
      <div className="grid two-col data-layout">
        <div className="card">
          <h3>{t('Import data')}</h3>
          <p className="sub">{t('Select a CSV file to validate for import. Nothing is saved until you import it, and a file with any error saves nothing.')}</p>
          <label className="field settings-field">{t('Data type')}
            <select name="importType" value={type} onChange={(event) => { setType(event.target.value); clearFile(); }}>
              {Object.entries(IMPORT_TYPES).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
            </select>
          </label>
          <button type="button" className="btn btn-outline btn-sm settings-field" onClick={() => download(`/api/data/import/${type}/template`, `rm-${type}-template.csv`)}>⇩ {t('Download template')}</button>
          <label className="field settings-field">{t('CSV file')}
            <input key={fileKey} name="csvFile" type="file" accept=".csv,text/csv" onChange={(event) => chooseFile(event.target.files[0])} />
          </label>
          {error && <p className="form-error" role="alert">{t(error)}</p>}
          <div className="modal-actions-row">
            <button type="button" className="btn btn-outline" disabled={!file || busy} onClick={validate}>{t('Validate CSV')}</button>
            <button type="button" className="btn btn-primary" disabled={!canImport || busy} onClick={runImport}>{canImport ? `${t('Import')} ${report.total} ${t('rows')}` : t('Import')}</button>
          </div>
        </div>

        <div className="card">
          <h3>{t('Export records')}</h3>
          <div className="form-grid">
            <label className="field">{t('Start date')}<input name="exportFrom" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
            <label className="field">{t('End date')}<input name="exportTo" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          </div>
          <p className="sub">{t('Dates apply to bills and the ledger. Leave them empty for everything.')}</p>
          {EXPORTS.map(([kind, title, note, dated]) => (
            <div className="setting-line" key={kind}>
              <span><strong>{t(title)}</strong><small>{t(note)}</small></span>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => download(`/api/data/export/${kind}${dated ? dates : ''}`, `rm-${kind}.csv`)}>{t('Export CSV')}</button>
            </div>
          ))}
        </div>
      </div>

      {report && (
        <div className="card data-report">
          <div className="section-row">
            <h3>{t('Validation result')}</h3>
            <span className={`chip ${report.errorCount ? '' : 'green'}`}>{report.errorCount ? `${report.errorCount} ${t('with errors')}` : `✓ ${report.total} ${t('rows ready')}`}</span>
          </div>
          {report.fileErrors.map((message) => <p className="form-error" role="alert" key={message}>{t(message)}</p>)}
          {badRows.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead><tr>{['Line', 'Name', 'Problems'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr></thead>
                <tbody>
                  {badRows.map((row) => (
                    <tr key={row.line}>
                      <td>{row.line}</td>
                      <td>{row.name || '—'}</td>
                      <td>{row.errors.map((message) => <div className="qty-down" key={message}>{message}</div>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {report.errorCount > 0 && <p className="sub">{t('Fix these in your file and choose it again. Nothing has been saved.')}</p>}
        </div>
      )}
    </>
  );
}
