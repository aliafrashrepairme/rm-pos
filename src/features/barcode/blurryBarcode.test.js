import assert from 'node:assert/strict';
import test from 'node:test';
import { EAN_PATTERNS, code128Modules, ean13Modules } from '../../app/barcode.js';
import { readBlurredStrip } from './blurryBarcode.js';

// Builds the brightness strip a fixed-focus webcam would give: white label, bars `moduleWidth` pixels wide,
// Gaussian blur of `blur` modules, a little camera grain, grey-ish contrast like a real photo.
function cameraStrip(bits, { moduleWidth = 3.6, blur = 1, seed = 1, reverse = false } = {}) {
  const margin = 80;
  const length = Math.ceil(bits.length * moduleWidth) + margin * 2;
  const sharp = new Float32Array(length).fill(1);
  for (let x = 0; x < length; x += 1) {
    const m = Math.floor((x + 0.5 - margin) / moduleWidth);
    if (m >= 0 && m < bits.length && bits[m] === '1') sharp[x] = 0;
  }
  const sigma = blur * moduleWidth;
  const radius = Math.ceil(sigma * 3);
  let random = seed;
  const noise = () => { random = (random * 16807) % 2147483647; return random / 2147483647 - 0.5; };
  const strip = new Float32Array(length);
  for (let x = 0; x < length; x += 1) {
    let sum = 0; let weight = 0;
    for (let k = -radius; k <= radius; k += 1) {
      const w = Math.exp(-(k * k) / (2 * sigma * sigma));
      sum += w * sharp[Math.min(length - 1, Math.max(0, x + k))];
      weight += w;
    }
    strip[x] = 70 + 130 * (sum / weight) + noise() * 6;
  }
  return reverse ? strip.reverse() : strip;
}

test('reads a blurred Code 128 shop label like the one tested on the webcam', () => {
  // The real label: 4796017020884 printed as Code 128, about 3.6 pixels a bar unit, blurred about one unit.
  const bits = code128Modules('4796017020884');
  assert.equal(readBlurredStrip(cameraStrip(bits)), '4796017020884');
});

test('reads a blurred EAN-13 product barcode, and one held upside down', () => {
  const bits = ean13Modules('2000000079202');
  assert.equal(readBlurredStrip(cameraStrip(bits, { moduleWidth: 4, blur: 0.9 })), '2000000079202');
  assert.equal(readBlurredStrip(cameraStrip(bits, { moduleWidth: 4, blur: 0.9, reverse: true })), '2000000079202');
});

test('reads an EAN-13 held close to the camera, where its wide spaces once split it in two', () => {
  // A Sri Lankan product barcode filling much of the frame: 6 to 12 pixels a bar unit.
  const bits = ean13Modules('4796009888843');
  for (const moduleWidth of [6, 8, 10, 12]) {
    assert.equal(readBlurredStrip(cameraStrip(bits, { moduleWidth, blur: 0.7 })), '4796009888843', `${moduleWidth} px a bar`);
  }
});

test('reads a blurred EAN-8 from a small product', () => {
  // EAN-8 96385074: start guard, four L digits, centre guard, four R digits, end guard.
  const { L, R } = EAN_PATTERNS;
  const digits = '96385074';
  const bits = `101${[...digits.slice(0, 4)].map((d) => L[d]).join('')}01010${[...digits.slice(4)].map((d) => R[d]).join('')}101`;
  assert.equal(readBlurredStrip(cameraStrip(bits, { moduleWidth: 4, blur: 0.8 })), '96385074');
});

test('does not invent a code from a strip without a barcode', () => {
  let random = 7;
  const noise = () => { random = (random * 16807) % 2147483647; return random / 2147483647; };
  const texture = Float32Array.from({ length: 900 }, (_, x) => 120 + 60 * Math.sin(x / 7) + 40 * noise());
  assert.equal(readBlurredStrip(texture), null);
  assert.equal(readBlurredStrip(new Float32Array(900).fill(200)), null);
});
