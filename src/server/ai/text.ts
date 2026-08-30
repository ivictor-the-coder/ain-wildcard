/**
 * Text primitives for the built-in reasoning engine.
 *
 * Everything here is deterministic and dependency-free: the same question
 * always produces the same tokens, the same similarity scores and therefore the
 * same answer, which is what makes the engine testable and the traces honest.
 */

const ACCENTS: Record<string, string> = {
  á: 'a', à: 'a', â: 'a', ä: 'a', ã: 'a', å: 'a', ā: 'a',
  é: 'e', è: 'e', ê: 'e', ë: 'e', ē: 'e',
  í: 'i', ì: 'i', î: 'i', ï: 'i', ī: 'i',
  ó: 'o', ò: 'o', ô: 'o', ö: 'o', õ: 'o', ø: 'o', ō: 'o',
  ú: 'u', ù: 'u', û: 'u', ü: 'u', ū: 'u',
  ñ: 'n', ç: 'c', ß: 'ss', æ: 'ae', œ: 'oe', ł: 'l', ż: 'z', ź: 'z', ś: 's', ć: 'c', ę: 'e', ą: 'a',
};

export function foldAccents(input: string): string {
  let out = '';
  for (const ch of input) out += ACCENTS[ch] ?? ch;
  return out;
}

/** Lowercase, accent-folded, punctuation collapsed to single spaces. */
export function normalise(input: string): string {
  return foldAccents(String(input).toLowerCase())
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Like `normalise` but keeps `@`, `.` and `_` so emails, domains and ids survive. */
export function normaliseLoose(input: string): string {
  return foldAccents(String(input).toLowerCase())
    .replace(/[^a-z0-9@._+-]+/g, ' ')
    .trim();
}

export const words = (input: string): string[] => normalise(input).split(' ').filter(Boolean);

/**
 * Words that carry no discriminating power in a business question. Kept small
 * on purpose — "open", "new" and "lost" are stage names, not noise.
 */
export const STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'is', 'are',
  'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', 'we', 'i', 'you', 'they', 'it', 'its',
  'our', 'us', 'me', 'my', 'their', 'them', 'this', 'that', 'these', 'those', 'there', 'here',
  'as', 'or', 'but', 'if', 'so', 'than', 'then', 'about', 'into', 'over', 'per', 'via', 'up',
  'please', 'thanks', 'thank', 'hey', 'hi', 'hello', 'ok', 'okay', 'just', 'can', 'could', 'would',
  'should', 'will', 'shall', 'may', 'might', 'much', 'many', 'any', 'some', 'all', 'each', 'every',
  'give', 'get', 'got', 'need', 'want', 'like', 'know', 'let', 'make', 'take', 'go', 'going',
]);

/** Corporate suffixes that must never be the thing that matches a company. */
export const COMPANY_NOISE = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'plc', 'gmbh', 'ag', 'sa', 'sas', 'srl', 'spa',
  'bv', 'nv', 'ab', 'as', 'oy', 'kk', 'co', 'corp', 'corporation', 'company', 'holdings', 'group',
  'international', 'global', 'worldwide', 'the', 'and', 'of',
]);

export const contentWords = (input: string): string[] => words(input).filter((w) => !STOPWORDS.has(w));

/** Character trigrams with boundary padding, the workhorse of fuzzy matching. */
export function trigrams(input: string): Set<string> {
  const padded = `  ${normalise(input)} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) {
    const gram = padded.slice(i, i + 3);
    if (gram.trim()) out.add(gram);
  }
  return out;
}

export function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const gram of small) if (large.has(gram)) shared++;
  return (2 * shared) / (a.size + b.size);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const gram of small) if (large.has(gram)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Trigram Dice coefficient between two raw strings. */
export const trigramSimilarity = (a: string, b: string): number => dice(trigrams(a), trigrams(b));

/** Bounded Levenshtein — returns `max + 1` as soon as it is certain to exceed. */
export function levenshtein(a: string, b: string, max = 8): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let best = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < best) best = curr[j];
    }
    if (best > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/** 1 for identical strings, 0 for nothing in common — typo tolerance. */
export function editSimilarity(a: string, b: string): number {
  const x = normalise(a);
  const y = normalise(b);
  if (!x || !y) return 0;
  const longest = Math.max(x.length, y.length);
  const distance = levenshtein(x, y, Math.ceil(longest / 2));
  return distance > longest ? 0 : 1 - distance / longest;
}

/** "Calder & Vance Manufacturing" → "cvm"; noise words never contribute. */
export function acronymOf(name: string): string {
  const parts = words(name).filter((w) => !COMPANY_NOISE.has(w));
  if (parts.length < 2) return '';
  return parts.map((w) => w[0]).join('');
}

/** The distinctive core of a company name: no legal suffixes, no filler. */
export function coreName(name: string): string {
  const parts = words(name).filter((w) => !COMPANY_NOISE.has(w));
  return (parts.length ? parts : words(name)).join(' ');
}

const SUFFIXES: [RegExp, string][] = [
  [/ies$/, 'y'], [/([^aeiou])ies$/, '$1y'], [/sses$/, 'ss'], [/ches$/, 'ch'], [/shes$/, 'sh'],
  [/xes$/, 'x'], [/([^s])s$/, '$1'], [/ing$/, ''], [/edly$/, ''], [/ed$/, ''], [/ly$/, ''],
];

/** A light stemmer: enough to make "invoices"/"invoice" and "paying"/"pay" agree. */
export function stem(word: string): string {
  if (word.length <= 3) return word;
  for (const [re, to] of SUFFIXES) {
    if (re.test(word)) {
      const out = word.replace(re, to);
      if (out.length >= 3) return out;
    }
  }
  return word;
}

export const stems = (input: string): Set<string> => new Set(contentWords(input).map(stem));

/** Overlap of stemmed content words, normalised by the shorter side. */
export function tokenOverlap(a: string, b: string): number {
  const x = stems(a);
  const y = stems(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared / Math.min(x.size, y.size);
}

/* ------------------------------ prose helpers ---------------------------- */

export function truncate(input: string, max: number): string {
  const s = String(input).trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export const capitalise = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Domain acronyms that must not be sentence-cased into nonsense. */
const ACRONYMS = new Set(['qbr', 'api', 'sla', 'crm', 'mrr', 'arr', 'acv', 'tcv', 'csat', 'nps', 'ai', 'it', 'ot', 'plc', 'cnc', 'erp', 'mes', 'roi', 'sqf', 'ceo', 'cto', 'cfo', 'vp', 'sme', 'poc', 'rfp', 'sow']);

/** "closed_won" → "Closed won", "qbr" → "QBR"; pretty labels pass through. */
export function humanise(value: string): string {
  if (!value) return '';
  if (/[a-z][A-Z]/.test(value) || /\s/.test(value)) return value;
  const spaced = value.replace(/[_-]+/g, ' ');
  return spaced
    .split(' ')
    .map((word, i) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : i === 0 ? capitalise(word) : word))
    .join(' ');
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : pluralForm ?? `${singular}s`;
}

export function countOf(count: number, singular: string, pluralForm?: string): string {
  return `${count.toLocaleString('en-US')} ${plural(count, singular, pluralForm)}`;
}

/** "a", "a and b", "a, b and c" — Oxford-free, the way people write. */
export function listPhrase(items: string[], conjunction = 'and'): string {
  const parts = items.filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} ${conjunction} ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} ${conjunction} ${parts[parts.length - 1]}`;
}

export function sentenceJoin(parts: string[]): string {
  return parts.map((p) => p.trim()).filter(Boolean).map((p) => (/[.!?]$/.test(p) ? p : `${p}.`)).join(' ');
}

/** Split prose into sentences without a regex that eats abbreviations. */
export function sentences(text: string): string[] {
  return String(text)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const firstName = (fullName: string): string => String(fullName).trim().split(/\s+/)[0] || '';

/** Percentage change, guarding the divide-by-zero every dashboard gets wrong. */
export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export function formatPercent(value: number, digits = 1): string {
  const rounded = Number(value.toFixed(digits));
  return `${rounded > 0 ? '' : ''}${rounded}%`;
}

export function formatSignedPercent(value: number, digits = 1): string {
  const rounded = Number(value.toFixed(digits));
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

export const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
export const DOMAIN_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|io|net|org|co|ai|dev|de|fr|jp|kr|cn|br|nl|se|it|es|pl|tr|in)\b/gi;
export const ID_PATTERN = /\b[a-z][a-z_]{1,12}_[A-Za-z0-9]{6,40}\b/g;
export const QUOTED_PATTERN = /["“”']([^"“”']{2,80})["“”']/g;
export const MONEY_PATTERN = /(?:[$€£¥])\s?([0-9][0-9,.]*)\s?([kmb]|thousand|million|billion)?/gi;

/** Contiguous runs of Capitalised words — how people name accounts in prose. */
export function properNounSpans(text: string): string[] {
  const out: string[] = [];
  const re = /\b([A-Z][A-Za-z0-9&'’.-]*(?:\s+(?:&|of|de|van|von)?\s*[A-Z][A-Za-z0-9&'’.-]*)*)/g;
  for (const match of text.matchAll(re)) {
    const span = match[1].trim();
    if (span.length >= 2) out.push(span);
  }
  return out;
}

/** All 1..n word windows of a string, longest first — candidate entity names. */
export function ngramSpans(text: string, maxWords = 4): string[] {
  const tokens = normalise(text).split(' ').filter(Boolean);
  const out: string[] = [];
  for (let size = Math.min(maxWords, tokens.length); size >= 1; size--) {
    for (let i = 0; i + size <= tokens.length; i++) {
      out.push(tokens.slice(i, i + size).join(' '));
    }
  }
  return out;
}
