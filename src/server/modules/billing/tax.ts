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
 *  2. **Rounding happens once per line**, on an exact rational, and the two
 *     halves are made to add up by subtraction rather than by rounding twice —
 *     an inclusive line's base is `amount - tax`, always, to the cent.
 *  3. **Zero tax is still an answer.** A reverse-charged B2B supply into the EU
 *     is 0%, but the invoice says so, names the rate it would have been and
 *     says why. A bill that is silent about tax cannot be sent to a customer in
 *     most of the world; a bill that says "VAT 19% — reverse charged, customer
 *     accounts for the tax" can.
 */
import type { Ctx } from '../../kernel/context';
import { badRequest, conflict, notFound } from '../../../shared/errors';
import { newId } from '../../../shared/ids';
import { rat, ratMul, ratToMoney, type Rational } from '../../../shared/money';
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

export function countryCode(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
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

/** The rate that applies to one customer, and why. */
export interface ResolvedRate {
  rate: TaxRate | null;
  reason: TaxReason;
  /** The country the decision was made against, for the explanation. */
  country: string | null;
  /** Where the supplier is established, when the workspace has recorded it. */
  supplier_country: string | null;
  /**
   * Set when a registration number was on file in the rate's country and the
   * tax was charged anyway. "Why is there VAT on this?" is a question the
   * invoice has to answer as clearly as "why is there none?".
   */
  registration_note: string | null;
}

/** One line's tax, and the base it was computed on. */
export interface TaxSplit {
  /** The taxable base — what the line is worth before tax. */
  base: number;
  /** The tax on it. Signed the same way the line is, so credits credit tax. */
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
    const clash = this.ctx.db.get<{ id: string }>(
      `SELECT id FROM billing_tax_rates WHERE org_id = ? AND country = ? AND active = 1
        AND ((state IS NULL AND ? IS NULL) OR state = ?)`,
      this.orgId, country, state, state,
    );
    if (clash) {
      throw conflict(
        'tax_rate_exists',
        `${country}${state ? ` / ${state}` : ''} already has an active rate (${clash.id}). Deactivate it before adding another, so an address can never match two.`,
        { tax_rate: clash.id },
      );
    }
    const id = newId('taxrate');
    this.ctx.db.insert('billing_tax_rates', {
      id,
      org_id: this.orgId,
      display_name: input.display_name,
      description: input.description ?? null,
      jurisdiction: input.jurisdiction,
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
    const rate = country ? this.rateFor(country, customer.address?.state ?? null) : null;
    const supplier = this.supplierCountry();
    const base = { rate, country, supplier_country: supplier, registration_note: null };

    if (customer.tax_exempt === 'exempt') return { ...base, reason: 'exempt' };
    if (customer.tax_exempt === 'reverse') return { ...base, reason: 'reverse_charge' };
    if (!rate) return { ...base, rate: null, reason: 'no_rate' };
    if (!rate.reverse_charge) return { ...base, reason: 'taxable' };

    // Three things have to hold before the tax moves onto the customer, and
    // each of them has been a way to lose the money in some real billing
    // system: the number has to be registered where the rate is, it has to
    // have been confirmed against the register that issued it, and the supply
    // has to cross a border — a supplier established where the customer is
    // charges its own domestic rate however good the customer's number is.
    // An account can hold more than one number in a country — an old one and
    // its replacement. The confirmed one decides, whichever order they are in.
    const inCountry = customer.tax_ids.filter((taxId) => taxIdCountry(taxId) === rate.country);
    const registration = inCountry.find((taxId) => taxId.verification.status === 'verified') ?? inCountry[0];
    if (!registration) return { ...base, reason: 'taxable' };
    if (supplier !== null && supplier === rate.country) {
      return {
        ...base,
        reason: 'taxable',
        registration_note: `${registration.value} is registered in ${rate.country}, but this is a domestic supply — the supplier is established in ${supplier} too — so ${rate.display_name} is charged rather than reverse charged.`,
      };
    }
    if (registration.verification.status !== 'verified') {
      return {
        ...base,
        reason: 'taxable',
        registration_note: `${registration.value} is on file but ${describeVerification(registration.verification.status)}, so the tax has not been shifted onto the customer. Confirm it against the register with POST /v1/customers/${customer.id}/tax_ids/verify and the next invoice is reverse charged.`,
      };
    }
    return {
      ...base,
      reason: 'reverse_charge',
      registration_note: supplier
        ? `${registration.value} was confirmed against the ${rate.country} register, and this supply is made from ${supplier} into ${rate.country}.`
        : `${registration.value} was confirmed against the ${rate.country} register.`,
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

  /** The most specific active rate for an address: state first, then country. */
  private rateFor(country: string, state: string | null): TaxRate | null {
    const rows = this.list({ country, active: true });
    if (!rows.length) return null;
    const normalised = state?.trim().toLowerCase();
    const byState = normalised ? rows.find((r) => r.state && r.state.toLowerCase() === normalised) : undefined;
    return byState ?? rows.find((r) => r.state === null) ?? null;
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
    const { rate, reason, registration_note: note } = resolved;
    if (!rate || reason !== 'taxable') {
      return { base: amount, tax: 0, behavior: rate ? behavior : 'unspecified', reason, rate, note };
    }
    const pct = percentToRat(rate.percentage);
    if (pct.n === 0n) return { base: amount, tax: 0, behavior, reason, rate, note };

    if (behavior === 'inclusive') {
      // base = gross x 100/(100 + pct), rounded once; the tax is the remainder,
      // which is what makes an inclusive line add back up to its listed price.
      const factor = rat(100n * pct.d, 100n * pct.d + pct.n);
      const base = ratToMoney(ratMul(rat(BigInt(amount)), factor), currency).amount;
      return { base, tax: amount - base, behavior, reason, rate, note };
    }
    const tax = ratToMoney(ratMul(rat(BigInt(amount)), rat(pct.n, pct.d * 100n)), currency).amount;
    return { base: amount, tax, behavior: 'exclusive', reason, rate, note };
  }

  /**
   * The sentence that goes on the line, so the figure explains itself.
   *
   * The *reason* leads, not the rate: an exempt account is exempt whether or
   * not a rate happens to be registered where it trades, and saying "no rate is
   * registered" about an account with a certificate on file would be the wrong
   * answer to the only question anyone asks about a zero.
   */
  explain(split: TaxSplit, jurisdictionFallback: string | null): string | null {
    const label = split.rate
      ? `${split.rate.display_name} ${formatPercentage(split.rate.percentage)}% (${split.rate.jurisdiction})`
      : null;
    switch (split.reason) {
      case 'reverse_charge': {
        const head = label
          ? `${label} is reverse charged — the customer accounts for the tax, so nothing is charged here.`
          : 'This supply is reverse charged — the customer accounts for the tax, so nothing is charged here.';
        return split.note ? `${head} ${split.note}` : head;
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
        const how = split.behavior === 'inclusive'
          ? `${label} is included in the price, so it is taken out of the amount rather than added to it.`
          : `${label} is added on top of the amount.`;
        return split.note ? `${how} ${split.note}` : how;
      }
    }
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

/** Group taxed lines by the rate that produced them, for the invoice payload. */
export function summariseTax(
  lines: { tax_rate: string | null; tax_display_name: string | null; tax_jurisdiction: string | null;
    tax_percentage: string | null; tax_type: string | null; tax_reason: TaxReason | null;
    tax_behavior: TaxBehavior | null; amount: number; tax_amount: number; currency: string }[],
): TaxSummaryRow[] {
  const groups = new Map<string, TaxSummaryRow>();
  for (const line of lines) {
    if (!line.tax_rate && !line.tax_percentage) continue;
    const reason = line.tax_reason ?? 'taxable';
    const key = `${line.tax_rate ?? 'none'}|${reason}|${line.tax_behavior === 'inclusive' ? 'i' : 'e'}`;
    const found = groups.get(key);
    if (found) {
      found.taxable_amount += line.amount;
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
      taxable_amount: line.amount,
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
