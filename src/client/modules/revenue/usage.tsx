/**
 * Usage: the meters, what is flowing through them, and the ingestion record.
 *
 * A metered business lives or dies on whether the numbers it bills from can be
 * trusted, so this screen is built around the four things that can go wrong —
 * a replayed event, a withdrawn one, a reading that arrived after its period
 * was billed, and one so old the meter refused it — and gives an operator the
 * controls to see and settle each of them.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, useMutation, useQuery, type ApiClientError, type ListEnvelope } from '../../kernel/api';
import { useNavigate, useParams, useSearchParam } from '../../kernel/router';
import {
  AreaChart, Badge, Banner, Button, Card, ConfirmDialog, DataTable, DatePicker, DescriptionList,
  EmptyState, Field, Grid, Icons, Inline, Input, Modal, Page, RadioGroup, Section,
  SegmentedControl, Select, Skeleton, Stack, Stat, Textarea, formatNumber, humanize, pluralize,
  useFormat, useToast,
  type DataTableColumn, type MenuSection,
  AlertTriangleIcon, ArrowLeftIcon, ArrowRightIcon,
} from '../../design';
import {
  BasisNote, ChartSkeleton, CustomerName, EmptyBody, ExportCsvButton, LiveNumberInput, Loading,
  SectionError, StatusChip, boundaryDate, boundaryRange, csvInstant, moneyIn, rateText,
  unitRateText, units, useCustomerNames, useDefaultCurrency, useTabParam, useUrlTableState,
  visibleRows,
  type CsvColumn,
} from './common';
import type {
  Meter, MeterDetail, MeterEvent, MeterEventAdjustment, MeterEventResult, MeterLateArrival,
  MeterPeriodClosure, MeterUsage, MeteringOverview, PriceLite, RevenueUsage, SummaryBucket,
} from './types';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * The acceptance window, edited as text.
 *
 * A stepper that silently clamps unparseable text to its minimum will create a
 * meter with a one-day window under a field still reading "flush" — and the
 * window decides which late-arriving usage is billable rather than refused, so
 * that is a month of backdated readings quietly thrown away. Parsing it here
 * means the form can refuse to submit a value it is not displaying.
 */
const WINDOW_MIN_DAYS = 1;
const WINDOW_MAX_DAYS = 365;

function parseWindowDays(text: string): { days: number | null; error: string | null } {
  const trimmed = text.trim();
  if (!trimmed) return { days: null, error: 'Say how far back a reading may be dated.' };
  if (!/^\d+$/.test(trimmed)) return { days: null, error: `"${trimmed}" is not a number of days.` };
  const days = Number(trimmed);
  if (days < WINDOW_MIN_DAYS) return { days: null, error: 'A meter has to accept at least one day of backdating.' };
  if (days > WINDOW_MAX_DAYS) return { days: null, error: `${WINDOW_MAX_DAYS} days is the longest window a meter may keep open.` };
  return { days, error: null };
}

/** The window field itself, so the create and edit forms cannot disagree. */
function AcceptanceWindowField({
  text, onChange, error, hint, apiError,
}: { text: string; onChange: (next: string) => void; error: string | null; hint: string; apiError?: string }) {
  return (
    <Field label="Acceptance window" hint={hint} error={apiError ?? error ?? undefined}>
      <Input
        value={text}
        inputMode="numeric"
        invalid={!!error}
        onChange={(e) => onChange(e.target.value)}
        suffix={<span className="rv-sub">days</span>}
        placeholder="35"
      />
    </Field>
  );
}

const AGGREGATIONS = [
  { value: 'sum', label: 'Sum — add every reading in the period' },
  { value: 'count', label: 'Count — one per event, whatever it carries' },
  { value: 'max', label: 'Max — the highest reading in the period' },
  { value: 'last', label: 'Last — the most recent reading' },
  { value: 'unique', label: 'Unique — distinct values of a key' },
];

const errorFor = (error: ApiClientError | null, param: string): string | undefined =>
  (error && error.param === param ? error.body.message : undefined);

/** Anything the server rejected that no field on the form is bound to. */
const generalError = (error: ApiClientError | null, params: string[]): string | null =>
  (error && (!error.param || !params.includes(error.param)) ? error.body.message : null);

/* ================================ overview ================================ */

export function UsagePage() {
  const navigate = useNavigate();
  const toast = useToast();
  const names = useCustomerNames();
  const overview = useQuery<MeteringOverview>('/v1/metering/overview');
  const meters = useQuery<ListEnvelope<Meter>>('/v1/meters');
  // The list endpoint hides archived meters, which is the right default and
  // the wrong answer for "what did we retire, and can I still read it?".
  const archived = useQuery<ListEnvelope<Meter>>('/v1/meters', { status: 'archived' });
  const [newMeter, setNewMeter] = useState(false);
  const [recording, setRecording] = useState(false);
  const [editing, setEditing] = useState<Meter | null>(null);
  const [archiving, setArchiving] = useState<Meter | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  /** The meter "Record an event" was opened from, so the form opens on it. */
  const [recordFor, setRecordFor] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab | undefined>(undefined);
  const table = useUrlTableState('mt', { columnId: 'events_30d', direction: 'desc' });

  // `?new=meter|event` so the palette and the create menu can land on the form
  // rather than beside it.
  const [newParam, setNewParam] = useSearchParam('new');
  useEffect(() => {
    if (!newParam) return;
    if (newParam === 'meter' || newParam === '1') setNewMeter(true);
    else if (newParam === 'event') setRecording(true);
    setNewParam(undefined);
  }, [newParam, setNewParam]);

  const stats = overview.data;
  const live = meters.data?.data ?? [];
  const retired = archived.data?.data ?? [];
  const all = useMemo(() => [...live, ...retired], [live, retired]);
  const rows = showArchived ? all : live;
  const volume = useMemo(() => {
    const index = new Map((stats?.meters ?? []).map((m) => [m.id, m]));
    return rows.map((meter) => ({ meter, live: index.get(meter.id) ?? null }));
  }, [rows, stats]);

  const columns: DataTableColumn<{ meter: Meter; live: MeteringOverview['meters'][number] | null }>[] = useMemo(() => [
    {
      id: 'name',
      header: 'Meter',
      pinned: true,
      accessor: (row) => row.meter.name,
      cell: (row) => (
        <div className="rv-cell">
          <span className="rv-cell__top">{row.meter.name}</span>
          <span className="rv-cell__sub rv-mono">{row.meter.event_name}</span>
        </div>
      ),
      width: 260,
    },
    {
      id: 'aggregation', header: 'Aggregation', accessor: (row) => row.meter.aggregation, filter: 'set',
      cell: (row) => (
        <div className="rv-cell">
          <span className="rv-cell__top">{humanize(row.meter.aggregation)}</span>
          <span className="rv-cell__sub">
            {row.meter.aggregation === 'unique'
              ? `distinct ${row.meter.unique_key ?? 'value'}`
              : row.meter.aggregation === 'count' ? 'events' : `payload.${row.meter.value_key ?? 'value'}`}
          </span>
        </div>
      ),
      width: 170,
    },
    { id: 'unit', header: 'Unit', accessor: (row) => row.meter.unit_label ?? '—', width: 100 },
    { id: 'status', header: 'Status', accessor: (row) => row.meter.status, filter: 'set', cell: (row) => <StatusChip status={row.meter.status} />, width: 120 },
    {
      id: 'events_30d', header: 'Events · 30d', align: 'right', accessor: (row) => row.live?.events_30d ?? 0,
      cell: (row) => <span className="rv-num">{formatNumber(row.live?.events_30d ?? 0)}</span>,
    },
    {
      id: 'customers_30d', header: 'Customers · 30d', align: 'right', accessor: (row) => row.live?.customers_30d ?? 0,
      cell: (row) => <span className="rv-num">{formatNumber(row.live?.customers_30d ?? 0)}</span>,
    },
    {
      id: 'last_event', header: 'Last event', accessor: (row) => row.live?.last_hour_with_events ?? 0,
      cell: (row) => <LastSeen at={row.live?.last_hour_with_events ?? null} />,
    },
  ], []);

  const rowActions = (row: { meter: Meter }): MenuSection[] => [
    {
      id: 'meter',
      items: [
        { id: 'open', label: 'Open meter', icon: <ArrowRightIcon size={14} />, onSelect: () => navigate(`/revenue/usage/${row.meter.id}`) },
        { id: 'edit', label: 'Edit meter', icon: <Icons.edit size={14} />, onSelect: () => setEditing(row.meter) },
        {
          id: 'record',
          label: 'Record an event',
          icon: <Icons.zap size={14} />,
          disabled: row.meter.status !== 'active',
          onSelect: () => { setRecordFor(row.meter.id); setRecording(true); },
        },
      ],
    },
    {
      id: 'lifecycle',
      items: [
        {
          id: 'archive',
          label: 'Archive the meter',
          icon: <Icons.trash size={14} />,
          danger: true,
          disabled: row.meter.status === 'archived',
          onSelect: () => setArchiving(row.meter),
        },
      ],
    },
  ];

  return (
    <Page
      title="Usage"
      eyebrow="Insights"
      subtitle="Every meter this workspace bills from, what is flowing through it, and the ingestion record behind the numbers."
      actions={
        <Inline gap={3}>
          <Button variant="secondary" iconLeft={<Icons.zap size={15} />} onClick={() => setRecording(true)}>Record an event</Button>
          <Button variant="primary" iconLeft={<Icons.plus size={15} />} onClick={() => setNewMeter(true)}>New meter</Button>
        </Inline>
      }
    >
      <Stack gap={7}>
        {overview.error && <Card><SectionError error={overview.error} path="GET /v1/metering/overview" onRetry={overview.refetch} /></Card>}
        {!overview.error && !stats && <div className="rv-tiles">{[0, 1, 2, 3, 4, 5].map((i) => <Card key={i} padding="tight"><Skeleton height={70} /></Card>)}</div>}
        {stats && (
          <>
            {stats.open_late_arrivals > 0 && (
              <Banner
                tone="warning"
                title={`${formatNumber(stats.open_late_arrivals)} ${stats.open_late_arrivals === 1 ? 'reading' : 'readings'} arrived after their period was billed`}
                actions={(
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setInspectorTab('late');
                      document.getElementById('late-arrivals')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                  >
                    Work through them
                  </Button>
                )}
              >
                Each one is a true-up waiting to be credited, rebilled or dismissed. Until it is settled, the invoice and the meter disagree.
              </Banner>
            )}
            <div className="rv-tiles rv-tiles--tight">
              <Card padding="tight"><Stat label="Meters" value={formatNumber(stats.meters.length)} caption={`${stats.meters.filter((m) => m.status === 'active').length} active`} /></Card>
              <Card padding="tight"><Stat label="Events · 30 days" value={formatNumber(stats.meters.reduce((sum, m) => sum + m.events_30d, 0))} caption="across every meter" /></Card>
              <Card padding="tight"><Stat label="Customers streaming" value={formatNumber(Math.max(0, ...stats.meters.map((m) => m.customers_30d)))} caption="most on any one meter" /></Card>
              <Card padding="tight"><Stat label="Billed periods" value={formatNumber(stats.closed_periods)} caption={`${formatNumber(stats.periods_awaiting_settlement)} awaiting settlement`} /></Card>
              <Card padding="tight"><Stat label="Late arrivals open" value={formatNumber(stats.open_late_arrivals)} caption={`${formatNumber(stats.true_ups_settled.n)} already trued up`} /></Card>
              <Card padding="tight"><Stat label="Events withdrawn" value={formatNumber(stats.withdrawn_events)} caption="cancelled after ingestion" /></Card>
            </div>
          </>
        )}

        <Section
          title="Meters"
          description="A meter is a standing instruction: which event name to listen for, where the value and the customer live in the payload, and how a period of events collapses into one number."
        >
          <Card padding="none">
            <DataTable
              rows={volume}
              columns={columns}
              getRowId={(row) => row.meter.id}
              caption="Meters"
              loading={meters.loading}
              error={meters.error ? { message: meters.error.body?.message, code: meters.error.body?.code, requestId: meters.error.body?.request_id } : null}
              onRetry={meters.refetch}
              onRowClick={(row) => navigate(`/revenue/usage/${row.meter.id}`)}
              rowActions={rowActions}
              value={table.state}
              onChange={table.setState}
              toolbar={(
                <Inline gap={3} wrap>
                  {retired.length > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => setShowArchived((v) => !v)}>
                      {showArchived ? 'Hide archived' : `Show ${retired.length} archived`}
                    </Button>
                  )}
                  <ExportCsvButton
                    name="meters"
                    noun="meter"
                    rows={visibleRows(volume, columns, table.state)}
                    columns={[
                      { header: 'Meter', value: (row) => row.meter.name },
                      { header: 'Event name', value: (row) => row.meter.event_name },
                      { header: 'Aggregation', value: (row) => row.meter.aggregation },
                      { header: 'Unit', value: (row) => row.meter.unit_label ?? '' },
                      { header: 'Status', value: (row) => row.meter.status },
                      { header: 'Events 30d', value: (row) => row.live?.events_30d ?? 0 },
                      { header: 'Customers 30d', value: (row) => row.live?.customers_30d ?? 0 },
                      { header: 'Last event', value: (row) => csvInstant(row.live?.last_hour_with_events ?? null) },
                    ] satisfies CsvColumn<{ meter: Meter; live: MeteringOverview['meters'][number] | null }>[]}
                  />
                </Inline>
              )}
              searchPlaceholder="Search meters…"
              empty={(
                <EmptyState
                  title="No meters yet"
                  body={<EmptyBody>A meter turns a stream of events into the one number an invoice line is drawn from.</EmptyBody>}
                  action={<Button variant="primary" iconLeft={<Icons.plus size={15} />} onClick={() => setNewMeter(true)}>New meter</Button>}
                />
              )}
            />
          </Card>
        </Section>

        <IngestionInspector meters={all} names={names} onRecord={() => setRecording(true)} initialTab={inspectorTab} />
      </Stack>

      <MeterFormModal
        open={newMeter}
        onClose={() => setNewMeter(false)}
        onSaved={(meter) => { toast.success(`Meter “${meter.name}” is listening for ${meter.event_name}`); setNewMeter(false); }}
        onArchiveClash={(eventName) => {
          const clash = all.find((m) => m.event_name === eventName && m.status !== 'archived');
          if (clash) setArchiving(clash);
        }}
      />
      {editing && (
        <MeterEditModal
          meter={editing}
          onClose={() => setEditing(null)}
          onSaved={(meter) => { toast.success(`${meter.name} updated`); setEditing(null); }}
        />
      )}
      {archiving && <ArchiveMeterDialog meter={archiving} onClose={() => setArchiving(null)} />}
      <RecordEventModal
        open={recording}
        meters={all.filter((m) => m.status === 'active')}
        initialMeter={recordFor}
        onClose={() => { setRecording(false); setRecordFor(null); }}
      />
    </Page>
  );
}

function LastSeen({ at }: { at: number | null }) {
  const f = useFormat();
  if (!at) return <span className="rv-muted">Never</span>;
  const silent = f.now() - at;
  return (
    <div className="rv-cell">
      <span className="rv-cell__top">{f.relative(at)}</span>
      <span className="rv-cell__sub">{silent > 2 * DAY_MS ? 'Stalled — nothing for two days' : f.dateTime(at)}</span>
    </div>
  );
}

/* ============================ meter create/edit ============================ */

function MeterFormModal({
  open, onClose, onSaved, onArchiveClash,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (meter: Meter) => void;
  /** Offers the archive the conflict message tells the operator to perform. */
  onArchiveClash?: (eventName: string) => void;
}) {
  const [name, setName] = useState('');
  const [eventName, setEventName] = useState('');
  const [aggregation, setAggregation] = useState('sum');
  const [valueKey, setValueKey] = useState('value');
  const [uniqueKey, setUniqueKey] = useState('');
  const [customerKey, setCustomerKey] = useState('customer_id');
  const [unitLabel, setUnitLabel] = useState('');
  const [description, setDescription] = useState('');
  const [windowText, setWindowText] = useState('35');
  const acceptance = parseWindowDays(windowText);

  const save = useMutation<void, Meter>(
    async () => api.post<Meter>('/v1/meters', {
      name,
      event_name: eventName,
      aggregation,
      ...(aggregation === 'count' || aggregation === 'unique' ? {} : { value_key: valueKey || undefined }),
      ...(aggregation === 'unique' ? { unique_key: uniqueKey || undefined } : {}),
      customer_key: customerKey || 'customer_id',
      unit_label: unitLabel || undefined,
      description: description || undefined,
      acceptance_window_ms: (acceptance.days as number) * DAY_MS,
    }),
    { invalidates: ['/v1/meters', '/v1/metering/overview'], onSuccess: onSaved },
  );

  const params = ['name', 'event_name', 'aggregation', 'value_key', 'unique_key', 'customer_key', 'unit_label', 'acceptance_window_ms'];
  const general = generalError(save.error, params);
  const ready = !!name.trim() && !!eventName.trim() && acceptance.days !== null
    && (aggregation !== 'unique' || !!uniqueKey.trim());

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New meter"
      description="What to listen for, where the numbers are, and how a period collapses into one figure."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready} loading={save.loading} onClick={() => { void save.run().catch(() => undefined); }}>Create meter</Button>
        </>
      }
    >
      <form
        className="rv-form"
        onSubmit={(e) => { e.preventDefault(); if (ready) void save.run().catch(() => undefined); }}
      >
        {general && (
          <Banner
            tone="danger"
            compact
            /* The API's advice — "archive that meter first" — is only useful if
               archiving is something this screen can do. It is: the row menu
               carries it, and so does this banner. */
            actions={save.error?.code === 'meter_event_name_in_use'
              ? <Button size="sm" variant="secondary" onClick={() => { onClose(); onArchiveClash?.(eventName.trim()); }}>Archive that meter</Button>
              : undefined}
          >
            {general}
          </Banner>
        )}
        <div className="rv-form__pair">
          <Field label="Name" required error={errorFor(save.error, 'name')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Telemetry events" autoFocus />
          </Field>
          <Field label="Event name" required hint="The name your systems send. Immutable once events exist." error={errorFor(save.error, 'event_name')}>
            <Input mono value={eventName} onChange={(e) => setEventName(e.target.value)} placeholder="telemetry_events" />
          </Field>
        </div>
        <Field label="Aggregation" required hint="Frozen once the meter exists — summaries already written were aggregated under the old rule." error={errorFor(save.error, 'aggregation')}>
          <Select value={aggregation} onChange={setAggregation} options={AGGREGATIONS} />
        </Field>
        <div className="rv-form__pair">
          {aggregation !== 'count' && aggregation !== 'unique' && (
            <Field label="Value key" hint="Where in the payload the number lives." error={errorFor(save.error, 'value_key')}>
              <Input mono value={valueKey} onChange={(e) => setValueKey(e.target.value)} placeholder="events" />
            </Field>
          )}
          {aggregation === 'unique' && (
            <Field label="Unique key" required hint="Distinct values of this payload key are counted." error={errorFor(save.error, 'unique_key')}>
              <Input mono value={uniqueKey} onChange={(e) => setUniqueKey(e.target.value)} placeholder="operator_id" />
            </Field>
          )}
          <Field label="Customer key" hint="Which payload key names the billing account." error={errorFor(save.error, 'customer_key')}>
            <Input mono value={customerKey} onChange={(e) => setCustomerKey(e.target.value)} />
          </Field>
        </div>
        <div className="rv-form__pair">
          <Field label="Unit label" hint="Singular — “event”, “GB”, “seat”." error={errorFor(save.error, 'unit_label')}>
            <Input value={unitLabel} onChange={(e) => setUnitLabel(e.target.value)} placeholder="event" />
          </Field>
          <AcceptanceWindowField
            text={windowText}
            onChange={setWindowText}
            error={acceptance.error}
            apiError={errorFor(save.error, 'acceptance_window_ms')}
            hint="How far back a reading may be dated before it is refused. A whole number of days."
          />
        </div>
        <Field label="Description">
          <Textarea minRows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Every measurement streamed into the platform, one row per gateway flush." />
        </Field>
      </form>
    </Modal>
  );
}

function MeterEditModal({ meter, onClose, onSaved }: { meter: Meter; onClose: () => void; onSaved: (meter: Meter) => void }) {
  const [name, setName] = useState(meter.name);
  const [unitLabel, setUnitLabel] = useState(meter.unit_label ?? '');
  const [description, setDescription] = useState(meter.description ?? '');
  const [status, setStatus] = useState(meter.status);
  const [windowText, setWindowText] = useState(String(Math.round(meter.acceptance_window_ms / DAY_MS)));
  const acceptance = parseWindowDays(windowText);

  const save = useMutation<void, Meter>(
    async () => api.patch<Meter>(`/v1/meters/${meter.id}`, {
      name,
      unit_label: unitLabel || undefined,
      description: description || undefined,
      status,
      acceptance_window_ms: (acceptance.days as number) * DAY_MS,
    }),
    { invalidates: ['/v1/meters', '/v1/metering/overview'], onSuccess: onSaved },
  );
  const general = generalError(save.error, ['name', 'unit_label', 'status', 'acceptance_window_ms']);
  const ready = !!name.trim() && acceptance.days !== null;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${meter.name}`}
      description="A meter’s aggregation and payload keys are frozen once it exists. Everything else can move."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready} loading={save.loading} onClick={() => { void save.run().catch(() => undefined); }}>Save changes</Button>
        </>
      }
    >
      <form className="rv-form" onSubmit={(e) => { e.preventDefault(); if (ready) void save.run().catch(() => undefined); }}>
        {general && <Banner tone="danger" compact>{general}</Banner>}
        <Field label="Name" required error={errorFor(save.error, 'name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="rv-form__pair">
          <Field label="Unit label" hint="Singular — “event”, “GB”, “seat”." error={errorFor(save.error, 'unit_label')}>
            <Input value={unitLabel} onChange={(e) => setUnitLabel(e.target.value)} />
          </Field>
          <Field
            label="Status"
            hint={status === 'archived'
              ? 'Archived: the meter stops listening and releases its event name for a new meter to claim.'
              : 'An inactive meter stops accepting events but keeps its event name reserved.'}
            error={errorFor(save.error, 'status')}
          >
            <Select
              value={status}
              onChange={(v) => setStatus(v as Meter['status'])}
              options={[
                { value: 'active', label: 'Active — listening' },
                { value: 'inactive', label: 'Inactive — paused, event name still reserved' },
                { value: 'archived', label: 'Archived — retired, event name released' },
              ]}
            />
          </Field>
        </div>
        <AcceptanceWindowField
          text={windowText}
          onChange={setWindowText}
          error={acceptance.error}
          apiError={errorFor(save.error, 'acceptance_window_ms')}
          hint="Readings older than this are refused rather than silently changing an invoiced total."
        />
        <Field label="Description">
          <Textarea minRows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

/**
 * Archiving is the operation that frees an event name.
 *
 * The create-meter conflict says "archive that meter first", so archiving has
 * to be something an operator can actually do — and it is not the same as
 * pausing: an inactive meter keeps its name reserved, an archived one does
 * not. Every summary, closure and settlement the meter already produced
 * survives, which is what makes this safe to offer without a typed phrase.
 */
function ArchiveMeterDialog({ meter, onClose }: { meter: Meter; onClose: () => void }) {
  const toast = useToast();
  const run = useMutation<void, Meter>(
    async () => api.patch<Meter>(`/v1/meters/${meter.id}`, { status: 'archived' }),
    {
      invalidates: ['/v1/meters', '/v1/metering/overview'],
      onSuccess: (updated) => {
        toast.success(`${updated.name} archived`, `The event name ${updated.event_name} is free for a new meter to claim.`);
        onClose();
      },
    },
  );

  return (
    <ConfirmDialog
      open
      onCancel={onClose}
      onConfirm={() => { void run.run().catch(() => undefined); }}
      loading={run.loading}
      title={`Archive ${meter.name}?`}
      confirmLabel="Archive the meter"
      body={(
        <>
          {`It stops listening for ${meter.event_name}, and that event name becomes available to a new meter. `}
          {'Every summary, billed period and settlement it has already produced is kept — archiving retires the instruction, not the record.'}
          {run.error ? ` — ${run.error.body.message}` : ''}
        </>
      )}
    />
  );
}

/* ============================== record an event =========================== */

function RecordEventModal({
  open, meters, onClose, initialMeter = null,
}: { open: boolean; meters: Meter[]; onClose: () => void; initialMeter?: string | null }) {
  const f = useFormat();
  const toast = useToast();
  const { customers } = useCustomerNames();
  const [meterId, setMeterId] = useState(initialMeter ?? '');
  useEffect(() => { if (open && initialMeter) setMeterId(initialMeter); }, [open, initialMeter]);
  const [customer, setCustomer] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [value, setValue] = useState<number | null>(1);
  const [uniqueValue, setUniqueValue] = useState('');
  const [backdate, setBackdate] = useState<number | null>(null);
  const [result, setResult] = useState<MeterEventResult | null>(null);

  const meter = meters.find((m) => m.id === meterId) ?? meters[0] ?? null;

  const send = useMutation<void, MeterEventResult>(
    async () => {
      if (!meter) throw new Error('no meter');
      const payload: Record<string, unknown> = { [meter.customer_key]: customer };
      if (meter.aggregation === 'unique' && meter.unique_key) payload[meter.unique_key] = uniqueValue;
      if (meter.value_key && value !== null) payload[meter.value_key] = value;
      return api.post<MeterEventResult>('/v1/meter-events', {
        event_name: meter.event_name,
        customer,
        identifier: identifier || undefined,
        ...(meter.aggregation === 'count' || meter.aggregation === 'unique' ? {} : { value: value ?? 0 }),
        ...(backdate ? { timestamp: backdate } : {}),
        payload,
      });
    },
    {
      invalidates: ['/v1/meter-events', '/v1/metering/overview', '/v1/meters'],
      onSuccess: (res) => {
        setResult(res);
        if (res.outcome === 'duplicate') toast.warning('That identifier was already recorded — nothing was written');
        else toast.success(`Recorded ${res.event.value_decimal} on ${meter?.name ?? 'the meter'}`);
      },
    },
  );

  const params = ['event_name', 'customer', 'identifier', 'value', 'timestamp'];
  const general = generalError(send.error, params);
  const ready = !!meter && !!customer;

  return (
    <Modal
      open={open}
      onClose={() => { setResult(null); send.reset(); onClose(); }}
      title="Record a usage event"
      description="The same call your systems make. Send an identifier you can reproduce and ingestion is exactly-once."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => { setResult(null); send.reset(); onClose(); }}>Close</Button>
          <Button variant="primary" disabled={!ready} loading={send.loading} onClick={() => { void send.run().catch(() => undefined); }}>Send event</Button>
        </>
      }
    >
      <form className="rv-form" onSubmit={(e) => { e.preventDefault(); if (ready) void send.run().catch(() => undefined); }}>
        {general && <Banner tone="danger" compact>{general}</Banner>}
        {result && (
          <Banner tone={result.outcome === 'duplicate' ? 'warning' : 'success'} compact title={result.outcome === 'duplicate' ? 'Duplicate — nothing was written' : 'Recorded'}>
            {result.outcome === 'duplicate'
              ? `The identifier ${result.event.identifier} was already claimed by an event recorded ${f.relative(result.event.received_at)}. The original was returned and no second row exists, which is what makes a replay safe.`
              : `${result.event.identifier} carried ${result.event.value_decimal} at ${f.dateTime(result.event.timestamp)}${result.event.late ? ' — and landed inside a period that has already been billed, so it is filed as a late arrival.' : '.'}`}
          </Banner>
        )}
        {meters.length === 0
          ? <EmptyState size="sm" title="No meter to send to" body={<EmptyBody>Create a meter first — an event with no meter listening for its name is refused.</EmptyBody>} />
          : (
            <>
              <div className="rv-form__pair">
                <Field label="Meter" required error={errorFor(send.error, 'event_name')}>
                  <Select
                    value={meter?.id ?? ''}
                    onChange={setMeterId}
                    options={meters.map((m) => ({ value: m.id, label: `${m.name} · ${m.event_name}` }))}
                  />
                </Field>
                <Field label="Customer" required hint="The billing account the usage belongs to." error={errorFor(send.error, 'customer')}>
                  <Select
                    value={customer}
                    onChange={setCustomer}
                    placeholder="Pick an account"
                    options={customers.map((c) => ({ value: c.id, label: c.name }))}
                  />
                </Field>
              </div>
              <div className="rv-form__pair">
                {meter && meter.aggregation !== 'count' && meter.aggregation !== 'unique' && (
                  <Field label={`Value${meter.unit_label ? ` (${meter.unit_label})` : ''}`} required error={errorFor(send.error, 'value')}>
                    <LiveNumberInput value={value} onChange={setValue} min={0} precision={2} />
                  </Field>
                )}
                {meter && meter.aggregation === 'unique' && (
                  <Field label={`Distinct ${meter.unique_key ?? 'key'}`} required hint="Counted once however many times it is seen in the period.">
                    <Input mono value={uniqueValue} onChange={(e) => setUniqueValue(e.target.value)} placeholder="op_4417" />
                  </Field>
                )}
                <Field label="Identifier" hint="Leave blank and the platform mints one. Reuse it to prove a replay writes nothing." error={errorFor(send.error, 'identifier')}>
                  <Input mono value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="gateway-flush-8841" />
                </Field>
              </div>
              <Field
                label="Backdate to"
                hint={meter
                  ? `Optional. This meter accepts readings from ${boundaryDate(f, f.now() - meter.acceptance_window_ms, true)} onwards; anything older is refused rather than moving an invoiced total.`
                  : undefined}
                error={errorFor(send.error, 'timestamp')}
              >
                <DatePicker value={backdate} onChange={setBackdate} max={f.now()} placeholder="Now" />
              </Field>
            </>
          )}
      </form>
    </Modal>
  );
}

/* =========================== ingestion inspector ========================== */

type InspectorTab = 'events' | 'withdrawn' | 'late' | 'closures';
const INSPECTOR_TABS = ['events', 'withdrawn', 'late', 'closures'] as const;

function IngestionInspector({
  meters, names, onRecord, initialTab,
}: {
  meters: Meter[];
  names: ReturnType<typeof useCustomerNames>;
  onRecord: () => void;
  /** Set when the operator arrives from the late-arrivals banner. */
  initialTab?: InspectorTab;
}) {
  const [tab, setTab] = useTabParam<InspectorTab>('inspect', INSPECTOR_TABS, 'events');
  const [meterFilter, setMeterFilter] = useState('');
  const [limit, setLimit] = useState(100);
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab, setTab]);

  const meterOptions = [{ value: '', label: 'Every meter' }, ...meters.map((m) => ({ value: m.id, label: m.name }))];

  return (
    <Section
      id="late-arrivals"
      title="Ingestion inspector"
      description="What was accepted, what was rejected as a replay, what was withdrawn, and what arrived after its period had been billed."
      actions={
        <Inline gap={3}>
          <Select size="sm" aria-label="Meter" value={meterFilter} onChange={setMeterFilter} options={meterOptions} />
          <SegmentedControl
            size="sm"
            aria-label="Rows to show"
            value={String(limit)}
            onChange={(v) => setLimit(Number(v))}
            options={[{ value: '50', label: '50' }, { value: '100', label: '100' }, { value: '200', label: '200' }]}
          />
          <Button size="sm" variant="secondary" iconLeft={<Icons.zap size={14} />} onClick={onRecord}>Record an event</Button>
        </Inline>
      }
    >
      <Card padding="none">
        <div style={{ padding: 'var(--space-5) var(--space-5) 0' }}>
          <SegmentedControl
            aria-label="Ingestion view"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'events', label: 'Recent events' },
              { value: 'withdrawn', label: 'Withdrawn' },
              { value: 'late', label: 'Late arrivals' },
              { value: 'closures', label: 'Billed periods' },
            ]}
          />
        </div>
        {tab === 'events' && <EventsTable meter={meterFilter} limit={limit} names={names} onRecord={onRecord} />}
        {tab === 'withdrawn' && <AdjustmentsTable meter={meterFilter} limit={limit} names={names} />}
        {tab === 'late' && <LateArrivalsTable meter={meterFilter} limit={limit} names={names} />}
        {tab === 'closures' && <ClosuresTable meter={meterFilter} limit={limit} names={names} />}
      </Card>
    </Section>
  );
}

function EventsTable({
  meter, limit, names, onRecord,
}: { meter: string; limit: number; names: ReturnType<typeof useCustomerNames>; onRecord: () => void }) {
  const f = useFormat();
  const toast = useToast();
  const table = useUrlTableState('e', { columnId: 'timestamp', direction: 'desc' });
  const events = useQuery<ListEnvelope<MeterEvent>>('/v1/meter-events', { meter: meter || undefined, limit });
  const [withdrawing, setWithdrawing] = useState<MeterEvent | null>(null);
  const rows = events.data?.data ?? [];

  const columns: DataTableColumn<MeterEvent>[] = useMemo(() => [
    {
      id: 'identifier', header: 'Identifier', pinned: true, accessor: (row) => row.identifier,
      cell: (row) => (
        <div className="rv-cell">
          <span className="rv-cell__top rv-mono">{row.identifier}</span>
          <span className="rv-cell__sub">{row.event_name}</span>
        </div>
      ),
      width: 250,
    },
    { id: 'customer', header: 'Customer', accessor: (row) => names.name(row.customer), cell: (row) => <CustomerName id={row.customer} names={names} />, width: 200 },
    { id: 'value', header: 'Value', align: 'right', accessor: (row) => row.value, filter: 'number', cell: (row) => <span className="rv-num">{row.value_decimal}</span> },
    {
      id: 'timestamp', header: 'Measured at', accessor: (row) => row.timestamp, filter: 'date',
      cell: (row) => <span className="rv-nowrap">{f.dateTime(row.timestamp)}</span>, width: 180,
    },
    {
      id: 'received_at', header: 'Received', accessor: (row) => row.received_at,
      cell: (row) => <span className="rv-nowrap rv-sub">{f.relative(row.received_at)}</span>, width: 140, defaultHidden: true,
    },
    {
      id: 'state', header: 'State', accessor: (row) => (row.cancelled ? 'withdrawn' : row.late ? 'late' : 'accepted'), filter: 'set',
      cell: (row) => (
        row.cancelled
          ? <Badge tone="danger" size="sm" dot>Withdrawn</Badge>
          : row.late
            ? <Badge tone="warning" size="sm" dot>Late — period billed</Badge>
            : <Badge tone="success" size="sm" dot>Accepted</Badge>
      ),
      width: 190,
    },
  ], [f, names]);

  return (
    <>
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        caption="Recorded usage events"
        loading={events.loading}
        error={events.error ? { message: events.error.body?.message, code: events.error.body?.code, requestId: events.error.body?.request_id } : null}
        onRetry={events.refetch}
        plain
        maxHeight={520}
        searchPlaceholder="Search identifiers and customers…"
        value={table.state}
        onChange={table.setState}
        toolbar={(
          <ExportCsvButton
            name="meter-events"
            noun="event"
            rows={visibleRows(rows, columns, table.state)}
            columns={[
              { header: 'Identifier', value: (row) => row.identifier },
              { header: 'Meter event', value: (row) => row.event_name },
              { header: 'Customer', value: (row) => names.name(row.customer) },
              { header: 'Value', value: (row) => row.value_decimal },
              { header: 'Measured at', value: (row) => csvInstant(row.timestamp) },
              { header: 'Received at', value: (row) => csvInstant(row.received_at) },
              { header: 'State', value: (row) => (row.cancelled ? 'withdrawn' : row.late ? 'late' : 'accepted') },
            ] satisfies CsvColumn<MeterEvent>[]}
          />
        )}
        rowActions={(row) => [{
          id: 'event',
          items: [
            {
              id: 'withdraw',
              label: 'Withdraw this event',
              icon: <Icons.trash size={14} />,
              danger: true,
              disabled: row.cancelled,
              onSelect: () => setWithdrawing(row),
            },
            {
              id: 'copy',
              label: 'Copy identifier',
              icon: <Icons.copy size={14} />,
              onSelect: () => { void navigator.clipboard?.writeText(row.identifier); toast.info('Identifier copied'); },
            },
          ],
        }]}
        empty={(
          <EmptyState
            title="No events on this meter yet"
            body={<EmptyBody>Ingestion is exactly-once: an identifier you can reproduce makes a replay write nothing.</EmptyBody>}
            action={<Button variant="primary" iconLeft={<Icons.zap size={15} />} onClick={onRecord}>Record an event</Button>}
          />
        )}
        footer={events.data?.has_more ? <span className="rv-sub" style={{ padding: 'var(--space-4) var(--space-5)' }}>Showing the {formatNumber(rows.length)} most recent — narrow by meter or raise the row count to see further back.</span> : null}
      />
      {withdrawing && <WithdrawEventModal event={withdrawing} onClose={() => setWithdrawing(null)} />}
    </>
  );
}

function WithdrawEventModal({ event, onClose }: { event: MeterEvent; onClose: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const run = useMutation<void, MeterEventAdjustment>(
    async () => api.post<MeterEventAdjustment>('/v1/meter-event-adjustments', {
      type: 'cancel',
      cancel: { identifier: event.identifier },
      event_name: event.event_name,
      reason: reason || undefined,
    }),
    {
      invalidates: ['/v1/meter-events', '/v1/meter-event-adjustments', '/v1/metering/overview', '/v1/meter-late-arrivals'],
      onSuccess: () => { toast.success(`${event.identifier} withdrawn — the hour it belonged to was rebuilt without it`); onClose(); },
    },
  );

  return (
    <Modal
      open
      onClose={onClose}
      title="Withdraw this event"
      icon={<AlertTriangleIcon size={18} />}
      iconTone="danger"
      description="The row survives and its identifier stays claimed, so a replay cannot resurrect it. The hour is rebuilt from the events that remain."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={run.loading} onClick={() => { void run.run().catch(() => undefined); }}>Withdraw event</Button>
        </>
      }
    >
      <Stack gap={5}>
        {run.error && <Banner tone="danger" compact>{run.error.body.message}</Banner>}
        <DescriptionList
          items={[
            { term: 'Identifier', value: <span className="rv-mono">{event.identifier}</span> },
            { term: 'Value', value: event.value_decimal },
            { term: 'Measured at', value: <EventTime ts={event.timestamp} /> },
          ]}
        />
        <Field label="Reason" hint="Written to the adjustment so the correction explains itself later.">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Gateway replayed the 22:00 shift after a network partition" autoFocus />
        </Field>
        {event.closure && (
          <Banner tone="warning" compact>
            This event sits inside a period that has already been billed. The billed total will not move — the withdrawal is filed as a negative true-up against that closure.
          </Banner>
        )}
      </Stack>
    </Modal>
  );
}

const EventTime = ({ ts }: { ts: number }) => {
  const f = useFormat();
  return <>{f.dateTime(ts)}</>;
};

function AdjustmentsTable({ meter, limit, names }: { meter: string; limit: number; names: ReturnType<typeof useCustomerNames> }) {
  const f = useFormat();
  const rowsQuery = useQuery<ListEnvelope<MeterEventAdjustment>>('/v1/meter-event-adjustments', { meter: meter || undefined, limit });
  const rows = rowsQuery.data?.data ?? [];
  const columns: DataTableColumn<MeterEventAdjustment>[] = useMemo(() => [
    { id: 'identifier', header: 'Identifier', pinned: true, accessor: (row) => row.identifier, cell: (row) => <span className="rv-mono">{row.identifier}</span>, width: 250 },
    { id: 'customer', header: 'Customer', accessor: (row) => names.name(row.customer), cell: (row) => <CustomerName id={row.customer} names={names} />, width: 200 },
    { id: 'value', header: 'Withdrawn', align: 'right', accessor: (row) => row.value, cell: (row) => <span className="rv-num rv-num--neg">{formatNumber(row.value)}</span> },
    { id: 'timestamp', header: 'Measured at', accessor: (row) => row.timestamp, cell: (row) => <span className="rv-nowrap">{f.dateTime(row.timestamp)}</span>, width: 180 },
    { id: 'reason', header: 'Reason', accessor: (row) => row.reason ?? '—', cell: (row) => <span className="rv-sub">{row.reason ?? '—'}</span> },
    {
      id: 'closure', header: 'Billed period', accessor: (row) => (row.closure ? 'yes' : 'no'), filter: 'set',
      cell: (row) => (row.closure ? <Badge tone="warning" size="sm">Trued up</Badge> : <Badge tone="neutral" size="sm">Open period</Badge>), width: 140,
    },
  ], [f, names]);

  return (
    <DataTable
      rows={rows}
      columns={columns}
      getRowId={(row) => row.id}
      caption="Withdrawn events"
      loading={rowsQuery.loading}
      error={rowsQuery.error ? { message: rowsQuery.error.body?.message, code: rowsQuery.error.body?.code, requestId: rowsQuery.error.body?.request_id } : null}
      onRetry={rowsQuery.refetch}
      plain
      maxHeight={520}
      searchPlaceholder="Search withdrawn events…"
      empty={(
        <EmptyState
          title="Nothing has been withdrawn"
          body={<EmptyBody>Cancel one from the recent-events tab: the row survives and its identifier stays claimed.</EmptyBody>}
        />
      )}
    />
  );
}

function LateArrivalsTable({ meter, limit, names }: { meter: string; limit: number; names: ReturnType<typeof useCustomerNames> }) {
  const f = useFormat();
  const rowsQuery = useQuery<ListEnvelope<MeterLateArrival>>('/v1/meter-late-arrivals', { meter: meter || undefined, limit });
  const [resolving, setResolving] = useState<MeterLateArrival | null>(null);
  const rows = rowsQuery.data?.data ?? [];

  const columns: DataTableColumn<MeterLateArrival>[] = useMemo(() => [
    { id: 'customer', header: 'Customer', pinned: true, accessor: (row) => names.name(row.customer), cell: (row) => <CustomerName id={row.customer} names={names} />, width: 210 },
    {
      id: 'period', header: 'Billed period', accessor: (row) => row.period_start,
      cell: (row) => <span className="rv-nowrap">{boundaryRange(f, row.period_start, row.period_end)}</span>, width: 200,
    },
    { id: 'value', header: 'Drift', align: 'right', accessor: (row) => row.value, cell: (row) => <span className={`rv-num${row.value < 0 ? ' rv-num--neg' : ' rv-num--pos'}`}>{formatNumber(row.value)}</span> },
    {
      id: 'amount', header: 'Worth', align: 'right', accessor: (row) => row.amount ?? 0,
      cell: (row) => <span className="rv-num">{row.amount === null ? '—' : moneyIn(f, row.amount, row.currency)}</span>,
    },
    { id: 'resolution', header: 'Resolution', accessor: (row) => row.resolution, filter: 'set', cell: (row) => <StatusChip status={row.resolution} />, width: 150 },
    { id: 'note', header: 'Note', accessor: (row) => row.note ?? '—', cell: (row) => <span className="rv-sub">{row.note ?? '—'}</span> },
  ], [f, names]);

  return (
    <>
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        caption="Usage that arrived after its period was billed"
        loading={rowsQuery.loading}
        error={rowsQuery.error ? { message: rowsQuery.error.body?.message, code: rowsQuery.error.body?.code, requestId: rowsQuery.error.body?.request_id } : null}
        onRetry={rowsQuery.refetch}
        plain
        maxHeight={520}
        searchPlaceholder="Search late arrivals…"
        rowActions={(row) => [{
          id: 'late',
          items: [{
            id: 'resolve',
            label: row.resolution === 'open' ? 'Settle this true-up' : 'Already settled',
            icon: <Icons.check size={14} />,
            disabled: row.resolution !== 'open',
            onSelect: () => setResolving(row),
          }],
        }]}
        empty={(
          <EmptyState
            title="Every billed period agrees with its meter"
            body={<EmptyBody>Nothing has landed inside a window an invoice was already drawn on.</EmptyBody>}
          />
        )}
      />
      {resolving && <ResolveLateArrivalModal entry={resolving} onClose={() => setResolving(null)} />}
    </>
  );
}

function ResolveLateArrivalModal({ entry, onClose }: { entry: MeterLateArrival; onClose: () => void }) {
  const f = useFormat();
  const toast = useToast();
  const [resolution, setResolution] = useState('credited');
  const [note, setNote] = useState('');
  const run = useMutation<void, MeterLateArrival>(
    async () => api.post<MeterLateArrival>(`/v1/meter-late-arrivals/${entry.id}/resolve`, {
      resolution,
      note: note || undefined,
    }),
    {
      invalidates: ['/v1/meter-late-arrivals', '/v1/metering/overview', '/v1/credit-billable-items', '/v1/credit-settlements'],
      onSuccess: (row) => { toast.success(`True-up ${humanize(row.resolution)}${row.amount !== null ? ` — ${moneyIn(f, row.amount, row.currency)}` : ''}`); onClose(); },
    },
  );

  return (
    <Modal
      open
      onClose={onClose}
      title="Settle this true-up"
      description="The unit of settlement is the period, not the entry: resolving this one settles every late reading on the same billed window alongside it."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={run.loading} onClick={() => { void run.run().catch(() => undefined); }}>Settle</Button>
        </>
      }
    >
      <Stack gap={5}>
        {run.error && <Banner tone="danger" compact>{run.error.body.message}</Banner>}
        <DescriptionList
          items={[
            { term: 'Period', value: boundaryRange(f, entry.period_start, entry.period_end) },
            { term: 'Drift', value: formatNumber(entry.value) },
            { term: 'Worth', value: entry.amount === null ? 'Not priced — the period was billed without naming a price' : moneyIn(f, entry.amount, entry.currency) },
          ]}
        />
        <Field label="Resolution" required error={errorFor(run.error, 'resolution')}>
          <RadioGroup
            label="Resolution"
            name="late-resolution"
            value={resolution}
            onChange={setResolution}
            options={[
              { value: 'credited', label: 'Credit the difference', hint: 'The period was over-billed. Money goes back, and unit credit returns to the grants that paid for it.' },
              { value: 'rebilled', label: 'Bill the difference', hint: 'The period was under-billed. A new invoice line is raised for exactly the drift.' },
              { value: 'ignored', label: 'Leave it', hint: 'Record the drift and move on. The only resolution that writes a word rather than money.' },
            ]}
          />
        </Field>
        <Field label="Note" hint="Kept with the entry so the decision explains itself a quarter later.">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Shift counted twice by the edge gateway" />
        </Field>
      </Stack>
    </Modal>
  );
}

function ClosuresTable({ meter, limit, names }: { meter: string; limit: number; names: ReturnType<typeof useCustomerNames> }) {
  const f = useFormat();
  const rowsQuery = useQuery<ListEnvelope<MeterPeriodClosure>>('/v1/meter-period-closures', { meter: meter || undefined, limit });
  const rows = rowsQuery.data?.data ?? [];
  const columns: DataTableColumn<MeterPeriodClosure>[] = useMemo(() => [
    { id: 'customer', header: 'Customer', pinned: true, accessor: (row) => names.name(row.customer), cell: (row) => <CustomerName id={row.customer} names={names} />, width: 210 },
    { id: 'period', header: 'Period', accessor: (row) => row.period_start, cell: (row) => <span className="rv-nowrap">{boundaryRange(f, row.period_start, row.period_end)}</span>, width: 200 },
    { id: 'total', header: 'Frozen total', align: 'right', accessor: (row) => row.total, cell: (row) => <span className="rv-num">{formatNumber(row.total)}</span> },
    { id: 'events', header: 'Events', align: 'right', accessor: (row) => row.event_count, cell: (row) => <span className="rv-num">{formatNumber(row.event_count)}</span> },
    {
      id: 'adjustment', header: 'Drift since', align: 'right', accessor: (row) => row.adjustment,
      cell: (row) => <span className={`rv-num${row.adjustment < 0 ? ' rv-num--neg' : row.adjustment > 0 ? ' rv-num--pos' : ''}`}>{row.adjustment === 0 ? '—' : formatNumber(row.adjustment)}</span>,
    },
    { id: 'closed_at', header: 'Closed', accessor: (row) => row.closed_at, cell: (row) => <span className="rv-sub rv-nowrap">{f.when(row.closed_at)}</span>, width: 150 },
  ], [f, names]);

  return (
    <DataTable
      rows={rows}
      columns={columns}
      getRowId={(row) => row.id}
      caption="Billed periods"
      loading={rowsQuery.loading}
      error={rowsQuery.error ? { message: rowsQuery.error.body?.message, code: rowsQuery.error.body?.code, requestId: rowsQuery.error.body?.request_id } : null}
      onRetry={rowsQuery.refetch}
      plain
      maxHeight={520}
      searchPlaceholder="Search billed periods…"
      empty={(
        <EmptyState
          title="No period has been frozen yet"
          body={<EmptyBody>A period closes when it is billed; anything landing inside it afterwards is a late arrival.</EmptyBody>}
        />
      )}
    />
  );
}

/* ============================== meter detail ============================== */

export function MeterDetailPage() {
  const { id } = useParams();
  const f = useFormat();
  const navigate = useNavigate();
  const names = useCustomerNames();
  const currency = useDefaultCurrency();
  const toast = useToast();
  const [granularity, setGranularity] = useTabParam<'hour' | 'day' | 'month'>('by', ['hour', 'day', 'month'], 'day');
  const [daysParam, setDaysParam] = useTabParam<'7' | '30' | '90' | '365'>('window', ['7', '30', '90', '365'], '30');
  const days = Number(daysParam);
  const [closing, setClosing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [recording, setRecording] = useState(false);

  const meter = useQuery<MeterDetail>(`/v1/meters/${id}`);
  // Rounded up to the hour so the request URL — which is the cache key — stops
  // changing on every render. Reading `now()` raw made each render ask for a
  // window one millisecond wider than the last, and the panel never resolved.
  const end = useMemo(() => Math.ceil(f.now() / HOUR_MS) * HOUR_MS, [f, days]);
  const start = end - days * DAY_MS;
  const summaries = useQuery<ListEnvelope<SummaryBucket>>(`/v1/meters/${id}/event-summaries`, { start, end, granularity });
  const customers = useQuery<ListEnvelope<MeterUsage>>(`/v1/meters/${id}/customers`, { start, end, limit: 25 });
  const economics = useQuery<RevenueUsage>('/v1/revenue/usage', { months: 12, currency });

  const buckets = summaries.data?.data ?? [];
  const meterEconomics = economics.data?.meters.find((row) => row.meter === id) ?? null;

  if (meter.error) {
    return (
      <Page title="Meter" eyebrow="Usage">
        <Card><SectionError error={meter.error} path={`GET /v1/meters/${id}`} onRetry={meter.refetch} /></Card>
      </Page>
    );
  }
  if (!meter.data) return <Page title="Meter" eyebrow="Usage"><Loading label="Reading the meter…" /></Page>;

  const m = meter.data;

  return (
    <Page
      title={m.name}
      eyebrow="Meter"
      badge={<span style={{ marginInlineStart: 'var(--space-4)' }}><StatusChip status={m.status} /></span>}
      subtitle={m.description ?? `Listening for ${m.event_name}, aggregated by ${m.aggregation}.`}
      actions={
        <Inline gap={3}>
          <Button variant="ghost" iconLeft={<ArrowLeftIcon size={15} />} onClick={() => navigate('/revenue/usage')}>All meters</Button>
          <Button variant="secondary" iconLeft={<Icons.zap size={15} />} onClick={() => setRecording(true)} disabled={m.status !== 'active'}>Record an event</Button>
          <Button variant="secondary" iconLeft={<Icons.edit size={15} />} onClick={() => setEditing(true)}>Edit meter</Button>
          <Button variant="secondary" iconLeft={<Icons.lock size={15} />} onClick={() => setClosing(true)}>Freeze a period</Button>
        </Inline>
      }
    >
      <Stack gap={7}>
        <div className="rv-tiles">
          <Card padding="tight"><Stat label="Events recorded" value={formatNumber(m.ingestion.event_count)} caption={m.ingestion.first_event_at ? `since ${f.date(m.ingestion.first_event_at)}` : 'nothing has arrived'} /></Card>
          <Card padding="tight"><Stat label="Customers" value={formatNumber(m.ingestion.customer_count)} caption="streaming into this meter" /></Card>
          <Card padding="tight"><Stat label="Last event" value={m.ingestion.last_event_at ? f.relative(m.ingestion.last_event_at) : '—'} caption={m.ingestion.last_event_at ? f.dateTime(m.ingestion.last_event_at) : 'nothing has arrived'} /></Card>
          {meterEconomics && (
            <>
              <Card padding="tight"><Stat label="Metered value · 12m" value={moneyIn(f, meterEconomics.metered_value, meterEconomics.currency)} caption={`${rateText(meterEconomics.charged_share)} charged, the rest covered by credit`} /></Card>
              <Card padding="tight">
                <Stat
                  label="Revenue per unit"
                  value={unitRateText(f, meterEconomics.revenue_per_unit, meterEconomics.currency, meterEconomics.unit_label)}
                  caption={meterEconomics.quantity_micro > 0
                    ? `${moneyIn(f, meterEconomics.metered_value, meterEconomics.currency)} over ${units(f, meterEconomics.quantity_micro / 1_000_000, meterEconomics.unit_label)}`
                    : 'nothing metered in the last twelve months'}
                />
              </Card>
            </>
          )}
        </div>

        <div className="rv-cols">
          <Card
            title="Event volume"
            description={`Read from the hourly pre-aggregate maintained on ingest — a bounded read whatever the volume behind it.`}
            actions={
              <Inline gap={3}>
                <SegmentedControl
                  size="sm"
                  aria-label="Granularity"
                  value={granularity}
                  onChange={(v) => setGranularity(v as 'hour' | 'day' | 'month')}
                  options={[{ value: 'hour', label: 'Hourly' }, { value: 'day', label: 'Daily' }, { value: 'month', label: 'Monthly' }]}
                />
                <SegmentedControl
                  size="sm"
                  aria-label="Window"
                  value={daysParam}
                  onChange={(v) => setDaysParam(v as '7' | '30' | '90' | '365')}
                  options={[{ value: '7', label: '7d' }, { value: '30', label: '30d' }, { value: '90', label: '90d' }, { value: '365', label: '1y' }]}
                />
                <ExportCsvButton
                  name={`meter-${m.event_name}-${granularity}`}
                  noun="bucket"
                  rows={buckets}
                  columns={[
                    { header: 'Period start', value: (row) => csvInstant(row.start) },
                    { header: 'Period end', value: (row) => csvInstant(row.end) },
                    { header: 'Granularity', value: () => granularity },
                    { header: 'Meter', value: () => m.name },
                    { header: `Value (${m.unit_label ?? 'units'})`, value: (row) => row.value },
                    { header: 'Events', value: (row) => row.event_count },
                  ] satisfies CsvColumn<SummaryBucket>[]}
                />
              </Inline>
            }
          >
            {summaries.error && <SectionError error={summaries.error} path={`GET /v1/meters/${id}/event-summaries`} onRetry={summaries.refetch} />}
            {!summaries.error && summaries.loading && <ChartSkeleton />}
            {!summaries.error && !summaries.loading && buckets.length === 0 && (
              <EmptyState
                size="sm"
                title="No usage in this window"
                body={<EmptyBody>Nothing has been measured on this meter in the period you picked. Widen the window, or send an event and watch it land.</EmptyBody>}
              />
            )}
            {buckets.length > 0 && (
              <AreaChart
                title={`${m.name} — ${granularity} volume`}
                description={`${m.aggregation} of ${m.unit_label ?? 'units'} per ${granularity}.`}
                categories={buckets.map((b) => (granularity === 'hour' ? f.time(b.start) : granularity === 'month' ? f.month(b.start) : f.date(b.start)))}
                series={[{ id: 'value', label: m.unit_label ? `${m.unit_label}s` : 'Value', values: buckets.map((b) => b.value) }]}
                height={260}
                valueFormat={(value) => formatNumber(value, { maxDecimals: 0 })}
              />
            )}
          </Card>

          <Card
            title="Top customers"
            description={`Period totals over the last ${days} days, largest first.`}
            actions={(
              <ExportCsvButton
                name={`meter-${m.event_name}-customers`}
                noun="customer"
                rows={customers.data?.data ?? []}
                columns={[
                  { header: 'Customer', value: (row) => names.name(row.customer) },
                  { header: 'Customer id', value: (row) => row.customer },
                  { header: 'Meter', value: () => m.name },
                  { header: `Value (${m.unit_label ?? 'units'})`, value: (row) => row.value },
                  { header: 'Events', value: (row) => row.event_count },
                  { header: 'Period still open', value: (row) => (row.pending ? 'yes' : 'no') },
                ] satisfies CsvColumn<MeterUsage>[]}
              />
            )}
          >
            {customers.error && <SectionError error={customers.error} path={`GET /v1/meters/${id}/customers`} onRetry={customers.refetch} />}
            {!customers.error && customers.loading && <Loading label="Reading the pre-aggregate…" />}
            {!customers.error && !customers.loading && (customers.data?.data ?? []).length === 0 && (
              <EmptyState size="sm" title="Nobody is streaming into this meter" body="No customer has sent an event in this window." illustration={null} />
            )}
            <div className="rv-rows">
              {(customers.data?.data ?? []).map((row) => (
                <div className="rv-row" key={row.customer}>
                  <div className="rv-row__main">
                    {names.known(row.customer)
                      ? (
                        <button type="button" className="rv-link rv-row__title" onClick={() => navigate(`/billing/customers/${row.customer}`)}>
                          {names.name(row.customer)}
                        </button>
                      )
                      : <div className="rv-row__title"><CustomerName id={row.customer} names={names} /></div>}
                    <div className="rv-row__sub">{f.plural(row.event_count, 'event')}{row.pending ? ' · period still open' : ''}</div>
                  </div>
                  <div className="rv-row__aside">
                    {formatNumber(row.value)} <span className="rv-muted">{pluralize(row.unit_label ?? 'unit', row.value)}</span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <Section title="How this meter is configured" actions={<BasisNote basis={economics.data?.basis} sources={economics.data?.sources} label="How usage revenue was computed" />}>
          <Card>
            <Grid minColumnWidth={220} gap={6}>
              <DescriptionList
                items={[
                  { term: 'Event name', value: <span className="rv-mono">{m.event_name}</span> },
                  { term: 'Aggregation', value: humanize(m.aggregation) },
                  { term: 'Value key', value: <span className="rv-mono">{m.value_key ?? '—'}</span> },
                  { term: 'Customer key', value: <span className="rv-mono">{m.customer_key}</span> },
                ]}
              />
              <DescriptionList
                items={[
                  { term: 'Unique key', value: <span className="rv-mono">{m.unique_key ?? '—'}</span> },
                  { term: 'Unit', value: m.unit_label ?? '—' },
                  { term: 'Accepts readings from', value: f.dateTime(m.ingestion.accepts_events_from) },
                  { term: 'And up to', value: f.dateTime(m.ingestion.accepts_events_until) },
                ]}
              />
            </Grid>
          </Card>
        </Section>
      </Stack>

      {closing && <ClosePeriodModal meter={m} onClose={() => setClosing(false)} />}
      {editing && (
        <MeterEditModal
          meter={m}
          onClose={() => setEditing(false)}
          onSaved={(updated) => { toast.success(`${updated.name} updated`); setEditing(false); }}
        />
      )}
      <RecordEventModal open={recording} meters={[m]} onClose={() => setRecording(false)} />
    </Page>
  );
}

function ClosePeriodModal({ meter, onClose }: { meter: MeterDetail; onClose: () => void }) {
  const f = useFormat();
  const toast = useToast();
  const { customers } = useCustomerNames();
  const prices = useQuery<ListEnvelope<PriceLite>>('/v1/prices', { limit: 100 });
  const [customer, setCustomer] = useState('');
  const [price, setPrice] = useState('');
  const [start, setStart] = useState<number | null>(f.now() - 30 * DAY_MS);
  const [end, setEnd] = useState<number | null>(f.now());

  const metered = (prices.data?.data ?? []).filter((p) => p.recurring?.meter === meter.event_name || p.recurring?.meter === meter.id);

  const run = useMutation<void, MeterPeriodClosure>(
    async () => api.post<MeterPeriodClosure>(`/v1/meters/${meter.id}/close-period`, {
      customer,
      period_start: start,
      period_end: end,
      price: price || undefined,
    }),
    {
      invalidates: ['/v1/meter-period-closures', '/v1/metering/overview', '/v1/meter-late-arrivals'],
      onSuccess: (closure) => {
        toast.success(
          `Period frozen at ${units(f, closure.total, meter.unit_label)}`,
          `${boundaryRange(f, closure.period_start, closure.period_end)} — anything landing inside it now is a late arrival.`,
        );
        onClose();
      },
    },
  );

  return (
    <Modal
      open
      onClose={onClose}
      title="Freeze a billed period"
      description="After a period is closed, events landing inside it are still recorded and still move the live total — but they are reported as late arrivals for a true-up instead of quietly disagreeing with the invoice."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={run.loading} disabled={!customer || !start || !end} onClick={() => { void run.run().catch(() => undefined); }}>Freeze period</Button>
        </>
      }
    >
      <form className="rv-form" onSubmit={(e) => { e.preventDefault(); void run.run().catch(() => undefined); }}>
        {generalError(run.error, ['customer', 'period_start', 'period_end', 'price']) && (
          <Banner tone="danger" compact>{run.error?.body.message}</Banner>
        )}
        <Field label="Customer" required error={errorFor(run.error, 'customer')}>
          <Select value={customer} onChange={setCustomer} placeholder="Pick an account" options={customers.map((c) => ({ value: c.id, label: c.name }))} />
        </Field>
        <div className="rv-form__pair">
          <Field label="Period starts" required error={errorFor(run.error, 'period_start')}>
            <DatePicker value={start} onChange={setStart} max={f.now()} />
          </Field>
          <Field label="Period ends" required error={errorFor(run.error, 'period_end')}>
            <DatePicker value={end} onChange={setEnd} max={f.now()} />
          </Field>
        </div>
        <Field
          label="Billed on price"
          hint="Name it and any later true-up can be priced to the cent; leave it out and the drift can only be recorded, not settled."
          error={errorFor(run.error, 'price')}
        >
          <Select
            value={price}
            onChange={setPrice}
            placeholder={metered.length ? 'Optional — pick the metered price' : 'No metered price bills from this meter'}
            options={metered.map((p) => ({ value: p.id, label: p.nickname ?? p.id }))}
          />
        </Field>
      </form>
    </Modal>
  );
}
