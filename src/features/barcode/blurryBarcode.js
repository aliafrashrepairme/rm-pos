import { CODE128, EAN_PATTERNS, isValidEan13 } from '../../app/barcode.js';

// Laptop webcams cannot focus closer than about 50 cm, so a barcode held up to one is blurred: thin bars
// smear into grey and ordinary readers, which look for sharp bar edges, find nothing.
// This reader works on one brightness strip across the barcode. For each character it asks which of the
// possible bar patterns, blurred by the same amount, looks most like what the camera saw. The barcode's own
// check character confirms the result; the camera code also waits for the same code in more than one frame.
// It reads EAN-13 / UPC-A (factory product barcodes, and the ones RM POS generates), EAN-8 (small
// products) and Code 128
// (most labels printed in shops).

// On recorded webcam frames, true reads matched at 0.94–0.96 and chance fits of strips at the barcode's
// edge at 0.77–0.89. Accept only close matches, and only codes made of characters RM POS barcodes use.
const MIN_AVERAGE = 0.91;
const MIN_SYMBOL = 0.5;
// EAN-13 has only a one-in-ten check digit, so its reads must match more closely (true reads score 0.98+).
const MIN_EAN_AVERAGE = 0.93;
// Runner-up symbols this close to the top choice are tried when the check character fails...
const CLOSE_RUNNER_UP = 0.04;
const MAX_COMBINATIONS = 729;
// ...and a combination is accepted only if the complete code matches the strip at least this well.
const MIN_WHOLE_FIT = 0.92;
// The same characters the server accepts as a barcode (server/services/barcode.js).
const CODE_FORMAT = /^[0-9A-Za-z._/-]{1,40}$/;

// ---- Blur model -------------------------------------------------------------------------------------

const PHI_STEP = 0.01;
const PHI_RANGE = 6;
const PHI_TABLE = (() => {
  const table = new Float32Array(Math.round((2 * PHI_RANGE) / PHI_STEP) + 1);
  let sum = 0;
  const density = (x) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  for (let i = 0; i < table.length; i += 1) {
    const x = -PHI_RANGE + i * PHI_STEP;
    sum += density(x - PHI_STEP / 2) * PHI_STEP;
    table[i] = sum;
  }
  return table;
})();
const phi = (x) => (x <= -PHI_RANGE ? 0 : x >= PHI_RANGE ? 1 : PHI_TABLE[Math.round((x + PHI_RANGE) / PHI_STEP)]);

// A barcode laid over the strip: where module 0 starts, how wide a module is, how blurred it is.
// `weights(x0, x1)` gives, for each pixel, how much each nearby module darkens it.
function makeLayout(start, width, sigma, totalModules) {
  const reach = Math.ceil((3 * sigma) / width) + 1;
  const cache = [];
  function weightsAt(x) {
    if (cache[x]) return cache[x];
    const centre = x + 0.5;
    const m0 = Math.max(0, Math.floor((centre - start) / width) - reach);
    const m1 = Math.min(totalModules - 1, Math.floor((centre - start) / width) + reach);
    const w = new Float32Array(Math.max(0, m1 - m0 + 1));
    let previous = phi((start + m0 * width - centre) / sigma);
    for (let m = m0; m <= m1; m += 1) {
      const next = phi((start + (m + 1) * width - centre) / sigma);
      w[m - m0] = next - previous;
      previous = next;
    }
    cache[x] = { m0, w };
    return cache[x];
  }
  return { start, width, sigma, totalModules, weightsAt };
}

// How well the modules `fromModule .. toModule` (1 = bar, 0 = space, 0.5 = unknown) explain the strip there.
function fit(profile, layout, modules, fromModule, toModule) {
  const x0 = Math.max(0, Math.floor(layout.start + fromModule * layout.width));
  const x1 = Math.min(profile.length, Math.ceil(layout.start + toModule * layout.width));
  const n = x1 - x0;
  if (n < 4) return 0;
  // One pass, no allocation: this runs thousands of times per strip.
  let sa = 0; let sb = 0; let saa = 0; let sbb = 0; let sab = 0;
  for (let i = 0; i < n; i += 1) {
    const a = -profile[x0 + i];
    const { m0, w } = layout.weightsAt(x0 + i);
    let b = 0;
    for (let k = 0; k < w.length; k += 1) b += w[k] * modules[m0 + k];
    sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
  }
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  return va > 1e-9 && vb > 1e-9 ? (sab - (sa * sb) / n) / Math.sqrt(va * vb) : 0;
}

// ---- Generic slot decoding ----------------------------------------------------------------------------

// Prepares everything about one slot that does not depend on which pattern is tried in it, and returns a
// fast function giving the match (correlation) for a pattern's bits.
function slotScorer(profile, layout, modules, slot) {
  const x0 = Math.max(0, Math.floor(layout.start + slot.at * layout.width));
  const x1 = Math.min(profile.length, Math.ceil(layout.start + (slot.at + slot.size) * layout.width));
  const n = x1 - x0;
  if (n < 4) return () => 0;
  const observed = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i += 1) { observed[i] = -profile[x0 + i]; mean += observed[i]; }
  mean /= n;
  let norm = 0;
  for (let i = 0; i < n; i += 1) { observed[i] -= mean; norm += observed[i] * observed[i]; }
  norm = Math.sqrt(norm);
  if (!norm) return () => 0;
  const base = new Float32Array(n);
  const inSlot = new Float32Array(n * slot.size);
  for (let i = 0; i < n; i += 1) {
    const { m0, w } = layout.weightsAt(x0 + i);
    for (let k = 0; k < w.length; k += 1) {
      const m = m0 + k;
      if (m >= slot.at && m < slot.at + slot.size) inSlot[i * slot.size + (m - slot.at)] = w[k];
      else base[i] += w[k] * modules[m];
    }
  }
  const predicted = new Float32Array(n);
  return (bits) => {
    let sum = 0;
    let sumSquares = 0;
    let dot = 0;
    for (let i = 0; i < n; i += 1) {
      let p = base[i];
      const row = i * slot.size;
      for (let j = 0; j < slot.size; j += 1) if (bits[j]) p += inSlot[row + j];
      predicted[i] = p;
      sum += p; sumSquares += p * p; dot += observed[i] * p;
    }
    const variance = sumSquares - (sum * sum) / n;
    return variance > 1e-9 ? dot / (norm * Math.sqrt(variance)) : 0;
  };
}

// `slots`: the unknown characters, each { at: first module, size: modules, options: [{ value, bits }] }.
// `known`: the full module array with fixed parts (guards, start, stop) filled in and unknown parts 0.5.
// Each slot is scored with its neighbours unknown, then again with the neighbours' best guesses.
function decodeSlots(profile, layout, known, slots, passes = 2) {
  const modules = Float32Array.from(known);
  let ranked = [];
  for (let pass = 0; pass < passes; pass += 1) {
    if (pass === 1) ranked.forEach((list, i) => list[0].bits.forEach((bit, k) => { modules[slots[i].at + k] = bit; }));
    ranked = slots.map((slot) => {
      const score = slotScorer(profile, layout, modules, slot);
      return slot.options.map((option) => ({ ...option, score: score(option.bits) })).sort((a, b) => b.score - a.score);
    });
  }
  return ranked;
}

// Where the strip has lots of light/dark alternation, i.e. where bars probably are.
// A label's edge close to the bars (dark box, then a short white margin) joins the bars' region and
// shifts the barcode's apparent start. A white stretch near either end that is wider than any gap inside a
// barcode (over about 5.5 modules) is the quiet zone: the barcode starts after it, or ends before it.
function trimQuietZones(profile, left, right) {
  const span = right - left;
  // White is judged against the brightest point: inside a blurred barcode the gaps never get fully white.
  let brightest = 0;
  for (let x = left; x < right; x += 1) brightest = Math.max(brightest, profile[x]);
  const white = brightest * 0.92;
  const minRun = span * 0.045;
  let start = left;
  let end = right;
  let run = 0;
  for (let x = left; x < left + span * 0.3; x += 1) {
    run = profile[x] >= white ? run + 1 : 0;
    if (run >= minRun) start = x + 1;
  }
  run = 0;
  for (let x = right; x > right - span * 0.3; x -= 1) {
    run = profile[x] >= white ? run + 1 : 0;
    if (run >= minRun) end = x - 1;
  }
  // Move past the rest of the white run, to the first bar.
  while (start < end && profile[start] >= white) start += 1;
  while (end > start && profile[end] >= white) end -= 1;
  return [start, end];
}

function barRegions(profile) {
  const n = profile.length;
  const reach = 10;
  const contrast = new Float32Array(n);
  for (let x = 0; x < n; x += 1) {
    let lo = Infinity; let hi = -Infinity;
    for (let k = Math.max(0, x - reach); k < Math.min(n, x + reach); k += 1) { if (profile[k] < lo) lo = profile[k]; if (profile[k] > hi) hi = profile[k]; }
    contrast[x] = hi - lo;
  }
  const sorted = Float32Array.from(contrast).sort();
  const threshold = Math.max(15, sorted[Math.floor(n * 0.95)] * 0.4);
  const regions = [];
  let from = -1;
  let quiet = 0;
  for (let x = 0; x <= n; x += 1) {
    const active = x < n && contrast[x] > threshold;
    if (active) {
      if (from < 0) from = x;
      quiet = 0;
    } else if (from >= 0 && (quiet += 1) > reach * 2) {
      const to = x - quiet;
      const trimmed = trimQuietZones(profile, from + reach, to - reach);
      if (trimmed[1] - trimmed[0] > 80) regions.push(trimmed);
      from = -1;
    }
  }
  return regions;
}

const toBits = (pattern) => [...pattern].map(Number);
const widthsToBits = (widths) => {
  const bits = [];
  [...widths].forEach((w, i) => { for (let k = 0; k < Number(w); k += 1) bits.push(i % 2 === 0 ? 1 : 0); });
  return bits;
};

// Tries layouts whose ends sit near the region's ends and ranks them by how well the fixed parts fit.
// `partSets` are alternatives (such as the three Code 128 start characters) that share each layout's
// blur arithmetic. Returns, for each set, its best few layouts.
function candidateLayouts(profile, [left, right], totalModules, partSets, sigmas, keep = 4) {
  const span = right - left;
  const rough = span / totalModules;
  const step = Math.max(0.75, rough / 2);
  const ranked = partSets.map(() => []);
  for (let start = left - 1.5 * rough; start <= left + rough; start += step) {
    for (let end = right - rough; end <= right + 1.5 * rough; end += step) {
      const width = (end - start) / totalModules;
      if (width < 1.5) continue;
      for (const blur of sigmas) {
        const layout = makeLayout(start, width, blur * width, totalModules);
        partSets.forEach((parts, i) => {
          let score = 0;
          for (const part of parts) score += fit(profile, layout, part.modules, part.from, part.to);
          ranked[i].push({ layout, score: score / parts.length });
        });
      }
    }
  }
  return ranked.map((list) => list.sort((x, y) => y.score - x.score).slice(0, keep));
}

// The coarse grid can straddle the true outline, so nudge a finalist's ends by up to one grid step.
function refineLayout(profile, found, totalModules, parts) {
  let best = found;
  const { start, width, sigma } = found.layout;
  const step = Math.max(0.75, width * 0.5);
  const end = start + width * totalModules;
  for (let ds = -step; ds <= step + 1e-9; ds += step / 3) {
    for (let de = -step; de <= step + 1e-9; de += step / 3) {
      const w = (end + de - start - ds) / totalModules;
      const layout = makeLayout(start + ds, w, (sigma / width) * w, totalModules);
      let score = 0;
      for (const part of parts) score += fit(profile, layout, part.modules, part.from, part.to);
      if (score / parts.length > best.score) best = { layout, score: score / parts.length };
    }
  }
  return best;
}

// Fine-tunes start, bar-unit width and blur so that a complete reading matches the whole strip best.
function fitWholeCode(profile, layout, modules, totalModules) {
  let best = { layout, score: fit(profile, layout, modules, 0, totalModules) };
  const { start, width, sigma } = layout;
  for (let ds = -1; ds <= 1; ds += 0.5) {
    for (let dw = -0.01; dw <= 0.01 + 1e-9; dw += 0.01) {
      for (let blur = 0.6; blur <= 1.2 + 1e-9; blur += 0.15) {
        const w = width * (1 + dw);
        const candidate = makeLayout(start + ds * width, w, blur * w, totalModules);
        const score = fit(profile, candidate, modules, 0, totalModules);
        if (score > best.score) best = { layout: candidate, score };
      }
    }
  }
  return best.layout;
}

// ---- EAN-13 -------------------------------------------------------------------------------------------

const EAN_LEFT = [...EAN_PATTERNS.L.map((p, d) => ({ value: d, parity: 'L', bits: toBits(p) })), ...EAN_PATTERNS.G.map((p, d) => ({ value: d, parity: 'G', bits: toBits(p) }))];
const EAN_RIGHT = EAN_PATTERNS.R.map((p, d) => ({ value: d, bits: toBits(p) }));
const EAN_SLOTS = Array.from({ length: 12 }, (_, i) => ({ at: i < 6 ? 3 + i * 7 : 50 + (i - 6) * 7, size: 7, options: i < 6 ? EAN_LEFT : EAN_RIGHT }));

function guardModules(total, guards) {
  const modules = new Float32Array(total).fill(0.5);
  guards.forEach(([at, bits]) => bits.forEach((b, k) => { modules[at + k] = b; }));
  return modules;
}

// The first digit is carried by which left digits use L or G patterns: pick the best consistent reading.
function bestEan13Reading(ranked) {
  let best = null;
  EAN_PATTERNS.parity.forEach((parity, first) => {
    const picks = ranked.map((list, i) => (i < 6 ? list.find((o) => o.parity === parity[i]) : list[0]));
    const total = picks.reduce((sum, o) => sum + o.score, 0);
    if (!best || total > best.total) best = { code: String(first) + picks.map((o) => o.value).join(''), picks, total };
  });
  return best;
}

const EAN8_LEFT = EAN_PATTERNS.L.map((p, d) => ({ value: d, bits: toBits(p) }));
const isValidEan8 = (code) => /^\d{8}$/.test(code)
  && [...code.slice(0, 7)].reduce((sum, d, i) => sum + Number(d) * (i % 2 ? 1 : 3), 0) % 10 === (10 - Number(code[7])) % 10;

// EAN-13 (also UPC-A, as EAN-13 with a leading 0) and EAN-8, the short code on small products.
const EAN_FORMATS = [
  {
    modules: 95,
    slots: EAN_SLOTS,
    known: guardModules(95, [[0, [1, 0, 1]], [45, [0, 1, 0, 1, 0]], [92, [1, 0, 1]]]),
    reading: bestEan13Reading,
    valid: isValidEan13
  },
  {
    modules: 67,
    slots: Array.from({ length: 8 }, (_, i) => ({ at: i < 4 ? 3 + i * 7 : 36 + (i - 4) * 7, size: 7, options: i < 4 ? EAN8_LEFT : EAN_RIGHT })),
    known: guardModules(67, [[0, [1, 0, 1]], [31, [0, 1, 0, 1, 0]], [64, [1, 0, 1]]]),
    reading: (ranked) => {
      const picks = ranked.map((list) => list[0]);
      return { code: picks.map((o) => o.value).join(''), picks, total: picks.reduce((sum, o) => sum + o.score, 0) };
    },
    valid: isValidEan8
  }
];

// EAN guard patterns are only 3–5 modules, which blur leaves nearly featureless, so outlines are
// ranked by a quick one-pass read of all the digits instead.
function readEan(profile, [left, right], format) {
  const { modules: total, slots, known } = format;
  const quick = (layout) => format.reading(decodeSlots(profile, layout, known, slots, 1)).total;
  const rough = (right - left) / total;
  if (rough < 1.5) return null;
  const step = Math.max(0.75, rough / 2);
  let outlines = [];
  for (let start = left - 1.5 * rough; start <= left + rough; start += step) {
    for (let end = right - rough; end <= right + 1.5 * rough; end += step) {
      for (const blur of [0.5, 0.8, 1.1]) {
        const width = (end - start) / total;
        outlines.push({ start, end, blur, score: quick(makeLayout(start, width, blur * width, total)) });
      }
    }
  }
  outlines = outlines.sort((x, y) => y.score - x.score).slice(0, 2);
  let best = null;
  for (const outline of outlines) {
    let tuned = outline;
    for (let ds = -step; ds <= step + 1e-9; ds += step / 2) {
      for (let de = -step; de <= step + 1e-9; de += step / 2) {
        for (const blur of [outline.blur - 0.15, outline.blur, outline.blur + 0.15]) {
          const width = (outline.end + de - outline.start - ds) / total;
          const score = quick(makeLayout(outline.start + ds, width, blur * width, total));
          if (score > tuned.score) tuned = { start: outline.start + ds, end: outline.end + de, blur, score };
        }
      }
    }
    const width = (tuned.end - tuned.start) / total;
    const reading = format.reading(decodeSlots(profile, makeLayout(tuned.start, width, tuned.blur * width, total), known, slots));
    if (!best || reading.total > best.total) best = reading;
  }
  if (!best) return null;
  const average = best.total / slots.length;
  if (average < MIN_EAN_AVERAGE || Math.min(...best.picks.map((o) => o.score)) < MIN_SYMBOL) return null;
  return format.valid(best.code) ? { code: best.code, score: average } : null;
}

// ---- Code 128 -----------------------------------------------------------------------------------------

const C128_BITS = CODE128.map(widthsToBits);
const C128_STOP = widthsToBits('2331112');
const C128_DATA = C128_BITS.slice(0, 103).map((bits, value) => ({ value, bits }));
const C128_STARTS = [103, 104, 105].map((value) => ({ value, bits: C128_BITS[value] }));

// Turns symbol values into text, following the code set switches.
function code128Text(values) {
  let set = values[0] === 103 ? 'A' : values[0] === 104 ? 'B' : 'C';
  let text = '';
  let shift = false;
  for (const value of values.slice(1)) {
    const current = shift ? (set === 'A' ? 'B' : 'A') : set;
    shift = false;
    if (current === 'C') {
      if (value < 100) text += String(value).padStart(2, '0');
      else if (value === 100) set = 'B';
      else if (value === 101) set = 'A';
      else if (value !== 102) return null;
      continue;
    }
    if (value === 98) { shift = true; continue; }
    if (value === 99) { set = 'C'; continue; }
    if (value === 100 && current === 'A') { set = 'B'; continue; }
    if (value === 101 && current === 'B') { set = 'A'; continue; }
    if (value >= 96) continue; // function codes carry no text
    if (current === 'B') text += String.fromCharCode(value + 32);
    else text += value < 64 ? String.fromCharCode(value + 32) : String.fromCharCode(value - 64);
  }
  return text;
}

const checkOf = (values) => values.reduce((sum, v, i) => sum + v * (i || 1), 0) % 103;

function readCode128(profile, region) {
  const roughSpan = region[1] - region[0];
  // Every plausible length and start character, ranked by how well the start and stop patterns fit.
  const outlines = [];
  for (let symbols = 4; symbols <= 40; symbols += 1) {
    const total = symbols * 11 + 13;
    if (roughSpan / total < 1.5) break;
    const known = new Float32Array(total).fill(0.5);
    C128_STOP.forEach((b, k) => { known[symbols * 11 + k] = b; });
    const partSets = C128_STARTS.map((start) => {
      const withStart = Float32Array.from(known);
      start.bits.forEach((b, k) => { withStart[k] = b; });
      return [{ modules: withStart, from: 0, to: 12 }, { modules: withStart, from: total - 14, to: total }];
    });
    candidateLayouts(profile, region, total, partSets, [0.7, 1.1], 1).forEach(([top], i) => {
      if (top) outlines.push({ ...top, symbols, start: C128_STARTS[i], known, parts: partSets[i] });
    });
  }
  outlines.sort((a, b) => b.score - a.score);
  let best = null;
  for (const outline of outlines.slice(0, 3)) {
    const { symbols, start, known } = outline;
    const { layout } = refineLayout(profile, outline, symbols * 11 + 13, outline.parts);
    const slots = Array.from({ length: symbols }, (_, i) => ({ at: i * 11, size: 11, options: i === 0 ? [start] : C128_DATA }));
    const ranked = decodeSlots(profile, layout, known, slots);
    const picks = ranked.map((list) => list[0]);
    const average = picks.reduce((sum, o) => sum + o.score, 0) / symbols;
    if (!best || average > best.average) best = { ranked, picks, average, layout, slots, known };
  }
  const accept = (picks, score) => {
    const values = picks.map((o) => o.value);
    if (checkOf(values.slice(0, -1)) !== values.at(-1)) return null;
    const text = code128Text(values.slice(0, -1));
    return text && CODE_FORMAT.test(text) ? { code: text, score } : null;
  };
  const passes = (b) => b.average >= MIN_AVERAGE && Math.min(...b.picks.map((o) => o.score)) >= MIN_SYMBOL;
  if (!best) return null;
  const first = passes(best) && accept(best.picks, best.average);
  if (first) return first;
  // Fit the outline to the whole first reading, then read again: small barcodes need the closer fit.
  for (let round = 0; best && round < 2; round += 1) {
    const total = best.slots.length * 11 + 13;
    const modules = Float32Array.from(best.known);
    best.picks.forEach((pick, i) => pick.bits.forEach((bit, k) => { modules[i * 11 + k] = bit; }));
    const layout = fitWholeCode(profile, best.layout, modules, total);
    const ranked = decodeSlots(profile, layout, best.known, best.slots);
    const picks = ranked.map((list) => list[0]);
    const average = picks.reduce((sum, o) => sum + o.score, 0) / picks.length;
    if (average <= best.average) break;
    best = { ...best, ranked, picks, average, layout };
  }
  if (!passes(best)) return null;
  const plain = accept(best.picks, best.average);
  if (plain) return plain;
  // The last symbol is the check. When it does not add up, small blurred barcodes usually have a few symbols
  // whose runner-up was the right one. Try close runners-up, keep combinations the check accepts, and take
  // the one that best explains the whole strip, only if it explains it very well.
  const choices = best.ranked.map((list, i) => (i === 0 ? [list[0]] : list.filter((o) => o.score >= list[0].score - CLOSE_RUNNER_UP).slice(0, 3)));
  const combinations = choices.reduce((count, list) => count * list.length, 1);
  if (combinations > MAX_COMBINATIONS) return null;
  const total = best.slots.length * 11 + 13;
  let found = null;
  const walk = (i, picks) => {
    if (i === choices.length) {
      if (!accept(picks, 0)) return;
      const modules = Float32Array.from(best.known);
      picks.forEach((pick, k) => pick.bits.forEach((bit, j) => { modules[k * 11 + j] = bit; }));
      const whole = fit(profile, best.layout, modules, 0, total);
      if (whole >= MIN_WHOLE_FIT && (!found || whole > found.score)) found = accept(picks, whole);
      return;
    }
    for (const option of choices[i]) walk(i + 1, [...picks, option]);
  };
  walk(0, []);
  return found;
}

// ---- Entry point --------------------------------------------------------------------------------------

// Reads one brightness strip (light = high) running across a barcode.
// Returns { code, score } (score: 0–1, how closely the blurred bars match), or null.
export function readBlurredStripDetail(profile) {
  const forward = Float32Array.from(profile);
  let best = null;
  for (const strip of [forward, Float32Array.from(forward).reverse()]) {
    for (const region of barRegions(strip)) {
      // Both types are tried and the closer fit wins, so a Code 128 label is never taken for an EAN-13.
      for (const found of [...EAN_FORMATS.map((format) => readEan(strip, region, format)), readCode128(strip, region)]) {
        if (found && (!best || found.score > best.score)) best = found;
      }
    }
  }
  return best;
}

export function readBlurredStrip(profile) {
  return readBlurredStripDetail(profile)?.code ?? null;
}

// How much a strip looks like it crosses a barcode: bars are vertical, so the strip STRIP_GAP strips lower
// looks nearly the same over the bars (text and pictures change), and bars alternate light/dark many times.
const STRIP_GAP = 2;
const WINDOW = 120;
function barcodeLikeness(strip, lower) {
  let best = 0;
  for (let x0 = 0; x0 + WINDOW <= strip.length; x0 += 30) {
    let ma = 0; let mb = 0;
    for (let x = x0; x < x0 + WINDOW; x += 1) { ma += strip[x]; mb += lower[x]; }
    ma /= WINDOW; mb /= WINDOW;
    let num = 0; let da = 0; let db = 0; let crossings = 0; let previous = 0;
    for (let x = x0; x < x0 + WINDOW; x += 1) {
      const u = strip[x] - ma; const v = lower[x] - mb;
      num += u * v; da += u * u; db += v * v;
      const sign = Math.sign(u);
      if (sign && previous && sign !== previous) crossings += 1;
      if (sign) previous = sign;
    }
    if (Math.sqrt(da / WINDOW) < 8 || crossings < 8 || !db) continue;
    best = Math.max(best, (num / Math.sqrt(da * db)) * Math.min(crossings, 30));
  }
  return best;
}

// Picks which strips of a frame (each half a strip below the last) are worth reading, most barcode-like first.
export function stripsToTry(profiles) {
  const likely = profiles
    .map((profile, index) => ({ index, score: index + STRIP_GAP < profiles.length ? barcodeLikeness(profile, profiles[index + STRIP_GAP]) : 0 }))
    .filter((strip) => strip.score >= 5);
  // Neighbouring barcode-like strips cross one barcode. Its top and bottom strips only partly cover the
  // bars, so each group is tried from its middle outwards, the most barcode-like group first.
  const groups = [];
  for (const strip of likely) {
    const last = groups.at(-1);
    if (last && strip.index - last.at(-1).index <= STRIP_GAP) last.push(strip); else groups.push([strip]);
  }
  return groups
    .sort((a, b) => Math.max(...b.map((s) => s.score)) - Math.max(...a.map((s) => s.score)))
    .flatMap((group) => {
      const middle = (group[0].index + group.at(-1).index) / 2;
      return group.slice().sort((a, b) => Math.abs(a.index - middle) - Math.abs(b.index - middle)).map((s) => s.index);
    });
}
