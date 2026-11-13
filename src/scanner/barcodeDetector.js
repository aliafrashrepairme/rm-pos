// Runs the trained YOLO barcode model (public/models/best.onnx) inside the app.
// Works offline in Electron: files are read through the preload bridge when the page is file://.
import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

const MODEL_URL = './models/best.onnx';
const SIZE = 640;   // must match imgsz used in training
const CONF = 0.45;  // minimum confidence for a box
const IOU = 0.5;    // overlap threshold for removing duplicate boxes

async function loadBinary(url) {
  if (location.protocol === 'file:' && window.rmpos?.readAppFile) {
    // turn './x' or 'file:///.../dist/x' into a path relative to dist/
    const abs = new URL(url, location.href).href;
    const base = new URL('.', location.href).href;
    const rel = decodeURIComponent(abs.startsWith(base) ? abs.slice(base.length) : url);
    return new Uint8Array(await window.rmpos.readAppFile(rel));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

let sessionPromise = null;

// Returns the ONNX session, or null if the model file is missing (scanner then uses ZXing only).
export function loadDetector() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      ort.env.wasm.numThreads = 1; // no SharedArrayBuffer in Electron/file://
      ort.env.wasm.wasmBinary = await loadBinary(wasmUrl);
      const model = await loadBinary(MODEL_URL);
      return ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
    })().catch((err) => {
      console.warn('[scanner] AI model not loaded, using ZXing only:', err);
      return null;
    });
  }
  return sessionPromise;
}

const canvas = document.createElement('canvas');
canvas.width = canvas.height = SIZE;
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const input = new Float32Array(3 * SIZE * SIZE);

function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

// Finds barcodes in a video frame. Returns boxes in video pixels, best first.
export async function detectBarcodes(session, video, maxBoxes = 3) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!session || !vw) return [];

  // letterbox (keep aspect ratio, grey padding) - same as Ultralytics
  const scale = Math.min(SIZE / vw, SIZE / vh);
  const nw = Math.round(vw * scale), nh = Math.round(vh * scale);
  const dx = Math.floor((SIZE - nw) / 2), dy = Math.floor((SIZE - nh) / 2);
  ctx.fillStyle = 'rgb(114,114,114)';
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.drawImage(video, 0, 0, vw, vh, dx, dy, nw, nh);

  const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const n = SIZE * SIZE;
  for (let i = 0; i < n; i++) {
    input[i] = px[i * 4] / 255;
    input[n + i] = px[i * 4 + 1] / 255;
    input[2 * n + i] = px[i * 4 + 2] / 255;
  }
  const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) };
  const out = (await session.run(feeds))[session.outputNames[0]];

  // YOLO11 single-class output: [1, 5, N] = cx, cy, w, h, score
  const N = out.dims[2], d = out.data;
  const boxes = [];
  for (let i = 0; i < N; i++) {
    const score = d[4 * N + i];
    if (score < CONF) continue;
    const w = d[2 * N + i] / scale, h = d[3 * N + i] / scale;
    const cx = (d[i] - dx) / scale, cy = (d[N + i] - dy) / scale;
    boxes.push({ x: cx - w / 2, y: cy - h / 2, w, h, score });
  }
  boxes.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const b of boxes) {
    if (keep.every((k) => iou(k, b) < IOU)) keep.push(b);
    if (keep.length === maxBoxes) break;
  }
  return keep;
}
