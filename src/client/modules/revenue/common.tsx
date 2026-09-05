/**
 * Pieces every revenue surface shares.
 *
 * Two ideas run through this file. The first is that a figure on a revenue
 * screen is worthless unless the reader can see how it was computed, so every
 * block that renders one carries the API's own `basis` string beside it. The
 * second is that this workspace bills in more than one currency and there is no
 * exchange rate anywhere in the platform: a money scalar is therefore stated in
 * a currency or it is not stated at all, and the currency in scope is a control
 * on the page rather than an assumption inside it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, type ApiClientError, type ListEnvelope, type QueryResult } from '../../kernel/api';
import { useRouter, useSearchParam } from '../../kernel/router';
import { useSession } from '../../kernel/session';
import {
  Badge, Button, DateRangePicker, IconButton, Icons, Inline, Input, Popover,
  SegmentedControl, Select, Skeleton, Spinner, Stack, currencySymbol, decodeTableState,
  encodeTableState, filterRows, formatMoney, formatNumber, niceTicks, parseMoneyInput,
  pluralize, searchRows, sortRows, useFormat, useToast,
  AlertTriangleIcon, ChevronDownIcon, ChevronUpIcon,
  type CellValue, type DateRange, type Formatter, type InputProps, type SortState, type TableState,
} from '../../design';
import { exponentOf, type Currency } from '../../../shared/money';
import type { Basis, CurrencyScope, Rate, Ratio, CustomerLite } from './types';
import './revenue.css';

/* ------------------------------- formatting ------------------------------- */

export type { Formatter };

/** `formatMoney` bound to the workspace locale but to a row's own currency. */
export function moneyIn(f: Formatter, amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  return formatMoney(amount, { locale: f.locale, currency: (currency || f.currency).toLowerCase() });
}

export function compactMoneyIn(f: Formatter, amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  return formatMoney(amount, {
    locale: f.locale, currency: (currency || f.currency).toLowerCase(), compact: true, trimZeroFraction: true,
  });
}

/** A signed money figure, so a contraction never renders as if it were growth. */
export function signedMoneyIn(f: Formatter, amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  return formatMoney(amount, { locale: f.locale, currency: (currency || f.currency).toLowerCase(), signDisplay: 'exceptZero' });
}

/** A rate the server already divided. `n/a` when the denominator was zero. */
export const rateText = (rate: Rate | null | undefined): string =>
  (!rate || rate.undefined_rate ? '—' : rate.percent);

/** The fraction behind a rate, for a chart axis. Undefined rates plot as zero. */
export const rateFraction = (rate: Rate | null | undefined): number =>
  (!rate || rate.undefined_rate ? 0 : rate.bps / 10_000);

export const ratioText = (ratio: Ratio | null | undefined): string =>
  (!ratio || ratio.undefined_value ? '—' : ratio.display);

/**
 * A calendar boundary is not an instant.
 *
 * `2026-09`, a grant's `expires_at` and a settlement's `period_end` are all
 * midnight UTC by construction — the server built them from a calendar, not
 * from a clock reading. Rendering them in the workspace's own timezone shifts
 * every one of them back into the previous evening, which is how a September
 * movement comes out labelled August and an expiry on the 10th prints as the
 * 9th. So a boundary is formatted in UTC, exactly as `DatePicker` shows it,
 * and only genuine instants — the last event, the next retry, when a ledger
 * entry was written — get the workspace timezone.
 */
export const UTC_DATE = { timeZone: 'UTC' } as const;

/** A UTC calendar date: grant expiry, period edges, anything a DatePicker edits. */
export const boundaryDate = (f: Formatter, ts: number | null | undefined, withYear?: boolean): string =>
  f.date(ts, withYear === undefined ? UTC_DATE : { ...UTC_DATE, withYear });

export const boundaryRange = (f: Formatter, start: number, end: number): string =>
  f.dateRange(start, end, UTC_DATE);

/** "2026-09" as the workspace would write it. Months arrive as strings. */
export function monthLabel(month: string, f: Formatter, withYear = false): string {
  const [year, index] = month.split('-').map(Number);
  if (!year || !index) return month;
  return f.month(Date.UTC(year, index - 1, 1), { ...UTC_DATE, withYear });
}

/**
 * A quantity in a meter's own units. `unit_label` is documented as singular in
 * the meter form, so every call site that puts a number in front of it has to
 * pluralise — "4,200 event" is the tell that one did not.
 */
export const units = (f: Formatter, count: number, label: string | null | undefined): string =>
  `${f.number(count, { maxDecimals: 2 })} ${pluralize(label || 'unit', count)}`;

/** The unit noun alone, agreeing with a count rendered elsewhere. */
export const unitNoun = (count: number, label: string | null | undefined): string =>
  pluralize(label || 'unit', count);

/* --------------------------------- states --------------------------------- */

/**
 * The loading figure, the failed-read panel and the status pill are the
 * billing module's. This surface used to draw its own three — "This did not
 * load" beside billing's "That did not load", the request path in the sentence
 * rather than under it, a small square chip where every other revenue screen
 * shows a pill — and a person reading a grant on the customer page and again
 * on Credits met two products.
 */
export { Loading, SectionError, StatusPill as StatusChip } from '../billing/common';

export function ChartSkeleton({ height = 240 }: { height?: number }) {
  return (
    <div className="rv-chartskel">
      <Skeleton height={height} />
    </div>
  );
}

/* --------------------------- stale-while-revalidate ----------------------- */

export type Sticky<T> = QueryResult<T> & {
  /** True while a previous response is on screen and a newer one is in flight. */
  stale: boolean;
};

/**
 * Changing the range is the commonest thing anyone does on a reporting screen,
 * and `useQuery` caches by URL — so a new range is a new key with no data, and
 * every tile on the page would blank to a skeleton each time. Holding the last
 * answer and marking it stale keeps the numbers readable while the next set
 * arrives; skeletons are then only what a first load looks like.
 */
export function useSticky<T>(query: QueryResult<T>, book?: string): Sticky<T> {
  const last = useRef<{ book: string | undefined; data: T } | null>(null);
  if (query.data !== undefined) last.current = { book, data: query.data };
  // Holding the previous answer is only honest while the *unit* has not
  // changed. Switching from the USD book to the EUR one keeps the same tiles
  // on screen but re-symbolises every one of them, so a dollar figure is
  // rendered as euros for as long as the fetch takes. A held answer therefore
  // carries the book it was read for, and is dropped the moment that differs:
  // a currency switch skeletons, a range change does not.
  const held = last.current && last.current.book === book ? last.current.data : undefined;
  // A failure must show as a failure, never as the previous range's numbers
  // wearing this range's label.
  const data = query.data ?? (query.error ? undefined : held);
  return {
    ...query,
    data,
    loading: data === undefined && !query.error,
    stale: query.data === undefined && data !== undefined,
  };
}

/** Dims a block that is showing the previous answer, and says so out loud. */
export function Stale({ stale, children }: { stale: boolean; children: ReactNode }) {
  return (
    <div className={stale ? 'rv-stale' : undefined} aria-busy={stale || undefined}>
      {children}
    </div>
  );
}

export function RefreshingChip({ stale }: { stale: boolean }) {
  if (!stale) return null;
  return (
    <span className="rv-refreshing" role="status">
      <Spinner size={12} />
      Updating
    </span>
  );
}

/* ------------------------------- basis note ------------------------------- */

/**
 * The API's own prose, kept one click away rather than printed at a reader who
 * did not ask for it. Used for the multi-currency note, which is written for
 * someone holding a query string.
 */
export function NotePopover({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button ref={anchor} size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label}
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-start" title={title}>
        <p className="rv-basis__summary" style={{ maxWidth: 460, margin: 0 }}>{children}</p>
      </Popover>
    </>
  );
}


/**
 * The provenance of a figure, one click away from the figure itself.
 *
 * `basis.summary` says what was counted, `basis.rules` says what was excluded
 * and what is inferred, and `sources` names the row counts underneath. Together
 * they turn "MRR is $38,873.66" into a claim someone can check.
 */
export function BasisNote({
  basis, sources, label = 'How this was computed',
}: { basis: Basis | undefined; sources?: Record<string, number>; label?: string }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!basis) return null;
  return (
    <>
      <IconButton
        ref={anchor}
        size="sm"
        label={label}
        aria-expanded={open}
        icon={<Icons.info size={14} />}
        onClick={() => setOpen((v) => !v)}
      />
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-end" title={label}>
        <div className="rv-basis">
          <p className="rv-basis__summary">{basis.summary}</p>
          <ul className="rv-basis__list">
            {basis.rules.map((rule) => <li key={rule}>{rule}</li>)}
          </ul>
          {sources && Object.keys(sources).length > 0 && (
            <div className="rv-basis__sources">
              {Object.entries(sources).map(([key, value]) => (
                <span className="rv-basis__source" key={key}><b>{value}</b> {key.replace(/_/g, ' ')}</span>
              ))}
            </div>
          )}
        </div>
      </Popover>
    </>
  );
}

/* ------------------------------ reconciliation ---------------------------- */

/**
 * Reconciliation is the one thing on these screens that is allowed to refuse to
 * draw. When opening plus movements does not equal closing, the honest answer is
 * to name the months rather than paint a bar that is wrong by the difference.
 */
export function ReconciliationBadge({ balanced, label }: { balanced: boolean; label?: string }) {
  return balanced
    ? <Badge tone="success" dot size="sm">{label ?? 'Reconciled'}</Badge>
    : <Badge tone="danger" dot size="sm">{label ?? 'Does not reconcile'}</Badge>;
}

/* -------------------------------- the range ------------------------------- */

export interface RevenueRange {
  /** Query parameters every revenue endpoint takes. */
  query: { months?: number; from?: number; to?: number; currency?: string };
  months: number;
  from: number | null;
  to: number | null;
  currency: string;
  setMonths: (months: number) => void;
  setDates: (range: DateRange) => void;
  setCurrency: (currency: string) => void;
  /** True while the range is a named window rather than two chosen dates. */
  preset: boolean;
  label: string;
}

const MONTH_CHOICES = [3, 6, 12, 24] as const;

/**
 * The range and the currency, held in the URL so a finance lead can send
 * somebody the screen they are looking at rather than a description of it.
 */
export function useRevenueRange(defaultCurrency: string): RevenueRange {
  const f = useFormat();
  const [monthsParam, setMonthsParam] = useSearchParam('months', '12');
  const [fromParam, setFromParam] = useSearchParam('from');
  const [toParam, setToParam] = useSearchParam('to');
  const [currencyParam, setCurrencyParam] = useSearchParam('currency');

  const months = Number.isFinite(Number(monthsParam)) && Number(monthsParam) > 0 ? Number(monthsParam) : 12;
  const from = fromParam ? Number(fromParam) : null;
  const to = toParam ? Number(toParam) : null;
  const explicit = from !== null && to !== null && Number.isFinite(from) && Number.isFinite(to);
  const currency = currencyParam || defaultCurrency;

  const query = useMemo(
    () => (explicit
      ? { from: from as number, to: to as number, currency }
      : { months, currency }),
    [explicit, from, to, months, currency],
  );

  const setDates = useCallback((range: DateRange) => {
    if (range.start === null || range.end === null) { setFromParam(undefined); setToParam(undefined); return; }
    setFromParam(String(range.start));
    setToParam(String(range.end));
  }, [setFromParam, setToParam]);

  const setMonths = useCallback((next: number) => {
    setFromParam(undefined);
    setToParam(undefined);
    setMonthsParam(String(next));
  }, [setFromParam, setToParam, setMonthsParam]);

  return {
    query,
    months,
    from: explicit ? from : null,
    to: explicit ? to : null,
    currency,
    setMonths,
    setDates,
    setCurrency: (next) => setCurrencyParam(next),
    preset: !explicit,
    label: explicit ? f.dateRange(from as number, to as number) : `Last ${months} months`,
  };
}

export function RangeControl({ range }: { range: RevenueRange }) {
  const f = useFormat();
  return (
    <Inline gap={3} wrap>
      <SegmentedControl
        size="sm"
        aria-label="Reporting window"
        value={range.preset ? String(range.months) : 'custom'}
        onChange={(value) => { if (value !== 'custom') range.setMonths(Number(value)); }}
        options={[
          ...MONTH_CHOICES.map((n) => ({ value: String(n), label: `${n}m` })),
          { value: 'custom', label: 'Custom', disabled: range.preset, title: 'Pick two dates to the right' },
        ]}
      />
      <DateRangePicker
        aria-label="Reporting date range"
        value={{ start: range.from, end: range.to }}
        onChange={range.setDates}
        max={f.now()}
        placeholder="Pick two dates"
      />
    </Inline>
  );
}

/**
 * Which book is on screen. There is no exchange-rate table in this platform, so
 * this is not a display preference — it is the only way a money figure here
 * means anything at all.
 */
export function CurrencyControl({ range, scope }: { range: RevenueRange; scope: CurrencyScope | undefined }) {
  const currencies = scope?.currencies.length ? scope.currencies : [range.currency];
  const options = currencies.map((code) => ({ value: code, label: code.toUpperCase() }));
  if (options.length <= 1) {
    return <Badge tone="neutral" size="sm">{(options[0]?.value ?? range.currency).toUpperCase()}</Badge>;
  }
  return options.length <= 4
    ? (
      <SegmentedControl
        size="sm"
        aria-label="Currency in scope"
        value={range.currency}
        onChange={range.setCurrency}
        options={options}
      />
    )
    : (
      <Select
        size="sm"
        aria-label="Currency in scope"
        value={range.currency}
        onChange={range.setCurrency}
        options={options.map((o) => ({ value: o.value, label: o.label }))}
      />
    );
}

/* ------------------------------ customer names ---------------------------- */

/**
 * Ids are what the API returns and names are what a person recognises. One read
 * of the customer book covers every screen in this module.
 */
export interface CustomerIndex {
  name: (id: string | null | undefined) => string;
  /** False when the id names no account in the billing book. */
  known: (id: string | null | undefined) => boolean;
  loading: boolean;
  customers: CustomerLite[];
}

export function useCustomerNames(): CustomerIndex {
  const { data, loading } = useQuery<ListEnvelope<CustomerLite>>('/v1/customers', { limit: 200 });
  const customers = useMemo(() => data?.data ?? [], [data]);
  const index = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of customers) map.set(row.id, row.name);
    return map;
  }, [customers]);
  return {
    customers,
    loading,
    name: useCallback((id) => (id ? index.get(id) ?? id : '—'), [index]),
    known: useCallback((id) => (id ? index.has(id) : false), [index]),
  };
}

/**
 * An account by name — or, when the id names nothing in the billing book, a
 * row that says so.
 *
 * Printing a bare `cus_…` where every neighbouring row prints a company reads
 * as a name nobody bothered to look up. It is a data problem: the reference
 * outlived the account. Saying that, and keeping the id available for whoever
 * has to go and fix it, is the honest rendering.
 */
export function CustomerName({ id, names }: { id: string | null | undefined; names: CustomerIndex }) {
  if (!id) return <span className="rv-muted">—</span>;
  if (names.known(id)) return <>{names.name(id)}</>;
  // Until the customer book has loaded, every id looks unknown. Say nothing
  // rather than accuse a real account of not existing.
  if (names.loading) return <span className="rv-muted">…</span>;
  return (
    <span className="rv-unknown" title={`No account in the billing book carries the id ${id}. The reference has outlived the customer record.`}>
      <AlertTriangleIcon size={12} aria-hidden />
      <span>Unknown account</span>
      <code className="rv-mono">{id}</code>
    </span>
  );
}

/* --------------------------------- chrome --------------------------------- */

/** The workspace's own currency — the sane default for the currency control. */
export function useDefaultCurrency(): string {
  const { currency } = useSession();
  return currency;
}

/** A labelled figure with its own provenance button, used across the tiles. */
export function TileRow({ children }: { children: ReactNode }) {
  return <div className="rv-tiles">{children}</div>;
}

export function FieldRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="rv-fieldrow">
      <div className="rv-fieldrow__label">{label}</div>
      <div className="rv-fieldrow__value">{children}</div>
    </div>
  );
}

export function Facts({ children }: { children: ReactNode }) {
  return <Stack gap={0}>{children}</Stack>;
}

/** Body copy for an empty state, held to a reading measure inside a wide table. */
export function EmptyBody({ children }: { children: ReactNode }) {
  return <span className="rv-emptybody">{children}</span>;
}

/* ------------------------------- live fields ------------------------------ */

/**
 * A number field whose value is the value on screen.
 *
 * The design system's `NumberInput` commits on blur, which is right for a form
 * that is read when it is submitted and wrong for one that prices itself as
 * you type: the quote, the enablement of the button and the amount printed on
 * it all read state the field has not handed over yet. That gap is how a
 * control labelled "$500.00" charged $2,760.00 — the click landed before the
 * blur. These two inputs lift on every keystroke instead, so nothing on the
 * screen can be one edit behind the field it was computed from.
 *
 * Out-of-range text is clamped *and rewritten*, rather than silently clamped
 * behind a field still showing what was typed — the same rule, for the same
 * reason: what is displayed is what will be sent.
 */
export interface LiveNumberInputProps extends Omit<InputProps, 'value' | 'onChange' | 'type'> {
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  showSteppers?: boolean;
}

export function LiveNumberInput({
  value, onChange, min, max, step = 1, precision = 0, suffix, showSteppers = true, ...rest
}: LiveNumberInputProps) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const lifted = useRef(value);
  useEffect(() => {
    if (value !== lifted.current) { setText(value === null ? '' : String(value)); lifted.current = value; }
  }, [value]);

  const clamp = useCallback((n: number) => {
    let out = n;
    if (min !== undefined) out = Math.max(min, out);
    if (max !== undefined) out = Math.min(max, out);
    return Number(out.toFixed(precision));
  }, [min, max, precision]);

  const lift = (next: number | null) => { lifted.current = next; onChange(next); };

  const type = (raw: string) => {
    setText(raw);
    if (raw.trim() === '') { lift(null); return; }
    const parsed = Number(raw.replace(/[^0-9.\-]/g, ''));
    if (!Number.isFinite(parsed)) return;
    const clamped = clamp(parsed);
    // Only the out-of-range case rewrites what was typed; "6." and "06" are
    // left alone so a decimal or a leading zero can still be entered.
    if (clamped !== parsed) setText(String(clamped));
    lift(clamped);
  };

  const nudge = (delta: number) => {
    const next = clamp((value ?? min ?? 0) + delta * step);
    setText(String(next));
    lift(next);
  };

  return (
    <Input
      {...rest}
      type="text"
      inputMode="decimal"
      value={text}
      wrapperClassName="ain-input--number"
      onChange={(e) => type(e.target.value)}
      onBlur={(e) => {
        // Normalising is a courtesy, never the path from text to state.
        if (text.trim() !== '' && value !== null) setText(String(value));
        rest.onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') { e.preventDefault(); nudge(e.shiftKey ? 10 : 1); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(e.shiftKey ? -10 : -1); }
        rest.onKeyDown?.(e);
      }}
      aria-valuenow={value ?? undefined}
      aria-valuemin={min}
      aria-valuemax={max}
      suffix={(
        <>
          {suffix}
          {showSteppers && (
            <span className="ain-input__stepper">
              <button type="button" className="ain-input__step" tabIndex={-1} aria-label="Increase" onClick={() => nudge(1)}>
                <ChevronUpIcon size={11} />
              </button>
              <button type="button" className="ain-input__step" tabIndex={-1} aria-label="Decrease" onClick={() => nudge(-1)}>
                <ChevronDownIcon size={11} />
              </button>
            </span>
          )}
        </>
      )}
    />
  );
}

export interface LiveMoneyInputProps extends Omit<InputProps, 'value' | 'onChange' | 'type' | 'prefix'> {
  /** Integer minor units, exactly as the API stores it. */
  value: number | null;
  onChange: (minorUnits: number | null) => void;
  currency: string;
  locale?: string;
  min?: number;
  max?: number;
}

export function LiveMoneyInput({
  value, onChange, currency, locale, min, max, ...rest
}: LiveMoneyInputProps) {
  const code = (currency || 'usd').toLowerCase() as Currency;
  const exp = exponentOf(code);
  const toText = useCallback((minor: number | null) => (minor === null ? '' : (minor / 10 ** exp).toFixed(exp)), [exp]);
  const [text, setText] = useState(() => toText(value));
  const lifted = useRef(value);
  useEffect(() => {
    if (value !== lifted.current) { setText(toText(value)); lifted.current = value; }
  }, [value, toText]);

  const type = (raw: string) => {
    setText(raw);
    if (raw.trim() === '') { lifted.current = null; onChange(null); return; }
    const parsed = parseMoneyInput(raw, code);
    if (!parsed) return;
    let minor = parsed.amount;
    if (min !== undefined) minor = Math.max(min, minor);
    if (max !== undefined) minor = Math.min(max, minor);
    if (minor !== parsed.amount) setText(toText(minor));
    lifted.current = minor;
    onChange(minor);
  };

  return (
    <Input
      {...rest}
      type="text"
      inputMode="decimal"
      value={text}
      placeholder={rest.placeholder ?? (0).toFixed(exp)}
      wrapperClassName="ain-input--number"
      prefix={currencySymbol(code, locale)}
      suffix={<span style={{ textTransform: 'uppercase', fontSize: 'var(--text-xs)' }}>{code}</span>}
      onChange={(e) => type(e.target.value)}
      onBlur={(e) => { if (text.trim() !== '' && value !== null) setText(toText(value)); rest.onBlur?.(e); }}
      title={value !== null ? formatMoney(value, { locale, currency: code }) : undefined}
    />
  );
}

/* ------------------------------ tabs in the URL --------------------------- */

/**
 * A section tab, held in the query string beside the filters that are already
 * there. Every other control on these screens survives a reload and can be
 * sent to a colleague; a tab strip that does not is the odd one out, and
 * "open the late arrivals" then has to be said in words rather than linked.
 */
export function useTabParam<T extends string>(
  key: string, options: readonly T[], fallback: T,
): [T, (next: T) => void] {
  const [raw, setRaw] = useSearchParam(key, fallback);
  const value = (options as readonly string[]).includes(raw) ? (raw as T) : fallback;
  const set = useCallback(
    (next: T) => setRaw(next === fallback ? undefined : next),
    [setRaw, fallback],
  );
  return [value, set];
}

/* -------------------------------- the axis -------------------------------- */

/**
 * A money tick formatter that cannot print the same label twice.
 *
 * Compact money drops the fraction on a whole amount, so £2,285.00 and
 * £2,370.50 both come out "£2K" on a small-magnitude axis and the reader is
 * asked to believe two different gridlines are the same number. The ticks are
 * derived here exactly as the chart derives them, and the shortest format that
 * keeps them distinct is the one used.
 */
export function moneyAxis(f: Formatter, currency: string, values: number[]): (value: number) => string {
  const code = (currency || f.currency).toLowerCase();
  const finite = values.filter((value) => Number.isFinite(value));
  const ticks = niceTicks(Math.min(0, ...finite), Math.max(0, ...finite), 5);
  const distinct = new Set(ticks).size;
  const candidates: ((value: number) => string)[] = [
    (value) => formatMoney(value, { locale: f.locale, currency: code, compact: true, trimZeroFraction: true }),
    (value) => formatMoney(value, { locale: f.locale, currency: code, compact: true }),
    (value) => formatMoney(value, { locale: f.locale, currency: code, trimZeroFraction: true }),
  ];
  return candidates.find((format) => new Set(ticks.map(format)).size === distinct) ?? candidates[2];
}

/**
 * A per-unit rate, with its currency and enough precision to be checked.
 *
 * The API carries this as minor units per whole unit, rounded to two places,
 * which turns a rate of 0.0282¢ an event into "0.03" — a bare number, in a
 * unit nobody states, 6% away from the truth. The division is on the ratio, so
 * it is re-rendered here in the currency; and a rate too small to write per
 * unit is quoted per thousand or per million, the way metered prices are
 * actually quoted, rather than as a row of leading zeroes.
 */
export function unitRateText(
  f: Formatter, ratio: Ratio | null | undefined, currency: string, unitLabel: string | null,
): string {
  if (!ratio || ratio.undefined_value || !ratio.denominator) return '—';
  const code = (currency || f.currency).toLowerCase() as Currency;
  const symbol = currencySymbol(code, f.locale);
  // Numerator and denominator carry the same micro scaling, so it divides out.
  const perUnit = ratio.numerator / ratio.denominator / 10 ** exponentOf(code);
  const noun = (count: number) => pluralize(unitLabel || 'unit', count);
  if (Math.abs(perUnit) >= 0.01) {
    return `${symbol}${formatNumber(perUnit, { locale: f.locale, decimals: 2, maxDecimals: 4 })} per ${noun(1)}`;
  }
  const per = Math.abs(perUnit) >= 0.000_01 ? 1_000 : 1_000_000;
  return `${symbol}${formatNumber(perUnit * per, { locale: f.locale, decimals: 2, maxDecimals: 2 })} per ${formatNumber(per, { locale: f.locale })} ${noun(per)}`;
}

/* ---------------------------------- export -------------------------------- */

/**
 * What a revenue operator's week ends in.
 *
 * Everything exported is what the grid is showing at that moment — the same
 * filter, the same order — because a file holding rows the screen did not is
 * how a reconciliation goes wrong twice. Amounts are plain decimals in the
 * major unit with the currency in its own column: a spreadsheet cannot add
 * "€1.309,00", and it adds `130900` to the wrong answer.
 */
export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

export const csvAmount = (minor: number | null | undefined, currency: string): string => {
  if (minor === null || minor === undefined) return '';
  const exp = exponentOf((currency || 'usd').toLowerCase() as Currency);
  return (minor / 10 ** exp).toFixed(exp);
};

export const csvDay = (ts: number | null | undefined): string =>
  (ts === null || ts === undefined ? '' : new Date(ts).toISOString().slice(0, 10));

export const csvInstant = (ts: number | null | undefined): string =>
  (ts === null || ts === undefined ? '' : new Date(ts).toISOString());

/** RFC 4180: quote anything with a comma, a quote or a newline; double the quotes. */
const csvCell = (raw: string | number | null | undefined): string => {
  if (raw === null || raw === undefined) return '';
  const text = String(raw);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((column) => csvCell(column.header)).join(',')];
  for (const row of rows) lines.push(columns.map((column) => csvCell(column.value(row))).join(','));
  // Excel on Windows wants the CRLF, and the BOM is what lets it read the €
  // and £ signs a multi-currency book is full of.
  return `﻿${lines.join('\r\n')}\r\n`;
}

const fileStamp = (now: number, timeZone: string): string => new Intl.DateTimeFormat('en-CA', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now);

export function ExportCsvButton<T>({
  rows, columns, name, noun, size = 'sm', variant = 'secondary',
}: {
  rows: T[];
  columns: CsvColumn<T>[];
  /** Slug for the filename: `ain-credit-grants-2026-09-01.csv`. */
  name: string;
  noun: string;
  size?: 'sm' | 'md';
  variant?: 'secondary' | 'ghost';
}) {
  const f = useFormat();
  const toast = useToast();
  const count = rows.length;

  const run = () => {
    const file = `ain-${name}-${fileStamp(f.now(), f.timeZone)}.csv`;
    const url = URL.createObjectURL(new Blob([toCsv(rows, columns)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = file;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoked on the next frame: revoking synchronously races the download in
    // WebKit and lands an empty file.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    toast.success(
      `${formatNumber(count)} ${count === 1 ? noun : pluralize(noun, count)} exported`,
      `${file} — the rows on screen, in the order they are shown.`,
    );
  };

  return (
    <Button
      size={size}
      variant={variant}
      iconLeft={<Icons.download size={14} />}
      disabled={count === 0}
      title={count === 0
        ? `There is nothing to export — no ${pluralize(noun, 2)} match the filters in force.`
        : `Export ${formatNumber(count)} ${count === 1 ? noun : pluralize(noun, count)} as CSV`}
      onClick={run}
    >
      Export
    </Button>
  );
}

/**
 * How many rows a DataTable is actually showing, under the grid's own rules.
 *
 * A label beside the search box that keeps quoting the unfiltered count while
 * six rows are on screen is a wrong number in the same viewport as the right
 * one. The table does not hand its processed rows out, so the search and the
 * filters are replayed here against the same accessors the columns declare.
 */
export function visibleRows<T>(
  rows: T[],
  columns: { id: string; accessor?: (row: T) => CellValue; unsearchable?: boolean }[],
  view: TableState,
  sort?: SortState | null,
): T[] {
  const byId = new Map(columns.map((column) => [column.id, column]));
  const read = (row: T, columnId: string): CellValue => {
    const column = byId.get(columnId);
    if (column?.accessor) return column.accessor(row);
    const raw = (row as Record<string, unknown>)[columnId];
    return typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' || raw === null || raw === undefined
      ? (raw as CellValue)
      : String(raw);
  };
  const searchable = columns.filter((column) => !column.unsearchable).map((column) => column.id);
  const shown = searchRows(filterRows(rows, view.filters, read), view.query, searchable, read);
  const order = sort === undefined ? view.sort : sort;
  return order ? sortRows(shown, order, read) : shown;
}

/* ---------------------------- table state in the URL ---------------------- */

/**
 * A DataTable's query, sort and filters, held in the query string under a
 * short prefix so two tables on one screen do not collide. Everything else on
 * these screens — the range, the currency, the month, the tab — is already
 * URL-backed; a filter that vanishes on reload is the odd one out, and it is
 * the one people most want to send to somebody.
 */
export function useUrlTableState(
  prefix: string, defaultSort: SortState | null = null,
): { state: TableState; setState: (next: TableState) => void; clear: () => void } {
  const { location, setQuery } = useRouter();
  const keys = useMemo(() => ({ q: `${prefix}q`, sort: `${prefix}sort`, filter: `${prefix}filter` }), [prefix]);
  const state = useMemo(() => {
    const decoded = decodeTableState({
      q: location.query[keys.q],
      sort: location.query[keys.sort],
      filter: location.query[keys.filter],
    });
    // A controlled table ignores `initialSort`, so the default belongs here —
    // otherwise a fresh URL opens the book in row order rather than by size.
    return decoded.sort ? decoded : { ...decoded, sort: defaultSort };
  }, [location.query, keys, defaultSort]);

  const setState = useCallback((next: TableState) => {
    const encoded = encodeTableState(next);
    setQuery({ [keys.q]: encoded.q, [keys.sort]: encoded.sort, [keys.filter]: encoded.filter });
  }, [setQuery, keys]);

  return {
    state,
    setState,
    clear: useCallback(() => setState({ query: '', sort: state.sort, filters: {} }), [setState, state.sort]),
  };
}
