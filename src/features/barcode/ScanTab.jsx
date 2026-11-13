import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { can } from '../../app/access.js';
import { createDuplicateFilter, createScannerBuffer } from '../../app/barcode.js';
import { money, quantity } from '../../app/format.js';
import BarcodeImage from '../../components/BarcodeImage.jsx';
import Status from '../../components/Status.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import { decodePhoto, startCamera } from './cameraScan.js';

const HISTORY_LENGTH = 8;

function stateOf(product) {
  if (!product.active) return 'Inactive';
  if (product.stock <= 0) return 'Out of Stock';
  return product.stock <= product.minStock ? 'Low Stock' : 'In Stock';
}

let audioContext;
function beep() {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = 1400;
    gain.gain.value = 0.05;
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.08);
  } catch {
    // A missing sound never stops a scan.
  }
}

function ScanResult({ result }) {
  const { t } = useI18n();
  if (!result) return <div className="empty"><span>⌸</span>{t('Scan a product to see its details.')}</div>;
  if (result.error) {
    return (
      <div className="scan-problem" role="alert">
        <b>{t(result.unknown ? 'Unknown barcode' : 'Could not read this code')}</b>
        <p>{t(result.error)}</p>
      </div>
    );
  }
  const { product } = result;
  const state = stateOf(product);
  return (
    <>
      <div className="section-row"><h3>{t('Last scanned')}</h3><Status value={state} label={t(state)} /></div>
      <div className="scan-product">
        {product.imageUrl
          ? <img className="product-photo large" src={product.imageUrl} alt="" />
          : <span className="product-photo large placeholder" aria-hidden="true">▨</span>}
        <div>
          <div className="scan-name">{product.name}</div>
          <div className="sub">{[product.category, product.location, product.sku].filter(Boolean).join(' · ')}</div>
          <div className="scan-figures">
            <span><span className="sub">{t('Price')}</span><br /><b>{money(product.sellingPrice)}</b></span>
            <span><span className="sub">{t('On hand')}</span><br /><b>{quantity(product.stock)} {t(product.unitCode)}</b></span>
            <span><span className="sub">{t('Reorder at')}</span><br /><b>{quantity(product.minStock)}</b></span>
          </div>
        </div>
      </div>
      {product.barcode && <div className="barcode-box"><BarcodeImage code={product.barcode} /></div>}
      {result.counted !== undefined && <p className="notice">{t('Counted')}: <b>{quantity(result.counted)}</b></p>}
    </>
  );
}

export default function ScanTab({ user }) {
  const { t } = useI18n();
  const toast = useToast();
  const canCount = can(user, 'counts.manage');
  const [mode, setMode] = useState('lookup');
  const [counts, setCounts] = useState([]);
  const [countId, setCountId] = useState('');
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const videoRef = useRef(null);
  const stopCameraRef = useRef(null);
  const isNewFromCamera = useMemo(() => createDuplicateFilter(), []);
  const feedScanner = useMemo(() => createScannerBuffer(), []);

  useEffect(() => {
    if (!canCount) return;
    api('/api/inventory/counts?pageSize=100')
      .then(({ counts: rows }) => {
        const open = rows.filter((row) => row.status === 'In Progress');
        setCounts(open);
        setCountId((current) => current || open[0]?.id || '');
      })
      .catch(() => setCounts([]));
  }, [canCount]);

  const modeRef = useRef(mode);
  const countRef = useRef(countId);
  modeRef.current = mode;
  countRef.current = countId;

  const handleCode = useCallback(async (rawCode) => {
    const code = rawCode.trim();
    if (!code) return;
    const addHistory = (name, outcome, ok) => setHistory((current) => [
      { id: `${Date.now()}-${Math.random()}`, code, name, outcome, ok, time: new Date().toLocaleTimeString() },
      ...current
    ].slice(0, HISTORY_LENGTH));
    try {
      const { product } = await api(`/api/barcode/lookup?code=${encodeURIComponent(code)}`);
      if (modeRef.current === 'count') {
        if (!countRef.current) throw Object.assign(new Error('Start a stock count first.'), {});
        const scan = await api(`/api/inventory/counts/${countRef.current}/scan`, { method: 'POST', body: JSON.stringify({ code }) });
        setResult({ product, counted: scan.counted });
        addHistory(product.name, `${t('Counted')} ${quantity(scan.counted)}`, true);
      } else {
        setResult({ product });
        addHistory(product.name, t('Found'), true);
      }
      beep();
    } catch (failure) {
      const unknown = failure.code === 'UNKNOWN_BARCODE';
      setResult({ error: failure.message, unknown });
      addHistory(t(unknown ? 'Unknown barcode' : 'Could not read this code'), t('Not found'), false);
    }
  }, [t]);

  // USB and Bluetooth scanners type very quickly and press Enter, anywhere on the page.
  useEffect(() => {
    const onKey = (event) => {
      const target = event.target;
      if (target.matches?.('input, textarea, select')) return;
      const code = feedScanner(event.key);
      if (code) {
        event.preventDefault();
        handleCode(code);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [feedScanner, handleCode]);

  const stopCamera = useCallback(() => {
    stopCameraRef.current?.();
    stopCameraRef.current = null;
    setCameraOn(false);
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  async function toggleCamera() {
    if (cameraOn) {
      stopCamera();
      return;
    }
    setCameraBusy(true);
    try {
      stopCameraRef.current = await startCamera(videoRef.current, (code) => {
        if (isNewFromCamera(code)) handleCode(code);
      });
      setCameraOn(true);
    } catch (failure) {
      toast(t(failure.name === 'NotAllowedError' ? 'Camera permission was denied.' : 'No camera could be started. Use a scanner or type the code.'));
    } finally {
      setCameraBusy(false);
    }
  }

  async function scanFromPhoto(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const code = await decodePhoto(file);
    if (code) handleCode(code);
    else toast(t('No barcode found in that photo.'));
  }

  function submitTyped(event) {
    event.preventDefault();
    const code = typed;
    setTyped('');
    handleCode(code);
  }

  return (
    <div className="grid two-col scan-grid">
      <div className="card">
        <h3>{t('Scan')}</h3>
        {canCount && (
          <>
            <div className="sub scan-gap">{t('What should a scan do?')}</div>
            <div className="seg scan-gap">
              <button type="button" className={mode === 'lookup' ? 'active' : ''} onClick={() => setMode('lookup')}>🔎 {t('Price & stock lookup')}</button>
              <button type="button" className={mode === 'count' ? 'active' : ''} onClick={() => setMode('count')}>☑ {t('Stock count')}</button>
            </div>
            {mode === 'count' && (
              counts.length
                ? (
                  <label className="field scan-gap">{t('Counting into')}
                    <select name="countId" value={countId} onChange={(event) => setCountId(event.target.value)}>
                      {counts.map((count) => <option key={count.id} value={count.id}>{count.countNo} · {count.name}</option>)}
                    </select>
                  </label>
                )
                : <div className="light-note scan-gap">{t('No count in progress — start one in Stock Counts.')}</div>
            )}
          </>
        )}
        <div className="viewfinder">
          <video ref={videoRef} playsInline muted aria-label={t('Camera preview')} className={cameraOn ? '' : 'video-off'} />
          {!cameraOn && <div className="vf-msg"><div className="vf-icon">⌸</div>{t('Camera is off.')}</div>}
          <div className="vf-frame" />
          {cameraOn && <div className="vf-laser" />}
        </div>
        <div className="scan-actions">
          <button type="button" className="btn btn-primary" disabled={cameraBusy} onClick={toggleCamera}>{cameraOn ? `■ ${t('Stop camera')}` : `● ${t('Start camera')}`}</button>
          <label className="btn btn-outline">🖼 {t('Scan from photo')}<input type="file" accept="image/*" hidden onChange={scanFromPhoto} /></label>
        </div>
        <form className="search" onSubmit={submitTyped}>
          <span>⌨</span>
          <input
            name="code"
            aria-label={t('Scan or type a barcode')}
            placeholder={t('Scan or type a barcode')}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            autoFocus
          />
        </form>
      </div>
      <div>
        <div className="card scan-result" aria-live="polite"><ScanResult result={result} /></div>
        <div className="card dash-gap">
          <div className="section-row">
            <h3>{t('Scan history')}</h3>
            {history.length > 0 && <button type="button" className="btn btn-outline btn-sm" onClick={() => setHistory([])}>{t('Clear')}</button>}
          </div>
          {history.length === 0 && <div className="empty">{t('No scans yet.')}</div>}
          {history.map((entry) => (
            <div className="list-row" key={entry.id}>
              <span><b>{entry.name}</b><br /><span className="muted small-note mono">{entry.code} · {entry.time}</span></span>
              <span className={`chip ${entry.ok ? 'green' : 'red'}`}>{entry.outcome}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
