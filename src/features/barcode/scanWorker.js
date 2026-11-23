import * as zxing from '@zxing/library';
import { readBlurredStripDetail, stripsToTry } from './blurryBarcode.js';
import { SHARP_READ_WIDTH, brightnessStrips, createSharpDecoder } from './frameReader.js';

// Reads camera frames off the main thread, so the screen and buttons stay responsive while scanning.
// Receives { id, frame: ImageBitmap, budgetMs }; replies { id, code, blurred, ms }.
// Each frame tries the standard reader first (fast on sharp barcodes), then the blur-tolerant reader.
const decodeSharp = createSharpDecoder(zxing);
let full = null;
let small = null;

function context(canvas, width, height) {
  if (canvas.canvas.width !== width || canvas.canvas.height !== height) {
    canvas.canvas.width = width;
    canvas.canvas.height = height;
  }
  return canvas;
}

self.onmessage = ({ data }) => {
  const started = performance.now();
  const { id, frame, budgetMs } = data;
  const { width, height } = frame;
  full ||= new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  small ||= new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });

  const scale = Math.min(1, SHARP_READ_WIDTH / width);
  const sw = Math.round(width * scale);
  const sh = Math.round(height * scale);
  const smallContext = context(small, sw, sh);
  smallContext.drawImage(frame, 0, 0, sw, sh);
  let code = decodeSharp(smallContext.getImageData(0, 0, sw, sh));
  let blurred = false;

  if (!code) {
    const fullContext = context(full, width, height);
    fullContext.drawImage(frame, 0, 0);
    const strips = brightnessStrips(fullContext, width, height);
    for (const index of stripsToTry(strips)) {
      code = readBlurredStripDetail(strips[index])?.code ?? null;
      if (code || performance.now() - started > budgetMs) break;
    }
    blurred = Boolean(code);
  }
  frame.close();
  self.postMessage({ id, code, blurred, ms: Math.round(performance.now() - started) });
};
