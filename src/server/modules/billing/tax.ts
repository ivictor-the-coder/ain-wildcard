/**
 * Tax.
 *
 * The catalog has always recorded a `tax_behavior` on every price; this file is
 * where that field finally decides a number. Three rules, and everything else
 * follows from them:
 *
 *  1. **A line's `amount` is its taxable base.** For an `exclusive` price that
 *     is the price itself and the tax is added on top. For an `inclusive` price
 *     the listed number already contains the tax, so the tax is *extracted* out
 *     of it and the base is what is left. That is the whole difference between
 *     the two behaviours, and it is why an inclusive price and an exclusive one
 *     must never produce the same invoice.
 *  2. **Rounding happens once per rate**, on an exact rational, and the halves
 *     are made to add up by subtraction rather than by rounding twice — an
 *     inclusive line's base is `amount - tax`, always, to the cent. A line in
 *     three jurisdictions rounds three times, once each, and never rounds one
 *     jurisdiction's tax on top of another's.
 *  3. **Zero tax is still an answer.** A reverse-charged B2B supply into the EU
 *     is 0%, but the invoice says so, names the rate it would have been and
 *     says why. A bill that is silent about tax cannot be sent to a customer in
 *     most of the world; a bill that says "VAT 19% — reverse charged, customer
 *     accounts for the tax" can.
 */
import type { Ctx } from '../../kernel/context';
import { badRequest, conflict, notFound } from '../../../shared/errors';
import { newId } from '../../../shared/ids';
import { rat, ratAdd, ratDiv, ratMul, ratToMoney, type Rational } from '../../../shared/money';
import type { TaxBehavior } from '../catalog/types';
import type { Customer, TaxId, TaxIdVerification } from './types';

/* --------------------------------- the rate ------------------------------- */

export const TAX_TYPES = [
  'vat', 'gst', 'sales_tax', 'hst', 'pst', 'qst', 'jct', 'igst', 'service_tax', 'other',
] as const;
export type TaxType = (typeof TAX_TYPES)[number];

/**
 * Why a line was taxed the way it was. Every line carries one, so "why is there
 * no VAT on this invoice?" is answered by the invoice rather than by an email.
 */
export const TAX_REASONS = ['taxable', 'reverse_charge', 'exempt', 'no_rate'] as const;
export type TaxReason = (typeof TAX_REASONS)[number];

/** Stripe's three states, and they mean the same things here. */
export const TAX_EXEMPTIONS = ['none', 'exempt', 'reverse'] as const;
export type TaxExemption = (typeof TAX_EXEMPTIONS)[number];

export interface TaxRate {
  object: 'tax_rate';
  id: string;
  /** What appears on the invoice: "VAT", "Sales tax", "MWST". */
  display_name: string;
  description: string | null;
  /** The place this rate belongs to, for a human: "Germany", "New York". */
  jurisdiction: string;
  /** ISO-3166-1 alpha-2, uppercase. */
  country: string;
  /** Set only on a sub-national rate; a country rate leaves it null. */
  state: string | null;
  tax_type: TaxType;
  /** An exact decimal string — "19", "8.875" — never a float. */
  percentage: string;
  /**
   * True when a business in this jurisdiction that supplies a registration
   * number accounts for the tax itself, so the supplier charges 0%.
   */
  reverse_charge: boolean;
  active: boolean;
  metadata: Record<string, string>;
  created: number;
  updated: number;
}

export interface TaxRateInput {
  display_name: string;
  description?: string | null;
  jurisdiction: string;
  country: string;
  state?: string | null;
  tax_type?: TaxType;
  percentage: string;
  reverse_charge?: boolean;
  active?: boolean;
  metadata?: Record<string, string>;
}

export function hydrateTaxRate(row: Record<string, unknown>): TaxRate {
  return {
    object: 'tax_rate',
    id: String(row.id),
    display_name: String(row.display_name),
    description: (row.description as string | null) ?? null,
    jurisdiction: String(row.jurisdiction),
    country: String(row.country),
    state: (row.state as string | null) ?? null,
    tax_type: row.tax_type as TaxType,
    percentage: String(row.percentage),
    reverse_charge: !!row.reverse_charge,
    active: !!row.active,
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : ((row.metadata as Record<string, string>) ?? {}),
    created: Number(row.created),
    updated: Number(row.updated),
  };
}

/* ------------------------------ exact percents ---------------------------- */

/**
 * "8.875" → 8875/1000, exactly. A percentage that arrives as a float has
 * already lost the argument; this is the only way one enters the system.
 */
export function percentToRat(percentage: string): Rational {
  const trimmed = percentage.trim();
  if (!/^\d{1,3}(\.\d{1,6})?$/.test(trimmed)) {
    throw badRequest(
      'tax_percentage_invalid',
      `"${percentage}" is not a tax percentage. Write it as a decimal between 0 and 100 with at most six decimal places, e.g. "19" or "8.875".`,
      'percentage',
    );
  }
  const [whole, fraction = ''] = trimmed.split('.');
  const scale = 10n ** BigInt(fraction.length);
  const value = rat(BigInt(whole) * scale + BigInt(fraction || '0'), scale);
  if (Number(value.n) / Number(value.d) > 100) {
    throw badRequest('tax_percentage_invalid', `A tax rate of ${percentage}% is not a rate anyone charges.`, 'percentage');
  }
  return value;
}

/** "19" not "19.00"; "8.875" kept whole. What a human would write. */
export const formatPercentage = (percentage: string): string =>
  percentage.includes('.') ? percentage.replace(/0+$/, '').replace(/\.$/, '') : percentage;

/**
 * An exact percentage back to the decimal string it came from.
 *
 * `percentToRat` reduces, so 0.375% is held as 3/8 rather than 375/1000; the
 * denominator still divides a million, because that is the most decimal places
 * a percentage may have here, so this scaling is exact and never a float. It is
 * what lets three stacked US rates print as the one combined "8.875%" a
 * customer recognises.
 */
export function formatRationalPercentage(value: Rational): string {
  const micro = (value.n * 1_000_000n) / value.d;
  const whole = micro / 1_000_000n;
  const fraction = (micro % 1_000_000n).toString().padStart(6, '0');
  return formatPercentage(`${whole}.${fraction}`);
}

/** Add exact percentages: "4" + "4.5" + "0.375" is "8.875", to the last place. */
export const combinePercentages = (percentages: string[]): string =>
  formatRationalPercentage(percentages.reduce((total, one) => ratAdd(total, percentToRat(one)), rat(0n)));

/** What to call a stack of rates that are all the same kind of tax. */
export const TAX_TYPE_LABELS: Record<TaxType, string> = {
  vat: 'VAT', gst: 'GST', sales_tax: 'Sales tax', hst: 'HST', pst: 'PST', qst: 'QST',
  jct: 'JCT', igst: 'IGST', service_tax: 'Service tax', other: 'Tax',
};

/* ------------------------------- jurisdictions ---------------------------- */

/**
 * The countries the workspace's own data actually spells out. A billing system
 * cannot guess at a country name, so anything not on this list has to arrive as
 * an ISO-3166 code, and an unmatched country simply has no rate — which is the
 * correct, and safe, answer.
 */
const COUNTRY_CODES: Record<string, string> = {
  argentina: 'AR', australia: 'AU', austria: 'AT', belgium: 'BE', brazil: 'BR', canada: 'CA',
  chile: 'CL', china: 'CN', colombia: 'CO', czechia: 'CZ', denmark: 'DK', finland: 'FI',
  france: 'FR', germany: 'DE', india: 'IN', ireland: 'IE', italy: 'IT', japan: 'JP',
  malaysia: 'MY', mexico: 'MX', netherlands: 'NL', norway: 'NO', poland: 'PL', portugal: 'PT',
  singapore: 'SG', 'south korea': 'KR', spain: 'ES', sweden: 'SE', switzerland: 'CH',
  türkiye: 'TR', turkey: 'TR', 'united kingdom': 'GB', 'great britain': 'GB',
  'united states': 'US', 'united states of america': 'US',
};

/**
 * What people type that is not the code the register uses. `UK` is the one that
 * matters: it is what a customer writes into an address field and `GB` is what
 * the rate is registered under, and reading them as two different countries is
 * how a British invoice quietly loses its VAT.
 */
const COUNTRY_ALIASES: Record<string, string> = { UK: 'GB', EL: 'GR' };

/**
 * Two letters that are a country, or two letters.
 *
 * ICU knows every ISO-3166-1 region and hands back the code itself when it does
 * not recognise one, so `ZZ` and `QQ` are refused here rather than travelling on
 * as a jurisdiction no rate can ever match and no invoice can ever explain.
 * `ZZ` is named separately because CLDR calls it "Unknown Region" — a display
 * name, which would otherwise read as a country that exists.
 *
 * A build shipped without region data would answer every code with itself;
 * there is nothing to check against then, so the check stands down rather than
 * refusing every address in the workspace.
 */
const REGION_NAMES: Intl.DisplayNames | null = (() => {
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    return names.of('DE') === 'DE' || names.of('QQ') !== 'QQ' ? null : names;
  } catch { return null; }
})();

export function isCountryCode(code: string): boolean {
  if (!/^[A-Z]{2}$/.test(code) || code === 'ZZ') return false;
  if (!REGION_NAMES) return true;
  try { return REGION_NAMES.of(code) !== code; } catch { return false; }
}

export function countryCode(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    const canonical = COUNTRY_ALIASES[trimmed.toUpperCase()] ?? trimmed.toUpperCase();
    if (isCountryCode(canonical)) return canonical;
  }
  return COUNTRY_CODES[trimmed.toLowerCase()] ?? null;
}

/**
 * The country a registration number is registered in. The prefix on the number
 * itself is the authority — `DE811234567` is German however the record spells
 * the country — and the recorded country is the fallback.
 *
 * A prefix only counts when something follows it. Two letters on their own are
 * a string a person typed into a field, not a registration, and treating them
 * as one is how a customer used to switch VAT off.
 */
export function taxIdCountry(taxId: TaxId): string | null {
  const value = normaliseTaxIdValue(taxId.type, taxId.value);
  const prefix = value.slice(0, 2);
  if (/^[A-Z]{2}[A-Z0-9]/.test(value)) {
    // The EU writes Greece as EL and the UK's numbers start GB; everything else
    // that starts with two letters starts with its own ISO code.
    if (prefix === 'EL') return 'GR';
    if (prefix === 'XI') return 'GB';
    if (COUNTRY_CODE_SET.has(prefix)) return prefix;
  }
  const fromType = /^([a-z]{2})_/.exec(taxId.type);
  if (fromType && fromType[1] !== 'eu' && COUNTRY_CODE_SET.has(fromType[1].toUpperCase())) {
    return fromType[1].toUpperCase();
  }
  return countryCode(taxId.country);
}

const COUNTRY_CODE_SET = new Set(Object.values(COUNTRY_CODES).concat(['GR', 'BG', 'HR', 'CY', 'EE', 'HU', 'LV', 'LT', 'LU', 'MT', 'RO', 'SK', 'SI']));

/* ----------------------------- registration ids --------------------------- */

/**
 * What a registration number of each kind actually looks like.
 *
 * This table is the difference between a tax id and a text field. Without it
 * `"DE"` is a German VAT registration, and two characters of customer-supplied
 * text take 19% off every invoice while the supplier stays liable for it. Each
 * entry names the shape, an example a human can compare against, and — for the
 * EU, where the number is the country — the per-member-state format, because
 * `DE` is nine digits and `NL` is nine digits, a `B` and two more.
 */
interface TaxIdFormat {
  /** What to call it in an error message: "an EU VAT registration number". */
  label: string;
  pattern: RegExp;
  example: string;
  /** Set on EU VAT, where each member state has its own shape. */
  byCountry?: Record<string, { pattern: RegExp; example: string }>;
}

const EU_VAT_FORMATS: Record<string, { pattern: RegExp; example: string }> = {
  AT: { pattern: /^ATU\d{8}$/, example: 'ATU12345678' },
  BE: { pattern: /^BE[01]\d{9}$/, example: 'BE0123456789' },
  BG: { pattern: /^BG\d{9,10}$/, example: 'BG123456789' },
  CY: { pattern: /^CY\d{8}[A-Z]$/, example: 'CY12345678L' },
  CZ: { pattern: /^CZ\d{8,10}$/, example: 'CZ12345678' },
  DE: { pattern: /^DE\d{9}$/, example: 'DE811907980' },
  DK: { pattern: /^DK\d{8}$/, example: 'DK12345678' },
  EE: { pattern: /^EE\d{9}$/, example: 'EE123456789' },
  EL: { pattern: /^EL\d{9}$/, example: 'EL123456789' },
  ES: { pattern: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/, example: 'ESA12345674' },
  FI: { pattern: /^FI\d{8}$/, example: 'FI12345678' },
  FR: { pattern: /^FR[A-Z0-9]{2}\d{9}$/, example: 'FRAB123456789' },
  HR: { pattern: /^HR\d{11}$/, example: 'HR12345678901' },
  HU: { pattern: /^HU\d{8}$/, example: 'HU12345678' },
  IE: { pattern: /^IE(\d{7}[A-W]{1,2}|\d[A-Z+*]\d{5}[A-W])$/, example: 'IE1234567FA' },
  IT: { pattern: /^IT\d{11}$/, example: 'IT12345678901' },
  LT: { pattern: /^LT(\d{9}|\d{12})$/, example: 'LT123456789' },
  LU: { pattern: /^LU\d{8}$/, example: 'LU12345678' },
  LV: { pattern: /^LV\d{11}$/, example: 'LV12345678901' },
  MT: { pattern: /^MT\d{8}$/, example: 'MT12345678' },
  NL: { pattern: /^NL\d{9}B\d{2}$/, example: 'NL123456789B01' },
  PL: { pattern: /^PL\d{10}$/, example: 'PL1234567890' },
  PT: { pattern: /^PT\d{9}$/, example: 'PT123456789' },
  RO: { pattern: /^RO\d{2,10}$/, example: 'RO1234567890' },
  SE: { pattern: /^SE\d{12}$/, example: 'SE123456789001' },
  SI: { pattern: /^SI\d{8}$/, example: 'SI12345678' },
  SK: { pattern: /^SK\d{10}$/, example: 'SK1234567890' },
  XI: { pattern: /^XI(\d{9}|\d{12})$/, example: 'XI123456789' },
};

const TAX_ID_FORMATS: Record<string, TaxIdFormat> = {
  eu_vat: {
    label: 'an EU VAT registration number',
    pattern: /^[A-Z]{2}[A-Z0-9]{2,12}$/,
    example: 'DE811907980',
    byCountry: EU_VAT_FORMATS,
  },
  gb_vat: { label: 'a UK VAT registration number', pattern: /^GB(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/, example: 'GB123456789' },
  ch_vat: { label: 'a Swiss VAT number', pattern: /^CHE\d{9}(MWST|TVA|IVA)?$/, example: 'CHE123456789MWST' },
  no_vat: { label: 'a Norwegian VAT number', pattern: /^NO\d{9}MVA$/, example: 'NO123456789MVA' },
  us_ein: { label: 'a US Employer Identification Number', pattern: /^\d{2}-\d{7}$/, example: '12-3456789' },
  au_abn: { label: 'an Australian Business Number', pattern: /^\d{11}$/, example: '12345678901' },
  au_acn: { label: 'an Australian Company Number', pattern: /^\d{9}$/, example: '123456789' },
  nz_gst: { label: 'a New Zealand GST number', pattern: /^\d{8,9}$/, example: '123456789' },
  in_gst: { label: 'an Indian GSTIN', pattern: /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/, example: '27AAPFU0939F1ZV' },
  ca_bn: { label: 'a Canadian Business Number', pattern: /^\d{9}$/, example: '123456789' },
  ca_gst_hst: { label: 'a Canadian GST/HST number', pattern: /^\d{9}RT\d{4}$/, example: '123456789RT0001' },
  jp_ct: { label: 'a Japanese Corporate Number', pattern: /^T?\d{13}$/, example: 'T1234567890123' },
  sg_gst: { label: 'a Singapore GST registration number', pattern: /^(M\d|\d{2})[A-Z0-9]{7}[A-Z]$/, example: '12345678M' },
  za_vat: { label: 'a South African VAT number', pattern: /^4\d{9}$/, example: '4123456789' },
  tr_tin: { label: 'a Turkish tax identification number', pattern: /^\d{10}$/, example: '1234567890' },
  mx_rfc: { label: 'a Mexican RFC', pattern: /^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/, example: 'ABC010203AB9' },
  br_cnpj: { label: 'a Brazilian CNPJ', pattern: /^\d{14}$/, example: '12345678000195' },
  kr_brn: { label: 'a Korean Business Registration Number', pattern: /^\d{3}-\d{2}-\d{5}$/, example: '123-45-67890' },
};

/** The registration kinds this workspace knows how to read, for the docs. */
export const TAX_ID_TYPES = Object.keys(TAX_ID_FORMATS);

/**
 * How a registration number is stored: the way the authority writes it.
 *
 * Spaces, dots and lower case are how humans type a VAT number and never how a
 * register holds one, so they come off here — once, on the way in — and every
 * comparison afterwards is between two numbers in the same form.
 */
export function normaliseTaxIdValue(type: string, value: string): string {
  const stripped = value.replace(/[\s.]/g, '').toUpperCase();
  return type === 'us_ein' && /^\d{9}$/.test(stripped) ? `${stripped.slice(0, 2)}-${stripped.slice(2)}` : stripped;
}

export interface TaxIdCheck {
  ok: boolean;
  /** The value as it will be stored. */
  value: string;
  /** Why it was refused, in the words the customer's finance team would use. */
  message?: string;
  /** True when this workspace has no format for the type, so it cannot check it. */
  unknownType?: boolean;
}

/**
 * Check a registration number against the shape its authority issues.
 *
 * A type this file does not know is not refused — a workspace may legitimately
 * record a registration Ain has no format for — but it is marked as one that
 * cannot be checked, and an unchecked registration never shifts the tax.
 */
export function checkTaxId(type: string, rawValue: string): TaxIdCheck {
  const value = normaliseTaxIdValue(type, rawValue);
  const format = TAX_ID_FORMATS[type];
  if (!format) {
    return /^[A-Z0-9][A-Z0-9\-/]{1,58}$/.test(value)
      ? { ok: true, value, unknownType: true }
      : {
        ok: false,
        value,
        unknownType: true,
        message: `"${rawValue}" is not a registration number. Ain has no format on file for "${type}", so it accepts any number of letters, digits and dashes — but not punctuation or spaces in the middle of one.`,
      };
  }
  if (!format.pattern.test(value)) {
    return { ok: false, value, message: `"${rawValue}" is not ${format.label}. One looks like ${format.example}.` };
  }
  if (!format.byCountry) return { ok: true, value };

  // The shape is right in general; now it has to be right for the state that
  // issues it, because nine digits is a German number and eleven is an Italian
  // one and neither is the other.
  const country = value.slice(0, 2);
  const shape = format.byCountry[country];
  if (!shape) {
    return {
      ok: false,
      value,
      message: `"${rawValue}" does not start with a country ${format.label} is issued for. An EU number starts with the member state that issued it — ${format.example}, for example — and "${country}" is not one of them.`,
    };
  }
  if (!shape.pattern.test(value)) {
    return {
      ok: false,
      value,
      message: `"${rawValue}" is not the shape ${country} issues. A ${country} VAT number looks like ${shape.example}.`,
    };
  }
  return { ok: true, value };
}

/** True when Ain holds a format for this kind of registration and can check it. */
export const isCheckableTaxIdType = (type: string): boolean => type in TAX_ID_FORMATS;

/* ------------------------------- verification ----------------------------- */

/**
 * Stripe's four states, and they mean the same things here. `pending` is a
 * number that has been checked for shape but not confirmed against the register
 * that issued it; only `verified` shifts the tax onto the customer.
 */
export const TAX_ID_VERIFICATION_STATUSES = ['pending', 'verified', 'unverified', 'unavailable'] as const;
export type TaxIdVerificationStatus = (typeof TAX_ID_VERIFICATION_STATUSES)[number];

/** How a status reads mid-sentence: "DE811907980 is on file but …". */
export function describeVerification(status: TaxIdVerificationStatus): string {
  switch (status) {
    case 'verified': return 'has been confirmed against the register that issued it';
    case 'unverified': return 'the register did not recognise it';
    case 'unavailable': return 'it is a kind of registration Ain cannot check';
    case 'pending':
    default: return 'it has not been confirmed against the register that issued it';
  }
}

/** What a recorded verification result means for the next invoice. */
export function defaultVerificationNote(status: TaxIdVerificationStatus, value: string): string {
  switch (status) {
    case 'verified':
      return `${value} was confirmed against the register that issued it, so a supply into that country from outside it is reverse charged.`;
    case 'unverified':
      return `The register that issues ${value} did not recognise it, so tax is charged as normal until a valid number is on file.`;
    case 'unavailable':
      return `The register that issues ${value} could not be reached, so tax is charged as normal until it can be.`;
    case 'pending':
    default:
      return `${value} is waiting to be confirmed against the register that issued it. Tax is charged as normal until it is.`;
  }
}

/** Where a registration starts: shape checked, register not yet asked. */
export const pendingVerification = (type: string): TaxIdVerification =>
  isCheckableTaxIdType(type)
    ? {
      status: 'pending',
      verified_name: null,
      verified_address: null,
      checked_at: null,
      note: 'The number is the right shape for the register that issues it. It has not been confirmed against that register, so tax is charged as normal until it is.',
    }
    : {
      status: 'unavailable',
      verified_name: null,
      verified_address: null,
      checked_at: null,
      note: `Ain holds no format for a "${type}" registration, so it cannot be checked and never shifts the tax.`,
    };

/* --------------------------------- the split ------------------------------ */

/** One rate that an address matched, and why it charged what it charged. */
export interface ResolvedRateEntry {
  rate: TaxRate;
  /**
   * Sibling rates can differ. A cross-border EU supply against a verified
   * registration reverse charges the VAT while a city rate registered in the
   * same country would still be charged, so the reason belongs to the rate.
   */
  reason: TaxReason;
}

/** The rates that apply to one customer, and why. */
export interface ResolvedRate {
  /**
   * Every active rate the address matched, country-wide first and then the
   * state's. A US supply is in as many jurisdictions as have registered a rate
   * over it and owes the sum of them; taking the most specific one and calling
   * it "the rate" undercharges by every other jurisdiction it is in.
   */
  entries: ResolvedRateEntry[];
  /** The first of them — the single-rate reading most invoices still have. */
  rate: TaxRate | null;
  /** The document's own answer, for a line with one rate or none. */
  reason: TaxReason;
  /** The country the decision was made against, for the explanation. */
  country: string | null;
  /**
   * False when no country could be resolved at all — no address, an address
   * with no country, a country that is not one. It is the difference between
   * "deliberately zero-rated" and "we never learned where this customer is",
   * and it is what `automatic_tax.status` on the invoice is decided from.
   */
  location_known: boolean;
  /** Where the supplier is established, when the workspace has recorded it. */
  supplier_country: string | null;
  /**
   * Set when a registration number was on file in the rate's country and the
   * tax was charged anyway. "Why is there VAT on this?" is a question the
   * invoice has to answer as clearly as "why is there none?".
   */
  registration_note: string | null;
}

/** One rate's slice of a line's tax. */
export interface TaxSlice {
  rate: TaxRate | null;
  reason: TaxReason;
  /** Signed the same way the line is, so a credit line credits its tax. */
  amount: number;
  behavior: TaxBehavior;
}

/** One line's tax, and the base it was computed on. */
export interface TaxSplit {
  /** The taxable base — what the line is worth before tax. */
  base: number;
  /** One entry per rate that touched the line, charged or not. */
  slices: TaxSlice[];
  /** `slices` summed. Signed the same way the line is. */
  tax: number;
  behavior: TaxBehavior;
  reason: TaxReason;
  rate: TaxRate | null;
  /** Carried through from the resolution so the line can explain a charged tax. */
  note: string | null;
}

/**
 * Reading rates, resolving them for a customer and splitting a line by one.
 *
 * Built per operation and memoised inside, because an invoice asks the same two
 * questions — "what rate does this account pay?" and "what is this price's tax
 * behaviour?" — once per line and must get the same answer every time.
 */
export class TaxRates {
  private readonly resolved = new Map<string, ResolvedRate>();
  private supplier: string | null | undefined;

  constructor(private readonly ctx: Ctx, private readonly orgId: string) {}

  /* ------------------------------- the store ----------------------------- */

  list(filter: { country?: string; active?: boolean; limit?: number } = {}): TaxRate[] {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [this.orgId];
    if (filter.country) { clauses.push('country = ?'); params.push(filter.country.toUpperCase()); }
    if (filter.active !== undefined) { clauses.push('active = ?'); params.push(filter.active ? 1 : 0); }
    return this.ctx.db.all<Record<string, unknown>>(
      `SELECT * FROM billing_tax_rates WHERE ${clauses.join(' AND ')}
        ORDER BY country ASC, state IS NULL DESC, state ASC, created ASC LIMIT ?`,
      ...(params as string[]), Math.min(Math.max(filter.limit ?? 100, 1), 500),
    ).map(hydrateTaxRate);
  }

  get(id: string): TaxRate | null {
    const row = this.ctx.db.get<Record<string, unknown>>(
      `SELECT * FROM billing_tax_rates WHERE org_id = ? AND id = ?`, this.orgId, id,
    );
    return row ? hydrateTaxRate(row) : null;
  }

  require(id: string): TaxRate {
    const found = this.get(id);
    if (!found) throw notFound('tax rate', id);
    return found;
  }

  create(input: TaxRateInput, at: number): TaxRate {
    const country = countryCode(input.country);
    if (!country) {
      throw badRequest(
        'tax_country_unknown',
        `"${input.country}" is not a country this workspace can match an address against. Use the ISO-3166 two-letter code, e.g. "DE".`,
        'country',
      );
    }
    percentToRat(input.percentage);
    const state = input.state?.trim() || null;
    // One active rate per *jurisdiction*, not per place. A US address is in
    // several jurisdictions at once — the state, the city, a transit district —
    // and every one of them registers its own rate over the same supply, so
    // refusing the second would make a New York invoice impossible to write.
    // What is still refused is the same jurisdiction registered twice, which is
    // a duplicate rather than a stack and would double-charge it.
    //
    // The test is *overlap*, not sameness of place, and it is `ratesFor`'s own
    // matching rule read backwards: two rates can both land on one address when
    // either is registered country-wide or they name the same state. Keying the
    // clash on the (country, state) tuple instead let New York be registered
    // once country-wide and once under its state, and every New York bill was
    // then charged New York twice — the exact double-charge this refusal
    // exists to prevent, wearing the stack's clothes. Case is folded here for
    // the same reason `ratesFor` folds it: "new york city" and "New York City"
    // are one city, and a bill that charges both charges it twice.
    const jurisdiction = input.jurisdiction.trim();
    const named = jurisdiction.toLowerCase();
    const scoped = state?.toLowerCase() ?? null;
    const clash = this.list({ country, active: true, limit: 500 }).find(
      (rate) => rate.jurisdiction.trim().toLowerCase() === named
        && (rate.state === null || scoped === null || rate.state.trim().toLowerCase() === scoped),
    );
    if (clash) {
      const where = clash.state ? `${country} / ${clash.state}` : `${country}, country-wide`;
      throw conflict(
        'tax_rate_exists',
        `${jurisdiction} already has an active rate (${clash.id}, ${clash.display_name} ${formatPercentage(clash.percentage)}%) registered over ${where}, which covers ${state ? `${country} / ${state}` : `all of ${country}`}. Deactivate it before adding another, so one address can never be charged the same jurisdiction twice — a second, *different* jurisdiction over the same address is registered under its own name and stacks with this one.`,
        { tax_rate: clash.id },
      );
    }
    const id = newId('taxrate');
    this.ctx.db.insert('billing_tax_rates', {
      id,
      org_id: this.orgId,
      display_name: input.display_name,
      description: input.description ?? null,
      jurisdiction,
      country,
      state,
      tax_type: input.tax_type ?? 'vat',
      percentage: formatPercentage(input.percentage.trim()),
      reverse_charge: input.reverse_charge ? 1 : 0,
      active: input.active === false ? 0 : 1,
      metadata: input.metadata ?? {},
      created: at,
      updated: at,
    });
    this.resolved.clear();
    return this.require(id);
  }

  /**
   * Only ever called with `false` today, and the API exposes only that.
   * Bringing a retired rate back is the one other way two active rates could
   * come to name the same jurisdiction over one address, so whoever exposes it
   * has to run `create`'s overlap check first — the refusal there is what keeps
   * a New York bill from being charged New York twice, and a route that skips
   * it hands the double-charge straight back.
   */
  setActive(id: string, active: boolean, at: number): TaxRate {
    const rate = this.require(id);
    this.ctx.db.patch('billing_tax_rates', 'id', rate.id, { active: active ? 1 : 0, updated: at });
    this.resolved.clear();
    return this.require(id);
  }

  /* ------------------------------- resolution ---------------------------- */

  /**
   * Which rate a customer pays, and why they pay it (or do not).
   *
   * The order matters. An explicit exemption on the account beats everything,
   * because a human has looked at a certificate. Otherwise the address decides
   * the jurisdiction — falling back to the country their registration number is
   * issued in, since an account with a `DE` VAT number is German whatever its
   * address field says — and a registration number in a reverse-charge
   * jurisdiction shifts the tax onto the customer.
   */
  forCustomer(customer: Customer): ResolvedRate {
    const cached = this.resolved.get(customer.id);
    if (cached) return cached;
    const answer = this.resolve(customer);
    this.resolved.set(customer.id, answer);
    return answer;
  }

  private resolve(customer: Customer): ResolvedRate {
    const country = countryCode(customer.address?.country)
      ?? customer.tax_ids.map(taxIdCountry).find((code): code is string => !!code)
      ?? null;
    const rates = country ? this.ratesFor(country, customer.address?.state ?? null) : [];
    const supplier = this.supplierCountry();
    const base = {
      rate: rates[0] ?? null,
      country,
      location_known: country !== null,
      supplier_country: supplier,
      registration_note: null,
    };
    const every = (reason: TaxReason): ResolvedRateEntry[] => rates.map((rate) => ({ rate, reason }));

    if (customer.tax_exempt === 'exempt') return { ...base, entries: every('exempt'), reason: 'exempt' };
    if (customer.tax_exempt === 'reverse') return { ...base, entries: every('reverse_charge'), reason: 'reverse_charge' };
    if (!rates.length) return { ...base, rate: null, entries: [], reason: 'no_rate' };

    const shiftable = rates.filter((rate) => rate.reverse_charge);
    if (!shiftable.length) return { ...base, entries: every('taxable'), reason: 'taxable' };
    const named = shiftable.map((rate) => rate.display_name).join(' and ');

    // Three things have to hold before the tax moves onto the customer, and
    // each of them has been a way to lose the money in some real billing
    // system: the number has to be registered where the rate is, it has to
    // have been confirmed against the register that issued it, and the supply
    // has to cross a border — a supplier established where the customer is
    // charges its own domestic rate however good the customer's number is.
    // An account can hold more than one number in a country — an old one and
    // its replacement. The confirmed one decides, whichever order they are in.
    const inCountry = customer.tax_ids.filter((taxId) => taxIdCountry(taxId) === country);
    const registration = inCountry.find((taxId) => taxId.verification.status === 'verified') ?? inCountry[0];
    if (!registration) return { ...base, entries: every('taxable'), reason: 'taxable' };
    if (supplier !== null && supplier === country) {
      return {
        ...base,
        entries: every('taxable'),
        reason: 'taxable',
        registration_note: `${registration.value} is registered in ${country}, but this is a domestic supply — the supplier is established in ${supplier} too — so ${named} is charged rather than reverse charged.`,
      };
    }
    if (registration.verification.status !== 'verified') {
      return {
        ...base,
        entries: every('taxable'),
        reason: 'taxable',
        registration_note: `${registration.value} is on file but ${describeVerification(registration.verification.status)}, so the tax has not been shifted onto the customer. Confirm it against the register with POST /v1/customers/${customer.id}/tax_ids/verify and the next invoice is reverse charged.`,
      };
    }
    // Only the rates that say they shift do. A city rate stacked under a
    // reverse-charged national one is still charged, and the line says both.
    const entries: ResolvedRateEntry[] = rates.map((rate) => ({
      rate, reason: rate.reverse_charge ? 'reverse_charge' : 'taxable',
    }));
    return {
      ...base,
      entries,
      reason: entries.every((entry) => entry.reason === 'reverse_charge') ? 'reverse_charge' : 'taxable',
      registration_note: supplier
        ? `${registration.value} was confirmed against the ${country} register, and this supply is made from ${supplier} into ${country}.`
        : `${registration.value} was confirmed against the ${country} register.`,
    };
  }

  /**
   * Where the bill is issued from.
   *
   * Without this the reverse-charge rule reads "the customer is registered
   * where the rate is", which is right only for a supplier established
   * somewhere else — and silently zero-rates every domestic B2B invoice the day
   * the issuer becomes a German entity.
   */
  private supplierCountry(): string | null {
    if (this.supplier !== undefined) return this.supplier;
    let recorded: string | null = null;
    try {
      const issuer = this.ctx.svc.core.setting<{ country?: string | null } | null>(this.orgId, 'billing.issuer', null);
      recorded = countryCode(issuer?.country ?? null);
    } catch { recorded = null; }
    this.supplier = recorded;
    return recorded;
  }

  /**
   * Every active rate an address matches, country-wide first and then the
   * state's — the order they belong in on a bill.
   *
   * This is a list because a supply is in every jurisdiction that has
   * registered a rate over it at once. A New York invoice owes the state rate
   * *and* the city rate *and* the transit district's, and the customer owes
   * their sum. Returning only the most specific one undercharges by all the
   * others and hides them from the document that has to name them.
   */
  private ratesFor(country: string, state: string | null): TaxRate[] {
    const normalised = state?.trim().toLowerCase();
    return this.list({ country, active: true, limit: 500 }).filter(
      (rate) => rate.state === null || (!!normalised && rate.state.toLowerCase() === normalised),
    );
  }

  /* --------------------------------- the maths --------------------------- */

  /**
   * Split one line's computed amount into a taxable base and the tax on it.
   *
   * `amount` is what the pricing engine produced. For an exclusive or
   * unspecified price that number is the base and the tax is added; for an
   * inclusive one it is the gross and the tax comes out of it. Either way the
   * rational is rounded exactly once and the other half is derived by
   * subtraction, so `base + tax` is the gross to the cent for every currency,
   * including the zero- and three-decimal ones.
   */
  split(amount: number, behavior: TaxBehavior, currency: string, resolved: ResolvedRate): TaxSplit {
    const { entries, rate, reason, registration_note: note } = resolved;
    // A line with no rate behind it has no behaviour to honour, which is what
    // `unspecified` has always meant here.
    const shape: TaxBehavior = entries.length ? behavior : 'unspecified';
    const charging = new Set(
      entries.filter((entry) => entry.reason === 'taxable' && percentToRat(entry.rate.percentage).n !== 0n),
    );
    if (!charging.size) {
      const slices = entries.map((entry) => ({ rate: entry.rate, reason: entry.reason, amount: 0, behavior: shape }));
      return { base: amount, slices, tax: 0, behavior: shape, reason, rate, note };
    }

    if (behavior === 'inclusive') {
      // The listed price already contains every one of these taxes at once, so
      // the divisor is their sum: this rate's share of the gross is
      // gross x p / (100 + Σp), rounded once, and the base is what is left
      // after all of them. base + Σtax is the listed price, to the cent.
      const stacked = [...charging].reduce((total, entry) => ratAdd(total, percentToRat(entry.rate.percentage)), rat(0n));
      const gross = ratAdd(rat(100n), stacked);
      const slices = entries.map((entry) => ({
        rate: entry.rate,
        reason: entry.reason,
        behavior,
        amount: charging.has(entry)
          ? ratToMoney(ratMul(rat(BigInt(amount)), ratDiv(percentToRat(entry.rate.percentage), gross)), currency).amount
          : 0,
      }));
      const tax = slices.reduce((total, slice) => total + slice.amount, 0);
      return { base: amount - tax, slices, tax, behavior, reason, rate, note };
    }

    // Exclusive: the line's amount is the base every jurisdiction taxes, and
    // each of them rounds once against it. Nothing is rounded twice, and no
    // rate is computed on another rate's tax.
    const slices = entries.map((entry) => {
      const pct = percentToRat(entry.rate.percentage);
      return {
        rate: entry.rate,
        reason: entry.reason,
        behavior: 'exclusive' as const,
        amount: charging.has(entry)
          ? ratToMoney(ratMul(rat(BigInt(amount)), rat(pct.n, pct.d * 100n)), currency).amount
          : 0,
      };
    });
    const tax = slices.reduce((total, slice) => total + slice.amount, 0);
    return { base: amount, slices, tax, behavior: 'exclusive', reason, rate, note };
  }

  /**
   * The sentence that goes on one rate's slice, so the figure explains itself.
   *
   * The *reason* leads, not the rate: an exempt account is exempt whether or
   * not a rate happens to be registered where it trades, and saying "no rate is
   * registered" about an account with a certificate on file would be the wrong
   * answer to the only question anyone asks about a zero.
   */
  explainSlice(slice: TaxSlice, note: string | null, jurisdictionFallback: string | null): string | null {
    const label = slice.rate
      ? `${slice.rate.display_name} ${formatPercentage(slice.rate.percentage)}% (${slice.rate.jurisdiction})`
      : null;
    switch (slice.reason) {
      case 'reverse_charge': {
        const head = label
          ? `${label} is reverse charged — the customer accounts for the tax, so nothing is charged here.`
          : 'This supply is reverse charged — the customer accounts for the tax, so nothing is charged here.';
        return note ? `${head} ${note}` : head;
      }
      case 'exempt':
        return label
          ? `${label} would apply, but this account is registered as exempt.`
          : 'This account is registered as tax exempt, so nothing is charged.';
      case 'no_rate':
        return jurisdictionFallback
          ? `No tax rate is registered for ${jurisdictionFallback}, so nothing is charged.`
          : 'No tax rate is registered for this address, so nothing is charged.';
      case 'taxable':
      default: {
        if (!label) return null;
        const how = slice.behavior === 'inclusive'
          ? `${label} is included in the price, so it is taken out of the amount rather than added to it.`
          : `${label} is added on top of the amount.`;
        return note ? `${how} ${note}` : how;
      }
    }
  }

  /**
   * The line's own sentence: every jurisdiction's, in the order they are
   * charged. A line in one jurisdiction reads exactly as it always did.
   */
  explain(split: TaxSplit, jurisdictionFallback: string | null): string | null {
    if (!split.slices.length) {
      return this.explainSlice(
        { rate: null, reason: split.reason, amount: 0, behavior: split.behavior }, split.note, jurisdictionFallback,
      );
    }
    const said = split.slices
      .map((slice) => this.explainSlice(slice, split.note, jurisdictionFallback))
      .filter((sentence): sentence is string => !!sentence);
    return said.length ? said.join(' ') : null;
  }
}

/** One rate's contribution to an invoice — Stripe's `total_taxes[]`. */
export interface TaxSummaryRow {
  object: 'invoice_tax_amount';
  tax_rate: string | null;
  display_name: string;
  jurisdiction: string;
  percentage: string;
  tax_type: TaxType | null;
  reason: TaxReason;
  inclusive: boolean;
  /** The base this rate was applied to. */
  taxable_amount: number;
  amount: number;
  currency: string;
  explanation: string;
}

/**
 * Group every line's tax entries by the rate that produced them.
 *
 * One row per rate across the whole document, which is what a US bill showing
 * a state rate, a city rate and a transit district's needs and what the EU
 * needs for a single reverse-charged VAT line. The key is the rate rather than
 * the line, so a rate that touched six lines is one row summing all six.
 */
export function summariseTax(
  entries: { tax_rate: string | null; tax_display_name: string | null; tax_jurisdiction: string | null;
    tax_percentage: string | null; tax_type: string | null; tax_reason: TaxReason | null;
    tax_behavior: TaxBehavior | null; taxable_amount: number; tax_amount: number; currency: string }[],
): TaxSummaryRow[] {
  const groups = new Map<string, TaxSummaryRow>();
  for (const line of entries) {
    if (!line.tax_rate && !line.tax_percentage) continue;
    const reason = line.tax_reason ?? 'taxable';
    // A rate that was retired and re-registered, or one snapshotted before ids
    // were carried, is still identified by what it charged and where.
    const identity = line.tax_rate ?? `${line.tax_display_name ?? 'Tax'}@${line.tax_percentage}@${line.tax_jurisdiction ?? ''}`;
    const key = `${identity}|${reason}|${line.tax_behavior === 'inclusive' ? 'i' : 'e'}`;
    const found = groups.get(key);
    if (found) {
      found.taxable_amount += line.taxable_amount;
      found.amount += line.tax_amount;
      continue;
    }
    const percentage = formatPercentage(line.tax_percentage ?? '0');
    const jurisdiction = line.tax_jurisdiction ?? 'this address';
    const display = line.tax_display_name ?? 'Tax';
    groups.set(key, {
      object: 'invoice_tax_amount',
      tax_rate: line.tax_rate,
      display_name: display,
      jurisdiction,
      percentage,
      tax_type: (line.tax_type as TaxType | null) ?? null,
      reason,
      inclusive: line.tax_behavior === 'inclusive',
      taxable_amount: line.taxable_amount,
      amount: line.tax_amount,
      currency: line.currency,
      explanation: reason === 'reverse_charge'
        ? `${display} ${percentage}% (${jurisdiction}) reverse charged — the customer accounts for it.`
        : reason === 'exempt'
          ? `${display} ${percentage}% (${jurisdiction}) not charged — the account is registered as exempt.`
          : line.tax_behavior === 'inclusive'
            ? `${display} ${percentage}% (${jurisdiction}), included in the prices shown.`
            : `${display} ${percentage}% (${jurisdiction}), added to the subtotal.`,
    });
  }
  return [...groups.values()];
}
