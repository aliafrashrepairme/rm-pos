import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useToast } from '../../components/Toast.jsx';
import { usePrintDocument } from '../../components/usePrintDocument.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

const ROLES = [
  { role: 'receipt', title: 'Receipt printer', hint: 'Customer bills from POS and the Bills Register.', size: 'receipt', className: 'print-receipt' },
  { role: 'label', title: 'Barcode label printer', hint: 'Barcode and shelf labels.', size: undefined, className: 'print-labels-test' },
  { role: 'document', title: 'Document printer', hint: 'A4 and A5 pages: purchase bills, quotations, shift and other reports.', size: 'a5', className: 'print-report' }
];

// Chooses the printers on this computer. Each till can have its own, so the choice is saved on the computer.
export default function PrintersPage() {
  const { t } = useI18n();
  const toast = useToast();
  const desktop = Boolean(window.rmpos?.listPrinters);
  const [printers, setPrinters] = useState(null);
  const [settings, setSettings] = useState(null);
  const [saved, setSaved] = useState(null);
  const [computer, setComputer] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { printArea, startPrint } = usePrintDocument();

  async function load() {
    setError('');
    try {
      const [list, current, name] = await Promise.all([window.rmpos.listPrinters(), window.rmpos.getPrinterSettings(), window.rmpos.getComputerName?.()]);
      setPrinters(list);
      setSettings(current);
      setSaved(current);
      setComputer(name ?? '');
    } catch (failure) {
      setError(failure.message);
    }
  }
  useEffect(() => { if (desktop) load(); }, [desktop]); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (role, field, value) => setSettings((current) => ({ ...current, [role]: { ...current[role], [field]: value } }));
  const dirty = settings && saved && JSON.stringify(settings) !== JSON.stringify(saved);

  async function save() {
    setError('');
    setBusy(true);
    try {
      const result = await window.rmpos.savePrinterSettings(settings);
      const changes = ROLES.filter(({ role }) => JSON.stringify(result[role]) !== JSON.stringify(saved[role]))
        .map(({ role }) => ({ role, printer: result[role].deviceName, silent: result[role].silent }));
      setSettings(result);
      setSaved(result);
      if (changes.length) api('/api/printers/changed', { method: 'POST', body: JSON.stringify({ computer, changes }) }).catch(() => {});
      toast(t('Printers saved for this computer.'));
    } catch (failure) {
      setError(failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setBusy(false);
    }
  }

  function testPrint({ role, title, size, className }) {
    if (dirty) {
      toast(t('Save your changes first, then print a test page.'));
      return;
    }
    const now = new Date().toLocaleString('en-GB');
    startPrint({
      kind: 'print',
      printer: role,
      size,
      className,
      fileName: 'printer-test.pdf',
      content: (
        <div className="printer-test">
          <b>RM POS</b>
          <div>{t(title)}</div>
          <div>{settings[role].deviceName || t('Windows default printer')}</div>
          <div>{computer}</div>
          <div>{now}</div>
          <div>✓ {t('If you can read this, the printer works.')}</div>
        </div>
      )
    });
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Printers')}</h1>
          <p>{t('Choose which printer this computer uses for receipts, barcode labels and documents.')}</p>
        </div>
        {desktop && <div className="toolbar head-actions"><button type="button" className="btn btn-outline" onClick={load}>↻ {t('Find printers again')}</button></div>}
      </div>

      {!desktop && <div className="light-note">{t('Printers can only be set up in the RM POS desktop app, on the computer the printers are connected to.')}</div>}
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      {desktop && computer && <p className="muted small-note">{t('Settings for this computer')}: <b>{computer}</b>. {t('Set up each till on its own computer.')}</p>}

      {desktop && settings && printers && (
        <>
          {printers.length === 0 && <div className="light-note">{t('No printers are installed on this computer. Install the printer in Windows, then press Find printers again.')}</div>}
          <div className="printer-grid">
            {ROLES.map((item) => {
              const choice = settings[item.role];
              const missing = choice.deviceName && !printers.some((printer) => printer.name === choice.deviceName);
              return (
                <div className="card printer-card" key={item.role}>
                  <h3>{t(item.title)}</h3>
                  <p className="sub">{t(item.hint)}</p>
                  <label className="field">{t('Printer')}
                    <select value={choice.deviceName} onChange={(event) => change(item.role, 'deviceName', event.target.value)}>
                      <option value="">{t('Windows default printer')}</option>
                      {missing && <option value={choice.deviceName}>{choice.deviceName} ({t('not connected')})</option>}
                      {printers.map((printer) => <option key={printer.name} value={printer.name}>{printer.displayName}{printer.isDefault ? ` · ${t('default')}` : ''}</option>)}
                    </select>
                  </label>
                  {missing && <p className="form-error">{t('This printer is not connected. Windows will choose one until it is back.')}</p>}
                  <label className="list-check">
                    <input type="checkbox" checked={choice.silent} disabled={!choice.deviceName} onChange={(event) => change(item.role, 'silent', event.target.checked)} />
                    {t('Print straight away, without the print dialog')}
                  </label>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => testPrint(item)}>⎙ {t('Print test page')}</button>
                </div>
              );
            })}
          </div>
          <div className="modal-actions-row">
            {dirty && <button type="button" className="btn btn-outline" onClick={() => setSettings(saved)}>{t('Undo changes')}</button>}
            <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={save}>{t('Save printers')}</button>
          </div>
        </>
      )}
      {printArea}
    </>
  );
}
