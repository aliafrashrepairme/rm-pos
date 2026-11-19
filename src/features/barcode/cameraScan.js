import { readBlurredStripDetail, stripsToTry } from './blurryBarcode.js';

// The decoding library is large, so it only loads when someone actually uses the camera or a photo.
async function createReader() {
  const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
    import('@zxing/browser'),
    import('@zxing/library')
  ]);
  const hints = new Map([
    [DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39
    ]],
    [DecodeHintType.TRY_HARDER, true]
  ]);
  return new BrowserMultiFormatReader(hints);
}

const TICK_MS = 150;
// The part of the picture inside the on-screen frame, where people hold the barcode.
const AREA = { left: 0.15, top: 0.15, width: 0.7, height: 0.7 };
const WHOLE = { left: 0, top: 0, width: 1, height: 1 };
const STRIP_HEIGHT = 32;
const STRIP_STEP = 16;
// A blurred read counts only when a second frame agrees, within this time.
const CONFIRM_MS = 2500;
const SHARP_READ_WIDTH = 1280;

// Row-averaged brightness strips across the frame's centre area: averaging removes the camera's grain.
function brightnessStrips(context, width, height, area = AREA) {
  const x0 = Math.round(width * area.left);
  const y0 = Math.round(height * area.top);
  const w = Math.round(width * area.width);
  const h = Math.round(height * area.height);
  const pixels = context.getImageData(x0, y0, w, h).data;
  const rows = new Float32Array(h * w);
  for (let i = 0, p = 0; i < rows.length; i += 1, p += 4) rows[i] = pixels[p] * 0.299 + pixels[p + 1] * 0.587 + pixels[p + 2] * 0.114;
  const strips = [];
  for (let y = 0; y + STRIP_HEIGHT <= h; y += STRIP_STEP) {
    const strip = new Float32Array(w);
    for (let row = y; row < y + STRIP_HEIGHT; row += 1) {
      const offset = row * w;
      for (let x = 0; x < w; x += 1) strip[x] += rows[offset + x];
    }
    for (let x = 0; x < w; x += 1) strip[x] /= STRIP_HEIGHT;
    strips.push(strip);
  }
  return strips;
}

// Laptop webcams are fixed-focus, so a barcode held up close is blurred. Each frame goes to two readers:
// the standard one for sharp barcodes, and a blur-tolerant one (blurryBarcode.js) in a background worker.
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
      worker.postMessage({ id: mine, strips, budgetMs: 900 }, strips.map((strip) => strip.buffer));
    },
    stop() { worker?.terminate(); }
  };
}

// Returns a function that stops the camera.
export async function startCamera(video, onCode) {
  const reader = await createReader();
  // The highest resolution the camera offers: the blur-tolerant reader needs about 3 pixels per bar.
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 2560 }, height: { ideal: 1440 }, advanced: [{ focusMode: 'continuous' }] }
  });
  video.srcObject = stream;
  await video.play();

  const frame = document.createElement('canvas');
  const frameContext = frame.getContext('2d', { willReadFrequently: true });
  const small = document.createElement('canvas');
  const smallContext = small.getContext('2d', { willReadFrequently: true });
  const blur = createBlurReader();
  let stopped = false;
  let timer = null;
  let tick = 0;
  let pending = null;

  const found = (code) => { if (!stopped) onCode(code); };
  const blurredResult = (code) => {
    if (!code || stopped) return;
    const now = Date.now();
    if (pending && pending.code === code && now - pending.at < CONFIRM_MS) {
      pending = null;
      found(code);
    } else {
      pending = { code, at: now };
    }
  };

  function scan() {
    if (stopped) return;
    tick += 1;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width && height && video.readyState >= 2) {
      if (frame.width !== width || frame.height !== height) { frame.width = width; frame.height = height; }
      frameContext.drawImage(video, 0, 0, width, height);
      if (!blur.busy) blur.read(brightnessStrips(frameContext, width, height), blurredResult);
      // The standard reader on a smaller copy, every other frame: it is quick on sharp barcodes.
      if (tick % 2 === 0) {
        const scale = Math.min(1, SHARP_READ_WIDTH / width);
        small.width = Math.round(width * scale);
        small.height = Math.round(height * scale);
        smallContext.drawImage(frame, 0, 0, small.width, small.height);
        try {
          found(reader.decodeFromCanvas(small).getText());
        } catch {
          // No sharp barcode in this frame.
        }
      }
    }
    timer = setTimeout(scan, TICK_MS);
  }
  scan();

  return () => {
    stopped = true;
    clearTimeout(timer);
    blur.stop();
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
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
