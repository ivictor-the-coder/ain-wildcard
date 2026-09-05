/**
 * Revenue recognition — the screen behind the board's "Deferred balance" tile.
 *
 * Every finalised invoice line is spread across the days of the period it
 * covers; what has elapsed is earned, what has not is deferred. A finance lead
 * reads that three ways and this screen gives all three: the monthly picture
 * (billed against earned), the balance rolled forward month by month with the
 * arithmetic re-done here for every row, and the lines still carrying a
 * balance, each opening to its own day-by-day schedule. The API's four
 * reconciliation checks — the ones that can actually fail — are named beside
 * the figures rather than folded into one green badge.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '../../kernel/api';
import { useNavigate } from '../../kernel/router';
import {
  Badge, Banner, BarChart, Button, Card, DataTable, Drawer, EmptyState, Grid, Icons, Inline, Page, Section,
  Skeleton, Stack, Stat, Tooltip, formatNumber, humanize, toMajorUnits, useFormat,
  type DataTableColumn,
} from '../../design';
import {
  BasisNote, ChartSkeleton, CurrencyControl, EmptyBody, ExportCsvButton, NotePopover, RangeControl,
  ReconciliationBadge, RefreshingChip, SectionError, Stale, boundaryDate, boundaryRange, csvAmount,
  csvDay, moneyAxis, monthLabel, moneyIn, useDefaultCurrency, useRevenueRange, useSticky, useUrlTableState,
  visibleRows,
  type CsvColumn, type RevenueRange, type Sticky,
} from './common';
import { CHECK_LABEL, rollForward, scheduleByMonth, scheduleReconciles, type RollForwardRow } from './recognition-math';
import type { DeferredLine, RecognitionCheck, RevenueDeferred, RevenueMrr } from './types';

/** Wide enough for a seven-figure amount with its sign; the table scrolls past that. */
const MONEY_COLUMN = 124;
/** The API caps the lines it names; asking for the cap keeps the table honest about what it holds. */
const LINE_LIMIT = 500;

/* ---------------------------------- page ---------------------------------- */

export function RecognitionPage() {
  const f = useFormat();
  const navigate = useNavigate();
  const defaultCurrency = useDefaultCurrency();
  const range = useRevenueRange(defaultCurrency);
  const currency = range.currency;

  // Unscoped, for which books exist; the same read the board uses for its strip.
  const books = useSticky(useQuery<RevenueMrr>('/v1/revenue/mrr', { months: range.months }));
  const report = useSticky(useQuery<RevenueDeferred>('/v1/revenue/deferred', { ...range.query, limit: LINE_LIMIT }), currency);
  const data = report.data;
  const totals = data?.totals;
  const rows = useMemo(() => rollForward(data?.series ?? []), [data]);
  const failed = (data?.reconciliation.checks ?? []).filter((check) => !check.ok);

  return (
    <Page
      className="rv-page"
      title="Revenue recognition"
      eyebrow="Insights"
      subtitle="What has been billed, what has been earned so far, and the deferred balance between them — every invoice line spread across the days it covers."
      actions={(
        <Inline gap={3} wrap>
          <RefreshingChip stale={report.stale} />
          <RangeControl range={range} />
          <CurrencyControl range={range} scope={books.data?.basis.currency} />
        </Inline>
      )}
    >
      <Stack gap={7}>
        {books.data && books.data.basis.currency.mode === 'mixed' && (
          <Banner
            tone="info"
            compact
            title={`This workspace bills in ${f.list(books.data.basis.currency.currencies.map((c) => c.toUpperCase()))}`}
            actions={(
              <NotePopover label="Why nothing is converted" title="The multi-currency basis">
                {data?.basis.currency.note ?? books.data.basis.currency.note}
              </NotePopover>
            )}
          >
            Nothing here is converted between currencies or added across them. Every figure on this page is a real{' '}
            {currency.toUpperCase()} amount; pick another book above to read that one.
          </Banner>
        )}

        {data && !data.balanced && (
          <Banner tone="danger" title="A recognition check failed">
            {failed.length
              ? `${f.list(failed.map((check) => CHECK_LABEL[check.name] ?? humanize(check.name)))} — ${data.reconciliation.note ?? 'the figures below are drawn from numbers that do not agree.'}`
              : data.reconciliation.note ?? 'Invoiced does not equal recognised plus deferred.'}
          </Banner>
        )}
        {(data?.warnings ?? []).map((warning) => <Banner tone="warning" compact key={warning}>{warning}</Banner>)}

        {report.error && <Card><SectionError error={report.error} path="GET /v1/revenue/deferred" onRetry={report.refetch} /></Card>}
        {!report.error && !data && (
          <div className="rv-tiles">{[0, 1, 2, 3].map((i) => <Card key={i} padding="tight"><Skeleton height={76} /></Card>)}</div>
        )}

        {data && totals && (
          <Stale stale={report.stale}>
            <div className="rv-tiles">
              <Card padding="tight" className="rv-tile">
                <span className="rv-tile__basis"><BasisNote basis={data.basis} sources={data.sources} label="How invoiced revenue was computed" /></span>
                <Stat
                  label="Invoiced"
                  value={moneyIn(f, totals.invoiced, currency)}
                  caption={totals.credited
                    ? `${moneyIn(f, totals.invoiced_gross, currency)} billed, ${moneyIn(f, totals.credited, currency)} credited back`
                    : `${f.plural(totals.invoice_lines, 'invoice line')} · net of tax`}
                />
              </Card>
              <Card padding="tight" className="rv-tile">
                <span className="rv-tile__basis"><BasisNote basis={data.basis} sources={data.sources} label="How recognised revenue was computed" /></span>
                <Stat
                  label="Recognised to date"
                  value={moneyIn(f, totals.recognised, currency)}
                  caption={totals.invoiced
                    ? `${f.percent((totals.recognised ?? 0) / totals.invoiced, { decimals: 1 })} of what was invoiced has been earned`
                    : 'Nothing invoiced in this book'}
                />
              </Card>
              <Card padding="tight" className="rv-tile">
                <span className="rv-tile__basis"><BasisNote basis={data.basis} sources={data.sources} label="How the deferred balance was computed" /></span>
                <Stat
                  label="Deferred balance"
                  value={moneyIn(f, totals.deferred_balance, currency)}
                  caption="Invoiced, not yet earned — it comes off as the days elapse"
                />
              </Card>
              <Card padding="tight" className="rv-tile">
                <span className="rv-tile__basis"><BasisNote basis={data.basis} sources={data.sources} label="How the unbilled balance was computed" /></span>
                <Stat
                  label="Earned, not yet billed"
                  value={moneyIn(f, totals.unbilled_balance, currency)}
                  caption={totals.unbilled_usage
                    ? `${moneyIn(f, totals.unbilled_usage, currency)} is settled usage waiting for its invoice`
                    : 'Every settled window is on an invoice'}
                />
              </Card>
            </div>
          </Stale>
        )}

        {data && data.series.length === 0 && (
          <Card>
            <EmptyState
              title="Nothing has been invoiced in this book"
              body={<EmptyBody>Recognition starts with a finalised invoice: the first one spreads its lines across the days they cover.</EmptyBody>}
              action={<Button variant="secondary" onClick={() => navigate('/billing/invoices')}>Open invoices</Button>}
            />
          </Card>
        )}

        {data && data.series.length > 0 && (
          <>
            <PictureSection report={report} rows={rows} range={range} />
            <RollForwardSection rows={rows} range={range} stale={report.stale} />
            <LinesSection report={report} range={range} />
          </>
        )}
      </Stack>
    </Page>
  );
}

/* --------------------------------- picture -------------------------------- */

function PictureSection({ report, rows, range }: { report: Sticky<RevenueDeferred>; rows: RollForwardRow[]; range: RevenueRange }) {
  const f = useFormat();
  const data = report.data;
  const checks = data?.reconciliation.checks ?? [];
  const values = rows.flatMap((row) => [row.billed, row.recognised]);

  return (
    <Section
      title="Billed against earned"
      description="What went out on invoices each month next to what was earned in it. The gap between the two bars is the month's move in the deferred balance."
      actions={data ? <ReconciliationBadge balanced={data.balanced} label={data.balanced ? 'Every check passes' : 'A check fails'} /> : undefined}
    >
      <div className="rv-cols">
        <Card title="By month" description="Complete months, and the month in progress read at the reporting instant.">
          {!data && <ChartSkeleton />}
          {data && rows.length > 0 && (
            <Stale stale={report.stale}>
              <BarChart
                title={`Billed against recognised revenue by month, ${range.currency.toUpperCase()}`}
                description="Two bars per month: the amount invoiced net of credit notes, and the amount recognised as earned."
                categories={rows.map((row) => monthLabel(row.month, f))}
                series={[
                  { id: 'billed', label: 'Invoiced', values: rows.map((row) => row.billed - row.credited) },
                  { id: 'recognised', label: 'Recognised', values: rows.map((row) => row.recognised) },
                ]}
                height={260}
                valueFormat={moneyAxis(f, range.currency, values)}
              />
            </Stale>
          )}
        </Card>
        <Card
          title="The checks"
          description="Invoiced = recognised + deferred is an identity — deferred is defined as the difference — so these are the four checks that can actually fail."
        >
          {!data && <Skeleton height={180} />}
          {data && (
            <div className="rv-rows">
              {checks.map((check) => <CheckRow key={check.name} check={check} currency={range.currency} />)}
              {checks.length === 0 && <span className="rv-sub">The report published no checks for this window.</span>}
            </div>
          )}
        </Card>
      </div>
    </Section>
  );
}

function CheckRow({ check, currency }: { check: RecognitionCheck; currency: string }) {
  const f = useFormat();
  return (
    <div className="rv-row">
      <div className="rv-row__main">
        <div className="rv-row__title">{CHECK_LABEL[check.name] ?? humanize(check.name)}</div>
        <div className="rv-row__sub">
          {check.ok
            ? `Expected ${moneyIn(f, check.expected, currency)}, found ${moneyIn(f, check.actual, currency)}.`
            : `Expected ${moneyIn(f, check.expected, currency)}, found ${moneyIn(f, check.actual, currency)} — off by ${moneyIn(f, check.difference, currency)}.`}
        </div>
      </div>
      <div className="rv-row__aside">
        <Tooltip content={check.description}>
          <span><ReconciliationBadge balanced={check.ok} label={check.ok ? 'Passes' : 'Fails'} /></span>
        </Tooltip>
      </div>
    </div>
  );
}

/* ------------------------------- roll-forward ----------------------------- */

const rollForwardCsv = (currency: string): CsvColumn<RollForwardRow>[] => [
  { header: 'Month', value: (row) => row.month },
  { header: 'Currency', value: () => currency.toUpperCase() },
  { header: 'Opening deferred', value: (row) => csvAmount(row.opening, currency) },
  { header: 'Billed', value: (row) => csvAmount(row.billed, currency) },
  { header: 'Credited', value: (row) => csvAmount(-row.credited || 0, currency) },
  { header: 'Recognised', value: (row) => csvAmount(-row.recognised || 0, currency) },
  { header: 'Closing deferred', value: (row) => csvAmount(row.closing, currency) },
  { header: 'Unbilled at close', value: (row) => csvAmount(row.unbilled, currency) },
  { header: 'Invoiced to date', value: (row) => csvAmount(row.invoicedToDate, currency) },
  { header: 'Recognised to date', value: (row) => csvAmount(row.recognisedToDate, currency) },
  { header: 'Complete month', value: (row) => (row.complete ? 'yes' : 'no') },
  { header: 'Rolls forward', value: (row) => (row.balanced ? 'yes' : 'no') },
];

function RollForwardSection({ rows, range, stale }: { rows: RollForwardRow[]; range: RevenueRange; stale: boolean }) {
  const f = useFormat();
  const table = useUrlTableState('rf', { columnId: 'month', direction: 'desc' });
  const unbalanced = rows.filter((row) => !row.balanced);

  const columns: DataTableColumn<RollForwardRow>[] = useMemo(() => [
    {
      id: 'month', header: 'Month', pinned: true, accessor: (row) => row.month, width: 170,
      cell: (row) => (
        <div className="rv-cell">
          <span className="rv-cell__top">{monthLabel(row.month, f, true)}</span>
          <span className="rv-cell__sub">{row.complete ? 'Closed' : 'In progress'}</span>
        </div>
      ),
    },
    { id: 'opening', header: 'Opening', align: 'right', width: MONEY_COLUMN, accessor: (row) => row.opening, cell: (row) => <span className="rv-num">{moneyIn(f, row.opening, range.currency)}</span> },
    { id: 'billed', header: 'Billed', align: 'right', width: MONEY_COLUMN, headerTitle: 'Invoiced this month before credit notes', accessor: (row) => row.billed, cell: (row) => (row.billed ? <span className="rv-num rv-num--pos">{`+${moneyIn(f, row.billed, range.currency)}`}</span> : <span className="rv-num rv-muted">—</span>) },
    { id: 'credited', header: 'Credited', align: 'right', width: MONEY_COLUMN, accessor: (row) => row.credited, cell: (row) => (row.credited ? <span className="rv-num rv-num--neg">{`-${moneyIn(f, row.credited, range.currency)}`}</span> : <span className="rv-num rv-muted">—</span>) },
    { id: 'recognised', header: 'Recognised', align: 'right', width: MONEY_COLUMN, accessor: (row) => row.recognised, cell: (row) => (row.recognised ? <span className="rv-num rv-num--neg">{`-${moneyIn(f, row.recognised, range.currency)}`}</span> : <span className="rv-num rv-muted">—</span>) },
    { id: 'closing', header: 'Closing', align: 'right', width: MONEY_COLUMN, accessor: (row) => row.closing, cell: (row) => <span className="rv-num">{moneyIn(f, row.closing, range.currency)}</span> },
    { id: 'unbilled', header: 'Unbilled', align: 'right', width: MONEY_COLUMN, headerTitle: 'Earned but not yet on an invoice at the close', accessor: (row) => row.unbilled, cell: (row) => (row.unbilled ? <span className="rv-num">{moneyIn(f, row.unbilled, range.currency)}</span> : <span className="rv-num rv-muted">—</span>), defaultHidden: true },
    {
      id: 'balanced', header: 'Rolls forward', accessor: (row) => (row.balanced ? 'yes' : 'no'), filter: 'set', width: 140,
      cell: (row) => (
        <Tooltip content={row.balanced
          ? `${moneyIn(f, row.opening, range.currency)} + ${moneyIn(f, row.billed, range.currency)} − ${moneyIn(f, row.credited, range.currency)} − ${moneyIn(f, row.recognised, range.currency)} = ${moneyIn(f, row.closing, range.currency)}.`
          : `Rolling the opening balance forward gives ${moneyIn(f, row.computed, range.currency)}, against a reported closing of ${moneyIn(f, row.closing, range.currency)} — off by ${moneyIn(f, row.difference, range.currency)}.`}
        >
          <span><ReconciliationBadge balanced={row.balanced} label={row.balanced ? 'Balances' : 'Off'} /></span>
        </Tooltip>
      ),
    },
  ], [f, range.currency]);

  return (
    <Section
      title="Deferred balance, rolled forward"
      description="Opening balance, plus what was billed, less what was credited back, less what was earned, equals closing — re-derived here for every month from the API's own figures."
      actions={<ReconciliationBadge balanced={unbalanced.length === 0} label={unbalanced.length === 0 ? 'Every month rolls forward' : `${f.plural(unbalanced.length, 'month')} off`} />}
    >
      {unbalanced.length > 0 && (
        <Banner tone="danger" title="A month does not roll forward">
          {`Opening plus billed, less credited and recognised, does not give the reported closing in ${f.list(unbalanced.map((row) => monthLabel(row.month, f, true)))}. The rows are marked below rather than smoothed over.`}
        </Banner>
      )}
      <Stale stale={stale}>
        <Card padding="none">
          <DataTable
            rows={rows}
            columns={columns}
            getRowId={(row) => row.month}
            caption="Deferred revenue roll-forward by month"
            searchPlaceholder="Search months…"
            value={table.state}
            onChange={table.setState}
            toolbar={(
              <ExportCsvButton
                name={`recognition-rollforward-${range.currency}`}
                noun="month"
                rows={visibleRows(rows, columns, table.state)}
                columns={rollForwardCsv(range.currency)}
              />
            )}
            maxHeight={520}
            empty={<EmptyState size="sm" title="No months in range" body="Widen the reporting window." />}
          />
        </Card>
      </Stale>
    </Section>
  );
}

/* ---------------------------------- lines --------------------------------- */

const linesCsv = (currency: string): CsvColumn<DeferredLine>[] => [
  { header: 'Account', value: (row) => row.customer_name },
  { header: 'Customer id', value: (row) => row.customer },
  { header: 'Invoice', value: (row) => row.invoice_number },
  { header: 'Invoice status', value: (row) => row.invoice_status },
  { header: 'Line', value: (row) => row.description },
  { header: 'Kind', value: (row) => row.kind },
  { header: 'Credit note', value: (row) => row.credit_note_number ?? '' },
  { header: 'Currency', value: () => currency.toUpperCase() },
  { header: 'Amount', value: (row) => csvAmount(row.amount, currency) },
  { header: 'Recognised to date', value: (row) => csvAmount(row.recognised_to_date, currency) },
  { header: 'Deferred', value: (row) => csvAmount(row.deferred, currency) },
  { header: 'Unbilled', value: (row) => csvAmount(row.unbilled, currency) },
  { header: 'Period start', value: (row) => csvDay(row.period.start) },
  { header: 'Period end', value: (row) => csvDay(row.period.end) },
  { header: 'Days', value: (row) => row.days },
  { header: 'Invoiced on', value: (row) => csvDay(row.invoiced_at) },
];

function LinesSection({ report, range }: { report: Sticky<RevenueDeferred>; range: RevenueRange }) {
  const f = useFormat();
  const navigate = useNavigate();
  const table = useUrlTableState('ln', { columnId: 'deferred', direction: 'desc' });
  const [open, setOpen] = useState<DeferredLine | null>(null);
  const lines = report.data?.lines ?? [];
  const capped = lines.length >= LINE_LIMIT;
  const code = range.currency.toUpperCase();

  const columns: DataTableColumn<DeferredLine>[] = useMemo(() => [
    {
      id: 'account', header: 'Account', pinned: true, width: 240, accessor: (row) => row.customer_name,
      cell: (row) => (
        <div className="rv-cell">
          <span className="rv-cell__top">{row.customer_name}</span>
          <span className="rv-cell__sub">{row.invoice_number}{row.credit_note_number ? ` · reduced by ${row.credit_note_number}` : ''} · {humanize(row.invoice_status).toLowerCase()}</span>
        </div>
      ),
    },
    {
      id: 'line', header: 'Line', width: 260, accessor: (row) => row.description,
      cell: (row) => (
        <div className="rv-cell">
          <span className="rv-cell__top">{row.description}</span>
          <span className="rv-cell__sub">{humanize(row.kind)}</span>
        </div>
      ),
    },
    { id: 'kind', header: 'Kind', accessor: (row) => row.kind, filter: 'set', filterOptionLabel: (value) => humanize(value), width: 120, defaultHidden: true },
    {
      id: 'period', header: 'Period', width: 210, accessor: (row) => row.period.start, filter: 'date',
      cell: (row) => (
        <div className="rv-cell">
          <span className="rv-cell__top rv-nowrap">{boundaryRange(f, row.period.start, row.period.end)}</span>
          <span className="rv-cell__sub">{f.plural(row.days, 'day')}</span>
        </div>
      ),
    },
    {
      id: 'amount', header: 'Invoiced', align: 'right', width: MONEY_COLUMN, filter: 'number', filterLabel: `Invoiced in ${code}`,
      accessor: (row) => toMajorUnits(row.amount, range.currency), cell: (row) => <span className="rv-num">{moneyIn(f, row.amount, range.currency)}</span>,
    },
    {
      id: 'recognised', header: 'Recognised', align: 'right', width: MONEY_COLUMN,
      accessor: (row) => toMajorUnits(row.recognised_to_date, range.currency),
      cell: (row) => (
        <div className="rv-cell" style={{ alignItems: 'flex-end' }}>
          <span className="rv-num">{moneyIn(f, row.recognised_to_date, range.currency)}</span>
          <span className="rv-cell__sub">{row.amount ? f.percent(row.recognised_to_date / row.amount, { decimals: 0 }) : '—'} earned</span>
        </div>
      ),
    },
    {
      id: 'deferred', header: 'Deferred', align: 'right', width: MONEY_COLUMN, filter: 'number', filterLabel: `Deferred in ${code}`,
      accessor: (row) => toMajorUnits(row.deferred, range.currency),
      cell: (row) => <span className="rv-num">{moneyIn(f, row.deferred, range.currency)}</span>,
      total: (shown) => <span className="rv-num">{moneyIn(f, shown.reduce((sum, row) => sum + row.deferred, 0), range.currency)}</span>,
    },
  ], [f, range.currency, code]);

  const shown = visibleRows(lines, columns, table.state);

  return (
    <Section
      title="Lines still carrying a balance"
      description={capped
        ? `The ${formatNumber(LINE_LIMIT)} lines with the largest deferred balance in the ${code} book — the report names no more than that at once.`
        : `Every invoice line in the ${code} book with revenue still ahead of it, largest balance first. Open one for its day-by-day schedule.`}
    >
      <Card padding="none">
        <DataTable
          rows={lines}
          columns={columns}
          getRowId={(row) => row.line}
          caption="Invoice lines with a deferred balance"
          loading={report.loading}
          error={report.error ? { message: report.error.body?.message, code: report.error.body?.code, requestId: report.error.body?.request_id } : null}
          onRetry={report.refetch}
          onRowClick={setOpen}
          rowActions={(row) => [{
            id: 'line',
            items: [
              { id: 'schedule', label: 'Day-by-day schedule', icon: <Icons.calendar size={14} />, onSelect: () => setOpen(row) },
              { id: 'invoice', label: 'Open the invoice', icon: <Icons.invoice size={14} />, onSelect: () => navigate(`/billing/invoices/${row.invoice}`) },
              { id: 'customer', label: 'Open the account', icon: <Icons.building size={14} />, onSelect: () => navigate(`/billing/customers/${row.customer}`) },
            ],
          }]}
          value={table.state}
          onChange={table.setState}
          toolbar={(
            <Inline gap={3} wrap>
              <span className="rv-sub">
                {shown.length === lines.length
                  ? `${f.plural(lines.length, 'line')} in the ${code} book`
                  : `${formatNumber(shown.length)} of ${f.plural(lines.length, 'line')} in the ${code} book`}
              </span>
              <ExportCsvButton name={`recognition-lines-${range.currency}`} noun="line" rows={shown} columns={linesCsv(range.currency)} />
            </Inline>
          )}
          searchPlaceholder="Search accounts, invoices and lines…"
          maxHeight={560}
          emptyFiltered={(
            <EmptyState
              size="sm"
              title="No line matches this filter"
              body={<EmptyBody>Money filters are in {code}, in whole units — type 1500 to mean {moneyIn(f, 150_000, range.currency)}.</EmptyBody>}
              action={<Button variant="secondary" onClick={() => table.setState({ query: '', sort: table.state.sort, filters: {} })}>Clear the filters</Button>}
            />
          )}
          empty={(
            <EmptyState
              title="Nothing is deferred in this book"
              body={<EmptyBody>Every invoiced line has been fully earned. The next finalised invoice with a period ahead of it will appear here.</EmptyBody>}
            />
          )}
        />
      </Card>
      {open && <LineDrawer line={open} range={range} onClose={() => setOpen(null)} />}
    </Section>
  );
}

/**
 * One line, day by day, folded into months.
 *
 * The report re-summed every schedule against its line as one of its four
 * checks; this drawer does the same for the one line a person is looking at,
 * so "the days add back to the line" is something they can see rather than a
 * badge they are asked to trust.
 */
function LineDrawer({ line, range, onClose }: { line: DeferredLine; range: RevenueRange; onClose: () => void }) {
  const f = useFormat();
  const navigate = useNavigate();
  const detail = useQuery<RevenueDeferred>('/v1/revenue/deferred', { ...range.query, invoice: line.invoice });
  const full = detail.data?.lines.find((row) => row.line === line.line);
  const days = full?.schedule ?? [];
  const months = useMemo(() => scheduleByMonth(days), [days]);
  const sums = scheduleReconciles(days, full ?? line);

  return (
    <Drawer
      open
      onClose={onClose}
      size="md"
      title={line.description}
      description={`${line.customer_name} · ${line.invoice_number} · ${boundaryRange(f, line.period.start, line.period.end)}`}
      actions={(
        <Inline gap={3}>
          <Button size="sm" variant="secondary" onClick={() => navigate(`/billing/customers/${line.customer}`)}>Open the account</Button>
          <Button size="sm" variant="primary" onClick={() => navigate(`/billing/invoices/${line.invoice}`)}>Open the invoice</Button>
        </Inline>
      )}
    >
      <Stack gap={6}>
        <Grid minColumnWidth={140} gap={5}>
          <Stat size="sm" label="Invoiced" value={moneyIn(f, line.amount, range.currency)} caption={`on ${boundaryDate(f, line.invoiced_at, true)}`} />
          <Stat size="sm" label="Recognised to date" value={moneyIn(f, line.recognised_to_date, range.currency)} caption={line.amount ? `${f.percent(line.recognised_to_date / line.amount, { decimals: 1 })} earned` : '—'} />
          <Stat size="sm" label="Deferred" value={moneyIn(f, line.deferred, range.currency)} caption={`over ${f.plural(line.days, 'day')}`} />
        </Grid>

        {detail.error && <SectionError error={detail.error} path="GET /v1/revenue/deferred?invoice=…" onRetry={detail.refetch} />}
        {!detail.error && detail.loading && <Skeleton height={200} />}
        {!detail.error && !detail.loading && days.length === 0 && (
          <EmptyState size="sm" title="No schedule for this line" body={<EmptyBody>The report returned this invoice without a day-by-day schedule.</EmptyBody>} />
        )}
        {days.length > 0 && (
          <>
            <Banner tone={sums.sumsToLine && sums.matchesRecognised ? 'success' : 'danger'} compact title={sums.sumsToLine && sums.matchesRecognised ? 'The days add back to the line' : 'The schedule does not add up'}>
              {`${f.plural(days.length, 'day')} sum to ${moneyIn(f, sums.total, range.currency)}${sums.sumsToLine ? ', exactly the line' : ` against a line of ${moneyIn(f, line.amount, range.currency)}`}; `}
              {`the ${f.plural(days.filter((day) => day.recognised).length, 'elapsed day')} sum to ${moneyIn(f, sums.recognised, range.currency)}${sums.matchesRecognised ? ', exactly what is recognised to date.' : `, against ${moneyIn(f, (full ?? line).recognised_to_date, range.currency)} recognised.`}`}
            </Banner>
            <div className="rv-rows">
              {months.map((row) => (
                <div className="rv-row" key={row.month}>
                  <div className="rv-row__main">
                    <div className="rv-row__title">{monthLabel(row.month, f, true)}</div>
                    <div className="rv-row__sub">
                      {row.state === 'earned' ? `${f.plural(row.days, 'day')}, all elapsed` : row.state === 'ahead' ? `${f.plural(row.days, 'day')}, none elapsed yet` : `${formatNumber(row.recognisedDays)} of ${f.plural(row.days, 'day')} elapsed`}
                    </div>
                  </div>
                  <div className="rv-row__aside">
                    <Inline gap={3} justify="end">
                      <Badge tone={row.state === 'earned' ? 'success' : row.state === 'running' ? 'brand' : 'neutral'} size="sm">
                        {row.state === 'earned' ? 'Earned' : row.state === 'running' ? 'Earning' : 'Ahead'}
                      </Badge>
                      <span className="rv-num">{moneyIn(f, row.amount, range.currency)}</span>
                    </Inline>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Stack>
    </Drawer>
  );
}
