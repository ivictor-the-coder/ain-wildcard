/**
 * Recovery: the screen that makes the money back.
 *
 * Every campaign here is a bill the bank refused, and the useful question is
 * never "how much is at risk" on its own — it is what the issuer actually said,
 * whether the schedule will clear it on its own, and which handful need a
 * person today. So each row carries the decline, the attempts spent, the next
 * attempt and the recommended action, and every one of them can be retried or
 * stood down from this page.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, useMutation, useQuery, type ApiClientError, type ListEnvelope } from '../../kernel/api';
import { useNavigate, useSearchParam } from '../../kernel/router';
import {
  Badge, Banner, Button, Card, Checkbox, ConfirmDialog, DataTable, DescriptionList, Drawer, EmptyState,
  Field, Grid, Icons, Inline, Input, Modal, Page, Section, SegmentedControl, Select, Skeleton,
  Stack, Stat, Switch, TagInput, Timeline, Tooltip, formatNumber, humanize, useFormat, useToast,
  type DataTableColumn, type MenuSection, type TimelineEntry,
  AlertTriangleIcon, ArrowRightIcon,
} from '../../design';
import {
  EmptyBody, ExportCsvButton, LiveNumberInput, Loading, SectionError, StatusChip, csvAmount,
  csvInstant, moneyIn, useUrlTableState, visibleRows,
  type CsvColumn,
} from './common';
import type {
  CollectionAttempt, DunningCampaign, DunningPolicy, DunningSummary, PaymentSettings,
} from './types';

/**
 * A campaign is only at risk while it is being chased.
 *
 * The tiles count `amount_at_risk` for campaigns in recovery and nothing else,
 * so a settled row that keeps printing its old figure in a column headed "At
 * risk" contradicts the total directly above it. The money is still worth
 * naming — it is just no longer at risk, and the outcome is what to call it.
 */
const chasing = (row: DunningCampaign): boolean => row.status === 'recovering' || row.status === 'open';

const outcomeNote = (f: ReturnType<typeof useFormat>, row: DunningCampaign): string => {
  if (row.status === 'recovered') return `${moneyIn(f, row.recovered_amount || row.amount_at_risk, row.currency)} recovered`;
  if (row.status === 'exhausted') return `${moneyIn(f, row.amount_at_risk, row.currency)} given up`;
  if (row.status === 'canceled') return `${moneyIn(f, row.amount_at_risk, row.currency)} no longer chased`;
  return '';
};

const errorFor = (error: ApiClientError | null, param: string): string | undefined =>
  (error && error.param === param ? error.body.message : undefined);

const STATUSES = ['recovering', 'open', 'recovered', 'exhausted', 'canceled', 'all'] as const;
type StatusFilter = (typeof STATUSES)[number];

/**
 * What the policy select offers, and what the API calls each one.
 *
 * These two drifted apart once — the select emitted `leave_open`, which the
 * API has never accepted, so choosing it failed every save and took the other
 * edits in the same submission down with it. Naming the pairs in one place is
 * what stops that happening again, and it doubles as the dictionary that turns
 * the API's raw enum list back into the labels on screen.
 */
const END_BEHAVIOURS: { value: DunningPolicy['end_behavior']; label: string }[] = [
  { value: 'mark_unpaid', label: 'Mark the invoice unpaid — the subscription follows its own status machine' },
  { value: 'cancel', label: 'Cancel the subscription' },
  { value: 'leave_past_due', label: 'Leave the bill open and stop trying' },
];

const END_BEHAVIOUR_LABEL: Record<string, string> = {
  mark_unpaid: 'Mark the invoice unpaid',
  cancel: 'Cancel the subscription',
  leave_past_due: 'Leave the bill open and stop trying',
};

/**
 * A validation message written for whoever calls the API, rewritten for
 * whoever is looking at the form. "Must be one of: leave_past_due,
 * mark_unpaid, cancel" names three values, one of which the dropdown does not
 * even offer under that spelling.
 */
function humaniseEnumError(message: string, labels: Record<string, string>): string {
  return message.replace(/Must be one of: ([a-z_,\s]+)/i, (_match, list: string) => {
    const options = list.split(',').map((v) => v.trim()).filter(Boolean);
    const named = options.map((value) => labels[value] ?? humanize(value));
    return `Pick one of: ${named.join('; ')}`;
  });
}

/* =================================== page ================================= */

export function DunningPage() {
  const f = useFormat();
  const toast = useToast();
  const navigate = useNavigate();
  const [statusParam, setStatusParam] = useSearchParam('status', 'recovering');
  const status = (STATUSES as readonly string[]).includes(statusParam) ? (statusParam as StatusFilter) : 'recovering';

  const summary = useQuery<DunningSummary>('/v1/dunning/summary');
  const queue = useQuery<ListEnvelope<DunningCampaign>>('/v1/dunning', { status, limit: 200 });
  const settings = useQuery<PaymentSettings>('/v1/payments/settings');

  const [open, setOpen] = useState<DunningCampaign | null>(null);
  const [cancelling, setCancelling] = useState<DunningCampaign | null>(null);
  // The dialog holds the policy it opened with. Saving invalidates
  // `/v1/payments/settings`, which empties the cache entry — a dialog rendered
  // straight off `settings.data` unmounts mid-save, taking its own success
  // handling with it.
  const [policyDraft, setPolicyDraft] = useState<PaymentSettings | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkRetry, setBulkRetry] = useState<DunningCampaign[] | null>(null);
  // Presenting a card is the one money-moving action on this screen, and it
  // was the only one that fired straight off a click. It asks now, and it
  // states the amount, the card and the attempt it is about to spend.
  const [retrying, setRetrying] = useState<DunningCampaign | null>(null);
  const table = useUrlTableState('d', { columnId: 'next_attempt_at', direction: 'asc' });

  const rows = queue.data?.data ?? [];
  const stats = summary.data;

  const openPolicy = () => { if (settings.data) setPolicyDraft(settings.data); };

  const [policyParam, setPolicyParam] = useSearchParam('policy');
  useEffect(() => {
    if (policyParam !== '1' || !settings.data) return;
    setPolicyDraft(settings.data);
    setPolicyParam(undefined);
  }, [policyParam, settings.data, setPolicyParam]);

  /** A campaign the issuer can still be asked about. */
  const retryable = (row: DunningCampaign) => row.status !== 'recovered' && row.status !== 'canceled';

  const retry = useMutation<{ campaign: DunningCampaign; offSession: boolean }, CollectionAttempt>(
    async ({ campaign, offSession }) => api.post<CollectionAttempt>(`/v1/invoices/${campaign.invoice}/retry`, { off_session: offSession }),
    { invalidates: ['/v1/dunning', '/v1/invoices', '/v1/charges'] },
  );

  const retryOne = async (campaign: DunningCampaign) => {
    try {
      const result = await retry.run({ campaign, offSession: true });
      if (result.collected) toast.success(`${campaign.invoice_number} collected — ${moneyIn(f, campaign.amount_at_risk, campaign.currency)} recovered`);
      else toast.warning(result.summary);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The retry did not go through');
    }
  };

  const columns: DataTableColumn<DunningCampaign>[] = useMemo(() => [
    {
      id: 'customer', header: 'Account', pinned: true, accessor: (row) => row.customer_name,
      cell: (row) => (
        <div className="rv-cell">
          <span className="rv-cell__top">{row.customer_name}</span>
          <span className="rv-cell__sub">{row.invoice_number}{row.subscription_status ? ` · subscription ${humanize(row.subscription_status).toLowerCase()}` : ''}</span>
        </div>
      ),
      width: 250,
    },
    {
      id: 'amount_at_risk', header: 'At risk', align: 'right',
      // Sorted and filtered on the figure the cell prints, so a settled
      // campaign does not out-rank a live one on money nobody is chasing.
      accessor: (row) => (chasing(row) ? row.amount_at_risk : 0), filter: 'number',
      cell: (row) => (chasing(row)
        ? <span className="rv-num">{moneyIn(f, row.amount_at_risk, row.currency)}</span>
        : (
          <div className="rv-cell" style={{ alignItems: 'flex-end' }}>
            <span className="rv-num rv-muted">—</span>
            <span className="rv-cell__sub rv-nowrap">{outcomeNote(f, row)}</span>
          </div>
        )),
      width: 150,
    },
    { id: 'status', header: 'Status', accessor: (row) => row.status, filter: 'set', cell: (row) => <StatusChip status={row.status} />, width: 124 },
    {
      id: 'attempts', header: 'Attempts', align: 'right', accessor: (row) => row.attempt_count,
      cell: (row) => (
        <span className="rv-num">
          {formatNumber(row.attempt_count)} <span className="rv-muted">/ {formatNumber(row.max_attempts)}</span>
        </span>
      ),
      width: 110,
    },
    {
      id: 'next_attempt_at', header: 'Next attempt', accessor: (row) => row.next_attempt_at ?? 0, filter: 'date',
      cell: (row) => (row.next_attempt_at === null
        ? <span className="rv-muted">{row.status === 'recovered' ? 'Settled' : 'No more scheduled'}</span>
        : (
          <div className="rv-cell">
            <span className="rv-cell__top rv-nowrap">{f.relative(row.next_attempt_at)}</span>
            <span className="rv-cell__sub rv-nowrap">{f.dateTime(row.next_attempt_at)}</span>
          </div>
        )),
      width: 166,
    },
    {
      id: 'decline', header: 'Last decline', accessor: (row) => row.last_failure_code ?? '—', filter: 'set',
      cell: (row) => (row.last_failure_code
        ? (
          <Tooltip content={row.last_failure_message ?? ''}>
            <span><Badge tone="warning" size="sm">{humanize(row.last_failure_code)}</Badge></span>
          </Tooltip>
        )
        : <span className="rv-muted">—</span>),
      width: 150,
    },
    {
      id: 'recommended_action', header: 'What to do', accessor: (row) => row.recommended_action,
      cell: (row) => (
        <span className="rv-sub rv-wrap rv-clamp" title={row.recommended_action}>
          {row.needs_human && <><Badge tone="danger" size="sm" dot>Needs a person</Badge>{' '}</>}
          {row.recommended_action}
        </span>
      ),
    },
  ], [f]);

  const shown = visibleRows(rows, columns, table.state);

  const rowActions = (row: DunningCampaign): MenuSection[] => [{
    id: 'campaign',
    items: [
      { id: 'open', label: 'Open the campaign', icon: <ArrowRightIcon size={14} />, onSelect: () => setOpen(row) },
      {
        id: 'retry',
        label: 'Retry the charge now…',
        icon: <Icons.refresh size={14} />,
        disabled: row.status === 'recovered' || row.status === 'canceled',
        onSelect: () => setRetrying(row),
      },
      { id: 'invoice', label: 'Open the invoice', icon: <Icons.invoice size={14} />, onSelect: () => navigate(`/billing/invoices/${row.invoice}`) },
      {
        id: 'cancel',
        label: 'Stop chasing this bill',
        icon: <Icons.x size={14} />,
        danger: true,
        disabled: row.status !== 'recovering' && row.status !== 'open',
        onSelect: () => setCancelling(row),
      },
    ],
  }];

  return (
    <Page
      title="Recovery"
      eyebrow="Insights"
      subtitle="Every subscription whose payment was refused: what the issuer said, how many attempts are left, and what a person should do about it today."
      actions={
        <Inline gap={3}>
          <SegmentedControl
            size="sm"
            aria-label="Campaign status"
            value={status}
            onChange={setStatusParam}
            options={[
              { value: 'recovering', label: 'In recovery' },
              { value: 'recovered', label: 'Recovered' },
              { value: 'exhausted', label: 'Given up' },
              { value: 'all', label: 'All' },
            ]}
          />
          <Button variant="secondary" iconLeft={<Icons.sliders size={15} />} disabled={!settings.data} onClick={openPolicy}>Retry policy</Button>
        </Inline>
      }
    >
      <Stack gap={7}>
        {summary.error && <Card><SectionError error={summary.error} path="GET /v1/dunning/summary" onRetry={summary.refetch} /></Card>}
        {!summary.error && !stats && <div className="rv-tiles">{[0, 1, 2, 3, 4].map((i) => <Card key={i} padding="tight"><Skeleton height={70} /></Card>)}</div>}
        {stats && (
          <>
            {stats.needs_human > 0 && (
              <Banner tone="danger" title={`${f.plural(stats.needs_human, 'campaign')} cannot be fixed by another retry`}>
                A card that has expired, an account that is closed or a charge the issuer wants authenticated will refuse every automatic attempt. These need a new payment method or a call.
              </Banner>
            )}
            <div className="rv-tiles">
              <Card padding="tight"><Stat label="In recovery" value={formatNumber(stats.open_campaigns)} caption={`${formatNumber(stats.needs_human)} need a person`} /></Card>
              {stats.totals.map((total) => (
                <Card padding="tight" key={total.currency}>
                  <Stat
                    label={`At risk · ${total.currency.toUpperCase()}`}
                    value={moneyIn(f, total.amount_at_risk, total.currency)}
                    caption={`${moneyIn(f, total.recovered_amount, total.currency)} recovered · ${(total.recovery_rate_bps / 100).toFixed(2)}% rate`}
                  />
                </Card>
              ))}
              <Card padding="tight">
                <Stat
                  label="Attempts"
                  value={formatNumber(stats.attempts.total)}
                  caption={`${formatNumber(stats.attempts.succeeded)} cleared · ${formatNumber(stats.attempts.failed)} refused`}
                />
              </Card>
              <Card padding="tight">
                <Stat
                  label="Next attempt"
                  value={stats.next_attempt_at ? f.relative(stats.next_attempt_at) : '—'}
                  caption={stats.next_attempt_at ? f.dateTime(stats.next_attempt_at) : 'nothing scheduled'}
                />
              </Card>
            </div>
          </>
        )}

        <Section
          title="The recovery queue"
          description="Ordered by the next attempt. Select rows to retry a batch, or open one to see every attempt the platform has made."
        >
          <Card padding="none">
            <DataTable
              rows={rows}
              columns={columns}
              getRowId={(row) => row.id}
              caption="Recovery queue"
              loading={queue.loading}
              error={queue.error ? { message: queue.error.body?.message, code: queue.error.body?.code, requestId: queue.error.body?.request_id } : null}
              onRetry={queue.refetch}
              onRowClick={setOpen}
              rowActions={rowActions}
              rowTone={(row) => (row.needs_human ? 'danger' : 'default')}
              selectable
              selected={selected}
              onSelectionChange={setSelected}
              bulkActions={(ids) => {
                // Counting the selection rather than what the selection can
                // actually do promises retries that will not happen — and a
                // settled campaign is not merely a no-op, it is a row the
                // button claims to be working on.
                const targets = rows.filter((row) => ids.includes(row.id) && retryable(row));
                const label = targets.length === ids.length
                  ? `Retry ${formatNumber(targets.length)} now`
                  : `Retry ${formatNumber(targets.length)} of ${formatNumber(ids.length)} selected`;
                return (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={targets.length === 0}
                    loading={retry.loading}
                    iconLeft={<Icons.refresh size={14} />}
                    title={targets.length === 0
                      ? 'Nothing in this selection can be presented again — every one is settled or stood down.'
                      : undefined}
                    onClick={() => setBulkRetry(targets)}
                  >
                    {targets.length === 0 ? 'Nothing to retry' : label}
                  </Button>
                );
              }}
              searchPlaceholder="Search accounts, invoices and declines…"
              value={table.state}
              onChange={table.setState}
              toolbar={(
                <Inline gap={3} wrap>
                  <span className="rv-sub">
                    {shown.length === rows.length
                      ? f.plural(rows.length, 'campaign')
                      : `${formatNumber(shown.length)} of ${f.plural(rows.length, 'campaign')}`}
                  </span>
                  <ExportCsvButton
                    name="recovery-queue"
                    noun="campaign"
                    rows={shown}
                    columns={[
                      { header: 'Account', value: (row) => row.customer_name },
                      { header: 'Invoice', value: (row) => row.invoice_number },
                      { header: 'Status', value: (row) => row.status },
                      { header: 'Currency', value: (row) => row.currency.toUpperCase() },
                      { header: 'At risk', value: (row) => csvAmount(chasing(row) ? row.amount_at_risk : 0, row.currency) },
                      { header: 'Recovered', value: (row) => csvAmount(row.recovered_amount, row.currency) },
                      { header: 'Attempts', value: (row) => row.attempt_count },
                      { header: 'Maximum attempts', value: (row) => row.max_attempts },
                      { header: 'Next attempt', value: (row) => csvInstant(row.next_attempt_at) },
                      { header: 'Last decline', value: (row) => row.last_failure_code ?? '' },
                      { header: 'Issuer message', value: (row) => row.last_failure_message ?? '' },
                      { header: 'Payment method', value: (row) => row.payment_method?.display_name ?? '' },
                      { header: 'Needs a person', value: (row) => (row.needs_human ? 'yes' : 'no') },
                      { header: 'What to do', value: (row) => row.recommended_action },
                    ] satisfies CsvColumn<DunningCampaign>[]}
                  />
                </Inline>
              )}
              maxHeight={620}
              empty={(
                <EmptyState
                  title={status === 'recovering' ? 'Nothing is in recovery' : 'No campaigns match this filter'}
                  body={(
                    <EmptyBody>
                      {status === 'recovering'
                        ? 'Every automatic charge is clearing. A campaign starts the moment a payment is refused.'
                        : 'Switch the filter above to see campaigns in another state.'}
                    </EmptyBody>
                  )}
                  action={status === 'recovering'
                    ? <Button variant="secondary" onClick={() => setStatusParam('all')}>Show every campaign</Button>
                    : <Button variant="secondary" onClick={() => setStatusParam('recovering')}>Back to the live queue</Button>}
                />
              )}
            />
          </Card>
        </Section>

        <PolicyCard settings={settings} onEdit={openPolicy} />
      </Stack>

      {open && (
        <CampaignDrawer
          campaign={open}
          onClose={() => setOpen(null)}
          onRetry={setRetrying}
          retrying={retry.loading}
          onCancel={() => { setCancelling(open); setOpen(null); }}
        />
      )}
      {retrying && (
        <RetryDialog
          campaign={retrying}
          loading={retry.loading}
          onCancel={() => setRetrying(null)}
          onConfirm={async (campaign) => { setRetrying(null); await retryOne(campaign); }}
        />
      )}
      {cancelling && <CancelCampaignModal campaign={cancelling} onClose={() => setCancelling(null)} />}
      {policyDraft && (
        <PolicyModal
          settings={policyDraft}
          onClose={() => setPolicyDraft(null)}
          onSaved={(schedule) => {
            toast.success('Retry policy saved', schedule);
            setPolicyDraft(null);
          }}
        />
      )}
      {bulkRetry && (
        <BulkRetryDialog
          campaigns={bulkRetry}
          onClose={() => setBulkRetry(null)}
          onDone={() => { setBulkRetry(null); setSelected([]); }}
          run={async (campaign) => retry.run({ campaign, offSession: true })}
        />
      )}
    </Page>
  );
}

/**
 * One card, presented on purpose.
 *
 * Every other money-moving control on these screens is priced and guarded —
 * invoicing says what it will raise, voiding says what it takes back, selling
 * a pack says what it charges. "Retry now" fired a real card presentation the
 * instant it was clicked, which is both a misclick away from a charge and, on
 * a repeated attempt, a cost. It asks the same way the others do, and names
 * the amount, the card and the attempt it is about to spend.
 */
function RetryDialog({
  campaign, loading, onCancel, onConfirm,
}: {
  campaign: DunningCampaign;
  loading: boolean;
  onCancel: () => void;
  onConfirm: (campaign: DunningCampaign) => Promise<void>;
}) {
  const f = useFormat();
  const amount = moneyIn(f, campaign.amount_at_risk, campaign.currency);
  const method = campaign.payment_method?.display_name ?? 'the method on file';
  const attempt = Math.min(campaign.attempt_count + 1, campaign.max_attempts);

  return (
    <ConfirmDialog
      open
      tone="brand"
      onCancel={onCancel}
      onConfirm={() => { void onConfirm(campaign); }}
      loading={loading}
      title={`Present ${amount} to ${method} now?`}
      confirmLabel={`Present ${amount} now`}
      body={(
        <>
          {`${campaign.customer_name} · ${campaign.invoice_number}. This is attempt ${formatNumber(attempt)} of ${formatNumber(campaign.max_attempts)} and it spends one from the schedule whether or not it clears`}
          {campaign.next_attempt_at ? `, ahead of the one due ${f.relative(campaign.next_attempt_at)}` : ''}
          {'.'}
          {campaign.last_failure_code
            ? ` The issuer last said ${humanize(campaign.last_failure_code).toLowerCase()}${campaign.needs_human ? ', which no automatic attempt can satisfy — a new payment method is what fixes it' : ''}.`
            : ''}
        </>
      )}
    />
  );
}

/**
 * Presenting a card to the issuer is not free: it spends one of a fixed number
 * of permitted attempts and, on some networks, is visible to the cardholder.
 * Void and Refund and "Stop chasing" all confirm before they act; the action
 * that actually moves money on somebody else's card should too, and it should
 * name the accounts and the amount at risk while it asks.
 */
function BulkRetryDialog({
  campaigns, onClose, onDone, run,
}: {
  campaigns: DunningCampaign[];
  onClose: () => void;
  onDone: () => void;
  run: (campaign: DunningCampaign) => Promise<CollectionAttempt>;
}) {
  const f = useFormat();
  const toast = useToast();
  const [working, setWorking] = useState(false);

  const byCurrency = useMemo(() => {
    const totals = new Map<string, number>();
    for (const campaign of campaigns) {
      totals.set(campaign.currency, (totals.get(campaign.currency) ?? 0) + campaign.amount_at_risk);
    }
    return [...totals.entries()].map(([currency, amount]) => moneyIn(f, amount, currency));
  }, [campaigns, f]);

  const go = async () => {
    setWorking(true);
    let collected = 0;
    let failed = 0;
    for (const campaign of campaigns) {
      try {
        const result = await run(campaign);
        if (result.collected) collected += 1; else failed += 1;
      } catch { failed += 1; }
    }
    setWorking(false);
    const outcome = `${formatNumber(collected)} of ${formatNumber(campaigns.length)} presented again cleared the bank`;
    if (collected > 0) toast.success(outcome, failed ? `${formatNumber(failed)} were refused again.` : undefined);
    else toast.warning(outcome, 'Every card was refused again. The schedule keeps its own attempts.');
    onDone();
  };

  return (
    <ConfirmDialog
      open
      tone="brand"
      onCancel={onClose}
      onConfirm={() => { void go(); }}
      loading={working}
      title={`Present ${f.plural(campaigns.length, 'card')} to the issuer now?`}
      confirmLabel={`Retry ${formatNumber(campaigns.length)} now`}
      body={(
        <>
          {`${f.list(byCurrency)} is at risk across ${f.list(campaigns.slice(0, 4).map((c) => c.customer_name))}`}
          {campaigns.length > 4 ? ` and ${f.plural(campaigns.length - 4, 'other account')}` : ''}
          {'. Each one spends an attempt from its own schedule, whether or not it clears.'}
        </>
      )}
    />
  );
}

/* =============================== the campaign ============================= */

function CampaignDrawer({
  campaign, onClose, onRetry, retrying, onCancel,
}: {
  campaign: DunningCampaign;
  onClose: () => void;
  onRetry: (campaign: DunningCampaign) => void;
  retrying: boolean;
  onCancel: () => void;
}) {
  const f = useFormat();
  const navigate = useNavigate();
  const live = useQuery<DunningCampaign>(`/v1/dunning/${campaign.id}`);
  const row = live.data ?? campaign;

  const entries: TimelineEntry[] = row.attempts.map((attempt) => ({
    id: attempt.id,
    tone: attempt.outcome === 'succeeded' ? 'success' : attempt.outcome === 'failed' ? 'danger' : 'neutral',
    icon: attempt.outcome === 'succeeded' ? <Icons.check size={12} /> : <Icons.x size={12} />,
    title: `Attempt ${attempt.attempt_number} — ${humanize(attempt.outcome)}`,
    time: f.dateTime(attempt.attempted_at ?? attempt.scheduled_for),
    description: attempt.failure_message ?? `${moneyIn(f, attempt.amount, attempt.currency)} presented`,
    children: <span className="rv-sub">{attempt.decision}</span>,
  }));

  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={row.customer_name}
      description={chasing(row)
        ? `${row.invoice_number} · ${moneyIn(f, row.amount_at_risk, row.currency)} at risk`
        : `${row.invoice_number} · ${outcomeNote(f, row)}`}
      actions={
        <Inline gap={3}>
          <Button size="sm" variant="secondary" onClick={() => navigate(`/billing/invoices/${row.invoice}`)}>Open the invoice</Button>
          <Button
            size="sm"
            variant="primary"
            loading={retrying}
            disabled={row.status === 'recovered' || row.status === 'canceled'}
            iconLeft={<Icons.refresh size={14} />}
            onClick={() => onRetry(row)}
          >
            {row.status === 'recovered' || row.status === 'canceled'
              ? 'Retry now'
              : `Retry ${moneyIn(f, row.amount_at_risk, row.currency)} now`}
          </Button>
        </Inline>
      }
      footer={
        row.status === 'recovering' || row.status === 'open'
          ? <Button variant="danger-ghost" iconLeft={<Icons.x size={15} />} onClick={onCancel}>Stop chasing this bill</Button>
          : null
      }
    >
      <Stack gap={6}>
        <Banner tone={row.needs_human ? 'danger' : row.status === 'recovered' ? 'success' : 'info'} title="What to do">
          {row.recommended_action}
        </Banner>

        <Grid minColumnWidth={150} gap={5}>
          {chasing(row)
            ? <Stat size="sm" label="At risk" value={moneyIn(f, row.amount_at_risk, row.currency)} caption={row.recovered_amount ? `${moneyIn(f, row.recovered_amount, row.currency)} recovered` : 'nothing recovered yet'} />
            : <Stat size="sm" label="Was at risk" value={moneyIn(f, row.amount_at_risk, row.currency)} caption={outcomeNote(f, row)} />}
          <Stat size="sm" label="Attempts" value={`${formatNumber(row.attempt_count)} / ${formatNumber(row.max_attempts)}`} caption={`${formatNumber(row.attempts_remaining)} left`} />
          <Stat size="sm" label="Next attempt" value={row.next_attempt_at ? f.relative(row.next_attempt_at) : '—'} caption={row.next_attempt_at ? f.dateTime(row.next_attempt_at) : 'none scheduled'} />
          <Stat size="sm" label="At the end" value={humanize(row.end_behavior)} caption={`started ${f.date(row.started_at)}`} />
        </Grid>

        <DescriptionList
          divided
          items={[
            { term: 'Payment method', value: row.payment_method?.display_name ?? 'None on file' },
            { term: 'Last decline', value: row.last_failure_code ? `${humanize(row.last_failure_code)} — ${row.last_failure_message ?? ''}` : 'None' },
            { term: 'Retry schedule', value: `${f.list(row.retry_days.map((d) => `${d} days`))} between attempts` },
            { term: 'Subscription', value: row.subscription ? `${row.subscription} · ${humanize(row.subscription_status ?? '')}` : 'None' },
          ]}
        />

        <Card title="Every attempt" description="Each presentation, what the issuer said, and what the schedule decided next.">
          {live.loading && !live.data ? <Loading label="Reading the campaign…" /> : <Timeline entries={entries} />}
        </Card>
      </Stack>
    </Drawer>
  );
}

function CancelCampaignModal({ campaign, onClose }: { campaign: DunningCampaign; onClose: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const run = useMutation<void, DunningCampaign>(
    async () => api.post<DunningCampaign>(`/v1/dunning/${campaign.id}/cancel`, { reason: reason || undefined }),
    {
      invalidates: ['/v1/dunning'],
      onSuccess: () => { toast.success(`Stopped chasing ${campaign.invoice_number}`); onClose(); },
    },
  );

  return (
    <Modal
      open
      onClose={onClose}
      title="Stop chasing this bill"
      icon={<AlertTriangleIcon size={18} />}
      iconTone="warning"
      description="The schedule stands down without touching the invoice — for accounts being collected another way."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Keep chasing</Button>
          <Button variant="danger" loading={run.loading} onClick={() => { void run.run().catch(() => undefined); }}>Stop chasing</Button>
        </>
      }
    >
      <Stack gap={5}>
        {run.error && <Banner tone="danger" compact>{run.error.body.message}</Banner>}
        <Field label="Reason" hint="Recorded against the campaign so the audit trail stays one story.">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Collections took this account over by phone" autoFocus />
        </Field>
      </Stack>
    </Modal>
  );
}

/* ================================= policy ================================= */

/**
 * What actually happens to a decline, said in the badge.
 *
 * The API's `retried` flag folds two different facts into one boolean — this
 * workspace's give-up list, and whether the code is a final decline no
 * schedule can ever satisfy — so a code removed from the policy kept reading
 * "Given up" with nothing to say why. They are separated here: the list is the
 * workspace's decision, and a final decline is the network's.
 */
function declineVerdict(
  code: PaymentSettings['decline_codes'][number], giveUpCodes: string[],
): { label: string; tone: 'success' | 'neutral' | 'warning'; why: string } {
  if (giveUpCodes.includes(code.code)) {
    return {
      label: 'Given up',
      tone: 'neutral',
      why: 'On this workspace’s give-up list: the schedule stops the moment the issuer answers with this code. Take it off the list to have it retried.',
    };
  }
  if (code.severity === 'final') {
    return {
      label: 'Always given up',
      tone: 'warning',
      why: 'A final decline: the card or the account is gone, so no further attempt can succeed however the policy is written. Taking it off the give-up list changes nothing.',
    };
  }
  return {
    label: 'Retried',
    tone: 'success',
    why: 'Chased on the schedule above until it clears or the attempts run out.',
  };
}

function PolicyCard({ settings, onEdit }: { settings: ReturnType<typeof useQuery<PaymentSettings>>; onEdit: () => void }) {
  const f = useFormat();
  const data = settings.data;
  return (
    <Section
      title="Retry policy"
      description="The schedule every campaign starts under, and what this workspace does with each decline code."
      actions={<Button size="sm" variant="secondary" iconLeft={<Icons.edit size={14} />} onClick={onEdit} disabled={!data}>Change the policy</Button>}
    >
      {settings.error && <Card><SectionError error={settings.error} path="GET /v1/payments/settings" onRetry={settings.refetch} /></Card>}
      {!settings.error && !data && <Card><Skeleton height={140} /></Card>}
      {data && (
        <div className="rv-cols">
          <Card title="The schedule">
            <Stack gap={5}>
              <Banner tone="info" compact>{data.schedule_explained}</Banner>
              <DescriptionList
                divided
                items={[
                  { term: 'Gaps between attempts', value: f.list(data.dunning.retry_days.map((d) => `${d} days`)) },
                  { term: 'Maximum attempts', value: formatNumber(data.dunning.max_attempts) },
                  { term: 'When the schedule runs out', value: END_BEHAVIOUR_LABEL[data.dunning.end_behavior] ?? humanize(data.dunning.end_behavior) },
                  { term: 'Weekends', value: data.dunning.skip_weekends ? 'Skipped — nobody watches a Sunday decline' : 'Attempted like any other day' },
                  { term: 'Collection hour', value: `${String(data.dunning.collection_hour).padStart(2, '0')}:00, jittered by up to ${f.plural(data.dunning.jitter_hours, 'hour')}` },
                  { term: 'Hard declines', value: `waited ${data.dunning.hard_decline_multiplier}× as long before the next attempt` },
                ]}
              />
            </Stack>
          </Card>
          <Card
            title="Decline codes"
            description="What this workspace does with each refusal — the codes on the give-up list, and the ones no retry schedule could satisfy whatever the list says."
          >
            <div className="rv-rows">
              {data.decline_codes.map((code) => {
                const verdict = declineVerdict(code, data.dunning.give_up_codes);
                return (
                  <div className="rv-row" key={code.code}>
                    <div className="rv-row__main">
                      <div className="rv-row__title">{humanize(code.code)}</div>
                      <div className="rv-row__sub">{code.advice}</div>
                    </div>
                    <div className="rv-row__aside">
                      <Tooltip content={verdict.why}>
                        <span><Badge tone={verdict.tone} size="sm">{verdict.label}</Badge></span>
                      </Tooltip>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      )}
    </Section>
  );
}

function PolicyModal({ settings, onClose, onSaved }: {
  settings: PaymentSettings;
  onClose: () => void;
  /** Raised on the page, which outlives the dialog the save closes. */
  onSaved: (schedule: string) => void;
}) {
  const [retryDays, setRetryDays] = useState<string[]>(settings.dunning.retry_days.map(String));
  const [maxAttempts, setMaxAttempts] = useState<number | null>(settings.dunning.max_attempts);
  const [endBehavior, setEndBehavior] = useState<string>(settings.dunning.end_behavior);
  const [skipWeekends, setSkipWeekends] = useState(settings.dunning.skip_weekends);
  const [collectionHour, setCollectionHour] = useState<number | null>(settings.dunning.collection_hour);
  const [giveUp, setGiveUp] = useState<string[]>(settings.dunning.give_up_codes);

  const save = useMutation<void, { dunning: DunningPolicy; schedule_explained: string }>(
    async () => api.patch<{ dunning: DunningPolicy; schedule_explained: string }>('/v1/payments/settings', {
      dunning: {
        retry_days: retryDays.map(Number).filter((n) => Number.isFinite(n) && n > 0),
        max_attempts: maxAttempts ?? settings.dunning.max_attempts,
        end_behavior: endBehavior,
        skip_weekends: skipWeekends,
        collection_hour: collectionHour ?? settings.dunning.collection_hour,
        give_up_codes: giveUp,
      },
    }),
    {
      invalidates: ['/v1/payments/settings', '/v1/dunning'],
      onSuccess: (result) => { onSaved(result.schedule_explained); },
    },
  );

  const endBehaviorError = errorFor(save.error, 'dunning.end_behavior');

  return (
    <Modal
      open
      onClose={onClose}
      title="Retry policy"
      description="A campaign already running keeps the policy it started under, so changes here apply to the next failure."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.loading} onClick={() => { void save.run().catch(() => undefined); }}>Save policy</Button>
        </>
      }
    >
      <form className="rv-form" onSubmit={(e) => { e.preventDefault(); void save.run().catch(() => undefined); }}>
        {save.error && !save.error.param && <Banner tone="danger" compact>{save.error.body.message}</Banner>}
        <Field
          label="Gaps between attempts"
          hint="Days between one attempt and the next — not offsets from the first failure. Add as many as the schedule needs."
          error={errorFor(save.error, 'dunning.retry_days') ?? errorFor(save.error, 'retry_days')}
        >
          <TagInput value={retryDays} onChange={setRetryDays} placeholder="3" />
        </Field>
        <div className="rv-form__pair">
          <Field label="Maximum attempts" required error={errorFor(save.error, 'dunning.max_attempts')}>
            <LiveNumberInput value={maxAttempts} onChange={setMaxAttempts} min={1} max={12} />
          </Field>
          <Field label="Collection hour" hint="Local hour the day's attempts are presented at." error={errorFor(save.error, 'dunning.collection_hour')}>
            <LiveNumberInput value={collectionHour} onChange={setCollectionHour} min={0} max={23} />
          </Field>
        </div>
        <Field
          label="When the schedule runs out"
          error={endBehaviorError ? humaniseEnumError(endBehaviorError, END_BEHAVIOUR_LABEL) : undefined}
        >
          <Select value={endBehavior} onChange={setEndBehavior} options={END_BEHAVIOURS} />
        </Field>
        <Switch
          checked={skipWeekends}
          onChange={setSkipWeekends}
          label="Skip weekends"
          hint="A Sunday decline is a Monday problem nobody sees. Attempts move to the next working day."
        />
        <Field
          label="Give up on these declines"
          hint="Anything left unticked is chased on the schedule above. A final decline is marked as such: it can be ticked or not, and the schedule stops for it either way."
          error={errorFor(save.error, 'dunning.give_up_codes')}
        >
          <div className="rv-codes">
            {settings.decline_codes.map((code) => {
              const final = code.severity === 'final';
              return (
                <Checkbox
                  key={code.code}
                  checked={giveUp.includes(code.code)}
                  onChange={(checked) => setGiveUp(
                    checked ? [...giveUp, code.code] : giveUp.filter((c) => c !== code.code),
                  )}
                  label={(
                    <Inline gap={3}>
                      <span>{humanize(code.code)}</span>
                      {final && <Badge tone="warning" size="sm">Final</Badge>}
                    </Inline>
                  )}
                  hint={final
                    ? `${code.advice} It is given up whether or not this is ticked — no attempt can satisfy a final decline.`
                    : code.advice}
                />
              );
            })}
          </div>
        </Field>
        <div className="rv-hint">{settings.schedule_explained}</div>
      </form>
    </Modal>
  );
}
