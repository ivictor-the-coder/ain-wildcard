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
import type { Customer, TaxId } from './types';

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
 */
export function taxIdCountry(taxId: TaxId): string | null {
  const value = taxId.value.trim().toUpperCase();
  const prefix = value.slice(0, 2);
  if (/^[A-Z]{2}/.test(value)) {
    // The EU writes Greece as EL and the UK's numbers start GB; everything else
    // that starts with two letters starts with its own ISO code.
    if (prefix === 'EL') return 'GR';
    if (COUNTRY_CODE_SET.has(prefix)) return prefix;
  }
  const fromType = /^([a-z]{2})_/.exec(taxId.type);
  if (fromType && fromType[1] !== 'eu' && COUNTRY_CODE_SET.has(fromType[1].toUpperCase())) {
    return fromType[1].toUpperCase();
  }
  return countryCode(taxId.country);
}

const COUNTRY_CODE_SET = new Set(Object.values(COUNTRY_CODES).concat(['GR', 'BG', 'HR', 'CY', 'EE', 'HU', 'LV', 'LT', 'LU', 'MT', 'RO', 'SK', 'SI']));

/* --------------------------------- the split ------------------------------ */

/** The rate that applies to one customer, and why. */
export interface ResolvedRate {
  rate: TaxRate | null;
  reason: TaxReason;
  /** The country the decision was made against, for the explanation. */
  country: string | null;
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
}

export const NO_TAX = (amount: number): TaxSplit =>
  ({ base: amount, tax: 0, behavior: 'unspecified', reason: 'no_rate', rate: null });

/**
 * Reading rates, resolving them for a customer and splitting a line by one.
 *
 * Built per operation and memoised inside, because an invoice asks the same two
 * questions — "what rate does this account pay?" and "what is this price's tax
 * behaviour?" — once per line and must get the same answer every time.
 */
export class TaxRates {
  private readonly resolved = new Map<string, ResolvedRate>();

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

    if (customer.tax_exempt === 'exempt') return { rate, reason: 'exempt', country };
    if (customer.tax_exempt === 'reverse') return { rate, reason: 'reverse_charge', country };
    if (!rate) return { rate: null, reason: 'no_rate', country };
    if (rate.reverse_charge && customer.tax_ids.some((taxId) => taxIdCountry(taxId) === rate.country)) {
      return { rate, reason: 'reverse_charge', country };
    }
    return { rate, reason: 'taxable', country };
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
    const { rate, reason } = resolved;
    if (!rate || reason !== 'taxable') {
      return { base: amount, tax: 0, behavior: rate ? behavior : 'unspecified', reason, rate };
    }
    const pct = percentToRat(rate.percentage);
    if (pct.n === 0n) return { base: amount, tax: 0, behavior, reason, rate };

    if (behavior === 'inclusive') {
      // base = gross x 100/(100 + pct), rounded once; the tax is the remainder,
      // which is what makes an inclusive line add back up to its listed price.
      const factor = rat(100n * pct.d, 100n * pct.d + pct.n);
      const base = ratToMoney(ratMul(rat(BigInt(amount)), factor), currency).amount;
      return { base, tax: amount - base, behavior, reason, rate };
    }
    const tax = ratToMoney(ratMul(rat(BigInt(amount)), rat(pct.n, pct.d * 100n)), currency).amount;
    return { base: amount, tax, behavior: 'exclusive', reason, rate };
  }

  /** The sentence that goes on the line, so the figure explains itself. */
  explain(split: TaxSplit, jurisdictionFallback: string | null): string | null {
    if (!split.rate) {
      return jurisdictionFallback
        ? `No tax rate is registered for ${jurisdictionFallback}, so nothing is charged.`
        : null;
    }
    const label = `${split.rate.display_name} ${formatPercentage(split.rate.percentage)}% (${split.rate.jurisdiction})`;
    switch (split.reason) {
      case 'reverse_charge':
        return `${label} is reverse charged — the customer accounts for the tax, so nothing is charged here.`;
      case 'exempt':
        return `${label} would apply, but this account is registered as exempt.`;
      case 'no_rate':
        return `No tax rate is registered for this address, so nothing is charged.`;
      case 'taxable':
      default:
        return split.behavior === 'inclusive'
          ? `${label} is included in the price, so it is taken out of the amount rather than added to it.`
          : `${label} is added on top of the amount.`;
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
