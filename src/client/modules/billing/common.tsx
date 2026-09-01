/**
 * The pieces every billing screen shares: paging that survives a filter change,
 * a table view that lives in the URL, inline editing bound to PATCH, and the
 * two things a mutation always owes the operator — a toast and a field-level
 * error pinned to the `param` the server named.
 */
import {
  useCallback, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { api, invalidate, useQuery, type ApiClientError, type ListEnvelope } from '../../kernel/api';
import { Link, useRouter, useSearchParam } from '../../kernel/router';
import {
  Badge, Button, EmptyState, ErrorState, Icons, Inline, Input, MoneyInput, SearchInput, Select, Stack, Tooltip,
  currencySymbol, decodeTableState, encodeTableState, humanize, parseMoneyInput, useFormat, useToast,
  type DateOptions, type Formatter, type TableState, type SortState,
} from '../../design';
import { AlertTriangleIcon, ChevronLeftIcon, ChevronRightIcon } from '../../design';
import { exponentOf, type Currency } from '../../../shared/money';
import './billing.css';

/* --------------------------- dates that bill ----------------------------- */

/**
 * Two kinds of date live on these screens, and printing them the same way is
 * how an AR clerk quotes a due date that is off by one.
 *
 * A **billing boundary** — a period start or end, a due date, a start date, a
 * billing anchor, a credit-grant expiry — is a *calendar date* the engine
 * computes in UTC (`startOfDay` and `addInterval` in `src/shared/time.ts` are
 * UTC throughout, and the server's own `period_display` strings are formatted
 * with `timeZone: 'UTC'`). Rendered in America/New_York, 2026-09-12T00:00Z is
 * "Sep 11" — a day early, and contradicting the pre-formatted sentence printed
 * beside it.
 *
 * A **timestamp** — created, finalised, paid, a dunning attempt — is a real
 * instant, and belongs in the workspace's timezone where "4:12 PM" means what
 * the operator's clock said.
 *
 * `f.day()` and `f.dayRange()` are the first kind. `f.date()`, `f.dateTime()`
 * and `f.time()` stay the second.
 */
export interface BillingFormatter extends Formatter {
  day(ts: number | null | undefined, o?: DateOptions): string;
  dayRange(start: number, end: number, o?: DateOptions): string;
}

export function useBillingFormat(): BillingFormatter {
  const f = useFormat();
  return useMemo(() => ({
    ...f,
    day: (ts, o) => f.date(ts, { ...o, timeZone: 'UTC' }),
    dayRange: (start, end, o) => f.dateRange(start, end, { ...o, timeZone: 'UTC' }),
  }), [f]);
}

/* ------------------------------- data access ----------------------------- */

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface CursorList<T> {
  rows: T[];
  total: number;
  loading: boolean;
  error: ApiClientError | null;
  retry: () => void;
  page: number;
  hasNext: boolean;
  hasPrev: boolean;
  next: () => void;
  prev: () => void;
  /** What the toolbar shows: "1–100 of 341". */
  range: [number, number];
}

/**
 * A cursor-paged list. The stack of cursors is reset whenever the filter
 * changes, because page 3 of one filter is not page 3 of another — that is the
 * bug that shows an empty grid after a status is chosen.
 */
export function useCursorList<T>(path: string, query: Query, limit = 100): CursorList<T> {
  const [stack, setStack] = useState<string[]>([]);
  const key = JSON.stringify(query);
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    setStack([]);
  }, [key]);

  const cursor = stack[stack.length - 1];
  const { data, error, loading, refetch } = useQuery<ListEnvelope<T>>(path, { ...query, limit, cursor });
  const rows = data?.data ?? [];
  const from = stack.length * limit + 1;
  return {
    rows,
    total: data?.total_count ?? rows.length,
    loading: loading && !data,
    error,
    retry: refetch,
    page: stack.length + 1,
    hasNext: !!data?.next_cursor && !!data?.has_more,
    hasPrev: stack.length > 0,
    next: () => { if (data?.next_cursor) setStack((s) => [...s, data.next_cursor as string]); },
    prev: () => setStack((s) => s.slice(0, -1)),
    range: [rows.length ? from : 0, from + Math.max(rows.length - 1, 0)],
  };
}

/** The DataTable's search, sort and filters, serialised into the address bar. */
export function useTableView(initialSort: SortState | null = null): [TableState, (s: TableState) => void] {
  const { location, setQuery } = useRouter();
  const { q, sort, filter } = location.query;
  const state = useMemo(() => {
    const decoded = decodeTableState({ q, sort, filter });
    return decoded.sort ? decoded : { ...decoded, sort: initialSort };
    // `initialSort` is a literal at every call site; re-deriving on identity churn
    // would reset the operator's sort on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, sort, filter]);
  const set = useCallback((next: TableState) => {
    const encoded = encodeTableState(next);
    setQuery({ q: encoded.q ?? undefined, sort: encoded.sort ?? undefined, filter: encoded.filter ?? undefined });
  }, [setQuery]);
  return [state, set];
}

/** Read `?new=1` once and clear it, so the create dialog opens from the + menu. */
export function useOpenOnQuery(param: string, onOpen: () => void): void {
  const { location, setQuery } = useRouter();
  const value = location.query[param];
  const fired = useRef(false);
  useEffect(() => {
    if (!value || fired.current) return;
    fired.current = true;
    setQuery({ [param]: undefined });
    onOpen();
  }, [value, param, setQuery, onOpen]);
}

/* ------------------------------- mutations ------------------------------- */

export interface ActionCopy {
  success: string;
  description?: string;
  failure: string;
  /**
   * Skip the failure toast. For a dialog that is already showing the refusal
   * inline against the field the server named — a toast repeating the same
   * forty words over the form it is talking about is not a second warning, it
   * is the same warning covering the control that would fix it.
   */
  inlineOnly?: boolean;
}

export interface ActionState {
  run: <T>(work: Promise<T>, copy: ActionCopy, invalidates?: string[]) => Promise<T | null>;
  error: ApiClientError | null;
  clear: () => void;
  busy: boolean;
  /** The message the server attached to this field, if it named one. */
  errorFor: (param: string) => string | undefined;
}

/**
 * One call, one toast, one invalidation — and the failure kept so a form can
 * pin it to the field the server refused rather than only shouting it.
 */
export function useAction(): ActionState {
  const toast = useToast();
  const [error, setError] = useState<ApiClientError | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(
    work: Promise<T>,
    copy: ActionCopy,
    invalidates: string[] = [],
  ): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      const result = await work;
      if (invalidates.length) invalidate(...invalidates);
      toast.success(copy.success, copy.description);
      return result;
    } catch (e) {
      const err = e as ApiClientError;
      setError(err);
      if (!copy.inlineOnly) toast.error(copy.failure, err?.body?.message ?? 'The server refused the request.', { duration: 0 });
      return null;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return {
    run,
    error,
    busy,
    clear: () => setError(null),
    errorFor: (param) => (error?.body?.param === param ? error.body.message : undefined),
  };
}

export const idem = (): string => (
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `idem_${Date.now()}_${Math.random()}`
);

/* --------------------------------- links --------------------------------- */

export const customerHref = (id: string) => `/billing/customers/${id}`;
export const subscriptionHref = (id: string) => `/billing/subscriptions/${id}`;
export const invoiceHref = (id: string) => `/billing/invoices/${id}`;

export function RecordLink({ to, children, mono }: { to: string; children: ReactNode; mono?: boolean }) {
  return <Link to={to} className={mono ? 'bl-link bl-link--mono' : 'bl-link'}>{children}</Link>;
}

/* -------------------------------- statuses ------------------------------- */

/**
 * One label map for every status this module shows — subscriptions, invoices,
 * credit notes, dunning campaigns and grants alike.
 *
 * Two rules it exists to keep. Casing is uniform, so a credit note never reads
 * a lowercase "void" beside an invoice's title-cased "Void". And the record's
 * word is the operator's word: the menu item says "Write it off", so the badge
 * says "Written off" rather than the wire value `uncollectible`.
 */
const STATUS_COPY: Record<string, string> = {
  trialing: 'Trialing', active: 'Active', past_due: 'Past due', paused: 'Paused',
  canceled: 'Canceled', unpaid: 'Unpaid', incomplete: 'Incomplete', incomplete_expired: 'Expired',
  draft: 'Draft', open: 'Open', paid: 'Paid', void: 'Voided', uncollectible: 'Written off',
  issued: 'Issued', recovering: 'Recovering', recovered: 'Recovered', exhausted: 'Given up',
  succeeded: 'Succeeded', failed: 'Failed', skipped: 'Skipped', pending: 'Not checked',
  verified: 'Verified', unverified: 'Unverified', unavailable: 'Register silent',
};

export const statusLabel = (status: string): string => STATUS_COPY[status] ?? humanize(status);

export function StatusPill({ status, title }: { status: string; title?: string }) {
  const pill = <Badge tone={toneFor(status)} dot pill>{statusLabel(status)}</Badge>;
  return title ? <Tooltip content={title}><span className="bl-pill">{pill}</span></Tooltip> : pill;
}

/** The billing words the shared status ramp does not already carry. */
function toneFor(status: string): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  switch (status) {
    case 'active': case 'paid': return 'success';
    case 'trialing': case 'open': case 'issued': return 'info';
    case 'past_due': case 'paused': case 'incomplete': return 'warning';
    case 'unpaid': case 'canceled': case 'uncollectible': return 'danger';
    default: return 'neutral';
  }
}

/* ------------------------------ presentation ----------------------------- */

/** A signed amount that always reads as credit or charge, never as a bare sum. */
export function Amount({ value, display, tone }: { value: number; display: string; tone?: 'auto' | 'plain' }) {
  const cls = tone === 'plain' ? 'bl-amount' : value < 0 ? 'bl-amount bl-amount--credit' : 'bl-amount';
  return <span className={cls}>{display}</span>;
}

export function FieldRow({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="bl-fieldrow">
      <div className="bl-fieldrow__label">{label}</div>
      <div className="bl-fieldrow__value">
        {children}
        {hint && <div className="bl-fieldrow__hint">{hint}</div>}
      </div>
    </div>
  );
}

export function SectionError({ error, path, onRetry }: { error: ApiClientError; path: string; onRetry: () => void }) {
  return (
    <ErrorState
      title="That did not load"
      message={error.body.message}
      code={`${error.status} ${path}`}
      requestId={error.body.request_id ?? null}
      action={<Button size="sm" variant="primary" iconLeft={<Icons.refresh size={13} />} onClick={onRetry}>Try again</Button>}
    />
  );
}

/**
 * The list's failure, rendered outside the grid.
 *
 * `DataTable` puts its error state in a `<td colSpan>` inside the horizontally
 * scrolling table body, so a sentence longer than the summed column widths runs
 * off the right edge and is only reachable by scrolling the grid sideways. The
 * grid keeps its toolbar and filters; the reason lives above it, where it wraps.
 */
export function ListFailure({ error, path, onRetry }: { error: ApiClientError; path: string; onRetry: () => void }) {
  return (
    <div className="bl-listfail">
      <SectionError error={error} path={path} onRetry={onRetry} />
    </div>
  );
}

export function LoadFailedEmpty({ noun }: { noun: string }) {
  return (
    <EmptyState
      size="sm"
      illustration={null}
      title={`No ${noun} were loaded`}
      body="The message above says what the server answered. Nothing here is a count of zero."
    />
  );
}

/**
 * The grid's search box, owned here rather than by `DataTable`.
 *
 * The shared component labels its input "Search table rows" whatever the
 * placeholder says, so a speech-input user reading "Search number, account or
 * id" off the screen cannot address it and a screen-reader user hears a
 * different control from the one a sighted colleague is describing. This one
 * takes its accessible name from the words actually on screen.
 */
export function TableSearch({ view, onChange, label }: {
  view: TableState; onChange: (state: TableState) => void; label: string;
}) {
  return (
    <SearchInput
      value={view.query}
      onChange={(query) => onChange({ ...view, query })}
      size="sm"
      placeholder={`${label}…`}
      aria-label={label}
      wrapperClassName="bl-tablesearch"
    />
  );
}

/* ---------------------------- priced sentences --------------------------- */

/**
 * A unit rate that may be worth a fraction of a cent.
 *
 * `formatMoney` takes whole minor units, so a metered rate of "0.04" cents
 * rounds to $0.00 — the one number on a usage bill that must not. This keeps
 * enough decimals to show the rate and no more.
 */
export function formatUnitRate(decimalMinorUnits: string, currency: string, locale: string): string {
  const exponent = exponentOf(currency);
  const value = Number(decimalMinorUnits) / 10 ** exponent;
  if (!Number.isFinite(value)) return decimalMinorUnits;
  let decimals = exponent;
  if (value !== 0) {
    // Two significant figures, capped, so $0.0004 survives and $12.00 is not
    // dressed up as $12.000000.
    while (decimals < 8 && Math.abs(value) * 10 ** decimals < 1) decimals++;
    if (Math.abs(value) < 1) decimals = Math.min(8, decimals + 1);
  }
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: Math.min(decimals, 8),
    maximumFractionDigits: Math.min(decimals, 8),
  }).format(value);
}

/**
 * A pricing-engine breakdown label, with its money made readable.
 *
 * The engine writes rows like "1 robot at 950 minor units each" — exact, and
 * exactly the thing this product refuses to put on a screen. The figure is
 * minor units of the line's own currency, so it is formatted in place and the
 * rest of the sentence is left as the engine wrote it.
 */
export function breakdownLabel(label: string, currency: string, locale: string): string {
  return label.replace(
    /(\d+(?:\.\d+)?)\s+minor units/g,
    (_match, amount: string) => formatUnitRate(amount, currency, locale),
  );
}

/* ------------------------------- previews -------------------------------- */

export interface PreviewResult<T> {
  data: T | null;
  error: ApiClientError | null;
  /** True while a request is in flight, including a re-price over stale data. */
  loading: boolean;
  refetch: () => void;
}

/**
 * A POST that prices something before it is committed.
 *
 * `useQuery` is GET-only, and every honest preview in this module is a POST —
 * `/v1/subscriptions/:id/preview`, `/v1/credit_notes/preview`,
 * `/v1/catalog/estimate`. The body is compared by value, so a re-render with an
 * identical basket does not re-ask; a ticket guards against an earlier, slower
 * answer overwriting a later one, which is what makes a panel that re-prices on
 * every keystroke trustworthy.
 */
export function usePricedPreview<T>(path: string | null, body: unknown, enabled = true): PreviewResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const ticket = useRef(0);
  const key = path && enabled ? `${path}|${JSON.stringify(body)}` : null;

  useEffect(() => {
    if (!key) { setData(null); setError(null); setLoading(false); return; }
    const mine = ++ticket.current;
    setLoading(true);
    const timer = setTimeout(() => {
      const [target, payload] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
      api.post<T>(target, JSON.parse(payload))
        .then((result) => { if (mine === ticket.current) { setData(result); setError(null); } })
        .catch((e: ApiClientError) => { if (mine === ticket.current) { setError(e); setData(null); } })
        .finally(() => { if (mine === ticket.current) setLoading(false); });
    }, 250);
    return () => clearTimeout(timer);
  }, [key, nonce]);

  return { data, error, loading, refetch: useCallback(() => setNonce((n) => n + 1), []) };
}

/* ---------------------------- proration copy ----------------------------- */

const REDUCE = (a: number, b: number): number => (b === 0 ? a : REDUCE(b, a % b));

/**
 * The proration explanation, with the raw rational lifted out of the sentence.
 *
 * The server writes one string that carries both halves: "…10d 23h of it
 * remaining at Sep 1 = 950131963/2678400000 ms = +$638.53". The first half is
 * what an operator reads; the second is what an auditor checks, and printing a
 * ten-digit unreduced fraction inline is how a priced change starts looking
 * like a stack trace. This splits them so the sentence stays a sentence and the
 * arithmetic moves behind the disclosure the lines already have.
 */
export interface ProrationCopy {
  sentence: string;
  exact: {
    numerator: number;
    denominator: number;
    /** The same fraction in lowest terms, when that is a different pair. */
    reduced: { numerator: number; denominator: number } | null;
  } | null;
}

export function prorationCopy(
  explanation: string,
  fraction?: { numerator: number; denominator: number } | null,
): ProrationCopy {
  const sentence = explanation.replace(/=\s*\d+\s*\/\s*\d+\s*ms\s*(?==)/, '').replace(/\s{2,}/g, ' ').trim();
  if (!fraction || fraction.denominator === 0) return { sentence, exact: null };
  const divisor = Math.abs(REDUCE(fraction.numerator, fraction.denominator)) || 1;
  const reduced = divisor > 1
    ? { numerator: fraction.numerator / divisor, denominator: fraction.denominator / divisor }
    : null;
  return { sentence, exact: { ...fraction, reduced } };
}

/* ------------------------------ inline editing --------------------------- */

export interface InlineEditProps {
  value: string;
  onSave: (value: string) => Promise<unknown>;
  label: string;
  placeholder?: string;
  type?: 'text' | 'email' | 'tel' | 'number';
  options?: { value: string; label: string }[];
  empty?: string;
  mono?: boolean;
}

/**
 * Click, type, Enter. Escape restores what was there. The value on screen only
 * changes once the PATCH comes back, so a refused edit never leaves a number
 * on screen that the server does not hold.
 */
export function InlineEdit({ value, onSave, label, placeholder, type = 'text', options, empty = '—', mono }: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const commit = async (next: string) => {
    if (next === value) { setEditing(false); return; }
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
    } catch {
      // The toast raised by the caller carries the reason; keep the draft so
      // the operator can correct it rather than retype it.
    } finally {
      setSaving(false);
    }
  };

  if (options) {
    return (
      <Select
        aria-label={label}
        size="sm"
        value={value}
        options={options}
        onChange={(next) => { void commit(next); }}
        wrapperClassName="bl-inline__select"
      />
    );
  }

  if (!editing) {
    return (
      <button type="button" className="bl-inline" onClick={() => setEditing(true)} aria-label={`Edit ${label}`}>
        <span className={value ? (mono ? 'u-mono' : undefined) : 'bl-inline__empty'}>{value || empty}</span>
        <Icons.edit size={12} className="bl-inline__pencil" />
      </button>
    );
  }

  return (
    <Inline gap={2}>
      <Input
        ref={inputRef}
        size="sm"
        type={type}
        aria-label={label}
        placeholder={placeholder}
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void commit(draft); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDraft(value); setEditing(false); }
        }}
        onBlur={() => { void commit(draft); }}
      />
      {saving && <Icons.refresh size={13} className="bl-spin" />}
    </Inline>
  );
}

/* --------------------------------- misc ---------------------------------- */

export function EmptyList({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return <EmptyState title={title} body={body} action={action} />;
}

export function ListFooter({ list, noun }: { list: CursorList<unknown>; noun: string }) {
  const paged = list.hasNext || list.hasPrev;
  return (
    <Inline justify="between" gap={4} className="bl-listfoot">
      <span className="bl-listfoot__count">
        {/* A count of zero on a failed read asserts there are none, which is
            the one thing the request never established. */}
        {list.error
          ? `The ${noun} could not be loaded`
          : list.rows.length
            ? `${list.range[0]}–${list.range[1]} of ${list.total} ${noun}`
            : `No ${noun} on this page`}
        {!list.error && list.rows.length > 0 && paged && (
          // A total under a paged grid is the page's total. Saying so is the
          // difference between a receivables figure and a wrong one.
          <span className="bl-listfoot__scope"> · totals cover this page</span>
        )}
      </span>
      <Inline gap={2}>
        <Button size="sm" variant="secondary" disabled={!list.hasPrev} onClick={list.prev} iconLeft={<ChevronLeftIcon size={14} />}>
          Previous
        </Button>
        <Button size="sm" variant="secondary" disabled={!list.hasNext} onClick={list.next} iconRight={<ChevronRightIcon size={14} />}>
          Next
        </Button>
      </Inline>
    </Inline>
  );
}

/** Fetch helper used by dialogs that need a one-shot POST preview. */
export async function post<T>(path: string, body: unknown): Promise<T> {
  return api.post<T>(path, body);
}

export function Loading({ label }: { label: string }) {
  return (
    <Stack gap={4} align="center" className="bl-loading">
      <Icons.refresh size={18} className="bl-spin" />
      <span className="bl-loading__label">{label}</span>
    </Stack>
  );
}

/* ------------------------------ record tabs ------------------------------ */

/**
 * A record's open tab, kept in the address bar beside the filters.
 *
 * Tabs used to be component state, so a reload after an edit dropped the
 * operator back on Overview and "the credit notes on NR-000341" was not a
 * sendable link. An unknown or stale `?tab=` falls back rather than rendering
 * an empty panel.
 */
export function useRecordTab<T extends string>(tabs: readonly T[], fallback: T): [T, (tab: T) => void] {
  const [raw, setRaw] = useSearchParam('tab', fallback);
  const value = (tabs as readonly string[]).includes(raw) ? (raw as T) : fallback;
  const set = useCallback((tab: T) => setRaw(tab === fallback ? undefined : tab), [setRaw, fallback]);
  return [value, set];
}

/** Hold a value still for `ms` — what turns a search box into one request. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [held, setHeld] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setHeld(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return held;
}

/* ------------------------------ money fields ----------------------------- */

const moneyText = (minor: number | null, exp: number): string => (minor === null ? '' : (minor / 10 ** exp).toFixed(exp));

/**
 * Money in integer minor units, committed on every keystroke.
 *
 * The design system's `MoneyInput` commits on blur, which is right for a form
 * that submits — and wrong for the two dialogs here that price themselves as
 * you type, where a mouse user typed an amount, clicked the disabled primary
 * button, and got nothing: a disabled button takes no focus, so the field
 * never blurred and the panel never priced. This one parses straight into
 * minor units on change and only re-formats when focus leaves, so the caller's
 * own debounce is what throttles the preview.
 *
 * The label comes from the enclosing `Field`, so the accessible name is the
 * visible one rather than a generic "Amount".
 */
export function MoneyField({ value, onChange, currency, min, max, label }: {
  value: number | null;
  onChange: (value: number | null) => void;
  currency: string;
  min?: number;
  max?: number;
  label?: string;
}) {
  const f = useFormat();
  const exp = exponentOf(currency);
  const [text, setText] = useState(() => moneyText(value, exp));
  const last = useRef(value);

  useEffect(() => {
    if (value !== last.current) { setText(moneyText(value, exp)); last.current = value; }
  }, [value, exp]);

  const clamp = (minor: number): number => {
    let next = minor;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    return next;
  };

  const type = (raw: string) => {
    setText(raw);
    if (raw.trim() === '') { last.current = null; onChange(null); return; }
    const parsed = parseMoneyInput(raw, currency);
    if (!parsed) return;
    const next = clamp(parsed.amount);
    if (next !== last.current) { last.current = next; onChange(next); }
  };

  return (
    <Input
      type="text"
      inputMode="decimal"
      value={text}
      placeholder={(0).toFixed(exp)}
      wrapperClassName="ain-input--number"
      prefix={currencySymbol(currency, f.locale)}
      suffix={<span className="bl-ccy">{currency}</span>}
      aria-label={label}
      onChange={(e) => type(e.target.value)}
      onBlur={() => setText(moneyText(last.current, exp))}
    />
  );
}

/** The blur-committed field, for forms that submit rather than price. */
export function MoneyInputField({ value, onChange, currency, min, label }: {
  value: number | null; onChange: (v: number | null) => void; currency: string; min?: number; label?: string;
}) {
  const f = useFormat();
  return (
    <MoneyInput
      value={value}
      onChange={onChange}
      currency={currency as Currency}
      locale={f.locale}
      min={min ?? 0}
      aria-label={label}
    />
  );
}

/* ------------------------------- currencies ------------------------------ */

/**
 * A sort key that ranks money inside its own currency.
 *
 * Comparing raw minor units across currencies converts at 1:1 and calls the
 * result a ranking — GBP 2,285 lands under $2,356 as though it were worth
 * less. There is no FX table in this platform, so the honest order is grouped:
 * currency first, amount inside it.
 */
export const moneyRank = (amount: number, currency: string): string =>
  `${currency.toLowerCase()}|${String(Math.round(amount) + 1e12).padStart(16, '0')}`;

export interface CurrencyTotal { currency: string; amount: number }

export function totalsByCurrency<T>(rows: T[], amount: (row: T) => number, currency: (row: T) => string): CurrencyTotal[] {
  const map = new Map<string, number>();
  for (const row of rows) {
    const key = currency(row).toLowerCase();
    map.set(key, (map.get(key) ?? 0) + amount(row));
  }
  return [...map.entries()].map(([c, a]) => ({ currency: c, amount: a })).sort((a, b) => a.currency.localeCompare(b.currency));
}

/** One figure per currency, never one figure across them. */
export function MoneyTotals({ totals }: { totals: CurrencyTotal[] }) {
  const f = useFormat();
  if (totals.length === 0) return <span className="bl-muted">—</span>;
  if (totals.length === 1) return <>{f.money(totals[0].amount, { currency: totals[0].currency })}</>;
  return (
    <span className="bl-ccytotals" title="Nothing is converted — one figure per currency.">
      {totals.map((total) => (
        <span key={total.currency} className="bl-ccytotals__item">{f.money(total.amount, { currency: total.currency })}</span>
      ))}
    </span>
  );
}

/**
 * The sentence under a line, unless it only repeats the line.
 *
 * Some priced lines carry an explanation identical to their description but for
 * the full stop, and printing both makes the bill look like it stutters.
 */
export function lineWhy(description: string, explanation: string | null | undefined): string | null {
  if (!explanation) return null;
  const bare = (value: string) => value.replace(/\.$/, '').trim();
  return bare(explanation) === bare(description) ? null : explanation;
}

/* ------------------------------ failure states --------------------------- */

/**
 * A refusal and an outage are different things.
 *
 * A 4xx from a preview is the operator's own input — "a flat fee's quantity is
 * always 1" — and "Try again" on it fails identically forever. Only a 5xx or a
 * dropped connection is worth retrying, so only that one gets the button.
 */
export function PreviewFailure({ error, path, onRetry, title = 'That did not load', refusalTitle = 'This will not price' }: {
  error: ApiClientError; path: string; onRetry: () => void; title?: string; refusalTitle?: string;
}) {
  const refused = error.status >= 400 && error.status < 500;
  if (refused) {
    return (
      <div className="bl-refusal" role="alert">
        <span className="bl-refusal__icon"><AlertTriangleIcon size={16} /></span>
        <div>
          <div className="bl-refusal__title">{refusalTitle}</div>
          <div className="bl-refusal__body">{error.body.message}</div>
          <div className="bl-refusal__meta">Change the item above — this is a refusal, not an outage, so sending it again returns the same answer.</div>
        </div>
      </div>
    );
  }
  return (
    <ErrorState
      title={title}
      message={error.body.message}
      code={`${error.status} ${path}`}
      requestId={error.body.request_id ?? null}
      action={<Button size="sm" variant="primary" iconLeft={<Icons.refresh size={13} />} onClick={onRetry}>Try again</Button>}
    />
  );
}
