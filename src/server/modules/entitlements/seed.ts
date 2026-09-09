import type { Ctx } from '../../kernel/context';
import { DAY } from '../../../shared/time';
import { resolveMeteredCustomers } from '../metering/seed';
import { entitlementsStore } from './store';
import type { FeatureInput } from './types';

/**
 * What Northwind Robotics actually sells, expressed as things a customer can
 * do rather than as lines on an invoice.
 *
 * Every key here is the `lookup_key` the catalog already publishes on the
 * product's feature list, so the pricing page, the invoice and the product's
 * own `check()` call all name the same thing. The numbers are the ones in the
 * plan copy — 75 robots on Growth, 400 on Scale — and nothing else is invented.
 */
const NORTHWIND_FEATURES: FeatureInput[] = [
  {
    key: 'seats',
    name: 'Operator seats',
    description: 'Named operators who can open the console, watch a line and acknowledge alerts. Counted on who actually worked during the period, not on who was provisioned.',
    type: 'limit',
    unit_label: 'seat',
    meter: 'operator_session',
    usage_window: 'billing_period',
    approaching_threshold_percent: 85,
    position: 10,
  },
  {
    key: 'robots',
    name: 'Connected robots',
    description: 'Cells, arms and AGVs streaming into Northwind Cloud at once. Measured as the high-water mark for the period, so a fleet that peaks above its ceiling is caught the day it happens.',
    type: 'limit',
    unit_label: 'robot',
    meter: 'connected_robots',
    usage_window: 'billing_period',
    approaching_threshold_percent: 80,
    position: 20,
  },
  {
    key: 'events_included',
    name: 'Telemetry events included',
    description: 'Measurements, state changes and alarms included each billing period before metered overage is charged. Prepaid credit packs are drawn down first and raise this allowance.',
    type: 'metered',
    unit_label: 'event',
    meter: 'telemetry_events',
    usage_window: 'billing_period',
    credit_backed: true,
    approaching_threshold_percent: 80,
    position: 30,
  },
  {
    key: 'retention',
    name: 'Event retention',
    description: 'How far back the raw event stream stays queryable and exportable.',
    type: 'limit',
    unit_label: 'day',
    usage_window: 'billing_period',
    position: 40,
  },
  {
    key: 'data_export',
    name: 'Bulk data export',
    description: 'Scheduled Parquet, CSV or JSONL extracts written into the customer’s own warehouse. Metered by volume and billed in 10 GB packages.',
    type: 'metered',
    unit_label: 'GB',
    meter: 'data_export_gb',
    usage_window: 'billing_period',
    approaching_threshold_percent: 90,
    position: 50,
  },
  {
    key: 'anomaly',
    name: 'Custom anomaly rules and alert routing',
    description: 'Author your own detection rules and route the alerts they raise to the right shift, rather than running the standard rule set.',
    type: 'boolean',
    position: 60,
  },
  {
    key: 'sso',
    name: 'SAML single sign-on',
    description: 'Sign in through the customer’s own identity provider, with SCIM provisioning on the plans that include it.',
    type: 'boolean',
    position: 70,
  },
  {
    key: 'benchmarking',
    name: 'Cross-site benchmarking and OEE reporting',
    description: 'Compare line and cell performance across every plant in the fleet, with overall equipment effectiveness reported on one axis.',
    type: 'boolean',
    position: 80,
  },
  {
    key: 'predictive',
    name: 'Predictive maintenance forecasting',
    description: 'Bearing-wear, spindle-drift and thermal-runaway forecasts per robot, raising a work order when a component crosses its remaining-useful-life threshold.',
    type: 'boolean',
    position: 90,
  },
  {
    key: 'deployment',
    name: 'Air-gapped or in-VPC deployment',
    description: 'Northwind Cloud running inside the customer’s own network boundary, for fleets that cannot stream to a shared tenancy.',
    type: 'boolean',
    position: 100,
  },
];

/** What each product includes, in the plan copy's own numbers. */
interface Grant {
  product: string;
  feature: string;
  value?: number;
  unlimited?: boolean;
  quantity_prices?: string[];
}

const NORTHWIND_GRANTS: Grant[] = [
  { product: 'prod_nw_starter', feature: 'seats', value: 3 },
  { product: 'prod_nw_starter', feature: 'robots', value: 10 },
  { product: 'prod_nw_starter', feature: 'events_included', value: 500_000 },
  { product: 'prod_nw_starter', feature: 'retention', value: 30 },

  { product: 'prod_nw_growth', feature: 'seats', value: 10, quantity_prices: ['price_nw_growth_seat_monthly', 'price_nw_growth_seat_annual'] },
  { product: 'prod_nw_growth', feature: 'robots', value: 75 },
  { product: 'prod_nw_growth', feature: 'events_included', value: 5_000_000 },
  { product: 'prod_nw_growth', feature: 'retention', value: 365 },
  { product: 'prod_nw_growth', feature: 'anomaly' },
  { product: 'prod_nw_growth', feature: 'sso' },

  { product: 'prod_nw_scale', feature: 'seats', value: 25, quantity_prices: ['price_nw_scale_seat_monthly', 'price_nw_scale_seat_annual'] },
  { product: 'prod_nw_scale', feature: 'robots', value: 400 },
  { product: 'prod_nw_scale', feature: 'events_included', value: 25_000_000 },
  { product: 'prod_nw_scale', feature: 'retention', value: 1095 },
  { product: 'prod_nw_scale', feature: 'anomaly' },
  { product: 'prod_nw_scale', feature: 'sso' },
  { product: 'prod_nw_scale', feature: 'benchmarking' },
  { product: 'prod_nw_scale', feature: 'predictive' },

  { product: 'prod_nw_enterprise', feature: 'seats', unlimited: true },
  { product: 'prod_nw_enterprise', feature: 'robots', unlimited: true },
  { product: 'prod_nw_enterprise', feature: 'events_included', unlimited: true },
  { product: 'prod_nw_enterprise', feature: 'retention', unlimited: true },
  { product: 'prod_nw_enterprise', feature: 'anomaly' },
  { product: 'prod_nw_enterprise', feature: 'sso' },
  { product: 'prod_nw_enterprise', feature: 'benchmarking' },
  { product: 'prod_nw_enterprise', feature: 'predictive' },
  { product: 'prod_nw_enterprise', feature: 'deployment' },

  // The metered components sold alongside a plan grant the thing they meter.
  { product: 'prod_nw_export', feature: 'data_export', unlimited: true },
  { product: 'prod_nw_predictive', feature: 'predictive' },
];

export function seedEntitlements(ctx: Ctx, orgId: string): void {
  const entitlements = entitlementsStore(ctx);
  const now = ctx.now();

  for (const feature of NORTHWIND_FEATURES) {
    // A feature whose meter is not in this workspace is simply not offered
    // here; the seed never invents a meter to hang a number on.
    if (feature.meter && !ctx.svc.metering.meter(orgId, feature.meter)) continue;
    entitlements.createFeature(orgId, feature, { actorType: 'system' });
  }

  for (const grant of NORTHWIND_GRANTS) {
    if (!entitlements.feature(orgId, grant.feature)) continue;
    if (!ctx.svc.catalog.product(orgId, grant.product)) continue;
    const quantityPrices = (grant.quantity_prices ?? []).filter((id) => ctx.svc.catalog.price(orgId, id));
    entitlements.setProductFeature(orgId, {
      product: grant.product,
      feature: grant.feature,
      value: grant.value ?? null,
      unlimited: grant.unlimited ?? false,
      quantity_prices: quantityPrices,
    }, { actorType: 'system' });
  }

  /* ------------------------ derive everybody's set once --------------------- */

  // Billing seeded its subscriptions before this module existed, so the events
  // that would normally derive an entitlement set fired against an empty
  // feature list. Deriving every account here is what makes the demo workspace
  // consistent on a cold boot; from this point on the event handlers keep it so.
  const subscribed = ctx.db.all<{ customer_id: string }>(
    `SELECT DISTINCT customer_id FROM billing_subscriptions WHERE org_id = ? AND status IN ('trialing','active','past_due','unpaid','paused')`,
    orgId,
  );
  for (const row of subscribed) {
    entitlements.recompute(orgId, row.customer_id, {
      trigger: 'seed',
      reason: 'Entitlements derived from the account\u2019s live subscriptions.',
      meta: { actorType: 'system' },
    });
  }

  /* --------------------------- the support stories -------------------------- */

  /**
   * A raise support actually handed out, sized against what the account is on
   * today. Reading the derived value first is the difference between a demo
   * override that binds and one that quietly sits under the plan's own ceiling
   * — and the sentence has to name the same number the raise is worth.
   */
  const raise = (customerId: string, feature: string, extra: number, sentence: (extra: number, to: number) => string) => {
    const current = entitlements
      .active(orgId, customerId, { usage: false })
      .find((entry) => entry.feature === feature);
    if (!current || current.unlimited || current.value === null) return;
    const to = current.value + extra;
    entitlements.createOverride(orgId, {
      customer: customerId,
      feature,
      effect: 'grant',
      value: to,
      reason: sentence(extra, to),
      expires_at: now + (feature === 'seats' ? 14 : 21) * DAY,
    }, { actorType: 'system' });
  };

  const roster = resolveMeteredCustomers(ctx, orgId);
  const byCompany = new Map(roster.map((c) => [c.company, c]));

  // Kestrel is trialling a night shift on the same plan: a fortnight of extra
  // seats, agreed by support, that take themselves away again.
  const kestrel = byCompany.get('Kestrel Aerospace Components');
  if (kestrel?.billable && entitlements.feature(orgId, 'seats')) {
    raise(kestrel.id, 'seats', 16, (extra, to) =>
      `Night-shift trial at Bristol \u2014 ${extra} extra seats agreed with Priya, taking them to ${to} until the trial ends.`);
  }

  // Ironwood's commissioning week runs the new line alongside the old one; the
  // ceiling is raised rather than the plan changed, so the bill does not move.
  const ironwood = byCompany.get('Ironwood Packaging Group');
  if (ironwood?.billable && entitlements.feature(orgId, 'robots')) {
    raise(ironwood.id, 'robots', 65, (extra, to) =>
      `Second line commissioning at Leeds \u2014 ceiling raised by ${extra} robots to ${to} for the cutover, reverting when the old line is retired.`);
  }
}
