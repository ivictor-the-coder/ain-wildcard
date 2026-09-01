/**
 * Prepaid credit: what has been granted, what is left, what it paid for.
 *
 * The ledger is the balance here — nothing on this screen reads a stored
 * number, because there is no stored balance to read. Every grant's history
 * re-adds on load and the endpoint says whether it reconciled, so the running
 * balance in the table is checkable rather than decorative.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, useMutation, useQuery, type ApiClientError, type ListEnvelope } from '../../kernel/api';
import { useNavigate, useSearchParam } from '../../kernel/router';
import {
  Badge, Banner, BarChart, Button, Card, DataTable, DatePicker, DescriptionList, Drawer,
  EmptyState, Field, Grid, Icons, Inline, Input, Modal, Page, Section,
  SegmentedControl, Select, Skeleton, Spinner, Stack, Stat, formatNumber, humanize, pluralize,
  useDebouncedValue, useFormat, useToast,
  type DataTableColumn, type MenuSection,
  AlertTriangleIcon, ArrowRightIcon, CreditCardIcon, RotateCcwIcon,
} from '../../design';
import {
  BasisNote, ChartSkeleton, CurrencyControl, CustomerName, EmptyBody, ExportCsvButton, LiveMoneyInput,
  LiveNumberInput, Loading, RangeControl, SectionError, StatusChip, boundaryDate, boundaryRange,
  csvAmount, csvDay, csvInstant, moneyAxis, monthLabel, moneyIn, rateText, unitNoun,
  units, useCustomerNames, useDefaultCurrency, useRevenueRange, useSticky, useTabParam,
  useUrlTableState, visibleRows,
  type CsvColumn,
} from './common';
import type {
  CreditBalance, CreditGrant, CreditLedgerEntry, CreditLedgerResponse, CreditRefund, CreditSettlement,
  CreditBillableItem, CreditsOverview, CreditTopUp, Meter, MeterUsage, OpenInvoice, PriceLite,
  PricePreview, RevenueMrr, RevenueUsage,
} from './types';

const DAY_MS = 86_400_000;

/** The states `/v1/credits/overview` counts in `grants.total`, in reading order. */
const GRANT_STATES = ['active', 'scheduled', 'exhausted', 'expired', 'voided'] as const;

const errorFor = (error: ApiClientError | null, param: string): string | undefined =>
  (error && error.param === param ? error.body.message : undefined);
const generalError = (error: ApiClientError | null, params: string[]): string | null =>
  (error && (!error.param || !params.includes(error.param)) ? error.body.message : null);

/** A grant's balance reads in money or in a meter's own units, never in both. */
const grantAmount = (f: ReturnType<typeof useFormat>, grant: CreditGrant, amount: number): string =>
  (grant.kind === 'monetary'
    ? moneyIn(f, amount, grant.currency)
    // A unit balance can be fractional — a settlement draws exactly what the
    // meter measured — so it keeps its decimals rather than rounding the
    // customer's remaining events to something they never had.
    : units(f, amount, grant.unit_label));

/**
 * "7 grants / 4 active · 2 scheduled · 1 expired" adds up until somebody voids
 * one. Counting the states actually present, from the same list the table is
 * drawn from, keeps the caption equal to the headline whatever happens.
 */
function grantBreakdown(grants: CreditGrant[], total: number): string {
  const counts = new Map<string, number>();
  for (const grant of grants) counts.set(grant.status, (counts.get(grant.status) ?? 0) + 1);
  const parts = GRANT_STATES
    .filter((state) => (counts.get(state) ?? 0) > 0)
    .map((state) => `${counts.get(state)} ${state}`);
  if (!parts.length) return 'none issued yet';
  const counted = [...counts.values()].reduce((sum, n) => sum + n, 0);
  // The list read is capped; say so rather than print a breakdown of a subset
  // beneath a headline of the whole.
  return counted < total ? `${parts.join(' · ')} of the ${formatNumber(counted)} most recent` : parts.join(' · ');
}

/* =================================== page ================================= */

type CreditsTab = 'ledger' | 'settlements' | 'pending';
const CREDITS_TABS = ['ledger', 'settlements', 'pending'] as const;

export function CreditsPage() {
  const f = useFormat();
  const toast = useToast();
  const names = useCustomerNames();
  const defaultCurrency = useDefaultCurrency();
  const range = useRevenueRange(defaultCurrency);

  const overview = useQuery<CreditsOverview>('/v1/credits/overview');
  const grants = useQuery<ListEnvelope<CreditGrant>>('/v1/credit-grants', { limit: 500 });
  const usage = useSticky(useQuery<RevenueUsage>('/v1/revenue/usage', range.query));
  const books = useQuery<RevenueMrr>('/v1/revenue/mrr', { months: range.months });

  // `?new=grant|topup|settle` so the command palette can open the dialog it
  // names rather than dropping the operator on the page beside it.
  const [newParam, setNewParam] = useSearchParam('new');
  const [granting, setGranting] = useState(false);
  const [toppingUp, setToppingUp] = useState(false);
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    if (!newParam) return;
    if (newParam === 'grant') setGranting(true);
    else if (newParam === 'topup') setToppingUp(true);
    else if (newParam === 'settle') setSettling(true);
    setNewParam(undefined);
  }, [newParam, setNewParam]);
  const [openGrant, setOpenGrant] = useState<CreditGrant | null>(null);
  const [editing, setEditing] = useState<CreditGrant | null>(null);
  const [voiding, setVoiding] = useState<CreditGrant | null>(null);
  const [refunding, setRefunding] = useState<CreditGrant | null>(null);
  const [tab, setTab] = useTabParam<CreditsTab>('record', CREDITS_TABS, 'ledger');
  const grantTable = useUrlTableState('g', { columnId: 'balance', direction: 'desc' });

  const rows = grants.data?.data ?? [];
  const stats = overview.data;

  const columns: DataTableColumn<CreditGrant>[] = useMemo(() => [
    {
      id: 'name', header: 'Grant', pinned: true, accessor: (row) => row.name,
      cell: (row) => (
        <div className="rv-cell">
          <span className="rv-cell__top">{row.name}</span>
          <span className="rv-cell__sub"><CustomerName id={row.customer} names={names} /></span>
        </div>
      ),
      width: 260,
    },
    { id: 'status', header: 'Status', accessor: (row) => row.status, filter: 'set', cell: (row) => <StatusChip status={row.status} />, width: 130 },
    { id: 'category', header: 'Category', accessor: (row) => row.category, filter: 'set', cell: (row) => <Badge tone={row.category === 'paid' ? 'brand' : 'neutral'} size="sm">{humanize(row.category)}</Badge>, width: 130 },
    { id: 'currency', header: 'Currency', accessor: (row) => row.currency.toUpperCase(), filter: 'set', width: 110, defaultHidden: true },
    {
      id: 'amount', header: 'Granted', align: 'right', accessor: (row) => row.amount, filter: 'number',
      cell: (row) => <span className="rv-num">{grantAmount(f, row, row.amount)}</span>,
    },
    {
      id: 'balance', header: 'Balance', align: 'right', accessor: (row) => row.balance, filter: 'number',
      cell: (row) => <span className={`rv-num${row.balance === 0 ? ' rv-muted' : ''}`}>{grantAmount(f, row, row.balance)}</span>,
    },
    { id: 'applies_to', header: 'Pays for', accessor: (row) => row.applies_to, cell: (row) => <span className="rv-sub">{row.applies_to}</span>, width: 220 },
    {
      id: 'expires_at', header: 'Expires', accessor: (row) => row.expires_at ?? 0, filter: 'date',
      cell: (row) => (row.expires_at === null
        ? <span className="rv-muted">Never</span>
        : (
          <div className="rv-cell">
            <span className="rv-cell__top">{boundaryDate(f, row.expires_at)}</span>
            <span className="rv-cell__sub">{row.expires_at > f.now() ? f.relative(row.expires_at) : 'lapsed'}</span>
          </div>
        )),
      width: 160,
    },
  ], [f, names]);

  const shownGrants = visibleRows(rows, columns, grantTable.state);

  const rowActions = (row: CreditGrant): MenuSection[] => [{
    id: 'grant',
    items: [
      { id: 'ledger', label: 'Open the ledger', icon: <Icons.list size={14} />, onSelect: () => setOpenGrant(row) },
      { id: 'edit', label: 'Edit name, priority or expiry', icon: <Icons.edit size={14} />, onSelect: () => setEditing(row) },
      {
        id: 'refund',
        label: 'Refund unused credit',
        icon: <RotateCcwIcon size={14} />,
        disabled: row.category !== 'paid' || row.balance <= 0,
        onSelect: () => setRefunding(row),
      },
      {
        id: 'void',
        label: 'Void the remaining balance',
        icon: <Icons.trash size={14} />,
        danger: true,
        disabled: row.status === 'voided' || row.status === 'expired',
        onSelect: () => setVoiding(row),
      },
    ],
  }];

  return (
    <Page
      title="Credits"
      eyebrow="Insights"
      subtitle="Prepaid balances, the ledger that is the balance, and what credit absorbed before a customer was charged for it."
      actions={
        <Inline gap={3} wrap>
          <Button variant="secondary" iconLeft={<Icons.receipt size={15} />} onClick={() => setSettling(true)}>Settle a period</Button>
          <Button variant="secondary" iconLeft={<CreditCardIcon size={15} />} onClick={() => setToppingUp(true)}>Sell a pack</Button>
          <Button variant="primary" iconLeft={<Icons.plus size={15} />} onClick={() => setGranting(true)}>Issue credit</Button>
        </Inline>
      }
    >
      <Stack gap={7}>
        {overview.error && <Card><SectionError error={overview.error} path="GET /v1/credits/overview" onRetry={overview.refetch} /></Card>}
        {!overview.error && !stats && <div className="rv-tiles">{[0, 1, 2, 3, 4].map((i) => <Card key={i} padding="tight"><Skeleton height={70} /></Card>)}</div>}
        {stats && (
          <>
            {stats.expiring_within_7_days.length > 0 && (
              <Banner tone="warning" title={`${f.plural(stats.expiring_within_7_days.length, 'grant')} expiring within seven days`}>
                  {f.list(stats.expiring_within_7_days.map((g) => `${names.name(g.customer)} — ${g.name}${g.expires_at ? `, ${boundaryDate(f, g.expires_at)}` : ''}`))}
                {'. A customer whose credit runs out mid-period is about to get a bill they are not expecting.'}
              </Banner>
            )}
            {stats.unbilled_purchases.count > 0 && (
              <Banner tone="danger" title={`${f.plural(stats.unbilled_purchases.count, 'credit purchase')} nobody has been charged for`}>
                {`${moneyIn(f, stats.unbilled_purchases.amount_total, defaultCurrency)} of credit was bought and never invoiced, so ${f.plural(stats.unbilled_purchases.held_grants, 'grant')} is held and unspendable.`}
              </Banner>
            )}
            <div className="rv-tiles">
              <Card padding="tight">
                <Stat
                  label="Grants"
                  value={formatNumber(stats.grants.total)}
                  /* The headline counts every grant ever issued, so the caption
                     has to enumerate every state or the parts will not add up
                     to it — which is exactly the arithmetic a reader checks on
                     a screen whose argument is that everything reconciles. */
                  caption={grantBreakdown(rows, stats.grants.total)}
                />
              </Card>
              {stats.outstanding.map((row) => (
                <Card padding="tight" key={row.currency}>
                  <Stat
                    label={`Outstanding · ${row.currency.toUpperCase()}`}
                    value={row.monetary_outstanding_display}
                    caption={row.unit_pots ? `${f.plural(row.unit_pots, 'unit pot')} alongside it` : 'monetary credit only'}
                  />
                </Card>
              ))}
              <Card padding="tight">
                <Stat
                  label="Pending invoice lines"
                  value={formatNumber(stats.pending_invoice_lines.count)}
                  caption={stats.pending_invoice_lines.oldest_at ? `oldest waiting ${f.duration(stats.pending_invoice_lines.oldest_age_ms)}` : 'nothing waiting'}
                />
              </Card>
            </div>
          </>
        )}

        <Section
          title="Credit grants"
          description="Every promise this workspace has made: how much, against what, and between which two instants."
        >
          <Card padding="none">
            <DataTable
              rows={rows}
              columns={columns}
              getRowId={(row) => row.id}
              caption="Credit grants"
              loading={grants.loading}
              error={grants.error ? { message: grants.error.body?.message, code: grants.error.body?.code, requestId: grants.error.body?.request_id } : null}
              onRetry={grants.refetch}
              onRowClick={setOpenGrant}
              rowActions={rowActions}
              searchPlaceholder="Search grants and accounts…"
              value={grantTable.state}
              onChange={grantTable.setState}
              toolbar={(
                <Inline gap={3} wrap>
                  <span className="rv-sub">
                    {shownGrants.length === rows.length
                      ? f.plural(rows.length, 'grant')
                      : `${formatNumber(shownGrants.length)} of ${f.plural(rows.length, 'grant')}`}
                  </span>
                  <ExportCsvButton
                    name="credit-grants"
                    noun="grant"
                    rows={shownGrants}
                    columns={[
                      { header: 'Grant', value: (row) => row.name },
                      { header: 'Grant id', value: (row) => row.id },
                      { header: 'Customer', value: (row) => names.name(row.customer) },
                      { header: 'Status', value: (row) => row.status },
                      { header: 'Category', value: (row) => row.category },
                      { header: 'Denomination', value: (row) => (row.kind === 'monetary' ? 'money' : unitNoun(2, row.unit_label)) },
                      { header: 'Currency', value: (row) => row.currency.toUpperCase() },
                      { header: 'Granted', value: (row) => (row.kind === 'monetary' ? csvAmount(row.amount, row.currency) : row.amount) },
                      { header: 'Balance', value: (row) => (row.kind === 'monetary' ? csvAmount(row.balance, row.currency) : row.balance) },
                      { header: 'Pays for', value: (row) => row.applies_to },
                      { header: 'Effective', value: (row) => csvDay(row.effective_at) },
                      { header: 'Expires', value: (row) => csvDay(row.expires_at) },
                      { header: 'Priority', value: (row) => row.priority },
                    ] satisfies CsvColumn<CreditGrant>[]}
                  />
                </Inline>
              )}
              maxHeight={560}
              empty={(
                <EmptyState
                  title="No credit has been issued yet"
                  body={<EmptyBody>A grant is a promise: this customer may draw this much, against these charges.</EmptyBody>}
                  action={<Button variant="primary" iconLeft={<Icons.plus size={15} />} onClick={() => setGranting(true)}>Issue credit</Button>}
                  secondaryAction={<Button variant="secondary" onClick={() => setToppingUp(true)}>Sell a credit pack</Button>}
                />
              )}
            />
          </Card>
        </Section>

        <Section
          title="Burn-down"
          description="What usage was worth, how much of it prepaid credit absorbed, and what was charged."
          actions={
            <Inline gap={3} wrap>
              <RangeControl range={range} />
              <CurrencyControl range={range} scope={books.data?.basis.currency} />
              <BasisNote basis={usage.data?.basis} sources={usage.data?.sources} label="How the burn-down was computed" />
            </Inline>
          }
        >
          <BurnDown usage={usage} currency={range.currency} />
        </Section>

        <Section title="The record">
          <Card padding="none">
            <div style={{ padding: 'var(--space-5) var(--space-5) 0' }}>
              <SegmentedControl
                aria-label="Credit record"
                value={tab}
                onChange={setTab}
                options={[
                  { value: 'ledger', label: 'Ledger' },
                  { value: 'settlements', label: 'Settlements' },
                  { value: 'pending', label: 'Lines waiting to be invoiced' },
                ]}
              />
            </div>
            {tab === 'ledger' && <WorkspaceLedger names={names} grants={rows} />}
            {tab === 'settlements' && <SettlementsTable names={names} onSettle={() => setSettling(true)} />}
            {tab === 'pending' && <PendingLines names={names} />}
          </Card>
        </Section>
      </Stack>

      <GrantModal open={granting} onClose={() => setGranting(false)} onSaved={(g) => { toast.success(`${grantAmount(f, g, g.amount)} issued to ${names.name(g.customer)}`); setGranting(false); }} />
      <TopUpModal open={toppingUp} onClose={() => setToppingUp(false)} />
      <SettleModal open={settling} onClose={() => setSettling(false)} />
      {openGrant && <GrantLedgerDrawer grant={openGrant} onClose={() => setOpenGrant(null)} names={names} />}
      {editing && <EditGrantModal grant={editing} onClose={() => setEditing(null)} />}
      {voiding && <VoidGrantDialog grant={voiding} onClose={() => setVoiding(null)} />}
      {refunding && <RefundGrantModal grant={refunding} onClose={() => setRefunding(null)} />}
    </Page>
  );
}

/* ================================ burn-down =============================== */

/** What share of the metered value the customer actually paid for. */
function chargedShare(charged: number | null, meteredValue: number | null): string {
  if (charged === null || !meteredValue) return 'nothing metered in this window';
  return `${((charged / meteredValue) * 100).toFixed(2)}% of the metered value`;
}

function BurnDown({ usage, currency }: { usage: ReturnType<typeof useSticky<RevenueUsage>>; currency: string }) {
  const f = useFormat();
  const data = usage.data;
  const months = useMemo(() => (data?.series ?? []).filter((row) => (row.metered_value ?? 0) > 0), [data]);

  if (usage.error) return <Card><SectionError error={usage.error} path="GET /v1/revenue/usage" onRetry={usage.refetch} /></Card>;
  if (!data) return <Card><ChartSkeleton /></Card>;

  return (
    <div className="rv-cols">
      <Card title="Covered against charged" description="Each month of settled usage, split into the part credit absorbed and the part the customer paid for.">
        {months.length === 0
          ? (
            <EmptyState
              size="sm"
              title="No usage has been settled in this window"
              body={<EmptyBody>A settlement prices a metered period, draws credit against it and freezes the meter window. Settle one and the split appears here.</EmptyBody>}
            />
          )
          : (
            <BarChart
              title="Credit burn-down"
              description="Credit-covered and charged usage by month."
              stacked
              categories={months.map((row) => monthLabel(row.month, f))}
              series={[
                { id: 'covered', label: 'Covered by credit', values: months.map((row) => row.credit_covered ?? 0) },
                { id: 'charged', label: 'Charged', values: months.map((row) => row.charged ?? 0) },
              ]}
              height={260}
              valueFormat={moneyAxis(f, currency, months.map((row) => (row.credit_covered ?? 0) + (row.charged ?? 0)))}
            />
          )}
      </Card>
      <Card title="Over the window">
        <Stack gap={5}>
          <Grid minColumnWidth={130} gap={5}>
            <Stat size="sm" label="Metered value" value={moneyIn(f, data.totals.metered_value, currency)} caption={f.plural(data.totals.settlements, 'settlement')} />
            <Stat size="sm" label="Covered by credit" value={moneyIn(f, data.totals.credit_covered, currency)} caption="never reached an invoice" />
            {/* The caption under a figure has to be a statement about that
                figure. `overage_share_of_invoiced` counts only the charged
                usage that reached a finalised invoice, which is a different
                numerator from the one above it — so it gets its own tile and
                this one is captioned from the split it belongs to. */}
            <Stat
              size="sm"
              label="Charged"
              value={moneyIn(f, data.totals.charged, currency)}
              caption={chargedShare(data.totals.charged, data.totals.metered_value)}
            />
            <Stat
              size="sm"
              label="Reached an invoice"
              value={rateText(data.totals.overage_share_of_invoiced)}
              caption={data.totals.overage_share_of_invoiced && !data.totals.overage_share_of_invoiced.undefined_rate
                ? `${moneyIn(f, data.totals.overage_share_of_invoiced.numerator, currency)} of ${moneyIn(f, data.totals.overage_share_of_invoiced.denominator, currency)} invoiced`
                : 'nothing was invoiced in this window'}
            />
            <Stat size="sm" label="Credit bought" value={moneyIn(f, data.credit.purchased, currency)} caption={f.plural(data.credit.purchase_lines, 'purchase line')} />
          </Grid>
          {data.meters.length > 0 && (
            <div className="rv-rows">
              {data.meters.map((meter) => (
                <div className="rv-row" key={meter.meter}>
                  <div className="rv-row__main">
                    <div className="rv-row__title">{meter.name}</div>
                    <div className="rv-row__sub">
                      {moneyIn(f, meter.credit_covered, meter.currency)} covered · {rateText(meter.charged_share)} charged
                    </div>
                  </div>
                  <div className="rv-row__aside">{moneyIn(f, meter.metered_value, meter.currency)}</div>
                </div>
              ))}
            </div>
          )}
          <Banner tone={data.reconciliation.balanced ? 'success' : 'danger'} compact title={data.reconciliation.balanced ? 'Every check balances' : 'A check failed'}>
            {data.reconciliation.balanced
              ? `${f.plural(data.reconciliation.checks.length, 'reconciliation')} passed: covered plus charged equals the metered value, and the ledger's own components equal its balance.`
              : (data.reconciliation.note ?? f.list(data.reconciliation.checks.filter((c) => !c.ok).map((c) => c.description)))}
          </Banner>
        </Stack>
      </Card>
    </div>
  );
}

/* ================================= ledger ================================= */

function WorkspaceLedger({
  names, grants,
}: { names: ReturnType<typeof useCustomerNames>; grants: CreditGrant[] }) {
  const f = useFormat();
  const table = useUrlTableState('l', { columnId: 'created', direction: 'desc' });
  const entries = useQuery<ListEnvelope<CreditLedgerEntry>>('/v1/credit-ledger', { limit: 500 });
  const rows = entries.data?.data ?? [];
  // A ledger entry carries its denomination but not the unit it is denominated
  // in, and "+1,000,000" in a column whose neighbouring row reads "$2,760.00"
  // is a million dollars to anyone reading quickly. The grant knows the noun.
  const unitOf = useMemo(() => {
    const index = new Map(grants.map((grant) => [grant.id, grant.unit_label]));
    return (entry: CreditLedgerEntry) => index.get(entry.grant) ?? null;
  }, [grants]);

  const columns: DataTableColumn<CreditLedgerEntry>[] = useMemo(() => [
    {
      id: 'created', header: 'When', pinned: true, accessor: (row) => row.created, filter: 'date',
      cell: (row) => (
        <div className="rv-cell">
          <span className="rv-cell__top rv-nowrap">{f.dateTime(row.created)}</span>
          <span className="rv-cell__sub">seq {row.seq}</span>
        </div>
      ),
      width: 190,
    },
    { id: 'customer', header: 'Customer', accessor: (row) => names.name(row.customer), cell: (row) => <CustomerName id={row.customer} names={names} />, width: 200 },
    { id: 'type', header: 'Movement', accessor: (row) => row.type, filter: 'set', cell: (row) => <Badge tone={row.delta >= 0 ? 'success' : 'neutral'} size="sm">{humanize(row.type)}</Badge>, width: 140 },
    {
      id: 'delta', header: 'Change', align: 'right', accessor: (row) => row.delta, filter: 'number',
      cell: (row) => (
        <span className={`rv-num ${row.delta >= 0 ? 'rv-ledger__delta--in' : 'rv-ledger__delta--out'}`}>
          {row.kind === 'monetary'
            ? moneyIn(f, row.delta, row.currency)
            : `${formatNumber(row.delta, { signDisplay: 'exceptZero', maxDecimals: 2 })} ${unitNoun(row.delta, unitOf(row))}`}
        </span>
      ),
    },
    {
      id: 'balance_after', header: 'Balance after', align: 'right', accessor: (row) => row.balance_after,
      cell: (row) => (
        <span className="rv-num">
          {row.kind === 'monetary' ? moneyIn(f, row.balance_after, row.currency) : units(f, row.balance_after, unitOf(row))}
        </span>
      ),
    },
    { id: 'reason', header: 'Reason', accessor: (row) => row.reason, cell: (row) => <span className="rv-sub">{row.reason}</span> },
  ], [f, names, unitOf]);

  const shown = visibleRows(rows, columns, table.state);

  return (
    <DataTable
      className="rv-ledger"
      rows={rows}
      columns={columns}
      getRowId={(row) => row.id}
      caption="Every credit movement"
      loading={entries.loading}
      error={entries.error ? { message: entries.error.body?.message, code: entries.error.body?.code, requestId: entries.error.body?.request_id } : null}
      onRetry={entries.refetch}
      plain
      maxHeight={520}
      searchPlaceholder="Search movements…"
      value={table.state}
      onChange={table.setState}
      toolbar={(
        <Inline gap={3} wrap>
          <span className="rv-sub">
            {shown.length === rows.length
              ? f.plural(rows.length, 'movement')
              : `${formatNumber(shown.length)} of ${f.plural(rows.length, 'movement')}`}
          </span>
          <ExportCsvButton
            name="credit-ledger"
            noun="movement"
            rows={shown}
            columns={[
              { header: 'When', value: (row) => csvInstant(row.created) },
              { header: 'Sequence', value: (row) => row.seq },
              { header: 'Customer', value: (row) => names.name(row.customer) },
              { header: 'Grant', value: (row) => row.grant },
              { header: 'Movement', value: (row) => row.type },
              { header: 'Denomination', value: (row) => (row.kind === 'monetary' ? 'money' : unitNoun(2, unitOf(row))) },
              { header: 'Change', value: (row) => (row.kind === 'monetary' ? csvAmount(row.delta, row.currency) : row.delta) },
              { header: 'Balance after', value: (row) => (row.kind === 'monetary' ? csvAmount(row.balance_after, row.currency) : row.balance_after) },
              { header: 'Currency', value: (row) => (row.kind === 'monetary' ? row.currency.toUpperCase() : '') },
              { header: 'Reason', value: (row) => row.reason },
            ] satisfies CsvColumn<CreditLedgerEntry>[]}
          />
        </Inline>
      )}
      empty={<EmptyState title="The ledger is empty" body="Nothing has been granted, burned, expired or refunded yet." />}
    />
  );
}

function GrantLedgerDrawer({
  grant, onClose, names,
}: { grant: CreditGrant; onClose: () => void; names: ReturnType<typeof useCustomerNames> }) {
  const f = useFormat();
  const navigate = useNavigate();
  const ledger = useQuery<CreditLedgerResponse>(`/v1/credit-grants/${grant.id}/ledger`, { limit: 500 });
  const entries = ledger.data?.entries ?? [];

  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={grant.name}
      description={<><CustomerName id={grant.customer} names={names} /> {` · ${grant.applies_to}`}</>}
      actions={<Button variant="secondary" size="sm" onClick={() => navigate(`/billing/customers/${grant.customer}`)}>Open the account</Button>}
    >
      <Stack gap={6}>
        <Grid minColumnWidth={150} gap={5}>
          <Stat size="sm" label="Granted" value={grantAmount(f, grant, grant.amount)} caption={humanize(grant.category)} />
          <Stat size="sm" label="Balance" value={grantAmount(f, grant, grant.balance)} caption={grant.status === 'active' ? 'spendable now' : humanize(grant.status)} />
          <Stat size="sm" label="Effective" value={boundaryDate(f, grant.effective_at)} caption={grant.expires_at ? `expires ${boundaryDate(f, grant.expires_at)}` : 'never expires'} />
          <Stat size="sm" label="Priority" value={formatNumber(grant.priority)} caption={`rollover: ${humanize(grant.rollover)}`} />
        </Grid>

        {ledger.data && (
          <Banner tone={ledger.data.reconciled ? 'success' : 'danger'} compact title={ledger.data.reconciled ? 'The ledger reconciles' : 'The ledger does not reconcile'}>
            {ledger.data.reconciled
              ? `Re-adding every delta on read gives ${grantAmount(f, grant, ledger.data.closing)}, which is the balance each entry carries. Nothing here is a stored number.`
              : 'Re-adding the deltas does not reproduce the running balance carried on the entries. Do not spend against this grant until it is investigated.'}
          </Banner>
        )}

        {ledger.error && <SectionError error={ledger.error} path={`GET /v1/credit-grants/${grant.id}/ledger`} onRetry={ledger.refetch} />}
        {!ledger.error && ledger.loading && <Loading label="Re-adding the ledger…" />}

        {entries.length > 0 && (
          <Card padding="none">
            <table className="rv-ledger" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <caption className="u-visually-hidden">Ledger entries with the running balance</caption>
              <thead>
                <tr>
                  {['Seq', 'When', 'Movement', 'Change', 'Balance after', 'Reason'].map((headCell) => (
                    <th
                      key={headCell}
                      scope="col"
                      style={{
                        textAlign: headCell === 'Change' || headCell === 'Balance after' ? 'end' : 'start',
                        padding: 'var(--space-4) var(--space-5)',
                        fontSize: 'var(--text-2xs)',
                        letterSpacing: 'var(--tracking-wide)',
                        textTransform: 'uppercase',
                        color: 'var(--text-tertiary)',
                        borderBlockEnd: '1px solid var(--border-default)',
                      }}
                    >
                      {headCell}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td style={{ padding: 'var(--space-4) var(--space-5)', borderBlockEnd: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)' }}>{entry.seq}</td>
                    <td style={{ padding: 'var(--space-4) var(--space-5)', borderBlockEnd: '1px solid var(--border-subtle)', whiteSpace: 'nowrap', fontSize: 'var(--text-sm)' }}>{f.dateTime(entry.created)}</td>
                    <td style={{ padding: 'var(--space-4) var(--space-5)', borderBlockEnd: '1px solid var(--border-subtle)' }}><Badge size="sm" tone={entry.delta >= 0 ? 'success' : 'neutral'}>{humanize(entry.type)}</Badge></td>
                    <td className={entry.delta >= 0 ? 'rv-ledger__delta--in' : 'rv-ledger__delta--out'} style={{ padding: 'var(--space-4) var(--space-5)', borderBlockEnd: '1px solid var(--border-subtle)', textAlign: 'end', fontSize: 'var(--text-sm)' }}>
                      {grant.kind === 'monetary'
                        ? moneyIn(f, entry.delta, entry.currency)
                        : `${formatNumber(entry.delta, { signDisplay: 'exceptZero', maxDecimals: 2 })} ${unitNoun(entry.delta, grant.unit_label)}`}
                    </td>
                    <td style={{ padding: 'var(--space-4) var(--space-5)', borderBlockEnd: '1px solid var(--border-subtle)', textAlign: 'end', fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)' }}>
                      {grantAmount(f, grant, entry.balance_after)}
                    </td>
                    <td style={{ padding: 'var(--space-4) var(--space-5)', borderBlockEnd: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', fontSize: 'var(--text-xs)' }}>{entry.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Stack>
    </Drawer>
  );
}

/* ============================== settlements =============================== */

function SettlementsTable({ names, onSettle }: { names: ReturnType<typeof useCustomerNames>; onSettle: () => void }) {
  const f = useFormat();
  const table = useUrlTableState('s', { columnId: 'period', direction: 'desc' });
  const settlements = useQuery<ListEnvelope<CreditSettlement>>('/v1/credit-settlements', { status: 'all', limit: 200 });
  const [open, setOpen] = useState<CreditSettlement | null>(null);
  const rows = settlements.data?.data ?? [];

  const columns: DataTableColumn<CreditSettlement>[] = useMemo(() => [
    { id: 'customer', header: 'Customer', pinned: true, accessor: (row) => names.name(row.customer), cell: (row) => <CustomerName id={row.customer} names={names} />, width: 210 },
    { id: 'period', header: 'Period', accessor: (row) => row.period_start, cell: (row) => <span className="rv-nowrap">{boundaryRange(f, row.period_start, row.period_end)}</span>, width: 200 },
    { id: 'status', header: 'Status', accessor: (row) => row.status, filter: 'set', cell: (row) => <StatusChip status={row.status} />, width: 120 },
    { id: 'quantity', header: 'Quantity', align: 'right', accessor: (row) => row.quantity, cell: (row) => <span className="rv-num">{formatNumber(row.quantity)}</span> },
    { id: 'full_amount', header: 'Worth', align: 'right', accessor: (row) => row.full_amount, cell: (row) => <span className="rv-num">{moneyIn(f, row.full_amount, row.currency)}</span> },
    { id: 'covered_amount', header: 'Covered', align: 'right', accessor: (row) => row.covered_amount, cell: (row) => <span className="rv-num rv-num--pos">{moneyIn(f, row.covered_amount, row.currency)}</span> },
    { id: 'charged_amount', header: 'Charged', align: 'right', accessor: (row) => row.charged_amount, cell: (row) => <span className="rv-num">{moneyIn(f, row.charged_amount, row.currency)}</span> },
  ], [f, names]);

  return (
    <>
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        caption="Settled usage periods"
        loading={settlements.loading}
        error={settlements.error ? { message: settlements.error.body?.message, code: settlements.error.body?.code, requestId: settlements.error.body?.request_id } : null}
        onRetry={settlements.refetch}
        onRowClick={setOpen}
        plain
        maxHeight={520}
        searchPlaceholder="Search settlements…"
        value={table.state}
        onChange={table.setState}
        toolbar={(
          <ExportCsvButton
            name="credit-settlements"
            noun="settlement"
            rows={visibleRows(rows, columns, table.state)}
            columns={[
              { header: 'Customer', value: (row) => names.name(row.customer) },
              { header: 'Period start', value: (row) => csvDay(row.period_start) },
              { header: 'Period end', value: (row) => csvDay(row.period_end) },
              { header: 'Status', value: (row) => row.status },
              { header: 'Quantity', value: (row) => row.quantity },
              { header: 'Covered quantity', value: (row) => row.covered_quantity },
              { header: 'Currency', value: (row) => row.currency.toUpperCase() },
              { header: 'Worth', value: (row) => csvAmount(row.full_amount, row.currency) },
              { header: 'Covered by credit', value: (row) => csvAmount(row.covered_amount, row.currency) },
              { header: 'Charged', value: (row) => csvAmount(row.charged_amount, row.currency) },
              { header: 'Settled at', value: (row) => csvInstant(row.created) },
            ] satisfies CsvColumn<CreditSettlement>[]}
          />
        )}
        empty={(
          <EmptyState
            title="No usage period has been settled"
            body={<EmptyBody>Settling prices a metered window, draws credit against it, and freezes the meter.</EmptyBody>}
            action={<Button variant="primary" iconLeft={<Icons.receipt size={15} />} onClick={onSettle}>Settle a period</Button>}
          />
        )}
      />
      {open && <SettlementDrawer settlement={open} onClose={() => setOpen(null)} names={names} />}
    </>
  );
}

function SettlementDrawer({
  settlement, onClose, names,
}: { settlement: CreditSettlement; onClose: () => void; names: ReturnType<typeof useCustomerNames> }) {
  const f = useFormat();
  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={`${names.name(settlement.customer)} — ${boundaryRange(f, settlement.period_start, settlement.period_end)}`}
      description={settlement.status === 'skipped' ? (settlement.skip?.explanation ?? 'This period was refused.') : 'What the period was worth, what credit absorbed, and what was billed.'}
    >
      <Stack gap={6}>
        <Grid minColumnWidth={140} gap={5}>
          <Stat size="sm" label="Quantity" value={formatNumber(settlement.quantity)} caption={`${formatNumber(settlement.covered_quantity)} covered`} />
          <Stat size="sm" label="Full amount" value={moneyIn(f, settlement.full_amount, settlement.currency)} caption="priced from the tier basis" />
          <Stat size="sm" label="Covered" value={moneyIn(f, settlement.covered_amount, settlement.currency)} caption="paid by prepaid credit" />
          <Stat size="sm" label="Charged" value={moneyIn(f, settlement.charged_amount, settlement.currency)} caption="raised as an invoice line" />
        </Grid>

        {settlement.applications.length > 0 && (
          <Card title="Which grants paid" description="Drawn in the burn-down order: eligible first, then soonest expiry, then promotional before paid.">
            <div className="rv-rows">
              {settlement.applications.map((application) => (
                <div className="rv-row" key={application.ledger_entry}>
                  <div className="rv-row__main">
                    <div className="rv-row__title">{application.grant_name}</div>
                    <div className="rv-row__sub">
                      {humanize(application.category)} · {humanize(application.kind)}
                      {application.expires_at ? ` · expires ${boundaryDate(f, application.expires_at)}` : ''}
                    </div>
                  </div>
                  <div className="rv-row__aside">
                    <div className="rv-num">{moneyIn(f, application.amount, settlement.currency)}</div>
                    <div className="rv-sub">{formatNumber(application.drawn)} drawn · {formatNumber(application.balance_after)} left</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        <Card title="Invoice lines" description="The credit-covered portion and the charged portion always sum to the full amount.">
          <div className="rv-rows">
            {[...settlement.lines, ...settlement.true_ups].map((line) => (
              <div className="rv-row" key={line.id}>
                <div className="rv-row__main">
                  <div className="rv-row__title">{line.description}</div>
                  <div className="rv-row__sub">{humanize(line.kind)} · {humanize(line.status)}{line.invoice ? ` on ${line.invoice}` : ''}</div>
                </div>
                <div className="rv-row__aside">
                  <div className="rv-num">{moneyIn(f, line.billed_amount, line.currency)}</div>
                  {line.credit_applied !== 0 && <div className="rv-sub">{moneyIn(f, line.credit_applied, line.currency)} from credit</div>}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Burn-down order">
          <ol className="rv-basis__list">{settlement.burn_order.map((rule) => <li key={rule}>{rule}</li>)}</ol>
        </Card>
      </Stack>
    </Drawer>
  );
}

/**
 * Lines credit has produced that no invoice has claimed yet.
 *
 * This is an outbox, and an outbox that cannot be flushed is a report. Raising
 * the bill is the operation that claims them — `POST /v1/invoices` sweeps every
 * pending line the account has — so it is offered here, on the rows, per
 * account, with what each bill will ask for stated before it is raised.
 */
function PendingLines({ names }: { names: ReturnType<typeof useCustomerNames> }) {
  const f = useFormat();
  const navigate = useNavigate();
  const table = useUrlTableState('p');
  const items = useQuery<ListEnvelope<CreditBillableItem>>('/v1/credit-billable-items', { status: 'pending', limit: 200 });
  const [invoicing, setInvoicing] = useState<CreditBillableItem[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const rows = items.data?.data ?? [];

  const linesFor = (ids: string[]) => rows.filter((row) => ids.includes(row.id));
  const accountsIn = (lines: CreditBillableItem[]) => new Set(lines.map((line) => line.customer)).size;

  const columns: DataTableColumn<CreditBillableItem>[] = useMemo(() => [
    { id: 'description', header: 'Line', pinned: true, accessor: (row) => row.description, cell: (row) => <span className="rv-cell__top">{row.description}</span>, width: 340 },
    { id: 'customer', header: 'Customer', accessor: (row) => names.name(row.customer), cell: (row) => <CustomerName id={row.customer} names={names} />, width: 200 },
    { id: 'kind', header: 'Kind', accessor: (row) => row.kind, filter: 'set', cell: (row) => <Badge size="sm" tone={row.kind === 'topup' ? 'brand' : row.kind === 'true_up' ? 'warning' : 'neutral'}>{humanize(row.kind)}</Badge>, width: 150 },
    { id: 'billed_amount', header: 'Customer pays', align: 'right', accessor: (row) => row.billed_amount, cell: (row) => <span className="rv-num">{moneyIn(f, row.billed_amount, row.currency)}</span> },
    { id: 'credit_applied', header: 'From credit', align: 'right', accessor: (row) => row.credit_applied, cell: (row) => <span className="rv-num rv-num--pos">{moneyIn(f, row.credit_applied, row.currency)}</span> },
    { id: 'period', header: 'Covers', accessor: (row) => row.period_start ?? 0, cell: (row) => (row.period_start && row.period_end ? <span className="rv-sub rv-nowrap">{boundaryRange(f, row.period_start, row.period_end)}</span> : <span className="rv-muted">—</span>), width: 190, defaultHidden: true },
    { id: 'created', header: 'Waiting since', accessor: (row) => row.created, cell: (row) => <span className="rv-sub rv-nowrap">{f.when(row.created)}</span>, width: 160 },
  ], [f, names]);

  return (
    <>
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        caption="Credit lines waiting for an invoice"
        loading={items.loading}
        error={items.error ? { message: items.error.body?.message, code: items.error.body?.code, requestId: items.error.body?.request_id } : null}
        onRetry={items.refetch}
        plain
        maxHeight={520}
        selectable
        selected={selected}
        onSelectionChange={setSelected}
        bulkActions={(ids) => {
          const lines = linesFor(ids);
          return (
            <Button
              size="sm"
              variant="primary"
              iconLeft={<Icons.invoice size={14} />}
              onClick={() => setInvoicing(lines)}
            >
              Invoice {f.plural(accountsIn(lines), 'account')}
            </Button>
          );
        }}
        rowActions={(row) => [{
          id: 'line',
          items: [
            {
              id: 'invoice',
              label: `Invoice ${names.name(row.customer)} now`,
              icon: <Icons.invoice size={14} />,
              onSelect: () => setInvoicing(rows.filter((line) => line.customer === row.customer)),
            },
            {
              id: 'account',
              label: 'Open the account',
              icon: <ArrowRightIcon size={14} />,
              onSelect: () => navigate(`/billing/customers/${row.customer}`),
            },
          ],
        }]}
        searchPlaceholder="Search pending lines…"
        value={table.state}
        onChange={table.setState}
        toolbar={(
          <ExportCsvButton
            name="credit-lines-pending"
            noun="line"
            rows={visibleRows(rows, columns, table.state)}
            columns={[
              { header: 'Line', value: (row) => row.description },
              { header: 'Customer', value: (row) => names.name(row.customer) },
              { header: 'Kind', value: (row) => row.kind },
              { header: 'Currency', value: (row) => row.currency.toUpperCase() },
              { header: 'Customer pays', value: (row) => csvAmount(row.billed_amount, row.currency) },
              { header: 'From credit', value: (row) => csvAmount(row.credit_applied, row.currency) },
              { header: 'Covers from', value: (row) => csvDay(row.period_start) },
              { header: 'Covers to', value: (row) => csvDay(row.period_end) },
              { header: 'Waiting since', value: (row) => csvInstant(row.created) },
            ] satisfies CsvColumn<CreditBillableItem>[]}
          />
        )}
        empty={(
          <EmptyState
            title="Nothing is waiting for an invoice"
            body={<EmptyBody>Top-up purchases and settled usage wait here until billing claims them onto a bill.</EmptyBody>}
            action={<Button variant="secondary" onClick={() => navigate('/billing/invoices')}>Open invoices</Button>}
          />
        )}
        footer={rows.length > 0
          ? (
            <div className="rv-chiprow" style={{ padding: 'var(--space-4) var(--space-5)', justifyContent: 'space-between' }}>
              <span className="rv-sub">
                {`${f.plural(rows.length, 'line')} across ${f.plural(accountsIn(rows), 'account')} — claimed onto a bill the next time each account is invoiced.`}
              </span>
              <Button size="sm" variant="secondary" iconLeft={<Icons.invoice size={14} />} onClick={() => setInvoicing(rows)}>
                Invoice every account
              </Button>
            </div>
          )
          : null}
      />
      {invoicing && (
        <InvoicePendingModal
          lines={invoicing}
          names={names}
          onClose={() => { setInvoicing(null); setSelected([]); }}
        />
      )}
    </>
  );
}

/**
 * Raising the bills that claim these lines.
 *
 * One invoice per account, because that is the unit billing works in — and it
 * sweeps everything else the account already owes at the same time, which is
 * stated here rather than discovered afterwards. Each outcome is reported
 * separately: a partial success is the normal case when one account's address
 * cannot be placed for tax and the rest can.
 */
function InvoicePendingModal({
  lines, names, onClose,
}: { lines: CreditBillableItem[]; names: ReturnType<typeof useCustomerNames>; onClose: () => void }) {
  const f = useFormat();
  const toast = useToast();
  const navigate = useNavigate();
  const [results, setResults] = useState<
    { customer: string; invoice: OpenInvoice | null; error: string | null; claimed: number; left: number }[] | null
  >(null);

  const accounts = useMemo(() => {
    const grouped = new Map<string, {
      customer: string; lines: CreditBillableItem[]; currency: string; due: number; credit: number;
      /** The account's own billing currency — what any bill raised for it is in. */
      billsIn: string | null;
      /** Lines a bill in that currency cannot claim. */
      mismatched: CreditBillableItem[];
    }>();
    for (const line of lines) {
      const billsIn = names.customers.find((c) => c.id === line.customer)?.currency ?? null;
      const row = grouped.get(line.customer)
        ?? { customer: line.customer, lines: [], currency: line.currency, due: 0, credit: 0, billsIn, mismatched: [] };
      row.lines.push(line);
      row.due += line.billed_amount;
      row.credit += line.credit_applied;
      // A bill is raised in the account's currency and can only carry lines in
      // that currency. Saying so before the button is pressed beats discovering
      // it in a rejected request afterwards.
      if (billsIn && line.currency !== billsIn) row.mismatched.push(line);
      grouped.set(line.customer, row);
    }
    return [...grouped.values()].sort((a, b) => b.due - a.due);
  }, [lines, names.customers]);

  // Raising a bill drains the account's whole outbox, and invoicing refuses
  // the *entire* bill the moment one of those lines is in another currency —
  // not just that line. So an account holding one is left out of the run and
  // said so, rather than offered a button that comes back "not raised".
  const blocked = accounts.filter((a) => a.mismatched.length > 0);
  const billable = accounts.filter((a) => a.mismatched.length === 0);
  const claimable = billable.flatMap((a) => a.lines);
  const claimableTotal = claimable.reduce((sum, line) => sum + line.billed_amount, 0);
  const claimableCurrency = claimable.length && claimable.every((l) => l.currency === claimable[0].currency)
    ? claimable[0].currency
    : null;

  const run = useMutation<void, { customer: string; invoice: OpenInvoice | null; error: string | null; claimed: number; left: number }[]>(
    async () => {
      const raised: { customer: string; invoice: OpenInvoice | null; error: string | null }[] = [];
      for (const account of billable) {
        try {
          const invoice = await api.post<OpenInvoice>('/v1/invoices', { customer: account.customer });
          raised.push({ customer: account.customer, invoice, error: null });
        } catch (e) {
          raised.push({ customer: account.customer, invoice: null, error: e instanceof Error ? e.message : 'The bill could not be raised' });
        }
      }
      // A bill is raised in the account's own currency and can only claim lines
      // in that currency, so "the invoice exists" is not the same as "the lines
      // are gone". Read the outbox back and say which are still in it.
      const outbox = await api.get<ListEnvelope<CreditBillableItem>>('/v1/credit-billable-items', { status: 'pending', limit: 200 });
      const stillPending = new Set(outbox.data.map((row) => row.id));
      return raised.map((row) => {
        const wanted = billable.find((a) => a.customer === row.customer)?.lines ?? [];
        const left = wanted.filter((line) => stillPending.has(line.id)).length;
        return { ...row, claimed: wanted.length - left, left };
      });
    },
    {
      invalidates: ['/v1/credit-billable-items', '/v1/credits/overview', '/v1/credit-grants', '/v1/invoices', '/v1/revenue'],
      onSuccess: (outcome) => {
        setResults(outcome);
        const raised = outcome.filter((row) => row.invoice).length;
        const claimed = outcome.reduce((sum, row) => sum + row.claimed, 0);
        const left = outcome.reduce((sum, row) => sum + row.left, 0);
        if (raised === 0) toast.error('No bill could be raised', outcome[0]?.error ?? undefined);
        else if (left === 0) toast.success(`${f.plural(raised, 'invoice')} raised`, `${f.plural(claimed, 'credit line')} claimed onto a bill.`);
        else toast.warning(`${f.plural(raised, 'invoice')} raised`, `${f.plural(claimed, 'line')} claimed; ${f.plural(left, 'line')} still waiting — named in the dialog.`);
      },
    },
  );


  return (
    <Modal
      open
      onClose={onClose}
      title={results ? 'Bills raised' : `Invoice ${f.plural(billable.length || accounts.length, 'account')}`}
      icon={<Icons.invoice size={18} />}
      iconTone="brand"
      description={results
        ? 'Each bill sweeps up everything the account owed, not only the credit lines.'
        : 'One bill per account. Raising it claims these lines — and every other proration, settled usage and credit pack the account is already carrying.'}
      size="lg"
      footer={results
        ? <Button variant="primary" onClick={onClose}>Done</Button>
        : (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              loading={run.loading}
              disabled={billable.length === 0}
              title={billable.length === 0
                ? 'Every account here is holding a line in a currency it does not bill in, and invoicing refuses the whole bill while that is true.'
                : undefined}
              onClick={() => { void run.run().catch(() => undefined); }}
            >
              {billable.length === 0
                ? 'Nothing can be billed'
                : claimableCurrency
                  ? `Raise ${f.plural(billable.length, 'bill')} · at least ${moneyIn(f, claimableTotal, claimableCurrency)}`
                  : `Raise ${f.plural(billable.length, 'bill')}`}
            </Button>
          </>
        )}
    >
      <Stack gap={5}>
        {run.error && !results && <Banner tone="danger" compact>{run.error.body.message}</Banner>}
        {!results && blocked.length > 0 && (
          <Banner tone="warning" compact title={`${f.plural(blocked.length, 'account')} cannot be billed at all`}>
            {f.list(blocked.map((a) => `${names.name(a.customer)} bills in ${(a.billsIn ?? '').toUpperCase()}, and ${f.plural(a.mismatched.length, 'line')} here ${a.mismatched.length === 1 ? 'is' : 'are'} in ${f.list([...new Set(a.mismatched.map((l) => l.currency.toUpperCase()))])}`))}
            {'. Raising a bill drains the whole outbox, and invoicing refuses the entire bill while one line is in the wrong currency — so '}
            {blocked.length === 1 ? 'that account is' : 'those accounts are'}
            {' left out of this run rather than sent into a failure.'}
          </Banner>
        )}
        {!results && (
          <>
            <div className="rv-rows">
              {accounts.map((account) => (
                <div className="rv-row" key={account.customer}>
                  <div className="rv-row__main">
                    <div className="rv-row__title"><CustomerName id={account.customer} names={names} /></div>
                    <div className="rv-row__sub">
                      {f.plural(account.lines.length, 'pending line')}
                      {account.credit !== 0 ? ` · a further ${moneyIn(f, account.credit, account.currency)} already absorbed by credit` : ''}
                      {account.mismatched.length > 0 ? ` · ${f.plural(account.mismatched.length, 'line')} not in ${(account.billsIn ?? '').toUpperCase()}` : ''}
                    </div>
                  </div>
                  <div className="rv-row__aside">
                    {account.mismatched.length > 0
                      ? <Badge tone="warning" size="sm">Left out</Badge>
                      : moneyIn(f, account.due, account.currency)}
                  </div>
                </div>
              ))}
            </div>
            <div className="rv-hint">
              {billable.length === 0
                ? 'None of these lines can go on a bill for the account that holds them, because the account bills in another currency.'
                : (
                  <>
                    {`${claimable.length === 1 ? 'This line adds ' : `These ${f.plural(claimable.length, 'line')} add `}`}
                    {claimableCurrency ? moneyIn(f, claimableTotal, claimableCurrency) : 'the amounts above'}
                    {' to what is owed. Each bill may come out larger, because raising it also sweeps up every other proration and settled period the account is carrying.'}
                  </>
                )}
            </div>
          </>
        )}
        {results && (
          <div className="rv-rows">
            {results.map((row) => (
              <div className="rv-row" key={row.customer}>
                <div className="rv-row__main">
                  <div className="rv-row__title"><CustomerName id={row.customer} names={names} /></div>
                  <div className="rv-row__sub">
                    {row.invoice
                      ? `${row.invoice.number} · ${humanize(row.invoice.status)} · ${f.plural(row.claimed, 'line')} claimed`
                      : row.error}
                    {row.left > 0
                      ? ` · ${f.plural(row.left, 'line')} still waiting — a bill only claims lines in its own currency`
                      : ''}
                  </div>
                </div>
                <div className="rv-row__aside">
                  {row.invoice
                    ? (
                      <Button size="sm" variant="ghost" iconRight={<ArrowRightIcon size={13} />} onClick={() => navigate(`/billing/invoices/${row.invoice?.id}`)}>
                        {row.invoice.amount_due_display}
                      </Button>
                    )
                    : <Badge tone="danger" size="sm">Not raised</Badge>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Stack>
    </Modal>
  );
}

/* ================================= forms ================================== */

function GrantModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (grant: CreditGrant) => void }) {
  const f = useFormat();
  const { customers } = useCustomerNames();
  const meters = useQuery<ListEnvelope<Meter>>('/v1/meters');
  const [customer, setCustomer] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('promotional');
  const [kind, setKind] = useState('monetary');
  const [meter, setMeter] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [units, setUnits] = useState<number | null>(null);
  const [scope, setScope] = useState('all');
  const [expires, setExpires] = useState<number | null>(null);
  const [effective, setEffective] = useState<number | null>(null);
  const [priority, setPriority] = useState<number | null>(0);
  const [reason, setReason] = useState('');

  const account = customers.find((c) => c.id === customer);
  const currency = account?.currency ?? f.currency;
  const meterRows = meters.data?.data ?? [];

  const save = useMutation<void, CreditGrant>(
    async () => api.post<CreditGrant>('/v1/credit-grants', {
      customer,
      name: name || undefined,
      category,
      kind,
      currency,
      ...(kind === 'unit' ? { meter, unit_label: meterRows.find((m) => m.id === meter)?.unit_label ?? undefined } : {}),
      amount: kind === 'unit' ? (units ?? 0) : (amount ?? 0),
      applicability: scope === 'all'
        ? { scope: 'all' }
        : { scope: 'targeted', meters: meter ? [meter] : [] },
      ...(effective ? { effective_at: effective } : {}),
      ...(expires ? { expires_at: expires } : {}),
      priority: priority ?? 0,
      reason: reason || undefined,
    }),
    { invalidates: ['/v1/credit-grants', '/v1/credits/overview', '/v1/credit-ledger'], onSuccess: onSaved },
  );

  const params = ['customer', 'name', 'amount', 'meter', 'currency', 'expires_at', 'effective_at', 'priority', 'kind'];
  const general = generalError(save.error, params);
  const ready = !!customer && (kind === 'unit' ? !!meter && !!units : amount !== null);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Issue credit"
      description="A grant is a promise: this customer may draw this much, against these charges, between these two instants."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready} loading={save.loading} onClick={() => { void save.run().catch(() => undefined); }}>Issue credit</Button>
        </>
      }
    >
      <form className="rv-form" onSubmit={(e) => { e.preventDefault(); if (ready) void save.run().catch(() => undefined); }}>
        {general && <Banner tone="danger" compact>{general}</Banner>}
        <div className="rv-form__pair">
          <Field label="Customer" required hint="The grant takes this account's currency, which cannot be changed later." error={errorFor(save.error, 'customer')}>
            <Select value={customer} onChange={setCustomer} placeholder="Pick an account" options={customers.map((c) => ({ value: c.id, label: `${c.name} · ${c.currency.toUpperCase()}` }))} />
          </Field>
          <Field label="Name" hint="What this credit is for, as it will read on the ledger." error={errorFor(save.error, 'name')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Pilot goodwill credit" />
          </Field>
        </div>
        <div className="rv-form__pair">
          <Field label="Category" hint="Promotional credit is spent before paid credit, so a customer never loses money they bought." error={errorFor(save.error, 'category')}>
            <Select value={category} onChange={setCategory} options={[{ value: 'promotional', label: 'Promotional — given' }, { value: 'paid', label: 'Paid — bought' }]} />
          </Field>
          <Field label="Denomination" hint="Monetary credit pays for anything in its currency; unit credit holds a meter's own units." error={errorFor(save.error, 'kind')}>
            <Select value={kind} onChange={setKind} options={[{ value: 'monetary', label: 'Money' }, { value: 'unit', label: 'Meter units' }]} />
          </Field>
        </div>
        {kind === 'unit' && (
          <div className="rv-form__pair">
            <Field label="Meter" required hint="Unit credit may only pay for this meter." error={errorFor(save.error, 'meter')}>
              <Select value={meter} onChange={setMeter} placeholder="Pick a meter" options={meterRows.map((m) => ({ value: m.id, label: `${m.name} · ${m.unit_label ?? 'units'}` }))} />
            </Field>
            <Field label="Units" required error={errorFor(save.error, 'amount')}>
              <LiveNumberInput value={units} onChange={setUnits} min={0} suffix={meterRows.find((m) => m.id === meter)?.unit_label ?? undefined} />
            </Field>
          </div>
        )}
        {kind === 'monetary' && (
          <div className="rv-form__pair">
            <Field label={`Amount (${currency.toUpperCase()})`} required error={errorFor(save.error, 'amount')}>
              <LiveMoneyInput value={amount} onChange={setAmount} currency={currency} locale={f.locale} min={0} />
            </Field>
            <Field label="Applies to" hint="Targeted credit is matched against a charge's meter, price or product." error={errorFor(save.error, 'applicability')}>
              <Select value={scope} onChange={setScope} options={[{ value: 'all', label: 'Any charge in this currency' }, { value: 'targeted', label: 'One meter only' }]} />
            </Field>
          </div>
        )}
        {kind === 'monetary' && scope === 'targeted' && (
          <Field label="Meter" required error={errorFor(save.error, 'meter')}>
            <Select value={meter} onChange={setMeter} placeholder="Pick a meter" options={meterRows.map((m) => ({ value: m.id, label: m.name }))} />
          </Field>
        )}
        <div className="rv-form__pair">
          <Field label="Effective from" hint="Leave blank to start now." error={errorFor(save.error, 'effective_at')}>
            <DatePicker value={effective} onChange={setEffective} />
          </Field>
          <Field label="Expires" hint="Expiry is scheduled as a job, so the time machine can show it lapse." error={errorFor(save.error, 'expires_at')}>
            <DatePicker value={expires} onChange={setExpires} min={f.now()} />
          </Field>
          <Field label="Priority" hint="Higher priority is drawn first when two grants both apply." error={errorFor(save.error, 'priority')}>
            <LiveNumberInput value={priority} onChange={setPriority} min={-1000} max={1000} />
          </Field>
        </div>
        <Field label="Reason" hint="Written onto the first ledger entry.">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Goodwill after the March outage" />
        </Field>
      </form>
    </Modal>
  );
}

/**
 * How a price reads in a picker.
 *
 * A tiered price has no single unit amount, so labelling it with the first
 * rung's rate states a price the customer will not pay at any quantity but
 * one. `display.from` is the honest headline for a ladder.
 */
function priceLabel(price: PriceLite): string {
  const name = price.nickname ?? price.product_name ?? price.id;
  if (!price.display) return name;
  const tiered = price.billing_scheme === 'tiered';
  const headline = tiered && price.display.from
    ? `from ${price.display.from}${price.unit_label ? ` per ${price.unit_label}` : ''}`
    : price.display.headline;
  return `${name} · ${headline}`;
}

/**
 * The charge a dialog is about to raise, stated before it raises it.
 *
 * Nothing is computed here: `POST /v1/prices/:id/preview` is the catalogue's
 * own arithmetic, breakdown rows and all, so a volume ladder cannot be
 * mis-stated by a screen that only knew about the first rung.
 *
 * The quote is *keyed on what it was asked about*. A preview for four packs is
 * not an answer about six, so it is not returned as one — while a newer
 * quantity is in flight `preview` is null and `pending` is true, which is what
 * lets the button refuse to carry a figure it can no longer stand behind.
 */
interface ChargeQuote {
  /** The quote for exactly the quantity in the field — never an older one. */
  preview: PricePreview | null;
  error: string | null;
  /** A quote has been asked for and has not landed: the amount is unknown. */
  pending: boolean;
}

function useChargePreview(price: string, quantity: number | null, currency: string | null): ChargeQuote {
  const key = price && quantity && quantity > 0 ? `${price}|${quantity}|${currency ?? ''}` : '';
  // Typing "60" should not price 6 on the way past; the settled key is what is
  // asked about, and the unsettled one is what the button is gated on.
  const settled = useDebouncedValue(key, 220);
  const [state, setState] = useState<{ key: string; preview: PricePreview | null; error: string | null }>(
    { key: '', preview: null, error: null },
  );

  useEffect(() => {
    if (!settled) { setState({ key: '', preview: null, error: null }); return undefined; }
    let live = true;
    const divider = settled.lastIndexOf('|');
    const [id, qty] = settled.slice(0, divider).split('|');
    const code = settled.slice(divider + 1);
    api.post<PricePreview>(`/v1/prices/${id}/preview`, { quantity: Number(qty), ...(code ? { currency: code } : {}) })
      .then((result) => { if (live) setState({ key: settled, preview: result, error: null }); })
      .catch((e: unknown) => {
        if (live) setState({ key: settled, preview: null, error: e instanceof Error ? e.message : 'This quantity could not be priced' });
      });
    return () => { live = false; };
  }, [settled]);

  const current = !!key && state.key === key;
  return { preview: current ? state.preview : null, error: current ? state.error : null, pending: !!key && !current };
}

function ChargePreview({
  label, amount, currency, lines, note, loading,
}: {
  label: string;
  amount: number | null;
  currency: string;
  lines?: { label: string; value: string }[];
  note?: string | null;
  /** A newer quantity is being priced: show that, never the previous answer. */
  loading?: boolean;
}) {
  const f = useFormat();
  return (
    <div className="rv-preview" aria-busy={loading || undefined}>
      <div className="rv-preview__head">
        <span className="rv-preview__label">{label}</span>
        <span className="rv-preview__amount">
          {loading ? <Spinner size={16} /> : amount === null ? '—' : moneyIn(f, amount, currency)}
        </span>
      </div>
      {lines && lines.length > 0 && (
        <div className="rv-preview__lines">
          {lines.map((line) => (
            <div className="rv-preview__line" key={line.label}><span>{line.label}</span><span>{line.value}</span></div>
          ))}
        </div>
      )}
      {note && <div className="rv-hint">{note}</div>}
    </div>
  );
}

function TopUpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const f = useFormat();
  const toast = useToast();
  const names = useCustomerNames();
  const prices = useQuery<ListEnvelope<PriceLite>>('/v1/prices', { limit: 100 });
  const [customer, setCustomer] = useState('');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState<number | null>(1);
  const [expires, setExpires] = useState<number | null>(null);

  const options = (prices.data?.data ?? []);
  const chosen = options.find((p) => p.id === price);
  const account = names.customers.find((c) => c.id === customer);
  // A price may be sold in more than one currency; the account's own is the
  // one the charge will be raised in, so it is the one previewed.
  const currency = account && chosen?.currencies.includes(account.currency) ? account.currency : (chosen?.currency ?? null);
  const charge = useChargePreview(price, quantity, currency);

  const run = useMutation<{ quoted: number }, CreditTopUp>(
    async () => api.post<CreditTopUp>('/v1/credit-topups', {
      customer,
      price,
      quantity: quantity ?? 1,
      ...(expires ? { expires_at: expires } : {}),
    }),
    {
      invalidates: ['/v1/credit-grants', '/v1/credits/overview', '/v1/credit-ledger', '/v1/credit-billable-items'],
      onSuccess: (result, args) => {
        // The server's own figure, not the quote — and if the two ever differ,
        // the toast says so rather than repeating what the button promised.
        const charged = moneyIn(f, result.amount, result.currency);
        const surprise = result.amount !== args.quoted
          ? ` The quote said ${moneyIn(f, args.quoted, result.currency)} — the catalogue priced it differently, so check the bill.`
          : '';
        toast.success(
          `${charged} charged to ${names.name(customer)}`,
          `${result.grant.name} — the credit is ${result.grant.status === 'active' ? 'spendable now' : 'held until the charge is invoiced'}.${surprise}`,
        );
        onClose();
      },
    },
  );

  const params = ['customer', 'price', 'quantity', 'expires_at'];
  const general = generalError(run.error, params);
  const unit = chosen?.unit_label ?? 'pack';
  // Nothing may be charged from a figure that is not on screen: the sale is
  // only armed while a quote for *this* quantity has landed.
  const quote = charge.preview;
  const ready = !!customer && !!price && !!quantity && !!quote && !charge.error;
  const sell = () => {
    if (!ready || !quote) return;
    void run.run({ quoted: quote.amount }).catch(() => undefined);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Sell a credit pack"
      description="The charge comes first. The purchase line and the grant are written in one transaction, so a customer can never be charged for credit they did not receive — or hold credit nobody was billed for."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!ready}
            loading={run.loading || charge.pending}
            title={charge.pending ? `Pricing ${units(f, quantity ?? 0, unit)} before anything is charged.` : undefined}
            onClick={sell}
          >
            {quote
              ? `Charge ${moneyIn(f, quote.amount, quote.currency)}`
              : charge.pending
                ? 'Pricing…'
                : 'Sell pack'}
          </Button>
        </>
      }
    >
      <form className="rv-form" onSubmit={(e) => { e.preventDefault(); sell(); }}>
        {general && <Banner tone="danger" compact>{general}</Banner>}
        <Field label="Customer" required error={errorFor(run.error, 'customer')}>
          <Select value={customer} onChange={setCustomer} placeholder="Pick an account" options={names.customers.map((c) => ({ value: c.id, label: `${c.name} · ${c.currency.toUpperCase()}` }))} />
        </Field>
        <Field
          label="Price"
          required
          hint={chosen?.billing_scheme === 'tiered' && chosen.display?.tiers?.length
            ? `Tiered: ${f.list(chosen.display.tiers)}.`
            : 'The catalogue price the pack is sold at. It decides both the charge and the credit.'}
          error={errorFor(run.error, 'price')}
        >
          <Select
            value={price}
            onChange={setPrice}
            placeholder="Pick a price"
            options={options.map((p) => ({ value: p.id, label: priceLabel(p) }))}
          />
        </Field>
        <div className="rv-form__pair">
          <Field
            label="Packs"
            required
            hint="The quote below is re-priced as you type — a tiered pack changes rung part-way up."
            error={errorFor(run.error, 'quantity')}
          >
            <LiveNumberInput value={quantity} onChange={setQuantity} min={1} max={1000} suffix={quantity === null ? unit : pluralize(unit, quantity)} />
          </Field>
          <Field label="Expires" hint="Leave blank and the credit does not lapse." error={errorFor(run.error, 'expires_at')}>
            <DatePicker value={expires} onChange={setExpires} min={f.now()} />
          </Field>
        </div>
        {charge.error && <Banner tone="danger" compact>{charge.error}</Banner>}
        {price && quantity ? (
          <ChargePreview
            label="The customer will be charged"
            amount={quote?.amount ?? null}
            currency={quote?.currency ?? currency ?? f.currency}
            loading={charge.pending}
            lines={(quote?.breakdown ?? []).map((row) => ({ label: row.label, value: row.amount_display }))}
            note={quote
              ? `${units(f, quote.quantity, unit)} at ${quote.effective_unit_display ?? '—'} each${quote.warning ? ` · ${quote.warning}` : ''}`
              : `Pricing ${units(f, quantity, unit)} — nothing is charged until this figure lands.`}
          />
        ) : (
          <div className="rv-hint">Pick a price and a quantity and the exact charge is stated here before anything is raised.</div>
        )}
      </form>
    </Modal>
  );
}

function SettleModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const f = useFormat();
  const toast = useToast();
  const names = useCustomerNames();
  const prices = useQuery<ListEnvelope<PriceLite>>('/v1/prices', { limit: 100 });
  const [customer, setCustomer] = useState('');
  const [price, setPrice] = useState('');
  const [start, setStart] = useState<number | null>(f.now() - 30 * DAY_MS);
  const [end, setEnd] = useState<number | null>(f.now());
  const [result, setResult] = useState<CreditSettlement | null>(null);

  const metered = (prices.data?.data ?? []).filter((p) => p.recurring?.meter);
  const chosen = metered.find((p) => p.id === price) ?? null;
  // A price names its meter by event name or by id, depending on how it was
  // written; a credit pot always names it by id. Resolving one to the other is
  // what lets the preview say which grants will pay for this period.
  const meters = useQuery<ListEnvelope<Meter>>('/v1/meters');
  const meterId = useMemo(() => {
    const ref = chosen?.recurring?.meter;
    if (!ref) return null;
    return (meters.data?.data ?? []).find((m) => m.id === ref || m.event_name === ref)?.id ?? ref;
  }, [chosen, meters.data]);

  /* ---- what this period will cost, before it is billed ---- */

  // The meter's own answer for exactly the window on the form. Read only once
  // every field it depends on is filled in, so an empty dialog makes no calls.
  const ready = !!customer && !!price && !!start && !!end && end > start;
  const usage = useQuery<MeterUsage>(
    meterId && ready ? `/v1/meters/${meterId}/usage` : null,
    { customer, start: start ?? 0, end: end ?? 0 },
  );
  const quantity = usage.data?.billable_quantity ?? null;
  const charge = useChargePreview(ready ? price : '', quantity, null);
  const balance = useQuery<CreditBalance>(customer ? `/v1/customers/${customer}/credit-balance` : null);
  // Monetary credit with no meter of its own pays for anything in its currency;
  // everything else has to name this meter.
  const eligible = useMemo(() => (balance.data?.balances ?? []).filter((pot) => (
    pot.meter === null ? pot.kind === 'monetary' : pot.meter === meterId
  )), [balance.data, meterId]);

  const run = useMutation<void, CreditSettlement>(
    async () => api.post<CreditSettlement>('/v1/credit-settlements', {
      customer, price, period_start: start, period_end: end,
    }),
    {
      invalidates: ['/v1/credit-settlements', '/v1/credit-grants', '/v1/credits/overview', '/v1/credit-ledger', '/v1/credit-billable-items', '/v1/revenue/usage'],
      onSuccess: (settlement) => {
        setResult(settlement);
        toast.success(`${moneyIn(f, settlement.full_amount, settlement.currency)} priced — ${moneyIn(f, settlement.covered_amount, settlement.currency)} covered by credit`);
      },
    },
  );

  const params = ['customer', 'price', 'period_start', 'period_end'];
  const general = generalError(run.error, params);

  return (
    <Modal
      open={open}
      onClose={() => { setResult(null); run.reset(); onClose(); }}
      title="Settle a usage period"
      description="Prices the window against the billing period's running total, draws credit in the documented order, and freezes the meter so a late reading becomes a true-up rather than a disagreement."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => { setResult(null); run.reset(); onClose(); }}>Close</Button>
          <Button
            variant="primary"
            disabled={!ready || !!result}
            loading={run.loading || (charge.pending && !result)}
            onClick={() => { void run.run().catch(() => undefined); }}
          >
            {charge.preview && !result
              ? `Bill about ${moneyIn(f, charge.preview.amount, charge.preview.currency)}`
              : charge.pending && !result ? 'Pricing…' : 'Settle period'}
          </Button>
        </>
      }
    >
      <form className="rv-form" onSubmit={(e) => { e.preventDefault(); void run.run().catch(() => undefined); }}>
        {general && <Banner tone="danger" compact>{general}</Banner>}
        {result && (
          <Banner tone="success" compact title={`${units(f, result.quantity, usage.data?.unit_label ?? chosen?.unit_label)} priced at ${moneyIn(f, result.full_amount, result.currency)}`}>
            {`${moneyIn(f, result.covered_amount, result.currency)} was absorbed by prepaid credit and ${moneyIn(f, result.charged_amount, result.currency)} became a charge. `
              + `${result.applications.length ? `Drawn from ${f.list(result.applications.map((a) => a.grant_name))}.` : 'No grant was eligible, so the whole period is charged.'}`}
          </Banner>
        )}
        <Field label="Customer" required error={errorFor(run.error, 'customer')}>
          <Select value={customer} onChange={setCustomer} placeholder="Pick an account" options={names.customers.map((c) => ({ value: c.id, label: c.name }))} />
        </Field>
        <Field label="Metered price" required hint="The price the period is billed on. Its meter decides which usage is counted." error={errorFor(run.error, 'price')}>
          <Select
            value={price}
            onChange={setPrice}
            placeholder={metered.length ? 'Pick a metered price' : 'No metered price exists yet'}
            options={metered.map((p) => ({ value: p.id, label: `${p.nickname ?? p.id} · ${p.recurring?.meter ?? ''}` }))}
          />
        </Field>
        <div className="rv-form__pair">
          <Field label="Period starts" required error={errorFor(run.error, 'period_start')}>
            <DatePicker value={start} onChange={setStart} max={f.now()} />
          </Field>
          <Field label="Period ends" required error={errorFor(run.error, 'period_end')}>
            <DatePicker value={end} onChange={setEnd} max={f.now()} />
          </Field>
        </div>
        {!result && (
          ready
            ? (
              <>
                {usage.error && <Banner tone="danger" compact>{usage.error.body.message}</Banner>}
                {charge.error && <Banner tone="warning" compact>{charge.error}</Banner>}
                <ChargePreview
                  label="This period is worth"
                  amount={charge.preview?.amount ?? null}
                  currency={charge.preview?.currency ?? chosen?.currency ?? f.currency}
                  loading={usage.loading || charge.pending}
                  lines={[
                    ...(quantity !== null
                      ? [{ label: `Metered over ${boundaryRange(f, start as number, end as number)}`, value: units(f, quantity, usage.data?.unit_label ?? chosen?.unit_label) }]
                      : []),
                    ...(charge.preview?.breakdown ?? []).map((row) => ({ label: row.label, value: row.amount_display })),
                    ...eligible.map((pot) => ({
                      label: `Credit available · ${pot.applies_to}`,
                      value: pot.kind === 'monetary' ? moneyIn(f, pot.available, pot.currency) : units(f, pot.available, pot.unit_label),
                    })),
                  ]}
                  note={eligible.length
                    ? 'Credit is drawn against this before the customer is charged, in the burn-down order. The settlement below states exactly how much it absorbed.'
                    : 'No grant applies to this meter, so the whole period becomes a charge.'}
                />
                <div className="rv-hint">
                  This is the window priced on its own. Settling prices it against the billing period&rsquo;s running total instead — if
                  earlier windows of the same cycle have already been settled, a graduated price starts this one further up the ladder,
                  and the amount billed will be lower than the figure above.
                </div>
              </>
            )
            : <div className="rv-hint">Pick an account, a metered price and two dates, and what the period is worth is stated here before anything is billed.</div>
        )}
      </form>
    </Modal>
  );
}

function EditGrantModal({ grant, onClose }: { grant: CreditGrant; onClose: () => void }) {
  const f = useFormat();
  const toast = useToast();
  const [name, setName] = useState(grant.name);
  const [priority, setPriority] = useState<number | null>(grant.priority);
  const [expires, setExpires] = useState<number | null>(grant.expires_at);

  const save = useMutation<void, CreditGrant>(
    async () => api.patch<CreditGrant>(`/v1/credit-grants/${grant.id}`, {
      name,
      priority: priority ?? 0,
      expires_at: expires,
    }),
    {
      invalidates: ['/v1/credit-grants', '/v1/credits/overview'],
      onSuccess: () => { toast.success(`${name} updated`); onClose(); },
    },
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${grant.name}`}
      description="The amount and what it may pay for are fixed — the money has already been taken. Rescheduling the expiry moves the expiry job with it."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.loading} onClick={() => { void save.run().catch(() => undefined); }}>Save changes</Button>
        </>
      }
    >
      <form className="rv-form" onSubmit={(e) => { e.preventDefault(); void save.run().catch(() => undefined); }}>
        {generalError(save.error, ['name', 'priority', 'expires_at']) && <Banner tone="danger" compact>{save.error?.body.message}</Banner>}
        <Field label="Name" required error={errorFor(save.error, 'name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="rv-form__pair">
          <Field label="Priority" hint="Higher is drawn first when two grants both apply." error={errorFor(save.error, 'priority')}>
            <LiveNumberInput value={priority} onChange={setPriority} min={-1000} max={1000} />
          </Field>
          <Field label="Expires" error={errorFor(save.error, 'expires_at')}>
            <DatePicker value={expires} onChange={setExpires} min={f.now()} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}

function VoidGrantDialog({ grant, onClose }: { grant: CreditGrant; onClose: () => void }) {
  const f = useFormat();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const run = useMutation<void, CreditGrant>(
    async () => api.post<CreditGrant>(`/v1/credit-grants/${grant.id}/void`, { reason: reason || undefined }),
    {
      invalidates: ['/v1/credit-grants', '/v1/credits/overview', '/v1/credit-ledger'],
      onSuccess: () => { toast.success(`${grant.name} voided`); onClose(); },
    },
  );

  return (
    <Modal
      open
      onClose={onClose}
      title="Void the remaining balance"
      icon={<AlertTriangleIcon size={18} />}
      iconTone="danger"
      description={`${grantAmount(f, grant, grant.balance)} is still unspent. Voiding writes a ledger entry that takes it back; nothing already burned is affected.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={run.loading} onClick={() => { void run.run().catch(() => undefined); }}>Void balance</Button>
        </>
      }
    >
      <Stack gap={5}>
        {run.error && <Banner tone="danger" compact>{run.error.body.message}</Banner>}
        <Field label="Reason" hint="Kept on the ledger entry.">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Pilot ended without conversion" autoFocus />
        </Field>
      </Stack>
    </Modal>
  );
}

function RefundGrantModal({ grant, onClose }: { grant: CreditGrant; onClose: () => void }) {
  const f = useFormat();
  const toast = useToast();
  const [amount, setAmount] = useState<number | null>(grant.kind === 'monetary' ? grant.balance : null);
  const [unitCount, setUnitCount] = useState<number | null>(grant.kind === 'unit' ? grant.balance : null);
  const [reason, setReason] = useState('');

  // What the customer paid for this pack is what a refund is pro-rated
  // against, and it is on the purchase line the top-up wrote. Without it the
  // dialog can only promise "a refund" and let the operator find out how much
  // afterwards, which is the one thing a money control may not do.
  const purchases = useQuery<ListEnvelope<CreditBillableItem>>(
    grant.source === 'topup' && grant.source_ref ? '/v1/credit-billable-items' : null,
    { customer: grant.customer, kind: 'topup', limit: 200 },
  );
  const purchase = (purchases.data?.data ?? []).find((item) => item.id === grant.source_ref) ?? null;

  const withdrawn = grant.kind === 'monetary' ? amount : unitCount;
  // The server's rule, restated: the share of the pack being handed back,
  // priced at what the pack actually cost, rounded once.
  const back = purchase && withdrawn && grant.amount > 0
    ? Math.round((purchase.amount * withdrawn) / grant.amount)
    : null;

  const run = useMutation<void, CreditRefund>(
    async () => api.post<CreditRefund>(`/v1/credit-grants/${grant.id}/refund`, {
      amount: withdrawn ?? undefined,
      reason: reason || undefined,
    }),
    {
      invalidates: ['/v1/credit-grants', '/v1/credits/overview', '/v1/credit-ledger', '/v1/credit-billable-items'],
      onSuccess: (result) => {
        const money = result.line ? moneyIn(f, Math.abs(result.line.amount), result.line.currency) : null;
        toast.success(
          money
            ? `${money} refunded to the customer`
            : `${grantAmount(f, grant, result.refunded)} withdrawn from ${grant.name}`,
          money
            ? `${grantAmount(f, grant, result.refunded)} taken back from ${grant.name} — the credit note is waiting for the next bill.`
            : 'This grant carries no purchase line, so the credit was withdrawn without a money refund.',
        );
        onClose();
      },
    },
  );

  const ready = !!withdrawn && withdrawn > 0 && withdrawn <= grant.balance;

  return (
    <Modal
      open
      onClose={onClose}
      title="Refund unused credit"
      icon={<RotateCcwIcon size={18} />}
      iconTone="warning"
      description="Refunded pro rata to what was bought, so a discounted pack refunds at the price the customer actually paid."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!ready}
            loading={run.loading || (purchases.loading && !!grant.source_ref)}
            onClick={() => { void run.run().catch(() => undefined); }}
          >
            {back !== null ? `Refund ${moneyIn(f, back, purchase?.currency ?? grant.currency)}` : 'Withdraw the credit'}
          </Button>
        </>
      }
    >
      <form className="rv-form" onSubmit={(e) => { e.preventDefault(); if (ready) void run.run().catch(() => undefined); }}>
        {generalError(run.error, ['amount', 'reason']) && <Banner tone="danger" compact>{run.error?.body.message}</Banner>}
        <DescriptionList items={[
          { term: 'Unspent balance', value: grantAmount(f, grant, grant.balance) },
          { term: 'Originally granted', value: grantAmount(f, grant, grant.amount) },
          ...(purchase
            ? [{ term: 'Paid for the pack', value: moneyIn(f, purchase.amount, purchase.currency) }]
            : []),
        ]}
        />
        {grant.kind === 'monetary'
          ? (
            <Field label="Refund amount" hint="Leave the full balance to refund everything unspent." error={errorFor(run.error, 'amount')}>
              <LiveMoneyInput value={amount} onChange={setAmount} currency={grant.currency} locale={f.locale} min={0} max={grant.balance} />
            </Field>
          )
          : (
            <Field label="Units to refund" error={errorFor(run.error, 'amount')}>
              <LiveNumberInput value={unitCount} onChange={setUnitCount} min={0} max={grant.balance} precision={2} suffix={unitNoun(unitCount ?? 2, grant.unit_label)} />
            </Field>
          )}
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Contract ended early" />
        </Field>
        {purchase
          ? (
            <ChargePreview
              label="Back to the customer"
              amount={back}
              currency={purchase.currency}
              loading={purchases.loading}
              lines={[
                { label: 'Pack bought for', value: moneyIn(f, purchase.amount, purchase.currency) },
                { label: 'Share being handed back', value: withdrawn ? `${grantAmount(f, grant, withdrawn)} of ${grantAmount(f, grant, grant.amount)}` : '—' },
                { label: 'Left on the grant afterwards', value: withdrawn ? grantAmount(f, grant, grant.balance - withdrawn) : grantAmount(f, grant, grant.balance) },
              ]}
              note={`Raised as a negative line against ${purchase.description}, which the account's next bill claims.`}
            />
          )
          : (
            <div className="rv-hint">
              {purchases.loading && grant.source_ref
                ? 'Reading the purchase this grant was sold on…'
                : 'No purchase line is attached to this grant, so nothing was paid for it and no money goes back — the balance is simply withdrawn.'}
            </div>
          )}
      </form>
    </Modal>
  );
}
