/**
 * The subscription schedule, made operable.
 *
 * A schedule is how a change that has already been agreed is put in the book
 * before it happens: the account stays on what it has until a renewal, and the
 * new plan takes over at that boundary without anyone remembering to do it.
 * Reading the phases was never the hard part — the three writes are, so they
 * are all here: put a subscription under a schedule, release it back, and stand
 * the whole thing down.
 *
 * Two rules this file keeps.
 *
 * No date on screen is arithmetic this file invented. A phase boundary is
 * whatever the server computed — `phase.window` and `phase.end_date` come back
 * from the API — and the one boundary chosen *before* the schedule exists is
 * the subscription's own `current_period_end`, which the API already sent. The
 * "in N renewals" option deliberately quotes no date, because the anchor-day
 * arithmetic that produces it lives on the server and a second implementation
 * here would eventually disagree with it.
 *
 * And the future plan is priced by the engine that will bill it:
 * `POST /v1/catalog/estimate` is the same `computeLineAmount` the invoice runs,
 * so what the phase card says the new plan costs is what the renewal charges.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, useQuery } from '../../kernel/api';
import {
  Badge, Banner, Button, Card, ConfirmDialog, Divider, Field, Grid, GridItem, Icons, Inline, Modal,
  NumberInput, Select, Stack, Textarea, humanize,
} from '../../design';
import {
  DialogFields, FieldRow, Loading, PreviewFailure, SectionError, idem, useAction, useBillingFormat, useDialogForm,
  usePricedPreview, useRecord,
} from './common';
import { useActivePrices } from './subscriptions';
import type {
  CatalogEstimate, Price, ScheduleStatus, SchedulePhase, Subscription, SubscriptionSchedule,
} from './types';

/* ------------------------------- shared bits ------------------------------ */

const scheduleStatusTone: Record<ScheduleStatus, 'success' | 'info' | 'neutral' | 'warning'> = {
  active: 'success', not_started: 'info', completed: 'neutral', released: 'neutral', canceled: 'warning',
};

const SCHEDULE_STATUS_COPY: Record<ScheduleStatus, string> = {
  not_started: 'Not started',
  active: 'Running',
  completed: 'Completed',
  released: 'Released',
  canceled: 'Canceled',
};

/** What the schedule does when the last phase ends, as a sentence. */
const endBehaviorCopy = (schedule: SubscriptionSchedule): string =>
  schedule.end_behavior === 'cancel'
    ? 'When the last phase ends, the subscription is canceled.'
    : 'When the last phase ends, the schedule steps out and the subscription carries on with whatever the last phase left it on.';

const isLive = (schedule: SubscriptionSchedule): boolean =>
  schedule.status === 'active' || schedule.status === 'not_started';

const priceName = (price: Price): string =>
  `${price.product_name}${price.nickname ? ` — ${price.nickname}` : ''}`;

const cadenceOf = (price: Price): string | null =>
  (price.recurring ? `${price.recurring.interval_count === 1 ? '' : `${price.recurring.interval_count} `}${price.recurring.interval}` : null);

/* ================================ the tab ================================= */

export function ScheduleTab({ scheduleId, subscription }: { scheduleId: string; subscription: Subscription }) {
  const f = useBillingFormat();
  const action = useAction();
  // Kept across its own invalidation: releasing a schedule must not blink the
  // panel that holds the button away before the new state arrives.
  const { data, loading, error, refetch } = useRecord<SubscriptionSchedule>(`/v1/subscription-schedules/${scheduleId}`);
  const [confirm, setConfirm] = useState<'release' | 'cancel' | null>(null);

  if (error) {
    return <Card><SectionError error={error} path={`GET /v1/subscription-schedules/${scheduleId}`} onRetry={refetch} /></Card>;
  }
  if (loading || !data) return <Card><Loading label="Loading the schedule…" /></Card>;

  const live = isLive(data);
  const upcoming = data.phases.filter((phase) => phase.state === 'upcoming').length;
  const invalidates = ['/v1/subscriptions', '/v1/subscription-schedules', '/v1/invoices'];

  const release = () => {
    setConfirm(null);
    void action.run(
      api.post<SubscriptionSchedule>(`/v1/subscription-schedules/${data.id}/release`, {}),
      {
        success: 'Released from the schedule',
        description: 'The subscription runs on exactly as it is; the phases still to come are dropped.',
        failure: 'The schedule could not be released',
      },
      invalidates,
    );
  };

  const cancel = () => {
    setConfirm(null);
    void action.run(
      api.post<SubscriptionSchedule>(`/v1/subscription-schedules/${data.id}/cancel`, { prorate: false }, { idempotencyKey: idem() }),
      {
        success: 'Schedule and subscription canceled',
        description: 'Both stopped now. Nothing further will be billed on this agreement.',
        failure: 'The schedule could not be canceled',
      },
      invalidates,
    );
  };

  return (
    <Stack gap={6}>
      <Card
        title="Schedule phases"
        description={endBehaviorCopy(data)}
        actions={live ? (
          <Inline gap={3}>
            <Button size="sm" variant="secondary" loading={action.busy} onClick={() => setConfirm('release')}>
              Release the subscription
            </Button>
            <Button size="sm" variant="danger-ghost" onClick={() => setConfirm('cancel')}>
              Cancel the schedule…
            </Button>
          </Inline>
        ) : undefined}
      >
        <div className="bl-schedmeta">
          <FieldRow label="Status">
            <Inline gap={3}>
              <Badge tone={scheduleStatusTone[data.status] ?? 'neutral'} dot pill>{SCHEDULE_STATUS_COPY[data.status] ?? humanize(data.status)}</Badge>
              {data.status === 'not_started' && data.starts_in_days > 0 && (
                <span className="bl-sub">{`Starts ${f.day(data.start_date)} — in ${data.starts_in_days === 1 ? 'a day' : `${data.starts_in_days} days`}.`}</span>
              )}
              {data.status === 'released' && data.released_at !== null && (
                <span className="bl-sub">{`Released ${f.dateTime(data.released_at)}.`}</span>
              )}
              {data.status === 'canceled' && data.canceled_at !== null && (
                <span className="bl-sub">{`Canceled ${f.dateTime(data.canceled_at)}.`}</span>
              )}
              {data.status === 'completed' && data.completed_at !== null && (
                <span className="bl-sub">{`Ran to the end ${f.day(data.completed_at)}.`}</span>
              )}
            </Inline>
          </FieldRow>
          <FieldRow label="Next boundary" hint={data.current_phase_ends === null ? undefined : 'When the phase now running hands over.'}>
            {data.current_phase_ends === null ? '—' : f.day(data.current_phase_ends)}
          </FieldRow>
          <FieldRow label="Id"><span className="u-mono bl-sub">{data.id}</span></FieldRow>
        </div>

        <Divider />

        {data.phases.map((phase) => <PhaseRow key={phase.id} phase={phase} />)}
      </Card>

      <ConfirmDialog
        open={confirm === 'release'}
        onCancel={() => setConfirm(null)}
        title="Release this subscription from its schedule?"
        body={
          `${subscription.items.map((item) => item.description).join(', ')} keeps billing exactly as it is now, on the same cycle. `
          + `${upcoming === 0
            ? 'There are no phases still to come, so nothing planned is lost.'
            : `The ${f.plural(upcoming, 'phase')} still to come ${upcoming === 1 ? 'is' : 'are'} dropped — the plan change they carry will not happen on its own.`}`
        }
        confirmLabel="Release it"
        tone="brand"
        onConfirm={release}
      />
      <ConfirmDialog
        open={confirm === 'cancel'}
        onCancel={() => setConfirm(null)}
        tone="danger"
        title="Cancel the schedule and the subscription?"
        body={
          'This stops both immediately — the schedule ends and the subscription it manages is canceled now, not at the period end. '
          + 'To keep the subscription running and only drop the future phases, release it instead.'
        }
        confirmLabel="Cancel both"
        onConfirm={cancel}
      />
    </Stack>
  );
}

function PhaseRow({ phase }: { phase: SchedulePhase }) {
  const f = useBillingFormat();
  return (
    <div className="bl-phase">
      <div>
        <Badge tone={phase.state === 'current' ? 'success' : phase.state === 'complete' ? 'neutral' : 'info'}>
          {humanize(phase.state)}
        </Badge>
        <div className="bl-phase__when" style={{ marginTop: 'var(--space-3)' }}>{f.day(phase.start_date)}</div>
      </div>
      <div>
        <div className="bl-phase__summary">{phase.summary}</div>
        <div className="bl-phase__desc">{phase.window}{phase.description ? ` — ${phase.description}` : ''}</div>
      </div>
    </div>
  );
}

/* ============================== create dialog ============================= */

interface PhaseDraft { key: string; price: string; quantity: number }

/**
 * Put a running subscription under a schedule: it keeps what it has until a
 * renewal, then moves to the plan agreed here.
 *
 * The first phase is the subscription exactly as it is today, so nothing about
 * this period changes. Only the second phase is chosen.
 */
export function ScheduleChangeDialog({ sub, open, onClose }: {
  sub: Subscription; open: boolean; onClose: () => void;
}) {
  const f = useBillingFormat();
  const action = useAction();
  const { prices } = useActivePrices();
  const [when, setWhen] = useState<'next' | 'later'>('next');
  const [renewals, setRenewals] = useState(2);
  const [rows, setRows] = useState<PhaseDraft[]>([]);
  const [endBehavior, setEndBehavior] = useState<'release' | 'cancel'>('release');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open) return;
    setWhen('next');
    setRenewals(2);
    setEndBehavior('release');
    setNote('');
    action.clear();
    setRows(sub.items.map((item, index) => ({ key: `${item.id}-${index}`, price: item.price, quantity: item.quantity })));
  }, [open, sub.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const sellable = useMemo(
    () => prices.filter((price) => price.type === 'recurring' && price.currencies.includes(sub.currency) && price.model !== 'custom'),
    [prices, sub.currency],
  );
  const priceById = useMemo(() => new Map(sellable.map((price) => [price.id, price])), [sellable]);
  const options = useMemo(() => sellable.map((price) => ({
    value: price.id,
    label: priceName(price),
    description: price.display?.summary ?? undefined,
    group: price.recurring?.usage_type === 'metered' ? 'Metered — billed on usage' : 'Recurring',
  })), [sellable]);

  const basket = useMemo(() => rows
    .filter((row) => priceById.has(row.price))
    .map((row) => ({
      price: row.price,
      quantity: priceById.get(row.price)?.recurring?.usage_type === 'metered' ? 1 : Math.max(1, row.quantity),
    })), [rows, priceById]);

  // The same engine that will bill the phase, asked what it costs. A metered
  // line has nothing to quote until usage arrives, so it prices at zero here
  // and says so on its own row rather than flattering the total.
  const estimate = usePricedPreview<CatalogEstimate>(
    '/v1/catalog/estimate',
    useMemo(() => ({ currency: sub.currency, lines: basket }), [sub.currency, basket]),
    open && basket.length > 0,
  );

  const cadences = useMemo(() => {
    const set = new Set<string>();
    for (const row of basket) {
      const cadence = cadenceOf(priceById.get(row.price) as Price);
      if (cadence) set.add(cadence);
    }
    return [...set];
  }, [basket, priceById]);

  const duplicate = useMemo(() => {
    const seen = new Set<string>();
    for (const row of basket) {
      if (seen.has(row.price)) return priceById.get(row.price) ?? null;
      seen.add(row.price);
    }
    return null;
  }, [basket, priceById]);

  const blocked = duplicate
    ? `${priceName(duplicate)} is on this phase twice. Change the quantity on one row instead of adding a second.`
    : cadences.length > 1
      ? `Every price in a phase has to share one billing interval, and these bill every ${f.list(cadences)}.`
      : basket.length === 0
        ? 'Choose at least one price for the phase that takes over.'
        : null;

  const perPeriod = estimate.data
    ? estimate.data.recurring.day + estimate.data.recurring.week + estimate.data.recurring.month + estimate.data.recurring.year
    : null;

  const submit = async () => {
    const first = when === 'next'
      ? { items: currentItems(sub), end_date: sub.current_period_end }
      : { items: currentItems(sub), iterations: renewals };
    const body = {
      from_subscription: sub.id,
      end_behavior: endBehavior,
      phases: [
        { ...first, proration_behavior: 'none' as const, description: `Stays on ${sub.items.map((i) => i.description).join(', ')}.` },
        {
          items: basket,
          proration_behavior: 'create_prorations' as const,
          ...(note.trim() ? { description: note.trim() } : {}),
        },
      ],
    };
    const result = await action.run(
      api.post<SubscriptionSchedule>('/v1/subscription-schedules', body, { idempotencyKey: idem() }),
      {
        success: 'Change scheduled',
        description: when === 'next'
          ? `It takes effect on ${f.day(sub.current_period_end)}, at the next renewal.`
          : `It takes effect after ${renewals} more billing periods.`,
        failure: 'The schedule was refused',
        inlineOnly: true,
      },
      ['/v1/subscriptions', '/v1/subscription-schedules'],
    );
    if (result) onClose();
  };

  const form = useDialogForm(open, !blocked && !!estimate.data && !estimate.loading && !action.busy, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Schedule a change for a future period"
      description="Nothing about the period now running changes. The new plan takes over at a renewal, with no proration to argue about."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={action.busy}
            // Nothing is booked that could not be priced: the estimate call and
            // the schedule call share the same engine, so a refusal here is the
            // refusal the create would have raised a moment later.
            disabled={!!blocked || !estimate.data || estimate.loading}
            onClick={() => { void submit(); }}
          >
            {when === 'next' ? `Schedule it for ${f.day(sub.current_period_end)}` : 'Schedule it'}
          </Button>
        </>
      }
    >
      <DialogFields form={form}>
      <Stack gap={6}>
        <Grid columns={2} gap={5}>
          <GridItem>
            <Field label="Take over" hint="The switch always lands on a billing boundary, never mid-period.">
              <Select
                value={when}
                onChange={(value) => setWhen(value as 'next' | 'later')}
                options={[
                  { value: 'next', label: `At the next renewal — ${f.day(sub.current_period_end)}` },
                  { value: 'later', label: 'After several more renewals' },
                ]}
              />
            </Field>
          </GridItem>
          <GridItem>
            <Field
              label="Renewals on the current plan"
              hint={when === 'later'
                ? 'Counted from the start of the period now running. The exact dates are shown on the schedule once it exists — they come from the billing engine, not from this screen.'
                : `One — the period now running, which ends ${f.day(sub.current_period_end)}.`}
            >
              <NumberInput
                aria-label="Renewals on the current plan"
                value={when === 'later' ? renewals : 1}
                min={1}
                max={120}
                disabled={when === 'next'}
                onChange={(value) => setRenewals(Math.max(1, value ?? 1))}
              />
            </Field>
          </GridItem>
        </Grid>

        <div>
          <div className="bl-phasehead">Then this subscription bills for</div>
          <div className="bl-items">
            {rows.map((row, index) => {
              const price = priceById.get(row.price);
              const metered = price?.recurring?.usage_type === 'metered';
              return (
                <div key={row.key} className="bl-item">
                  <Select
                    aria-label={`Price for phase item ${index + 1}`}
                    value={row.price}
                    options={options.length ? options : [{ value: row.price, label: row.price }]}
                    onChange={(value) => setRows((all) => all.map((r) => (r.key === row.key ? { ...r, price: value } : r)))}
                  />
                  <NumberInput
                    aria-label={`Quantity for phase item ${index + 1}`}
                    value={row.quantity}
                    min={1}
                    max={1000000}
                    disabled={metered}
                    onChange={(value) => setRows((all) => all.map((r) => (r.key === row.key ? { ...r, quantity: value ?? 1 } : r)))}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove phase item ${index + 1}`}
                    iconLeft={<Icons.trash size={14} />}
                    disabled={rows.length === 1}
                    onClick={() => setRows((all) => all.filter((r) => r.key !== row.key))}
                  />
                  {metered && <div className="bl-item__meta">Metered — the quantity comes from usage when the period closes.</div>}
                </div>
              );
            })}
          </div>
          <Inline gap={3} style={{ marginTop: 'var(--space-5)' }}>
            <Button
              size="sm"
              variant="secondary"
              iconLeft={<Icons.plus size={14} />}
              disabled={!sellable.length}
              onClick={() => setRows((all) => [...all, {
                key: `new-${all.length}-${Date.now()}`,
                price: sellable[0]?.id ?? '',
                quantity: 1,
              }])}
            >
              Add a price
            </Button>
          </Inline>
        </div>

        <Field label="What this phase is for" hint="Printed on the schedule, so whoever opens it next knows what was agreed.">
          <Textarea
            aria-label="What this phase is for"
            value={note}
            minRows={2}
            maxRows={4}
            placeholder="Plant-wide rollout on Growth with twelve operator seats."
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>

        <Field label="When the last phase ends" hint="A schedule always runs out; this is what it leaves behind.">
          <Select
            value={endBehavior}
            onChange={(value) => setEndBehavior(value as 'release' | 'cancel')}
            options={[
              { value: 'release', label: 'Release — the subscription carries on with the new plan' },
              { value: 'cancel', label: 'Cancel — the subscription ends there' },
            ]}
          />
        </Field>

        <Divider />

        {blocked && (
          <Banner tone="warning" compact title="This cannot be scheduled yet">{blocked}</Banner>
        )}
        {!blocked && estimate.error && (
          <PreviewFailure
            error={estimate.error}
            path="POST /v1/catalog/estimate"
            onRetry={estimate.refetch}
            refusalTitle="This phase cannot be priced"
          />
        )}
        {!blocked && !estimate.error && estimate.loading && !estimate.data && <Loading label="Pricing the new plan…" />}
        {!blocked && !estimate.error && estimate.data && (
          <div className="bl-phasepreview">
            <div className="bl-phasepreview__head">
              <span>What the new plan bills, every period</span>
              <span className="bl-phasepreview__total">{f.money(perPeriod ?? 0, { currency: sub.currency })}</span>
            </div>
            {estimate.data.lines.map((line) => (
              <div key={line.price} className="bl-phasepreview__row">
                <span>
                  {line.quantity > 1 ? `${line.quantity} × ` : ''}
                  {line.product?.name ?? line.price}
                  {line.nickname ? ` — ${line.nickname}` : ''}
                </span>
                <span>
                  {priceById.get(line.price)?.recurring?.usage_type === 'metered'
                    ? 'billed on recorded usage'
                    : line.amount_display}
                </span>
              </div>
            ))}
            <div className="bl-phasepreview__foot">
              {`Priced by POST /v1/catalog/estimate — the same computeLineAmount the invoice engine runs, in ${sub.currency.toUpperCase()}. `}
              {`Today this subscription bills ${f.money(sub.recurring_subtotal, { currency: sub.currency })} per ${sub.interval_display}.`}
            </div>
          </div>
        )}
        {action.error && (
          <PreviewFailure
            error={action.error}
            path="POST /v1/subscription-schedules"
            onRetry={action.clear}
            refusalTitle="The schedule was refused"
          />
        )}
      </Stack>
      </DialogFields>
    </Modal>
  );
}

const currentItems = (sub: Subscription) => sub.items.map((item) => ({
  price: item.price,
  quantity: item.metered ? 1 : item.quantity,
  ...(item.custom_unit_amount !== null ? { custom_unit_amount: item.custom_unit_amount } : {}),
}));

/* ============================= record summary ============================= */

/** The one-line schedule note the subscription overview carries. */
export function ScheduleBanner({ sub, onOpen }: { sub: Subscription; onOpen: () => void }) {
  const f = useBillingFormat();
  const { data } = useQuery<SubscriptionSchedule>(sub.schedule ? `/v1/subscription-schedules/${sub.schedule}` : null);
  if (!data || !isLive(data)) return null;
  const next = data.phases.find((phase) => phase.state === 'upcoming');
  return (
    <Banner
      tone="info"
      title={next ? `A change is already booked for ${f.day(next.start_date)}` : 'This subscription is under a schedule'}
      actions={<Button size="sm" variant="secondary" onClick={onOpen}>Open the schedule</Button>}
    >
      {next
        ? `${next.summary}${next.description ? ` — ${next.description}` : ''}`
        : endBehaviorCopy(data)}
    </Banner>
  );
}
