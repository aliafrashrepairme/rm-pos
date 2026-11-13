import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiFile } from '../../api.js';
import { dateTime } from '../../app/format.js';
import { useListRequest } from '../../app/useListRequest.js';
import Status from '../../components/Status.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import OrderModal from '../purchases/OrderModal.jsx';
import { preparePhoto } from './preparePhoto.js';
import ScanReview from './ScanReview.jsx';

const FEATURES = [
  ['🏷', 'Supplier & invoice details', 'Supplier name, invoice number and date'],
  ['📦', 'Line items', 'Description, quantity and unit cost'],
  ['🔗', 'Product matching', 'Suggests the closest product for you to confirm'],
  ['⚠', 'Checks', 'Hard-to-read values, repeated invoices, price changes and totals that differ']
];

function DocumentPreview({ scanId, mimeType, localUrl }) {
  const { t } = useI18n();
  const [url, setUrl] = useState(localUrl);
  const [error, setError] = useState('');

  useEffect(() => {
    if (localUrl) {
      setUrl(localUrl);
      return undefined;
    }
    let made;
    let current = true;
    setUrl(null);
    apiFile(`/api/invoice-scans/${scanId}/file`)
      .then((blob) => {
        if (!current) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch((failure) => { if (current) setError(failure.message); });
    return () => {
      current = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [scanId, localUrl]);

  if (error) return <p className="form-error" role="alert">{t(error)}</p>;
  if (!url) return <div className="empty">{t('Loading…')}</div>;
  if (mimeType === 'application/pdf') {
    return (
      <>
        <iframe className="scan-preview" title={t('Invoice document')} src={url} />
        <a className="btn btn-outline btn-sm scan-open" href={url} target="_blank" rel="noreferrer">{t('Open PDF')}</a>
      </>
    );
  }
  return <img className="scan-preview" src={url} alt={t('Invoice document')} />;
}

export default function AiScanPage({ user }) {
  const { t } = useI18n();
  const toast = useToast();
  const status = useListRequest('/api/invoice-scans/status');
  const history = useListRequest('/api/invoice-scans');
  const [options, setOptions] = useState(null);
  const [scan, setScan] = useState(null);
  const [uploading, setUploading] = useState(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [order, setOrder] = useState(null);
  const localUrl = useRef(null);
  const connected = status.data?.connected;

  const loadOptions = useCallback(async () => {
    setOptions(await api('/api/invoice-scans/options'));
  }, []);

  useEffect(() => { loadOptions().catch((failure) => setError(failure.message)); }, [loadOptions]);

  function clearLocal() {
    if (localUrl.current) URL.revokeObjectURL(localUrl.current);
    localUrl.current = null;
  }

  useEffect(() => clearLocal, []);

  function reset() {
    clearLocal();
    setScan(null);
    setUploading(null);
    setError('');
  }

  async function chooseFile(file) {
    if (!file) return;
    setError('');
    setScan(null);
    clearLocal();
    try {
      const prepared = await preparePhoto(file);
      localUrl.current = URL.createObjectURL(prepared);
      setUploading({ name: prepared.name, mimeType: prepared.type });
      const { scan: result } = await api(`/api/invoice-scans?name=${encodeURIComponent(prepared.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': prepared.type },
        body: prepared
      });
      setScan(result);
      history.reload();
      if (result.status === 'Extracted') toast(t('Invoice read. Please review it.'));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setUploading(null);
    }
  }

  async function openScan(id) {
    setError('');
    clearLocal();
    try {
      setScan((await api(`/api/invoice-scans/${id}`)).scan);
    } catch (failure) {
      setError(failure.message);
    }
  }

  async function retry() {
    setError('');
    setUploading({ name: scan.fileName, mimeType: scan.mimeType });
    try {
      setScan((await api(`/api/invoice-scans/${scan.id}/retry`, { method: 'POST' })).scan);
      history.reload();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setUploading(null);
    }
  }

  async function rejectFailed() {
    try {
      await api(`/api/invoice-scans/${scan.id}/reject`, { method: 'POST' });
      toast(t('Invoice rejected.'));
      history.reload();
      reset();
    } catch (failure) {
      setError(failure.message);
    }
  }

  const showingDocument = uploading || scan;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('AI invoice scan')}</h1>
          <p>{t('Upload or photograph a supplier invoice. It is read for you to review and approve.')}</p>
        </div>
        <div className="toolbar head-actions">
          {connected && <span className="ai-badge">✦ {t('AI POWERED')}</span>}
          {showingDocument && <button type="button" className="btn btn-outline" onClick={reset}>↺ {t('New scan')}</button>}
        </div>
      </div>

      {status.data && !connected && (
        <div className="card scan-section scan-off" role="status">
          <h3>{t('Invoice scanning is not connected')}</h3>
          <p className="sub">{t('No invoice can be read until the reading service is connected. Add ANTHROPIC_API_KEY to the server settings, then restart the server. Nothing on this screen is simulated.')}</p>
        </div>
      )}
      {error && <p className="form-error" role="alert">{t(error)}</p>}

      <div className="grid two-col scan-layout">
        <div className="card">
          <div className="section-row">
            <div>
              <h3>{t('Invoice document')}</h3>
              <div className="sub">{scan?.fileName ?? uploading?.name ?? t('JPG, PNG, WebP or PDF. A phone photo works too.')}</div>
            </div>
            {scan && <Status value={scan.status} label={t(scan.status)} />}
          </div>
          {!showingDocument && (
            <div
              className={`dropzone ${dragging ? 'drag' : ''}`}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => { event.preventDefault(); setDragging(false); if (connected) chooseFile(event.dataTransfer.files[0]); }}
            >
              <span className="big">🧾</span>
              <b>{t('Drop an invoice here')}</b>
              <p className="sub">{t('or choose a file')}</p>
              <label className={`btn btn-primary ${connected ? '' : 'disabled'}`}>
                ⇪ {t('Upload invoice')}
                <input name="invoiceFile" type="file" accept="image/*,application/pdf" hidden disabled={!connected} onChange={(event) => { chooseFile(event.target.files[0]); event.target.value = ''; }} />
              </label>
            </div>
          )}
          {showingDocument && <DocumentPreview scanId={scan?.id} mimeType={scan?.mimeType ?? uploading?.mimeType} localUrl={localUrl.current} />}
        </div>

        <div className="scan-panel">
          {!showingDocument && (
            <div className="card">
              <h3>{t('What gets read')}</h3>
              {FEATURES.map(([icon, title, note]) => (
                <div className="feature" key={title}><span className="kpi-icon">{icon}</span><span><strong>{t(title)}</strong><small>{t(note)}</small></span></div>
              ))}
              <p className="sub scan-note">{t('Invoice files are sent to Anthropic, the AI service, to be read.')}</p>
            </div>
          )}
          {uploading && (
            <div className="card" role="status">
              <h3>{t('Reading invoice…')}</h3>
              <div className="sub">{t('This can take up to a minute.')}</div>
            </div>
          )}
          {!uploading && scan?.status === 'Failed' && (
            <div className="card">
              <h3>{t('This invoice could not be read')}</h3>
              <p className="form-error" role="alert">{t(scan.error)}</p>
              <div className="modal-actions-row">
                <button type="button" className="btn btn-outline" onClick={rejectFailed}>{t('Reject')}</button>
                <button type="button" className="btn btn-primary" disabled={!connected} onClick={retry}>{t('Try again')}</button>
              </div>
            </div>
          )}
          {!uploading && scan?.status === 'Extracted' && options && (
            <ScanReview
              key={scan.id}
              scan={scan}
              options={options}
              onReload={loadOptions}
              onError={setError}
              onRejected={() => { toast(t('Invoice rejected.')); history.reload(); reset(); }}
              onApproved={({ scan: approved, purchaseId, poNo }) => {
                setError('');
                setScan(approved);
                history.reload();
                toast(`${poNo} · ${t('Ordered')}`);
                setOrder(purchaseId);
              }}
            />
          )}
          {!uploading && ['Approved', 'Rejected'].includes(scan?.status) && (
            <div className="card">
              <h3>{t(scan.status)}</h3>
              <p className="sub">{scan.invoiceNo}{scan.poNo && ` · ${scan.poNo}`}</p>
              {scan.purchaseId && <button type="button" className="btn btn-primary" onClick={() => setOrder(scan.purchaseId)}>{t('Open purchase order')}</button>}
            </div>
          )}
        </div>
      </div>

      <div className="card scan-history">
        <h3>{t('Recent scans')}</h3>
        <div className="table-wrap">
          <table>
            <thead><tr>{['File', 'Supplier', 'Invoice number', 'Read', 'Scanned', 'Status', ''].map((heading) => <th key={heading || 'open'}>{heading && t(heading)}</th>)}</tr></thead>
            <tbody>
              {history.data?.scans.length === 0 && <tr><td colSpan="7"><div className="empty">{t('No records found.')}</div></td></tr>}
              {history.data?.scans.map((row) => (
                <tr key={row.id}>
                  <td>{row.fileName}</td>
                  <td>{row.supplierText ?? '—'}</td>
                  <td>{row.invoiceNo ?? '—'}</td>
                  <td>{row.confidence === null ? '—' : `${Math.round(row.confidence)}%`}</td>
                  <td>{dateTime(row.createdAt)}</td>
                  <td><Status value={row.status} label={t(row.status)} /></td>
                  <td><button type="button" className="btn btn-outline btn-sm" onClick={() => openScan(row.id)}>{t('View')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {order && <OrderModal key={order} purchaseId={order} user={user} onClose={() => setOrder(null)} onChanged={() => {}} />}
    </>
  );
}
