/**
 * Northwind Robotics' prepaid credit book.
 *
 * Five accounts, five different shapes of credit, because that is what a real
 * usage business looks like: a fleet that prepaid packs and has burned through
 * them, one whose packs lapse next week, a new logo on promotional credit, a
 * goodwill balance that rolls over up to a cap, and a lapsed pack nobody used.
 *
 * Every number below is computed from the metered history seeded a moment
 * earlier, so the settlement in this file is the one the invoice would show.
 */
import type { Ctx } from '../../kernel/context';
import { DAY, startOfDay } from '../../../shared/time';
import { METERED_CUSTOMERS, resolveMeteredCustomers, telemetryShift, type SeedCustomer } from '../metering/seed';
import { Credits } from './store';

const TELEMETRY_PRICE = 'price_nw_telemetry_events';
const CREDIT_PACK_PRICE = 'price_nw_credit_pack';
const TELEMETRY_METER = 'telemetry_events';

export function seedCredits(ctx: Ctx, orgId: string): void {
  const credits = new Credits(ctx);
  // `resolveMeteredCustomers` maps one-for-one over the metering roster, so the
  // index is the link back to the account these grants were written for.
  const resolved = resolveMeteredCustomers(ctx, orgId);
  const byRosterId = new Map<string, SeedCustomer>(METERED_CUSTOMERS.map((c, i) => [c.id, resolved[i]]));
  /**
   * A grant names a customer, so it can only go to a roster entry that resolved
   * to a real invoicing customer. An unresolved entry keeps its roster id, and a
   * grant written against that id is a balance on an account that does not
   * exist — the credits screen showed one as "Unknown account".
   */
  const grantee = (rosterId: string): SeedCustomer | undefined => {
    const customer = byRosterId.get(rosterId);
    return customer?.billable ? customer : undefined;
  };
  const now = ctx.now();

  const packPrice = ctx.svc.catalog.price(orgId, CREDIT_PACK_PRICE);
  const packCurrencies = packPrice ? ctx.svc.catalog.currencies(packPrice) : [];
  /**
   * Only sell a pack to an account that can actually be charged for it, and
   * only in a currency the price book offers. A purchase invoicing cannot take
   * leaves the customer holding credit nobody was billed for — which is exactly
   * what the grant is now held back from being until the charge lands, so
   * seeding one would seed a permanently held grant.
   */
  const canBuyPacks = (customer: SeedCustomer | undefined): customer is SeedCustomer =>
    !!customer && !!customer.billable && packCurrencies.includes(customer.currency);

  const meridian = grantee('cus_nw_meridianforge');
  const whitcombe = grantee('cus_nw_whitcombe');
  const aldergate = grantee('cus_nw_aldergate');
  const kestrel = grantee('cus_nw_kestrel');
  const sableworks = grantee('cus_nw_sableworks');
  const ironwood = grantee('cus_nw_ironwood');

  /* Meridian Forge prepaid five packs in the spring and signed for six more
     that start next quarter, so only the first five are spendable today. */
  if (canBuyPacks(meridian)) {
    credits.topUp(orgId, {
      customer: meridian.id,
      price: CREDIT_PACK_PRICE,
      quantity: 5,
      currency: meridian.currency,
      name: 'Telemetry packs — spring prepay',
      applicability: { scope: 'targeted', meters: [TELEMETRY_METER] },
      expires_at: startOfDay(now) + 45 * DAY,
      priority: 0,
      metadata: { po: 'MF-2026-0148', signed_by: 'Operations' },
    });
    credits.topUp(orgId, {
      customer: meridian.id,
      price: CREDIT_PACK_PRICE,
      quantity: 6,
      currency: meridian.currency,
      name: 'Telemetry packs — Q4 commitment',
      applicability: { scope: 'targeted', meters: [TELEMETRY_METER] },
      effective_at: startOfDay(now) + 5 * DAY,
      expires_at: startOfDay(now) + 190 * DAY,
      priority: 0,
      metadata: { po: 'MF-2026-0212', signed_by: 'Procurement' },
    });

    // Bill the month that just closed. The packs cover part of it and the rest
    // is charged — the two lines are what the customer's invoice shows.
    const periodEnd = startOfDay(now) - DAY;
    const periodStart = periodEnd - 30 * DAY;
    const { settlement } = credits.settleUsage(orgId, {
      customer: meridian.id,
      price: TELEMETRY_PRICE,
      meter: TELEMETRY_METER,
      period_start: periodStart,
      period_end: periodEnd,
      currency: meridian.currency,
      close_period: true,
    });

    /* And then the part every usage business actually lives with: a reading
       that turns out to have been wrong after the invoice went out. Meridian's
       gateway replayed a night shift it had already sent, so the shift is
       withdrawn — and because the period is closed, the correction becomes a
       true-up that credits the invoice and hands back the prepaid units that
       paid for it, rather than a number that quietly disagrees with the bill. */
    const replayed = telemetryShift(meridian.id, 20, 2);
    if (ctx.svc.metering.event(orgId, replayed)) {
      ctx.svc.metering.cancelEvent(orgId, {
        identifier: replayed,
        event_name: TELEMETRY_METER,
        reason: 'gateway mf-edge-3 replayed the 22:00 shift after a network partition',
      });
      const entry = ctx.svc.metering
        .lateArrivals(orgId, { customer: meridian.id, resolution: 'open', limit: 20 })
        .find((late) => late.period_start === periodStart && late.period_end === periodEnd);
      if (entry) {
        ctx.svc.metering.resolveLateArrival(orgId, entry.id, {
          resolution: 'credited',
          note: `Credited against ${settlement.id} — the shift was counted twice.`,
        });
      }
    }
  }

  /* Whitcombe's packs lapse next week — the account team's cue to call. And
     they are priced in sterling, so the balance screen has to keep two
     currencies apart rather than adding them up. */
  if (canBuyPacks(whitcombe)) {
    credits.topUp(orgId, {
      customer: whitcombe.id,
      price: CREDIT_PACK_PRICE,
      quantity: 4,
      currency: whitcombe.currency,
      name: 'Telemetry packs — pilot prepay',
      applicability: { scope: 'targeted', meters: [TELEMETRY_METER] },
      // Bought a quarter ago, so what rolls over covers the next quarter too.
      effective_at: startOfDay(now) - 84 * DAY,
      expires_at: startOfDay(now) + 6 * DAY,
      rollover: 'capped',
      rollover_cap: 1_000_000,
      priority: 0,
      metadata: { po: 'WA-8841', renewal_owner: 'Priya Raman' },
    });
  }

  /* Aldergate's renewal credits are signed but do not start until next week.
     Goodwill is given, not sold, so there is no purchase to charge for and the
     grant is held only by its start date. */
  if (aldergate) {
    credits.createGrant(orgId, {
      customer: aldergate.id,
      name: 'Renewal goodwill — Q4',
      category: 'promotional',
      kind: 'monetary',
      currency: aldergate.currency,
      amount: 150_000,
      effective_at: startOfDay(now) + 7 * DAY,
      expires_at: startOfDay(now) + 97 * DAY,
      priority: 10,
      reason: 'Agreed with Marcus during the renewal negotiation',
      metadata: { agreed_by: 'Marcus Ilori', deal_stage: 'renewal' },
    });
  }

  /* Kestrel had a bad month of false alarms; credit that rolls over, capped. */
  if (kestrel) {
    credits.createGrant(orgId, {
      customer: kestrel.id,
      name: 'Service credit — March alerting incident',
      category: 'promotional',
      kind: 'monetary',
      currency: kestrel.currency,
      amount: 100_000,
      expires_at: startOfDay(now) + 20 * DAY,
      rollover: 'capped',
      rollover_cap: 25_000,
      priority: 5,
      reason: 'SLA credit for the 14-hour alerting outage',
      metadata: { incident: 'INC-2291', approved_by: 'Sofia Alvarez' },
    });
  }

  /* Sableworks is three weeks old and onboarding on promotional credit. */
  if (sableworks) {
    credits.createGrant(orgId, {
      customer: sableworks.id,
      name: 'Onboarding credit — first 60 days',
      category: 'promotional',
      kind: 'monetary',
      currency: sableworks.currency,
      amount: 25_000,
      effective_at: startOfDay(now) - 21 * DAY,
      expires_at: startOfDay(now) + 39 * DAY,
      priority: 20,
      reason: 'Standard new-logo onboarding credit',
      metadata: { campaign: 'new_logo_2026' },
    });
  }

  /* Ironwood never used the pack they bought in the spring. It has lapsed, and
     the ledger says so in its own entry rather than by an absent balance. */
  if (canBuyPacks(ironwood)) {
    const lapsed = credits.topUp(orgId, {
      customer: ironwood.id,
      price: CREDIT_PACK_PRICE,
      quantity: 1,
      currency: ironwood.currency,
      name: 'Telemetry pack — trial prepay',
      applicability: { scope: 'targeted', meters: [TELEMETRY_METER] },
      effective_at: startOfDay(now) - 120 * DAY,
      expires_at: startOfDay(now) - 5 * DAY,
      priority: 0,
      metadata: { po: 'IW-1120' },
    });
    credits.expireGrant(orgId, lapsed.grant.id);
  }
}
