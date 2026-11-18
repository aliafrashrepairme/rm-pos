import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { detectBarcodes } from './barcodeDetector.js';

const formats = [
  BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF
];
// The quick reader checks the whole frame; the careful one, several times slower, only the AI's box.
const quickReader = new BrowserMultiFormatReader(new Map([[DecodeHintType.POSSIBLE_FORMATS, formats]]));
const carefulReader = new BrowserMultiFormatReader(new Map([
  [DecodeHintType.TRY_HARDER, true],
  [DecodeHintType.POSSIBLE_FORMATS, formats]
]));
const ENLARGE_TO = 900; // a small, blurry barcode is enlarged to about this many pixels wide
// The AI model is the slowest step, so it runs at most this often. Frames in between are read inside
// the boxes it last found, which lets a fresh, sharper frame be tried without waiting for the model.
const DETECT_EVERY_MS = 1000;
let lastDetection = { boxes: [], at: -Infinity };

const sizeOf = (source) => ({ width: source.videoWidth || source.width, height: source.videoHeight || source.height });

// Spreads the crop's greys over the full black-to-white range, so dim or washed-out bars stand out.
function stretchContrast(context, width, height) {
  const image = context.getImageData(0, 0, width, height);
  const { data } = image;
  const grey = new Uint8ClampedArray(data.length / 4);
  const counts = new Uint32Array(256);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    grey[p] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    counts[grey[p]] += 1;
  }
  // Ignore the darkest and brightest 2%, so a speck of glare does not set the range.
  const edge = grey.length * 0.02;
  let low = 0;
  let high = 255;
  for (let sum = 0; low < 255 && sum + counts[low] < edge; low += 1) sum += counts[low];
  for (let sum = 0; high > 0 && sum + counts[high] < edge; high -= 1) sum += counts[high];
  const range = Math.max(1, high - low);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const value = ((grey[p] - low) * 255) / range;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
  }
  context.putImageData(image, 0, 0);
}

// Reads the whole picture, or one box of it with a margin around it, turned 90° if asked.
function decodeRegion(source, box, { pad = 0.15, rotate = false, reader = carefulReader } = {}) {
  const { width, height } = sizeOf(source);
  const area = box || { x: 0, y: 0, w: width, h: height };
  const margin = box ? pad : 0;
  const x = Math.max(0, area.x - area.w * margin);
  const y = Math.max(0, area.y - area.h * margin);
  const w = Math.min(width - x, area.w * (1 + 2 * margin));
  const h = Math.min(height - y, area.h * (1 + 2 * margin));
  if (w < 8 || h < 8) return null;
  const grow = box ? Math.max(1, ENLARGE_TO / Math.max(w, h)) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round((rotate ? h : w) * grow);
  canvas.height = Math.round((rotate ? w : h) * grow);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (rotate) {
    context.translate(canvas.width, 0);
    context.rotate(Math.PI / 2);
  }
  context.drawImage(source, x, y, w, h, 0, 0, w * grow, h * grow);
  if (box) stretchContrast(context, canvas.width, canvas.height);
  try {
    return reader.decodeFromCanvas(canvas).getText();
  } catch {
    return null;
  }
}

// Reads one camera frame. The quick reader goes first because clear barcodes need nothing more, so the
// AI model only helps when it fails. The model's box is read as found, and again with a wider margin,
// because on blurry pictures the box can sit slightly off the bars.
export async function readFrame(source, session, useAi, now = performance.now()) {
  const plain = decodeRegion(source, null, { reader: quickReader });
  if (plain) return { code: plain, method: 'ZXing (full frame)', boxes: [] };
  if (!useAi || !session) return { code: null, method: '', boxes: [] };

  const fresh = now - lastDetection.at >= DETECT_EVERY_MS;
  if (fresh) {
    // Timed from when the model finishes, so a slow computer still gets quick frames in between.
    const started = performance.now();
    const found = await detectBarcodes(session, source);
    lastDetection = { boxes: found, at: now + (performance.now() - started) };
  }
  // Frames between model runs only get the quick reader, so they stay fast.
  return readBoxes(source, lastDetection.boxes, fresh ? [quickReader, carefulReader] : [quickReader]);
}

function readBoxes(source, boxes, readers) {
  for (const box of boxes) {
    for (const reader of readers) {
      for (const pad of [0.15, 0.5]) {
        const code = decodeRegion(source, box, { pad, reader })
          || (box.h > box.w * 1.3 ? decodeRegion(source, box, { pad, reader, rotate: true }) : null);
        if (code) return { code, method: 'AI box + ZXing', boxes };
      }
    }
  }
  return { code: null, method: '', boxes };
}

// Reads a still picture, such as an uploaded photo: the careful reader on the whole picture, then the
// AI model's boxes. It leaves the camera's once-a-second model timing alone.
export async function readPicture(source, session) {
  const whole = decodeRegion(source, null);
  if (whole) return { code: whole, method: 'Photo · ZXing', boxes: [] };
  if (!session) return { code: null, method: '', boxes: [] };
  const found = await readBoxes(source, await detectBarcodes(session, source), [quickReader, carefulReader]);
  return found.code ? { ...found, method: 'Photo · AI box + ZXing' } : found;
}
