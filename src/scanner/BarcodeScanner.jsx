import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { api } from '../api.js';
import { detectBarcodes, loadDetector } from './barcodeDetector.js';

const hints = new Map([
  [DecodeHintType.TRY_HARDER, true],
  [DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
    BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF
  ]]
]);
const reader = new BrowserMultiFormatReader(hints);
const FRAME_MS = 250;     // how often a frame is checked
const REPEAT_MS = 2000;   // ignore the same code again for 2 s

// Copy part of the video into a canvas (optionally rotated 90°) and try to decode it.
function decodeRegion(video, box, rotate = false) {
  const b = box || { x: 0, y: 0, w: video.videoWidth, h: video.videoHeight };
  const pad = box ? 0.15 : 0;
  const x = Math.max(0, b.x - b.w * pad), y = Math.max(0, b.y - b.h * pad);
  const w = Math.min(video.videoWidth - x, b.w * (1 + 2 * pad)), h = Math.min(video.videoHeight - y, b.h * (1 + 2 * pad));
  if (w < 8 || h < 8) return null;
  const up = Math.max(1, 480 / Math.max(w, h)); // enlarge small barcodes
  const c = document.createElement('canvas');
  c.width = Math.round((rotate ? h : w) * up);
  c.height = Math.round((rotate ? w : h) * up);
  const g = c.getContext('2d');
  if (rotate) { g.translate(c.width, 0); g.rotate(Math.PI / 2); }
  g.drawImage(video, x, y, w, h, 0, 0, w * up, h * up);
  try { return reader.decodeFromCanvas(c).getText(); } catch { return null; }
}

export default function BarcodeScanner() {
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const lastRef = useRef({ code: '', at: 0 });
  const useAiRef = useRef(true);

  const [model, setModel] = useState('loading');   // loading | ready | missing
  const [running, setRunning] = useState(false);
  const [useAi, setUseAi] = useState(true);
  const [cameras, setCameras] = useState([]);
  const [cameraId, setCameraId] = useState('');
  const [manual, setManual] = useState('');
  const [message, setMessage] = useState('');
  const [scans, setScans] = useState([]);
  const [stats, setStats] = useState({ frames: 0, ms: 0 });
  const sessionRef = useRef(null);

  useEffect(() => { useAiRef.current = useAi; }, [useAi]);

  useEffect(() => {
    loadDetector().then((s) => { sessionRef.current = s; setModel(s ? 'ready' : 'missing'); });
    BrowserMultiFormatReader.listVideoInputDevices().then(setCameras).catch(() => {});
    return () => stop();
  }, []);

  async function handleCode(code, method, ms) {
    const now = Date.now();
    if (code === lastRef.current.code && now - lastRef.current.at < REPEAT_MS) return;
    lastRef.current = { code, at: now };
    let product = null;
    try {
      product = (await api(`/api/barcode/lookup?code=${encodeURIComponent(code)}`)).product;
    } catch (error) {
      if (error.code !== 'UNKNOWN_BARCODE') {
        setMessage(error.message || 'Could not look up this barcode.');
        return;
      }
    }
    setScans((s) => [{ code, method, ms, product, time: new Date().toLocaleTimeString() }, ...s].slice(0, 50));
  }

  function drawBoxes(boxes) {
    const v = videoRef.current, c = overlayRef.current;
    if (!v || !c) return;
    c.width = v.videoWidth; c.height = v.videoHeight;
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    g.lineWidth = Math.max(3, c.width / 200);
    g.strokeStyle = '#f6c928';
    g.fillStyle = '#f6c928';
    g.font = `${Math.max(14, c.width / 50)}px sans-serif`;
    for (const b of boxes) {
      g.strokeRect(b.x, b.y, b.w, b.h);
      g.fillText(`barcode ${(b.score * 100).toFixed(0)}%`, b.x, Math.max(16, b.y - 6));
    }
  }

  async function tick() {
    const v = videoRef.current;
    if (!streamRef.current) return;
    if (v && v.videoWidth) {
      const t0 = performance.now();
      let code = null, method = 'ZXing (full frame)';
      const ai = useAiRef.current && sessionRef.current;
      if (ai) {
        const boxes = await detectBarcodes(sessionRef.current, v);
        drawBoxes(boxes);
        for (const b of boxes) {
          code = decodeRegion(v, b) || (b.h > b.w * 1.3 ? decodeRegion(v, b, true) : null);
          if (code) { method = 'AI box + ZXing'; break; }
        }
      } else {
        drawBoxes([]);
      }
      if (!code) code = decodeRegion(v, null);
      const ms = performance.now() - t0;
      setStats((s) => ({ frames: s.frames + 1, ms: s.ms + ms }));
      if (code) handleCode(code, method, Math.round(ms));
    }
    timerRef.current = setTimeout(tick, FRAME_MS);
  }

  async function start() {
    setMessage('');
    try {
      const video = cameraId ? { deviceId: { exact: cameraId } } : { facingMode: 'environment' };
      streamRef.current = await navigator.mediaDevices.getUserMedia({ video: { ...video, width: { ideal: 1280 }, height: { ideal: 720 } } });
    } catch (err) {
      setMessage(`Camera not available: ${err.message}`);
      return;
    }
    videoRef.current.srcObject = streamRef.current;
    await videoRef.current.play().catch(() => {});
    setRunning(true);
    setStats({ frames: 0, ms: 0 });
    BrowserMultiFormatReader.listVideoInputDevices().then(setCameras).catch(() => {});
    tick();
  }

  function stop() {
    clearTimeout(timerRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    drawBoxes([]);
    setRunning(false);
  }

  function submitManual(e) {
    e.preventDefault();
    if (manual.trim()) handleCode(manual.trim(), 'USB scanner / typed', 0);
    setManual('');
  }

  const modelText = { loading: 'Loading AI model…', ready: 'AI model loaded', missing: 'AI model not found — using ZXing only' }[model];

  return (
    <div className="scanner">
      <div className="scanner-main">
        <div className="scanner-video">
          <video ref={videoRef} muted playsInline />
          <canvas ref={overlayRef} />
          {!running && <div className="scanner-idle">Camera is off</div>}
        </div>
        <div className="scanner-controls">
          {running
            ? <button className="btn" onClick={stop}>Stop camera</button>
            : <button className="btn primary" onClick={start}>Start camera</button>}
          <select value={cameraId} onChange={(e) => setCameraId(e.target.value)} disabled={running}>
            <option value="">Default camera</option>
            {cameras.map((c, i) => <option key={c.deviceId || i} value={c.deviceId}>{c.label || `Camera ${i + 1}`}</option>)}
          </select>
          <label className="toggle">
            <input type="checkbox" checked={useAi} disabled={model !== 'ready'} onChange={(e) => setUseAi(e.target.checked)} />
            Use AI detector
          </label>
          <span className={`pill ${model}`}>{modelText}</span>
        </div>
        {message && <p className="error">{message}</p>}
        <form className="scanner-manual" onSubmit={submitManual}>
          <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="USB scanner or type a barcode, then Enter" />
          <button className="btn" type="submit">Add</button>
        </form>
      </div>

      <aside className="scanner-side">
        <div className="scanner-stats">
          <div><b>{scans.length}</b><span>scans</span></div>
          <div><b>{stats.frames ? Math.round(stats.ms / stats.frames) : 0} ms</b><span>avg per frame</span></div>
          <div><b>{stats.frames}</b><span>frames checked</span></div>
        </div>
        <h3>Scanned items</h3>
        {scans.length === 0 && <p className="hint">Point the camera at a barcode.</p>}
        <ul className="scan-list">
          {scans.map((s, i) => (
            <li key={i}>
              <div className="scan-code">{s.code}</div>
              <div className="scan-product">
                {s.product ? `${s.product.name} · Rs. ${s.product.sellingPrice.toLocaleString()} · stock ${s.product.stock}` : 'Not in product list'}
              </div>
              <div className="scan-meta">{s.time} · {s.method}{s.ms ? ` · ${s.ms} ms` : ''}</div>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
