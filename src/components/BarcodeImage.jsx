import { code128Modules, ean13Modules, isValidEan13, printModuleMm } from '../app/barcode.js';

// White space each side, in bar units: EAN-13 needs 11 on the left and Code 128 needs 10.
const QUIET = 11;
const SCREEN_MODULE = 2;
// Thermal printers make each bar slightly wider than drawn, so printed bars are drawn this much thinner.
const BAR_SHRINK_MM = 0.04;
const PRINT_BARS_MM = 9;
const PRINT_DIGITS_MM = 2.6;

function barRects(bits, x0, unit, height, shrink) {
  const bars = [];
  for (let index = 0; index < bits.length; index += 1) {
    if (bits[index] !== '1') continue;
    let run = 1;
    while (bits[index + run] === '1') run += 1;
    bars.push(<rect key={index} x={(x0 + index) * unit + shrink / 2} y="0" width={run * unit - shrink} height={height} />);
    index += run - 1;
  }
  return bars;
}

// On screen the barcode scales to fit. With `printWidthMm` it is drawn at an exact size in mm, so a
// label or receipt printer reproduces every bar faithfully (see printModuleMm).
export default function BarcodeImage({ code, height = 60, printWidthMm, printBarsMm = PRINT_BARS_MM }) {
  const bits = isValidEan13(code) ? ean13Modules(code) : code128Modules(code);
  const modules = bits.length + QUIET * 2;

  if (printWidthMm) {
    const moduleMm = printModuleMm(modules, printWidthMm);
    const bars = printBarsMm / moduleMm;
    const digits = PRINT_DIGITS_MM / moduleMm;
    return (
      <svg
        className="barcode-image barcode-print"
        viewBox={`0 0 ${modules} ${bars + digits}`}
        style={{ width: `${modules * moduleMm}mm`, height: `${printBarsMm + PRINT_DIGITS_MM}mm` }}
        shapeRendering="crispEdges"
        role="img"
        aria-label={`Barcode ${code}`}
      >
        <rect width={modules} height={bars + digits} fill="#fff" />
        <g fill="#000">{barRects(bits, QUIET, 1, bars, Math.min(BAR_SHRINK_MM / moduleMm, 0.3))}</g>
        <text x={modules / 2} y={bars + digits * 0.85} textAnchor="middle" fontFamily="monospace" fontSize={digits * 0.95} fill="#000">{code}</text>
      </svg>
    );
  }

  const width = modules * SCREEN_MODULE;
  const textHeight = 16;
  return (
    <svg className="barcode-image" viewBox={`0 0 ${width} ${height + textHeight}`} role="img" aria-label={`Barcode ${code}`}>
      <rect width={width} height={height + textHeight} fill="#fff" />
      <g fill="#111">{barRects(bits, QUIET, SCREEN_MODULE, height, 0)}</g>
      <text x={width / 2} y={height + 13} textAnchor="middle" fontFamily="monospace" fontSize="13" fill="#111">{code}</text>
    </svg>
  );
}
