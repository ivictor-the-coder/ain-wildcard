/**
 * Northwind Robotics' real price book.
 *
 * A four-rung ladder (Starter → Growth → Scale → Enterprise) with per-seat
 * components, metered telemetry events on graduated tiers, packaged data
 * exports, an annual option at two months free, a one-off commissioning fee and
 * a prepaid credit pack — priced in USD, EUR and GBP. Every number here is the
 * one the invoices, the pricing page and the revenue reports all read.
 */
import type { Ctx } from '../../kernel/context';
import { DAY } from '../../../shared/time';
import { Catalog, type PriceInput, type ProductInput } from './store';

/** The repo's convention for "no uploaded asset yet" — see core's avatars. */
const swatch = (hex: string) => [`color:${hex}`];

interface SeedProduct extends ProductInput {
  id: string;
  /** Days before "now" this product was added to the book. */
  ageDays: number;
  prices: (Omit<PriceInput, 'product'> & { id: string; ageDays?: number })[];
  /** Lookup key of the price that should be the product's default. */
  defaultPriceKey?: string;
}

const SAAS_TAX_CODE = 'txcd_10103001';
const SERVICE_TAX_CODE = 'txcd_20060046';

export const NORTHWIND_CATALOG: SeedProduct[] = [
  {
    id: 'prod_nw_starter',
    ageDays: 420,
    name: 'Telemetry Cloud Starter',
    tagline: 'One line, one dashboard, live in an afternoon.',
    description:
      'Stream vibration, torque and cycle-time telemetry from a single production line into Northwind Cloud. Includes the standard anomaly rules, live line dashboards and a 30-day history you can export at any time.',
    statement_descriptor: 'NORTHWIND STARTER',
    unit_label: 'seat',
    category: 'plan',
    position: 10,
    tax_code: SAAS_TAX_CODE,
    url: 'https://northwind.io/pricing/starter',
    images: swatch('#12A0A0'),
    metadata: { rung: '1', ideal_for: 'single line', included_events: '500000' },
    features: [
      { name: '3 operator seats', lookup_key: 'seats', description: 'Named operators who can view and acknowledge alerts.' },
      { name: 'Up to 10 connected robots', lookup_key: 'robots', description: 'Cells, arms and AGVs streaming into the platform.' },
      { name: '500,000 telemetry events included each month', lookup_key: 'events_included', description: 'Overage is billed on the graduated telemetry price.' },
      { name: '30-day event retention', lookup_key: 'retention', description: 'How far back the raw event stream stays queryable.' },
      { name: 'Standard anomaly rules', lookup_key: 'anomaly' },
      { name: 'Email support, next business day', lookup_key: 'support' },
    ],
    defaultPriceKey: 'starter_monthly',
    prices: [
      {
        id: 'price_nw_starter_monthly', ageDays: 420, model: 'flat', type: 'recurring', currency: 'usd',
        nickname: 'Starter — monthly', lookup_key: 'starter_monthly', unit_amount: 9900,
        recurring: { interval: 'month', trial_period_days: 14 },
        currency_options: { eur: { unit_amount: 8900 }, gbp: { unit_amount: 7900 } },
        tax_behavior: 'exclusive', metadata: { component: 'base', term: 'monthly' },
      },
      {
        id: 'price_nw_starter_annual', ageDays: 400, model: 'flat', type: 'recurring', currency: 'usd',
        nickname: 'Starter — annual (2 months free)', lookup_key: 'starter_annual', unit_amount: 99000,
        recurring: { interval: 'year', trial_period_days: 14 },
        currency_options: { eur: { unit_amount: 89000 }, gbp: { unit_amount: 79000 } },
        tax_behavior: 'exclusive', metadata: { component: 'base', term: 'annual' },
      },
    ],
  },
  {
    id: 'prod_nw_growth',
    ageDays: 420,
    name: 'Telemetry Cloud Growth',
    tagline: 'For plant-wide rollouts with a team watching the floor.',
    description:
      'Everything in Starter across every line in the plant, plus shift handover reports, maintenance work-order routing and the alert-routing rules engine. Seats are added as the team grows and billed per seat per month.',
    statement_descriptor: 'NORTHWIND GROWTH',
    unit_label: 'seat',
    category: 'plan',
    position: 20,
    tax_code: SAAS_TAX_CODE,
    url: 'https://northwind.io/pricing/growth',
    images: swatch('#5B4BE1'),
    metadata: { rung: '2', ideal_for: 'single plant', included_events: '5000000', popular: 'true' },
    features: [
      { name: '10 operator seats included, then $29 each', lookup_key: 'seats' },
      { name: 'Up to 75 connected robots', lookup_key: 'robots' },
      { name: '5,000,000 telemetry events included each month', lookup_key: 'events_included' },
      { name: '12-month event retention', lookup_key: 'retention' },
      { name: 'Custom anomaly rules and alert routing', lookup_key: 'anomaly' },
      { name: 'Priority email and chat, 4-hour response', lookup_key: 'support' },
      { name: 'SAML single sign-on', lookup_key: 'sso' },
    ],
    defaultPriceKey: 'growth_monthly',
    prices: [
      {
        id: 'price_nw_growth_monthly', ageDays: 420, model: 'flat', type: 'recurring', currency: 'usd',
        nickname: 'Growth platform fee — monthly', lookup_key: 'growth_monthly', unit_amount: 49900,
        recurring: { interval: 'month', trial_period_days: 14 },
        currency_options: { eur: { unit_amount: 45900 }, gbp: { unit_amount: 39900 } },
        tax_behavior: 'exclusive', metadata: { component: 'base', term: 'monthly' },
      },
      {
        id: 'price_nw_growth_annual', ageDays: 400, model: 'flat', type: 'recurring', currency: 'usd',
        nickname: 'Growth platform fee — annual (2 months free)', lookup_key: 'growth_annual', unit_amount: 499000,
        recurring: { interval: 'year', trial_period_days: 14 },
        currency_options: { eur: { unit_amount: 459000 }, gbp: { unit_amount: 399000 } },
        tax_behavior: 'exclusive', metadata: { component: 'base', term: 'annual' },
      },
      {
        id: 'price_nw_growth_seat_monthly', ageDays: 420, model: 'per_unit', type: 'recurring', currency: 'usd',
        nickname: 'Growth operator seat — monthly', lookup_key: 'growth_seat_monthly', unit_amount: 2900,
        recurring: { interval: 'month' },
        currency_options: { eur: { unit_amount: 2700 }, gbp: { unit_amount: 2400 } },
        tax_behavior: 'exclusive', metadata: { component: 'seat', term: 'monthly', included_with_plan: '10' },
      },
      {
        id: 'price_nw_growth_seat_annual', ageDays: 400, model: 'per_unit', type: 'recurring', currency: 'usd',
        nickname: 'Growth operator seat — annual', lookup_key: 'growth_seat_annual', unit_amount: 29000,
        recurring: { interval: 'year' },
        currency_options: { eur: { unit_amount: 27000 }, gbp: { unit_amount: 24000 } },
        tax_behavior: 'exclusive', metadata: { component: 'seat', term: 'annual', included_with_plan: '10' },
      },
    ],
  },
  {
    id: 'prod_nw_scale',
    ageDays: 300,
    name: 'Telemetry Cloud Scale',
    tagline: 'Multi-site fleets, long retention and a named engineer.',
    description:
      'Fleet-wide telemetry across every site, with cross-plant benchmarking, predictive maintenance models, three-year retention and a 24×7 support rota. Seats are volume-priced, so the rate falls as the fleet team grows.',
    statement_descriptor: 'NORTHWIND SCALE',
    unit_label: 'seat',
    category: 'plan',
    position: 30,
    tax_code: SAAS_TAX_CODE,
    url: 'https://northwind.io/pricing/scale',
    images: swatch('#D63F8F'),
    metadata: { rung: '3', ideal_for: 'multi-site fleets', included_events: '25000000' },
    features: [
      { name: '25 operator seats included, volume-priced after', lookup_key: 'seats' },
      { name: 'Up to 400 connected robots', lookup_key: 'robots' },
      { name: '25,000,000 telemetry events included each month', lookup_key: 'events_included' },
      { name: '3-year event retention', lookup_key: 'retention' },
      { name: 'Predictive maintenance models included', lookup_key: 'anomaly' },
      { name: '24×7 support with a 1-hour response SLA', lookup_key: 'support' },
      { name: 'SAML SSO and SCIM provisioning', lookup_key: 'sso' },
      { name: 'Cross-site benchmarking and OEE reporting', lookup_key: 'benchmarking' },
    ],
    defaultPriceKey: 'scale_monthly',
    prices: [
      {
        id: 'price_nw_scale_monthly', ageDays: 300, model: 'flat', type: 'recurring', currency: 'usd',
        nickname: 'Scale platform fee — monthly', lookup_key: 'scale_monthly', unit_amount: 190000,
        recurring: { interval: 'month', trial_period_days: 30 },
        currency_options: { eur: { unit_amount: 175000 }, gbp: { unit_amount: 152000 } },
        tax_behavior: 'exclusive', metadata: { component: 'base', term: 'monthly' },
      },
      {
        id: 'price_nw_scale_annual', ageDays: 300, model: 'flat', type: 'recurring', currency: 'usd',
        nickname: 'Scale platform fee — annual (2 months free)', lookup_key: 'scale_annual', unit_amount: 1900000,
        recurring: { interval: 'year', trial_period_days: 30 },
        currency_options: { eur: { unit_amount: 1750000 }, gbp: { unit_amount: 1520000 } },
        tax_behavior: 'exclusive', metadata: { component: 'base', term: 'annual' },
      },
      {
        id: 'price_nw_scale_seat_monthly', ageDays: 300, model: 'tiered', type: 'recurring', currency: 'usd',
        nickname: 'Scale operator seat — monthly (volume)', lookup_key: 'scale_seat_monthly',
        tiers_mode: 'volume',
        tiers: [
          { up_to: 25, unit_amount: 2400 },
          { up_to: 100, unit_amount: 1900 },
          { up_to: 'inf', unit_amount: 1500 },
        ],
        recurring: { interval: 'month' },
        currency_options: {
          eur: { tiers: [{ up_to: 25, unit_amount: 2200 }, { up_to: 100, unit_amount: 1750 }, { up_to: 'inf', unit_amount: 1400 }] },
          gbp: { tiers: [{ up_to: 25, unit_amount: 1900 }, { up_to: 100, unit_amount: 1500 }, { up_to: 'inf', unit_amount: 1200 }] },
        },
        tax_behavior: 'exclusive', metadata: { component: 'seat', term: 'monthly', included_with_plan: '25' },
      },
      {
        id: 'price_nw_scale_seat_annual', ageDays: 300, model: 'tiered', type: 'recurring', currency: 'usd',
        nickname: 'Scale operator seat — annual (volume)', lookup_key: 'scale_seat_annual',
        tiers_mode: 'volume',
        tiers: [
          { up_to: 25, unit_amount: 24000 },
          { up_to: 100, unit_amount: 19000 },
          { up_to: 'inf', unit_amount: 15000 },
        ],
        recurring: { interval: 'year' },
        currency_options: {
          eur: { tiers: [{ up_to: 25, unit_amount: 22000 }, { up_to: 100, unit_amount: 17500 }, { up_to: 'inf', unit_amount: 14000 }] },
          gbp: { tiers: [{ up_to: 25, unit_amount: 19000 }, { up_to: 100, unit_amount: 15000 }, { up_to: 'inf', unit_amount: 12000 }] },
        },
        tax_behavior: 'exclusive', metadata: { component: 'seat', term: 'annual', included_with_plan: '25' },
      },
    ],
  },
  {
    id: 'prod_nw_enterprise',
    ageDays: 300,
    name: 'Telemetry Cloud Enterprise',
    tagline: 'Air-gapped deployments, committed use, procurement-ready.',
    description:
      'Northwind Cloud deployed in your own VPC or on-premises, with committed-use event pricing, a custom retention schedule, quarterly business reviews and contractual SLAs. Priced per fleet after a technical discovery.',
    statement_descriptor: 'NORTHWIND ENTERPRIS',
    unit_label: 'seat',
    category: 'plan',
    position: 40,
    tax_code: SAAS_TAX_CODE,
    url: 'https://northwind.io/pricing/enterprise',
    images: swatch('#1F2430'),
    metadata: { rung: '4', ideal_for: 'regulated and air-gapped fleets', contact_sales: 'true' },
    features: [
      { name: 'Unlimited operator seats', lookup_key: 'seats' },
      { name: 'Unlimited connected robots', lookup_key: 'robots' },
      { name: 'Committed-use event pricing', lookup_key: 'events_included' },
      { name: 'Retention set to your regulator’s requirement', lookup_key: 'retention' },
      { name: 'Custom models trained on your fleet', lookup_key: 'anomaly' },
      { name: '24×7 with a named engineer and a 15-minute SLA', lookup_key: 'support' },
      { name: 'SSO, SCIM and streaming audit export', lookup_key: 'sso' },
      { name: 'Cross-site benchmarking and OEE reporting', lookup_key: 'benchmarking' },
      { name: 'Air-gapped or in-VPC deployment', lookup_key: 'deployment' },
    ],
    defaultPriceKey: 'enterprise_annual',
    prices: [
      {
        id: 'price_nw_enterprise_annual', ageDays: 300, model: 'custom', type: 'recurring', currency: 'usd',
        nickname: 'Enterprise — annual commitment', lookup_key: 'enterprise_annual',
        custom_unit_amount: { enabled: true, minimum: 6_000_000, maximum: 500_000_000, preset: 12_000_000 },
        recurring: { interval: 'year' },
        currency_options: {
          eur: { custom_unit_amount: { enabled: true, minimum: 5_500_000, maximum: 460_000_000, preset: 11_000_000 } },
          gbp: { custom_unit_amount: { enabled: true, minimum: 4_800_000, maximum: 400_000_000, preset: 9_600_000 } },
        },
        tax_behavior: 'exclusive', proration_behavior: 'none', metadata: { component: 'custom', term: 'annual' },
      },
    ],
  },
  {
    id: 'prod_nw_events',
    ageDays: 420,
    name: 'Telemetry events',
    tagline: 'Metered ingestion, graduated so heavy fleets pay less per event.',
    description:
      'Every measurement, state change and alarm streamed into Northwind Cloud is one telemetry event. Usage is metered per workspace and billed monthly on graduated tiers on top of the events your plan already includes.',
    statement_descriptor: 'NORTHWIND EVENTS',
    unit_label: 'event',
    category: 'component',
    position: 110,
    tax_code: SAAS_TAX_CODE,
    images: swatch('#E08C00'),
    metadata: { meter: 'telemetry_events' },
    features: [
      { name: 'Metered per event, aggregated by sum', lookup_key: 'metering' },
      { name: 'Graduated tiers — the rate drops as volume grows', lookup_key: 'tiering' },
    ],
    defaultPriceKey: 'telemetry_events_monthly',
    prices: [
      {
        id: 'price_nw_telemetry_events', ageDays: 420, model: 'usage', type: 'recurring', currency: 'usd',
        nickname: 'Telemetry events — graduated', lookup_key: 'telemetry_events_monthly',
        tiers_mode: 'graduated',
        tiers: [
          { up_to: 500_000, unit_amount_decimal: '0' },
          { up_to: 5_000_000, unit_amount_decimal: '0.04' },
          { up_to: 25_000_000, unit_amount_decimal: '0.028' },
          { up_to: 'inf', unit_amount_decimal: '0.019' },
        ],
        recurring: { interval: 'month', usage_type: 'metered', aggregate_usage: 'sum', meter: 'telemetry_events' },
        currency_options: {
          eur: {
            tiers: [
              { up_to: 500_000, unit_amount_decimal: '0' },
              { up_to: 5_000_000, unit_amount_decimal: '0.037' },
              { up_to: 25_000_000, unit_amount_decimal: '0.026' },
              { up_to: 'inf', unit_amount_decimal: '0.017' },
            ],
          },
          gbp: {
            tiers: [
              { up_to: 500_000, unit_amount_decimal: '0' },
              { up_to: 5_000_000, unit_amount_decimal: '0.032' },
              { up_to: 25_000_000, unit_amount_decimal: '0.022' },
              { up_to: 'inf', unit_amount_decimal: '0.015' },
            ],
          },
        },
        tax_behavior: 'exclusive', proration_behavior: 'none',
        metadata: { component: 'metered', meter: 'telemetry_events' },
      },
    ],
  },
  {
    id: 'prod_nw_export',
    ageDays: 240,
    name: 'Bulk data export',
    tagline: 'Warehouse-ready extracts, billed in 10 GB packages.',
    description:
      'Scheduled Parquet exports of raw telemetry into your own warehouse or lake. Metered by volume written and billed in 10 GB packages — a part-used package rounds up, so the invoice is always a whole number of blocks.',
    statement_descriptor: 'NORTHWIND EXPORT',
    unit_label: 'GB',
    category: 'component',
    position: 120,
    tax_code: SAAS_TAX_CODE,
    images: swatch('#2A7AE4'),
    metadata: { meter: 'data_export_gb' },
    features: [
      { name: 'Billed per 10 GB package, rounded up', lookup_key: 'packaging' },
      { name: 'Parquet, CSV or JSONL to S3, GCS or Azure', lookup_key: 'destinations' },
    ],
    defaultPriceKey: 'data_export_monthly',
    prices: [
      {
        id: 'price_nw_data_export', ageDays: 240, model: 'package', type: 'recurring', currency: 'usd',
        nickname: 'Bulk export — per 10 GB', lookup_key: 'data_export_monthly', unit_amount: 900,
        transform_quantity: { divide_by: 10, round: 'up' },
        recurring: { interval: 'month', usage_type: 'metered', aggregate_usage: 'sum', meter: 'data_export_gb' },
        currency_options: { eur: { unit_amount: 850 }, gbp: { unit_amount: 750 } },
        tax_behavior: 'exclusive', proration_behavior: 'none',
        metadata: { component: 'metered', meter: 'data_export_gb' },
      },
    ],
  },
  {
    id: 'prod_nw_predictive',
    ageDays: 180,
    name: 'Predictive Maintenance AI',
    tagline: 'Failure forecasts per robot, trained on your own fleet history.',
    description:
      'Adds bearing-wear, spindle-drift and thermal-runaway forecasting to every enrolled robot, with work orders raised automatically when a component crosses its predicted remaining-useful-life threshold.',
    statement_descriptor: 'NORTHWIND AI',
    unit_label: 'robot',
    category: 'add_on',
    position: 210,
    tax_code: SAAS_TAX_CODE,
    images: swatch('#17A862'),
    metadata: { included_in: 'scale,enterprise' },
    features: [
      { name: 'Remaining-useful-life forecast per component', lookup_key: 'rul' },
      { name: 'Automatic work orders on threshold breach', lookup_key: 'work_orders' },
    ],
    defaultPriceKey: 'predictive_monthly',
    prices: [
      {
        id: 'price_nw_predictive_monthly', ageDays: 180, model: 'per_unit', type: 'recurring', currency: 'usd',
        nickname: 'Predictive Maintenance — per robot, monthly', lookup_key: 'predictive_monthly', unit_amount: 1200,
        recurring: { interval: 'month' },
        currency_options: { eur: { unit_amount: 1100 }, gbp: { unit_amount: 950 } },
        tax_behavior: 'exclusive', metadata: { component: 'addon', term: 'monthly' },
      },
      {
        id: 'price_nw_predictive_annual', ageDays: 180, model: 'per_unit', type: 'recurring', currency: 'usd',
        nickname: 'Predictive Maintenance — per robot, annual', lookup_key: 'predictive_annual', unit_amount: 12000,
        recurring: { interval: 'year' },
        currency_options: { eur: { unit_amount: 11000 }, gbp: { unit_amount: 9500 } },
        tax_behavior: 'exclusive', metadata: { component: 'addon', term: 'annual' },
      },
    ],
  },
  {
    id: 'prod_nw_onboarding',
    ageDays: 420,
    name: 'Onboarding & commissioning',
    tagline: 'A Northwind engineer on site until the first line is streaming.',
    description:
      'Two days on site: gateway installation, PLC tag mapping, baseline capture and operator training, finishing with a signed commissioning report. Charged once per site, invoiced when the engagement is booked.',
    statement_descriptor: 'NORTHWIND ONBOARD',
    unit_label: 'site',
    category: 'service',
    position: 410,
    tax_code: SERVICE_TAX_CODE,
    images: swatch('#8A6BF2'),
    metadata: { delivery: 'on_site', duration_days: '2' },
    features: [
      { name: 'Gateway install and PLC tag mapping', lookup_key: 'install' },
      { name: 'Baseline capture and operator training', lookup_key: 'training' },
    ],
    defaultPriceKey: 'onboarding_fee',
    prices: [
      {
        id: 'price_nw_onboarding', ageDays: 420, model: 'flat', type: 'one_time', currency: 'usd',
        nickname: 'Onboarding & commissioning — per site', lookup_key: 'onboarding_fee', unit_amount: 250000,
        currency_options: { eur: { unit_amount: 230000 }, gbp: { unit_amount: 199000 } },
        tax_behavior: 'exclusive', metadata: { component: 'onboarding' },
      },
    ],
  },
  {
    id: 'prod_nw_credits',
    ageDays: 150,
    name: 'Telemetry credit pack',
    tagline: 'Prepay for burst months; volume-priced, never expires mid-term.',
    description:
      'Each pack covers one million telemetry events and is drawn down before metered overage is charged. Packs are volume-priced, so buying the year up front lands at a lower rate than paying month to month.',
    statement_descriptor: 'NORTHWIND CREDITS',
    unit_label: 'pack',
    category: 'credit_pack',
    position: 310,
    tax_code: SAAS_TAX_CODE,
    images: swatch('#E0654B'),
    metadata: { events_per_pack: '1000000', drawdown_order: 'before_overage' },
    features: [
      { name: '1,000,000 telemetry events per pack', lookup_key: 'pack_size' },
      { name: 'Drawn down before metered overage', lookup_key: 'drawdown' },
      { name: 'Volume-priced from 5 packs', lookup_key: 'volume' },
    ],
    defaultPriceKey: 'credit_pack',
    prices: [
      {
        id: 'price_nw_credit_pack', ageDays: 150, model: 'tiered', type: 'one_time', currency: 'usd',
        nickname: 'Telemetry credit pack (volume)', lookup_key: 'credit_pack',
        tiers_mode: 'volume',
        tiers: [
          { up_to: 4, unit_amount: 50000 },
          { up_to: 9, unit_amount: 46000 },
          { up_to: 'inf', unit_amount: 42000 },
        ],
        currency_options: {
          eur: { tiers: [{ up_to: 4, unit_amount: 46000 }, { up_to: 9, unit_amount: 42000 }, { up_to: 'inf', unit_amount: 38000 }] },
          gbp: { tiers: [{ up_to: 4, unit_amount: 39000 }, { up_to: 9, unit_amount: 36000 }, { up_to: 'inf', unit_amount: 33000 }] },
        },
        tax_behavior: 'exclusive', metadata: { component: 'credits', events_per_pack: '1000000' },
      },
    ],
  },
];

export function seedCatalog(ctx: Ctx, orgId: string): void {
  const catalog = new Catalog(ctx);
  const now = ctx.now();

  for (const entry of NORTHWIND_CATALOG) {
    const { prices, ageDays, defaultPriceKey, ...product } = entry;
    catalog.createProduct(orgId, product, { actorType: 'system' });
    const productCreated = now - ageDays * DAY;
    ctx.db.patch('catalog_products', 'id', product.id, { created: productCreated, updated: productCreated });

    for (const price of prices) {
      const { ageDays: priceAge, ...input } = price;
      catalog.createPrice(orgId, { ...input, product: product.id }, { actorType: 'system' });
      const created = now - (priceAge ?? ageDays) * DAY;
      ctx.db.patch('catalog_prices', 'id', price.id, { created, updated: created });
    }

    if (defaultPriceKey) {
      const def = catalog.priceByLookupKey(orgId, defaultPriceKey);
      if (def) catalog.setDefaultPrice(orgId, product.id, def.id);
    }
    ctx.db.patch('catalog_products', 'id', product.id, { updated: productCreated });
  }
}
