/**
 * The burn-down card's arithmetic, and the one list every credit write
 * invalidates.
 *
 * `GET /v1/revenue/usage` answers the same question two ways. `totals.charged`
 * and `totals.credit_covered` count only the lines that have reached a
 * finalised invoice — zero on a fresh workspace, where the settled period is
 * still waiting for its bill — while `totals.settled` is what the settlement
 * ledger priced when each window closed, and `totals.unbilled` is the part of
 * that charge no bill carries yet. The card that says what usage was worth and
 * who paid for it has to read the second set: the first is a statement about
 * invoicing, not about usage, and printing it under "Covered by credit" beside
 * a meter line reading "88.56% charged" was a screen contradicting itself.
 *
 * Everything here is pure so a unit test can hand it the API's own response.
 */
import type { RevenueUsage, UsageMonth } from './types';

/**
 * What a credit write changes on screen: the grants and their ledger, the
 * outbox of pending lines, the settlements, the overview tiles and the
 * burn-down. Every mutation on the credits screen invalidates all of them —
 * the cost of re-reading a list that did not move is a round trip; the cost of
 * not re-reading one that did was a "Credit bought" figure two packs behind.
 */
export const CREDIT_WRITE_INVALIDATES: readonly string[] = [
  '/v1/credit-grants',
  '/v1/credit-ledger',
  '/v1/credit-billable-items',
  '/v1/credit-settlements',
  '/v1/credits/overview',
  '/v1/revenue/usage',
];

export interface BurnDownFigures {
  /** Windows closed in the range, at the value they priced at. */
  metered: number;
  /** Absorbed by prepaid credit when the windows were priced. */
  covered: number;
  /** Charged when the windows were priced, before any true-up. */
  charged: number;
  /** Late arrivals and withdrawals since, signed. */
  trueUps: number;
  /** `charged + trueUps`: what the customer owes for the windows. */
  owed: number;
  /** The part of `owed` on a finalised invoice, at the amount the invoice carries. */
  invoiced: number;
  /** The part of `owed` no finalised invoice carries yet. */
  unbilled: number;
  purchased: number;
  purchaseLines: number;
  settlements: number;
}

export function burnDownFigures(usage: RevenueUsage): BurnDownFigures {
  const settled = usage.totals.settled;
  return {
    metered: usage.totals.metered_value ?? 0,
    covered: settled.credit_covered,
    charged: settled.charged,
    trueUps: settled.true_ups,
    owed: settled.net_charged,
    invoiced: settled.invoiced,
    unbilled: usage.totals.unbilled,
    purchased: usage.credit.purchased ?? 0,
    purchaseLines: usage.credit.purchase_lines,
    settlements: usage.totals.settlements,
  };
}

/** Covered plus charged is the metered value — the identity the first check asserts. */
export const splitReconciles = (figures: BurnDownFigures): boolean =>
  figures.covered + figures.charged === figures.metered;

/** `numerator / denominator` to two places, as the API prints its own rates; null over nothing. */
export function shareText(numerator: number, denominator: number): string | null {
  if (!denominator) return null;
  return `${((numerator / denominator) * 100).toFixed(2)}%`;
}

/**
 * What the chart can honestly draw. Its series are the covered and charged
 * lines on invoices finalised each month; a month whose settled usage has not
 * been billed has a metered value and nothing else, and a chart of it is five
 * "$0.01" gridlines over an empty plot.
 */
export type BurnDownChart =
  | { state: 'nothing_metered' }
  | { state: 'nothing_invoiced'; unbilled: number }
  | { state: 'draw'; months: UsageMonth[] };

const meteredIn = (month: UsageMonth): boolean =>
  (month.metered_value ?? 0) > 0 || (month.credit_covered ?? 0) > 0 || (month.charged ?? 0) > 0;
const invoicedIn = (month: UsageMonth): boolean =>
  (month.credit_covered ?? 0) > 0 || (month.charged ?? 0) > 0;

export function burnDownChart(usage: RevenueUsage): BurnDownChart {
  const months = usage.series.filter(meteredIn);
  if (months.length === 0) return { state: 'nothing_metered' };
  if (!months.some(invoicedIn)) return { state: 'nothing_invoiced', unbilled: usage.totals.unbilled };
  return { state: 'draw', months };
}

/**
 * Each reconciliation the report ran, said as what it checked. The banner
 * used to say "covered plus charged equals the metered value, and the
 * ledger's own components equal its balance" for six checks, four of which
 * were about something else.
 */
export const CHECK_LABEL: Record<string, string> = {
  settlement_components_match: 'covered plus charged equals the metered value on every settlement',
  invoice_lines_carry_the_settled_amount: 'every charge that reached a finalised invoice is carried at the amount the settlement said',
  every_metered_line_has_a_settlement: 'every metered invoice line names the settlement behind it',
  credit_flow_components_sum_to_movement: 'the credit ledger’s named movements add up to its balance',
  ledger_agrees_with_its_grants: 'the ledger agrees with the grants it belongs to',
  every_grant_kind_is_reported: 'every kind of grant is reported',
};

export const checkPhrase = (name: string): string =>
  CHECK_LABEL[name] ?? name.replace(/_/g, ' ');

export function checkPhrases(checks: { name: string; ok: boolean }[]): { passed: string[]; failed: string[] } {
  return {
    passed: checks.filter((check) => check.ok).map((check) => checkPhrase(check.name)),
    failed: checks.filter((check) => !check.ok).map((check) => checkPhrase(check.name)),
  };
}

/**
 * A ledger reason as the server writes it names calendar days as ISO strings
 * ("Expired unused on 2026-08-31"). Those are boundaries — midnight UTC by
 * construction — so each is rewritten through the caller's boundary formatter
 * rather than the timezone-shifting instant one.
 */
export function formatReasonDates(reason: string, formatDay: (utcMidnight: number) => string): string {
  return reason.replace(/\b(\d{4})-(\d{2})-(\d{2})(?:T[0-9:.]+Z)?\b/g, (_match, y: string, m: string, d: string) =>
    formatDay(Date.UTC(Number(y), Number(m) - 1, Number(d))));
}

/**
 * What to call a ledger movement. A `refund` written by a true-up is units
 * going back onto the grant because the usage they paid for was withdrawn —
 * not money going back to the customer, which is what "Refund" says.
 */
export function movementLabel(entry: { type: string; ref_type: string | null }): string {
  if (entry.type === 'refund' && entry.ref_type === 'credit_true_up') return 'True-up return';
  return entry.type.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * A grant's state in the word the credits screen means by it.
 *
 * `exhausted` is one wire word doing two jobs. On a dunning campaign it means
 * the schedule ran out of attempts and stopped chasing, which the product
 * calls "Given up" — and the kit's one lifecycle map, quite correctly, gives
 * that word to every `exhausted` it is handed. A credit grant reaches the
 * same wire value by the opposite route: the customer used every unit of a
 * pack they paid for. A prepaid pack drawn to zero rendered as a red "Given
 * up" pill, over a caption counting "1 given up", beside a drawer stat
 * reading "Exhausted" — three words, one of them accusing the customer of
 * abandoning a bill they had already paid.
 *
 * So the grant's state is translated to a word of its own before the kit
 * renders it: `spent` is not in the kit's map, so `statusLabel` humanises it
 * to "Spent" and the shared ramp paints it neutral, which is what a fully
 * drawn pack is — finished, not failed. The kit still owns the label and the
 * tone; this only decides which word it is asked about, so the pill, the
 * caption, the filter and the drawer cannot drift apart again.
 *
 * The kit edit that retires this: give `statusLabel`/`statusTone` an optional
 * scope, `credit_grant`, mapping `exhausted` to "Spent"/neutral, and pass it
 * from `<StatusPill>`.
 */
export const grantStatusWord = (status: string): string => (status === 'exhausted' ? 'spent' : status);
