import dictionary from './translations.json' with { type: 'json' };
import extra from './extra.js';

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ta', label: 'தமிழ்' },
  { code: 'si', label: 'සිංහල' }
];

const exact = {
  ta: { ...dictionary.exact.ta, ...extra.ta },
  si: { ...dictionary.exact.si, ...extra.si }
};

function compileWildcards(rules) {
  return rules.map(([english, translated]) => {
    const kinds = [];
    const pattern = english
      .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
      .replace(/\\?\{(\\?\*|n)\\?\}|\{\*\}|\{n\}/g, (match) => {
        const kind = match.includes('*') ? '*' : 'n';
        kinds.push(kind);
        return kind === '*' ? '(.+?)' : '(\\d+(?:,\\d{3})*(?:\\.\\d+)?)';
      });
    return { pattern: new RegExp(`^${pattern}$`), kinds, translated };
  });
}

const wildcards = { ta: compileWildcards(dictionary.wild.ta), si: compileWildcards(dictionary.wild.si) };

function translateCore(core, language, depth, skipWildcards) {
  const phrases = exact[language];
  if (phrases[core] != null) return phrases[core];

  const numbers = [];
  const template = core.replace(/\d+(?:,\d{3})*(?:\.\d+)?/g, (match) => {
    numbers.push(match);
    return `{${numbers.length - 1}}`;
  });
  if (numbers.length && phrases[template] != null) {
    return phrases[template].replace(/\{(\d+)\}/g, (_, index) => numbers[Number(index)]);
  }

  if (!skipWildcards && depth < 3) {
    for (const rule of wildcards[language]) {
      const match = core.match(rule.pattern);
      if (match) {
        let position = 0;
        return rule.translated.replace(/\{\*\}|\{n\}/g, () => {
          position += 1;
          const value = match[position];
          return rule.kinds[position - 1] === '*' ? translateText(value, language, depth + 1) ?? value : value;
        });
      }
    }
  }

  const words = dictionary.words[language];
  const tokens = core.match(/[A-Za-z]+/g);
  if (tokens && tokens.every((token) => words[token])) return core.replace(/[A-Za-z]+/g, (token) => words[token]);
  return null;
}

// Returns null when no translation is known, so callers can tell a gap from a real result.
function translateText(text, language, depth = 0) {
  const [, before, core, after] = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!core || !/[A-Za-z]/.test(core)) return null;
  const parts = core.match(/^([^\p{L}\p{N}]*)([\s\S]*?)([^\p{L}\p{N})%]*)$/u);
  const stripped = parts && (parts[1] || parts[3]) ? parts[2] : null;

  for (const skipWildcards of [true, false]) {
    const whole = translateCore(core, language, depth, skipWildcards);
    if (whole != null) return before + whole + after;
    if (stripped) {
      const inner = translateCore(stripped, language, depth, skipWildcards);
      if (inner != null) return before + parts[1] + inner + parts[3] + after;
    }
  }

  for (const separator of [' · ', '; ', ': ', '. ', ', ', ' — ']) {
    if (core.includes(separator) && depth < 4) {
      const pieces = core.split(separator);
      const translated = pieces.map((piece) => translateText(piece, language, depth + 1) ?? piece);
      if (translated.some((piece, index) => piece !== pieces[index])) return before + translated.join(separator) + after;
    }
  }
  return null;
}

export function hasTranslation(text, language) {
  return translateText(text, language) != null;
}

export function translate(text, language) {
  if (language === 'en' || !exact[language]) return text;
  return translateText(text, language) ?? text;
}
