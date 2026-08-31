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
 *
 * The credit flow beside them is a **ledger**, and it is reported like one:
 * every field is the signed sum of one ledger type, so a burn is negative
 * because a burn makes the balance smaller, and the named fields add up to the
 * closing movement exactly. Anything the ledger holds that this file does not
 * name lands in `other` rather than vanishing, and a reconciliation block
 * checks the whole thing against a second, independent read of the same table.
 */
import type { Ctx } from '../../kernel/context';
import { monthKey } from '../../../shared/time';
import type { MonthCell } from './grid';
import { decimal2, ratio, type Decimal2, type Ratio } from './ratio';
import type { CurrencyScope } from './currency';

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

/**
 * One credit ledger, summarised.
 *
 * Every money field is the **signed** sum of its ledger type, exactly as the
 * ledger carries it: `granted` is positive because a grant adds to the balance,
 * `burned` and `expired` are negative because they take from it, and `refunded`
 * carries whichever sign the refund actually had rather than a sign this file
 * assumed. `inflows`/`outflows` are there for anyone who wants magnitudes.
 */
export interface CreditFlow {
  kind: 'monetary' | 'unit';
  /** The currency of the grants behind it, or null across the whole book. */
  currency: string | null;
  /** Minor units for a monetary grant, micro-units for a unit grant. */
  granted: number;
  /** Credit carried into a grant from a previous period. Not a new grant. */
  rolled_in: number;
  /** Credit carried out of an expiring grant. Negative: it left this one. */
  rolled_out: number;
  burned: number;
  expired: number;
  refunded: number;
  voided: number;
  adjusted: number;
  /** Any ledger type this file does not name, so nothing can go missing. */
  other: { type: string; amount: number; entries: number }[];
  other_total: number;
  inflows: number;
  outflows: number;
  entries: number;
  /** Net movement over the window: the named fields sum to exactly this. */
  balance: number;
  /** True when the figures are micro-units rather than minor units. */
  micro: boolean;
  reconciliation: {
    components: number;
    balance: number;
    difference: number;
    balanced: boolean;
    note: string | null;
  };
}

export interface InvoicedMix {
  kind: string;
  currency: string;
  lines: number;
  amount: number;
  share: Ratio;
}

export interface UsageCheck {
  name: string;
  description: string;
  expected: number;
  actual: number;
  difference: number;
  unit: 'minor' | 'micro';
  ok: boolean;
}

export interface UsageTotals {
  metered_value: number;
  credit_covered: number;
  charged: number;
  settlements: number;
  skipped_settlements: number;
  currency: string | null;
  /** Metered money as a share of everything invoiced in the range. */
  metered_share_of_invoiced: Ratio;
  /** Charged usage as a share of everything invoiced — the true overage line. */
  overage_share_of_invoiced: Ratio;
  invoiced: number;
}

export interface UsageCredit {
  flows: CreditFlow[];
  purchased: number;
  purchase_lines: number;
  /**
   * Credit burned against usage as a positive magnitude — the sign flipped
   * once, here, where the name says which direction it means.
   */
  burned_against_usage: number;
  /** Purchases over burn: above 100% the customer is stockpiling credit. */
  purchase_to_burn: Ratio;
  outstanding_monetary: number;
  outstanding_unit_micro: number;
  grants: number;
}

/** Everything the report says about one currency. */
export interface UsageSlice {
  currency: string;
  totals: UsageTotals;
  months: UsageMonth[];
  meters: MeterEconomics[];
  credit: UsageCredit;
  invoiced_mix: InvoicedMix[];
}

export interface UsageReport {
  meters: MeterEconomics[];
  months: UsageMonth[];
  by_currency: UsageSlice[];
  totals: UsageTotals;
  credit: UsageCredit;
  invoiced_mix: InvoicedMix[];
  reconciliation: {
    balanced: boolean;
    checks: UsageCheck[];
    note: string | null;
  };
}

const num = (value: unknown): number => Number(value ?? 0);

const MICRO = 1_000_000;

/** Monetary grants are whole minor units of micro, so the division is exact. */
const toMinor = (micro: number): number => Number(BigInt(Math.trunc(micro)) / BigInt(MICRO));

interface SettlementRow {
  meter_id: string | null; name: string | null; unit_label: string | null; price_id: string; currency: string;
  settlements: number; quantity_micro: number; full_amount: number; covered_amount: number; charged_amount: number;
}

interface MonthRow { period_end: number; currency: string; full_amount: number; covered_amount: number; charged_amount: number }
/** Grouped straight off `credit_ledger`, which carries its own kind and currency. */
interface LedgerRow { kind: string; currency: string; type: string; entries: number; micro: number }
interface MixRow { kind: string; currency: string; lines: number; amount: number }

/** The ledger types this file names, in the order a flow reports them. */
const NAMED_TYPES = ['grant', 'rollover_in', 'rollover_out', 'burn', 'expiry', 'refund', 'void', 'adjustment'] as const;

function creditFlow(kind: 'monetary' | 'unit', currency: string | null, rows: LedgerRow[]): CreditFlow {
  const scale = (micro: number) => (kind === 'monetary' ? toMinor(micro) : micro);
  const pick = (type: string) => scale(rows.filter((row) => row.type === type).reduce((sum, row) => sum + num(row.micro), 0));

  const other = rows
    .filter((row) => !(NAMED_TYPES as readonly string[]).includes(row.type))
    .map((row) => ({ type: row.type, amount: scale(num(row.micro)), entries: num(row.entries) }))
    .sort((a, b) => a.type.localeCompare(b.type));
  const otherTotal = other.reduce((sum, row) => sum + row.amount, 0);

  const named = {
    granted: pick('grant'),
    rolled_in: pick('rollover_in'),
    rolled_out: pick('rollover_out'),
    burned: pick('burn'),
    expired: pick('expiry'),
    refunded: pick('refund'),
    voided: pick('void'),
    adjusted: pick('adjustment'),
  };

  const components = Object.values(named).reduce((sum, value) => sum + value, 0) + otherTotal;
  // Accumulated separately, over every row rather than over the named buckets,
  // so a type that is neither named nor collected would show up as a break.
  const balance = scale(rows.reduce((sum, row) => sum + num(row.micro), 0));
  const parts = [...Object.values(named), ...other.map((row) => row.amount)];

  return {
    kind,
    currency,
    ...named,
    other,
    other_total: otherTotal,
    inflows: parts.filter((value) => value > 0).reduce((sum, value) => sum + value, 0),
    outflows: parts.filter((value) => value < 0).reduce((sum, value) => sum + value, 0),
    entries: rows.reduce((sum, row) => sum + num(row.entries), 0),
    balance,
    micro: kind === 'unit',
    reconciliation: {
      components,
      balance,
      difference: components - balance,
      balanced: components === balance,
      note: components === balance
        ? null
        : `The named components of this ledger come to ${components} but the ledger moved ${balance} over the same ` +
          'window. The difference is a ledger type this report does not account for; do not read the flow until it is named.',
    },
  };
}

export function usageReport(
  ctx: Ctx, orgId: string, from: number, to: number, cells: MonthCell[], scope: CurrencyScope,
): UsageReport {
  const only = scope.single;
  const clause = (column: string) => (only ? ` AND ${column} = ?` : '');
  const args = (...params: unknown[]) => (only ? [...params, only] : params) as never[];

  const settlements = ctx.db.all<SettlementRow>(
    `SELECT s.meter_id, m.name, m.unit_label, s.price_id, s.currency,
            COUNT(*) AS settlements,
            COALESCE(SUM(s.quantity_micro), 0) AS quantity_micro,
            COALESCE(SUM(s.full_amount), 0) AS full_amount,
            COALESCE(SUM(s.covered_amount), 0) AS covered_amount,
            COALESCE(SUM(s.charged_amount), 0) AS charged_amount
       FROM credit_settlements s
       LEFT JOIN meters m ON m.id = s.meter_id AND m.org_id = s.org_id
      WHERE s.org_id = ? AND s.status = 'settled' AND s.period_end > ? AND s.period_end <= ?${clause('s.currency')}
      GROUP BY s.meter_id, m.name, m.unit_label, s.price_id, s.currency
      ORDER BY full_amount DESC`,
    ...args(orgId, from, to),
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
    revenue_per_unit: decimal2(num(row.full_amount) * MICRO, num(row.quantity_micro)),
  }));

  const byMonth = ctx.db.all<MonthRow>(
    `SELECT period_end, currency, full_amount, covered_amount, charged_amount
       FROM credit_settlements
      WHERE org_id = ? AND status = 'settled' AND period_end > ? AND period_end <= ?${clause('currency')}`,
    ...args(orgId, from, to),
  );

  const skipped = ctx.db.all<{ currency: string; count: number }>(
    `SELECT currency, COUNT(*) AS count FROM credit_settlements
      WHERE org_id = ? AND status = 'skipped' AND period_end > ? AND period_end <= ?${clause('currency')}
      GROUP BY currency`,
    ...args(orgId, from, to),
  );

  // Grouped on the ledger's own kind and currency rather than through a join on
  // credit_grants: a join drops what it cannot match, and a credit flow that
  // silently shrinks because a grant row went missing is exactly the kind of
  // quiet wrong number this module exists to refuse.
  const ledger = ctx.db.all<LedgerRow>(
    `SELECT l.kind AS kind, l.currency AS currency, l.type AS type, COUNT(*) AS entries,
            COALESCE(SUM(l.delta_micro), 0) AS micro
       FROM credit_ledger l
      WHERE l.org_id = ? AND l.created >= ? AND l.created < ?${clause('l.currency')}
      GROUP BY l.kind, l.currency, l.type`,
    ...args(orgId, from, to),
  );

  // The denormalised columns above against the grants they were copied from:
  // a ledger row with no grant, or one whose kind or currency has drifted from
  // its grant's, breaks a check instead of quietly changing a total.
  const inconsistentRows = ctx.db.count(
    `SELECT COUNT(*) FROM credit_ledger l
       LEFT JOIN credit_grants g ON g.id = l.grant_id AND g.org_id = l.org_id
      WHERE l.org_id = ? AND l.created >= ? AND l.created < ?
        AND (g.id IS NULL OR g.kind <> l.kind OR g.currency <> l.currency)`,
    orgId, from, to,
  );
  const unreportedKinds = ctx.db.count(
    `SELECT COUNT(*) FROM credit_ledger l
      WHERE l.org_id = ? AND l.created >= ? AND l.created < ? AND l.kind NOT IN ('monetary', 'unit')`,
    orgId, from, to,
  );

  const purchases = ctx.db.all<{ currency: string; lines: number; amount: number }>(
    `SELECT currency, COUNT(*) AS lines, COALESCE(SUM(amount), 0) AS amount
       FROM credit_billable_items
      WHERE org_id = ? AND kind = 'topup' AND status <> 'void' AND created >= ? AND created < ?${clause('currency')}
      GROUP BY currency`,
    ...args(orgId, from, to),
  );

  const outstanding = ctx.db.all<{ kind: string; currency: string; micro: number }>(
    `SELECT l.kind AS kind, l.currency AS currency, COALESCE(SUM(l.delta_micro), 0) AS micro
       FROM credit_ledger l
      WHERE l.org_id = ? AND l.created < ?${clause('l.currency')}
      GROUP BY l.kind, l.currency`,
    ...args(orgId, to),
  );

  const grants = ctx.db.all<{ currency: string; count: number }>(
    `SELECT currency, COUNT(*) AS count FROM credit_grants WHERE org_id = ? AND created < ?${clause('currency')}
      GROUP BY currency`,
    ...args(orgId, to),
  );

  const mix = ctx.db.all<MixRow>(
    `SELECT l.kind AS kind, i.currency AS currency, COUNT(*) AS lines, COALESCE(SUM(l.amount), 0) AS amount
       FROM billing_invoice_lines l
       JOIN billing_invoices i ON i.id = l.invoice_id AND i.org_id = l.org_id
      WHERE l.org_id = ? AND i.status IN ('open', 'paid', 'uncollectible')
        AND i.finalized_at >= ? AND i.finalized_at < ?${clause('i.currency')}
      GROUP BY l.kind, i.currency ORDER BY amount DESC`,
    ...args(orgId, from, to),
  );

  /* ------------------------- one currency's answer ------------------------ */

  const slice = (currency: string | null) => {
    const keep = <T extends { currency: string }>(rows: T[]) =>
      (currency === null ? rows : rows.filter((row) => row.currency === currency));

    const scopedMeters = keep(meters);
    const monthRows = keep(byMonth);
    const mixRows = keep(mix);

    const monthIndex = new Map<string, { full: number; covered: number; charged: number; settlements: number }>();
    for (const row of monthRows) {
      // A usage period is earned where it ends: that is the window the meter
      // closed on and the window the invoice settles.
      const key = monthKey(num(row.period_end));
      const cell = monthIndex.get(key) ?? { full: 0, covered: 0, charged: 0, settlements: 0 };
      cell.full += num(row.full_amount);
      cell.covered += num(row.covered_amount);
      cell.charged += num(row.charged_amount);
      cell.settlements += 1;
      monthIndex.set(key, cell);
    }

    const months: UsageMonth[] = cells.map((cell) => {
      const row = monthIndex.get(cell.key);
      return {
        month: cell.key,
        period: { start: cell.start, end: cell.end },
        complete: cell.complete,
        metered_value: num(row?.full),
        credit_covered: num(row?.covered),
        charged: num(row?.charged),
        settlements: num(row?.settlements),
      };
    });

    const invoiced = mixRows.reduce((sum, row) => sum + num(row.amount), 0);
    const meteredLines = mixRows
      .filter((row) => row.kind === 'usage' || row.kind === 'true_up' || row.kind === 'credit_covered')
      .reduce((sum, row) => sum + num(row.amount), 0);
    const chargedLines = mixRows
      .filter((row) => row.kind === 'usage' || row.kind === 'true_up')
      .reduce((sum, row) => sum + num(row.amount), 0);

    const flows: CreditFlow[] = (['monetary', 'unit'] as const).map(
      (kind) => creditFlow(kind, currency, keep(ledger).filter((row) => row.kind === kind)),
    );
    const monetaryBurn = flows.find((flow) => flow.kind === 'monetary')?.burned ?? 0;
    // The one place the sign is flipped, because the name says which way it
    // means. `-0` is not a figure anyone wants to read back.
    const burnedMagnitude = monetaryBurn === 0 ? 0 : -monetaryBurn;
    const purchased = keep(purchases).reduce((sum, row) => sum + num(row.amount), 0);
    const outstandingOf = (kind: string) =>
      keep(outstanding).filter((row) => row.kind === kind).reduce((sum, row) => sum + num(row.micro), 0);

    const totals: UsageTotals = {
      metered_value: scopedMeters.reduce((sum, row) => sum + row.metered_value, 0),
      credit_covered: scopedMeters.reduce((sum, row) => sum + row.credit_covered, 0),
      charged: scopedMeters.reduce((sum, row) => sum + row.charged, 0),
      settlements: scopedMeters.reduce((sum, row) => sum + row.settlements, 0),
      skipped_settlements: keep(skipped).reduce((sum, row) => sum + num(row.count), 0),
      currency,
      metered_share_of_invoiced: ratio(meteredLines, invoiced),
      overage_share_of_invoiced: ratio(chargedLines, invoiced),
      invoiced,
    };

    const credit: UsageCredit = {
      flows,
      purchased,
      purchase_lines: keep(purchases).reduce((sum, row) => sum + num(row.lines), 0),
      burned_against_usage: burnedMagnitude,
      purchase_to_burn: ratio(purchased, burnedMagnitude),
      outstanding_monetary: toMinor(outstandingOf('monetary')),
      outstanding_unit_micro: outstandingOf('unit'),
      grants: keep(grants).reduce((sum, row) => sum + num(row.count), 0),
    };

    const invoicedMix: InvoicedMix[] = mixRows.map((row) => ({
      kind: row.kind,
      currency: row.currency,
      lines: num(row.lines),
      amount: num(row.amount),
      share: ratio(num(row.amount), invoiced),
    }));

    return { totals, months, meters: scopedMeters, credit, invoiced_mix: invoicedMix };
  };

  const whole = slice(null);
  const currencies = only
    ? [only]
    : [...new Set([
      ...scope.currencies,
      ...meters.map((row) => row.currency),
      ...ledger.map((row) => row.currency),
      ...mix.map((row) => row.currency),
    ])].sort();
  const byCurrency: UsageSlice[] = currencies.map((currency) => ({ currency, ...slice(currency) }));

  /* ---------------------------- the check block --------------------------- */

  const settlementValue = meters.reduce((sum, row) => sum + row.metered_value, 0);
  const settlementParts = meters.reduce((sum, row) => sum + row.credit_covered + row.charged, 0);
  const flowDifference = byCurrency
    .flatMap((slice_) => slice_.credit.flows)
    .reduce((sum, flow) => sum + flow.reconciliation.difference, 0);

  const checks: UsageCheck[] = [
    {
      name: 'settlement_components_match',
      description:
        'Every settled period prices its usage once and records three figures for it. What credit absorbed plus what ' +
        'was charged must be the whole metered value, summed here from three separate columns of credit_settlements.',
      expected: settlementValue,
      actual: settlementParts,
      difference: settlementParts - settlementValue,
      unit: 'minor',
      ok: settlementValue === settlementParts,
    },
    {
      name: 'credit_flow_components_sum_to_movement',
      description:
        'Every named component of every credit ledger against the net movement of that ledger over the same window, ' +
        'accumulated separately. A ledger type this report does not name would break it, which is what the `other` ' +
        'bucket exists to prevent.',
      expected: 0,
      actual: flowDifference,
      difference: flowDifference,
      unit: 'micro',
      ok: byCurrency.every((slice_) => slice_.credit.flows.every((flow) => flow.reconciliation.balanced))
        && whole.credit.flows.every((flow) => flow.reconciliation.balanced),
    },
    {
      name: 'ledger_agrees_with_its_grants',
      description:
        'Every ledger row in the window against the grant it belongs to. The flows are grouped on the ledger\'s own ' +
        'kind and currency columns; this counts the rows where those have drifted from the grant they were copied ' +
        'from, or where the grant is gone altogether.',
      expected: 0,
      actual: inconsistentRows,
      difference: inconsistentRows,
      unit: 'micro',
      ok: inconsistentRows === 0,
    },
    {
      name: 'every_grant_kind_is_reported',
      description:
        'A flow is reported for monetary and unit credit. This counts ledger rows of any other kind — credit that ' +
        'moved in the window and would appear in no flow above.',
      expected: 0,
      actual: unreportedKinds,
      difference: unreportedKinds,
      unit: 'micro',
      ok: unreportedKinds === 0,
    },
  ];
  const failed = checks.filter((check) => !check.ok);

  return {
    meters,
    months: whole.months,
    by_currency: byCurrency,
    totals: whole.totals,
    credit: whole.credit,
    invoiced_mix: whole.invoiced_mix,
    reconciliation: {
      balanced: failed.length === 0,
      checks,
      note: failed.length
        ? failed.map((check) => `${check.name}: expected ${check.expected}, got ${check.actual} (${check.unit}).`).join(' ')
        : null,
    },
  };
}
