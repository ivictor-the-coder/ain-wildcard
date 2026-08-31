/**
 * Collections: what is owed, how old it is, and how much of it comes back.
 *
 * Ageing is reconstructed rather than snapshotted. Every finalised invoice
 * carries the four instants that decide whether it was outstanding at a given
 * moment — `finalized_at`, `paid_at`, `voided_at`, `marked_uncollectible_at` —
 * so the book can be aged at the close of any month in the range, not only as
 * it stands today. That is what makes the AR line on the monthly series a
 * balance rather than a repeated copy of this morning's number.
 *
 * "What was owed" is `amount_due + amount_paid`, never `total`: a bill reduced
 * by a credit note or absorbed by account credit was never owed in full, and
 * ageing it at its face value would invent receivables.
 */
import type { Ctx } from '../../kernel/context';
import { DAY } from '../../../shared/time';
import type { MonthCell } from './grid';
import { decimal2, ratio, type Decimal2, type Ratio } from './ratio';

export interface InvoiceRow {
  id: string;
  number: string;
  customer_id: string;
  subscription_id: string | null;
  currency: string;
  status: string;
  total: number;
  amount_due: number;
  amount_paid: number;
  due_date: number | null;
  finalized_at: number | null;
  paid_at: number | null;
  voided_at: number | null;
  marked_uncollectible_at: number | null;
  created: number;
}

/** What this bill asked for. Zero once a credit note or credit balance ate it. */
export const owedOn = (invoice: InvoiceRow): number =>
  invoice.amount_due + (invoice.paid_at !== null ? invoice.amount_paid : 0);

/** The instant a bill stopped being a receivable, whichever way it stopped. */
export const settledAt = (invoice: InvoiceRow): number | null =>
  invoice.paid_at ?? invoice.voided_at ?? invoice.marked_uncollectible_at ?? null;

export const dueAt = (invoice: InvoiceRow): number =>
  invoice.due_date ?? invoice.finalized_at ?? invoice.created;

export function outstandingAt(invoice: InvoiceRow, at: number): number {
  if (invoice.finalized_at === null || invoice.finalized_at > at) return 0;
  const settled = settledAt(invoice);
  if (settled !== null && settled <= at) return 0;
  return owedOn(invoice);
}

export const AGEING_BUCKETS = ['not_yet_due', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

const BUCKET_LABELS: Record<AgeingBucket, string> = {
  not_yet_due: 'Not yet due',
  d1_30: '1–30 days past due',
  d31_60: '31–60 days past due',
  d61_90: '61–90 days past due',
  d90_plus: 'Over 90 days past due',
};

export function bucketFor(invoice: InvoiceRow, at: number): AgeingBucket {
  const days = Math.floor((at - dueAt(invoice)) / DAY);
  if (days < 0) return 'not_yet_due';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'd90_plus';
}

export interface AgeingRow {
  bucket: AgeingBucket;
  label: string;
  invoices: number;
  amount: number;
  share: Ratio;
  oldest_due: number | null;
}

export interface Ageing {
  as_of: number;
  currency: string;
  total: number;
  invoices: number;
  buckets: AgeingRow[];
  past_due_total: number;
  past_due_share: Ratio;
  oldest_due: number | null;
}

export function ageBook(invoices: InvoiceRow[], at: number, currency: string): Ageing {
  const buckets = new Map<AgeingBucket, { invoices: number; amount: number; oldest: number | null }>();
  for (const bucket of AGEING_BUCKETS) buckets.set(bucket, { invoices: 0, amount: 0, oldest: null });
  let total = 0, count = 0, oldest: number | null = null;

  for (const invoice of invoices) {
    const amount = outstandingAt(invoice, at);
    if (amount === 0) continue;
    const bucket = buckets.get(bucketFor(invoice, at)) as { invoices: number; amount: number; oldest: number | null };
    bucket.invoices += 1;
    bucket.amount += amount;
    const due = dueAt(invoice);
    if (bucket.oldest === null || due < bucket.oldest) bucket.oldest = due;
    if (oldest === null || due < oldest) oldest = due;
    total += amount;
    count += 1;
  }

  const rows: AgeingRow[] = AGEING_BUCKETS.map((bucket) => {
    const cell = buckets.get(bucket) as { invoices: number; amount: number; oldest: number | null };
    return {
      bucket,
      label: BUCKET_LABELS[bucket],
      invoices: cell.invoices,
      amount: cell.amount,
      share: ratio(cell.amount, total),
      oldest_due: cell.oldest,
    };
  });
  const pastDue = rows.filter((row) => row.bucket !== 'not_yet_due').reduce((sum, row) => sum + row.amount, 0);

  return {
    as_of: at,
    currency,
    total,
    invoices: count,
    buckets: rows,
    past_due_total: pastDue,
    past_due_share: ratio(pastDue, total),
    oldest_due: oldest,
  };
}

/* -------------------------------- dunning --------------------------------- */

export interface RecoveryReport {
  /** Open campaigns: what is still being chased, right now. */
  at_risk: number;
  at_risk_campaigns: number;
  /** Campaigns that started inside the range, whichever way they ended. */
  campaigns_started: number;
  amount_at_risk: number;
  amount_recovered: number;
  recovery_rate: Ratio;
  by_status: { status: string; campaigns: number; amount_at_risk: number; amount_recovered: number }[];
  attempts: { outcome: string; attempts: number }[];
  attempt_success_rate: Ratio;
  give_ups: number;
  /** The decline codes doing the damage, worst first. */
  top_failure_codes: { code: string; campaigns: number; amount: number }[];
}

export function recoveryReport(ctx: Ctx, orgId: string, from: number, to: number): RecoveryReport {
  const open = ctx.db.get<{ campaigns: number; amount: number }>(
    `SELECT COUNT(*) AS campaigns, COALESCE(SUM(amount_at_risk - recovered_amount), 0) AS amount
       FROM payments_dunning WHERE org_id = ? AND status = 'recovering'`,
    orgId,
  ) ?? { campaigns: 0, amount: 0 };

  const byStatus = ctx.db.all<{ status: string; campaigns: number; at_risk: number; recovered: number }>(
    `SELECT status, COUNT(*) AS campaigns,
            COALESCE(SUM(amount_at_risk), 0) AS at_risk,
            COALESCE(SUM(recovered_amount), 0) AS recovered
       FROM payments_dunning
      WHERE org_id = ? AND started_at >= ? AND started_at < ?
      GROUP BY status ORDER BY status`,
    orgId, from, to,
  );

  const attempts = ctx.db.all<{ outcome: string; attempts: number }>(
    `SELECT outcome, COUNT(*) AS attempts FROM payments_dunning_attempts
      WHERE org_id = ? AND attempted_at >= ? AND attempted_at < ?
      GROUP BY outcome ORDER BY outcome`,
    orgId, from, to,
  );

  const codes = ctx.db.all<{ code: string; campaigns: number; amount: number }>(
    `SELECT last_failure_code AS code, COUNT(*) AS campaigns,
            COALESCE(SUM(amount_at_risk - recovered_amount), 0) AS amount
       FROM payments_dunning
      WHERE org_id = ? AND last_failure_code IS NOT NULL AND started_at >= ? AND started_at < ?
      GROUP BY last_failure_code ORDER BY amount DESC, campaigns DESC LIMIT 8`,
    orgId, from, to,
  );

  const atRisk = byStatus.reduce((sum, row) => sum + Number(row.at_risk), 0);
  const recovered = byStatus.reduce((sum, row) => sum + Number(row.recovered), 0);
  const succeeded = attempts.find((row) => row.outcome === 'succeeded')?.attempts ?? 0;
  const made = attempts.filter((row) => row.outcome !== 'skipped').reduce((sum, row) => sum + Number(row.attempts), 0);

  return {
    at_risk: Number(open.amount),
    at_risk_campaigns: Number(open.campaigns),
    campaigns_started: byStatus.reduce((sum, row) => sum + Number(row.campaigns), 0),
    amount_at_risk: atRisk,
    amount_recovered: recovered,
    recovery_rate: ratio(recovered, atRisk),
    by_status: byStatus.map((row) => ({
      status: row.status,
      campaigns: Number(row.campaigns),
      amount_at_risk: Number(row.at_risk),
      amount_recovered: Number(row.recovered),
    })),
    attempts: attempts.map((row) => ({ outcome: row.outcome, attempts: Number(row.attempts) })),
    attempt_success_rate: ratio(Number(succeeded), made),
    give_ups: Number(byStatus.find((row) => row.status === 'exhausted')?.campaigns ?? 0),
    top_failure_codes: codes.map((row) => ({
      code: row.code, campaigns: Number(row.campaigns), amount: Number(row.amount),
    })),
  };
}

/* ------------------------------- the series ------------------------------- */

export interface CollectionsRow {
  month: string;
  period: { start: number; end: number };
  complete: boolean;
  currency: string;
  /** Billings raised in the month: what the bills finalised in it asked for. */
  billed: number;
  /** Cash that landed in the month, whichever month the bill was raised in. */
  collected: number;
  /**
   * Of the bills raised in this month, how much has been collected since. This
   * is the honest collection rate: comparing cash in a month against billings
   * in the same month reads over 100% whenever long-dated terms land, which
   * says nothing about whether anyone paid.
   */
  collected_on_billings: number;
  credited: number;
  written_off: number;
  /** Receivables outstanding at the close of the month. */
  outstanding: number;
  past_due: number;
  collection_rate: Ratio;
}

export interface CollectionsReport {
  rows: CollectionsRow[];
  ageing: Ageing;
  recovery: RecoveryReport;
  totals: {
    billed: number;
    collected: number;
    collected_on_billings: number;
    credited: number;
    written_off: number;
    outstanding: number;
    past_due: number;
    collection_rate: Ratio;
    /** Days sales outstanding across the range, on the classic formula. */
    dso: Decimal2;
    dso_basis: string;
    days_in_range: number;
    currency: string;
  };
}

export interface CollectionsInput {
  invoices: InvoiceRow[];
  creditNotes: { created: number; total: number }[];
  cells: MonthCell[];
  from: number;
  to: number;
  currency: string;
  recovery: RecoveryReport;
}

export function collectionsReport(input: CollectionsInput): CollectionsReport {
  const { invoices, creditNotes, cells, from, to, currency } = input;
  const rows: CollectionsRow[] = cells.map((cell) => {
    let billed = 0, collected = 0, collectedOnBillings = 0, writtenOff = 0, credited = 0;
    for (const invoice of invoices) {
      const owed = owedOn(invoice);
      if (invoice.finalized_at !== null && invoice.finalized_at >= cell.start && invoice.finalized_at < cell.end) {
        billed += owed;
        collectedOnBillings += invoice.paid_at !== null ? invoice.amount_paid : 0;
      }
      if (invoice.paid_at !== null && invoice.paid_at >= cell.start && invoice.paid_at < cell.end) collected += invoice.amount_paid;
      if (invoice.marked_uncollectible_at !== null && invoice.marked_uncollectible_at >= cell.start && invoice.marked_uncollectible_at < cell.end) {
        writtenOff += owed;
      }
    }
    for (const note of creditNotes) {
      if (note.created >= cell.start && note.created < cell.end) credited += note.total;
    }
    const aged = ageBook(invoices, cell.at, currency);
    return {
      month: cell.key,
      period: { start: cell.start, end: cell.end },
      complete: cell.complete,
      currency,
      billed,
      collected,
      collected_on_billings: collectedOnBillings,
      credited,
      written_off: writtenOff,
      outstanding: aged.total,
      past_due: aged.past_due_total,
      collection_rate: ratio(collectedOnBillings, billed),
    };
  });

  const ageing = ageBook(invoices, to, currency);
  const billed = rows.reduce((sum, row) => sum + row.billed, 0);
  const collected = rows.reduce((sum, row) => sum + row.collected, 0);
  const collectedOnBillings = rows.reduce((sum, row) => sum + row.collected_on_billings, 0);
  const days = Math.max(1, Math.round((to - from) / DAY));

  return {
    rows,
    ageing,
    recovery: input.recovery,
    totals: {
      billed,
      collected,
      collected_on_billings: collectedOnBillings,
      credited: rows.reduce((sum, row) => sum + row.credited, 0),
      written_off: rows.reduce((sum, row) => sum + row.written_off, 0),
      outstanding: ageing.total,
      past_due: ageing.past_due_total,
      collection_rate: ratio(collectedOnBillings, billed),
      dso: decimal2(ageing.total * days, billed),
      dso_basis:
        `Receivables outstanding at the end of the range (${ageing.total} minor units) divided by everything billed ` +
        `inside it (${billed}), times the ${days} days the range covers. Both figures are "amount_due + amount_paid", ` +
        'so a bill reduced by a credit note ages at what it actually asked for.',
      days_in_range: days,
      currency,
    },
  };
}
