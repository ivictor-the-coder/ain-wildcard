/**
 * The catalog's object model.
 *
 * Products describe *what* is sold; prices describe *how much* and *how often*.
 * Everything a price needs to turn a quantity into money lives on the price
 * itself, so an invoice line can always be recomputed and explained years later
 * even if the plan has since been rewritten — which is why prices are immutable.
 */
import type { IntervalUnit } from '../../../shared/time';

export type PriceType = 'recurring' | 'one_time';

/**
 * How the price turns a quantity into an amount.
 * - `flat`     one amount per interval, independent of quantity
 * - `per_unit` quantity x unit amount (seats, devices, licences)
 * - `tiered`   graduated or volume tiers
 * - `package`  quantity is bucketed by `transform_quantity` first
 * - `usage`    metered: quantity is aggregated from usage records
 * - `custom`   negotiated — "contact us"; the amount arrives with the quote
 */
export type PriceModel = 'flat' | 'per_unit' | 'tiered' | 'package' | 'usage' | 'custom';

export type TiersMode = 'graduated' | 'volume';
export type BillingScheme = 'per_unit' | 'tiered';
export type UsageType = 'licensed' | 'metered';

/** How many usage records collapse into the quantity billed for a period. */
export type UsageAggregation = 'sum' | 'max' | 'last_during_period' | 'last_ever' | 'unique';

export type ProrationBehavior = 'create_prorations' | 'none' | 'always_invoice';
export type TaxBehavior = 'inclusive' | 'exclusive' | 'unspecified';
export type TransformRounding = 'up' | 'down';

export const PRICE_MODELS = ['flat', 'per_unit', 'tiered', 'package', 'usage', 'custom'] as const;
export const PRICE_TYPES = ['recurring', 'one_time'] as const;
export const TIERS_MODES = ['graduated', 'volume'] as const;
export const BILLING_SCHEMES = ['per_unit', 'tiered'] as const;
export const USAGE_TYPES = ['licensed', 'metered'] as const;
export const USAGE_AGGREGATIONS = ['sum', 'max', 'last_during_period', 'last_ever', 'unique'] as const;
export const PRORATION_BEHAVIORS = ['create_prorations', 'none', 'always_invoice'] as const;
export const TAX_BEHAVIORS = ['inclusive', 'exclusive', 'unspecified'] as const;
export const INTERVAL_UNITS = ['day', 'week', 'month', 'year'] as const;
export const PRODUCT_CATEGORIES = ['plan', 'component', 'add_on', 'credit_pack', 'service'] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

/**
 * A tier boundary. `up_to` is inclusive and cumulative, exactly like Stripe:
 * `[{up_to: 10}, {up_to: 'inf'}]` means units 1-10 then 11 and beyond.
 * Amounts are in the currency's minor unit; the `_decimal` variants carry the
 * exact sub-cent price used for metered pricing ("0.04" = 0.04 cents).
 */
export interface PriceTier {
  up_to: number | 'inf';
  unit_amount?: number | null;
  unit_amount_decimal?: string | null;
  flat_amount?: number | null;
  flat_amount_decimal?: string | null;
}

/** Package pricing: charge per block of `divide_by` units. */
export interface TransformQuantity {
  divide_by: number;
  round: TransformRounding;
}

export interface Recurring {
  interval: IntervalUnit;
  interval_count: number;
  usage_type: UsageType;
  /** Only meaningful when `usage_type` is `metered`. */
  aggregate_usage: UsageAggregation | null;
  trial_period_days: number | null;
  /** Lookup key of the meter that feeds this price. */
  meter: string | null;
}

/** Pay-what-you-want / negotiated amounts, in minor units. */
export interface CustomUnitAmount {
  enabled: boolean;
  minimum: number | null;
  maximum: number | null;
  preset: number | null;
}

/**
 * A currency this price also sells in. Anything omitted falls back to nothing —
 * an option with no amounts and no tiers is not a valid offer in that currency.
 */
export interface CurrencyOption {
  unit_amount?: number | null;
  unit_amount_decimal?: string | null;
  tiers?: PriceTier[] | null;
  custom_unit_amount?: CustomUnitAmount | null;
  tax_behavior?: TaxBehavior;
}

export interface ProductFeature {
  /** Human label shown on the pricing page. */
  name: string;
  /** Stable key entitlements are granted against. */
  lookup_key: string;
  description: string | null;
}

export interface Product {
  object: 'product';
  id: string;
  name: string;
  description: string | null;
  /** What shows up on a card statement — <= 22 chars, no special characters. */
  statement_descriptor: string | null;
  unit_label: string | null;
  active: boolean;
  images: string[];
  features: ProductFeature[];
  metadata: Record<string, string>;
  tax_code: string | null;
  default_price: string | null;
  category: ProductCategory;
  tagline: string | null;
  url: string | null;
  position: number;
  created: number;
  updated: number;
  livemode: boolean;
}

export interface Price {
  object: 'price';
  id: string;
  product: string;
  nickname: string | null;
  lookup_key: string | null;
  active: boolean;
  type: PriceType;
  model: PriceModel;
  /** The price's home currency; `currency_options` covers the rest. */
  currency: string;
  unit_amount: number | null;
  unit_amount_decimal: string | null;
  billing_scheme: BillingScheme;
  tiers_mode: TiersMode | null;
  tiers: PriceTier[] | null;
  transform_quantity: TransformQuantity | null;
  recurring: Recurring | null;
  currency_options: Record<string, CurrencyOption>;
  custom_unit_amount: CustomUnitAmount | null;
  tax_behavior: TaxBehavior;
  proration_behavior: ProrationBehavior;
  metadata: Record<string, string>;
  created: number;
  updated: number;
  livemode: boolean;
}

/** One explained contribution to a line amount. */
export interface LineBreakdownRow {
  kind: 'flat' | 'per_unit' | 'tier' | 'tier_flat' | 'package' | 'custom' | 'included';
  label: string;
  /** 1-based tier index, when this row came from a tier. */
  tier: number | null;
  /** The tier's inclusive upper bound, for display. */
  up_to: number | 'inf' | null;
  /** Units billed by this row (after any package transform). */
  quantity: number;
  /** Exact per-unit price in minor units, e.g. "0.04" = 0.04 cents. */
  unit_amount_decimal: string | null;
  /** This row's share of the rounded total, in minor units. */
  amount: number;
  /** The row's exact, unrounded contribution in minor units. */
  amount_decimal: string;
}

export interface LineAmount {
  object: 'line_amount';
  price: string;
  currency: string;
  /** The quantity supplied by the caller. */
  quantity: number;
  /** The quantity actually charged, after `transform_quantity`. */
  billable_quantity: number;
  amount: number;
  /** The exact, unrounded amount in minor units, before the single final rounding. */
  amount_decimal: string;
  /** Effective average price per supplied unit, in minor units. */
  effective_unit_amount_decimal: string;
  /** What the next single unit would cost, in minor units. */
  marginal_unit_amount_decimal: string;
  breakdown: LineBreakdownRow[];
  /** Set when the caller asked for a partial period. */
  proration: { numerator: number; denominator: number } | null;
}

export interface CurvePoint {
  quantity: number;
  amount: number;
  effective_unit_amount_decimal: string;
  marginal_unit_amount_decimal: string;
  /** True when this quantity sits exactly on a tier boundary. */
  boundary: boolean;
}

export interface PriceCurve {
  object: 'price_curve';
  price: string;
  currency: string;
  from: number;
  to: number;
  points: CurvePoint[];
  boundaries: number[];
  min_amount: number;
  max_amount: number;
  /** Cheapest and dearest effective unit price across the range. */
  best_unit_amount_decimal: string;
  worst_unit_amount_decimal: string;
}

/** A single metered usage record, as the billing module records them. */
export interface UsageRecord {
  quantity: number;
  timestamp: number;
  /** Distinguishes the subject for `unique` aggregation (a device, a seat). */
  key?: string | null;
}

export interface PriceUsage {
  /** Live references from subscriptions, invoices, quotes and the like. */
  count: number;
  references: { type: string; id: string }[];
  /** True once anything has ever billed against this price. */
  in_use: boolean;
}
