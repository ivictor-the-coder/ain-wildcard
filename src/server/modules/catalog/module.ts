import { defineModule } from '../../kernel/module';
import type { Ctx } from '../../kernel/context';
import { created, list, noContent, type Req } from '../../kernel/http';
import { badRequest, notFound } from '../../../shared/errors';
import { rat, ratAdd, ratRound } from '../../../shared/money';
import v, { type SchemaNode, type Validator } from '../../../shared/validate';
import { assertCurrency, CURRENCY_CODES, currencyName } from './currencies';
import { CATALOG_MIGRATIONS } from './schema';
import {
  Catalog, type CatalogView, type PriceInput, type PriceListFilter, type ProductInput, type ProductListFilter,
} from './store';
import {
  aggregateUsage, boundariesOf, computeLineAmount, currenciesOf, previewCurve, resolveForCurrency,
  type ComputeOptions, type CurveOptions,
} from './engine';
import { describePrice, formatMinor, formatMinorDecimal, type PriceDisplay } from './format';
import { seedCatalog } from './seed';
import {
  INTERVAL_UNITS, PRICE_MODELS, PRICE_TYPES, PRODUCT_CATEGORIES, PRORATION_BEHAVIORS, TAX_BEHAVIORS,
  TIERS_MODES, USAGE_AGGREGATIONS, USAGE_TYPES,
  type LineAmount, type Price, type PriceCurve, type PriceUsage, type Product, type UsageAggregation,
  type UsageRecord,
} from './types';

/* -------------------------------- service --------------------------------- */

/**
 * Everything the rest of the platform needs from the price book. Subscriptions,
 * invoicing, quotes, checkout and the copilot all price through `compute`, so
 * there is exactly one implementation of graduated tiering in the codebase.
 */
export interface CatalogService {
  products(orgId: string, filter?: ProductListFilter): Product[];
  product(orgId: string, id: string): Product | null;
  requireProduct(orgId: string, id: string): Product;
  prices(orgId: string, filter?: PriceListFilter): Price[];
  price(orgId: string, id: string): Price | null;
  requirePrice(orgId: string, id: string): Price;
  priceByLookupKey(orgId: string, lookupKey: string): Price | null;
  pricesFor(orgId: string, productId: string, opts?: { active?: boolean }): Price[];

  createProduct(orgId: string, input: ProductInput): Product;
  createPrice(orgId: string, input: PriceInput): Price;

  /** Exact line amount plus a breakdown whose rows sum to it, to the cent. */
  compute(price: Price, quantity: number, currency?: string, opts?: ComputeOptions): LineAmount;
  computeById(orgId: string, priceId: string, quantity: number, currency?: string, opts?: ComputeOptions): LineAmount;
  /** The effective unit-cost curve across a quantity range. */
  curve(price: Price, currency?: string, opts?: CurveOptions): PriceCurve;
  /** Collapse metered usage records into the quantity a price bills for. */
  aggregate(records: UsageRecord[], aggregation: UsageAggregation): number;

  currencies(price: Price): string[];
  describe(price: Price, currency?: string, locale?: string, product?: Product | null): PriceDisplay;

  /** Who bills against a price — the reason a used price can never be edited. */
  usage(orgId: string, priceId: string): PriceUsage;
  registerUsage(orgId: string, priceId: string, ref: { type: string; id: string }): void;
  releaseUsage(orgId: string, priceId: string, ref: { type: string; id: string }): void;

  view(orgId: string, opts?: { currency?: string; locale?: string; includeInactive?: boolean }): CatalogView;
}

declare module '../../kernel/services' {
  interface ServiceRegistry { catalog: CatalogService }
}

const engines = new WeakMap<Ctx, Catalog>();
export function catalogStore(ctx: Ctx): Catalog {
  let engine = engines.get(ctx);
  if (!engine) { engine = new Catalog(ctx); engines.set(ctx, engine); }
  return engine;
}

const writeMeta = (req: Req) => ({
  actorId: req.auth.userId ?? req.auth.keyId ?? null,
  actorType: (req.auth.kind === 'api_key' ? 'api_key' : req.auth.kind === 'system' ? 'system' : 'user') as
    'user' | 'api_key' | 'system',
  requestId: req.requestId,
  livemode: req.auth.livemode,
});

/* ------------------------------- validators ------------------------------- */

/**
 * `[a-z]{3}` is a shape, not a currency: it accepts "zzz", and a price's
 * currency can never be edited once the price has billed. Every currency that
 * enters the catalog is checked against the ISO-4217 register instead.
 */
const currencyCode = (): Validator<string> => ({
  parse: (value: unknown, path = '') => assertCurrency(v.currency().parse(value, path), path || 'currency'),
  describe: (): SchemaNode => ({
    type: 'string', format: 'currency', pattern: '^[a-z]{3}$',
    description: 'Lowercase ISO-4217 currency code, e.g. usd.',
  }),
});

/** Prose on a field, so `/api/openapi.json` explains it and not just its type. */
const described = <T>(inner: Validator<T>, description: string): Validator<T> =>
  v.transform(inner, (value) => value, { description });

const tierBody = v.object({
  up_to: v.union(v.int({ min: 1 }), v.literal('inf')),
  unit_amount: v.optional(v.int({ min: 0 })),
  unit_amount_decimal: v.optional(v.string({ max: 40 })),
  flat_amount: v.optional(v.int({ min: 0 })),
  flat_amount_decimal: v.optional(v.string({ max: 40 })),
}, { strict: true });

const customAmountBody = v.object({
  enabled: v.default(v.boolean(), true),
  minimum: v.optional(v.int({ min: 0 })),
  maximum: v.optional(v.int({ min: 0 })),
  preset: v.optional(v.int({ min: 0 })),
}, { strict: true });

const recurringBody = v.object({
  interval: v.enum(INTERVAL_UNITS),
  interval_count: v.optional(v.int({ min: 1, max: 52 })),
  usage_type: v.optional(v.enum(USAGE_TYPES)),
  aggregate_usage: v.optional(v.enum(USAGE_AGGREGATIONS)),
  trial_period_days: v.optional(v.int({ min: 0, max: 730 })),
  meter: v.optional(v.string({ max: 80 })),
}, { strict: true });

const currencyOptionBody = v.object({
  unit_amount: v.optional(v.int({ min: 0 })),
  unit_amount_decimal: v.optional(v.string({ max: 40 })),
  tiers: v.optional(v.array(tierBody, { max: 60 })),
  custom_unit_amount: v.optional(customAmountBody),
  tax_behavior: v.optional(v.enum(TAX_BEHAVIORS)),
}, { strict: true });

const PRICE_FIELDS = {
  currency: currencyCode(),
  nickname: v.optional(v.nullable(v.string({ max: 160 }))),
  lookup_key: v.optional(v.nullable(v.string({ max: 80 }))),
  transfer_lookup_key: v.optional(described(
    v.boolean(),
    'Take lookup_key off whichever price currently holds it and give it to this one, in the same transaction. Without it a key already in use is a 409, so the standard "cut the key over to the replacement price" migration is one atomic call on create as well as on update — the key is never briefly unowned.',
  )),
  active: v.optional(v.boolean()),
  type: v.optional(v.enum(PRICE_TYPES)),
  model: v.optional(described(
    v.enum(PRICE_MODELS),
    'How a quantity turns into money. Omit it and the payload decides, the way Stripe reads one: tiers → tiered, recurring.usage_type "metered" → usage, transform_quantity → package, custom_unit_amount → custom, and otherwise per_unit — unit_amount multiplied by the quantity. "flat", one charge whatever the quantity, is never inferred: ask for it by name.',
  )),
  unit_amount: v.optional(described(
    v.int({ min: 0 }),
    'The price of one unit, in integer minor units — 1000 is $10.00. Multiplied by the quantity on every model but "flat".',
  )),
  unit_amount_decimal: v.optional(described(
    v.string({ max: 40 }),
    'A sub-cent rate as a decimal string of minor units: "0.04" is 0.04 cents, $0.0004 per unit. Up to 12 decimal places, kept exact through the whole calculation.',
  )),
  tiers_mode: v.optional(described(
    v.enum(TIERS_MODES),
    'How tiers combine: "graduated" charges each tier for the units that fall inside it, "volume" charges every unit at the rate of the tier the total lands in. Defaults to graduated, which bills more than volume on the same ladder.',
  )),
  tiers: v.optional(v.array(tierBody, { min: 1, max: 60 })),
  transform_quantity: v.optional(v.object({ divide_by: v.int({ min: 1 }), round: v.enum(['up', 'down'] as const) }, { strict: true })),
  recurring: v.optional(recurringBody),
  currency_options: v.optional(v.record(currencyOptionBody)),
  custom_unit_amount: v.optional(customAmountBody),
  tax_behavior: v.optional(v.enum(TAX_BEHAVIORS)),
  proration_behavior: v.optional(v.enum(PRORATION_BEHAVIORS)),
  metadata: v.metadata(),
};

/**
 * Every catalog write body is strict. A dropped `tiersMode` is not a typo the
 * API can shrug off: the price it silently creates is a *graduated* one that
 * bills half again as much as the volume price the operator meant to write, and
 * the price it created can never be repriced. Unknown keys are named and
 * refused, the way Stripe answers `Received unknown parameter`.
 */
const priceCreateBody = v.object({ product: v.id('prod'), ...PRICE_FIELDS }, { strict: true });
const priceDataBody = v.object(PRICE_FIELDS, { strict: true });

const priceUpdateBody = v.object({
  product: v.optional(v.id('prod')),
  currency: v.optional(currencyCode()),
  ...Object.fromEntries(Object.entries(PRICE_FIELDS).filter(([k]) => k !== 'currency')),
}, { strict: true });

const featureBody = v.object({
  name: v.string({ min: 1, max: 160 }),
  lookup_key: v.optional(v.string({ min: 1, max: 60 })),
  description: v.optional(v.string({ max: 400 })),
}, { strict: true });

/**
 * The fields a product can be edited *back out of* are nullable, not merely
 * optional: an operator who typed a tagline has to be able to untype it, and
 * the store has always known how to clear them.
 */
const PRODUCT_FIELDS = {
  description: v.optional(v.nullable(v.string({ max: 2000 }))),
  statement_descriptor: v.optional(v.nullable(v.string({ max: 22 }))),
  unit_label: v.optional(v.nullable(v.string({ max: 40 }))),
  active: v.optional(v.boolean()),
  images: v.optional(v.array(v.string({ max: 500 }), { max: 8 })),
  features: v.optional(v.array(featureBody, { max: 60 })),
  metadata: v.metadata(),
  tax_code: v.optional(v.nullable(v.string({ max: 60 }))),
  default_price: v.optional(v.nullable(v.id('price'))),
  category: v.optional(v.enum(PRODUCT_CATEGORIES)),
  tagline: v.optional(v.nullable(v.string({ max: 200 }))),
  url: v.optional(v.nullable(v.string({ max: 500 }))),
  position: v.optional(v.int({ min: 0, max: 1_000_000 })),
};

const productCreateBody = v.object({
  name: v.string({ min: 1, max: 150 }),
  default_price_data: v.optional(priceDataBody),
  ...PRODUCT_FIELDS,
}, { strict: true });

const productUpdateBody = v.object(
  { name: v.optional(v.string({ min: 1, max: 150 })), ...PRODUCT_FIELDS }, { strict: true },
);

const usageRecordBody = v.object({
  quantity: v.int({ min: 0 }),
  timestamp: v.optional(v.timestamp()),
  key: v.optional(v.string({ max: 120 })),
}, { strict: true });

const previewBody = v.object({
  quantity: v.optional(v.int({ min: 0 })),
  currency: v.optional(currencyCode()),
  custom_unit_amount: v.optional(v.int({ min: 0 })),
  usage_records: v.optional(v.array(usageRecordBody, { max: 500 })),
  proration: v.optional(v.object({ numerator: v.int({ min: 0 }), denominator: v.int({ min: 1 }) }, { strict: true })),
}, { strict: true });

/* --------------------------------- queries -------------------------------- */

const expandQuery = v.object({ expand: v.optional(v.string({ max: 120 })) });

const productListQuery = v.object({
  active: v.optional(v.boolean()),
  category: v.optional(v.enum(PRODUCT_CATEGORIES)),
  query: v.optional(v.string({ max: 120 })),
  limit: v.optional(v.int({ min: 1, max: 200 })),
  cursor: v.optional(v.string({ max: 200 })),
  expand: v.optional(v.string({ max: 120 })),
});

const productPricesQuery = v.object({ active: v.optional(v.boolean()) });

const priceListQuery = v.object({
  product: v.optional(v.id('prod')),
  active: v.optional(v.boolean()),
  type: v.optional(v.enum(PRICE_TYPES)),
  model: v.optional(v.enum(PRICE_MODELS)),
  currency: v.optional(currencyCode()),
  lookup_key: v.optional(v.string({ max: 80 })),
  limit: v.optional(v.int({ min: 1, max: 200 })),
  cursor: v.optional(v.string({ max: 200 })),
});

const curveQuery = v.object({
  from: v.optional(v.int({ min: 0 })),
  to: v.optional(v.int({ min: 1 })),
  points: v.optional(v.int({ min: 2, max: 250 })),
  quantities: v.optional(v.string({ max: 600 })),
  currency: v.optional(currencyCode()),
  custom_unit_amount: v.optional(v.int({ min: 0 })),
});

const catalogQuery = v.object({
  currency: v.optional(currencyCode()),
  include_inactive: v.optional(v.boolean()),
});

/**
 * `Req.query` is declared as raw strings, but by the time a handler runs the
 * router has replaced it with the output of the route's own query validator:
 * `?active=true` arrives as the boolean `true`, and comparing it to the string
 * "true" silently matches nothing. Reading the query back through the same
 * validator is what carries the coerced types into the handler, so that
 * comparison stops compiling instead of quietly filtering the list wrong.
 */
const queryOf = <T>(req: Req, schema: Validator<T>): T => schema.parse(req.query);

/* ------------------------------ presentation ------------------------------ */

const expandList = (req: Req): string[] =>
  String(req.query.expand ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function productPayload(
  ctx: Ctx, orgId: string, product: Product, expand: string[], active?: boolean,
): Record<string, unknown> {
  if (!expand.includes('prices')) return { ...product };
  const store = catalogStore(ctx);
  const locale = localeOf(ctx, orgId);
  return {
    ...product,
    // An archived price inlined under ?active=true would contradict the filter.
    prices: store.pricesFor(orgId, product.id, { active }).map((p) => pricePayload(p, product, locale)),
  };
}

function pricePayload(price: Price, product: Product | null, locale: string): Record<string, unknown> {
  return {
    ...price,
    currencies: currenciesOf(price),
    display: describePrice(price, price.currency, locale, product),
    ...(product ? { product_name: product.name, unit_label: product.unit_label } : {}),
  };
}

/**
 * What a flat price has to say when it is quoted at a quantity it will not
 * bill. The subscription route refuses an item carrying one outright; a quote
 * is a question rather than a purchase, so it answers — and then says plainly
 * that the number it just gave is one charge, not `quantity` of them.
 */
function flatQuantityWarning(
  price: Price, quantity: number, amount: number, currency: string, locale: string,
): { code: string; param: string; message: string } | null {
  if (price.model !== 'flat' || quantity === 1) return null;
  const asked = quantity.toLocaleString(locale);
  return {
    code: 'flat_price_quantity',
    param: 'quantity',
    message: `${price.nickname ? `"${price.nickname}"` : price.id} is a flat fee: this is one charge of ${formatMinor(amount, currency, locale)}, not ${asked} of them. A subscription item on a flat price must carry quantity 1 — move the line onto a per-unit price if it should scale.`,
  };
}

const localeOf = (ctx: Ctx, orgId: string): string => {
  try { return ctx.svc.core.org(orgId).locale || 'en-US'; }
  catch { return 'en-US'; }
};

const currencyOf = (ctx: Ctx, orgId: string): string => {
  try { return ctx.svc.core.currency(orgId); }
  catch { return 'usd'; }
};

/* --------------------------------- module --------------------------------- */

export default defineModule({
  name: 'catalog',
  title: 'Products & pricing',
  description:
    'The price book and the pricing engine: products, immutable prices, graduated and volume tiers, package and metered pricing, multi-currency, and the exact quantity-to-money calculation every invoice line is built from.',
  dependsOn: ['core'],
  migrations: CATALOG_MIGRATIONS,

  boot(ctx) {
    const store = catalogStore(ctx);
    const service: CatalogService = {
      products: (orgId, filter) => store.listProducts(orgId, { limit: 200, ...filter }).data,
      product: (orgId, id) => store.product(orgId, id),
      requireProduct: (orgId, id) => store.requireProduct(orgId, id),
      prices: (orgId, filter) => store.listPrices(orgId, { limit: 200, ...filter }).data,
      price: (orgId, id) => store.price(orgId, id),
      requirePrice: (orgId, id) => store.requirePrice(orgId, id),
      priceByLookupKey: (orgId, key) => store.priceByLookupKey(orgId, key),
      pricesFor: (orgId, productId, opts) => store.pricesFor(orgId, productId, opts),

      createProduct: (orgId, input) => store.createProduct(orgId, input),
      createPrice: (orgId, input) => store.createPrice(orgId, input),

      compute: (price, quantity, currency, opts) => computeLineAmount(price, quantity, currency, opts),
      computeById(orgId, priceId, quantity, currency, opts) {
        const price = store.requirePrice(orgId, priceId);
        const product = store.product(orgId, price.product);
        return computeLineAmount(price, quantity, currency, { unitLabel: product?.unit_label ?? null, ...opts });
      },
      curve: (price, currency, opts) => previewCurve(price, currency, opts),
      aggregate: (records, aggregation) => aggregateUsage(records, aggregation),

      currencies: (price) => currenciesOf(price),
      describe: (price, currency, locale, product) => describePrice(price, currency ?? price.currency, locale ?? 'en-US', product),

      usage: (orgId, priceId) => store.priceUsage(orgId, priceId),
      registerUsage: (orgId, priceId, ref) => store.registerPriceUsage(orgId, priceId, ref),
      releaseUsage: (orgId, priceId, ref) => store.releasePriceUsage(orgId, priceId, ref),

      view: (orgId, opts) => store.catalogView(orgId, {
        currency: opts?.currency ?? currencyOf(ctx, orgId),
        locale: opts?.locale ?? localeOf(ctx, orgId),
        includeInactive: opts?.includeInactive,
      }),
    };
    ctx.provide('catalog', service);
  },

  seed(ctx, orgId) {
    seedCatalog(ctx, orgId);
  },

  routes(router, ctx) {
    const store = catalogStore(ctx);

    /* -------------------------------- products ---------------------------- */

    router.get('/v1/products', (req: Req, c: Ctx) => {
      const q = queryOf(req, productListQuery);
      const page = catalogStore(c).listProducts(req.auth.orgId, {
        active: q.active,
        category: q.category,
        query: q.query,
        limit: q.limit,
        cursor: q.cursor ?? null,
      });
      const expand = expandList(req);
      return list(page.data.map((p) => productPayload(c, req.auth.orgId, p, expand, q.active)), {
        hasMore: page.hasMore, nextCursor: page.nextCursor, totalCount: page.totalCount, url: '/v1/products',
      });
    }, {
      summary: 'List products', tags: ['catalog'],
      description: 'Ordered the way the pricing page shows them. Pass active=true for the live book, active=false for what has been archived, and expand=prices to inline each product’s prices under the same filter.',
      query: productListQuery,
    });

    router.post('/v1/products', (req: Req, c: Ctx) => {
      const body = req.body as ProductInput & { default_price_data?: Omit<PriceInput, 'product'> };
      const s = catalogStore(c);
      return created(c.atomic(() => {
        const { default_price_data: priceData, ...input } = body;
        const product = s.createProduct(req.auth.orgId, input, writeMeta(req));
        if (priceData) {
          const price = s.createPrice(req.auth.orgId, { ...priceData, product: product.id }, writeMeta(req));
          return { ...s.setDefaultPrice(req.auth.orgId, product.id, price.id), prices: [pricePayload(price, product, localeOf(c, req.auth.orgId))] };
        }
        return product;
      }));
    }, {
      summary: 'Create a product', tags: ['catalog'], roles: ['member'], idempotent: true,
      description: 'Pass default_price_data to create the product and its first price in one atomic call.',
      body: productCreateBody,
    });

    router.get('/v1/products/:id', (req: Req, c: Ctx) => {
      const product = catalogStore(c).requireProduct(req.auth.orgId, req.params.id);
      const expand = expandList(req);
      return productPayload(c, req.auth.orgId, product, expand.length ? expand : ['prices']);
    }, {
      summary: 'Retrieve a product', tags: ['catalog'],
      query: expandQuery,
    });

    router.patch('/v1/products/:id', (req: Req, c: Ctx) =>
      c.atomic(() => catalogStore(c).updateProduct(req.auth.orgId, req.params.id, req.body as Partial<ProductInput>, writeMeta(req))),
      { summary: 'Update a product', tags: ['catalog'], roles: ['member'], body: productUpdateBody });

    router.del('/v1/products/:id', (req: Req, c: Ctx) => {
      c.atomic(() => catalogStore(c).deleteProduct(req.auth.orgId, req.params.id, writeMeta(req)));
      return noContent();
    }, {
      summary: 'Delete a product', tags: ['catalog'], roles: ['admin'],
      description: 'Refused while the product still has prices — deactivate it instead so historical invoices keep their product.',
    });

    router.get('/v1/products/:id/prices', (req: Req, c: Ctx) => {
      const s = catalogStore(c);
      const product = s.requireProduct(req.auth.orgId, req.params.id);
      const q = queryOf(req, productPricesQuery);
      const locale = localeOf(c, req.auth.orgId);
      const prices = s.pricesFor(req.auth.orgId, product.id, { active: q.active });
      return list(prices.map((p) => pricePayload(p, product, locale)),
        { totalCount: prices.length, url: `/v1/products/${product.id}/prices` });
    }, {
      summary: 'List a product’s prices', tags: ['catalog'],
      description: 'Oldest first, so a price history reads in the order it happened. Pass active=true for the prices a new subscription may use; the default keeps archived prices, which is what old invoices still reference.',
      query: productPricesQuery,
    });

    /* --------------------------------- prices ----------------------------- */

    router.get('/v1/prices', (req: Req, c: Ctx) => {
      const q = queryOf(req, priceListQuery);
      const s = catalogStore(c);
      const page = s.listPrices(req.auth.orgId, {
        product: q.product,
        active: q.active,
        type: q.type,
        model: q.model,
        currency: q.currency,
        lookupKey: q.lookup_key,
        limit: q.limit,
        cursor: q.cursor ?? null,
      });
      const locale = localeOf(c, req.auth.orgId);
      const products = new Map<string, Product | null>();
      const data = page.data.map((price) => {
        if (!products.has(price.product)) products.set(price.product, s.product(req.auth.orgId, price.product));
        return pricePayload(price, products.get(price.product) ?? null, locale);
      });
      return list(data, { hasMore: page.hasMore, nextCursor: page.nextCursor, totalCount: page.totalCount, url: '/v1/prices' });
    }, {
      summary: 'List prices', tags: ['catalog'],
      description: 'Newest first. active=true is the book a new subscription can buy from; active=false is what has been archived and still appears on historical invoices.',
      query: priceListQuery,
    });

    router.post('/v1/prices', (req: Req, c: Ctx) =>
      created(c.atomic(() => {
        const s = catalogStore(c);
        const price = s.createPrice(req.auth.orgId, req.body as PriceInput, writeMeta(req));
        return pricePayload(price, s.product(req.auth.orgId, price.product), localeOf(c, req.auth.orgId));
      })),
      {
        summary: 'Create a price', tags: ['catalog'], roles: ['member'], idempotent: true,
        description:
          'Amounts are integer minor units and never negative, whether written as unit_amount or as unit_amount_decimal, which carries sub-cent metered rates ("0.04" = 0.04 cents). Leave model out and it is read from the payload exactly as Stripe reads one — {unit_amount, recurring} is a per-unit price that multiplies by quantity — so the only model that must be asked for by name is "flat", the one whose money does not follow from the other fields. Unknown parameters are refused rather than dropped: a mistyped tiers_mode would otherwise create a price that bills differently and can never be repriced.',
        body: priceCreateBody,
      });

    router.get('/v1/prices/:id', (req: Req, c: Ctx) => {
      const s = catalogStore(c);
      const price = s.requirePrice(req.auth.orgId, req.params.id);
      const product = s.product(req.auth.orgId, price.product);
      const usage = s.priceUsage(req.auth.orgId, price.id);
      return {
        ...pricePayload(price, product, localeOf(c, req.auth.orgId)),
        usage,
        editable: !usage.in_use,
        boundaries: price.billing_scheme === 'tiered' || price.transform_quantity ? boundariesOf(price, price.currency) : [],
      };
    }, { summary: 'Retrieve a price', tags: ['catalog'] });

    router.patch('/v1/prices/:id', (req: Req, c: Ctx) =>
      c.atomic(() => {
        const s = catalogStore(c);
        const price = s.updatePrice(req.auth.orgId, req.params.id, req.body as Partial<PriceInput>, writeMeta(req));
        return pricePayload(price, s.product(req.auth.orgId, price.product), localeOf(c, req.auth.orgId));
      }),
      {
        summary: 'Update a price', tags: ['catalog'], roles: ['member'],
        description:
          'Labels (nickname, lookup_key, metadata, active) are always editable. Amounts, tiers, currency and cadence can only change while nothing has billed against the price; after that, create a new price and migrate.',
        body: priceUpdateBody,
      });

    router.del('/v1/prices/:id', (req: Req, c: Ctx) => {
      c.atomic(() => catalogStore(c).deletePrice(req.auth.orgId, req.params.id, writeMeta(req)));
      return noContent();
    }, {
      summary: 'Delete a price', tags: ['catalog'], roles: ['admin'],
      description: 'Refused once anything references the price. Deactivate it instead so old invoices still explain themselves.',
    });

    /* ------------------------------- pricing ------------------------------ */

    router.post('/v1/prices/:id/preview', (req: Req, c: Ctx) => {
      const s = catalogStore(c);
      const price = s.requirePrice(req.auth.orgId, req.params.id);
      const product = s.product(req.auth.orgId, price.product);
      const body = req.body as {
        quantity?: number; currency?: string; custom_unit_amount?: number;
        usage_records?: UsageRecord[]; proration?: { numerator: number; denominator: number };
      };
      const aggregation = price.recurring?.aggregate_usage ?? 'sum';
      const quantity = body.usage_records?.length
        ? aggregateUsage(body.usage_records.map((r) => ({ ...r, timestamp: r.timestamp ?? c.now() })), aggregation)
        : body.quantity ?? 0;

      const line = computeLineAmount(price, quantity, body.currency, {
        customUnitAmount: body.custom_unit_amount ?? null,
        proration: body.proration ?? null,
        unitLabel: product?.unit_label ?? null,
      });
      const locale = localeOf(c, req.auth.orgId);
      return {
        ...line,
        object: 'price_preview',
        price: price.id,
        warning: flatQuantityWarning(price, quantity, line.amount, line.currency, locale),
        product: product ? { id: product.id, name: product.name, unit_label: product.unit_label } : null,
        amount_display: formatMinor(line.amount, line.currency, locale),
        effective_unit_display: formatMinorDecimal(line.effective_unit_amount_decimal, line.currency, locale),
        marginal_unit_display: formatMinorDecimal(line.marginal_unit_amount_decimal, line.currency, locale),
        breakdown: line.breakdown.map((row) => ({
          ...row,
          amount_display: formatMinor(row.amount, line.currency, locale),
          unit_display: row.unit_amount_decimal ? formatMinorDecimal(row.unit_amount_decimal, line.currency, locale) : null,
        })),
        aggregated_from: body.usage_records?.length ? { records: body.usage_records.length, aggregation } : null,
      };
    }, {
      summary: 'Price a quantity, with the arithmetic shown', tags: ['catalog'],
      description:
        'Returns the amount and a breakdown whose rows sum exactly to it. Send usage_records instead of a quantity to see how a metered period aggregates.',
      body: previewBody,
    });

    router.get('/v1/prices/:id/curve', (req: Req, c: Ctx) => {
      const s = catalogStore(c);
      const price = s.requirePrice(req.auth.orgId, req.params.id);
      const product = s.product(req.auth.orgId, price.product);
      const q = queryOf(req, curveQuery);
      const quantities = q.quantities
        ? q.quantities.split(',').map((n) => Number(n.trim())).filter((n) => Number.isFinite(n))
        : undefined;
      const curve = previewCurve(price, q.currency, {
        from: q.from,
        to: q.to,
        points: q.points,
        quantities,
        customUnitAmount: q.custom_unit_amount ?? null,
        unitLabel: product?.unit_label ?? null,
      });
      const locale = localeOf(c, req.auth.orgId);
      return {
        ...curve,
        unit_label: product?.unit_label ?? null,
        product_name: product?.name ?? null,
        best_unit_display: formatMinorDecimal(curve.best_unit_amount_decimal, curve.currency, locale),
        worst_unit_display: formatMinorDecimal(curve.worst_unit_amount_decimal, curve.currency, locale),
        points: curve.points.map((p) => ({
          ...p,
          amount_display: formatMinor(p.amount, curve.currency, locale),
          effective_unit_display: formatMinorDecimal(p.effective_unit_amount_decimal, curve.currency, locale),
        })),
      };
    }, {
      summary: 'Effective unit-cost curve across a quantity range', tags: ['catalog'],
      description: 'Powers the "what would 25,000 events cost?" widget. Tier boundaries are always sampled, so the steps land exactly where the price changes.',
      query: curveQuery,
    });

    /* -------------------------------- catalog ----------------------------- */

    router.get('/v1/catalog', (req: Req, c: Ctx) => {
      const q = queryOf(req, catalogQuery);
      return catalogStore(c).catalogView(req.auth.orgId, {
        currency: q.currency || currencyOf(c, req.auth.orgId),
        locale: localeOf(c, req.auth.orgId),
        includeInactive: q.include_inactive,
      });
    }, {
      summary: 'The whole price book, shaped for a pricing page', tags: ['catalog'],
      description: 'Plans with their base and per-seat prices, shared metered components, add-ons, services, credit packs, a feature comparison matrix and the annual saving, all computed from the stored prices. include_inactive=true adds the archived products and prices, for an internal price-book view.',
      query: catalogQuery,
    });

    router.get('/v1/catalog/currencies', (req: Req, c: Ctx) => {
      const orgId = req.auth.orgId;
      const store = catalogStore(c);
      const home = currencyOf(c, orgId);
      const counts = new Map<string, number>();
      let cursor: string | null = null;
      do {
        const page = store.listPrices(orgId, { limit: 200, cursor });
        for (const price of page.data) {
          for (const code of currenciesOf(price)) counts.set(code, (counts.get(code) ?? 0) + 1);
        }
        cursor = page.nextCursor;
      } while (cursor);
      const offered = [...counts.keys()].sort();
      return list(
        offered.map((code) => ({
          object: 'catalog_currency',
          code,
          name: currencyName(code),
          symbol: formatMinor(0, code, localeOf(c, orgId)).replace(/[\d.,\s]/g, ''),
          prices: counts.get(code) ?? 0,
          default: code === home,
        })),
        { totalCount: offered.length },
      );
    }, {
      summary: 'Currencies this price book already sells in', tags: ['catalog'],
      description: `The currency picker's source of truth: every code that appears on a price or one of its currency_options, with the number of prices quoted in it. New codes must be valid ISO-4217 — ${CURRENCY_CODES.length} are accepted.`,
    });

    router.post('/v1/catalog/estimate', (req: Req, c: Ctx) => {
      const s = catalogStore(c);
      const body = req.body as { currency?: string; lines: { price: string; quantity?: number; custom_unit_amount?: number }[] };
      const locale = localeOf(c, req.auth.orgId);
      const currency = (body.currency || currencyOf(c, req.auth.orgId)).toLowerCase();

      const lines = body.lines.map((input) => {
        const price = s.price(req.auth.orgId, input.price) ?? s.priceByLookupKey(req.auth.orgId, input.price);
        if (!price) throw notFound('price', input.price);
        const product = s.product(req.auth.orgId, price.product);
        const line = computeLineAmount(price, input.quantity ?? 1, currency, {
          customUnitAmount: input.custom_unit_amount ?? null,
          unitLabel: product?.unit_label ?? null,
        });
        return {
          ...line,
          nickname: price.nickname,
          product: product ? { id: product.id, name: product.name, unit_label: product.unit_label } : null,
          interval: price.recurring ? { unit: price.recurring.interval, count: price.recurring.interval_count } : null,
          amount_display: formatMinor(line.amount, currency, locale),
          warning: flatQuantityWarning(price, input.quantity ?? 1, line.amount, currency, locale),
        };
      });

      const bucket = (unit: string | null) => lines
        .filter((l) => (l.interval?.unit ?? null) === unit)
        .reduce((acc, l) => acc + l.amount, 0);
      const monthly = bucket('month');
      const yearly = bucket('year');
      const weekly = bucket('week');
      const daily = bucket('day');
      const oneTime = bucket(null);
      // A single comparable figure for the plan switcher, rounded once.
      const monthlyEquivalent = Number(ratRound(
        [rat(BigInt(monthly)), rat(BigInt(yearly), 12n), rat(BigInt(weekly) * 52n, 12n), rat(BigInt(daily) * 365n, 12n)]
          .reduce((acc, r) => ratAdd(acc, r), rat(0n)),
        'half_up',
      ));

      return {
        object: 'catalog_estimate',
        currency,
        lines,
        // A basket total that is smaller than the quantities asked for has to
        // say why on the total, not only on the line that shrank.
        warnings: lines.flatMap((l) => (l.warning ? [{ price: l.price, ...l.warning }] : [])),
        recurring: {
          day: daily, week: weekly, month: monthly, year: yearly,
          monthly_equivalent: monthlyEquivalent,
          monthly_equivalent_display: formatMinor(monthlyEquivalent, currency, locale),
        },
        one_time: oneTime,
        one_time_display: formatMinor(oneTime, currency, locale),
        due_today: oneTime + monthly + weekly + daily + yearly,
        due_today_display: formatMinor(oneTime + monthly + weekly + daily + yearly, currency, locale),
      };
    }, {
      summary: 'Price a whole basket — the pricing page calculator', tags: ['catalog'], roles: ['readonly'],
      description: 'Accepts price ids or lookup keys, prices every line in one currency, and rolls the result up per interval plus a monthly-equivalent figure.',
      body: v.object({
        currency: v.optional(currencyCode()),
        lines: v.array(v.object({
          price: v.string({ min: 3, max: 120 }),
          quantity: v.optional(v.int({ min: 0 })),
          custom_unit_amount: v.optional(v.int({ min: 0 })),
        }, { strict: true }), { min: 1, max: 50 }),
      }, { strict: true }),
    });

    void store;
  },

  tools(ctx) {
    const locale = () => 'en-US';
    return [
      {
        name: 'catalog_list_products',
        description: 'List Northwind products with their prices and what each one costs. Use this before quoting anything.',
        readOnly: true,
        tags: ['catalog', 'billing'],
        input: v.object({
          category: v.optional(v.enum(PRODUCT_CATEGORIES)),
          currency: v.optional(currencyCode()),
        }),
        run(args: { category?: string; currency?: string }, c: Ctx, meta) {
          const s = catalogStore(c);
          const currency = (args.currency || currencyOf(c, meta.orgId)).toLowerCase();
          return s.listProducts(meta.orgId, { active: true, category: args.category as ProductListFilter['category'], limit: 100 })
            .data.map((product) => ({
              id: product.id,
              name: product.name,
              tagline: product.tagline,
              category: product.category,
              unit_label: product.unit_label,
              features: product.features.map((f) => f.name),
              prices: s.pricesFor(meta.orgId, product.id, { active: true })
                .filter((p) => p.currency === currency || !!p.currency_options[currency])
                .map((p) => ({
                  id: p.id, lookup_key: p.lookup_key, nickname: p.nickname, model: p.model,
                  summary: describePrice(p, currency, locale(), product).summary,
                })),
            }));
        },
      },
      {
        name: 'catalog_quote_price',
        description:
          'Work out exactly what a quantity costs on a given price, with the tier-by-tier arithmetic shown. Accepts a price id or a lookup key such as "telemetry_events_monthly".',
        readOnly: true,
        tags: ['catalog', 'billing'],
        input: v.object({
          price: v.string({ min: 3, max: 120 }),
          quantity: v.int({ min: 0 }),
          currency: v.optional(currencyCode()),
          custom_unit_amount: v.optional(v.int({ min: 0 })),
        }),
        run(args: { price: string; quantity: number; currency?: string; custom_unit_amount?: number }, c: Ctx, meta) {
          const s = catalogStore(c);
          const price = s.price(meta.orgId, args.price) ?? s.priceByLookupKey(meta.orgId, args.price);
          if (!price) throw notFound('price', args.price);
          const product = s.product(meta.orgId, price.product);
          const currency = (args.currency || currencyOf(c, meta.orgId)).toLowerCase();
          const line = computeLineAmount(price, args.quantity, currency, {
            customUnitAmount: args.custom_unit_amount ?? null,
            unitLabel: product?.unit_label ?? null,
          });
          return {
            price: price.id,
            product: product?.name ?? null,
            quantity: args.quantity,
            amount: line.amount,
            amount_display: formatMinor(line.amount, currency, locale()),
            warning: flatQuantityWarning(price, args.quantity, line.amount, currency, locale())?.message ?? null,
            effective_unit_display: formatMinorDecimal(line.effective_unit_amount_decimal, currency, locale()),
            breakdown: line.breakdown.map((row) => `${row.label} — ${formatMinor(row.amount, currency, locale())}`),
          };
        },
      },
      {
        name: 'catalog_cost_curve',
        description: 'Show how the cost of a metered or tiered price behaves across a quantity range, including where the rate steps down.',
        readOnly: true,
        tags: ['catalog', 'billing'],
        input: v.object({
          price: v.string({ min: 3, max: 120 }),
          from: v.optional(v.int({ min: 0 })),
          to: v.optional(v.int({ min: 1 })),
          currency: v.optional(currencyCode()),
        }),
        run(args: { price: string; from?: number; to?: number; currency?: string }, c: Ctx, meta) {
          const s = catalogStore(c);
          const price = s.price(meta.orgId, args.price) ?? s.priceByLookupKey(meta.orgId, args.price);
          if (!price) throw notFound('price', args.price);
          const product = s.product(meta.orgId, price.product);
          const currency = (args.currency || currencyOf(c, meta.orgId)).toLowerCase();
          const curve = previewCurve(price, currency, {
            from: args.from, to: args.to, points: 12, unitLabel: product?.unit_label ?? null,
          });
          return {
            price: price.id,
            currency,
            boundaries: curve.boundaries,
            points: curve.points.map((p) => ({
              quantity: p.quantity,
              amount_display: formatMinor(p.amount, currency, locale()),
              effective_unit_display: formatMinorDecimal(p.effective_unit_amount_decimal, currency, locale()),
            })),
          };
        },
      },
      {
        name: 'catalog_create_price',
        description:
          'Add a new price to an existing product. Prices are immutable once billed, so this is how a price change is made — the old price is deactivated separately.',
        readOnly: false,
        requiresApproval: true,
        tags: ['catalog', 'billing'],
        input: priceCreateBody,
        run(args: PriceInput, c: Ctx, meta) {
          return c.atomic(() => {
            const price = catalogStore(c).createPrice(meta.orgId, args, { actorId: meta.actorId ?? null, actorType: 'agent' });
            return { id: price.id, product: price.product, summary: describePrice(price, price.currency, locale(), catalogStore(c).product(meta.orgId, price.product)).summary };
          });
        },
      },
    ];
  },
});

export { computeLineAmount, previewCurve, aggregateUsage, resolveForCurrency };
export type { LineAmount, Price, Product, PriceCurve, PriceUsage };
