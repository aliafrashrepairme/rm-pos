const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
const MAX_EDGE = 2400;

// Phone photos are often too large to send, so big ones are made smaller first. PDFs go as they are.
export async function preparePhoto(file) {
  if (file.type === 'application/pdf') return file;
  const known = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
  if (known && file.size <= MAX_IMAGE_BYTES) return file;
  if (!file.type.startsWith('image/')) throw new Error('Choose a JPG, PNG, WebP or PDF file.');

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This photo could not be opened. Choose a JPG, PNG or PDF file.');
  }
  const scale = Math.min(MAX_EDGE / Math.max(bitmap.width, bitmap.height), 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new Error('This photo could not be opened. Choose a JPG, PNG or PDF file.');
  return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
}
