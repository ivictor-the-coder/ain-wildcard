/**
 * Money is represented in integer minor units (cents) exactly like Stripe.
 * All intermediate arithmetic (proration, tiering, tax) is done with exact
 * rational numbers backed by BigInt so we never accumulate float drift, and
 * rounding to minor units happens once, at the boundary.
 */

export type Currency = string; // ISO-4217 lowercase, e.g. 'usd'

export interface Money {
  /** Integer amount in the currency's minor unit. May be negative. */
  amount: number;
  currency: Currency;
}

/** Currencies whose minor unit is not 1/100. */
const EXPONENTS: Record<string, number> = {
  bif: 0, clp: 0, djf: 0, gnf: 0, jpy: 0, kmf: 0, krw: 0, mga: 0, pyg: 0,
  rwf: 0, ugx: 0, vnd: 0, vuv: 0, xaf: 0, xof: 0, xpf: 0,
  bhd: 3, iqd: 3, jod: 3, kwd: 3, lyd: 3, omr: 3, tnd: 3,
};

export function exponentOf(currency: Currency): number {
  return EXPONENTS[currency.toLowerCase()] ?? 2;
}

export function money(amount: number, currency: Currency): Money {
  if (!Number.isFinite(amount)) throw new Error(`money(): non-finite amount ${amount}`);
  return { amount: Math.round(amount), currency: currency.toLowerCase() };
}

export const zero = (currency: Currency): Money => ({ amount: 0, currency: currency.toLowerCase() });

export function assertSame(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSame(a, b);
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function sub(a: Money, b: Money): Money {
  assertSame(a, b);
  return { amount: a.amount - b.amount, currency: a.currency };
}

export function neg(a: Money): Money {
  return { amount: -a.amount, currency: a.currency };
}

export function sum(items: Money[], currency: Currency): Money {
  return items.reduce((acc, m) => add(acc, m), zero(currency));
}

export const isZero = (m: Money) => m.amount === 0;
export const isNegative = (m: Money) => m.amount < 0;
export const isPositive = (m: Money) => m.amount > 0;
export const cmp = (a: Money, b: Money) => { assertSame(a, b); return a.amount - b.amount; };
export const maxMoney = (a: Money, b: Money) => (cmp(a, b) >= 0 ? a : b);
export const minMoney = (a: Money, b: Money) => (cmp(a, b) <= 0 ? a : b);

/* ------------------------------------------------------------------ *
 * Exact rational arithmetic (BigInt numerator / denominator)
 * ------------------------------------------------------------------ */

export interface Rational {
  n: bigint;
  d: bigint; // always > 0
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) { const t = a % b; a = b; b = t; }
  return a || 1n;
}

export function rat(n: bigint | number, d: bigint | number = 1n): Rational {
  let nn = typeof n === 'bigint' ? n : BigInt(Math.round(n));
  let dd = typeof d === 'bigint' ? d : BigInt(Math.round(d));
  if (dd === 0n) throw new Error('rat(): zero denominator');
  if (dd < 0n) { nn = -nn; dd = -dd; }
  const g = gcd(nn, dd);
  return { n: nn / g, d: dd / g };
}

export const ratAdd = (a: Rational, b: Rational): Rational => rat(a.n * b.d + b.n * a.d, a.d * b.d);
export const ratSub = (a: Rational, b: Rational): Rational => rat(a.n * b.d - b.n * a.d, a.d * b.d);
export const ratMul = (a: Rational, b: Rational): Rational => rat(a.n * b.n, a.d * b.d);
export const ratDiv = (a: Rational, b: Rational): Rational => {
  if (b.n === 0n) throw new Error('ratDiv(): division by zero');
  return rat(a.n * b.d, a.d * b.n);
};
export const ratCmp = (a: Rational, b: Rational): number => {
  const l = a.n * b.d, r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
};
export const ratToNumber = (a: Rational): number => Number(a.n) / Number(a.d);

export type RoundingMode = 'half_up' | 'half_even' | 'up' | 'down';

/** Round an exact rational to an integer using the given mode. */
export function ratRound(v: Rational, mode: RoundingMode = 'half_up'): bigint {
  const neg = v.n < 0n;
  const n = neg ? -v.n : v.n;
  const q = n / v.d;
  const r = n % v.d;
  if (r === 0n) return neg ? -q : q;
  let out: bigint;
  switch (mode) {
    case 'up': out = q + 1n; break;
    case 'down': out = q; break;
    case 'half_even': {
      const twice = r * 2n;
      if (twice > v.d) out = q + 1n;
      else if (twice < v.d) out = q;
      else out = q % 2n === 0n ? q : q + 1n;
      break;
    }
    case 'half_up':
    default: {
      const twice = r * 2n;
      out = twice >= v.d ? q + 1n : q;
      break;
    }
  }
  return neg ? -out : out;
}

/** Convert an exact rational amount of minor units into Money. */
export function ratToMoney(v: Rational, currency: Currency, mode: RoundingMode = 'half_up'): Money {
  return { amount: Number(ratRound(v, mode)), currency: currency.toLowerCase() };
}

export const moneyToRat = (m: Money): Rational => rat(BigInt(m.amount));

/** Multiply money by an exact fraction; rounds once at the end. */
export function mulFraction(m: Money, numerator: bigint | number, denominator: bigint | number, mode: RoundingMode = 'half_up'): Money {
  return ratToMoney(ratMul(moneyToRat(m), rat(numerator, denominator)), m.currency, mode);
}

/**
 * Split money into `parts` shares that sum exactly back to the original,
 * distributing remainder pennies to the earliest shares (largest-remainder).
 */
export function allocate(m: Money, weights: number[]): Money[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0) return weights.map(() => zero(m.currency));
  const base: number[] = [];
  let allocated = 0;
  for (const w of weights) {
    const share = Math.trunc((m.amount * w) / total);
    base.push(share);
    allocated += share;
  }
  let remainder = m.amount - allocated;
  const step = remainder >= 0 ? 1 : -1;
  const order = weights
    .map((w, i) => ({ i, frac: Math.abs((m.amount * w) / total - base[i]) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  let k = 0;
  while (remainder !== 0 && order.length) {
    base[order[k % order.length].i] += step;
    remainder -= step;
    k++;
  }
  return base.map((amount) => ({ amount, currency: m.currency }));
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

const fmtCache = new Map<string, Intl.NumberFormat>();

export interface FormatOptions {
  locale?: string;
  /** Drop the fraction when the amount is a whole unit (e.g. $12 instead of $12.00). */
  trimZeroFraction?: boolean;
  /** Show as a compact figure, e.g. $1.2M. */
  compact?: boolean;
  signDisplay?: 'auto' | 'always' | 'never' | 'exceptZero';
}

export function formatMoney(m: Money, opts: FormatOptions = {}): string {
  const locale = opts.locale || 'en-US';
  const exp = exponentOf(m.currency);
  const whole = m.amount % 10 ** exp === 0;
  const digits = opts.trimZeroFraction && whole ? 0 : exp;
  const key = `${locale}|${m.currency}|${digits}|${opts.compact ? 'c' : 'n'}|${opts.signDisplay || 'auto'}`;
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: m.currency.toUpperCase(),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      notation: opts.compact ? 'compact' : 'standard',
      signDisplay: opts.signDisplay || 'auto',
    });
    fmtCache.set(key, f);
  }
  return f.format(m.amount / 10 ** exp);
}

/** Parse a human string like "12.50" into minor units for the currency. */
export function parseMoney(input: string, currency: Currency): Money {
  const cleaned = input.replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') throw new Error(`parseMoney(): cannot parse "${input}"`);
  const exp = exponentOf(currency);
  const negative = cleaned.startsWith('-');
  const [intPart = '0', fracPart = ''] = cleaned.replace('-', '').split('.');
  const frac = (fracPart + '0'.repeat(exp)).slice(0, exp);
  const roundUp = exp < fracPart.length && Number(fracPart[exp]) >= 5 ? 1 : 0;
  const minor = BigInt(intPart || '0') * BigInt(10 ** exp) + BigInt(frac || '0') + BigInt(roundUp);
  return { amount: Number(negative ? -minor : minor), currency: currency.toLowerCase() };
}

export const toMajor = (m: Money): number => m.amount / 10 ** exponentOf(m.currency);
