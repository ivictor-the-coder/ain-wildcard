/**
 * The revenue board — the screen a finance lead opens on Monday.
 *
 * Everything here is read from the reporting endpoints at render time, and
 * every block carries the `basis` string the API computed it under. Where the
 * platform can tell that a figure would be wrong — a month whose movements do
 * not add up to its closing balance — this screen says so and refuses to draw
 * the bar, which is the whole reason the reconciliation exists.
 */
import { useCallback, useMemo, useState } from 'react';
import { useQuery, type ListEnvelope } from '../../kernel/api';
import { useNavigate, useSearchParam } from '../../kernel/router';
import {
  Badge, Banner, Button, Card, DataTable, Drawer, EmptyState, Grid, Icons, Inline, LineChart, Page, Section,
  SegmentedControl, Skeleton, Stack, Stat, Tooltip, WaterfallChart, formatNumber, humanize,
  toMajorUnits, useFormat, waterfallLayout,
  type DataTableColumn, type SortState, type WaterfallInput,
} from '../../design';
import {
  BasisNote, ChartSkeleton, CurrencyControl, EmptyBody, ExportCsvButton, NotePopover, RangeControl,
  ReconciliationBadge, RefreshingChip, SectionError, Stale, boundaryDate, csvAmount,
  csvDay, moneyAxis, monthLabel, moneyIn, rateFraction, rateText, ratioText, signedMoneyIn,
  useDefaultCurrency, useRevenueRange, useSticky, useTabParam, useUrlTableState, visibleRows,
  type CsvColumn, type RevenueRange, type Sticky,
} from './common';
import type {
  OpenInvoice, RevenueAccountRow, RevenueChurn, RevenueCohorts, RevenueCollections, RevenueMovement,
  RevenueMrr, RevenueSummary, MovementMonth, Mover, AgeingBucket,
} from './types';

const DAY_MS = 86_400_000;

/** The book opens biggest-first; the URL overrides it once anyone sorts. */
const ACCOUNTS_SORT: SortState = { columnId: 'mrr', direction: 'desc' };

/**
 * The same rule the reporting endpoint ages the book by, restated here so a
 * bucket can be opened and the invoices inside it named. `dueAt` falls back to
 * the day a bill was finalised when it carries no due date — due on receipt.
 */
const dueAt = (invoice: OpenInvoice): number =>
  invoice.due_date ?? invoice.finalized_at ?? invoice.created;

const settledAt = (invoice: OpenInvoice): number | null =>
  invoice.paid_at ?? invoice.voided_at ?? invoice.marked_uncollectible_at ?? null;

/** What this bill still asks for at `at`. Zero once it stopped being a receivable. */
const outstandingAt = (invoice: OpenInvoice, at: number): number => {
  if (invoice.finalized_at === null || invoice.finalized_at > at) return 0;
  const settled = settledAt(invoice);
  if (settled !== null && settled <= at) return 0;
  return invoice.amount_due + (invoice.paid_at !== null ? invoice.amount_paid : 0);
};

const bucketFor = (invoice: OpenInvoice, at: number): string => {
  const days = Math.floor((at - dueAt(invoice)) / DAY_MS);
  if (days < 0) return 'not_yet_due';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'd90_plus';
};

/* ------------------------------ movement bars ----------------------------- */

/**
 * Contraction and churn come back as magnitudes — the amount lost, stated
 * positively — so they are negated here. A waterfall drawn from the raw
 * response climbs on churn.
 */
function waterfallOf(month: MovementMonth): WaterfallInput[] {
  return [
    { label: 'Opening', value: month.opening ?? 0, kind: 'total' },
    { label: 'New', value: month.new_business ?? 0 },
    { label: 'Expansion', value: month.expansion ?? 0 },
    { label: 'Reactivation', value: month.reactivation ?? 0 },
    // `|| 0` normalises negative zero: a month with no contraction would
    // otherwise label its bar "-$0".
    { label: 'Contraction', value: -(month.contraction ?? 0) || 0 },
    { label: 'Churn', value: -(month.churn ?? 0) || 0 },
    { label: 'Closing', value: month.closing ?? 0, kind: 'total' },
  ];
}

/** Did anything at all happen to the book in this month? */
const monthMoved = (m: MovementMonth): boolean =>
  (m.new_business ?? 0) + (m.expansion ?? 0) + (m.reactivation ?? 0) + (m.contraction ?? 0) + (m.churn ?? 0) > 0;

const movementCsv = (currency: string): CsvColumn<MovementMonth>[] => [
  { header: 'Month', value: (row) => row.month },
  { header: 'Currency', value: () => currency.toUpperCase() },
  { header: 'Opening', value: (row) => csvAmount(row.opening, currency) },
  { header: 'New', value: (row) => csvAmount(row.new_business, currency) },
  { header: 'Expansion', value: (row) => csvAmount(row.expansion, currency) },
  { header: 'Reactivation', value: (row) => csvAmount(row.reactivation, currency) },
  { header: 'Contraction', value: (row) => csvAmount(row.contraction === null ? null : -row.contraction, currency) },
  { header: 'Churn', value: (row) => csvAmount(row.churn === null ? null : -row.churn, currency) },
  { header: 'Net', value: (row) => csvAmount(row.net, currency) },
  { header: 'Closing', value: (row) => csvAmount(row.closing, currency) },
  { header: 'Accounts at open', value: (row) => row.counts.accounts_at_open },
  { header: 'Accounts at close', value: (row) => row.counts.accounts_at_close },
  { header: 'Complete month', value: (row) => (row.complete ? 'yes' : 'no') },
  { header: 'Reconciled', value: (row) => (row.reconciliation.balanced ? 'yes' : 'no') },
];

const MOVER_TONE: Record<string, 'success' | 'danger' | 'brand' | 'neutral'> = {
  new: 'brand', expansion: 'success', reactivation: 'success', contraction: 'danger', churn: 'danger',
};

/* ---------------------------------- page ---------------------------------- */

export function RevenueBoardPage() {
  const f = useFormat();
  const navigate = useNavigate();
  const defaultCurrency = useDefaultCurrency();
  const range = useRevenueRange(defaultCurrency);

  // Unscoped: the only read that can say which books exist, because every
  // scoped read has already narrowed to one of them.
  //
  // Every scoped read is sticky: changing the range or the currency changes the
  // request URL, and blanking eight tiles to skeletons on the most frequent
  // interaction of the screen is worse than showing the previous answer dimmed
  // for a moment.
  const currency = range.currency;
  const books = useSticky(useQuery<RevenueMrr>('/v1/revenue/mrr', { months: range.months }));
  const summary = useSticky(useQuery<RevenueSummary>('/v1/revenue/summary', range.query), currency);
  const mrr = useSticky(useQuery<RevenueMrr>('/v1/revenue/mrr', range.query), currency);
  const movement = useSticky(useQuery<RevenueMovement>('/v1/revenue/movement', { ...range.query, top_movers: 6 }), currency);
  const churn = useSticky(useQuery<RevenueChurn>('/v1/revenue/churn', range.query), currency);
  const cohorts = useSticky(useQuery<RevenueCohorts>('/v1/revenue/cohorts', range.query), currency);
  const collections = useSticky(useQuery<RevenueCollections>('/v1/revenue/collections', range.query), currency);
  const accounts = useSticky(useQuery<ListEnvelope<RevenueAccountRow>>('/v1/revenue/accounts', { ...range.query, limit: 200 }), currency);
  const refreshing = summary.stale || mrr.stale || movement.stale || churn.stale || collections.stale;

  const head = summary.data?.headline;
  const series = mrr.data?.series ?? [];
  const latest = series[series.length - 1];
  const previous = series[series.length - 2];
  const mrrDelta = latest?.mrr != null && previous?.mrr ? (latest.mrr - previous.mrr) / previous.mrr : null;
  const spark = useMemo(
    () => series.map((point) => toMajorUnits(point.mrr ?? 0, currency)),
    [series, currency],
  );

  const unbalanced = movement.data?.unbalanced_months ?? [];
  const balanced = summary.data ? summary.data.balanced : true;

  return (
    <Page
      title="Revenue"
      eyebrow="Insights"
      subtitle="Recurring revenue, how it moved, what it retains and what is still owed — each figure with the basis it was computed on."
      actions={
        <Inline gap={3} wrap>
          <RefreshingChip stale={refreshing} />
          <RangeControl range={range} />
          <CurrencyControl range={range} scope={books.data?.basis.currency} />
        </Inline>
      }
    >
      <Stack gap={7}>
        {books.data && books.data.basis.currency.mode === 'mixed' && (
          <Banner
            tone="info"
            compact
            title={`This workspace bills in ${f.list(books.data.basis.currency.currencies.map((c) => c.toUpperCase()))}`}
            actions={(
              <NotePopover label="Why nothing is converted" title="The multi-currency basis">
                {books.data.basis.currency.note}
              </NotePopover>
            )}
          >
            No figure on this page is converted between currencies, and nothing is added across them. Pick a book below —
            every number on the screen is then a real {range.currency.toUpperCase()} amount.
          </Banner>
        )}

        {!balanced && (
          <Banner tone="danger" title="A figure on this page does not reconcile">
            {unbalanced.length
              ? `Opening plus movements does not equal closing in ${f.list(unbalanced.map((m) => monthLabel(m, f, true)))}. Those months are named below and their waterfall is withheld rather than drawn wrong.`
              : 'One of the reconciliations behind these figures failed. The affected block says so where it is drawn.'}
          </Banner>
        )}

        {(summary.data?.warnings ?? []).map((warning) => (
          <Banner tone="warning" compact key={warning}>{warning}</Banner>
        ))}

        <BooksStrip books={books} range={range} />

        {summary.error && <Card><SectionError error={summary.error} path="GET /v1/revenue/summary" onRetry={summary.refetch} /></Card>}
        {!summary.error && !summary.data && (
          <div className="rv-tiles">{[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <Card key={i} padding="tight"><Skeleton height={76} /></Card>)}</div>
        )}

        {head && summary.data && (
          <Stale stale={refreshing}>
          <div className="rv-tiles">
            <Card padding="tight" className="rv-tile">
              <span className="rv-tile__basis"><BasisNote basis={mrr.data?.basis} sources={mrr.data?.sources} label="How MRR was computed" /></span>
              <Stat
                label="Monthly recurring revenue"
                value={moneyIn(f, head.mrr, currency)}
                delta={mrrDelta}
                sparkline={spark.length > 1 ? spark : undefined}
                caption={`${moneyIn(f, head.arr, currency)} a year · ${f.plural(head.accounts, 'account')}`}
              />
            </Card>
            <Card padding="tight" className="rv-tile">
              <span className="rv-tile__basis"><BasisNote basis={movement.data?.basis} sources={movement.data?.sources} label="How movement was computed" /></span>
              <Stat
                label="Net new MRR this month"
                value={signedMoneyIn(f, head.net_new_mrr_this_month, currency)}
                caption={(() => {
                  const current = movement.data?.series[movement.data.series.length - 1];
                  if (!current) return 'The month in progress';
                  return `${monthLabel(current.month, f, true)}, ${current.complete ? 'closed' : 'still running'}`;
                })()}
              />
            </Card>
            <Card padding="tight" className="rv-tile">
              <span className="rv-tile__basis"><BasisNote basis={churn.data?.basis} sources={churn.data?.sources} label="How retention was computed" /></span>
              <Stat
                label="Net revenue retention"
                value={rateText(head.net_revenue_retention)}
                caption={head.net_revenue_retention
                  ? `${moneyIn(f, head.net_revenue_retention.numerator, currency)} kept of ${moneyIn(f, head.net_revenue_retention.denominator, currency)} exposed`
                  : 'No exposed revenue in this window'}
              />
            </Card>
            <Card padding="tight" className="rv-tile">
              <span className="rv-tile__basis"><BasisNote basis={churn.data?.basis} sources={churn.data?.sources} label="How retention was computed" /></span>
              <Stat
                label="Gross revenue retention"
                value={rateText(head.gross_revenue_retention)}
                caption={`Logo churn ${rateText(head.logo_churn)} over ${f.plural(head.logo_churn.denominator, 'account-month')}`}
              />
            </Card>
            <Card padding="tight" className="rv-tile">
              <span className="rv-tile__basis"><BasisNote basis={collections.data?.basis} sources={collections.data?.sources} label="How receivables were computed" /></span>
              <Stat
                label="Receivables"
                value={moneyIn(f, head.receivables, currency)}
                caption={`${moneyIn(f, head.past_due, currency)} past due`}
              />
            </Card>
            <Card padding="tight" className="rv-tile">
              <span className="rv-tile__basis"><BasisNote basis={collections.data?.basis} sources={collections.data?.sources} label="How DSO was computed" /></span>
              <Stat
                label="Days sales outstanding"
                value={ratioText(head.dso)}
                caption={collections.data?.totals.dso_basis ? `Over ${f.plural(collections.data.totals.days_in_range, 'day')} of billings` : 'Days'}
              />
            </Card>
            <Card padding="tight" className="rv-tile">
              <span className="rv-tile__basis"><BasisNote basis={summary.data.basis} sources={summary.data.sources} label="How deferred revenue was computed" /></span>
              <Stat
                label="Deferred balance"
                value={moneyIn(f, head.deferred_balance, currency)}
                caption="Invoiced, not yet recognised"
              />
            </Card>
            <Card padding="tight" className="rv-tile">
              <span className="rv-tile__basis"><BasisNote basis={summary.data.basis} sources={summary.data.sources} label="How the usage share was computed" /></span>
              <Stat
                label="Overage share of invoiced"
                value={rateText(head.overage_share)}
                /* The caption states the division behind the rate rather than
                   an unrelated figure that happens to be nearby. */
                caption={head.overage_share && !head.overage_share.undefined_rate
                  ? `${moneyIn(f, head.overage_share.numerator, currency)} of ${moneyIn(f, head.overage_share.denominator, currency)} invoiced`
                  : 'Nothing metered has been invoiced in this window'}
              />
            </Card>
          </div>
          </Stale>
        )}

        <MovementSection movement={movement} range={range} />
        <RetentionSection churn={churn} cohorts={cohorts} range={range} />
        <ReceivablesSection collections={collections} range={range} />

        <Section
          title="Accounts by size"
          description="Every account carrying recurring revenue now or last month, ranked inside its own currency."
        >
          <Card padding="none">
            <AccountsTable accounts={accounts} currency={currency} onOpen={(row) => navigate(`/billing/customers/${row.customer}`)} />
          </Card>
        </Section>

        {mrr.data && (
          <div className="rv-cols">
            <Section title="Cadence mix" description="What the book is contracted on, normalised to a month.">
              <Card>
                <Stack gap={4}>
                  {mrr.data.by_cadence.length === 0 && <span className="rv-sub">No recurring subscriptions in this book.</span>}
                  {mrr.data.by_cadence.map((row) => (
                    <div className="rv-row" key={`${row.currency}-${row.interval}-${row.interval_count}`}>
                      <div className="rv-row__main">
                        <div className="rv-row__title">
                          {row.interval_count === 1 ? `Every ${row.interval}` : `Every ${row.interval_count} ${row.interval}s`}
                        </div>
                        <div className="rv-row__sub">{f.plural(row.subscriptions, 'subscription')} · {rateText(row.share)} of MRR</div>
                      </div>
                      <div className="rv-row__aside">{moneyIn(f, row.mrr, row.currency)}</div>
                    </div>
                  ))}
                </Stack>
              </Card>
            </Section>
            <Section title="Contracted but not recognised" description={mrr.data.not_yet_revenue.note}>
              <Card>
                <Grid minColumnWidth={140} gap={5}>
                  <Stat size="sm" label="Trialling" value={moneyIn(f, mrr.data.not_yet_revenue.trialing_mrr, currency)} caption={f.plural(mrr.data.not_yet_revenue.trialing_subscriptions, 'subscription')} />
                  <Stat size="sm" label="Paused" value={moneyIn(f, mrr.data.not_yet_revenue.paused_mrr, currency)} caption={f.plural(mrr.data.not_yet_revenue.paused_subscriptions, 'subscription')} />
                  <Stat size="sm" label="Usage run-rate" value={moneyIn(f, mrr.data.usage.run_rate, currency)} caption="Mean of the last 3 complete months" />
                </Grid>
              </Card>
            </Section>
          </div>
        )}
      </Stack>
    </Page>
  );
}

/* ------------------------------- books strip ------------------------------ */

function BooksStrip({ books, range }: { books: Sticky<RevenueMrr>; range: RevenueRange }) {
  const f = useFormat();
  if (books.error) return <Card><SectionError error={books.error} path="GET /v1/revenue/mrr" onRetry={books.refetch} /></Card>;
  if (!books.data) return <Skeleton height={64} />;
  const rows = books.data.by_currency;
  if (rows.length <= 1) return null;
  return (
    <div className="rv-books" role="group" aria-label="Books by currency">
      {rows.map((row) => (
        <button
          type="button"
          key={row.currency}
          className={`rv-book${row.currency === range.currency ? ' is-active' : ''}`}
          aria-pressed={row.currency === range.currency}
          onClick={() => range.setCurrency(row.currency)}
        >
          <span className="rv-book__code">{row.currency.toUpperCase()} book</span>
          <span className="rv-book__amount">{moneyIn(f, row.mrr, row.currency)}</span>
          <span className="rv-book__meta">{f.plural(row.accounts, 'account')} · {moneyIn(f, row.arr, row.currency)} a year</span>
        </button>
      ))}
    </div>
  );
}

/* ------------------------------- movement --------------------------------- */

function MovementSection({ movement, range }: { movement: Sticky<RevenueMovement>; range: RevenueRange }) {
  const f = useFormat();
  const navigate = useNavigate();
  const [monthParam, setMonthParam] = useSearchParam('month');
  const data = movement.data;
  const months = data?.series ?? [];
  const latest = months[months.length - 1];
  // The default is the calendar's latest month, always — a board that quietly
  // opens seven months in the past next to a tile reading "this month" is
  // telling two different stories about what "now" is. The last month that
  // actually moved is offered instead, in words, right where the empty
  // waterfall would otherwise be a mystery.
  const moved = [...months].reverse().find(monthMoved);
  const selectedMonth = months.some((m) => m.month === monthParam) ? monthParam : (latest?.month ?? '');
  const month = months.find((m) => m.month === selectedMonth);
  const stale = !!month && !monthMoved(month) && !!moved && moved.month !== month.month;
  // The strip is the contiguous tail of the window. A month picked from
  // outside it is prepended with a gap marker, so six chips never read as six
  // consecutive months when they are not.
  const monthChoices = useMemo(() => {
    const tail = months.slice(-6);
    if (!month || tail.some((m) => m.month === selectedMonth)) {
      return tail.map((m) => ({ value: m.month, label: monthLabel(m.month, f) }));
    }
    return [
      { value: month.month, label: monthLabel(month.month, f, true) },
      { value: '', label: '…', disabled: true, title: `Months between ${monthLabel(month.month, f, true)} and ${monthLabel(tail[0].month, f, true)} are not on the strip.` },
      ...tail.map((m) => ({ value: m.month, label: monthLabel(m.month, f) })),
    ];
  }, [months, selectedMonth, month, f]);

  const table = useUrlTableState('m', { columnId: 'month', direction: 'desc' });

  const columns: DataTableColumn<MovementMonth>[] = useMemo(() => [
    {
      id: 'month',
      header: 'Month',
      pinned: true,
      accessor: (row) => row.month,
      cell: (row) => (
        <div className="rv-cell">
          <span className="rv-cell__top">{monthLabel(row.month, f, true)}</span>
          <span className="rv-cell__sub">{row.complete ? `${row.counts.accounts_at_close} accounts at close` : 'In progress'}</span>
        </div>
      ),
      width: 180,
    },
    { id: 'opening', header: 'Opening', align: 'right', accessor: (row) => row.opening ?? 0, cell: (row) => <span className="rv-num">{moneyIn(f, row.opening, range.currency)}</span> },
    { id: 'new_business', header: 'New', align: 'right', accessor: (row) => row.new_business ?? 0, cell: (row) => (row.new_business ? <span className="rv-num rv-num--pos">{signedMoneyIn(f, row.new_business, range.currency)}</span> : <span className="rv-num rv-muted">—</span>) },
    { id: 'expansion', header: 'Expansion', align: 'right', accessor: (row) => row.expansion ?? 0, cell: (row) => (row.expansion ? <span className="rv-num rv-num--pos">{signedMoneyIn(f, row.expansion, range.currency)}</span> : <span className="rv-num rv-muted">—</span>) },
    { id: 'reactivation', header: 'Reactivation', align: 'right', accessor: (row) => row.reactivation ?? 0, cell: (row) => (row.reactivation ? <span className="rv-num rv-num--pos">{signedMoneyIn(f, row.reactivation, range.currency)}</span> : <span className="rv-num rv-muted">—</span>), defaultHidden: false },
    { id: 'contraction', header: 'Contraction', align: 'right', accessor: (row) => row.contraction ?? 0, cell: (row) => (row.contraction ? <span className="rv-num rv-num--neg">{signedMoneyIn(f, -row.contraction, range.currency)}</span> : <span className="rv-num rv-muted">—</span>) },
    { id: 'churn', header: 'Churn', align: 'right', accessor: (row) => row.churn ?? 0, cell: (row) => (row.churn ? <span className="rv-num rv-num--neg">{signedMoneyIn(f, -row.churn, range.currency)}</span> : <span className="rv-num rv-muted">—</span>) },
    { id: 'net', header: 'Net', align: 'right', accessor: (row) => row.net ?? 0, cell: (row) => <span className="rv-num">{signedMoneyIn(f, row.net, range.currency)}</span> },
    { id: 'closing', header: 'Closing', align: 'right', accessor: (row) => row.closing ?? 0, cell: (row) => <span className="rv-num">{moneyIn(f, row.closing, range.currency)}</span> },
    {
      id: 'reconciled',
      header: 'Reconciled',
      accessor: (row) => (row.reconciliation.balanced ? 'yes' : 'no'),
      filter: 'set',
      cell: (row) => (
        <Tooltip content={row.reconciliation.balanced
          ? `Computed closing ${moneyIn(f, row.reconciliation.computed_closing, range.currency)} equals the reported closing.`
          : `Computed ${moneyIn(f, row.reconciliation.computed_closing, range.currency)} against reported ${moneyIn(f, row.reconciliation.reported_closing, range.currency)} — off by ${moneyIn(f, row.reconciliation.difference, range.currency)}.`}
        >
          <span><ReconciliationBadge balanced={row.reconciliation.balanced} label={row.reconciliation.balanced ? 'Balances' : 'Off'} /></span>
        </Tooltip>
      ),
      width: 120,
    },
  ], [f, range.currency]);

  return (
    <Section
      title="MRR movement"
      description="New, expansion, contraction, churn and reactivation, classified per customer and reconciled against the closing balance."
      actions={<BasisNote basis={data?.basis} sources={data?.sources} label="How movement was computed" />}
    >
      {movement.error && <Card><SectionError error={movement.error} path="GET /v1/revenue/movement" onRetry={movement.refetch} /></Card>}
      {!movement.error && !data && <Card><ChartSkeleton /></Card>}
      {data && months.length === 0 && (
        <Card>
          <EmptyState
            title="No recurring revenue moved in this window"
            body={<EmptyBody>Nothing was contracted, expanded or lost in the months you picked.</EmptyBody>}
            action={<Button variant="secondary" onClick={() => range.setMonths(24)}>Look back 24 months</Button>}
          />
        </Card>
      )}
      {data && month && (
        <div className="rv-cols">
          <Card
            title={`${monthLabel(month.month, f, true)} movement`}
            actions={(
              <Inline gap={3}>
                <ReconciliationBadge balanced={month.reconciliation.balanced} />
                <SegmentedControl
                  size="sm"
                  aria-label="Month to break down"
                  value={selectedMonth}
                  onChange={(value) => { if (value) setMonthParam(value); }}
                  options={monthChoices}
                />
              </Inline>
            )}
          >
            {month.reconciliation.balanced ? (
              <Stack gap={5}>
                {stale && moved && (
                  <Banner
                    tone="info"
                    compact
                    title={`Nothing moved in ${monthLabel(month.month, f, true)}`}
                    actions={(
                      <Button size="sm" variant="secondary" onClick={() => setMonthParam(moved.month)}>
                        {`Show ${monthLabel(moved.month, f, true)}`}
                      </Button>
                    )}
                  >
                    {`No account started, grew, shrank or left in this month. The last month with movement was ${monthLabel(moved.month, f, true)}.`}
                  </Banner>
                )}
                <WaterfallChart
                  title={`MRR movement in ${monthLabel(month.month, f, true)}`}
                  description="Opening balance, each classified movement, and the closing balance it adds up to."
                  items={waterfallOf(month)}
                  height={280}
                  valueFormat={moneyAxis(f, range.currency, waterfallLayout(waterfallOf(month)).flatMap((bar) => [bar.start, bar.end]))}
                />
                <div className="rv-waterlegend">
                  <span className="rv-waterlegend__item">Opening <span className="rv-waterlegend__value">{moneyIn(f, month.opening, range.currency)}</span></span>
                  <span className="rv-waterlegend__item">Net <span className="rv-waterlegend__value">{signedMoneyIn(f, month.net, range.currency)}</span></span>
                  <span className="rv-waterlegend__item">Closing <span className="rv-waterlegend__value">{moneyIn(f, month.closing, range.currency)}</span></span>
                  <span className="rv-waterlegend__item">
                    Accounts <span className="rv-waterlegend__value">{formatNumber(month.counts.accounts_at_open)} → {formatNumber(month.counts.accounts_at_close)}</span>
                  </span>
                </div>
              </Stack>
            ) : (
              <Banner tone="danger" title="This month does not reconcile, so the waterfall is not drawn">
                {`Re-deriving the closing balance from the movements gives ${moneyIn(f, month.reconciliation.computed_closing, range.currency)}, `
                  + `against a reported closing of ${moneyIn(f, month.reconciliation.reported_closing, range.currency)} — a difference of `
                  + `${moneyIn(f, month.reconciliation.difference, range.currency)}. ${month.reconciliation.note ?? 'Drawing bars from these numbers would show a movement that did not happen.'}`}
              </Banner>
            )}
          </Card>

          <Card title="Who moved" description={`Largest movements in ${monthLabel(month.month, f, true)}, biggest first.`}>
            {month.top_movers.length === 0
              ? <EmptyState size="sm" inline title="Nobody moved" body="No account started, grew, shrank or left in this month." illustration={null} />
              : (
                <div className="rv-rows">
                  {month.top_movers.map((mover: Mover) => (
                    <div className="rv-row" key={`${mover.customer}-${mover.kind}`}>
                      <div className="rv-row__main">
                        <button type="button" className="rv-link rv-row__title" onClick={() => navigate(`/billing/customers/${mover.customer}`)}>
                          {mover.name}
                        </button>
                        <div className="rv-row__sub">
                          {moneyIn(f, mover.from, mover.currency)} → {moneyIn(f, mover.to, mover.currency)}
                        </div>
                      </div>
                      <div className="rv-row__aside">
                        <Inline gap={3} justify="end">
                          <Badge tone={MOVER_TONE[mover.kind] ?? 'neutral'} size="sm">{humanize(mover.kind)}</Badge>
                          <span className="rv-num">{signedMoneyIn(f, mover.kind === 'contraction' || mover.kind === 'churn' ? -Math.abs(mover.amount) : mover.amount, mover.currency)}</span>
                        </Inline>
                      </div>
                    </div>
                  ))}
                </div>
              )}
          </Card>
        </div>
      )}

      {data && months.length > 0 && (
        <Card padding="none">
          <DataTable
            rows={months}
            columns={columns}
            getRowId={(row) => row.month}
            caption="MRR movement by month"
            searchPlaceholder="Search months…"
            value={table.state}
            onChange={table.setState}
            toolbar={(
              <ExportCsvButton
                name={`mrr-movement-${range.currency}`}
                noun="month"
                rows={visibleRows(months, columns, table.state)}
                columns={movementCsv(range.currency)}
              />
            )}
            onRowClick={(row) => setMonthParam(row.month)}
            maxHeight={520}
            empty={<EmptyState size="sm" title="No months in range" body="Widen the reporting window." />}
          />
        </Card>
      )}
    </Section>
  );
}

/* ------------------------------- retention -------------------------------- */

type CohortMetric = 'logo' | 'nrr';
const COHORT_METRICS = ['nrr', 'logo'] as const;

function RetentionSection({
  churn, cohorts, range,
}: {
  churn: Sticky<RevenueChurn>;
  cohorts: Sticky<RevenueCohorts>;
  range: RevenueRange;
}) {
  const f = useFormat();
  const [metric, setMetric] = useTabParam<CohortMetric>('cohort', COHORT_METRICS, 'nrr');
  const data = churn.data;
  const complete = useMemo(() => (data?.series ?? []).filter((row) => row.complete), [data]);

  const chartSeries = useMemo(() => [
    { id: 'nrr', label: 'Net revenue retention', values: complete.map((row) => rateFraction(row.net_revenue_retention) * 100) },
    { id: 'grr', label: 'Gross revenue retention', values: complete.map((row) => rateFraction(row.gross_revenue_retention) * 100) },
    { id: 'logo', label: 'Logo retention', values: complete.map((row) => rateFraction(row.logo_retention) * 100), dashed: true },
  ], [complete]);

  return (
    <Section
      title="Retention"
      description="What the book keeps month over month, and what each signup cohort is still worth."
      actions={<BasisNote basis={data?.basis} sources={data?.sources} label="How retention was computed" />}
    >
      {churn.error && <Card><SectionError error={churn.error} path="GET /v1/revenue/churn" onRetry={churn.refetch} /></Card>}
      {!churn.error && !data && <Card><ChartSkeleton /></Card>}
      {data && (
        <div className="rv-cols">
          <Card title="Retention by month" description="Complete months only — a month still running has not retained anything yet.">
            {complete.length < 2
              ? (
                <EmptyState
                  size="sm"
                  title="Not enough complete months to draw a trend"
                  body={<EmptyBody>Retention is measured against a month that has closed. Widen the window and the series fills in.</EmptyBody>}
                  action={<Button variant="secondary" size="sm" onClick={() => range.setMonths(24)}>Look back 24 months</Button>}
                />
              )
              : (
                <LineChart
                  title="Retention by month"
                  description="Net and gross revenue retention against logo retention, in percent."
                  categories={complete.map((row) => monthLabel(row.month, f))}
                  series={chartSeries}
                  height={260}
                  valueFormat={(value) => `${formatNumber(value, { maxDecimals: 1 })}%`}
                  partialLast={false}
                />
              )}
          </Card>
          <Card title="Over the whole window">
            <Stack gap={5}>
              <Grid minColumnWidth={130} gap={5}>
                <Stat size="sm" label="Net revenue retention" value={rateText(data.totals.net_revenue_retention)} caption={`${moneyIn(f, data.totals.expansion_mrr, range.currency)} expanded`} />
                <Stat size="sm" label="Gross revenue retention" value={rateText(data.totals.gross_revenue_retention)} caption={`${moneyIn(f, data.totals.churned_mrr, range.currency)} churned`} />
                <Stat size="sm" label="Logo churn" value={rateText(data.totals.logo_churn)} caption={`${f.plural(data.totals.churned_accounts, 'account')} lost of ${formatNumber(data.totals.exposed_accounts)} exposed`} />
                <Stat size="sm" label="Contraction" value={moneyIn(f, data.totals.contraction_mrr, range.currency)} caption="Downgrades inside surviving accounts" />
              </Grid>
              <div className="rv-hint">
                {data.totals.net_revenue_retention
                  ? `Net revenue retention divides ${moneyIn(f, data.totals.net_revenue_retention.numerator, range.currency)} kept by ${moneyIn(f, data.totals.net_revenue_retention.denominator, range.currency)} exposed. Both numbers come back with the rate, so the figure can be checked rather than believed.`
                  : 'No revenue was exposed to churn in this window, so retention is undefined rather than 100%.'}
              </div>
            </Stack>
          </Card>
        </div>
      )}

      <Card
        title="Cohort retention"
        description="Rows are the month an account first carried recurring revenue; columns are months since."
        actions={(
          <Inline gap={3}>
            <SegmentedControl
              size="sm"
              aria-label="Cohort measure"
              value={metric}
              onChange={setMetric}
              options={[{ value: 'nrr', label: 'Revenue' }, { value: 'logo', label: 'Logos' }]}
            />
            <ExportCsvButton
              name={`cohorts-${range.currency}`}
              noun="cohort month"
              rows={cohortCells(cohorts.data)}
              columns={[
                { header: 'Cohort', value: (row) => row.cohort },
                { header: 'Cohort accounts', value: (row) => row.cohortAccounts },
                { header: 'Months since', value: (row) => row.offset },
                { header: 'Month', value: (row) => row.month },
                { header: 'Accounts retained', value: (row) => row.accounts },
                { header: 'Currency', value: () => range.currency.toUpperCase() },
                { header: 'MRR', value: (row) => csvAmount(row.mrr, range.currency) },
                { header: 'Logo retention %', value: (row) => (row.logo === null ? '' : (row.logo / 100).toFixed(2)) },
                { header: 'Net revenue retention %', value: (row) => (row.nrr === null ? '' : (row.nrr / 100).toFixed(2)) },
                { header: 'Complete month', value: (row) => (row.complete ? 'yes' : 'no') },
              ] satisfies CsvColumn<CohortCsvRow>[]}
            />
            <BasisNote basis={cohorts.data?.basis} sources={cohorts.data?.sources} label="How the cohort matrix was computed" />
          </Inline>
        )}
      >
        {cohorts.error && <SectionError error={cohorts.error} path="GET /v1/revenue/cohorts" onRetry={cohorts.refetch} />}
        {!cohorts.error && !cohorts.data && <ChartSkeleton height={200} />}
        {cohorts.data && <CohortMatrix cohorts={cohorts.data} metric={metric} currency={range.currency} />}
      </Card>
    </Section>
  );
}

/**
 * The matrix as rows rather than as a grid.
 *
 * A cohort table is the one thing on this board somebody always wants in a
 * spreadsheet, and a grid pasted into one is a grid nobody can pivot. One row
 * per cohort-month, with the retention that cell was shaded from.
 */
interface CohortCsvRow {
  cohort: string;
  cohortAccounts: number;
  offset: number;
  month: string;
  accounts: number;
  mrr: number | null;
  logo: number | null;
  nrr: number | null;
  complete: boolean;
}

function cohortCells(cohorts: RevenueCohorts | undefined): CohortCsvRow[] {
  if (!cohorts) return [];
  return cohorts.series.flatMap((cohort) => cohort.cells.map((cell) => ({
    cohort: cohort.cohort,
    cohortAccounts: cohort.accounts,
    offset: cell.offset,
    month: cell.month,
    accounts: cell.accounts,
    mrr: cell.mrr,
    logo: cell.logo_retention.undefined_rate ? null : cell.logo_retention.bps,
    nrr: cell.net_revenue_retention && !cell.net_revenue_retention.undefined_rate ? cell.net_revenue_retention.bps : null,
    complete: cell.complete,
  })));
}

function CohortMatrix({ cohorts, metric, currency }: { cohorts: RevenueCohorts; metric: CohortMetric; currency: string }) {
  const f = useFormat();
  const offsets = cohorts.totals.by_offset.map((row) => row.offset);
  const width = Math.min(offsets.length, 13);
  const columns = offsets.slice(0, width);

  if (cohorts.series.length === 0) {
    return (
      <EmptyState
        size="sm"
        title="No cohorts in this window"
        body={<EmptyBody>A cohort forms the month an account first carries recurring revenue.</EmptyBody>}
      />
    );
  }

  const valueOf = (cell: { logo_retention: { bps: number; undefined_rate: boolean }; net_revenue_retention: { bps: number; undefined_rate: boolean } | null }) => (
    metric === 'logo' ? cell.logo_retention : cell.net_revenue_retention
  );

  return (
    <div className="rv-cohort">
      <table>
        <caption className="u-visually-hidden">
          {metric === 'logo' ? 'Logo retention' : 'Net revenue retention'} by signup cohort and months since signup
        </caption>
        <thead>
          <tr>
            <th scope="col">Cohort</th>
            <th scope="col">Accounts</th>
            {columns.map((offset) => <th scope="col" key={offset}>M{offset}</th>)}
          </tr>
        </thead>
        <tbody>
          {cohorts.series.map((cohort) => (
            <tr key={cohort.cohort}>
              <th scope="row">{monthLabel(cohort.cohort, f, true)}</th>
              <td className="is-empty">{formatNumber(cohort.accounts)}</td>
              {columns.map((offset) => {
                const cell = cohort.cells.find((c) => c.offset === offset);
                const rate = cell ? valueOf(cell) : null;
                if (!cell || !rate || rate.undefined_rate) {
                  return <td key={offset} className="is-empty" aria-label="No data">·</td>;
                }
                const intensity = cohortIntensity(rate.bps);
                return (
                  <td
                    key={offset}
                    title={`${monthLabel(cohort.cohort, f, true)} cohort, month ${offset}: ${rate.bps / 100}% — ${formatNumber(cell.accounts)} accounts, ${moneyIn(f, cell.mrr, currency)} MRR`}
                    style={{ background: `color-mix(in srgb, var(--viz-1) ${Math.round(10 + intensity * 78)}%, var(--bg-sunken))`, color: intensity > 0.46 ? 'var(--accent-contrast)' : 'var(--text-primary)' }}
                  >
                    {cohortCellText(rate.bps)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rv-cohort__legend">
        <span>0%</span>
        {[0, 50, 100, 200, 600, 3000].map((points) => (
          <span
            key={points}
            className="rv-cohort__swatch"
            title={`${points}%`}
            style={{ background: `color-mix(in srgb, var(--viz-1) ${Math.round(10 + cohortIntensity(points * 100) * 78)}%, var(--bg-sunken))` }}
          />
        ))}
        <span>10×+</span>
        <span className="rv-muted">· linear to 100%, then logarithmic · {cohorts.totals.cohorts} cohorts, {cohorts.totals.accounts} accounts</span>
      </div>
    </div>
  );
}

/**
 * Retention above 100% spans two orders of magnitude in this book — 185% and
 * 2704% are both real cohorts — so a linear ramp to 200% paints them the same
 * shade and hides the one cohort that expanded twenty-seven fold. Below par is
 * linear, because the difference between 40% and 60% is what a reader acts on;
 * above it the scale goes logarithmic, which keeps growth legible all the way
 * out without flattening the cases nearer 100%.
 */
function cohortIntensity(bps: number): number {
  const points = bps / 100;
  if (points <= 100) return Math.max(0.04, (points / 100) * 0.5);
  // 100% → 0.5, 1000% → ~0.83, 10000% → 1.
  const decades = Math.log10(points / 100) / 2;
  return Math.min(1, 0.5 + Math.max(0, decades) * 0.5);
}

/** Past a certain size, "2,704%" is noise where "27×" is the finding. */
function cohortCellText(bps: number): string {
  const points = bps / 100;
  if (points >= 400) return `${Math.round(points / 100)}×`;
  return `${Math.round(points)}%`;
}

/* ------------------------------ receivables ------------------------------- */

function ReceivablesSection({ collections, range }: { collections: Sticky<RevenueCollections>; range: RevenueRange }) {
  const f = useFormat();
  const navigate = useNavigate();
  const data = collections.data;
  const buckets = data?.ageing.buckets ?? [];
  const [drilled, setDrilled] = useState<AgeingBucket | null>(null);
  // Recovery is currency-scoped like everything else on this board, so the
  // queue can hold a live EUR campaign while the USD book is genuinely clear.
  const recovery = useQuery<{ open_campaigns: number; totals: { currency: string; amount_at_risk: number }[] }>('/v1/dunning/summary');
  const elsewhere = (recovery.data?.totals ?? [])
    .filter((total) => total.currency !== range.currency && total.amount_at_risk > 0);

  return (
    <Section
      title="Receivables"
      description="What is owed, how old it is, and what recovery is getting back."
      actions={(
        <Inline gap={3}>
          <ExportCsvButton
            name={`ageing-${range.currency}`}
            noun="bucket"
            rows={buckets}
            columns={[
              { header: 'Bucket', value: (row) => row.label },
              { header: 'Open invoices', value: (row) => row.invoices },
              { header: 'Currency', value: () => range.currency.toUpperCase() },
              { header: 'Outstanding', value: (row) => csvAmount(row.amount, range.currency) },
              { header: 'Share of the book %', value: (row) => (row.share && !row.share.undefined_rate ? (row.share.bps / 100).toFixed(2) : '') },
              { header: 'Oldest due', value: (row) => csvDay(row.oldest_due) },
              { header: 'As at', value: () => csvDay(data?.ageing.as_of) },
            ] satisfies CsvColumn<AgeingBucket>[]}
          />
          <Button variant="secondary" size="sm" iconLeft={<Icons.refresh size={14} />} onClick={() => navigate('/revenue/dunning')}>
            Work the recovery queue
          </Button>
          <BasisNote basis={data?.basis} sources={data?.sources} label="How receivables were computed" />
        </Inline>
      )}
    >
      {collections.error && <Card><SectionError error={collections.error} path="GET /v1/revenue/collections" onRetry={collections.refetch} /></Card>}
      {!collections.error && !data && <Card><ChartSkeleton height={200} /></Card>}
      {data && (
        <div className="rv-cols">
          <Card title="Ageing" description={`As at ${f.dateTime(data.ageing.as_of)} · ${f.plural(data.ageing.invoices, 'open invoice')}`}>
            {data.ageing.total === 0 || buckets.length === 0
              ? (
                <EmptyState
                  size="sm"
                  title="Nothing is owed in this book"
                  body={<EmptyBody>Every invoice raised in this currency has been paid, credited or written off.</EmptyBody>}
                  action={<Button variant="secondary" size="sm" onClick={() => navigate('/billing/invoices')}>Open invoices</Button>}
                />
              )
              : (
                <Stack gap={5}>
                  <div className="rv-rows">
                    {buckets.map((bucket) => (
                      <button
                        type="button"
                        className="rv-row"
                        key={bucket.bucket}
                        disabled={bucket.invoices === 0}
                        aria-label={`${bucket.label} — open the ${f.plural(bucket.invoices, 'invoice')} in this bucket`}
                        onClick={() => setDrilled(bucket)}
                        style={{ background: 'none', border: 0, borderBlockEnd: '1px solid var(--border-subtle)', cursor: bucket.invoices ? 'pointer' : 'default', width: '100%', textAlign: 'start', color: 'inherit' }}
                      >
                        <div className="rv-row__main">
                          <div className="rv-row__title">{bucket.label}</div>
                          <div className="rv-row__sub">
                            {f.plural(bucket.invoices, 'invoice')}
                            {bucket.oldest_due ? ` · oldest due ${boundaryDate(f, bucket.oldest_due)}` : ''}
                          </div>
                        </div>
                        <div className="rv-row__aside">
                          <div className="rv-num">{moneyIn(f, bucket.amount, range.currency)}</div>
                          <div className="rv-sub">{rateText(bucket.share)}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                  <div className="rv-hint">
                    {`${moneyIn(f, data.ageing.past_due_total, range.currency)} of ${moneyIn(f, data.ageing.total, range.currency)} is past due — ${rateText(data.ageing.past_due_share)} of the book.`}
                  </div>
                </Stack>
              )}
          </Card>
          <Card title="Collection and recovery">
            <Stack gap={5}>
              <Grid minColumnWidth={130} gap={5}>
                <Stat size="sm" label="Billed" value={moneyIn(f, data.totals.billed, range.currency)} caption={`over ${f.plural(data.totals.days_in_range, 'day')}`} />
                <Stat size="sm" label="Collection rate" value={rateText(data.totals.collection_rate)} caption="of what was billed in range" />
                <Stat size="sm" label="Recovery rate" value={rateText(data.recovery?.recovery_rate)} caption={data.recovery ? `${f.plural(data.recovery.campaigns_started, 'campaign')} started` : 'No campaigns'} />
                <Stat size="sm" label="Written off" value={moneyIn(f, data.totals.written_off, range.currency)} caption="marked uncollectible" />
              </Grid>
              {data.exposure.note && (
                <div className="rv-hint">
                  {/* The API states this absolutely; the board is scoped to one
                      book, so it is only true of that book. */}
                  {data.exposure.campaigns === 0
                    ? `Nothing is in recovery in the ${range.currency.toUpperCase()} book: every failed charge in this range was either collected or written off.`
                    : data.exposure.note}
                  {elsewhere.length > 0 && (
                    <>
                      {' '}
                      {f.list(elsewhere.map((total) => `${moneyIn(f, total.amount_at_risk, total.currency)} is still being chased in ${total.currency.toUpperCase()}`))}
                      {' — '}
                      <button type="button" className="rv-link" onClick={() => navigate('/revenue/dunning?status=all')}>open the recovery queue</button>
                      {'.'}
                    </>
                  )}
                </div>
              )}
              {(data.recovery?.top_failure_codes ?? []).length > 0 && (
                <Stack gap={3}>
                  <span className="rv-sub">Why cards were refused</span>
                  <Inline gap={3} wrap>
                    {data.recovery?.top_failure_codes.map((code) => (
                      <Badge key={code.code} tone="warning" size="sm">{humanize(code.code)} · {code.campaigns}</Badge>
                    ))}
                  </Inline>
                </Stack>
              )}
              <div className="rv-hint">
                {`Days sales outstanding divides ${moneyIn(f, data.totals.outstanding, range.currency)} still outstanding at the close of the range by `
                  + `${moneyIn(f, data.totals.billed, range.currency)} billed inside it, across ${f.plural(data.totals.days_in_range, 'day')}. `
                  + 'A bill reduced by a credit note ages at what it actually asked for.'}
              </div>
            </Stack>
          </Card>
        </div>
      )}
      {drilled && data && (
        <AgeingDrawer bucket={drilled} currency={range.currency} asOf={data.ageing.as_of} onClose={() => setDrilled(null)} />
      )}
    </Section>
  );
}

/**
 * One ageing bucket, opened.
 *
 * "Which invoice is the $127,840?" is the question the bucket provokes, and
 * sending the reader to every open invoice does not answer it. The book is
 * re-aged here under the endpoint's own rule — outstanding at `as_of`, aged
 * from the due date, or the day it was finalised when there is none — so the
 * rows in this drawer are exactly the ones the tile counted.
 */
function AgeingDrawer({
  bucket, currency, asOf, onClose,
}: { bucket: AgeingBucket; currency: string; asOf: number; onClose: () => void }) {
  const f = useFormat();
  const navigate = useNavigate();
  const invoices = useQuery<ListEnvelope<OpenInvoice>>('/v1/invoices', { status: 'open_like', limit: 200 });

  const rows = useMemo(() => (invoices.data?.data ?? [])
    .filter((invoice) => invoice.currency === currency)
    .map((invoice) => ({ invoice, outstanding: outstandingAt(invoice, asOf) }))
    .filter((row) => row.outstanding > 0 && bucketFor(row.invoice, asOf) === bucket.bucket)
    .sort((a, b) => dueAt(a.invoice) - dueAt(b.invoice)), [invoices.data, currency, asOf, bucket.bucket]);

  const total = rows.reduce((sum, row) => sum + row.outstanding, 0);

  return (
    <Drawer
      open
      onClose={onClose}
      size="md"
      title={bucket.label}
      description={`${f.plural(bucket.invoices, 'open invoice')} in the ${currency.toUpperCase()} book, ${moneyIn(f, bucket.amount, currency)} outstanding as at ${f.dateTime(asOf)}.`}
      actions={<Button size="sm" variant="secondary" onClick={() => navigate('/billing/invoices?status=open_like')}>All open invoices</Button>}
    >
      <Stack gap={5}>
        {invoices.error && <SectionError error={invoices.error} path="GET /v1/invoices" onRetry={invoices.refetch} />}
        {!invoices.error && invoices.loading && <Skeleton height={160} />}
        {!invoices.error && !invoices.loading && rows.length === 0 && (
          <EmptyState
            size="sm"
            title="Nothing in this bucket"
            body={<EmptyBody>Every bill that was in this band has since been paid, credited or written off.</EmptyBody>}
          />
        )}
        {rows.length > 0 && (
          <>
            <div className="rv-rows">
              {rows.map(({ invoice, outstanding }) => {
                const days = Math.floor((asOf - dueAt(invoice)) / DAY_MS);
                return (
                  <div className="rv-row" key={invoice.id}>
                    <div className="rv-row__main">
                      <button type="button" className="rv-link rv-row__title" onClick={() => navigate(`/billing/invoices/${invoice.id}`)}>
                        {invoice.customer_name} · {invoice.number}
                      </button>
                      <div className="rv-row__sub">
                        {days < 0
                          ? `due ${boundaryDate(f, dueAt(invoice), true)}, ${f.plural(-days, 'day')} from now`
                          : `${f.plural(days, 'day')} past its ${boundaryDate(f, dueAt(invoice), true)} due date`}
                      </div>
                    </div>
                    <div className="rv-row__aside">{moneyIn(f, outstanding, invoice.currency)}</div>
                  </div>
                );
              })}
            </div>
            <div className="rv-hint">
              {`${f.plural(rows.length, 'bill')} ${rows.length === 1 ? 'adds' : 'add'} to ${moneyIn(f, total, currency)}`}
              {total === bucket.amount
                ? ', which is exactly what the bucket reported.'
                : `, against the ${moneyIn(f, bucket.amount, currency)} the bucket reported — the list is capped at the 200 most recent open bills.`}
            </div>
          </>
        )}
      </Stack>
    </Drawer>
  );
}

/* -------------------------------- accounts -------------------------------- */

const accountsCsv = (currency: string): CsvColumn<RevenueAccountRow>[] => [
  { header: 'Account', value: (row) => row.name },
  { header: 'Customer id', value: (row) => row.customer },
  { header: 'Currency', value: (row) => row.currency.toUpperCase() },
  { header: 'MRR', value: (row) => csvAmount(row.mrr, row.currency) },
  { header: 'ARR', value: (row) => csvAmount(row.arr, row.currency) },
  { header: 'Month on month', value: (row) => csvAmount(row.change, row.currency) },
  { header: 'Subscriptions', value: (row) => row.subscriptions },
  { header: 'First revenue', value: (row) => csvDay(row.first_revenue_at) },
  { header: 'Book', value: () => currency.toUpperCase() },
];

/**
 * The book, account by account.
 *
 * Two things here are deliberate. Money columns are accessed in *major* units,
 * because the filter, the sort and the chip all read the accessor: filtering
 * MRR "at least 1500" on minor units silently means fifteen dollars, and the
 * result — sixteen of seventeen accounts "over $1,500" — is wrong in a way
 * that looks plausible. And the whole query/sort/filter stack lives in the URL
 * beside the range and the currency, so a narrowed table survives a reload and
 * can be sent to somebody.
 */
function AccountsTable({
  accounts, currency, onOpen,
}: { accounts: Sticky<ListEnvelope<RevenueAccountRow>>; currency: string; onOpen: (row: RevenueAccountRow) => void }) {
  const f = useFormat();
  const table = useUrlTableState('a', ACCOUNTS_SORT);
  const rows = accounts.data?.data ?? [];
  const code = currency.toUpperCase();
  const major = useCallback((minor: number) => toMajorUnits(minor, currency.toLowerCase()), [currency]);

  const columns: DataTableColumn<RevenueAccountRow>[] = useMemo(() => [
    {
      id: 'name',
      header: 'Account',
      pinned: true,
      accessor: (row) => row.name,
      cell: (row) => (
        <div className="rv-cell">
          <span className="rv-cell__top">{row.name}</span>
          <span className="rv-cell__sub">{f.plural(row.subscriptions, 'subscription')}{row.first_revenue_at ? ` · since ${boundaryDate(f, row.first_revenue_at)}` : ''}</span>
        </div>
      ),
      width: 260,
    },
    {
      id: 'mrr', header: 'MRR', align: 'right', width: 150, accessor: (row) => major(row.mrr), filter: 'number',
      filterLabel: `MRR in ${code}`,
      cell: (row) => <span className="rv-num">{moneyIn(f, row.mrr, row.currency)}</span>,
      total: (shown) => <span className="rv-num">{shown.length && shown.every((r) => r.currency === shown[0].currency) ? moneyIn(f, shown.reduce((sum, r) => sum + r.mrr, 0), shown[0].currency) : '—'}</span>,
    },
    {
      id: 'arr', header: 'ARR', align: 'right', width: 150, accessor: (row) => major(row.arr), filter: 'number',
      filterLabel: `ARR in ${code}`,
      cell: (row) => <span className="rv-num">{moneyIn(f, row.arr, row.currency)}</span>, defaultHidden: true,
    },
    {
      id: 'change', header: 'Month on month', align: 'right', width: 180, accessor: (row) => major(row.change), filter: 'number',
      filterLabel: `Month on month in ${code}`,
      cell: (row) => (
        <span className={`rv-num${row.change > 0 ? ' rv-num--pos' : row.change < 0 ? ' rv-num--neg' : ''}`}>
          {row.change === 0 ? '—' : signedMoneyIn(f, row.change, row.currency)}
        </span>
      ),
    },
    { id: 'subscriptions', header: 'Subscriptions', align: 'right', width: 140, accessor: (row) => row.subscriptions, filter: 'number', defaultHidden: true },
    // The board is scoped to one book at a time, so every row here reads the
    // same code. Kept behind the Columns control for the one reader checking
    // that the scope did what they asked, off by default for everyone else —
    // and with no filter of its own, because filtering one constant value
    // inside a table the book selector has already narrowed does nothing.
    { id: 'currency', header: 'Currency', accessor: (row) => row.currency.toUpperCase(), width: 110, defaultHidden: true },
  ], [f, major, code]);

  // The label beside the search box has to quote the number the operator can
  // count on screen, not the number the endpoint returned.
  const shown = visibleRows(rows, columns, table.state);

  return (
    <DataTable
      rows={rows}
      columns={columns}
      getRowId={(row) => row.customer}
      caption="Accounts by recurring revenue"
      loading={accounts.loading}
      error={accounts.error ? { message: accounts.error.body?.message, code: accounts.error.body?.code, requestId: accounts.error.body?.request_id } : null}
      onRetry={accounts.refetch}
      onRowClick={onOpen}
      value={table.state}
      onChange={table.setState}
      toolbar={(
        <Inline gap={3} wrap>
          <span className="rv-sub">
            {shown.length === rows.length
              ? `${f.plural(rows.length, 'account')} in the ${code} book`
              : `${formatNumber(shown.length)} of ${f.plural(rows.length, 'account')} in the ${code} book`}
          </span>
          <ExportCsvButton
            name={`accounts-${currency}`}
            noun="account"
            rows={shown}
            columns={accountsCsv(currency)}
          />
        </Inline>
      )}
      searchPlaceholder="Search accounts…"
      maxHeight={560}
      emptyFiltered={(
        <EmptyState
          size="sm"
          title="No account matches this filter"
          body={<EmptyBody>Money filters are in {code}, in whole units — type 1500 to mean {moneyIn(f, 150_000, currency)}.</EmptyBody>}
          action={<Button variant="secondary" onClick={() => table.setState({ query: '', sort: table.state.sort, filters: {} })}>Clear the filters</Button>}
        />
      )}
      empty={(
        <EmptyState
          title="No account carries recurring revenue in this book"
          body={<EmptyBody>Nothing in this currency has an active subscription inside the window.</EmptyBody>}
          action={<Button variant="primary" href="/billing/subscriptions?new=1" iconLeft={<Icons.repeat size={15} />}>New subscription</Button>}
        />
      )}
    />
  );
}
