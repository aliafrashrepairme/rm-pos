// Frame helpers shared by the camera scanner on the page (cameraScan.js) and in its worker (scanWorker.js),
// so both read barcodes exactly the same way.

// The part of the picture inside the on-screen frame, where people hold the barcode.
export const AREA = { left: 0.15, top: 0.15, width: 0.7, height: 0.7 };
export const WHOLE = { left: 0, top: 0, width: 1, height: 1 };
// The standard reader works on a copy at most this wide: it is quick on sharp barcodes and needs no more.
export const SHARP_READ_WIDTH = 1280;
const STRIP_HEIGHT = 32;
const STRIP_STEP = 16;

// Row-averaged brightness strips across the frame's centre area: averaging removes the camera's grain.
// `context` is a 2D context of a canvas or an OffscreenCanvas.
export function brightnessStrips(context, width, height, area = AREA) {
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

export const BARCODE_FORMATS = ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128', 'CODE_39'];

// The standard ZXing reader without any page (DOM) parts, so it also runs in a worker.
// Converts pixels to grey the same way ZXing's own canvas reader does.
export function createSharpDecoder(zxing) {
  const { MultiFormatReader, RGBLuminanceSource, HybridBinarizer, BinaryBitmap, DecodeHintType, BarcodeFormat } = zxing;
  const hints = new Map([
    [DecodeHintType.POSSIBLE_FORMATS, BARCODE_FORMATS.map((name) => BarcodeFormat[name])],
    [DecodeHintType.TRY_HARDER, true]
  ]);
  const reader = new MultiFormatReader();
  reader.setHints(hints);
  return (imageData) => {
    const { data, width, height } = imageData;
    const grey = new Uint8ClampedArray(width * height);
    for (let i = 0, p = 0; i < grey.length; i += 1, p += 4) {
      grey[i] = data[p + 3] === 0 ? 0xff : (306 * data[p] + 601 * data[p + 1] + 117 * data[p + 2] + 0x200) >> 10;
    }
    try {
      return reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(grey, width, height))), hints).getText();
    } catch {
      return null;
    } finally {
      reader.reset();
    }
  };
}
