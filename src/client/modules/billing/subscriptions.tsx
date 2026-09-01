/**
 * Subscriptions: the book, one subscription, and every change an operator can
 * make to it.
 *
 * The change dialog is the point of this screen. `POST /v1/subscriptions/:id/
 * preview` is the same pure function `PATCH /v1/subscriptions/:id` settles
 * with, so what is drawn here — every credit, every charge, the window each
 * covers, the exact fraction of the interval behind it and the sentence that
 * reconstructs the number — is what the invoice will say. The preview's own
 * `proration_date` is sent back with the change, so the two cannot drift even
 * by the seconds the operator spent reading it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, useQuery, type ApiClientError, type ListEnvelope } from '../../kernel/api';
import { useNavigate, useParams, useSearchParam } from '../../kernel/router';
import { useSession } from '../../kernel/session';
import {
  Badge, Banner, Button, Card, Checkbox, Combobox, DataTable, DatePicker, Divider, EmptyState, Field,
  Grid, GridItem, Icons, Inline, Input, Menu, Modal, NumberInput, Page, Section, Select,
  Stack, Tabs, Textarea, Tooltip, humanize, useToast,
  type DataTableColumn, type MenuSection,
} from '../../design';
import { AlertTriangleIcon, ArrowDownIcon, ArrowRightIcon, ArrowUpIcon, ArrowUpRightIcon, XCircleIcon } from '../../design';
import {
  Amount, BookFooter, DialogFields, EmptyList, ExportCsvButton, FieldRow, FixedQuantity, InlineEdit, ListFailure, ListFooter,
  LoadFailedEmpty, Loading, MoneyField, MoneyRangeFilter, MoneyTotals, PreviewFailure, QuantityField, RecordLink,
  RecordMissing, SectionError, StatusPill, TableSearch, breakdownLabel, customerHref, decodeRange, encodeRange, idem,
  invoiceHref, lineWhy, matchesRange, moneyRank, prorationCopy, rangeActive, statusLabel, subscriptionHref,
  csvAmount, csvDay, totalsByCurrency, useAction, useBillingFormat, useBookList, useBookTotal, useCurrencyChoices, useDebounced,
  useDialogForm,
  useOpenOnQuery, usePricedPreview, useRecord, useRecordTab, useTableView, visibleRows,
} from './common';
import type { CsvColumn } from './common';
import type {
  BilledPeriod, CatalogEstimate, ChangePreview, Customer, CustomUnitAmount, EstimateLine, Invoice,
  InvoiceLine, PauseBehavior, Price, ProrationLine, Subscription, SubscriptionItem, SubscriptionSchedule,
} from './types';
import { ScheduleBanner, ScheduleChangeDialog, ScheduleTab } from './schedules';

/**
 * The recurring book as a file: what each agreement bills, on what cadence, and
 * where its period sits. MRR excludes paused agreements exactly as the screen
 * does, and the recurring fee is beside it so the two are never confused.
 */
const SUBSCRIPTION_CSV: CsvColumn<Subscription>[] = [
  { header: 'Account', value: (row) => row.customer_detail?.name ?? row.customer },
  { header: 'Status', value: (row) => statusLabel(row.status) },
  { header: 'Currency', value: (row) => row.currency.toUpperCase() },
  { header: 'MRR', value: (row) => csvAmount(row.mrr, row.currency) },
  { header: 'Recurring fee', value: (row) => csvAmount(row.recurring_subtotal, row.currency) },
  { header: 'Billed', value: (row) => row.interval_display },
  { header: 'Items', value: (row) => row.items.length },
  { header: 'Collection', value: (row) => humanize(row.collection_method) },
  { header: 'Period start', value: (row) => csvDay(row.current_period_start) },
  { header: 'Period end', value: (row) => csvDay(row.current_period_end) },
  { header: 'Started', value: (row) => csvDay(row.start_date) },
  { header: 'Trial ends', value: (row) => csvDay(row.trial_end) },
  { header: 'Cancels at', value: (row) => csvDay(row.cancel_at) },
  { header: 'Customer id', value: (row) => row.customer },
  { header: 'Subscription id', value: (row) => row.id },
];

/* ------------------------------- shared data ----------------------------- */

export function useActivePrices(): { prices: Price[]; loading: boolean } {
  const { data, loading } = useQuery<ListEnvelope<Price>>('/v1/prices', { active: true, limit: 200 });
  return { prices: data?.data ?? [], loading };
}

/**
 * A price with no per-unit component sells one of itself. Handing it a spinner
 * invites an operator to buy two platform fees, which is not a thing, and the
 * server refuses it after the fact rather than the screen refusing it before.
 */
const flatPrice = (price: Price | undefined): boolean =>
  !!price && price.model === 'flat' && price.recurring?.usage_type !== 'metered';

const priceLabel = (price: Price): string =>
  `${price.product_name}${price.nickname ? ` — ${price.nickname}` : ''}`;

const priceOption = (price: Price) => ({
  value: price.id,
  label: priceLabel(price),
  description: price.display?.summary ?? undefined,
  group: price.recurring?.usage_type === 'metered' ? 'Metered' : price.type === 'recurring' ? 'Recurring' : 'One-off',
});

/** A customer picker that searches the API rather than loading the whole book. */
export function CustomerPicker({ value, onChange, invalid, placeholder, emptyOption, size, label }: {
  value: string;
  onChange: (id: string) => void;
  invalid?: boolean;
  placeholder?: string;
  /** Offers a "no account" row, so the same control can clear a filter. */
  emptyOption?: string;
  size?: 'sm' | 'md';
  label?: string;
}) {
  const { data } = useQuery<ListEnvelope<Customer>>('/v1/customers', { limit: 200 });
  const row = (c: Customer) => ({ value: c.id, label: c.name, description: c.email ?? c.id });
  const options = useMemo(() => {
    const all = (data?.data ?? []).map(row);
    return emptyOption ? [{ value: '', label: emptyOption, description: 'Every account' }, ...all] : all;
  }, [data, emptyOption]);
  // The "any account" row belongs at the top of an unsearched list, not at the
  // top of the matches: leaving it there makes it the highlighted option, so
  // Enter after typing an account name clears the filter instead of setting it.
  const search = useCallback(async (query: string) => {
    const page = await api.get<ListEnvelope<Customer>>('/v1/customers', { query, limit: 20 });
    const all = page.data.map(row);
    return emptyOption && !query.trim() ? [{ value: '', label: emptyOption, description: 'Every account' }, ...all] : all;
  }, [emptyOption]);
  return (
    <Combobox
      value={value}
      onChange={(next) => onChange(next as unknown as string)}
      options={options}
      onSearch={search}
      invalid={invalid}
      size={size}
      placeholder={placeholder ?? 'Search accounts…'}
      aria-label={label ?? 'Customer'}
    />
  );
}

/* ============================ proration preview =========================== */

/** The one notice the server writes as an API instruction rather than a sentence. */
const WAITING_NOTICE = 'These lines wait on the next invoice for this subscription. Use proration_behavior=always_invoice to bill them straight away.';

export function ProrationPreview({ preview, pending, onBillNow }: {
  preview: ChangePreview; pending: boolean; onBillNow?: () => void;
}) {
  const f = useBillingFormat();
  const money = (amount: number) => f.money(amount, { currency: preview.currency });
  const credits = preview.lines.filter((line) => line.amount < 0);
  const charges = preview.lines.filter((line) => line.amount >= 0);
  const intervalChanged = preview.interval_before.interval !== preview.interval_after.interval
    || preview.interval_before.interval_count !== preview.interval_after.interval_count;
  // The cycle only moves when the anchor is reset or the cadence changes; short
  // of that, `next_period` is the period the subscription is already in.
  const rebased = preview.next_period.start !== preview.current_period.start
    || preview.next_period.end !== preview.current_period.end;

  return (
    <div className="bl-preview" style={{ opacity: pending ? 0.55 : 1 }} aria-busy={pending}>
      {preview.notices.map((notice) => (
        notice === WAITING_NOTICE
          ? (
            <Banner key={notice} tone="info" compact title="These lines wait for the next invoice">
              {`They go onto the bill raised on ${f.day(preview.next_invoice.date)}, priced exactly as they are above. `}
              {onBillNow ? 'Bill them straight away instead:' : 'Choose “Always invoice” above to bill them straight away.'}
              {onBillNow && (
                <Inline gap={3} style={{ marginTop: 'var(--space-4)' }}>
                  <Button size="sm" variant="secondary" onClick={onBillNow}>Bill them now instead</Button>
                </Inline>
              )}
            </Banner>
          )
          : <Banner key={notice} tone="info" compact>{notice}</Banner>
      ))}
      {intervalChanged && (
        <Banner tone="warning" compact title="The billing cadence changes">
          {`Every ${preview.interval_before.interval_count} ${preview.interval_before.interval} becomes every `
            + `${preview.interval_after.interval_count} ${preview.interval_after.interval}, so the cycle restarts here.`}
        </Banner>
      )}

      {preview.lines.length === 0 ? (
        <EmptyState
          size="sm"
          inline
          illustration={null}
          title="Nothing to prorate"
          body={
            preview.proration_behavior === 'none'
              ? 'Proration is switched off for this change, so the period already paid for stands and the new price starts at the next renewal.'
              : 'This change does not move any money inside the current period. Edit an item above to see what it would cost.'
          }
        />
      ) : (
        <>
          {credits.length > 0 && <LineGroup title="Credited back" lines={credits} currency={preview.currency} />}
          {charges.length > 0 && <LineGroup title="Charged for the rest of the period" lines={charges} currency={preview.currency} />}
        </>
      )}

      <div className="bl-totals">
        <div className="bl-total">
          <span className="bl-total__label">Credit for unused time</span>
          <span className="bl-total__value">{money(preview.credit_total)}</span>
        </div>
        <div className="bl-total">
          <span className="bl-total__label">Charge for remaining time</span>
          <span className="bl-total__value">{money(preview.charge_total)}</span>
        </div>
        <div className="bl-total">
          <span className="bl-total__label">Net movement</span>
          <span className="bl-total__value">{money(preview.net)}</span>
        </div>
        <div className="bl-total">
          <span className="bl-total__label">Account balance today</span>
          <span className="bl-total__value">
            {preview.customer_balance <= 0
              ? `${money(Math.abs(preview.customer_balance))} of credit`
              : `${money(preview.customer_balance)} carried forward`}
          </span>
        </div>
      </div>

      <div className="bl-duenow">
        <span className="bl-duenow__label">
          {preview.amount_due_now > 0 ? 'Collected now' : 'Nothing is collected now'}
        </span>
        <span className="bl-duenow__value">{money(preview.amount_due_now)}</span>
      </div>

      <Card variant="sunken" padding="tight">
        <Inline justify="between" wrap gap={5}>
          <span className="bl-sub">Monthly recurring revenue</span>
          <span className="bl-mrrmove">
            <span>{money(preview.mrr_before)}</span>
            <ArrowRightIcon size={14} className="bl-mrrmove__arrow" />
            <span className="bl-strong">{money(preview.mrr_after)}</span>
            <Badge tone={preview.mrr_delta > 0 ? 'success' : preview.mrr_delta < 0 ? 'danger' : 'neutral'}>
              {preview.mrr_delta === 0 ? 'no change' : `${preview.mrr_delta > 0 ? '+' : '−'}${money(Math.abs(preview.mrr_delta))}`}
            </Badge>
          </span>
        </Inline>
      </Card>

      {/*
        When the cycle is not reset, `next_period` *is* the current period: the
        card prices the recurring fee over the window the subscription is in
        now, and only the date it will be billed on is in the future. Heading it
        "Next invoice · <date>" put a date on lines covering a different period,
        so it says which of the two it is showing.
      */}
      <Section
        title={rebased ? `Next invoice · ${f.day(preview.next_invoice.date)}` : 'The recurring fee, as this change would leave it'}
        description={rebased
          ? `The cycle restarts here, so the next bill covers ${f.dayRange(preview.next_period.start, preview.next_period.end)}.`
          : `Priced over ${f.dayRange(preview.next_period.start, preview.next_period.end)}, the period this subscription is in. `
            + `It is billed on ${f.day(preview.next_invoice.date)}, for the period that begins then.`}
      >
        <div className="bl-tablewrap">
          <table className="bl-lines">
            <thead>
              <tr><th>Line</th><th>Qty</th><th className="bl-num">Amount</th></tr>
            </thead>
            <tbody>
              {preview.next_invoice.lines.map((line, i) => (
                <tr key={`${line.price}-${i}`}>
                  <td>
                    <div>{line.description}</div>
                    <div className="bl-lines__why">{f.dayRange(line.period.start, line.period.end)}</div>
                  </td>
                  <td>{f.number(line.quantity)}</td>
                  <td className="bl-num">
                    {line.amount === null
                      ? <span className="bl-muted">metered — billed in arrears</span>
                      : f.money(line.amount, { currency: line.currency })}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="bl-strong">Subtotal</td>
                <td />
                <td className="bl-num bl-strong">{money(preview.next_invoice.subtotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function LineGroup({ title, lines, currency }: { title: string; lines: ProrationLine[]; currency: string }) {
  return (
    <Stack gap={4}>
      <div className="bl-headline__label">{title}</div>
      {lines.map((line, index) => (
        <ProrationRow key={`${line.subscription_item ?? line.price}-${line.kind}-${index}`} line={line} currency={currency} />
      ))}
    </Stack>
  );
}

/**
 * A line on the bill that has not been raised yet.
 *
 * Same rule as the invoice's own lines and the change preview's: the sentence
 * that reconstructs the number stays on the line, and the unreduced rational it
 * carries — `2591921671/2592000000 ms` — goes behind a disclosure. It was
 * printing inline here alone, which is how the one surface that shows a real
 * customer-facing line ended up reading like a stack trace.
 */
function UpcomingLineRow({ line }: { line: InvoiceLine }) {
  const f = useBillingFormat();
  const [open, setOpen] = useState(false);
  const why = prorationCopy(line.explanation, line.proration_fraction);
  return (
    <>
      <tr className={line.amount < 0 ? 'bl-lines__row--credit' : undefined}>
        <td>
          <div>{line.description}</div>
          {lineWhy(line.description, why.sentence) && (
            <div className="bl-lines__why">{why.sentence}</div>
          )}
          {why.exact && (
            <button type="button" className="bl-lines__toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {open ? <ArrowUpIcon size={12} /> : <ArrowDownIcon size={12} />}
              {open ? 'Hide the arithmetic' : 'Show the arithmetic'}
            </button>
          )}
        </td>
        <td className="bl-nowrap">{f.dayRange(line.period.start, line.period.end)}</td>
        <td>{f.number(line.quantity)}</td>
        <td className="bl-num">{line.amount_display}</td>
      </tr>
      {open && why.exact && (
        <tr>
          <td colSpan={4}>
            <div className="bl-lines__why">
              {'Prorated by '}
              <span className="bl-fraction">
                {f.number(why.exact.numerator)} / {f.number(why.exact.denominator)} ms
              </span>
              {' of the interval'}
              {why.exact.reduced
                ? `, or ${f.number(why.exact.reduced.numerator)} / ${f.number(why.exact.reduced.denominator)} in lowest terms.`
                : '.'}
              {' That exact rational is multiplied into the price and rounded once — never a float.'}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * One priced credit or charge.
 *
 * The server's explanation carries both the human sentence and the exact
 * rational behind it — "10d 23h of it remaining at Sep 1 = 950131963/2678400000
 * ms = +$638.53". Printing the ten-digit fraction inline made a priced change
 * read like a stack trace, so the sentence stays and the arithmetic goes behind
 * the same disclosure the invoice lines use, reduced and with its units named.
 */
function ProrationRow({ line, currency }: { line: ProrationLine; currency: string }) {
  const f = useBillingFormat();
  const [open, setOpen] = useState(false);
  const why = prorationCopy(line.explanation, line.proration);
  return (
    <div className={`bl-prorow ${line.amount < 0 ? 'bl-prorow--credit' : 'bl-prorow--charge'}`}>
      <span className="bl-prorow__icon">
        {line.amount < 0 ? <ArrowDownIcon size={15} /> : <ArrowUpIcon size={15} />}
      </span>
      <div>
        <div className="bl-prorow__desc">{line.description}</div>
        <div className="bl-prorow__why">{why.sentence}</div>
        <div className="bl-prorow__meta">
          <Inline gap={3} wrap>
            <span>{f.dayRange(line.period.start, line.period.end)}</span>
            <span>{humanize(line.kind)}</span>
            {why.exact && (
              <button type="button" className="bl-lines__toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
                {open ? 'Hide the arithmetic' : 'Show the arithmetic'}
              </button>
            )}
          </Inline>
        </div>
        {open && why.exact && (
          <div className="bl-prorow__exact">
            <span className="bl-fraction">
              {f.number(why.exact.numerator)} / {f.number(why.exact.denominator)} ms
            </span>
            {' of the interval'}
            {why.exact.reduced && (
              <>
                {', or '}
                <span className="bl-fraction">
                  {f.number(why.exact.reduced.numerator)} / {f.number(why.exact.reduced.denominator)}
                </span>
                {' in lowest terms'}
              </>
            )}
            {'. That exact rational is multiplied into the price and rounded once — never a float.'}
          </div>
        )}
      </div>
      <span className={`bl-prorow__amount ${line.amount < 0 ? 'bl-prorow__amount--credit' : ''}`}>
        {f.money(line.amount, { currency })}
      </span>
    </div>
  );
}

/* ============================== change dialog ============================= */

interface DraftItem {
  key: string;
  id: string | null;
  price: string;
  quantity: number;
  metered: boolean;
  deleted: boolean;
  original: { price: string; quantity: number } | null;
}

const toDraft = (sub: Subscription): DraftItem[] => sub.items.map((item) => ({
  key: item.id,
  id: item.id,
  price: item.price,
  quantity: item.quantity,
  metered: item.metered,
  deleted: false,
  original: { price: item.price, quantity: item.quantity },
}));

const changed = (draft: DraftItem[]): boolean => draft.some((item) => (
  item.deleted || !item.original || item.price !== item.original.price || item.quantity !== item.original.quantity
));

function itemsPayload(draft: DraftItem[]): { id?: string; price?: string; quantity?: number; deleted?: boolean }[] {
  const payload: { id?: string; price?: string; quantity?: number; deleted?: boolean }[] = [];
  for (const item of draft) {
    if (item.deleted) {
      if (item.id) payload.push({ id: item.id, deleted: true });
      continue;
    }
    if (item.id) payload.push({ id: item.id, price: item.price, quantity: item.quantity });
    else payload.push({ price: item.price, quantity: item.quantity });
  }
  return payload;
}

export function ChangeDialog({ sub, open, onClose }: { sub: Subscription; open: boolean; onClose: () => void }) {
  const f = useBillingFormat();
  const action = useAction();
  const { prices } = useActivePrices();
  const [draft, setDraft] = useState<DraftItem[]>(() => toDraft(sub));
  const [behavior, setBehavior] = useState(sub.proration_behavior);
  const [anchor, setAnchor] = useState<'unchanged' | 'now'>('unchanged');
  const [preview, setPreview] = useState<ChangePreview | null>(null);
  const [pending, setPending] = useState(false);
  const [previewError, setPreviewError] = useState<ApiClientError | null>(null);
  const seq = useRef(0);
  const priceById = useMemo(() => new Map(prices.map((price) => [price.id, price])), [prices]);

    // Keyed on the id, not the object: an invalidation elsewhere re-reads the
  // subscription, and resetting the operator's half-made change on that is how
  // an edit disappears under them.
  useEffect(() => { if (open) { setDraft(toDraft(sub)); setPreview(null); setPreviewError(null); } },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, sub.id]);

  const body = useMemo(() => ({
    items: itemsPayload(draft),
    proration_behavior: behavior,
    billing_cycle_anchor: anchor,
  }), [draft, behavior, anchor]);
  const bodyKey = JSON.stringify(body);

  useEffect(() => {
    if (!open) return;
    const ticket = ++seq.current;
    setPending(true);
    const timer = setTimeout(() => {
      api.post<ChangePreview>(`/v1/subscriptions/${sub.id}/preview`, JSON.parse(bodyKey))
        .then((result) => { if (ticket === seq.current) { setPreview(result); setPreviewError(null); } })
        .catch((e: ApiClientError) => { if (ticket === seq.current) { setPreviewError(e); setPreview(null); } })
        .finally(() => { if (ticket === seq.current) setPending(false); });
    }, 300);
    return () => clearTimeout(timer);
  }, [bodyKey, open, sub.id]);

  const priceOptions = useMemo(() => prices.map(priceOption), [prices]);
  const dirty = changed(draft);
  // The server refuses with the price id in the sentence; find the row it means
  // so the refusal points at a control rather than only at the operator.
  const offending = previewError && previewError.status < 500
    ? draft.find((item) => previewError.body.message.includes(item.price))?.key ?? null
    : null;

  const apply = async () => {
    if (!preview) return;
    const result = await action.run(
      api.patch<Subscription>(`/v1/subscriptions/${sub.id}`, {
        ...JSON.parse(bodyKey) as Record<string, unknown>,
        // The date the preview priced. Sending it back is what makes the charge
        // identical to the quote rather than merely close to it.
        proration_date: preview.proration_date,
      }),
      {
        success: 'Subscription changed',
        description: preview.amount_due_now > 0
          ? `${f.money(preview.amount_due_now, { currency: preview.currency })} was collected now.`
          : 'The proration is waiting on the next invoice.',
        failure: 'The change was refused',
      },
      ['/v1/subscriptions', '/v1/invoices', '/v1/customers', '/v1/revenue'],
    );
    if (result) onClose();
  };

  const form = useDialogForm(open, dirty && !!preview && !pending && !action.busy, () => { void apply(); });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="Change this subscription"
      description="Every credit and charge below is priced by the same function that will issue the invoice."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={action.busy}
            disabled={!dirty || !preview || pending}
            onClick={() => { void apply(); }}
          >
            {preview && preview.amount_due_now > 0
              ? `Apply and collect ${f.money(preview.amount_due_now, { currency: preview.currency })}`
              : 'Apply change'}
          </Button>
        </>
      }
    >
      <DialogFields form={form}>
      <Stack gap={6}>
        <Section title="Items" description="Swap a price to move plan; change a quantity to add or drop seats.">
          <div className="bl-items">
            {draft.map((item, index) => (
              <div key={item.key} className="bl-item" style={item.deleted ? { opacity: 0.5 } : undefined}>
                <Select
                  aria-label={`Price for item ${index + 1}`}
                  value={item.price}
                  disabled={item.deleted}
                  options={priceOptions.length ? priceOptions : [{ value: item.price, label: item.price }]}
                  onChange={(price) => setDraft((rows) => rows.map((row) => (row.key === item.key ? { ...row, price } : row)))}
                />
                {item.metered || flatPrice(priceById.get(item.price))
                  ? (
                    <FixedQuantity
                      label={`Quantity for item ${index + 1}`}
                      why={item.metered
                        ? 'Counted from recorded usage when the period closes.'
                        : 'A flat fee sells one of itself, whatever the plan is counted in.'}
                    />
                  )
                  : (
                    <QuantityField
                      label={`Quantity for item ${index + 1}`}
                      value={item.quantity}
                      min={0}
                      disabled={item.deleted}
                      onChange={(quantity) => setDraft((rows) => rows.map((row) => (row.key === item.key ? { ...row, quantity } : row)))}
                    />
                  )}
                <Tooltip content={item.deleted ? 'Keep this item' : 'Remove this item'}>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={item.deleted ? `Keep item ${index + 1}` : `Remove item ${index + 1}`}
                    iconLeft={item.deleted ? <Icons.refresh size={14} /> : <Icons.trash size={14} />}
                    onClick={() => setDraft((rows) => (
                      item.id
                        ? rows.map((row) => (row.key === item.key ? { ...row, deleted: !row.deleted } : row))
                        : rows.filter((row) => row.key !== item.key)
                    ))}
                  />
                </Tooltip>
                {item.metered && (
                  <div className="bl-item__meta">Metered — the quantity comes from usage when the period closes.</div>
                )}
              </div>
            ))}
          </div>
          <Inline gap={3} style={{ marginTop: 'var(--space-5)' }}>
            <Button
              size="sm"
              variant="secondary"
              iconLeft={<Icons.plus size={14} />}
              disabled={!prices.length}
              onClick={() => setDraft((rows) => [...rows, {
                key: `new-${rows.length}-${Date.now()}`,
                id: null,
                price: prices[0]?.id ?? '',
                quantity: 1,
                metered: prices[0]?.recurring?.usage_type === 'metered',
                deleted: false,
                original: null,
              }])}
            >
              Add an item
            </Button>
            <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => setDraft(toDraft(sub))}>Reset</Button>
          </Inline>
        </Section>

        <Grid columns={2} gap={5}>
          <GridItem>
            <Field label="Proration" hint="How the money already paid for this period is treated.">
              <Select
                value={behavior}
                onChange={(value) => setBehavior(value as typeof behavior)}
                options={[
                  { value: 'create_prorations', label: 'Create prorations — wait for the next invoice' },
                  { value: 'always_invoice', label: 'Always invoice — bill the difference now' },
                  { value: 'none', label: 'None — the change starts at the next renewal' },
                ]}
              />
            </Field>
          </GridItem>
          <GridItem>
            <Field label="Billing cycle" hint="Restarting the cycle bills a fresh period from today.">
              <Select
                value={anchor}
                onChange={(value) => setAnchor(value as 'unchanged' | 'now')}
                options={[
                  { value: 'unchanged', label: `Keep the cycle — renews ${f.day(sub.current_period_end)}` },
                  { value: 'now', label: 'Reset the cycle to today' },
                ]}
              />
            </Field>
          </GridItem>
        </Grid>

        <Divider />

        {previewError && (
          <PreviewFailure
            error={previewError}
            path={`POST /v1/subscriptions/${sub.id}/preview`}
            onRetry={() => setDraft((rows) => [...rows])}
            refusalTitle="This change cannot be priced"
          />
        )}
        {!previewError && !preview && <Loading label="Pricing this change…" />}
        {!previewError && preview && (
          <ProrationPreview
            preview={preview}
            pending={pending}
            onBillNow={behavior === 'always_invoice' ? undefined : () => setBehavior('always_invoice')}
          />
        )}
      </Stack>
      </DialogFields>
    </Modal>
  );
}

/* =========================== lifecycle dialogs ============================ */

/**
 * The three pause behaviours as sentences.
 *
 * `humanize('keep_as_draft')` gives "Keep as draft", which reads as an
 * instruction rather than a description — "invoices raised while paused are
 * keep as draft". These are the same words the pause dialog offers.
 */
export const PAUSE_BEHAVIOR_COPY: Record<PauseBehavior, string> = {
  keep_as_draft: 'held as drafts',
  void: 'voided as they are raised',
  mark_uncollectible: 'written off as they are raised',
};

function CancelDialog({ sub, open, onClose }: { sub: Subscription; open: boolean; onClose: () => void }) {
  const f = useBillingFormat();
  const action = useAction();
  const [atPeriodEnd, setAtPeriodEnd] = useState(true);
  const [prorate, setProrate] = useState(false);
  const [reason, setReason] = useState('cancellation_requested');
  const [comment, setComment] = useState('');

  const submit = async () => {
    const result = await action.run(
      api.post<Subscription>(`/v1/subscriptions/${sub.id}/cancel`, {
        at_period_end: atPeriodEnd,
        prorate: atPeriodEnd ? false : prorate,
        cancellation_reason: reason,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      }, { idempotencyKey: idem() }),
      {
        success: atPeriodEnd ? 'Set to cancel at the period end' : 'Subscription canceled',
        description: atPeriodEnd ? `It runs until ${f.day(sub.current_period_end)}.` : 'It stopped immediately.',
        failure: 'The cancellation was refused',
      },
      ['/v1/subscriptions', '/v1/customers', '/v1/invoices', '/v1/revenue'],
    );
    if (result) onClose();
  };

  const form = useDialogForm(open, !action.busy, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cancel this subscription"
      icon={<AlertTriangleIcon size={18} />}
      iconTone="danger"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Keep it running</Button>
          <Button variant="danger" loading={action.busy} onClick={() => { void submit(); }}>
            {atPeriodEnd ? 'Cancel at period end' : 'Cancel now'}
          </Button>
        </>
      }
    >
      <DialogFields form={form}>
      <Stack gap={5}>
        <Field label="When">
          <Select
            value={atPeriodEnd ? 'period_end' : 'now'}
            onChange={(value) => setAtPeriodEnd(value === 'period_end')}
            options={[
              { value: 'period_end', label: `At the end of the paid period — ${f.day(sub.current_period_end)}` },
              { value: 'now', label: 'Immediately' },
            ]}
          />
        </Field>
        {!atPeriodEnd && (
          <Checkbox
            checked={prorate}
            onChange={(checked) => setProrate(checked)}
            label="Give back the unused remainder as account credit"
            hint="A cancellation never becomes a payment — the credit comes off whatever is billed next."
          />
        )}
        <Field label="Reason">
          <Select
            value={reason}
            onChange={setReason}
            options={[
              'cancellation_requested', 'too_expensive', 'missing_features', 'lost_to_competitor',
              'downgraded', 'switched_to_annual', 'went_out_of_business', 'payment_failed', 'other',
            ].map((value) => ({ value, label: humanize(value) }))}
          />
        </Field>
        <Field label="Note" optional error={action.errorFor('comment')}>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What the customer said, for whoever reads this in a year."
            maxLength={1000}
          />
        </Field>
      </Stack>
      </DialogFields>
    </Modal>
  );
}

function PauseDialog({ sub, open, onClose }: { sub: Subscription; open: boolean; onClose: () => void }) {
  const action = useAction();
  const session = useSession();
  const [behavior, setBehavior] = useState<'keep_as_draft' | 'mark_uncollectible' | 'void'>('keep_as_draft');
  const [resumesAt, setResumesAt] = useState<number | null>(null);

  const submit = async () => {
    const result = await action.run(
      api.post<Subscription>(`/v1/subscriptions/${sub.id}/pause`, {
        behavior,
        ...(resumesAt ? { resumes_at: resumesAt } : {}),
      }),
      { success: 'Collection paused', description: 'The cycle keeps advancing; the bills are held.', failure: 'The pause was refused' },
      ['/v1/subscriptions', '/v1/invoices', '/v1/customers'],
    );
    if (result) onClose();
  };

  const form = useDialogForm(open, !action.busy, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Pause collection"
      description="The billing cycle keeps running. What happens to the invoices it raises is up to you."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={action.busy} onClick={() => { void submit(); }}>Pause collection</Button>
        </>
      }
    >
      <DialogFields form={form}>
      <Stack gap={5}>
        <Field label="What happens to invoices raised while paused">
          <Select
            value={behavior}
            onChange={(value) => setBehavior(value as typeof behavior)}
            options={[
              { value: 'keep_as_draft', label: 'Hold them as drafts — finalise them later' },
              { value: 'mark_uncollectible', label: 'Write them off as they are raised' },
              { value: 'void', label: 'Void them as they are raised' },
            ]}
          />
        </Field>
        <Field label="Resume automatically on" optional hint="Leave empty to resume by hand.">
          <DatePicker value={resumesAt} onChange={setResumesAt} min={session.now()} aria-label="Resume on" />
        </Field>
      </Stack>
      </DialogFields>
    </Modal>
  );
}

function ResumeDialog({ sub, open, onClose }: { sub: Subscription; open: boolean; onClose: () => void }) {
  const action = useAction();
  const [anchor, setAnchor] = useState<'unchanged' | 'now'>('unchanged');
  const submit = async () => {
    const result = await action.run(
      api.post<Subscription>(`/v1/subscriptions/${sub.id}/resume`, { billing_cycle_anchor: anchor }),
      { success: 'Subscription resumed', description: 'Collection is on again.', failure: 'The resume was refused' },
      ['/v1/subscriptions', '/v1/invoices', '/v1/customers'],
    );
    if (result) onClose();
  };
  const form = useDialogForm(open, !action.busy, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Resume this subscription"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={action.busy} onClick={() => { void submit(); }}>Resume</Button>
        </>
      }
    >
      <DialogFields form={form}>
        <Field label="Billing cycle">
          <Select
            value={anchor}
            onChange={(value) => setAnchor(value as 'unchanged' | 'now')}
            options={[
              { value: 'unchanged', label: 'Pick the old cycle back up' },
              { value: 'now', label: 'Restart the cycle from today' },
            ]}
          />
        </Field>
      </DialogFields>
    </Modal>
  );
}

/**
 * A balance adjustment — the platform's discount, which the next bill draws down.
 *
 * Named end to end for what it is. It used to be reached from a trigger called
 * "Adjust the balance", open a dialog titled "Grant account credit" and confirm
 * with a button reading "Grant credit" — the exact label of the button beside
 * it, which opens the prepaid-credit dialog, a different mechanism whose own
 * copy takes pains to say it "is not a balance adjustment".
 */
export function CreditDialog({ customer, currency, open, onClose, subscription, initialDirection = 'credit', title, description: intro }: {
  customer: string; currency: string; open: boolean; onClose: () => void; subscription?: string;
  /** Opens on the charge side for the one-off billing flow. */
  initialDirection?: 'credit' | 'debit';
  title?: string;
  description?: string;
}) {
  const f = useBillingFormat();
  const action = useAction();
  const [amount, setAmount] = useState<number | null>(null);
  const [direction, setDirection] = useState<'credit' | 'debit'>(initialDirection);
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (open) { setAmount(null); setDescription(''); setDirection(initialDirection); action.clear(); }
  }, [open, initialDirection]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    const result = await action.run(
      api.post(`/v1/customers/${customer}/balance_transactions`, {
        amount: direction === 'credit' ? -(amount ?? 0) : (amount ?? 0),
        description: description.trim(),
        type: 'adjustment',
        ...(subscription ? { subscription } : {}),
      }, { idempotencyKey: idem() }),
      {
        success: direction === 'credit' ? 'Credit granted' : 'Charge carried forward',
        description: `${f.money(amount ?? 0, { currency })} ${direction === 'credit' ? 'comes off' : 'is added to'} the next invoice.`,
        failure: 'The adjustment was refused',
      },
      ['/v1/customers', '/v1/subscriptions'],
    );
    if (result) onClose();
  };

  const form = useDialogForm(open, !!amount && description.trim().length >= 3 && !action.busy, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title ?? 'Adjust the account balance'}
      description={intro
        ?? 'This is how a discount is given here: the balance moves, and the next invoice draws it down. It is not prepaid credit — that is a pot bought up front, granted from Payment & credit.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={action.busy}
            disabled={!amount || description.trim().length < 3}
            onClick={() => { void submit(); }}
          >
            {amount
              ? direction === 'credit'
                ? `Credit ${f.money(amount, { currency })}`
                : `Charge ${f.money(amount, { currency })}`
              : 'Apply the adjustment'}
          </Button>
        </>
      }
    >
      <DialogFields form={form}>
      <Stack gap={5}>
        <Field label="Direction">
          <Select
            value={direction}
            onChange={(value) => setDirection(value as 'credit' | 'debit')}
            options={[
              { value: 'credit', label: 'Credit the account — reduces the next invoice' },
              { value: 'debit', label: 'Debit the account — adds to the next invoice' },
            ]}
          />
        </Field>
        <Field label="Amount" required error={action.errorFor('amount')}>
          <MoneyField value={amount} onChange={setAmount} currency={currency} min={1} label="Amount" />
        </Field>
        <Field
          label="Why"
          required
          hint="This shows on the ledger and on the invoice that draws it down."
          error={action.errorFor('description')}
          counter={{ value: description.length, max: 300 }}
        >
          <Input
            value={description}
            maxLength={300}
            placeholder="Goodwill credit for the 6 March ingestion outage"
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </Stack>
      </DialogFields>
    </Modal>
  );
}

export { MoneyField };

/* ============================== create dialog ============================= */

/**
 * A cadence as a suffix on an option label: "/month", "/year".
 * `interval_count` is on the wire, so "every 3 months" says so rather than
 * quietly reading as monthly.
 */
const cadenceSuffix = (interval: { unit: string; count: number } | null): string => {
  if (!interval) return '';
  return interval.count === 1 ? ` per ${interval.unit}` : ` per ${interval.count} ${interval.unit}s`;
};

/**
 * A negotiated price's bounds in the currency the account bills in — the
 * per-currency override when there is one, the price's own otherwise.
 */
const boundsFor = (price: Price | undefined, currency: string): CustomUnitAmount | null => {
  if (!price || price.model !== 'custom') return null;
  return price.currency_options?.[currency.toLowerCase()]?.custom_unit_amount ?? price.custom_unit_amount ?? null;
};

const presetFor = (price: Price | undefined, currency: string): number | null =>
  boundsFor(price, currency)?.preset ?? null;

/** "every 1 month" is how a machine says it; "every month" is how a person does. */
const cadencePhrase = (count: number, unit: string): string =>
  (count === 1 ? unit : `${count} ${unit}s`);

/**
 * New subscription — priced before it is sold.
 *
 * The item picker used to list seventeen bare strings and the numbers only
 * arrived on the record afterwards, which is the one thing this screen cannot
 * afford: a subscription is a commitment, and you should not learn what you
 * sold by reading the invoice it raised. There is no preview route for a
 * subscription that does not exist yet — `POST /v1/invoices/create_preview`
 * needs an id — so every figure here comes from `POST /v1/catalog/estimate`,
 * which prices the whole basket in the account's own currency with the same
 * function the invoice engine bills with. One request prices every option in
 * the list *and* the basket, so the labels and the panel can never disagree.
 */
export function SubscriptionCreateDialog({ open, onClose, customer }: {
  open: boolean; onClose: () => void; customer?: string;
}) {
  const f = useBillingFormat();
  const navigate = useNavigate();
  const action = useAction();
  const { prices, loading: pricesLoading } = useActivePrices();
  const [customerId, setCustomerId] = useState(customer ?? '');
  const [rows, setRows] = useState<{ key: string; price: string; quantity: number; custom: number | null }[]>([]);
  const [trialDays, setTrialDays] = useState<number | null>(null);
  const [collection, setCollection] = useState<'charge_automatically' | 'send_invoice'>('charge_automatically');
  const [anchorDay, setAnchorDay] = useState<number | null>(null);

  // The account decides the currency every figure below is quoted in, so the
  // record is read even when the picker is locked to one.
  const account = useQuery<Customer>(customerId ? `/v1/customers/${customerId}` : null, undefined, { enabled: open && !!customerId });
  const currency = account.data?.currency ?? f.currency;

  useEffect(() => {
    if (!open) return;
    setCustomerId(customer ?? '');
    setRows([]);
    setTrialDays(null);
    setAnchorDay(null);
    setCollection('charge_automatically');
    action.clear();
  }, [open, customer]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Only what a subscription can actually carry, in the currency it bills in. */
  const sellable = useMemo(
    () => prices.filter((p) => p.type === 'recurring' && p.currencies.includes(currency)),
    [prices, currency],
  );
  const priceById = useMemo(() => new Map(sellable.map((p) => [p.id, p])), [sellable]);

  useEffect(() => {
    if (open && rows.length === 0 && sellable.length) {
      setRows([{ key: 'row-0', price: sellable[0].id, quantity: 1, custom: presetFor(sellable[0], currency) }]);
    }
  }, [open, sellable, rows.length]);

  // Every option priced at one unit, in this account's currency, in one call.
  // A negotiated price has no list amount to quote — asking for one refuses the
  // whole basket — so it is left out here and priced on its own row instead.
  const listed = useMemo(() => sellable.filter((p) => p.model !== 'custom'), [sellable]);
  const catalogue = usePricedPreview<CatalogEstimate>(
    '/v1/catalog/estimate',
    useMemo(() => ({ currency, lines: listed.map((p) => ({ price: p.id, quantity: 1 })) }), [currency, listed]),
    open && listed.length > 0,
  );
  const unitPrice = useMemo(() => {
    const map = new Map<string, EstimateLine>();
    for (const line of catalogue.data?.lines ?? []) map.set(line.price, line);
    return map;
  }, [catalogue.data]);

  const priceOptions = useMemo(() => sellable.map((price) => {
    const line = unitPrice.get(price.id);
    const metered = price.recurring?.usage_type === 'metered';
    const name = `${price.product_name}${price.nickname ? ` — ${price.nickname}` : ''}`;
    if (price.model === 'custom') {
      const bounds = boundsFor(price, currency);
      return {
        value: price.id,
        label: bounds?.minimum
          ? `${name} · negotiated, from ${f.money(bounds.minimum, { currency })}${cadenceSuffix(price.recurring ? { unit: price.recurring.interval, count: price.recurring.interval_count } : null)}`
          : `${name} · negotiated`,
        group: 'Negotiated — name the amount',
      };
    }
    if (!line) return { value: price.id, label: name, group: metered ? 'Metered — billed on usage' : 'Recurring' };
    // The unit label belongs to the *product*, and a flat platform fee sells
    // one of itself however many seats the product is counted in — labelling it
    // "£1,520.00 per seat" is the same lie as pricing it that way.
    const perUnit = price.model !== 'flat' && price.model !== 'custom';
    const unit = perUnit ? line.product?.unit_label : null;
    const money = f.money(line.amount, { currency: line.currency });
    const priced = metered
      ? `metered${cadenceSuffix(line.interval)} — billed on recorded usage`
      : unit
        ? `${money} per ${unit}${cadenceSuffix(line.interval)}`
        : `${money}${cadenceSuffix(line.interval)}`;
    return {
      value: price.id,
      label: `${name} · ${priced}`,
      group: metered ? 'Metered — billed on usage' : 'Recurring',
    };
  }), [sellable, unitPrice, currency, f]);

  /* ------------------------------ the basket ----------------------------- */

  const basket = useMemo(() => rows
    .filter((row) => {
      const price = priceById.get(row.price);
      // A negotiated line cannot be priced — or created — until it carries one.
      return !!price && (price.model !== 'custom' || (row.custom ?? 0) > 0);
    })
    .map((row) => ({
      price: row.price,
      quantity: priceById.get(row.price)?.recurring?.usage_type === 'metered' ? 1 : Math.max(1, row.quantity),
      ...(priceById.get(row.price)?.model === 'custom' ? { custom_unit_amount: row.custom as number } : {}),
    })), [rows, priceById]);
  const estimate = usePricedPreview<CatalogEstimate>(
    '/v1/catalog/estimate',
    useMemo(() => ({ currency, lines: basket }), [currency, basket]),
    open && basket.length > 0 && !!customerId,
  );

  /* --------- the three refusals the server would raise, raised here ------- */

  const duplicate = useMemo(() => {
    const seen = new Set<string>();
    for (const row of basket) {
      if (seen.has(row.price)) return priceById.get(row.price) ?? null;
      seen.add(row.price);
    }
    return null;
  }, [basket, priceById]);

  const cadences = useMemo(() => {
    const set = new Set<string>();
    for (const row of basket) {
      const r = priceById.get(row.price)?.recurring;
      if (r) set.add(cadencePhrase(r.interval_count, r.interval));
    }
    return [...set];
  }, [basket, priceById]);

  const refusal = duplicate
    ? `${duplicate.product_name}${duplicate.nickname ? ` — ${duplicate.nickname}` : ''} is on this subscription twice. Change the quantity on one line instead of adding a second.`
    : cadences.length > 1
      ? `Every price on a subscription has to share one billing interval, and these bill every ${f.list(cadences)}. "The current period" has no single meaning otherwise.`
      : null;

  // Every row has to be in the basket: a negotiated line without an amount is
  // dropped from the pricing call, and creating it would be refused too.
  const priced = basket.length === rows.filter((row) => priceById.has(row.price)).length;
  const ready = !!customerId && basket.length > 0 && priced && !refusal && !!estimate.data && !estimate.loading;
  const recurring = estimate.data?.recurring;
  const perPeriod = recurring
    ? recurring.month + recurring.year + recurring.week + recurring.day
    : 0;
  const cadenceWord = cadences[0] ?? '';

  const submit = async () => {
    const created = await action.run(
      api.post<Subscription>('/v1/subscriptions', {
        customer: customerId,
        items: basket,
        collection_method: collection,
        ...(trialDays ? { trial_period_days: trialDays } : {}),
        ...(anchorDay ? { billing_cycle_anchor_day: anchorDay } : {}),
      }, { idempotencyKey: idem() }),
      {
        success: 'Subscription created',
        description: trialDays
          ? `The trial runs ${f.plural(trialDays, 'day')}; nothing has been billed yet.`
          : `The first period is open and billed. ${f.money(recurring?.monthly_equivalent ?? 0, { currency })} a month of recurring revenue.`,
        failure: 'The subscription was refused',
      },
      ['/v1/subscriptions', '/v1/customers', '/v1/invoices', '/v1/revenue'],
    );
    if (created) { onClose(); navigate(subscriptionHref(created.id)); }
  };

  const form = useDialogForm(open, ready && !action.busy, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="New subscription"
      description="Every figure below is priced by the same function that will raise the invoice, in the currency this account bills in."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {/* The label carries a price, so it must never carry a stale one:
              while the basket is being re-priced it says so instead of quoting
              the figure the last quantity produced. */}
          <Button variant="primary" loading={action.busy} disabled={!ready} onClick={() => { void submit(); }}>
            {estimate.loading && basket.length > 0
              ? 'Pricing…'
              : ready && recurring
                ? `Create · ${f.money(perPeriod, { currency })}${cadenceWord ? ` per ${cadenceWord}` : ''}`
                : 'Create subscription'}
          </Button>
        </>
      }
    >
      <DialogFields form={form}>
      <Stack gap={6}>
        <Field
          label="Customer"
          required
          error={action.errorFor('customer')}
          hint={account.data ? `Bills in ${account.data.currency.toUpperCase()}, so this agreement does too.` : undefined}
        >
          {/* A locked customer field used to print `cus_sJNIPKFMu62BgiXH` — the
              one field that decides whose money this binds. It shows the name. */}
          {customer
            ? (
              <div className="bl-lockedfield">
                <span className="bl-lockedfield__name">{account.data?.name ?? 'Reading the account…'}</span>
                <span className="bl-lockedfield__id u-mono">{customerId}</span>
              </div>
            )
            : <CustomerPicker value={customerId} onChange={setCustomerId} invalid={!!action.errorFor('customer')} />}
        </Field>

        <Section title="Items" description="What this subscription bills for, every period.">
          <Field label="Priced items" required error={action.errorFor('items')}>
            <div className="bl-items">
              {rows.map((row, index) => {
                const price = priceById.get(row.price);
                const metered = price?.recurring?.usage_type === 'metered';
                return (
                  <div key={row.key} className="bl-item">
                    <Select
                      aria-label={`Price ${index + 1}`}
                      value={row.price}
                      options={priceOptions.length ? priceOptions : [{ value: row.price, label: pricesLoading ? 'Reading the catalogue…' : row.price }]}
                      onChange={(next) => setRows((all) => all.map((r) => (r.key === row.key
                        ? { ...r, price: next, quantity: 1, custom: presetFor(priceById.get(next), currency) }
                        : r)))}
                    />
                    {metered || flatPrice(price)
                      ? (
                        <FixedQuantity
                          label={`Quantity ${index + 1}`}
                          why={metered
                            ? 'Counted from recorded usage when the period closes.'
                            : 'A flat fee sells one of itself, whatever the plan is counted in.'}
                        />
                      )
                      : (
                        <QuantityField
                          label={`Quantity ${index + 1}`}
                          value={row.quantity}
                          min={1}
                          onChange={(quantity) => setRows((all) => all.map((r) => (r.key === row.key ? { ...r, quantity } : r)))}
                        />
                      )}
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove item ${index + 1}`}
                      disabled={rows.length === 1}
                      iconLeft={<Icons.trash size={14} />}
                      onClick={() => setRows((all) => all.filter((r) => r.key !== row.key))}
                    />
                    {metered && (
                      <div className="bl-item__meta">Metered — the quantity comes from recorded usage when the period closes, so it is always 1 here.</div>
                    )}
                    {/* A negotiated price has no list amount. Without one it can
                        neither be priced nor created, so the field is here on
                        the row rather than in a refusal after the fact. */}
                    {price?.model === 'custom' && (
                      <div className="bl-item__custom">
                        <Field
                          label={`Negotiated amount for ${price.product_name}`}
                          required
                          hint={(() => {
                            const bounds = boundsFor(price, currency);
                            if (!bounds) return 'The amount agreed with this account, per period.';
                            const low = bounds.minimum !== null ? f.money(bounds.minimum, { currency }) : null;
                            const high = bounds.maximum !== null ? f.money(bounds.maximum, { currency }) : null;
                            return low && high
                              ? `Agreed with this account, per period. This price sells between ${low} and ${high}.`
                              : 'The amount agreed with this account, per period.';
                          })()}
                        >
                          <MoneyField
                            value={row.custom}
                            onChange={(next) => setRows((all) => all.map((r) => (r.key === row.key ? { ...r, custom: next } : r)))}
                            currency={currency}
                            min={boundsFor(price, currency)?.minimum ?? 1}
                            max={boundsFor(price, currency)?.maximum ?? undefined}
                            label={`Negotiated amount for ${price.product_name}`}
                          />
                        </Field>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Field>
          <Button
            size="sm"
            variant="secondary"
            style={{ marginTop: 'var(--space-4)' }}
            iconLeft={<Icons.plus size={14} />}
            disabled={!sellable.length}
            onClick={() => setRows((all) => [...all, {
              key: `row-${all.length}-${Date.now()}`,
              price: sellable[0]?.id ?? '',
              quantity: 1,
              custom: sellable[0] ? presetFor(sellable[0], currency) : null,
            }])}
          >
            Add an item
          </Button>
        </Section>

        <Grid columns={3} gap={5}>
          <GridItem>
            <Field label="Trial days" optional hint="Empty bills immediately." error={action.errorFor('trial_period_days')}>
              <NumberInput value={trialDays} onChange={setTrialDays} min={0} max={730} aria-label="Trial days" />
            </Field>
          </GridItem>
          <GridItem>
            <Field label="Billing day" optional hint="1–31 — a 31st survives February.">
              <NumberInput value={anchorDay} onChange={setAnchorDay} min={1} max={31} aria-label="Billing day" />
            </Field>
          </GridItem>
          <GridItem>
            <Field label="Collection" hint="How each bill is settled.">
              <Select
                value={collection}
                onChange={(value) => setCollection(value as typeof collection)}
                options={[
                  { value: 'charge_automatically', label: 'Charge automatically' },
                  { value: 'send_invoice', label: 'Send an invoice' },
                ]}
              />
            </Field>
          </GridItem>
        </Grid>

        <Divider />

        {refusal && (
          <Banner tone="danger" compact title="This will not be accepted">{refusal}</Banner>
        )}
        {!customerId && (
          <EmptyState
            size="sm"
            inline
            illustration={null}
            title="Pick an account first"
            body="Every price below is quoted in the currency that account bills in, so the numbers wait for it."
          />
        )}
        {customerId && !refusal && estimate.error && (
          <PreviewFailure
            error={estimate.error}
            path="POST /v1/catalog/estimate"
            onRetry={estimate.refetch}
            refusalTitle="These items will not price"
          />
        )}
        {customerId && !refusal && !estimate.error && (estimate.loading || !estimate.data) && basket.length > 0 && (
          <Loading label="Pricing this subscription…" />
        )}
        {customerId && !refusal && estimate.data && (
          <NewSubscriptionPrice
            estimate={estimate.data}
            pending={estimate.loading}
            currency={currency}
            cadence={cadenceWord}
            trialDays={trialDays}
            anchorDay={anchorDay}
            account={account.data?.name ?? 'this account'}
          />
        )}
      </Stack>
      </DialogFields>
    </Modal>
  );
}

/**
 * What the operator is about to sell: every line at its real price, what the
 * period costs, what recurring revenue it adds, and — the question the old
 * dialog could not answer — what gets invoiced the moment Create is pressed.
 */
function NewSubscriptionPrice({ estimate, pending, currency, cadence, trialDays, anchorDay, account }: {
  estimate: CatalogEstimate;
  /** A newer basket is being priced; what is on screen is the previous answer. */
  pending: boolean;
  currency: string;
  cadence: string;
  trialDays: number | null;
  anchorDay: number | null;
  account: string;
}) {
  const f = useBillingFormat();
  const fixed = estimate.lines.filter((line) => !!line.interval);
  const perPeriod = estimate.recurring.month + estimate.recurring.year + estimate.recurring.week + estimate.recurring.day;

  return (
    <div className={pending ? 'bl-preview is-pending' : 'bl-preview'} aria-busy={pending}>
      {pending && <div className="bl-preview__pending" role="status">Re-pricing this basket…</div>}
      {estimate.warnings.map((warning) => (
        <Banner key={warning.price} tone="warning" compact>{warning.message}</Banner>
      ))}

      <div className="bl-tablewrap">
        <table className="bl-lines">
          <thead>
            <tr><th>Line</th><th className="bl-num">Qty</th><th className="bl-num">Per period</th></tr>
          </thead>
          <tbody>
            {fixed.map((line) => (
              <tr key={line.price}>
                <td>
                  <div>{line.product?.name ?? line.price}{line.nickname ? ` — ${line.nickname}` : ''}</div>
                  {/* A flat price's only breakdown row is its own nickname, and
                      printing that under the line makes the panel stutter. */}
                  {(() => {
                    const title = `${line.product?.name ?? line.price}${line.nickname ? ` — ${line.nickname}` : ''}`;
                    const why = line.breakdown.map((row) => breakdownLabel(row.label, line.currency, f.locale)).join(' · ');
                    if (!why || title.includes(why)) return null;
                    return <div className="bl-lines__why">{why}</div>;
                  })()}
                </td>
                <td className="bl-num">{f.number(line.quantity)}</td>
                <td className="bl-num">
                  {line.amount === 0 && line.breakdown.some((row) => row.kind === 'included')
                    ? <span className="bl-muted">included</span>
                    : line.amount_display}
                </td>
              </tr>
            ))}
            {estimate.lines.filter((line) => !line.interval).map((line) => (
              <tr key={line.price}>
                <td>{line.product?.name ?? line.price}</td>
                <td className="bl-num">{f.number(line.quantity)}</td>
                <td className="bl-num">{line.amount_display}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bl-totals">
        <div className="bl-total">
          <span className="bl-total__label">{cadence ? `Recurring fee, every ${cadence}` : 'Recurring fee'}</span>
          <span className="bl-total__value">{f.money(perPeriod, { currency })}</span>
        </div>
        <div className="bl-total bl-total--grand">
          <span className="bl-total__label">Monthly recurring revenue</span>
          <span className="bl-total__value">{estimate.recurring.monthly_equivalent_display}</span>
        </div>
      </div>

      <div className="bl-duenow">
        <span className="bl-duenow__label">
          {trialDays
            ? 'Invoiced today — nothing, this is a trial'
            : anchorDay
              ? 'Invoiced today — a part period'
              : 'Invoiced today'}
        </span>
        <span className="bl-duenow__value">
          {trialDays ? f.money(0, { currency }) : anchorDay ? `up to ${f.money(perPeriod, { currency })}` : f.money(perPeriod, { currency })}
        </span>
      </div>

      <div className="bl-sub">
        {trialDays
          ? `The trial runs ${f.plural(trialDays, 'day')} from today. Nothing is charged until it ends, and the first bill covers the ${cadence || 'period'} that starts then.`
          : anchorDay
            ? `The first period runs from today to the ${f.number(anchorDay)}${anchorDay === 1 ? 'st' : anchorDay === 2 ? 'nd' : anchorDay === 3 ? 'rd' : 'th'} and is billed for exactly the days it covers, so the first invoice is a fraction of the ${f.money(perPeriod, { currency })} above. Every period after it is the full fee.`
            : `The first period opens the moment this is created and ${account} is invoiced for it immediately.`}
        {' Tax and anything on the account balance are applied when the bill is raised, so the invoice total can differ from this subtotal.'}
        {estimate.lines.some((line) => !line.interval || line.breakdown.some((row) => row.kind === 'included'))
          ? ' Metered items are billed in arrears on recorded usage and add nothing to this figure.'
          : ''}
      </div>
    </div>
  );
}

/* ================================== list ================================== */

const STATUS_FILTERS = [
  { value: 'active_like', label: 'Everything live' },
  { value: 'all', label: 'All statuses' },
  { value: 'trialing', label: 'Trialing' },
  { value: 'active', label: 'Active' },
  { value: 'past_due', label: 'Past due' },
  { value: 'paused', label: 'Paused' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'canceled', label: 'Canceled' },
];

const currencyOfRow = (row: { currency: string }): string => row.currency;

export function SubscriptionsPage() {
  const f = useBillingFormat();
  const navigate = useNavigate();
  const toast = useToast();
  const action = useAction();
  const [status, setStatus] = useSearchParam('status', 'active_like');
  const [collection, setCollection] = useSearchParam('collection', '');
  const [view, setView] = useTableView({ columnId: 'mrr', direction: 'desc' });
  const [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  useOpenOnQuery('new', useCallback(() => setCreating(true), []));

  const [rangeParam, setRangeParam] = useSearchParam('amount', '');
  const search = useDebounced(view.query.trim(), 250);
  const book = useBookList<Subscription>('/v1/subscriptions', useMemo(() => ({
    status,
    expand: 'customer',
    ...(search ? { query: search } : {}),
    ...(collection ? { collection_method: collection } : {}),
  }), [status, search, collection]));
  const { currencies, preferred } = useCurrencyChoices(book.rows, currencyOfRow, f.currency);
  const range = useMemo(() => decodeRange(rangeParam, preferred), [rangeParam, preferred]);

  const columns: DataTableColumn<Subscription>[] = useMemo(() => [
    {
      id: 'customer',
      header: 'Account',
      pinned: true,
      width: 260,
      accessor: (row) => row.customer_detail?.name ?? row.customer,
      cell: (row) => (
        <div className="bl-cellstack">
          <RecordLink to={subscriptionHref(row.id)}>{row.customer_detail?.name ?? row.customer}</RecordLink>
          <span className="bl-cellstack__sub">
            {`${row.items.length} ${row.items.length === 1 ? 'item' : 'items'} · every ${cadencePhrase(row.interval_count, row.interval)}`}
          </span>
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      width: 130,
      filter: 'set',
      accessor: (row) => row.status,
      filterOptionLabel: statusLabel,
      cell: (row) => <StatusPill status={row.status} title={row.status_detail} />,
    },
    {
      id: 'plan',
      header: 'Plan',
      accessor: (row) => row.items.map((i) => i.description).join(', '),
      cell: (row) => (
        <div className="bl-cellstack">
          <span className="bl-cellstack__top">{row.items[0]?.description ?? '—'}</span>
          {row.items.length > 1 && <span className="bl-cellstack__sub">{`+ ${row.items.length - 1} more`}</span>}
        </div>
      ),
    },
    {
      // Visible, not hidden: the MRR beside it is ranked inside this value, and
      // a grouped order that does not show what it is grouped by reads as noise.
      id: 'currency',
      header: 'Currency',
      width: 100,
      filter: 'set',
      accessor: (row) => row.currency.toUpperCase(),
    },
    {
      id: 'mrr',
      header: 'MRR',
      align: 'right',
      width: 120,
      sortable: true,
      // Ranked inside the currency it bills in. Comparing minor units across
      // three books converts at 1:1 and calls the result an order: GBP 2,285 is
      // roughly $2,900 and used to sit below $2,356 in this very column.
      headerTitle: 'MRR',
      accessor: (row) => moneyRank(row.mrr, row.currency),
      cell: (row) => <Amount value={row.mrr} display={f.money(row.mrr, { currency: row.currency })} tone="plain" />,
      total: (rows) => <MoneyTotals totals={totalsByCurrency(rows, (r) => r.mrr, (r) => r.currency)} />,
    },
    {
      id: 'period',
      header: 'Current period',
      width: 200,
      accessor: (row) => row.current_period_end,
      cell: (row) => (
        <div className="bl-cellstack">
          <span className="bl-cellstack__top">{f.dayRange(row.current_period_start, row.current_period_end)}</span>
          <span className="bl-cellstack__sub">{row.interval_display}</span>
        </div>
      ),
    },
    {
      id: 'next_invoice',
      header: 'Next invoice',
      width: 150,
      sortable: true,
      filter: 'date',
      accessor: (row) => row.current_period_end,
      cell: (row) => (
        row.cancel_at_period_end
          ? <Badge tone="warning">Ends {f.day(row.current_period_end)}</Badge>
          : <span className="bl-nowrap">{f.day(row.current_period_end)}</span>
      ),
    },
    {
      id: 'collection_method',
      header: 'Collection',
      width: 150,
      filter: 'set',
      defaultHidden: true,
      accessor: (row) => row.collection_method,
      cell: (row) => humanize(row.collection_method),
    },
    {
      id: 'created',
      header: 'Started',
      width: 130,
      sortable: true,
      defaultHidden: true,
      accessor: (row) => row.start_date,
      cell: (row) => f.day(row.start_date),
    },
  ], [f]);

  const rows = useMemo(() => (rangeActive(range)
    ? book.rows.filter((row) => matchesRange(row.mrr, row.currency, range))
    : book.rows), [book.rows, range]);
  // The unnarrowed book. The default view is already narrowed — "Everything
  // live" is `status=active_like` — so measuring against `book.total` had the
  // list calling 36 of 41 subscriptions "the whole book" before anyone touched
  // a filter.
  const whole = useBookTotal('/v1/subscriptions', { status: 'all' });
  const visible = useMemo(() => visibleRows(rows, columns, view), [rows, columns, view]);
  const shown = visible.length;

  const bulk = async (label: string, path: (id: string) => string, body: unknown) => {
    const ids = [...selected];
    let ok = 0;
    for (const id of ids) {
      try { await api.post(path(id), body); ok++; } catch { /* counted below */ }
    }
    book.retry();
    setSelected([]);
    if (ok === ids.length) toast.success(`${label} ${ok} ${ok === 1 ? 'subscription' : 'subscriptions'}`);
    else toast.warning(`${label} ${ok} of ${ids.length}`, 'The rest were refused — open them to see why.', { duration: 0 });
  };

  return (
    <Page
      title="Subscriptions"
      eyebrow="Revenue"
      subtitle="Every recurring agreement in the workspace, what it is worth and when it bills next."
      actions={
        <Inline gap={3}>
          <Button variant="secondary" iconLeft={<Icons.wallet size={15} />} onClick={() => navigate('/billing/customers')}>
            Customers
          </Button>
          <Button variant="primary" iconLeft={<Icons.plus size={15} />} onClick={() => setCreating(true)}>
            New subscription
          </Button>
        </Inline>
      }
    >
      {book.error && <ListFailure error={book.error} path="GET /v1/subscriptions" onRetry={book.retry} />}
      <div className={book.loading ? 'bl-grid is-loading' : 'bl-grid'}>
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        caption="Subscriptions"
        loading={book.loading}
        error={null}
        onRetry={book.retry}
        value={view}
        onChange={setView}
        initialSort={{ columnId: 'mrr', direction: 'desc' }}
        searchable={false}
        selectable
        selected={selected}
        onSelectionChange={setSelected}
        onRowClick={(row) => navigate(subscriptionHref(row.id))}
        rowActions={(row) => rowMenu(row, navigate, action)}
        maxHeight={640}
        stickyFooter
        toolbar={
          <Inline gap={3}>
            <TableSearch view={view} onChange={setView} label="Search account, plan or id" />
            <Select
              size="sm"
              aria-label="Status"
              value={status}
              onChange={(value) => { setStatus(value || undefined); setSelected([]); }}
              options={STATUS_FILTERS}
              icon={<Icons.filter size={14} />}
            />
            <Select
              size="sm"
              aria-label="Collection method"
              value={collection}
              onChange={(value) => setCollection(value || undefined)}
              options={[
                { value: '', label: 'Any collection' },
                { value: 'charge_automatically', label: 'Charged automatically' },
                { value: 'send_invoice', label: 'Invoiced' },
              ]}
            />
            <MoneyRangeFilter
              value={range}
              onChange={(next) => { setRangeParam(encodeRange(next) || undefined); setSelected([]); }}
              fields={[{ value: 'mrr', label: 'MRR' }]}
              currencies={currencies}
              defaultCurrency={preferred}
            />
            <ExportCsvButton
              rows={visible}
              columns={SUBSCRIPTION_CSV}
              name="subscriptions"
              noun="subscriptions"
              disabled={!book.complete}
              reason={book.complete ? undefined : 'Still reading the book — the file would hold fewer rows than the screen.'}
            />
          </Inline>
        }
        bulkActions={(ids) => (
          <Inline gap={3}>
            <Button size="sm" variant="secondary" onClick={() => { void bulk('Paused', (id) => `/v1/subscriptions/${id}/pause`, { behavior: 'keep_as_draft' }); }}>
              Pause {ids.length}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => { void bulk('Resumed', (id) => `/v1/subscriptions/${id}/resume`, { billing_cycle_anchor: 'unchanged' }); }}>
              Resume
            </Button>
            <Button size="sm" variant="danger-ghost" onClick={() => { void bulk('Scheduled cancellation on', (id) => `/v1/subscriptions/${id}/cancel`, { at_period_end: true, cancellation_reason: 'cancellation_requested' }); }}>
              Cancel at period end
            </Button>
          </Inline>
        )}
        empty={book.error
          ? <LoadFailedEmpty noun="subscriptions" />
          : (
            <EmptyList
              title="No subscription matches this filter"
              body="Northwind bills its telemetry platform on recurring plans. Start one against an account and the first period opens immediately."
              action={<Button variant="primary" iconLeft={<Icons.plus size={15} />} onClick={() => setCreating(true)}>New subscription</Button>}
            />
          )}
        footer={<BookFooter book={book} noun="subscriptions" shown={shown} whole={whole} />}
      />
      </div>
      <p className="bl-gridnote">
        MRR is ranked and totalled inside each currency. There is no exchange-rate table in this platform, so
        nothing here is converted and no figure is added across two books.
      </p>
      <SubscriptionCreateDialog open={creating} onClose={() => setCreating(false)} />
    </Page>
  );
}

function rowMenu(row: Subscription, navigate: (to: string) => void, action: ReturnType<typeof useAction>): MenuSection[] {
  return [{
    id: 'sub',
    items: [
      { id: 'open', label: 'Open', icon: <ArrowUpRightIcon size={14} />, onSelect: () => navigate(subscriptionHref(row.id)) },
      { id: 'customer', label: 'Open the account', icon: <Icons.wallet size={14} />, onSelect: () => navigate(customerHref(row.customer)) },
      {
        id: 'pause',
        label: row.status === 'paused' ? 'Resume collection' : 'Pause collection',
        icon: row.status === 'paused' ? <Icons.play size={14} /> : <Icons.pause size={14} />,
        disabled: row.status === 'canceled',
        onSelect: () => {
          void action.run(
            api.post(`/v1/subscriptions/${row.id}/${row.status === 'paused' ? 'resume' : 'pause'}`,
              row.status === 'paused' ? { billing_cycle_anchor: 'unchanged' } : { behavior: 'keep_as_draft' }),
            { success: row.status === 'paused' ? 'Resumed' : 'Paused', failure: 'That was refused' },
            ['/v1/subscriptions'],
          );
        },
      },
      {
        id: 'cancel',
        label: 'Cancel at period end',
        icon: <XCircleIcon size={14} />,
        danger: true,
        disabled: row.status === 'canceled' || row.cancel_at_period_end,
        onSelect: () => {
          void action.run(
            api.post(`/v1/subscriptions/${row.id}/cancel`, { at_period_end: true, cancellation_reason: 'cancellation_requested' }),
            { success: 'Set to cancel at the period end', failure: 'The cancellation was refused' },
            ['/v1/subscriptions', '/v1/revenue'],
          );
        },
      },
    ],
  }];
}

/* ================================= detail ================================= */

const SUBSCRIPTION_TABS = ['overview', 'upcoming', 'periods', 'schedule'] as const;

export function SubscriptionDetailPage() {
  const { id } = useParams();
  const f = useBillingFormat();
  const navigate = useNavigate();
  const action = useAction();
  const [rawTab, setTab] = useRecordTab(SUBSCRIPTION_TABS, 'overview');
  const [dialog, setDialog] = useState<null | 'change' | 'cancel' | 'pause' | 'resume' | 'credit' | 'schedule'>(null);

  const { data: sub, error, loading, refetch } = useRecord<Subscription>(`/v1/subscriptions/${id}`, { expand: 'customer' });

  if (loading) return <Page title="Subscription"><Loading label="Loading this subscription…" /></Page>;
  if (error || !sub) {
    return (
      <Page title="Subscription" eyebrow="Revenue">
        <Card>
          <RecordMissing
            error={error ?? ({ status: 404, body: { message: `No subscription with the id ${id}.` } } as ApiClientError)}
            path={`GET /v1/subscriptions/${id}`}
            onRetry={refetch}
            noun="subscription"
            backTo="/billing/subscriptions"
            backLabel="Back to subscriptions"
          />
        </Card>
      </Page>
    );
  }

  const customerName = sub.customer_detail?.name ?? sub.customer;
  /**
   * `description` is null on anything created through this UI, and falling back
   * to the object id names the record after its primary key. Seeded rows read
   * "{account} — {plan}"; so does everything else now.
   */
  const headline = sub.description
    ?? (sub.items[0] ? `${customerName} — ${sub.items[0].description}` : customerName);
  const money = (amount: number) => f.money(amount, { currency: sub.currency });
  const patch = (body: Record<string, unknown>) => action.run(
    api.patch<Subscription>(`/v1/subscriptions/${sub.id}`, body),
    { success: 'Saved', failure: 'That edit was refused' },
    ['/v1/subscriptions'],
  ).then((result) => { if (!result) throw new Error('refused'); return result; });
  // A link to ?tab=schedule on a subscription that never had one lands somewhere.
  const tab = rawTab === 'schedule' && !sub.schedule ? 'overview' : rawTab;

  const actions: MenuSection[] = [
    {
      id: 'lifecycle',
      label: 'Lifecycle',
      items: [
        { id: 'pause', label: 'Pause collection', icon: <Icons.pause size={14} />, disabled: sub.status === 'paused' || sub.status === 'canceled', onSelect: () => setDialog('pause') },
        { id: 'resume', label: 'Resume', icon: <Icons.play size={14} />, disabled: sub.status !== 'paused', onSelect: () => setDialog('resume') },
        { id: 'cancel', label: 'Cancel…', icon: <XCircleIcon size={14} />, danger: true, disabled: sub.status === 'canceled', onSelect: () => setDialog('cancel') },
      ],
    },
    {
      id: 'schedule',
      label: 'Agreement',
      items: sub.schedule
        ? [{
          id: 'schedule-open',
          label: 'Open the schedule',
          icon: <Icons.calendar size={14} />,
          onSelect: () => setTab('schedule'),
        }]
        : [{
          id: 'schedule-new',
          label: 'Schedule a change…',
          icon: <Icons.calendar size={14} />,
          disabled: sub.status === 'canceled',
          onSelect: () => setDialog('schedule'),
        }],
    },
    {
      id: 'money',
      label: 'Money',
      items: [
        { id: 'credit', label: 'Discount or credit the account…', icon: <Icons.percent size={14} />, onSelect: () => setDialog('credit') },
        {
          id: 'invoice',
          label: 'Bill what is owed now',
          icon: <Icons.invoice size={14} />,
          onSelect: () => {
            void action.run(
              api.post<Invoice>('/v1/invoices', { customer: sub.customer, subscription: sub.id }, { idempotencyKey: idem() }),
              { success: 'Invoice raised', description: 'Everything waiting was swept onto one bill.', failure: 'Nothing could be billed' },
              ['/v1/invoices', '/v1/customers', '/v1/subscriptions'],
            ).then((invoice) => { if (invoice) navigate(invoiceHref(invoice.id)); });
          },
        },
      ],
    },
  ];

  return (
    <Page
      title={customerName}
      eyebrow="Subscription"
      badge={<span style={{ marginLeft: 'var(--space-4)' }}><StatusPill status={sub.status} title={sub.status_detail} /></span>}
      subtitle={headline}
      breadcrumbs={
        <Inline gap={3}>
          <RecordLink to="/billing/subscriptions">Subscriptions</RecordLink>
          <span className="bl-muted">/</span>
          <RecordLink to={customerHref(sub.customer)}>{customerName}</RecordLink>
        </Inline>
      }
      actions={
        <Inline gap={3}>
          <Button variant="secondary" iconLeft={<Icons.wallet size={15} />} onClick={() => navigate(customerHref(sub.customer))}>
            Account
          </Button>
          <Button variant="primary" iconLeft={<Icons.edit size={15} />} onClick={() => setDialog('change')}>
            Change plan or quantity
          </Button>
          <ActionMenu sections={actions} />
        </Inline>
      }
      tabs={
        <Tabs
          aria-label="Subscription sections"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'upcoming', label: 'Upcoming invoice' },
            { id: 'periods', label: 'Period ledger' },
            ...(sub.schedule ? [{ id: 'schedule' as const, label: 'Schedule' }] : []),
          ]}
        />
      }
    >
      <Stack gap={6}>
        <Card>
          <div className="bl-headline">
            {/* MRR excludes a paused or cancelled agreement; the recurring fee
                is unchanged. Both are true, and a tile that prints $0.00 over
                $570.00 with no word between them reads as a contradiction —
                so when they disagree, the caption says why. */}
            <Headline
              label="MRR"
              value={money(sub.mrr)}
              caption={sub.mrr === 0 && sub.recurring_subtotal > 0
                ? `${sub.pause_collection ? 'Excluded while collection is paused' : 'Excluded — this agreement is no longer billing'} · the fee is still ${money(sub.recurring_subtotal)} per ${sub.interval_display}`
                : `${money(sub.recurring_subtotal)} per ${sub.interval_display}`}
            />
            <Headline
              label="Current period"
              value={f.dayRange(sub.current_period_start, sub.current_period_end)}
              caption={statusCaption(sub, f)}
            />
            <Headline
              label={sub.cancel_at_period_end ? 'Ends' : 'Next invoice'}
              value={f.day(sub.current_period_end)}
              caption={sub.cancel_at_period_end ? 'Set to cancel at the period end' : humanize(sub.collection_method)}
            />
            <Headline
              label="Trial"
              value={sub.trial_end ? f.day(sub.trial_end) : '—'}
              caption={sub.trial_end ? (sub.trial_end > f.now() ? 'Trial ends' : 'Trial ended') : 'No trial on this subscription'}
            />
          </div>
        </Card>

        {sub.cancel_at_period_end && (
          <Banner tone="warning" title="Scheduled to cancel">
            {`This subscription stops on ${f.day(sub.current_period_end)}. `}
            {sub.cancellation_comment ?? 'No note was recorded with the cancellation.'}
          </Banner>
        )}
        {sub.schedule && <ScheduleBanner sub={sub} onOpen={() => setTab('schedule')} />}

        {sub.pause_collection && (
          <Banner tone="warning" title="Collection is paused">
            {`Invoices raised while paused are ${PAUSE_BEHAVIOR_COPY[sub.pause_collection.behavior]}. `}
            {sub.pause_collection.resumes_at ? `It resumes on ${f.day(sub.pause_collection.resumes_at)}.` : 'It resumes when you say so.'}
            <Inline gap={3} style={{ marginTop: 'var(--space-4)' }}>
              <Button size="sm" variant="secondary" onClick={() => setDialog('resume')}>Resume now</Button>
            </Inline>
          </Banner>
        )}

        {tab === 'overview' && <OverviewTab sub={sub} onChange={() => setDialog('change')} onPatch={patch} />}
        {tab === 'upcoming' && <UpcomingTab sub={sub} />}
        {tab === 'periods' && <PeriodsTab sub={sub} />}
        {tab === 'schedule' && sub.schedule && <ScheduleTab scheduleId={sub.schedule} subscription={sub} />}
      </Stack>

      <ChangeDialog sub={sub} open={dialog === 'change'} onClose={() => setDialog(null)} />
      <ScheduleChangeDialog sub={sub} open={dialog === 'schedule'} onClose={() => setDialog(null)} />
      <CancelDialog sub={sub} open={dialog === 'cancel'} onClose={() => setDialog(null)} />
      <PauseDialog sub={sub} open={dialog === 'pause'} onClose={() => setDialog(null)} />
      <ResumeDialog sub={sub} open={dialog === 'resume'} onClose={() => setDialog(null)} />
      <CreditDialog
        customer={sub.customer}
        currency={sub.currency}
        subscription={sub.id}
        open={dialog === 'credit'}
        onClose={() => setDialog(null)}
      />
    </Page>
  );
}

export function Headline({ label, value, caption }: { label: string; value: ReactNode; caption?: ReactNode }) {
  return (
    <div className="bl-headline__item">
      <div className="bl-headline__label">{label}</div>
      <div className="bl-headline__value">{value}</div>
      {caption && <div className="bl-headline__caption">{caption}</div>}
    </div>
  );
}

export function ActionMenu({ sections, label = 'More actions' }: { sections: MenuSection[]; label?: string }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        ref={anchor}
        variant="secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        iconLeft={<Icons.more size={15} />}
        onClick={() => setOpen((v) => !v)}
      />
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} sections={sections} ariaLabel={label} placement="bottom-end" />
    </>
  );
}

/**
 * One naming scheme for a subscription's items.
 *
 * The server's `description` is written per line kind: a plan line reads
 * "Telemetry Cloud Growth" and a seat line reads "5 × Growth operator seat —
 * monthly", so the same table named one row after its product and the next
 * after its nickname, and repeated in prose the quantity the Qty column
 * already carries. The catalogue holds both halves, so both rows get the
 * product on the first line and the price's nickname on the second.
 */
/**
 * What a subscription's cycle is doing, in the same words as the tile beside
 * it. The server's `status_detail` describes the *status* — a subscription set
 * to cancel is still `active`, so it kept saying "Billing normally on its
 * cycle" underneath a tile reading "Set to cancel at the period end".
 */
function statusCaption(sub: Subscription, f: ReturnType<typeof useBillingFormat>): string {
  if (sub.cancel_at_period_end) return `The last period — it stops on ${f.day(sub.current_period_end)}.`;
  if (sub.pause_collection) return 'The cycle runs; collection on it is paused.';
  return sub.status_detail;
}

const stripQuantity = (description: string): string => description.replace(/^\s*[\d,.]+\s*[×x]\s*/u, '');

function itemNaming(item: SubscriptionItem, price: Price | undefined): { name: string; detail: string | null } {
  if (price) return { name: price.product_name, detail: price.nickname };
  return { name: stripQuantity(item.description), detail: null };
}

function OverviewTab({ sub, onChange, onPatch }: {
  sub: Subscription; onChange: () => void; onPatch: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const f = useBillingFormat();
  const { prices } = useActivePrices();
  const priceById = useMemo(() => new Map(prices.map((price) => [price.id, price])), [prices]);
  const money = (amount: number) => f.money(amount, { currency: sub.currency });
  return (
    <div className="bl-cols">
      <Stack gap={6}>
      <Card title="Items" description="What this subscription bills for, every period." actions={
        <Button size="sm" variant="secondary" iconLeft={<Icons.edit size={13} />} onClick={onChange}>Change</Button>
      }>
        <div className="bl-tablewrap">
          <table className="bl-lines">
            <thead>
              <tr><th>Item</th><th>Qty</th><th className="bl-num">Amount per period</th></tr>
            </thead>
            <tbody>
              {sub.items.map((item) => {
                const naming = itemNaming(item, priceById.get(item.price));
                return (
                <tr key={item.id}>
                  <td>
                    <div>{naming.name}</div>
                    {naming.detail && <div className="bl-lines__why">{naming.detail}</div>}
                    <div className="bl-lines__why u-mono">{item.price}</div>
                  </td>
                  <td>{item.metered ? <Badge tone="info">metered</Badge> : f.number(item.quantity)}</td>
                  <td className="bl-num">{item.amount === null ? <span className="bl-muted">from usage</span> : money(item.amount)}</td>
                </tr>
                );
              })}
              <tr>
                <td className="bl-strong">Recurring subtotal</td>
                <td />
                <td className="bl-num bl-strong">{money(sub.recurring_subtotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
      <SubscriptionInvoices sub={sub} />
      </Stack>

      <Stack gap={6}>
      <Card title="Terms" description="Collection, net terms and the note below are editable here; the items and the money are changed through the priced dialog.">
        <FieldRow label="Status">{statusCaption(sub, f)}</FieldRow>
        <FieldRow label="Cadence">{`Every ${cadencePhrase(sub.interval_count, sub.interval)}`}</FieldRow>
        <FieldRow label="Billing day" hint="The day of the month every future period lands on.">
          {sub.billing_cycle_anchor_day}
        </FieldRow>
        <FieldRow label="Collection">
          <InlineEdit
            label="Collection"
            value={sub.collection_method}
            options={[
              { value: 'charge_automatically', label: 'Charge automatically' },
              { value: 'send_invoice', label: 'Send an invoice' },
            ]}
            onSave={(value) => onPatch({ collection_method: value })}
          />
        </FieldRow>
        <FieldRow
          label="Net terms"
          hint={sub.collection_method === 'charge_automatically'
            ? 'Applies to invoices sent for payment. This subscription charges the card on file the moment a bill is raised, so nothing on it waits for a due date.'
            : 'Days until an invoice raised on this subscription is due. Empty follows the account.'}
        >
          <InlineEdit
            label="Net terms"
            value={String(sub.days_until_due ?? 0)}
            options={[
              { value: '0', label: 'Due on receipt' },
              { value: '14', label: 'Net 14' },
              { value: '30', label: 'Net 30' },
              { value: '45', label: 'Net 45' },
              { value: '60', label: 'Net 60' },
            ]}
            onSave={(value) => onPatch({ days_until_due: Number(value) })}
          />
        </FieldRow>
        <FieldRow label="Note" hint="What this agreement is, for whoever opens it next.">
          <InlineEdit
            label="Note"
            value={sub.description ?? ''}
            empty="No note on this subscription"
            onSave={(value) => onPatch({ description: value })}
          />
        </FieldRow>
        <FieldRow label="Default proration">{humanize(sub.proration_behavior)}</FieldRow>
        <FieldRow label="Started">{f.day(sub.start_date, { withYear: true })}</FieldRow>
        {sub.canceled_at && <FieldRow label="Canceled">{f.dateTime(sub.canceled_at)}</FieldRow>}
        <FieldRow label="Latest invoice">
          {sub.latest_invoice
            ? (
              <RecordLink to={invoiceHref(sub.latest_invoice.id)}>
                {`${sub.latest_invoice.number} · ${f.money(sub.latest_invoice.total, { currency: sub.latest_invoice.currency })}`}
              </RecordLink>
            )
            : <span className="bl-muted">Nothing billed yet</span>}
        </FieldRow>
        <FieldRow label="Id"><span className="u-mono bl-sub">{sub.id}</span></FieldRow>
      </Card>
      </Stack>
    </div>
  );
}

function SubscriptionInvoices({ sub }: { sub: Subscription }) {
  const f = useBillingFormat();
  const { data, loading, error, refetch } = useQuery<ListEnvelope<Invoice>>('/v1/invoices', {
    subscription: sub.id, status: 'all', limit: 8,
  });
  const rows = data?.data ?? [];
  return (
    <Card
      title="Invoices raised on this subscription"
      description={data ? `${f.number(data.total_count ?? rows.length)} in total, newest first` : undefined}
    >
      {error && <SectionError error={error} path="GET /v1/invoices" onRetry={refetch} />}
      {!error && loading && <Loading label="Reading invoices…" />}
      {!error && !loading && rows.length === 0 && (
        <EmptyState
          size="sm"
          inline
          illustration={null}
          title="Nothing has been billed yet"
          body="The first invoice is raised when this subscription opens a period it has to charge for."
        />
      )}
      {rows.map((invoice) => (
        <div key={invoice.id} className="bl-row">
          <div className="bl-row__main">
            <div className="bl-row__title"><RecordLink to={invoiceHref(invoice.id)}>{invoice.number}</RecordLink></div>
            <div className="bl-row__sub">{invoice.period_display}</div>
          </div>
          <div className="bl-row__aside">
            <div>{invoice.total_display}</div>
            <div className="bl-sub"><StatusPill status={invoice.status} /></div>
          </div>
        </div>
      ))}
    </Card>
  );
}

function UpcomingTab({ sub }: { sub: Subscription }) {
  const f = useBillingFormat();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    api.post<Invoice>('/v1/invoices/create_preview', { subscription: sub.id })
      .then((result) => { if (live) { setInvoice(result); setError(null); } })
      .catch((e: ApiClientError) => { if (live) { setError(e); setInvoice(null); } });
    return () => { live = false; };
  }, [sub.id, nonce]);

  if (error) {
    return <Card><SectionError error={error} path="POST /v1/invoices/create_preview" onRetry={() => setNonce((n) => n + 1)} /></Card>;
  }
  if (!invoice) return <Card><Loading label="Drawing the next invoice…" /></Card>;

  // `status_detail` on a preview always reads as a held draft — the preview
  // endpoint can only return one — and on an actively billing subscription that
  // sentence asserts a pause that is not there. The description is written from
  // the subscription in hand instead; the real pause has its own banner above.
  const account = sub.customer_detail?.name ?? 'this account';
  const description = sub.pause_collection
    ? `Collection is paused, so this bill is ${PAUSE_BEHAVIOR_COPY[sub.pause_collection.behavior]} when the period closes.`
    : sub.cancel_at_period_end
      ? `Nothing has been sent. This subscription ends on ${f.day(sub.current_period_end)}, so this is the last bill it would raise.`
      : `Nothing has been sent — this is what ${account} would be invoiced for the period beginning ${f.day(invoice.period.start)}.`;

  return (
    <Card
      title={`Upcoming invoice · ${f.day(invoice.period.start)}`}
      description={description}
    >
      <div className="bl-tablewrap">
        <table className="bl-lines">
          <thead>
            <tr><th>Line</th><th>Period</th><th>Qty</th><th className="bl-num">Amount</th></tr>
          </thead>
          <tbody>
            {invoice.lines.map((line) => (
              <UpcomingLineRow key={line.id} line={line} />
            ))}
          </tbody>
        </table>
      </div>
      <Divider style={{ margin: 'var(--space-5) 0' }} />
      <div className="bl-totals">
        <div className="bl-total"><span className="bl-total__label">Subtotal</span><span className="bl-total__value">{invoice.subtotal_display}</span></div>
        <div className="bl-total"><span className="bl-total__label">Tax</span><span className="bl-total__value">{invoice.tax_display}</span></div>
        {invoice.balance_applied !== 0 && (
          <div className="bl-total"><span className="bl-total__label">Account balance applied</span><span className="bl-total__value">{invoice.balance_applied_display}</span></div>
        )}
        <div className="bl-total bl-total--grand"><span className="bl-total__label">Estimated total</span><span className="bl-total__value">{invoice.total_display}</span></div>
      </div>
    </Card>
  );
}

function PeriodsTab({ sub }: { sub: Subscription }) {
  const f = useBillingFormat();
  const { data, loading, error, refetch } = useQuery<ListEnvelope<BilledPeriod>>(`/v1/subscriptions/${sub.id}/periods`);
  // The ledger carries invoice ids; every other screen in this module prints
  // numbers, so the numbers are read from the invoices this subscription raised
  // and the id is only the fallback for one that has been deleted.
  const invoices = useQuery<ListEnvelope<Invoice>>('/v1/invoices', { subscription: sub.id, status: 'all', limit: 200 });
  const numbers = useMemo(() => {
    const map = new Map<string, Invoice>();
    for (const invoice of invoices.data?.data ?? []) map.set(invoice.id, invoice);
    return map;
  }, [invoices.data]);
  if (error) return <Card><SectionError error={error} path={`GET /v1/subscriptions/${sub.id}/periods`} onRetry={refetch} /></Card>;
  const rows = data?.data ?? [];
  return (
    <Card title="Period ledger" description="Every period this subscription has entered, and what was recognised for it.">
      {loading && <Loading label="Reading the ledger…" />}
      {!loading && rows.length === 0 && (
        <EmptyState size="sm" inline illustration={null} title="No period has closed yet" body="The first row appears when this subscription enters its first billing period." />
      )}
      {!loading && rows.length > 0 && (
        <div className="bl-tablewrap">
          <table className="bl-lines">
            <thead>
              <tr><th>Period</th><th>Status</th><th>Invoice</th><th className="bl-num">Recognised</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="bl-nowrap">{f.dayRange(row.period_start, row.period_end)}</td>
                  <td><StatusPill status={row.status} /></td>
                  <td>
                    {row.invoice
                      ? (
                        <RecordLink to={invoiceHref(row.invoice)}>
                          {numbers.get(row.invoice)?.number ?? row.invoice}
                        </RecordLink>
                      )
                      : <span className="bl-muted">not billed</span>}
                  </td>
                  <td className="bl-num">{f.money(row.amount, { currency: row.currency })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

