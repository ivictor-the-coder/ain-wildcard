/**
 * Usage economics: what the meters are worth, and who paid for them.
 *
 * A usage-priced business has three different numbers for the same telemetry
 * and confuses them at its peril:
 *
 *  - **metered value** — what the usage priced at, before anything was applied.
 *  - **credit-covered** — the part a prepaid grant absorbed. Real revenue, but
 *    it was recognised when the credit was *sold*, not when it was burned.
 *  - **charged** — the part that reached an invoice as new money. This is the
 *    overage, and it is the only one of the three that is incremental cash.
 *
 * The settlement ledger in `credits` already holds all three per period, per
 * price, so this reads them rather than re-deriving them — which is why the
 * numbers here can never disagree with the invoices they came from.
 */
import type { Ctx } from '../../kernel/context';
import { monthKey } from '../../../shared/time';
import type { MonthCell } from './grid';
import { decimal2, ratio, type Decimal2, type Ratio } from './ratio';

export interface MeterEconomics {
  meter: string | null;
  name: string;
  unit_label: string | null;
  currency: string;
  settlements: number;
  /** Metered quantity in micro-units: 1 unit = 1,000,000. */
  quantity_micro: number;
  /** What the usage priced at, before credit. */
  metered_value: number;
  /** Absorbed by prepaid credit. */
  credit_covered: number;
  /** Reached an invoice as new money. */
  charged: number;
  /** `charged / metered_value` — how much of this meter is really overage. */
  charged_share: Ratio;
  /** Minor units of metered value per whole unit, to two decimal places. */
  revenue_per_unit: Decimal2;
}

export interface UsageMonth {
  month: string;
  period: { start: number; end: number };
  complete: boolean;
  metered_value: number;
  credit_covered: number;
  charged: number;
  settlements: number;
}

export interface CreditFlow {
  kind: 'monetary' | 'unit';
  /** Minor units for a monetary grant, micro-units for a unit grant. */
  granted: number;
  burned: number;
  expired: number;
  refunded: number;
  adjusted: number;
  entries: number;
  balance: number;
  /** True when the figures are micro-units rather than minor units. */
  micro: boolean;
}

export interface InvoicedMix {
  kind: string;
  lines: number;
  amount: number;
  share: Ratio;
}

export interface UsageReport {
  meters: MeterEconomics[];
  months: UsageMonth[];
  totals: {
    metered_value: number;
    credit_covered: number;
    charged: number;
    settlements: number;
    skipped_settlements: number;
    currency: string;
    /** Metered money as a share of everything invoiced in the range. */
    metered_share_of_invoiced: Ratio;
    /** Charged usage as a share of everything invoiced — the true overage line. */
    overage_share_of_invoiced: Ratio;
    invoiced: number;
  };
  credit: {
    flows: CreditFlow[];
    purchased: number;
    purchase_lines: number;
    /** Burned against usage, in minor units, for monetary grants. */
    burned: number;
    /** Purchases over burn: above 100% the customer is stockpiling credit. */
    purchase_to_burn: Ratio;
    outstanding_monetary: number;
    outstanding_unit_micro: number;
    grants: number;
  };
  invoiced_mix: InvoicedMix[];
}

const num = (value: unknown): number => Number(value ?? 0);

export function usageReport(
  ctx: Ctx, orgId: string, from: number, to: number, cells: MonthCell[], currency: string,
): UsageReport {
  const settlements = ctx.db.all<{
    meter_id: string | null; name: string | null; unit_label: string | null; price_id: string; currency: string;
    settlements: number; quantity_micro: number; full_amount: number; covered_amount: number; charged_amount: number;
  }>(
    `SELECT s.meter_id, m.name, m.unit_label, s.price_id, s.currency,
            COUNT(*) AS settlements,
            COALESCE(SUM(s.quantity_micro), 0) AS quantity_micro,
            COALESCE(SUM(s.full_amount), 0) AS full_amount,
            COALESCE(SUM(s.covered_amount), 0) AS covered_amount,
            COALESCE(SUM(s.charged_amount), 0) AS charged_amount
       FROM credit_settlements s
       LEFT JOIN meters m ON m.id = s.meter_id AND m.org_id = s.org_id
      WHERE s.org_id = ? AND s.status = 'settled' AND s.period_end > ? AND s.period_end <= ?
      GROUP BY s.meter_id, m.name, m.unit_label, s.price_id, s.currency
      ORDER BY full_amount DESC`,
    orgId, from, to,
  );

  const meters: MeterEconomics[] = settlements.map((row) => ({
    meter: row.meter_id,
    name: row.name ?? (row.meter_id ? row.meter_id : `Priced usage on ${row.price_id}`),
    unit_label: row.unit_label,
    currency: row.currency,
    settlements: num(row.settlements),
    quantity_micro: num(row.quantity_micro),
    metered_value: num(row.full_amount),
    credit_covered: num(row.covered_amount),
    charged: num(row.charged_amount),
    charged_share: ratio(num(row.charged_amount), num(row.full_amount)),
    revenue_per_unit: decimal2(num(row.full_amount) * 1_000_000, num(row.quantity_micro)),
  }));

  const byMonth = ctx.db.all<{ period_end: number; full_amount: number; covered_amount: number; charged_amount: number }>(
    `SELECT period_end, full_amount, covered_amount, charged_amount
       FROM credit_settlements
      WHERE org_id = ? AND status = 'settled' AND period_end > ? AND period_end <= ?`,
    orgId, from, to,
  );
  const monthIndex = new Map<string, { full_amount: number; covered_amount: number; charged_amount: number; settlements: number }>();
  for (const row of byMonth) {
    // A usage period is earned where it ends: that is the window the meter
    // closed on and the window the invoice settles.
    const key = monthKey(num(row.period_end));
    const cell = monthIndex.get(key) ?? { full_amount: 0, covered_amount: 0, charged_amount: 0, settlements: 0 };
    cell.full_amount += num(row.full_amount);
    cell.covered_amount += num(row.covered_amount);
    cell.charged_amount += num(row.charged_amount);
    cell.settlements += 1;
    monthIndex.set(key, cell);
  }
  const months: UsageMonth[] = cells.map((cell) => {
    const row = monthIndex.get(cell.key);
    return {
      month: cell.key,
      period: { start: cell.start, end: cell.end },
      complete: cell.complete,
      metered_value: num(row?.full_amount),
      credit_covered: num(row?.covered_amount),
      charged: num(row?.charged_amount),
      settlements: num(row?.settlements),
    };
  });

  const skipped = ctx.db.count(
    `SELECT COUNT(*) FROM credit_settlements WHERE org_id = ? AND status = 'skipped' AND period_end > ? AND period_end <= ?`,
    orgId, from, to,
  );

  /* ------------------------------ credit flows ---------------------------- */

  const ledger = ctx.db.all<{ kind: string; type: string; entries: number; micro: number }>(
    `SELECT g.kind AS kind, l.type AS type, COUNT(*) AS entries, COALESCE(SUM(l.delta_micro), 0) AS micro
       FROM credit_ledger l
       JOIN credit_grants g ON g.id = l.grant_id
      WHERE l.org_id = ? AND l.created >= ? AND l.created < ?
      GROUP BY g.kind, l.type`,
    orgId, from, to,
  );

  // Monetary grants are always whole minor units of micro, so the division is
  // exact; unit grants keep their micro precision and say so.
  const toMinor = (micro: number): number => Number(BigInt(Math.trunc(micro)) / 1_000_000n);
  const flows: CreditFlow[] = (['monetary', 'unit'] as const).map((kind) => {
    const rows = ledger.filter((row) => row.kind === kind);
    const pick = (type: string) => num(rows.find((row) => row.type === type)?.micro);
    const scale = (micro: number) => (kind === 'monetary' ? toMinor(micro) : micro);
    return {
      kind,
      granted: scale(pick('grant') + pick('rollover_in')),
      burned: scale(-pick('burn')),
      expired: scale(-pick('expiry')),
      refunded: scale(-pick('refund') - pick('void')),
      adjusted: scale(pick('adjustment')),
      entries: rows.reduce((sum, row) => sum + num(row.entries), 0),
      balance: scale(rows.reduce((sum, row) => sum + num(row.micro), 0)),
      micro: kind === 'unit',
    };
  });

  const purchases = ctx.db.get<{ lines: number; amount: number }>(
    `SELECT COUNT(*) AS lines, COALESCE(SUM(amount), 0) AS amount
       FROM credit_billable_items
      WHERE org_id = ? AND kind = 'topup' AND status <> 'void' AND created >= ? AND created < ?`,
    orgId, from, to,
  ) ?? { lines: 0, amount: 0 };

  const outstanding = ctx.db.all<{ kind: string; micro: number }>(
    `SELECT g.kind AS kind, COALESCE(SUM(l.delta_micro), 0) AS micro
       FROM credit_ledger l JOIN credit_grants g ON g.id = l.grant_id
      WHERE l.org_id = ? AND l.created < ?
      GROUP BY g.kind`,
    orgId, to,
  );
  const outstandingOf = (kind: string) => num(outstanding.find((row) => row.kind === kind)?.micro);
  const monetaryBurned = flows.find((flow) => flow.kind === 'monetary')?.burned ?? 0;

  /* ---------------------------- the invoiced mix -------------------------- */

  const mix = ctx.db.all<{ kind: string; lines: number; amount: number }>(
    `SELECT l.kind AS kind, COUNT(*) AS lines, COALESCE(SUM(l.amount), 0) AS amount
       FROM billing_invoice_lines l
       JOIN billing_invoices i ON i.id = l.invoice_id
      WHERE l.org_id = ? AND i.status IN ('open', 'paid', 'uncollectible')
        AND i.finalized_at >= ? AND i.finalized_at < ?
      GROUP BY l.kind ORDER BY amount DESC`,
    orgId, from, to,
  );
  const invoiced = mix.reduce((sum, row) => sum + num(row.amount), 0);
  const meteredLines = mix
    .filter((row) => row.kind === 'usage' || row.kind === 'true_up' || row.kind === 'credit_covered')
    .reduce((sum, row) => sum + num(row.amount), 0);
  const chargedLines = mix
    .filter((row) => row.kind === 'usage' || row.kind === 'true_up')
    .reduce((sum, row) => sum + num(row.amount), 0);

  return {
    meters,
    months,
    totals: {
      metered_value: meters.reduce((sum, row) => sum + row.metered_value, 0),
      credit_covered: meters.reduce((sum, row) => sum + row.credit_covered, 0),
      charged: meters.reduce((sum, row) => sum + row.charged, 0),
      settlements: meters.reduce((sum, row) => sum + row.settlements, 0),
      skipped_settlements: skipped,
      currency,
      metered_share_of_invoiced: ratio(meteredLines, invoiced),
      overage_share_of_invoiced: ratio(chargedLines, invoiced),
      invoiced,
    },
    credit: {
      flows,
      purchased: num(purchases.amount),
      purchase_lines: num(purchases.lines),
      burned: monetaryBurned,
      purchase_to_burn: ratio(num(purchases.amount), monetaryBurned),
      outstanding_monetary: toMinor(outstandingOf('monetary')),
      outstanding_unit_micro: outstandingOf('unit'),
      grants: ctx.db.count(`SELECT COUNT(*) FROM credit_grants WHERE org_id = ? AND created < ?`, orgId, to),
    },
    invoiced_mix: mix.map((row) => ({
      kind: row.kind,
      lines: num(row.lines),
      amount: num(row.amount),
      share: ratio(num(row.amount), invoiced),
    })),
  };
}
