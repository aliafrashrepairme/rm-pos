import { readBlurredStripDetail, stripsToTry } from './blurryBarcode.js';

// Reads blurred barcodes off the main thread, so the screen stays smooth while the camera is on.
// Receives the brightness strips of one frame; replies with the code found, or null.
self.onmessage = ({ data }) => {
  const started = performance.now();
  let code = null;
  for (const index of stripsToTry(data.strips)) {
    code = readBlurredStripDetail(data.strips[index])?.code ?? null;
    if (code || performance.now() - started > data.budgetMs) break;
  }
  self.postMessage({ id: data.id, code });
};
