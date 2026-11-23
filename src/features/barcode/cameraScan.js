import { readBlurredStripDetail, stripsToTry } from './blurryBarcode.js';
import { AREA, BARCODE_FORMATS, SHARP_READ_WIDTH, WHOLE, brightnessStrips } from './frameReader.js';

// The decoding library is large, so it only loads when someone actually uses the camera or a photo,
// and then only once.
let readerPromise = null;
function createReader() {
  readerPromise ||= Promise.all([import('@zxing/browser'), import('@zxing/library')])
    .then(([{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }]) => new BrowserMultiFormatReader(new Map([
      [DecodeHintType.POSSIBLE_FORMATS, BARCODE_FORMATS.map((name) => BarcodeFormat[name])],
      [DecodeHintType.TRY_HARDER, true]
    ])))
    .catch((error) => {
      readerPromise = null;
      throw error;
    });
  return readerPromise;
}

const TICK_MS = 150;
// A blurred read counts only when a second frame agrees, within this time.
const CONFIRM_MS = 2500;
// The worker reads one frame at a time; the next frame is sent as soon as it is free, but no sooner than this.
const MIN_FRAME_GAP_MS = 40;
const WORKER_BUDGET_MS = 900;

function openStream() {
  // The highest resolution the camera offers: the blur-tolerant reader needs about 3 pixels per bar.
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 2560 }, height: { ideal: 1440 }, advanced: [{ focusMode: 'continuous' }] }
  });
}

// One worker reads every frame, kept for the whole session so the camera starts quickly the next time.
let frameWorker;
function getFrameWorker() {
  if (frameWorker !== undefined) return frameWorker;
  frameWorker = null;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null;
  try {
    frameWorker = new Worker(new URL('./scanWorker.js', import.meta.url), { type: 'module' });
  } catch {
    frameWorker = null;
  }
  return frameWorker;
}

// Starts loading the scanner in the background, e.g. when a screen with a camera button opens.
export function prepareScanner() {
  getFrameWorker();
}

// Calls onCode for confirmed codes. A blurred read counts only when a second frame agrees.
function confirmer(onCode) {
  let pending = null;
  return (code, blurred) => {
    if (!code) return;
    if (!blurred) {
      pending = null;
      onCode(code);
      return;
    }
    const now = Date.now();
    if (pending && pending.code === code && now - pending.at < CONFIRM_MS) {
      pending = null;
      onCode(code);
    } else {
      pending = { code, at: now };
    }
  };
}

// Returns a function that stops the camera.
export async function startCamera(video, onCode) {
  const worker = getFrameWorker();
  // The camera and the decoder start together rather than one after the other.
  const [stream, reader] = await Promise.all([openStream(), worker ? null : createReader()]);
  video.srcObject = stream;
  try {
    await video.play();
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    throw error;
  }
  let stopped = false;
  const found = (code) => { if (!stopped) onCode(code); };
  const stopStream = () => {
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  };
  const confirm = confirmer(found);
  const isStopped = () => stopped;
  let stopLoop;
  // If the worker fails part-way, the page reads the frames itself for the rest of this scan.
  const fallBack = () => {
    createReader()
      .then((pageReader) => { if (!stopped) stopLoop = runPageLoop(video, pageReader, confirm, isStopped); })
      .catch(() => {});
  };
  stopLoop = worker ? runWorkerLoop(video, worker, confirm, isStopped, fallBack) : runPageLoop(video, reader, confirm, isStopped);
  return () => {
    stopped = true;
    stopLoop?.();
    stopStream();
  };
}

// Sends one frame at a time to the worker and the next as soon as it replies, so it never decodes old frames.
function runWorkerLoop(video, worker, confirm, isStopped, fallBack) {
  let id = 0;
  let timer = null;
  let lastSent = 0;
  const previousHandlers = { onmessage: worker.onmessage, onerror: worker.onerror };

  const next = () => {
    if (isStopped()) return;
    const wait = Math.max(0, MIN_FRAME_GAP_MS - (performance.now() - lastSent));
    timer = setTimeout(send, wait);
  };
  async function send() {
    if (isStopped()) return;
    if (!video.videoWidth || video.readyState < 2) {
      timer = setTimeout(send, TICK_MS);
      return;
    }
    let frame;
    try {
      frame = await createImageBitmap(video);
    } catch {
      timer = setTimeout(send, TICK_MS);
      return;
    }
    if (isStopped()) {
      frame.close();
      return;
    }
    id += 1;
    lastSent = performance.now();
    worker.postMessage({ id, frame, budgetMs: WORKER_BUDGET_MS }, [frame]);
  }
  worker.onmessage = ({ data }) => {
    if (data.id !== id || isStopped()) return;
    confirm(data.code, data.blurred);
    next();
  };
  // A worker that cannot run here is dropped, and the page reads frames itself from the next start on.
  worker.onerror = () => {
    frameWorker = null;
    worker.terminate();
    clearTimeout(timer);
    if (!isStopped()) fallBack();
  };
  send();
  return () => {
    clearTimeout(timer);
    worker.onmessage = previousHandlers.onmessage;
    worker.onerror = previousHandlers.onerror;
  };
}

// Laptop webcams are fixed-focus, so a barcode held up close is blurred. Without the frame worker, each
// frame goes to two readers on the page: the standard one for sharp barcodes, and a blur-tolerant one
// (blurryBarcode.js) in its own small worker.
function createBlurReader() {
  let worker = null;
  try {
    worker = new Worker(new URL('./blurryWorker.js', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }
  let busy = false;
  let id = 0;
  return {
    get busy() { return busy; },
    read(strips, onResult) {
      busy = true;
      id += 1;
      if (!worker) {
        // Without a worker, read a single strip per frame so the screen keeps responding.
        const [first] = stripsToTry(strips);
        const code = first === undefined ? null : readBlurredStripDetail(strips[first])?.code ?? null;
        busy = false;
        onResult(code);
        return;
      }
      const mine = id;
      worker.onmessage = ({ data }) => {
        if (data.id !== mine) return;
        busy = false;
        onResult(data.code);
      };
      worker.onerror = () => { busy = false; };
      worker.postMessage({ id: mine, strips, budgetMs: WORKER_BUDGET_MS }, strips.map((strip) => strip.buffer));
    },
    stop() { worker?.terminate(); }
  };
}

function runPageLoop(video, reader, confirm, isStopped) {
  const frame = document.createElement('canvas');
  const frameContext = frame.getContext('2d', { willReadFrequently: true });
  const small = document.createElement('canvas');
  const smallContext = small.getContext('2d', { willReadFrequently: true });
  const blur = createBlurReader();
  let timer = null;
  let tick = 0;

  function scan() {
    if (isStopped()) return;
    tick += 1;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width && height && video.readyState >= 2) {
      if (frame.width !== width || frame.height !== height) { frame.width = width; frame.height = height; }
      frameContext.drawImage(video, 0, 0, width, height);
      if (!blur.busy) blur.read(brightnessStrips(frameContext, width, height, AREA), (code) => confirm(code, true));
      // The standard reader on a smaller copy, every other frame: it is quick on sharp barcodes.
      if (tick % 2 === 0) {
        const scale = Math.min(1, SHARP_READ_WIDTH / width);
        small.width = Math.round(width * scale);
        small.height = Math.round(height * scale);
        smallContext.drawImage(frame, 0, 0, small.width, small.height);
        try {
          confirm(reader.decodeFromCanvas(small).getText(), false);
        } catch {
          // No sharp barcode in this frame.
        }
      }
    }
    timer = setTimeout(scan, TICK_MS);
  }
  scan();
  return () => {
    clearTimeout(timer);
    blur.stop();
  };
}

// Returns null when the picture has no readable barcode.
export async function decodePhoto(file) {
  const reader = await createReader();
  const url = URL.createObjectURL(file);
  try {
    try {
      return (await reader.decodeFromImageUrl(url)).getText();
    } catch {
      // Pictures cropped right up to the bars lack the white margin UPC and EAN barcodes need, so add one.
      const image = new Image();
      image.src = url;
      await image.decode();
      const pad = Math.max(40, Math.round(image.naturalWidth * 0.15));
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth + pad * 2;
      canvas.height = image.naturalHeight + pad * 2;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, pad, pad);
      try {
        return reader.decodeFromCanvas(canvas).getText();
      } catch {
        // A blurred photo: try the blur-tolerant reader across the whole picture.
        const strips = brightnessStrips(context, canvas.width, canvas.height, WHOLE);
        for (const index of stripsToTry(strips)) {
          const code = readBlurredStripDetail(strips[index])?.code;
          if (code) return code;
        }
        return null;
      }
    }
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
