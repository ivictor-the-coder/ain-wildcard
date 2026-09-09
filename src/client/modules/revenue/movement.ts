/**
 * MRR movement as the board classifies it — one place, shared by the
 * waterfall, the "nothing moved" test, the table and the export.
 *
 * The reporting endpoint's basis names seven movement classes: new,
 * expansion, reactivation and resumed add to the book; contraction, churn and
 * paused take from it. A collection pause is not churn — the contract is
 * intact — so it has a bucket of its own, and a client that drops that bucket
 * draws bars that do not reach their own closing balance while the badge
 * beside them says "Reconciled". Every function here carries all seven.
 *
 * Pure: no React, no design system, so the arithmetic the screen shows can be
 * checked against the API's own reconciliation in a unit test.
 */
import type { WaterfallInput } from '../../design';
import { csvAmount, type CsvColumn } from './csv';
import type { MovementMonth, Mover } from './types';

/** The classes in the order the waterfall walks them: inflows, then outflows. */
export const INFLOW_KINDS = ['new', 'expansion', 'reactivation', 'resumed'] as const;
export const OUTFLOW_KINDS = ['contraction', 'churn', 'paused'] as const;

const zero = (value: number | null | undefined): number => value ?? 0;

/**
 * Contraction, churn and paused come back as magnitudes — the amount lost,
 * stated positively — so they are negated here. A waterfall drawn from the raw
 * response climbs on churn. `|| 0` normalises negative zero: a month with no
 * contraction would otherwise label its bar "-$0".
 */
export function waterfallOf(month: MovementMonth): WaterfallInput[] {
  return [
    { label: 'Opening', value: zero(month.opening), kind: 'total' },
    { label: 'New', value: zero(month.new_business) },
    { label: 'Expansion', value: zero(month.expansion) },
    { label: 'Reactivation', value: zero(month.reactivation) },
    { label: 'Resumed', value: zero(month.resumed) },
    { label: 'Contraction', value: -zero(month.contraction) || 0 },
    { label: 'Churn', value: -zero(month.churn) || 0 },
    { label: 'Paused', value: -zero(month.paused) || 0 },
    { label: 'Closing', value: zero(month.closing), kind: 'total' },
  ];
}

/**
 * Opening plus every classified movement, as the client re-derives it. The
 * API reconciles the same sum server-side; this is what lets a screen prove it
 * drew every class rather than trust that it did.
 */
export function walkedClosing(month: MovementMonth): number {
  return zero(month.opening)
    + zero(month.new_business) + zero(month.expansion) + zero(month.reactivation) + zero(month.resumed)
    - zero(month.contraction) - zero(month.churn) - zero(month.paused);
}

/** Did anything at all happen to the book in this month — a pause included? */
export const monthMoved = (m: MovementMonth): boolean =>
  zero(m.new_business) + zero(m.expansion) + zero(m.reactivation) + zero(m.resumed)
    + zero(m.contraction) + zero(m.churn) + zero(m.paused) > 0;

/** What a month with no movement did not see, in the words the banner uses. */
export const NOTHING_MOVED = 'No account started, grew, shrank, paused, resumed or left in this month.';

export const movementCsv = (currency: string): CsvColumn<MovementMonth>[] => [
  { header: 'Month', value: (row) => row.month },
  { header: 'Currency', value: () => currency.toUpperCase() },
  { header: 'Opening', value: (row) => csvAmount(row.opening, currency) },
  { header: 'New', value: (row) => csvAmount(row.new_business, currency) },
  { header: 'Expansion', value: (row) => csvAmount(row.expansion, currency) },
  { header: 'Reactivation', value: (row) => csvAmount(row.reactivation, currency) },
  { header: 'Resumed', value: (row) => csvAmount(row.resumed, currency) },
  { header: 'Contraction', value: (row) => csvAmount(row.contraction === null ? null : -row.contraction, currency) },
  { header: 'Churn', value: (row) => csvAmount(row.churn === null ? null : -row.churn, currency) },
  { header: 'Paused', value: (row) => csvAmount(row.paused === null ? null : -row.paused, currency) },
  { header: 'Net', value: (row) => csvAmount(row.net, currency) },
  { header: 'Closing', value: (row) => csvAmount(row.closing, currency) },
  { header: 'Accounts at open', value: (row) => row.counts.accounts_at_open },
  { header: 'Accounts at close', value: (row) => row.counts.accounts_at_close },
  { header: 'Complete month', value: (row) => (row.complete ? 'yes' : 'no') },
  { header: 'Reconciled', value: (row) => (row.reconciliation.balanced ? 'yes' : 'no') },
];

export type MoverTone = 'success' | 'danger' | 'brand' | 'warning' | 'neutral';

/** A pause is amber, not red: the money stopped, the contract did not. */
export const MOVER_TONE: Record<string, MoverTone> = {
  new: 'brand',
  expansion: 'success',
  reactivation: 'success',
  resumed: 'success',
  contraction: 'danger',
  churn: 'danger',
  paused: 'warning',
};

/**
 * The mover's amount with the sign its class implies. The API states
 * contraction and churn as magnitudes and a pause as a negative delta; the
 * screen states every outflow as negative and every inflow as positive.
 */
export function moverDelta(mover: Pick<Mover, 'kind' | 'amount'>): number {
  const size = Math.abs(mover.amount);
  return (OUTFLOW_KINDS as readonly string[]).includes(mover.kind) ? -size || 0 : size;
}
