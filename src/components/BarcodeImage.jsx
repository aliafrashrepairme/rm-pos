import { code128Modules, ean13Modules, isValidEan13 } from '../app/barcode.js';

const QUIET = 10;
const MODULE_WIDTH = 2;

// Draws bars at whole-number widths, because rounded widths are what printers and scanners read reliably.
export default function BarcodeImage({ code, height = 60 }) {
  const isEan = isValidEan13(code);
  const bits = isEan ? ean13Modules(code) : code128Modules(code);
  const width = (bits.length + QUIET * 2) * MODULE_WIDTH;
  const textHeight = 16;
  const bars = [];
  for (let index = 0; index < bits.length; index += 1) {
    if (bits[index] !== '1') continue;
    let run = 1;
    while (bits[index + run] === '1') run += 1;
    bars.push(<rect key={index} x={(QUIET + index) * MODULE_WIDTH} y="0" width={run * MODULE_WIDTH} height={height} />);
    index += run - 1;
  }
  return (
    <svg className="barcode-image" viewBox={`0 0 ${width} ${height + textHeight}`} role="img" aria-label={`Barcode ${code}`}>
      <rect width={width} height={height + textHeight} fill="#fff" />
      <g fill="#111">{bars}</g>
      <text x={width / 2} y={height + 13} textAnchor="middle" fontFamily="monospace" fontSize="13" fill="#111">{code}</text>
    </svg>
  );
}
