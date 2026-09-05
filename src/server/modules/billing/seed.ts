/**
 * Northwind Robotics' book of business.
 *
 * Every account here is one of the CRM companies, linked by `crm_record_id`, on
 * a plan its size and controls estate would actually justify. Subscriptions are
 * backdated across eighteen months and then walked forward period by period
 * through the real ledger, so revenue reporting has genuine movement to chart:
 * ramps, seat expansions, two mid-cycle upgrades priced by the same proration
 * function the API uses, two accounts in arrears, one paused, a live trial and
 * a handful of churns.
 *
 * Nothing here writes a number by hand. Every amount comes out of the pricing
 * engine, which is why the seed doubles as a test of it.
 */
import type { Ctx } from '../../kernel/context';
import { DAY, addInterval, startOfDay } from '../../../shared/time';
import type { CrmRecord } from '../crm/types';
import { intervalOf, periodAt, type Pricebook } from './cycle';
import { prorate } from './proration';
import { Billing } from './store';
import type { SubscriptionCreateInput } from './records';
import { Schedules } from './schedules';
import { TaxRates, type TaxRateInput } from './tax';
import type { CancellationReason, Subscription } from './types';

const MONTH = 30 * DAY;

/** Deterministic jitter — the same book of business on every reseed. */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

type Rung = 'starter' | 'growth' | 'scale' | 'enterprise';

const rungOf = (assets: number): Rung =>
  assets >= 800 ? 'enterprise' : assets >= 300 ? 'scale' : assets >= 120 ? 'growth' : 'starter';

/** Northwind sells in three currencies; which one follows the billing entity. */
function currencyFor(country: string, region: string): string {
  if (country === 'United Kingdom') return 'gbp';
  if (region === 'emea') return 'eur';
  return 'usd';
}

/**
 * A registration number in the shape the country's register actually issues.
 *
 * Every member state writes its VAT number differently — nine digits in
 * Germany, nine digits and a `B` block in the Netherlands, twelve in Sweden —
 * and the tax engine refuses anything that is not the right shape, so a seed
 * that invented `EU443216789` would be a seed that could not be saved.
 */
function taxIdFor(country: string, slug: string): { type: string; value: string; country: string } | null {
  const digits = slugDigits(slug);
  const eu = (value: string) => ({ type: 'eu_vat', value, country });
  switch (country) {
    case 'United Kingdom': return { type: 'gb_vat', value: `GB${digits.slice(0, 9)}`, country };
    case 'Germany': return eu(`DE${digits.slice(0, 9)}`);
    case 'France': return eu(`FR${digits.slice(0, 2)}${digits.slice(0, 9)}`);
    case 'Netherlands': return eu(`NL${digits.slice(0, 9)}B${digits.slice(0, 2)}`);
    case 'Italy': return eu(`IT${digits.slice(0, 10)}${digits.slice(0, 1)}`);
    case 'Spain': return eu(`ES${digits.slice(0, 9)}`);
    case 'Ireland': return eu(`IE${digits.slice(0, 7)}A`);
    case 'Sweden': return eu(`SE${digits.slice(0, 10)}01`);
    case 'Denmark': return eu(`DK${digits.slice(0, 8)}`);
    case 'Poland': return eu(`PL${digits.slice(0, 10)}`);
    case 'Switzerland': return { type: 'ch_vat', value: `CHE${digits.slice(0, 9)}MWST`, country };
    case 'Türkiye': return { type: 'tr_tin', value: digits.slice(0, 10), country };
    case 'United States': return { type: 'us_ein', value: `${digits.slice(0, 2)}-${digits.slice(2, 9)}`, country };
    default: return null;
  }
}

/** A stable nine-digit-ish string from a slug, so tax ids survive a reseed. */
function slugDigits(slug: string): string {
  let hash = 0;
  for (const ch of slug) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return String(hash).padStart(10, '4').slice(0, 10);
}

const str = (record: CrmRecord, key: string): string => {
  const value = record.properties[key];
  return value === null || value === undefined ? '' : String(value);
};
const num = (record: CrmRecord, key: string): number => {
  const value = Number(record.properties[key]);
  return Number.isFinite(value) ? value : 0;
};

/* ------------------------------- the seed run ----------------------------- */

/** What a rung of the ladder is made of, in catalog lookup keys. */
interface Plan {
  base: string;
  seat?: string;
  metered: string[];
}

/**
 * Where Northwind is registered to collect tax.
 *
 * A US company selling software: sales tax in the eight states it has nexus in,
 * and VAT registrations across the EU and the UK where every B2B supply against
 * a valid registration number is reverse charged — the customer accounts for
 * the tax and the invoice says so. Everywhere else there is simply no rate,
 * which is the correct answer and the one the invoice prints.
 */
const TAX_REGISTRATIONS: TaxRateInput[] = [
  { display_name: 'OH sales tax', jurisdiction: 'Ohio', country: 'US', state: 'Ohio', tax_type: 'sales_tax', percentage: '5.75', description: 'State rate for the home jurisdiction in Cleveland.' },
  { display_name: 'TX sales tax', jurisdiction: 'Texas', country: 'US', state: 'Texas', tax_type: 'sales_tax', percentage: '6.25' },
  { display_name: 'NY sales tax', jurisdiction: 'New York', country: 'US', state: 'New York', tax_type: 'sales_tax', percentage: '4' },
  { display_name: 'WA sales tax', jurisdiction: 'Washington', country: 'US', state: 'Washington', tax_type: 'sales_tax', percentage: '6.5' },
  { display_name: 'MI sales tax', jurisdiction: 'Michigan', country: 'US', state: 'Michigan', tax_type: 'sales_tax', percentage: '6' },
  { display_name: 'TN sales tax', jurisdiction: 'Tennessee', country: 'US', state: 'Tennessee', tax_type: 'sales_tax', percentage: '7' },
  { display_name: 'PA sales tax', jurisdiction: 'Pennsylvania', country: 'US', state: 'Pennsylvania', tax_type: 'sales_tax', percentage: '6' },
  { display_name: 'MN sales tax', jurisdiction: 'Minnesota', country: 'US', state: 'Minnesota', tax_type: 'sales_tax', percentage: '6.875' },
  { display_name: 'VAT', jurisdiction: 'Germany', country: 'DE', tax_type: 'vat', percentage: '19', reverse_charge: true },
  { display_name: 'TVA', jurisdiction: 'France', country: 'FR', tax_type: 'vat', percentage: '20', reverse_charge: true },
  { display_name: 'BTW', jurisdiction: 'Netherlands', country: 'NL', tax_type: 'vat', percentage: '21', reverse_charge: true },
  { display_name: 'VAT', jurisdiction: 'Ireland', country: 'IE', tax_type: 'vat', percentage: '23', reverse_charge: true },
  { display_name: 'IVA', jurisdiction: 'Italy', country: 'IT', tax_type: 'vat', percentage: '22', reverse_charge: true },
  { display_name: 'IVA', jurisdiction: 'Spain', country: 'ES', tax_type: 'vat', percentage: '21', reverse_charge: true },
  { display_name: 'Moms', jurisdiction: 'Sweden', country: 'SE', tax_type: 'vat', percentage: '25', reverse_charge: true },
  { display_name: 'Moms', jurisdiction: 'Denmark', country: 'DK', tax_type: 'vat', percentage: '25', reverse_charge: true },
  { display_name: 'VAT', jurisdiction: 'United Kingdom', country: 'GB', tax_type: 'vat', percentage: '20', reverse_charge: true },
];

export function seedBilling(ctx: Ctx, orgId: string): void {
  const billing = new Billing(ctx);
  const schedules = new Schedules(ctx, billing);
  const book = billing.book(orgId);
  const now = ctx.now();
  const random = rng(0x8f21_44b3);

  // Registered long before the oldest backdated invoice, so every bill in the
  // book was raised against a rate that already existed.
  const rates = new TaxRates(ctx, orgId);
  for (const registration of TAX_REGISTRATIONS) rates.create(registration, now - 460 * DAY);

  // Who the bill comes from. Kept as a workspace setting rather than a constant
  // so the rendered invoice reads from the same place a settings screen writes.
  ctx.svc.core.setSetting(orgId, 'billing.issuer', {
    legal_name: 'Northwind Robotics, Inc.',
    line1: '1200 Superior Avenue East',
    line2: 'Suite 1400',
    city: 'Cleveland',
    state: 'Ohio',
    postal_code: '44114',
    country: 'United States',
    tax_id: 'EIN 34-2118840',
    email: 'ar@northwind.io',
    phone: '+1 216 555 0142',
    remittance:
      'Payable by ACH, wire or card in the currency shown. Bank details are on your account under Billing \u2192 Payment methods. Quote the invoice number on the remittance advice, and send queries to ar@northwind.io.',
  });

  // Northwind has not turned the tax-location hold on. Its own book is fully
  // addressed — every account here came from a CRM company with a country on
  // it — so the hold would never fire on this data; what it would catch is the
  // accounts someone creates by hand while trying the product out, and refusing
  // to bill those is not how a workspace should introduce itself. Nothing is
  // hidden by leaving it off: every bill still carries `automatic_tax.status`,
  // the overview still counts what could not be placed, and
  // GET /v1/invoices?tax=missing still finds it. Turning it on is what a
  // finance team does the day it starts selling somewhere it must not guess at.
  ctx.svc.core.setSetting(orgId, 'billing.automatic_tax', { enabled: false });

  const priceOf = (lookupKey: string): string => {
    const price = ctx.svc.catalog.priceByLookupKey(orgId, lookupKey);
    if (!price) throw new Error(`Billing seed expects catalog price "${lookupKey}"`);
    return price.id;
  };

  const companies = ctx.svc.crm
    .search(orgId, 'company', { limit: 100 }).records
    .filter((record) => str(record, 'lifecycle_stage') === 'customer')
    .sort((a, b) => a.id.localeCompare(b.id));

  if (!companies.length) return;

  // The account with a resale certificate on file. Deliberately one that trades
  // where Northwind *is* registered, so its lines name the rate that would have
  // applied and charge nothing — the case a finance team has to point at when
  // an auditor asks why a US invoice carries no sales tax.
  const registeredStates = new Set(
    TAX_REGISTRATIONS.filter((r) => r.country === 'US' && r.state).map((r) => r.state as string),
  );
  const exemptCompany = companies.find(
    (company) => str(company, 'country') === 'United States' && registeredStates.has(str(company, 'state')),
  )?.id ?? null;

  const customers = companies.map((company, index) => {
    const slug = str(company, 'domain').split('.')[0];
    const country = str(company, 'country');
    const region = str(company, 'region');
    const currency = currencyFor(country, region);
    const assets = num(company, 'connected_assets');
    const rung = rungOf(assets);
    const enterprise = rung === 'enterprise';
    const taxId = taxIdFor(country, slug);
    const createdAt = startOfDay(company.created + 7 * DAY);

    const customer = billing.createCustomer(orgId, {
      name: company.display_name,
      email: `ap@${str(company, 'domain')}`,
      description: `Billing account for ${company.display_name} — ${num(company, 'plant_count')} plants, ${assets} connected assets.`,
      phone: str(company, 'phone') || null,
      currency,
      crm_record_id: company.id,
      address: {
        line1: str(company, 'street'), city: str(company, 'city'), state: str(company, 'state'),
        postal_code: str(company, 'postal_code'), country,
      },
      tax_ids: taxId ? [taxId] : [],
      invoice_settings: {
        default_payment_method: enterprise ? null : `pm_card_${slug.slice(0, 10)}`,
        days_until_due: enterprise ? 45 : 30,
        custom_fields: enterprise ? [{ name: 'Purchase order', value: `PO-${slugDigits(slug).slice(0, 6)}` }] : [],
        footer: enterprise
          ? 'Payable by bank transfer under master services agreement NW-MSA-2024. Remittance advice to ar@northwind.io.'
          : null,
      },
      preferred_locales: currency === 'eur' ? ['de-DE', 'en-GB'] : currency === 'gbp' ? ['en-GB'] : ['en-US'],
      tax_exempt: company.id === exemptCompany ? 'exempt' : 'none',
      metadata: { crm_company: company.id, region, rung, plants: String(num(company, 'plant_count')) },
    }, { actorType: 'system' });

    // Northwind's AP team checked every registration against its own register
    // when the account was opened — which is the only thing that lets a B2B
    // supply into the EU be reverse charged, and the reason the seeded German
    // and Irish bills carry 0% with a sentence saying why.
    if (taxId) {
      billing.verifyTaxId(orgId, customer.id, {
        value: taxId.value,
        status: 'verified',
        verified_name: company.display_name,
        verified_address: `${str(company, 'street')}, ${str(company, 'city')}, ${country}`,
      }, { actorType: 'system' });
    }

    ctx.db.patch('billing_customers', 'id', customer.id, { created: createdAt, updated: createdAt });
    retimeEvents(ctx, orgId, customer.id, now, createdAt);
    return { customer: billing.requireCustomer(orgId, customer.id), company, rung, currency, assets, index, slug };
  });

  /* ------------------------------ the plan mix ---------------------------- */

  const byRung = (rung: Rung): Plan => {
    switch (rung) {
      case 'starter': return { base: 'starter_monthly', metered: ['telemetry_events_monthly'] };
      case 'growth': return { base: 'growth_monthly', seat: 'growth_seat_monthly', metered: ['telemetry_events_monthly'] };
      case 'scale': return { base: 'scale_monthly', seat: 'scale_seat_monthly', metered: ['telemetry_events_monthly', 'data_export_monthly'] };
      case 'enterprise': return { base: 'enterprise_annual', metered: [] };
    }
  };

  // Two accounts in arrears, one paused, one live trial, two on annual terms.
  const arrears = new Set([customers[3]?.customer.id, customers[16]?.customer.id].filter(Boolean) as string[]);
  const paused = new Set([customers[12]?.customer.id].filter(Boolean) as string[]);
  const trialing = new Set([customers[customers.length - 1]?.customer.id].filter(Boolean) as string[]);
  const annualSwitchers = new Set([customers[9]?.customer.id, customers[19]?.customer.id].filter(Boolean) as string[]);
  const sendInvoice = new Set(customers.filter((c) => c.rung === 'enterprise' || c.rung === 'scale').map((c) => c.customer.id));

  const created: { sub: Subscription; entry: (typeof customers)[number] }[] = [];

  // Every subscription's shape is settled before any of them is written, so the
  // two mid-cycle upgrades below can be chosen now and then *lived through* —
  // billed at the old price up to the day they happened and at the new price
  // afterwards — rather than backdated onto a book that was already drawn.
  const plans = customers.map((entry) => {
    const isTrial = trialing.has(entry.customer.id);
    const ageMonths = isTrial ? 0 : 2 + Math.floor(random() * 16);
    const startDate = isTrial
      ? startOfDay(now - 9 * DAY)
      : startOfDay(now - ageMonths * MONTH - Math.floor(random() * 26) * DAY);
    return {
      entry,
      isTrial,
      startDate,
      annualTerm: annualSwitchers.has(entry.customer.id),
      seats: entry.rung === 'growth'
        ? 10 + Math.round(entry.assets / 24)
        : entry.rung === 'scale' ? 25 + Math.round(entry.assets / 18) : 0,
    };
  });

  // The two oldest Growth accounts with seats on them: one moves up to Scale
  // after its second plant goes live, the other simply buys more seats.
  const upgradable = plans
    .filter((plan) => plan.entry.rung === 'growth' && !plan.isTrial && !plan.annualTerm
      && plan.seats > 0 && plan.startDate < now - 6 * MONTH)
    .sort((a, b) => a.startDate - b.startDate);
  const promoted = upgradable[0];
  const expanded = upgradable[1];

  plans.forEach(({ entry, isTrial, annualTerm, startDate, seats }) => {
    const plan = byRung(entry.rung);

    const items: SubscriptionCreateInput['items'] = [];
    if (entry.rung === 'enterprise') {
      // A negotiated annual commitment: the agreed figure scales with the fleet.
      items.push({ price: priceOf('enterprise_annual'), quantity: 1, custom_unit_amount: 6_000_000 + entry.assets * 8_000 });
    } else if (annualTerm) {
      items.push({ price: priceOf(`${entry.rung}_annual`), quantity: 1 });
      if (plan.seat && seats > 0) items.push({ price: priceOf(`${entry.rung}_seat_annual`), quantity: seats });
    } else {
      items.push({ price: priceOf(plan.base), quantity: 1 });
      if (plan.seat && seats > 0) items.push({ price: priceOf(plan.seat), quantity: seats });
      for (const metered of plan.metered) items.push({ price: priceOf(metered), quantity: 1 });
    }

    const collection = sendInvoice.has(entry.customer.id) ? 'send_invoice' as const : 'charge_automatically' as const;
    const mark = ctx.now();
    const sub = billing.createSubscription(orgId, {
      customer: entry.customer.id,
      items,
      backdate_start_date: startDate,
      billing_cycle_anchor: startDate,
      ...(isTrial ? { trial_period_days: 14 } : {}),
      collection_method: collection,
      days_until_due: collection === 'send_invoice' ? (entry.rung === 'enterprise' ? 45 : 30) : null,
      default_payment_method: collection === 'charge_automatically' ? `pm_card_${entry.slug.slice(0, 10)}` : null,
      description: `${entry.company.display_name} — Telemetry Cloud ${entry.rung[0].toUpperCase()}${entry.rung.slice(1)}${annualTerm ? ', annual term' : ''}`,
      metadata: { rung: entry.rung, crm_company: entry.company.id, region: str(entry.company, 'region') },
    }, { actorType: 'system' });
    retimeEvents(ctx, orgId, sub.id, mark, startDate);

    if (!isTrial) {
      // An upgrade in the middle of this account's history is walked through,
      // not stamped on afterwards: bill at the old price up to the day it
      // happened, prorate that day, then bill at the new price from there.
      const upgrade = entry === promoted?.entry
        ? {
            at: startOfDay(startDate + 4 * MONTH + 11 * DAY),
            changes: [
              { index: 0, price: priceOf('scale_monthly') },
              { index: 1, price: priceOf('scale_seat_monthly') },
            ],
            note: 'Moved up to Scale after the second plant went live.',
          }
        : entry === expanded?.entry
          ? {
              at: startOfDay(startDate + 3 * MONTH + 19 * DAY),
              changes: [{ index: 1, quantity: seats + 9 }],
              note: 'Nine more operator seats when the night shift came onto the platform.',
            }
          : null;
      if (upgrade && upgrade.at < now) {
        fastForward(ctx, billing, orgId, sub.id, upgrade.at);
        historicalChange(ctx, billing, orgId, book, sub.id, upgrade.at, upgrade.changes, upgrade.note);
      }
      fastForward(ctx, billing, orgId, sub.id, now);
    }
    created.push({ sub: billing.requireSubscription(orgId, sub.id), entry });
  });

  /* ------------------------------- add-on book ---------------------------- */

  const addOnCandidates = created.filter((row) => row.entry.rung === 'scale' || row.entry.rung === 'growth');
  addOnCandidates.slice(0, 9).forEach((row, i) => {
    const robots = 6 + Math.round(row.entry.assets / 40);
    const startDate = startOfDay(now - (2 + i) * MONTH - Math.floor(random() * 20) * DAY);
    if (startDate <= row.sub.start_date) return;
    const mark = ctx.now();
    const sub = billing.createSubscription(orgId, {
      customer: row.entry.customer.id,
      items: [{ price: priceOf('predictive_monthly'), quantity: robots }],
      backdate_start_date: startDate,
      billing_cycle_anchor: startDate,
      collection_method: 'charge_automatically',
      default_payment_method: `pm_card_${row.entry.slug.slice(0, 10)}`,
      description: `${row.entry.company.display_name} — Predictive Maintenance AI on ${robots} robots`,
      metadata: { component: 'add_on', crm_company: row.entry.company.id },
    }, { actorType: 'system' });
    retimeEvents(ctx, orgId, sub.id, mark, startDate);
    fastForward(ctx, billing, orgId, sub.id, now);
  });

  /* ------------------------ second sites, and churn ----------------------- */

  created.filter((row) => row.entry.rung === 'scale').slice(0, 2).forEach((row, i) => {
    const startDate = startOfDay(now - (5 + i * 2) * MONTH);
    const mark = ctx.now();
    const sub = billing.createSubscription(orgId, {
      customer: row.entry.customer.id,
      items: [{ price: priceOf('starter_monthly'), quantity: 1 }, { price: priceOf('telemetry_events_monthly'), quantity: 1 }],
      backdate_start_date: startDate,
      billing_cycle_anchor: startDate,
      collection_method: 'charge_automatically',
      default_payment_method: `pm_card_${row.entry.slug.slice(0, 10)}`,
      description: `${row.entry.company.display_name} — Starter for the ${i === 0 ? 'pilot line at the new site' : 'aftermarket parts cell'}`,
      metadata: { component: 'second_site', crm_company: row.entry.company.id },
    }, { actorType: 'system' });
    retimeEvents(ctx, orgId, sub.id, mark, startDate);
    fastForward(ctx, billing, orgId, sub.id, now);
  });

  const churnPlan: { row: (typeof created)[number] | undefined; reason: CancellationReason; comment: string; months: number; endedMonths: number }[] = [
    { row: created[5], reason: 'too_expensive', comment: 'Predictive pilot did not clear the capex bar for FY26.', months: 15, endedMonths: 6 },
    { row: created[11], reason: 'missing_features', comment: 'Wanted MES write-back before renewing the add-on.', months: 13, endedMonths: 4 },
    { row: created[18], reason: 'lost_to_competitor', comment: 'Second site went to an incumbent SCADA vendor.', months: 12, endedMonths: 3 },
  ];
  for (const plan of churnPlan) {
    if (!plan.row) continue;
    const entry = plan.row.entry;
    const startDate = startOfDay(now - plan.months * MONTH);
    const endedAt = startOfDay(now - plan.endedMonths * MONTH);
    const mark = ctx.now();
    const sub = billing.createSubscription(orgId, {
      customer: entry.customer.id,
      items: [{ price: priceOf('predictive_monthly'), quantity: 4 + Math.round(entry.assets / 90) }],
      backdate_start_date: startDate,
      billing_cycle_anchor: startDate,
      collection_method: 'charge_automatically',
      default_payment_method: `pm_card_${entry.slug.slice(0, 10)}`,
      description: `${entry.company.display_name} — Predictive Maintenance AI pilot`,
      metadata: { component: 'add_on', crm_company: entry.company.id },
    }, { actorType: 'system' });
    retimeEvents(ctx, orgId, sub.id, mark, startDate);
    fastForward(ctx, billing, orgId, sub.id, endedAt);
    const cancelMark = ctx.now();
    billing.endNow(orgId, billing.requireSubscription(orgId, sub.id), {
      at: endedAt, reason: plan.reason, comment: plan.comment, meta: { actorType: 'system' },
    });
    ctx.db.patch('billing_subscriptions', 'id', sub.id, { canceled_at: endedAt, updated: endedAt });
    retimeEvents(ctx, orgId, sub.id, cancelMark, endedAt);
  }

  // Two accounts moved onto annual terms; the monthly subscription they left is
  // still on the books, which is what makes a churn-versus-expansion report honest.
  for (const customerId of annualSwitchers) {
    const entry = customers.find((c) => c.customer.id === customerId);
    if (!entry) continue;
    const startDate = startOfDay(now - 17 * MONTH);
    const endedAt = startOfDay(created.find((row) => row.entry.customer.id === customerId)?.sub.start_date ?? now - 10 * MONTH);
    if (endedAt <= startDate) continue;
    const mark = ctx.now();
    const sub = billing.createSubscription(orgId, {
      customer: customerId,
      items: [{ price: priceOf(`${entry.rung}_monthly`), quantity: 1 }, { price: priceOf('telemetry_events_monthly'), quantity: 1 }],
      backdate_start_date: startDate,
      billing_cycle_anchor: startDate,
      collection_method: 'charge_automatically',
      default_payment_method: `pm_card_${entry.slug.slice(0, 10)}`,
      description: `${entry.company.display_name} — monthly term, closed on renewal to annual`,
      metadata: { crm_company: entry.company.id, replaced_by: 'annual_term' },
    }, { actorType: 'system' });
    retimeEvents(ctx, orgId, sub.id, mark, startDate);
    fastForward(ctx, billing, orgId, sub.id, endedAt);
    const cancelMark = ctx.now();
    billing.endNow(orgId, billing.requireSubscription(orgId, sub.id), {
      at: endedAt, reason: 'switched_to_annual', comment: 'Signed a twelve-month term at two months free.', meta: { actorType: 'system' },
    });
    ctx.db.patch('billing_subscriptions', 'id', sub.id, { canceled_at: endedAt, updated: endedAt });
    retimeEvents(ctx, orgId, sub.id, cancelMark, endedAt);
  }

  /* --------------------------- statuses and states ------------------------ */

  for (const row of created) {
    const sub = billing.requireSubscription(orgId, row.sub.id);
    if (sub.status !== 'active') continue;
    if (arrears.has(sub.customer)) {
      billing.transition(orgId, sub, 'past_due', { meta: { actorType: 'system' } });
    } else if (paused.has(sub.customer)) {
      billing.pauseSubscription(orgId, sub.id, { behavior: 'keep_as_draft', resumes_at: now + 45 * DAY }, { actorType: 'system' });
    }
  }

  // One account has given notice for the end of its paid period.
  const leaver = created.find((row) => row.entry.rung === 'growth' && billing.requireSubscription(orgId, row.sub.id).status === 'active');
  if (leaver) {
    billing.cancelSubscription(orgId, leaver.sub.id, {
      at_period_end: true,
      cancellation_reason: 'went_out_of_business',
      comment: 'Plant closure announced; access requested through to the end of the paid period.',
    }, { actorType: 'system' });
  }

  /* ------------------------------ a live ramp ----------------------------- */

  // "Three months on Starter while the pilot line proves out, then Growth."
  const rampAccount = created.find((row) => row.entry.rung === 'starter' && billing.requireSubscription(orgId, row.sub.id).status === 'active');
  if (rampAccount) {
    const sub = billing.requireSubscription(orgId, rampAccount.sub.id);
    schedules.create(orgId, {
      from_subscription: sub.id,
      start_date: sub.current_period_start,
      end_behavior: 'release',
      phases: [
        {
          items: [{ price: priceOf('starter_monthly'), quantity: 1 }, { price: priceOf('telemetry_events_monthly'), quantity: 1 }],
          iterations: 3,
          proration_behavior: 'none',
          description: 'Pilot line on Starter while the baseline is captured.',
        },
        {
          items: [
            { price: priceOf('growth_monthly'), quantity: 1 },
            { price: priceOf('growth_seat_monthly'), quantity: 12 },
            { price: priceOf('telemetry_events_monthly'), quantity: 1 },
          ],
          iterations: 9,
          proration_behavior: 'create_prorations',
          description: 'Plant-wide rollout on Growth with twelve operator seats.',
        },
      ],
      metadata: { deal: 'ramp', crm_company: rampAccount.entry.company.id },
    }, { actorType: 'system' });
  }

  /* -------------------------- balances and dunning ------------------------ */

  // A goodwill credit after an outage, and a small carried-forward balance.
  const goodwill = created[7]?.entry.customer;
  if (goodwill) {
    billing.adjustBalance(orgId, goodwill.id, -25_000, {
      type: 'adjustment',
      description: 'Goodwill credit for the 6 March ingestion outage, agreed by Sofia Alvarez.',
      createdAt: now - 21 * DAY,
    });
    ctx.db.run(`UPDATE billing_balance_transactions SET created = ? WHERE customer_id = ? AND created > ?`,
      now - 21 * DAY, goodwill.id, now - 21 * DAY);
  }

  /* ----------------------------- collections ------------------------------ */

  settleHistoricalInvoices(ctx, billing, orgId, now);

  /* -------------------------------- the clock ----------------------------- */

  // Every live subscription now needs its renewal aimed at the right instant:
  // the ones we fast-forwarded were enqueued against a period that has passed.
  for (const row of ctx.db.all<{ id: string }>(
    `SELECT id FROM billing_subscriptions WHERE org_id = ? AND status NOT IN ('canceled','incomplete_expired')`, orgId,
  )) {
    billing.scheduleLifecycleJobs(orgId, billing.requireSubscription(orgId, row.id));
  }
}

/**
 * Northwind has been collecting for eighteen months, so its history says so.
 *
 * Every invoice raised for a period that has already ended was paid — on the
 * day it fell due for the accounts on net terms, on the day it was raised for
 * the ones on a card. What stays open is the current cycle for the two accounts
 * in arrears, which is the entire reason those subscriptions are `past_due`:
 * the delinquency in this workspace is a real unpaid bill, not a flag.
 */
function settleHistoricalInvoices(ctx: Ctx, billing: Billing, orgId: string, now: number): void {
  const rows = ctx.db.all<{ id: string; created: number; due_date: number | null; subscription_id: string | null; period_end: number }>(
    `SELECT id, created, due_date, subscription_id, period_end FROM billing_invoices
      WHERE org_id = ? AND status = 'open' ORDER BY created ASC`, orgId,
  );
  const arrears = new Set(
    ctx.db.all<{ id: string }>(
      `SELECT id FROM billing_subscriptions WHERE org_id = ? AND status = 'past_due'`, orgId,
    ).map((row) => row.id),
  );
  for (const row of rows) {
    const current = Number(row.period_end) > now;
    if (current && row.subscription_id && arrears.has(row.subscription_id)) continue;
    const paidAt = Math.min(now, row.due_date === null ? Number(row.created) : Number(row.due_date));
    const mark = ctx.now();
    billing.invoices.pay(orgId, row.id, {
      note: row.due_date === null ? 'Collected by card on the billing date.' : 'Bank transfer received against the purchase order.',
      at: paidAt,
    }, { actorType: 'system' });
    retimeEvents(ctx, orgId, row.id, mark, paidAt);
  }
}

/* --------------------------------- helpers -------------------------------- */

/**
 * Move the events a seeded write just emitted back to the date they belong to,
 * so record timelines read as history rather than as a mass import.
 */
function retimeEvents(ctx: Ctx, orgId: string, objectId: string, since: number, to: number): void {
  ctx.db.run(
    `UPDATE events SET created = ? WHERE org_id = ? AND object_id = ? AND created >= ?`,
    to, orgId, objectId, since,
  );
}

/**
 * Walk a backdated subscription forward one period at a time, writing the
 * revenue ledger and the invoice for each period as it goes. This is the same
 * period arithmetic the renewal job uses, and it raises the same invoice, dated
 * at the boundary the charge was incurred on — so the workspace opens with
 * eighteen months of real bills rather than a ledger nobody was charged from.
 */
function fastForward(ctx: Ctx, billing: Billing, orgId: string, subscriptionId: string, to: number): void {
  const sub = billing.requireSubscription(orgId, subscriptionId);
  const iv = intervalOf(sub);
  const book = billing.book(orgId);
  let start = sub.current_period_start;
  let end = sub.current_period_end;
  let guard = 0;
  while (end <= to && guard++ < 400) {
    start = end;
    end = addInterval(end, iv, sub.billing_cycle_anchor_day);
    const period = { start, end };
    const at = { ...sub, current_period_start: start, current_period_end: end };
    billing.recordPeriod(orgId, at, period, 'billed', book, null, { createdAt: start });
    const mark = ctx.now();
    const invoice = billing.backfillInvoice(orgId, at, {
      reason: 'subscription_cycle', period, book, createdAt: start,
    });
    if (invoice) retimeEvents(ctx, orgId, invoice.id, mark, start);
  }
  ctx.db.patch('billing_subscriptions', 'id', subscriptionId, {
    current_period_start: start, current_period_end: end, updated: to,
  });
}

/**
 * An upgrade that happened months ago, priced by the same `prorate()` the API
 * runs today. The credit and the charge are billed on their own invoice, dated
 * the day the change landed, and the subscription's items move to the new
 * shape — so every period after this one is walked forward at the new price by
 * the same `fastForward` that walked the ones before it at the old one.
 */
function historicalChange(
  ctx: Ctx, billing: Billing, orgId: string, book: Pricebook, subscriptionId: string, at: number,
  changes: { index: number; price?: string; quantity?: number }[], note: string,
): void {
  const sub = billing.requireSubscription(orgId, subscriptionId);
  const period = periodAt(sub.billing_cycle_anchor, intervalOf(sub), at, sub.billing_cycle_anchor_day);
  const before = sub.items.map((item) => ({
    id: item.id, price: book.price(item.price), quantity: item.quantity, customUnitAmount: item.custom_unit_amount,
  }));
  const after = before.map((item, index) => {
    const change = changes.find((c) => c.index === index);
    if (!change) return item;
    return {
      ...item,
      price: change.price ? book.price(change.price) : item.price,
      quantity: change.quantity ?? item.quantity,
    };
  });

  const set = prorate({
    subscriptionId: sub.id,
    currency: sub.currency,
    locale: billing.locale(orgId),
    status: 'active',
    currentPeriod: period,
    nextPeriod: period,
    interval: intervalOf(sub),
    anchorDay: sub.billing_cycle_anchor_day,
    before,
    after,
    prorationDate: at,
    behavior: 'create_prorations',
    book,
  });

  const pendingIds = set.lines.map((line, lineIndex) => {
    const id = `ii_seed_${sub.id.slice(4, 12)}_${line.kind === 'unused_time' ? 'cr' : 'ch'}${lineIndex}`;
    ctx.db.insert('billing_pending_items', {
      id,
      org_id: orgId, customer_id: sub.customer, subscription_id: sub.id,
      subscription_item_id: line.subscription_item, price_id: line.price, quantity: line.quantity,
      amount: line.amount, currency: line.currency, description: line.description, explanation: line.explanation,
      kind: line.kind, period_start: line.period.start, period_end: line.period.end,
      proration_numerator: line.proration.numerator, proration_denominator: line.proration.denominator,
      proration_date: at, breakdown: line.breakdown as any,
      status: 'pending', invoice_id: null, created: at,
    } as any);
    return id;
  });

  // The upgrade was billed at the time, on its own invoice, exactly as
  // `always_invoice` would bill one today — which is why the lines can be
  // reconciled against a real document rather than left floating as "settled".
  const mark = ctx.now();
  const invoice = billing.backfillInvoice(orgId, sub, {
    reason: 'subscription_update', period: period, book, createdAt: at, paidAt: at,
    recurring: false, pendingItemIds: pendingIds,
  });
  if (invoice) retimeEvents(ctx, orgId, invoice.id, mark, at);

  after.forEach((item, index) => {
    if (!item.id || item === before[index]) return;
    ctx.db.patch('billing_subscription_items', 'id', item.id, {
      price_id: item.price.id, quantity: item.quantity, updated: at,
    });
  });

  ctx.db.insert('events', {
    id: `evt_seed_change_${sub.id.slice(4, 14)}`,
    type: 'subscription.prorated',
    org_id: orgId, object_id: sub.id, object_type: 'subscription',
    actor_id: null, actor_type: 'system', request_id: null, created: at,
    data: {
      subscription: sub.id, customer: sub.customer, currency: sub.currency,
      proration_date: at, proration_behavior: 'create_prorations',
      credit_total: set.creditTotal, charge_total: set.chargeTotal, net: set.net,
      note, lines: set.lines,
    } as any,
    previous: null,
  } as any);
}
