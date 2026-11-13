const LEFT_ODD = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const RIGHT = LEFT_ODD.map((pattern) => pattern.replace(/./g, (bit) => (bit === '0' ? '1' : '0')));
const LEFT_EVEN = RIGHT.map((pattern) => [...pattern].reverse().join(''));
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

const CODE128 = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232'];
const CODE128_START_B = 104;
const CODE128_STOP = '2331112';

export function isValidEan13(code) {
  if (!/^\d{13}$/.test(code)) return false;
  const sum = [...code.slice(0, 12)].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

// The 95 modules of an EAN-13 symbol, as a string of 1s (bars) and 0s (spaces).
export function ean13Modules(code) {
  if (!isValidEan13(code)) throw new Error('Not a valid EAN-13 code.');
  const parity = PARITY[Number(code[0])];
  let bits = '101';
  for (let index = 1; index <= 6; index += 1) bits += (parity[index - 1] === 'L' ? LEFT_ODD : LEFT_EVEN)[Number(code[index])];
  bits += '01010';
  for (let index = 7; index <= 12; index += 1) bits += RIGHT[Number(code[index])];
  return `${bits}101`;
}

// Code 128 prints any other code, such as letters or a short manufacturer number.
export function code128Modules(text) {
  if (!/^[\x20-\x7e]+$/.test(text)) throw new Error('Code 128 only prints plain characters.');
  const values = [...text].map((character) => character.charCodeAt(0) - 32);
  const check = values.reduce((total, value, index) => total + value * (index + 1), CODE128_START_B) % 103;
  const widths = [CODE128[CODE128_START_B], ...values.map((value) => CODE128[value]), CODE128[check], CODE128_STOP].join('');
  let bit = '1';
  let bits = '';
  for (const width of widths) {
    bits += bit.repeat(Number(width));
    bit = bit === '1' ? '0' : '1';
  }
  return bits;
}

// Decides how a scanner's fast keystrokes differ from someone typing.
export function createScannerBuffer({ maxGapMs = 60, minLength = 6, now = Date.now } = {}) {
  let buffer = '';
  let lastKeyAt = 0;
  return (key) => {
    const time = now();
    if (time - lastKeyAt > maxGapMs) buffer = '';
    lastKeyAt = time;
    if (key === 'Enter') {
      const code = buffer.length >= minLength ? buffer : null;
      buffer = '';
      return code;
    }
    if (key.length === 1) buffer += key;
    return null;
  };
}

// The same code seen again within the window is one physical scan, not a second item.
export function createDuplicateFilter({ windowMs = 2000, now = Date.now } = {}) {
  let lastCode = null;
  let lastAt = 0;
  return (code) => {
    const time = now();
    const isRepeat = code === lastCode && time - lastAt < windowMs;
    lastCode = code;
    lastAt = time;
    return !isRepeat;
  };
}
