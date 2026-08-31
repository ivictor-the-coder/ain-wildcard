/**
 * Reading and writing the catalog.
 *
 * Two rules shape this file. Every statement filters on `org_id`, and a price
 * that anything has billed against can never be repriced — you create a new one
 * and migrate, exactly like Stripe, because an invoice from 2024 must still be
 * reproducible line for line in 2027.
 */
import type { Ctx } from '../../kernel/context';
import { parseJson } from '../../kernel/db';
import { badRequest, conflict, notFound } from '../../../shared/errors';
import { cursorOf, newId, parseCursor } from '../../../shared/ids';
import { rat, ratMul, ratRound, ratSub } from '../../../shared/money';
import { assertCurrency } from './currencies';
import { decimalToRat, resolveForCurrency, validateTiers } from './engine';
import { anchorUnitDecimal, describePrice, type PriceDisplay } from './format';
import {
  PRODUCT_CATEGORIES, type CurrencyOption, type CustomUnitAmount, type Price, type PriceModel,
  type PriceTier, type PriceType, type PriceUsage, type ProrationBehavior, type Product,
  type ProductCategory, type ProductFeature, type Recurring, type TaxBehavior, type TiersMode,
  type TransformQuantity, type UsageAggregation, type UsageType,
} from './types';
import type { IntervalUnit } from '../../../shared/time';

/* --------------------------------- inputs --------------------------------- */

export interface ProductInput {
  id?: string;
  name: string;
  description?: string | null;
  statement_descriptor?: string | null;
  unit_label?: string | null;
  active?: boolean;
  images?: string[];
  features?: { name: string; lookup_key?: string | null; description?: string | null }[];
  metadata?: Record<string, string>;
  tax_code?: string | null;
  default_price?: string | null;
  category?: ProductCategory;
  tagline?: string | null;
  url?: string | null;
  position?: number;
}

export interface RecurringInput {
  interval: IntervalUnit;
  interval_count?: number;
  usage_type?: UsageType;
  aggregate_usage?: UsageAggregation | null;
  trial_period_days?: number | null;
  meter?: string | null;
}

export interface PriceInput {
  id?: string;
  product: string;
  nickname?: string | null;
  lookup_key?: string | null;
  active?: boolean;
  type?: PriceType;
  model?: PriceModel;
  currency: string;
  unit_amount?: number | null;
  unit_amount_decimal?: string | null;
  tiers_mode?: TiersMode | null;
  tiers?: PriceTier[] | null;
  transform_quantity?: TransformQuantity | null;
  recurring?: RecurringInput | null;
  currency_options?: Record<string, CurrencyOption>;
  custom_unit_amount?: CustomUnitAmount | null;
  tax_behavior?: TaxBehavior;
  proration_behavior?: ProrationBehavior;
  metadata?: Record<string, string>;
}

export interface WriteMeta {
  actorId?: string | null;
  actorType?: 'user' | 'api_key' | 'system' | 'agent' | 'workflow';
  requestId?: string | null;
  livemode?: boolean;
}

export interface ProductListFilter {
  active?: boolean;
  category?: ProductCategory;
  ids?: string[];
  query?: string;
  limit?: number;
  cursor?: string | null;
}

export interface PriceListFilter {
  product?: string;
  active?: boolean;
  type?: PriceType;
  model?: PriceModel;
  currency?: string;
  lookupKey?: string;
  limit?: number;
  cursor?: string | null;
}

export interface Page<T> {
  data: T[];
  hasMore: boolean;
  nextCursor: string | null;
  totalCount: number;
}

/* ------------------------------- hydration -------------------------------- */

export function hydrateProduct(row: any): Product {
  return {
    object: 'product',
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    statement_descriptor: row.statement_descriptor ?? null,
    unit_label: row.unit_label ?? null,
    active: !!row.active,
    images: parseJson<string[]>(row.images, []),
    features: parseJson<ProductFeature[]>(row.features, []),
    metadata: parseJson<Record<string, string>>(row.metadata, {}),
    tax_code: row.tax_code ?? null,
    default_price: row.default_price_id ?? null,
    category: (row.category ?? 'plan') as ProductCategory,
    tagline: row.tagline ?? null,
    url: row.url ?? null,
    position: Number(row.position ?? 0),
    created: Number(row.created),
    updated: Number(row.updated),
    livemode: !!row.livemode,
  };
}

export function hydratePrice(row: any): Price {
  return {
    object: 'price',
    id: row.id,
    product: row.product_id,
    nickname: row.nickname ?? null,
    lookup_key: row.lookup_key ?? null,
    active: !!row.active,
    type: row.type as PriceType,
    model: row.model as PriceModel,
    currency: row.currency,
    unit_amount: row.unit_amount === null || row.unit_amount === undefined ? null : Number(row.unit_amount),
    unit_amount_decimal: row.unit_amount_decimal ?? null,
    billing_scheme: row.billing_scheme,
    tiers_mode: row.tiers_mode ?? null,
    tiers: row.tiers ? parseJson<PriceTier[]>(row.tiers, []) : null,
    transform_quantity: row.transform_quantity ? parseJson<TransformQuantity | null>(row.transform_quantity, null) : null,
    recurring: row.recurring ? parseJson<Recurring | null>(row.recurring, null) : null,
    currency_options: parseJson<Record<string, CurrencyOption>>(row.currency_options, {}),
    custom_unit_amount: row.custom_unit_amount ? parseJson<CustomUnitAmount | null>(row.custom_unit_amount, null) : null,
    tax_behavior: (row.tax_behavior ?? 'unspecified') as TaxBehavior,
    proration_behavior: (row.proration_behavior ?? 'create_prorations') as ProrationBehavior,
    metadata: parseJson<Record<string, string>>(row.metadata, {}),
    created: Number(row.created),
    updated: Number(row.updated),
    livemode: !!row.livemode,
  };
}

/* ------------------------------- normalising ------------------------------ */

const LOOKUP_RE = /^[a-z0-9][a-z0-9_.-]{1,79}$/;

function checkAmount(value: number | null | undefined, param: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value)) throw badRequest('parameter_invalid', 'Amounts are whole numbers of minor units — 1999 means 19.99.', param);
  if (value < 0) throw badRequest('parameter_invalid', 'Amounts cannot be negative. Use a coupon or a credit note instead.', param);
  if (value > 1_000_000_000_000) throw badRequest('parameter_invalid', 'Amount is implausibly large.', param);
  return value;
}

function normalizeTiers(tiers: PriceTier[] | null | undefined, param: string): PriceTier[] | null {
  if (!tiers) return null;
  const cleaned: PriceTier[] = tiers.map((t, i) => {
    const path = `${param}[${i}]`;
    const up_to = t.up_to === 'inf' || t.up_to === null || t.up_to === undefined ? 'inf' : Number(t.up_to);
    if (up_to !== 'inf' && (!Number.isInteger(up_to) || up_to <= 0)) {
      throw badRequest('parameter_invalid', 'up_to must be a positive whole number or "inf".', `${path}.up_to`);
    }
    if (t.unit_amount_decimal) decimalToRat(t.unit_amount_decimal, `${path}.unit_amount_decimal`);
    if (t.flat_amount_decimal) decimalToRat(t.flat_amount_decimal, `${path}.flat_amount_decimal`);
    return {
      up_to,
      unit_amount: checkAmount(t.unit_amount, `${path}.unit_amount`),
      unit_amount_decimal: t.unit_amount_decimal ?? null,
      flat_amount: checkAmount(t.flat_amount, `${path}.flat_amount`),
      flat_amount_decimal: t.flat_amount_decimal ?? null,
    };
  });
  validateTiers(cleaned, param);
  return cleaned;
}

function normalizeTransform(t: TransformQuantity | null | undefined, param = 'transform_quantity'): TransformQuantity | null {
  if (!t) return null;
  if (!Number.isInteger(t.divide_by) || t.divide_by < 1) {
    throw badRequest('parameter_invalid', 'transform_quantity.divide_by must be a whole number of at least 1.', `${param}.divide_by`);
  }
  if (t.round !== 'up' && t.round !== 'down') {
    throw badRequest('parameter_invalid', 'transform_quantity.round must be "up" or "down".', `${param}.round`);
  }
  return { divide_by: t.divide_by, round: t.round };
}

function normalizeCustom(c: CustomUnitAmount | null | undefined, param = 'custom_unit_amount'): CustomUnitAmount | null {
  if (!c) return null;
  const minimum = checkAmount(c.minimum, `${param}.minimum`);
  const maximum = checkAmount(c.maximum, `${param}.maximum`);
  const preset = checkAmount(c.preset, `${param}.preset`);
  if (minimum !== null && maximum !== null && minimum > maximum) {
    throw badRequest('parameter_invalid', 'minimum cannot exceed maximum.', `${param}.minimum`);
  }
  if (preset !== null && minimum !== null && preset < minimum) {
    throw badRequest('parameter_invalid', 'preset must be at least the minimum.', `${param}.preset`);
  }
  if (preset !== null && maximum !== null && preset > maximum) {
    throw badRequest('parameter_invalid', 'preset cannot exceed the maximum.', `${param}.preset`);
  }
  return { enabled: c.enabled !== false, minimum, maximum, preset };
}

function normalizeRecurring(r: RecurringInput | null | undefined, model: PriceModel): Recurring | null {
  if (!r) return null;
  if (!['day', 'week', 'month', 'year'].includes(r.interval)) {
    throw badRequest('parameter_invalid', 'recurring.interval must be day, week, month or year.', 'recurring.interval');
  }
  const count = r.interval_count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 52) {
    throw badRequest('parameter_invalid', 'recurring.interval_count must be a whole number between 1 and 52.', 'recurring.interval_count');
  }
  const usage_type: UsageType = model === 'usage' ? 'metered' : (r.usage_type ?? 'licensed');
  const trial = r.trial_period_days ?? null;
  if (trial !== null && (!Number.isInteger(trial) || trial < 0 || trial > 730)) {
    throw badRequest('parameter_invalid', 'recurring.trial_period_days must be between 0 and 730.', 'recurring.trial_period_days');
  }
  return {
    interval: r.interval,
    interval_count: count,
    usage_type,
    aggregate_usage: usage_type === 'metered' ? (r.aggregate_usage ?? 'sum') : null,
    trial_period_days: trial,
    meter: r.meter ?? null,
  };
}

function normalizeCurrencyOptions(
  options: Record<string, CurrencyOption> | undefined,
  base: string,
): Record<string, CurrencyOption> {
  const out: Record<string, CurrencyOption> = {};
  for (const [raw, option] of Object.entries(options ?? {})) {
    const code = assertCurrency(raw, `currency_options.${raw}`);
    if (code === base) {
      throw badRequest('parameter_invalid', `${code.toUpperCase()} is the price's own currency — set unit_amount or tiers directly instead.`, `currency_options.${raw}`);
    }
    const path = `currency_options.${code}`;
    if (option.unit_amount_decimal) decimalToRat(option.unit_amount_decimal, `${path}.unit_amount_decimal`);
    out[code] = {
      unit_amount: checkAmount(option.unit_amount, `${path}.unit_amount`),
      unit_amount_decimal: option.unit_amount_decimal ?? null,
      tiers: normalizeTiers(option.tiers, `${path}.tiers`),
      custom_unit_amount: normalizeCustom(option.custom_unit_amount, `${path}.custom_unit_amount`),
      tax_behavior: option.tax_behavior ?? 'unspecified',
    };
  }
  return out;
}

function inferModel(input: PriceInput): PriceModel {
  if (input.model) return input.model;
  if (input.custom_unit_amount?.enabled) return 'custom';
  if (input.tiers?.length) return 'tiered';
  if (input.recurring?.usage_type === 'metered') return 'usage';
  if (input.transform_quantity && input.transform_quantity.divide_by > 1) return 'package';
  if (input.recurring) return 'flat';
  return 'per_unit';
}

export interface NormalizedPrice {
  model: PriceModel;
  type: PriceType;
  currency: string;
  unit_amount: number | null;
  unit_amount_decimal: string | null;
  billing_scheme: 'per_unit' | 'tiered';
  tiers_mode: TiersMode | null;
  tiers: PriceTier[] | null;
  transform_quantity: TransformQuantity | null;
  recurring: Recurring | null;
  currency_options: Record<string, CurrencyOption>;
  custom_unit_amount: CustomUnitAmount | null;
  tax_behavior: TaxBehavior;
  proration_behavior: ProrationBehavior;
}

/** Turn a create/replace payload into a coherent, computable price. */
export function normalizePrice(input: PriceInput): NormalizedPrice {
  const currency = assertCurrency(input.currency, 'currency');
  const model = inferModel(input);
  const type: PriceType = input.type ?? (input.recurring ? 'recurring' : 'one_time');
  if (type === 'recurring' && !input.recurring) {
    throw badRequest('parameter_missing', 'A recurring price needs a recurring interval.', 'recurring');
  }
  if (type === 'one_time' && input.recurring) {
    throw badRequest('parameter_invalid', 'A one-time price cannot recur. Set type to "recurring" or drop the recurring field.', 'recurring');
  }
  if (model === 'usage' && type !== 'recurring') {
    throw badRequest('parameter_invalid', 'Metered usage is only billable on a recurring price.', 'type');
  }

  const tiers = normalizeTiers(input.tiers, 'tiers');
  const transform = normalizeTransform(input.transform_quantity);
  const custom = normalizeCustom(input.custom_unit_amount);
  const recurring = normalizeRecurring(input.recurring, model);
  const unit_amount = checkAmount(input.unit_amount, 'unit_amount');
  if (input.unit_amount_decimal) decimalToRat(input.unit_amount_decimal, 'unit_amount_decimal');
  const unit_amount_decimal = input.unit_amount_decimal ?? null;
  const hasUnit = unit_amount !== null || !!unit_amount_decimal;
  const billing_scheme = tiers?.length ? 'tiered' : 'per_unit';

  if (model === 'tiered' && !tiers?.length) {
    throw badRequest('parameter_missing', 'A tiered price needs tiers.', 'tiers');
  }
  if (model === 'package' && (!transform || transform.divide_by < 2)) {
    throw badRequest('parameter_missing', 'Package pricing needs transform_quantity.divide_by of at least 2.', 'transform_quantity');
  }
  if (model === 'custom' && !custom?.enabled) {
    throw badRequest('parameter_missing', 'A custom price needs custom_unit_amount.enabled.', 'custom_unit_amount');
  }
  if (model !== 'custom' && model !== 'tiered' && !hasUnit && billing_scheme === 'per_unit') {
    throw badRequest('parameter_missing', 'Set unit_amount (minor units) or unit_amount_decimal, or supply tiers.', 'unit_amount');
  }
  if (hasUnit && billing_scheme === 'tiered') {
    throw badRequest('parameter_invalid', 'A tiered price is priced by its tiers — remove unit_amount.', 'unit_amount');
  }
  if (model === 'flat' && tiers?.length) {
    throw badRequest('parameter_invalid', 'A flat price cannot have tiers. Use model "tiered".', 'tiers');
  }

  const currency_options = normalizeCurrencyOptions(input.currency_options, currency);
  for (const [code, option] of Object.entries(currency_options)) {
    const optionHasUnit = option.unit_amount !== null || !!option.unit_amount_decimal;
    if (billing_scheme === 'tiered' && !option.tiers?.length) {
      throw badRequest('parameter_missing', `${code.toUpperCase()} needs its own tiers because this price is tiered.`, `currency_options.${code}.tiers`);
    }
    if (billing_scheme === 'per_unit' && model !== 'custom' && !optionHasUnit) {
      throw badRequest('parameter_missing', `${code.toUpperCase()} needs a unit_amount.`, `currency_options.${code}.unit_amount`);
    }
  }

  return {
    model,
    type,
    currency,
    unit_amount,
    unit_amount_decimal,
    billing_scheme,
    tiers_mode: tiers?.length ? (input.tiers_mode ?? 'graduated') : null,
    tiers,
    transform_quantity: transform,
    recurring,
    currency_options,
    custom_unit_amount: custom,
    tax_behavior: input.tax_behavior ?? 'unspecified',
    proration_behavior: input.proration_behavior ?? 'create_prorations',
  };
}

/** Fields that describe how much money changes hands. Frozen once billed. */
export const PRICING_FIELDS = [
  'currency', 'unit_amount', 'unit_amount_decimal', 'tiers', 'tiers_mode', 'transform_quantity',
  'recurring', 'currency_options', 'custom_unit_amount', 'type', 'model', 'product', 'tax_behavior',
] as const;

/* ---------------------------------- store --------------------------------- */

interface ReferencingTable { table: string; column: string; idColumn: string }

export class Catalog {
  private referencing: ReferencingTable[] | null = null;

  constructor(private readonly ctx: Ctx) {}

  /* -------------------------------- products ------------------------------ */

  listProducts(orgId: string, filter: ProductListFilter = {}): Page<Product> {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.active !== undefined) { clauses.push('active = ?'); params.push(filter.active ? 1 : 0); }
    if (filter.category) { clauses.push('category = ?'); params.push(filter.category); }
    if (filter.ids?.length) {
      clauses.push(`id IN (${filter.ids.map(() => '?').join(', ')})`);
      params.push(...filter.ids);
    }
    if (filter.query) {
      clauses.push('(name LIKE ? ESCAPE \'\\\' OR description LIKE ? ESCAPE \'\\\' OR tagline LIKE ? ESCAPE \'\\\')');
      const like = `%${filter.query.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      params.push(like, like, like);
    }
    const where = clauses.join(' AND ');
    const totalCount = this.ctx.db.count(`SELECT COUNT(*) FROM catalog_products WHERE ${where}`, ...(params as any[]));

    const paged = [...params];
    let cursorClause = '';
    if (filter.cursor) {
      const parsed = parseCursor(filter.cursor);
      if (!parsed) throw badRequest('cursor_invalid', 'That pagination cursor is not readable. Start the list again.', 'cursor');
      cursorClause = ' AND (position > ? OR (position = ? AND id > ?))';
      paged.push(parsed.createdAt, parsed.createdAt, parsed.id);
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const rows = this.ctx.db.all<any>(
      `SELECT * FROM catalog_products WHERE ${where}${cursorClause} ORDER BY position ASC, id ASC LIMIT ?`,
      ...(paged as any[]), limit + 1,
    );
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(hydrateProduct);
    const last = data[data.length - 1];
    return { data, hasMore, nextCursor: hasMore && last ? cursorOf(last.position, last.id) : null, totalCount };
  }

  product(orgId: string, id: string): Product | null {
    const row = this.ctx.db.get<any>(`SELECT * FROM catalog_products WHERE org_id = ? AND id = ?`, orgId, id);
    return row ? hydrateProduct(row) : null;
  }

  requireProduct(orgId: string, id: string): Product {
    const found = this.product(orgId, id);
    if (!found) throw notFound('product', id);
    return found;
  }

  createProduct(orgId: string, input: ProductInput, meta: WriteMeta = {}): Product {
    const now = this.ctx.now();
    const name = String(input.name ?? '').trim();
    if (!name) throw badRequest('parameter_missing', 'A product needs a name.', 'name');
    const descriptor = input.statement_descriptor ?? null;
    if (descriptor && descriptor.length > 22) {
      throw badRequest('parameter_invalid', 'Statement descriptors are limited to 22 characters — that is all a card statement shows.', 'statement_descriptor');
    }
    if (descriptor && /[<>"'*\\]/.test(descriptor)) {
      throw badRequest('parameter_invalid', 'Statement descriptors cannot contain < > " \' * or \\.', 'statement_descriptor');
    }
    const category = input.category ?? 'plan';
    if (!PRODUCT_CATEGORIES.includes(category)) {
      throw badRequest('parameter_invalid', `Category must be one of: ${PRODUCT_CATEGORIES.join(', ')}.`, 'category');
    }
    const id = input.id ?? newId('product');
    if (this.ctx.db.get(`SELECT id FROM catalog_products WHERE id = ?`, id)) {
      throw conflict('resource_already_exists', `Product ${id} already exists.`);
    }
    const row = {
      id, org_id: orgId, name,
      description: input.description ?? null,
      statement_descriptor: descriptor,
      unit_label: input.unit_label ?? null,
      active: input.active === false ? 0 : 1,
      images: JSON.stringify(input.images ?? []),
      features: JSON.stringify(normalizeFeatures(input.features)),
      metadata: JSON.stringify(input.metadata ?? {}),
      tax_code: input.tax_code ?? null,
      default_price_id: null as string | null,
      category,
      tagline: input.tagline ?? null,
      url: input.url ?? null,
      position: input.position ?? this.nextPosition(orgId, category),
      created: now, updated: now,
      livemode: meta.livemode === false ? 0 : 1,
    };
    this.ctx.db.insert('catalog_products', row);
    if (input.default_price) this.setDefaultPrice(orgId, id, input.default_price);
    const product = this.requireProduct(orgId, id);
    this.ctx.emit(orgId, 'product.created', product, {
      objectId: id, objectType: 'product', actorId: meta.actorId ?? null, actorType: meta.actorType ?? 'system', requestId: meta.requestId ?? null,
    });
    return product;
  }

  updateProduct(orgId: string, id: string, patch: Partial<ProductInput>, meta: WriteMeta = {}): Product {
    const before = this.requireProduct(orgId, id);
    const changes: Record<string, any> = {};
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw badRequest('parameter_invalid', 'A product needs a name.', 'name');
      changes.name = name;
    }
    if (patch.description !== undefined) changes.description = patch.description;
    if (patch.statement_descriptor !== undefined) {
      if (patch.statement_descriptor && patch.statement_descriptor.length > 22) {
        throw badRequest('parameter_invalid', 'Statement descriptors are limited to 22 characters.', 'statement_descriptor');
      }
      changes.statement_descriptor = patch.statement_descriptor;
    }
    if (patch.unit_label !== undefined) changes.unit_label = patch.unit_label;
    if (patch.active !== undefined) changes.active = patch.active ? 1 : 0;
    if (patch.images !== undefined) changes.images = JSON.stringify(patch.images);
    if (patch.features !== undefined) changes.features = JSON.stringify(normalizeFeatures(patch.features));
    if (patch.metadata !== undefined) changes.metadata = JSON.stringify({ ...before.metadata, ...patch.metadata });
    if (patch.tax_code !== undefined) changes.tax_code = patch.tax_code;
    if (patch.category !== undefined) {
      if (!PRODUCT_CATEGORIES.includes(patch.category)) {
        throw badRequest('parameter_invalid', `Category must be one of: ${PRODUCT_CATEGORIES.join(', ')}.`, 'category');
      }
      changes.category = patch.category;
    }
    if (patch.tagline !== undefined) changes.tagline = patch.tagline;
    if (patch.url !== undefined) changes.url = patch.url;
    if (patch.position !== undefined) changes.position = patch.position;
    if (patch.default_price !== undefined && patch.default_price !== null) {
      this.assertPriceBelongs(orgId, id, patch.default_price);
      changes.default_price_id = patch.default_price;
    } else if (patch.default_price === null) {
      changes.default_price_id = null;
    }
    if (!Object.keys(changes).length) return before;
    changes.updated = this.ctx.now();
    this.ctx.db.patch('catalog_products', 'id', id, changes);
    const after = this.requireProduct(orgId, id);
    this.ctx.emit(orgId, 'product.updated', after, {
      objectId: id, objectType: 'product', previous: diff(before, after),
      actorId: meta.actorId ?? null, actorType: meta.actorType ?? 'system', requestId: meta.requestId ?? null,
    });
    return after;
  }

  deleteProduct(orgId: string, id: string, meta: WriteMeta = {}): Product {
    const product = this.requireProduct(orgId, id);
    const prices = this.ctx.db.count(`SELECT COUNT(*) FROM catalog_prices WHERE org_id = ? AND product_id = ?`, orgId, id);
    if (prices > 0) {
      throw conflict(
        'product_has_prices',
        `${product.name} still has ${prices} price${prices === 1 ? '' : 's'}. Deactivate it instead (active: false) so historical invoices keep their product.`,
        { prices },
      );
    }
    this.ctx.db.run(`DELETE FROM catalog_products WHERE org_id = ? AND id = ?`, orgId, id);
    this.ctx.emit(orgId, 'product.deleted', product, {
      objectId: id, objectType: 'product', actorId: meta.actorId ?? null, actorType: meta.actorType ?? 'system', requestId: meta.requestId ?? null,
    });
    return product;
  }

  setDefaultPrice(orgId: string, productId: string, priceId: string): Product {
    this.assertPriceBelongs(orgId, productId, priceId);
    this.ctx.db.patch('catalog_products', 'id', productId, { default_price_id: priceId, updated: this.ctx.now() });
    return this.requireProduct(orgId, productId);
  }

  private assertPriceBelongs(orgId: string, productId: string, priceId: string): void {
    const price = this.price(orgId, priceId);
    if (!price) throw notFound('price', priceId);
    if (price.product !== productId) {
      throw badRequest('parameter_invalid', `Price ${priceId} belongs to ${price.product}, not ${productId}.`, 'default_price');
    }
  }

  /**
   * Positions are globally ordered but banded by category, so one `ORDER BY
   * position` lists the book the way a pricing page reads it — plans, then the
   * metered components, then add-ons, credit packs and services — and cursor
   * pagination over that single column stays correct.
   */
  private nextPosition(orgId: string, category: ProductCategory): number {
    const base = CATEGORY_BASE[category] ?? 500;
    const max = this.ctx.db.pluck<number>(
      `SELECT MAX(position) FROM catalog_products WHERE org_id = ? AND category = ? AND position >= ? AND position < ?`,
      orgId, category, base, base + 100,
    );
    return (max ?? base) + 10;
  }

  /* --------------------------------- prices ------------------------------- */

  listPrices(orgId: string, filter: PriceListFilter = {}): Page<Price> {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.product) { clauses.push('product_id = ?'); params.push(filter.product); }
    if (filter.active !== undefined) { clauses.push('active = ?'); params.push(filter.active ? 1 : 0); }
    if (filter.type) { clauses.push('type = ?'); params.push(filter.type); }
    if (filter.model) { clauses.push('model = ?'); params.push(filter.model); }
    if (filter.lookupKey) { clauses.push('lookup_key = ?'); params.push(filter.lookupKey); }
    if (filter.currency) {
      const code = filter.currency.toLowerCase();
      clauses.push(`(currency = ? OR json_extract(currency_options, ?) IS NOT NULL)`);
      params.push(code, `$.${code}`);
    }
    const where = clauses.join(' AND ');
    const totalCount = this.ctx.db.count(`SELECT COUNT(*) FROM catalog_prices WHERE ${where}`, ...(params as any[]));

    const paged = [...params];
    let cursorClause = '';
    if (filter.cursor) {
      const parsed = parseCursor(filter.cursor);
      if (!parsed) throw badRequest('cursor_invalid', 'That pagination cursor is not readable. Start the list again.', 'cursor');
      cursorClause = ' AND (created < ? OR (created = ? AND id < ?))';
      paged.push(parsed.createdAt, parsed.createdAt, parsed.id);
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const rows = this.ctx.db.all<any>(
      `SELECT * FROM catalog_prices WHERE ${where}${cursorClause} ORDER BY created DESC, id DESC LIMIT ?`,
      ...(paged as any[]), limit + 1,
    );
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(hydratePrice);
    const last = data[data.length - 1];
    return { data, hasMore, nextCursor: hasMore && last ? cursorOf(last.created, last.id) : null, totalCount };
  }

  price(orgId: string, id: string): Price | null {
    const row = this.ctx.db.get<any>(`SELECT * FROM catalog_prices WHERE org_id = ? AND id = ?`, orgId, id);
    return row ? hydratePrice(row) : null;
  }

  requirePrice(orgId: string, id: string): Price {
    const found = this.price(orgId, id);
    if (!found) throw notFound('price', id);
    return found;
  }

  priceByLookupKey(orgId: string, lookupKey: string): Price | null {
    const row = this.ctx.db.get<any>(`SELECT * FROM catalog_prices WHERE org_id = ? AND lookup_key = ?`, orgId, lookupKey);
    return row ? hydratePrice(row) : null;
  }

  /** `active` is a tri-state: omit it for the whole history of the product. */
  pricesFor(orgId: string, productId: string, opts: { active?: boolean } = {}): Price[] {
    const clause = opts.active === undefined ? '' : ' AND active = ?';
    const params: unknown[] = [orgId, productId];
    if (opts.active !== undefined) params.push(opts.active ? 1 : 0);
    return this.ctx.db.all<any>(
      `SELECT * FROM catalog_prices WHERE org_id = ? AND product_id = ?${clause} ORDER BY created ASC, id ASC`,
      ...(params as any[]),
    ).map(hydratePrice);
  }

  createPrice(orgId: string, input: PriceInput, meta: WriteMeta = {}): Price {
    const product = this.requireProduct(orgId, input.product);
    const normalized = normalizePrice(input);
    const lookupKey = input.lookup_key ?? null;
    if (lookupKey) {
      if (!LOOKUP_RE.test(lookupKey)) {
        throw badRequest('parameter_invalid', 'Lookup keys are lowercase letters, digits, dots, dashes and underscores (2–80 characters).', 'lookup_key');
      }
      const clash = this.priceByLookupKey(orgId, lookupKey);
      if (clash) throw conflict('lookup_key_in_use', `Lookup key "${lookupKey}" already points at ${clash.id}. Pass transfer_lookup_key to move it.`);
    }
    const id = input.id ?? newId('price');
    if (this.ctx.db.get(`SELECT id FROM catalog_prices WHERE id = ?`, id)) {
      throw conflict('resource_already_exists', `Price ${id} already exists.`);
    }
    const now = this.ctx.now();
    this.ctx.db.insert('catalog_prices', {
      id, org_id: orgId, product_id: product.id,
      nickname: input.nickname ?? null,
      lookup_key: lookupKey,
      active: input.active === false ? 0 : 1,
      type: normalized.type,
      model: normalized.model,
      currency: normalized.currency,
      unit_amount: normalized.unit_amount,
      unit_amount_decimal: normalized.unit_amount_decimal,
      billing_scheme: normalized.billing_scheme,
      tiers_mode: normalized.tiers_mode,
      tiers: normalized.tiers ? JSON.stringify(normalized.tiers) : null,
      transform_quantity: normalized.transform_quantity ? JSON.stringify(normalized.transform_quantity) : null,
      recurring: normalized.recurring ? JSON.stringify(normalized.recurring) : null,
      currency_options: JSON.stringify(normalized.currency_options),
      custom_unit_amount: normalized.custom_unit_amount ? JSON.stringify(normalized.custom_unit_amount) : null,
      tax_behavior: normalized.tax_behavior,
      proration_behavior: normalized.proration_behavior,
      metadata: JSON.stringify(input.metadata ?? {}),
      created: now, updated: now,
      livemode: meta.livemode === false ? 0 : 1,
    });
    const price = this.requirePrice(orgId, id);
    if (!product.default_price && price.active) {
      this.ctx.db.patch('catalog_products', 'id', product.id, { default_price_id: id, updated: now });
    }
    this.ctx.emit(orgId, 'price.created', price, {
      objectId: id, objectType: 'price', actorId: meta.actorId ?? null, actorType: meta.actorType ?? 'system', requestId: meta.requestId ?? null,
    });
    return price;
  }

  /**
   * Prices are immutable once anything has billed against them. Before that,
   * a price can still be corrected; afterwards only its labels move.
   */
  updatePrice(
    orgId: string,
    id: string,
    patch: Partial<PriceInput> & { transfer_lookup_key?: boolean },
    meta: WriteMeta = {},
  ): Price {
    const before = this.requirePrice(orgId, id);
    const usage = this.priceUsage(orgId, id);
    const changes: Record<string, any> = {};

    const touched = PRICING_FIELDS.filter((field) => (patch as Record<string, unknown>)[field] !== undefined);
    if (touched.length && usage.in_use) {
      throw conflict(
        'price_immutable',
        `${before.nickname ? `"${before.nickname}"` : id} has already billed ${usage.count} object${usage.count === 1 ? '' : 's'}, so ${touched.join(', ')} cannot change. Create a new price and move the subscriptions across — that keeps every historical invoice reproducible.`,
        { price: id, field: touched[0], references: usage.references.slice(0, 10) },
      );
    }

    if (touched.length) {
      const merged: PriceInput = {
        product: (patch.product as string) ?? before.product,
        currency: patch.currency ?? before.currency,
        type: patch.type ?? before.type,
        model: patch.model ?? before.model,
        unit_amount: patch.unit_amount !== undefined ? patch.unit_amount : before.unit_amount,
        unit_amount_decimal: patch.unit_amount_decimal !== undefined ? patch.unit_amount_decimal : before.unit_amount_decimal,
        tiers: patch.tiers !== undefined ? patch.tiers : before.tiers,
        tiers_mode: patch.tiers_mode !== undefined ? patch.tiers_mode : before.tiers_mode,
        transform_quantity: patch.transform_quantity !== undefined ? patch.transform_quantity : before.transform_quantity,
        recurring: patch.recurring !== undefined ? patch.recurring : before.recurring,
        currency_options: patch.currency_options !== undefined ? patch.currency_options : before.currency_options,
        custom_unit_amount: patch.custom_unit_amount !== undefined ? patch.custom_unit_amount : before.custom_unit_amount,
        tax_behavior: patch.tax_behavior ?? before.tax_behavior,
        proration_behavior: patch.proration_behavior ?? before.proration_behavior,
      };
      if (merged.product !== before.product) this.requireProduct(orgId, merged.product);
      const normalized = normalizePrice(merged);
      Object.assign(changes, {
        product_id: merged.product,
        type: normalized.type,
        model: normalized.model,
        currency: normalized.currency,
        unit_amount: normalized.unit_amount,
        unit_amount_decimal: normalized.unit_amount_decimal,
        billing_scheme: normalized.billing_scheme,
        tiers_mode: normalized.tiers_mode,
        tiers: normalized.tiers ? JSON.stringify(normalized.tiers) : null,
        transform_quantity: normalized.transform_quantity ? JSON.stringify(normalized.transform_quantity) : null,
        recurring: normalized.recurring ? JSON.stringify(normalized.recurring) : null,
        currency_options: JSON.stringify(normalized.currency_options),
        custom_unit_amount: normalized.custom_unit_amount ? JSON.stringify(normalized.custom_unit_amount) : null,
        tax_behavior: normalized.tax_behavior,
      });
    }

    if (patch.active !== undefined) changes.active = patch.active ? 1 : 0;
    if (patch.nickname !== undefined) changes.nickname = patch.nickname;
    if (patch.metadata !== undefined) changes.metadata = JSON.stringify({ ...before.metadata, ...patch.metadata });
    if (patch.proration_behavior !== undefined) changes.proration_behavior = patch.proration_behavior;
    if (patch.lookup_key !== undefined) {
      const key = patch.lookup_key;
      if (key === null) changes.lookup_key = null;
      else {
        if (!LOOKUP_RE.test(key)) {
          throw badRequest('parameter_invalid', 'Lookup keys are lowercase letters, digits, dots, dashes and underscores (2–80 characters).', 'lookup_key');
        }
        const clash = this.priceByLookupKey(orgId, key);
        if (clash && clash.id !== id) {
          if (!patch.transfer_lookup_key) {
            throw conflict('lookup_key_in_use', `Lookup key "${key}" already points at ${clash.id}. Pass transfer_lookup_key: true to move it here.`);
          }
          this.ctx.db.patch('catalog_prices', 'id', clash.id, { lookup_key: null, updated: this.ctx.now() });
        }
        changes.lookup_key = key;
      }
    }
    if (!Object.keys(changes).length) return before;
    changes.updated = this.ctx.now();
    this.ctx.db.patch('catalog_prices', 'id', id, changes);
    const after = this.requirePrice(orgId, id);
    if (!after.active) {
      this.ctx.db.run(
        `UPDATE catalog_products SET default_price_id = NULL, updated = ? WHERE org_id = ? AND default_price_id = ?`,
        this.ctx.now(), orgId, id,
      );
    }
    this.ctx.emit(orgId, 'price.updated', after, {
      objectId: id, objectType: 'price', previous: diff(before, after),
      actorId: meta.actorId ?? null, actorType: meta.actorType ?? 'system', requestId: meta.requestId ?? null,
    });
    return after;
  }

  deletePrice(orgId: string, id: string, meta: WriteMeta = {}): Price {
    const price = this.requirePrice(orgId, id);
    const usage = this.priceUsage(orgId, id);
    if (usage.in_use) {
      throw conflict(
        'price_in_use',
        `${price.nickname ? `"${price.nickname}"` : id} is referenced by ${usage.count} object${usage.count === 1 ? '' : 's'} and cannot be deleted. Set active: false so it stops being sold but keeps explaining past invoices.`,
        { references: usage.references.slice(0, 10) },
      );
    }
    this.ctx.db.run(
      `UPDATE catalog_products SET default_price_id = NULL, updated = ? WHERE org_id = ? AND default_price_id = ?`,
      this.ctx.now(), orgId, id,
    );
    this.ctx.db.run(`DELETE FROM catalog_prices WHERE org_id = ? AND id = ?`, orgId, id);
    this.ctx.emit(orgId, 'price.deleted', price, {
      objectId: id, objectType: 'price', actorId: meta.actorId ?? null, actorType: meta.actorType ?? 'system', requestId: meta.requestId ?? null,
    });
    return price;
  }

  /* ------------------------------ price usage ----------------------------- */

  registerPriceUsage(orgId: string, priceId: string, ref: { type: string; id: string }): void {
    this.ctx.db.upsert(
      'catalog_price_usage',
      { org_id: orgId, price_id: priceId, ref_type: ref.type, ref_id: ref.id, created: this.ctx.now() },
      ['org_id', 'price_id', 'ref_type', 'ref_id'],
    );
  }

  releasePriceUsage(orgId: string, priceId: string, ref: { type: string; id: string }): void {
    this.ctx.db.run(
      `DELETE FROM catalog_price_usage WHERE org_id = ? AND price_id = ? AND ref_type = ? AND ref_id = ?`,
      orgId, priceId, ref.type, ref.id,
    );
  }

  /**
   * Who is billing against this price. Modules register references explicitly,
   * and any table that carries both `org_id` and `price_id` is also scanned, so
   * this answer stays true as subscriptions and invoicing land alongside us.
   */
  priceUsage(orgId: string, priceId: string): PriceUsage {
    const references: { type: string; id: string }[] = this.ctx.db.all<any>(
      `SELECT ref_type, ref_id FROM catalog_price_usage WHERE org_id = ? AND price_id = ? LIMIT 50`, orgId, priceId,
    ).map((r) => ({ type: r.ref_type, id: String(r.ref_id) }));
    let count = this.ctx.db.count(`SELECT COUNT(*) FROM catalog_price_usage WHERE org_id = ? AND price_id = ?`, orgId, priceId);

    for (const t of this.referencingTables()) {
      const n = this.ctx.db.count(`SELECT COUNT(*) FROM ${t.table} WHERE org_id = ? AND ${t.column} = ?`, orgId, priceId);
      if (!n) continue;
      count += n;
      for (const row of this.ctx.db.all<any>(
        `SELECT ${t.idColumn} AS ref FROM ${t.table} WHERE org_id = ? AND ${t.column} = ? LIMIT 10`, orgId, priceId,
      )) {
        references.push({ type: t.table, id: String(row.ref) });
      }
    }
    return { count, references, in_use: count > 0 };
  }

  private referencingTables(): ReferencingTable[] {
    if (this.referencing) return this.referencing;
    const safe = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const out: ReferencingTable[] = [];
    const tables = this.ctx.db.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'catalog_%'`,
    );
    for (const { name } of tables) {
      if (!safe.test(name)) continue;
      const columns = this.ctx.db.all<{ name: string }>(`PRAGMA table_info(${name})`).map((c) => c.name);
      if (!columns.includes('org_id') || !columns.includes('price_id')) continue;
      out.push({ table: name, column: 'price_id', idColumn: columns.includes('id') ? 'id' : 'rowid' });
    }
    this.referencing = out;
    return out;
  }

  /** Called when a module migrates in after the catalog has already booted. */
  invalidateReferenceCache(): void { this.referencing = null; }

  /* ------------------------------ catalog view ---------------------------- */

  catalogView(orgId: string, opts: { currency?: string; locale?: string; includeInactive?: boolean } = {}): CatalogView {
    const includeInactive = opts.includeInactive === true;
    const productRows = this.ctx.db.all<any>(
      `SELECT * FROM catalog_products WHERE org_id = ?${includeInactive ? '' : ' AND active = 1'} ORDER BY category ASC, position ASC, id ASC`,
      orgId,
    ).map(hydrateProduct);
    const priceRows = this.ctx.db.all<any>(
      `SELECT * FROM catalog_prices WHERE org_id = ?${includeInactive ? '' : ' AND active = 1'} ORDER BY created ASC, id ASC`,
      orgId,
    ).map(hydratePrice);

    const currencies = [...new Set(priceRows.flatMap((p) => [p.currency, ...Object.keys(p.currency_options)]))].sort();
    const currency = (opts.currency || currencies[0] || 'usd').toLowerCase();
    if (currencies.length && !currencies.includes(currency)) {
      throw badRequest('currency_not_supported', `This catalog sells in ${currencies.map((c) => c.toUpperCase()).join(', ')}, not ${currency.toUpperCase()}.`, 'currency');
    }
    const locale = opts.locale || 'en-US';

    const byProduct = new Map<string, Price[]>();
    for (const price of priceRows) {
      const bucket = byProduct.get(price.product) ?? [];
      bucket.push(price);
      byProduct.set(price.product, bucket);
    }

    const view = (product: Product): CatalogProductView => {
      const prices = (byProduct.get(product.id) ?? [])
        .filter((p) => p.currency === currency || !!p.currency_options[currency])
        .sort(displayOrder)
        .map((p) => this.priceView(p, product, currency, locale, currencies));
      return { product, prices, default_price: product.default_price };
    };

    const productsInCategory = (category: ProductCategory) =>
      productRows.filter((p) => p.category === category).map(view);

    const plans = productsInCategory('plan').map((entry) => this.planView(entry));

    return {
      object: 'catalog',
      currency,
      currencies,
      locale,
      updated: productRows.concat().reduce((acc, p) => Math.max(acc, p.updated), 0),
      plans,
      components: productsInCategory('component'),
      add_ons: productsInCategory('add_on'),
      credit_packs: productsInCategory('credit_pack'),
      services: productsInCategory('service'),
      feature_matrix: featureMatrix(plans),
      totals: {
        products: productRows.length,
        prices: priceRows.length,
        active_prices: priceRows.filter((p) => p.active).length,
      },
    };
  }

  priceView(price: Price, product: Product, currency: string, locale: string, currencies: string[]): CatalogPriceView {
    const by_currency: Record<string, PriceDisplay> = {};
    for (const code of currencies) {
      if (code !== price.currency && !price.currency_options[code]) continue;
      by_currency[code] = describePrice(price, code, locale, product);
    }
    return {
      ...price,
      product_name: product.name,
      unit_label: product.unit_label,
      display: describePrice(price, currency, locale, product),
      by_currency,
      anchor_unit_amount_decimal: anchorUnitDecimal(price, currency),
    };
  }

  private planView(entry: CatalogProductView): CatalogPlanView {
    const componentOf = (p: CatalogPriceView) => p.metadata.component ?? (p.model === 'custom' ? 'custom' : 'base');
    const find = (component: string, interval: string) =>
      entry.prices.find((p) => componentOf(p) === component && p.recurring?.interval === interval) ?? null;

    const base = { month: find('base', 'month'), year: find('base', 'year') };
    const seat = { month: find('seat', 'month'), year: find('seat', 'year') };
    const custom = entry.prices.find((p) => p.model === 'custom') ?? null;

    const pairs: [number, number][] = [];
    for (const [monthly, annual] of [[base.month, base.year], [seat.month, seat.year]] as const) {
      if (monthly?.unit_amount != null && annual?.unit_amount != null) pairs.push([monthly.unit_amount, annual.unit_amount]);
    }
    let annual_discount_percent: number | null = null;
    if (pairs.length) {
      const monthlyYear = pairs.reduce((acc, [m]) => acc + m * 12, 0);
      const annualTotal = pairs.reduce((acc, [, y]) => acc + y, 0);
      if (monthlyYear > 0 && annualTotal < monthlyYear) {
        const saved = ratMul(ratSub(rat(BigInt(monthlyYear)), rat(BigInt(annualTotal))), rat(100n));
        annual_discount_percent = Number(ratRound(rat(saved.n, saved.d * BigInt(monthlyYear)), 'half_up'));
      }
    }
    return { ...entry, base, seat, custom, annual_discount_percent };
  }
}

/* ------------------------------- view types ------------------------------- */

export interface CatalogPriceView extends Price {
  product_name: string;
  /** The product's unit noun, carried so a price renders on its own. */
  unit_label: string | null;
  display: PriceDisplay;
  by_currency: Record<string, PriceDisplay>;
  /** Cheapest per-unit rate in minor units — for sorting and "from" copy. */
  anchor_unit_amount_decimal: string | null;
}

export interface CatalogProductView {
  product: Product;
  prices: CatalogPriceView[];
  default_price: string | null;
}

export interface CatalogPlanView extends CatalogProductView {
  base: { month: CatalogPriceView | null; year: CatalogPriceView | null };
  seat: { month: CatalogPriceView | null; year: CatalogPriceView | null };
  custom: CatalogPriceView | null;
  /** Whole-percent saving of paying annually, computed from the two prices. */
  annual_discount_percent: number | null;
}

export interface FeatureMatrixRow {
  lookup_key: string;
  name: string;
  description: string | null;
  /** Product id → the plan's own wording for this feature, or null if absent. */
  values: Record<string, string | null>;
}

export interface CatalogView {
  object: 'catalog';
  currency: string;
  currencies: string[];
  locale: string;
  updated: number;
  plans: CatalogPlanView[];
  components: CatalogProductView[];
  add_ons: CatalogProductView[];
  credit_packs: CatalogProductView[];
  services: CatalogProductView[];
  feature_matrix: { plans: { id: string; name: string }[]; rows: FeatureMatrixRow[] };
  totals: { products: number; prices: number; active_prices: number };
}

/* --------------------------------- helpers -------------------------------- */

export const CATEGORY_BASE: Record<ProductCategory, number> = {
  plan: 0, component: 100, add_on: 200, credit_pack: 300, service: 400,
};

/** Pricing pages read top-down: platform fee, then seats, then usage. */
const COMPONENT_ORDER = ['base', 'seat', 'metered', 'addon', 'credits', 'onboarding', 'custom'];
const INTERVAL_ORDER = ['day', 'week', 'month', 'year'];

function displayOrder(a: Price, b: Price): number {
  const rank = (p: Price) => {
    const component = p.metadata.component ?? (p.model === 'custom' ? 'custom' : 'base');
    const idx = COMPONENT_ORDER.indexOf(component);
    return idx < 0 ? COMPONENT_ORDER.length : idx;
  };
  const cadence = (p: Price) => (p.recurring ? INTERVAL_ORDER.indexOf(p.recurring.interval) : INTERVAL_ORDER.length);
  return rank(a) - rank(b) || cadence(a) - cadence(b) || a.created - b.created || a.id.localeCompare(b.id);
}

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'feature';

export function normalizeFeatures(features: ProductInput['features']): ProductFeature[] {
  return (features ?? []).map((f) => {
    const name = String(f.name ?? '').trim();
    if (!name) throw badRequest('parameter_invalid', 'Every feature needs a name.', 'features');
    return { name, lookup_key: f.lookup_key || slugify(name), description: f.description ?? null };
  });
}

/** The subset of `before` whose values changed — Stripe's previous_attributes. */
function diff<T extends object>(before: T, after: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) out[key] = a[key];
  }
  return out;
}

function featureMatrix(plans: CatalogPlanView[]): CatalogView['feature_matrix'] {
  const rows = new Map<string, FeatureMatrixRow>();
  for (const plan of plans) {
    for (const feature of plan.product.features) {
      const row = rows.get(feature.lookup_key) ?? {
        lookup_key: feature.lookup_key,
        name: feature.name,
        description: feature.description,
        values: Object.fromEntries(plans.map((p) => [p.product.id, null])) as Record<string, string | null>,
      };
      row.values[plan.product.id] = feature.name;
      if (!row.description && feature.description) row.description = feature.description;
      rows.set(feature.lookup_key, row);
    }
  }
  return { plans: plans.map((p) => ({ id: p.product.id, name: p.product.name })), rows: [...rows.values()] };
}

export const priceCurrencies = (price: Price): string[] =>
  [price.currency, ...Object.keys(price.currency_options)].filter((c, i, all) => all.indexOf(c) === i);

export { resolveForCurrency };
