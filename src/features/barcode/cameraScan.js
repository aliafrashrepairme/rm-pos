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
  return new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 200 });
}

// Returns a function that stops the camera.
export async function startCamera(video, onCode) {
  const reader = await createReader();
  const controls = await reader.decodeFromConstraints(
    { video: { facingMode: 'environment' } },
    video,
    (result) => {
      if (result) onCode(result.getText());
    }
  );
  return () => controls.stop();
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
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, pad, pad);
      return reader.decodeFromCanvas(canvas).getText();
    }
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
