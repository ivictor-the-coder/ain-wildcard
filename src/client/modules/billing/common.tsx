/**
 * The pieces every billing screen shares: paging that survives a filter change,
 * a table view that lives in the URL, inline editing bound to PATCH, and the
 * two things a mutation always owes the operator — a toast and a field-level
 * error pinned to the `param` the server named.
 */
import {
  useCallback, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { api, invalidate, useQuery, type ApiClientError, type ListEnvelope, type QueryResult } from '../../kernel/api';
import { Link, useRouter, useSearchParam } from '../../kernel/router';
import {
  Badge, Button, EmptyState, ErrorState, Field, Icons, Inline, Input, MoneyInput, Popover, SearchInput, Select,
  Stack, Tooltip,
  currencySymbol, decodeTableState, encodeTableState, filterRows, humanize, parseMoneyInput, searchRows,
  useFormat, useToast,
  type CellValue, type DateOptions, type Formatter, type TableState, type SortState,
} from '../../design';
import {
  AlertTriangleIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon,
} from '../../design';
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

/**
 * A record read that survives its own invalidation.
 *
 * Every mutation on a detail screen ends in `invalidate('/v1/customers')`, and
 * an invalidation *drops* the cache entry rather than marking it stale — so the
 * hook reports `loading` again for one paint. A page whose guard is
 * `if (loading) return <Loading/>` therefore tears the whole record down and
 * rebuilds it after every inline edit: the screen blinks, scroll position
 * jumps, and whatever the operator had focused is blurred by the unmount.
 *
 * What was on screen a moment ago is still the right thing to show while the
 * re-read is in flight. The kept copy is dropped the instant the address
 * changes, so moving between two records never shows the previous one.
 */
export function useRecord<T>(path: string | null, query?: Query): QueryResult<T> {
  const result = useQuery<T>(path, query);
  const kept = useRef<{ key: string | null; data: T | undefined }>({ key: path, data: undefined });
  if (kept.current.key !== path) kept.current = { key: path, data: undefined };
  if (result.data !== undefined) kept.current.data = result.data;
  const data = result.data ?? kept.current.data;
  return { ...result, data, loading: result.loading && data === undefined };
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
  // A payment instruction's own states. `requires_payment_method` is where a
  // declined intent goes — "Declined" is what happened, and calling it
  // "Requires payment method" hides that money was refused.
  requires_payment_method: 'Declined', requires_confirmation: 'Ready to present',
  requires_action: 'Needs the cardholder', processing: 'With the bank',
};

export const statusLabel = (status: string): string => STATUS_COPY[status] ?? humanize(status);

export function StatusPill({ status, title }: { status: string; title?: string }) {
  const pill = <Badge tone={toneFor(status)} dot pill>{statusLabel(status)}</Badge>;
  return title ? <Tooltip content={title}><span className="bl-pill">{pill}</span></Tooltip> : pill;
}

/** The billing words the shared status ramp does not already carry. */
function toneFor(status: string): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  switch (status) {
    case 'active': case 'paid': case 'succeeded': return 'success';
    case 'trialing': case 'open': case 'issued': case 'processing': return 'info';
    case 'past_due': case 'paused': case 'incomplete': case 'requires_action': return 'warning';
    case 'unpaid': case 'canceled': case 'uncollectible': case 'requires_payment_method': return 'danger';
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
export function MoneyField({ value, onChange, currency, min, max, label, placeholder }: {
  value: number | null;
  onChange: (value: number | null) => void;
  currency: string;
  min?: number;
  max?: number;
  label?: string;
  /** Overrides the "0.00" ghost, which reads as an amount on an optional field. */
  placeholder?: string;
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
      placeholder={placeholder ?? (0).toFixed(exp)}
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

/* --------------------------- one clock per screen ------------------------- */

/**
 * What an invoice's status means, dated on the invoice's own calendar.
 *
 * An invoice has one set of dates and the customer is holding them: the
 * document stamps itself in UTC, so a bill settled at 8pm in New York is dated
 * the following day on the copy in the customer's hand. Printing the
 * workspace-local date beside it — "Paid Sep 16" under a document that says
 * PAID Sep 17 — is an AR agent quoting a date the customer cannot find.
 *
 * So every date that *names the invoice* comes from `f.day()`, the UTC
 * calendar. The operator's own clock is not discarded; it moves to
 * `invoiceClockNote`, where it is labelled as their time rather than the
 * bill's.
 */
export function invoiceStatusDetail(
  invoice: { status: string; status_detail: string; due_date: number | null; paid_at: number | null },
  f: BillingFormatter,
): string {
  if (invoice.status === 'open') {
    return invoice.due_date ? `Owed, due ${f.day(invoice.due_date)}.` : 'Owed, payable on receipt.';
  }
  if (invoice.status === 'paid' && invoice.paid_at) return `Paid ${f.day(invoice.paid_at, { withYear: true })}.`;
  return invoice.status_detail;
}

/**
 * The instant behind an invoice date, on the operator's clock.
 *
 * The date above it is the one on the document. This is the moment the thing
 * actually happened where the operator was standing, said as such — the two are
 * never presented as one date, and the one on screen in the largest type is
 * always the one the customer can read back.
 */
export function invoiceClockNote(ts: number, f: BillingFormatter): string {
  const local = `Recorded ${f.dateTime(ts)}, ${f.timeZone.replace(/_/g, ' ')}.`;
  return f.day(ts, { withYear: true }) === f.date(ts, { withYear: true })
    ? local
    : `The date on the customer's copy — bills are stamped on a UTC calendar. ${local}`;
}

/* ------------------------------ calendar days ---------------------------- */

const dayFmt = new Map<string, Intl.DateTimeFormat>();

/**
 * The calendar day an instant falls on, as an integer, in a named timezone.
 *
 * Ageing a receivable is calendar arithmetic, not elapsed milliseconds:
 * "56 days overdue" has to agree with the two dates the operator can read off
 * the screen. Dividing `now - due_date` by 86,400,000 answers a different
 * question and lands a day out whenever the workspace clock and UTC are on
 * opposite sides of midnight — which, for America/New_York, is every evening.
 */
export function calendarDay(ts: number, timeZone: string): number {
  let fmt = dayFmt.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFmt.set(timeZone, fmt);
  }
  const iso = fmt.format(ts);
  return Math.round(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000);
}

/**
 * How many days late a bill is, counted between the day printed on the document
 * and the day the workspace clock is showing.
 *
 * A due date is a UTC calendar boundary; "now" is an instant in the workspace's
 * zone. Both are reduced to calendar days in the zone each is stated in before
 * they are subtracted, so the badge can never contradict the header.
 */
export function daysOverdue(due: number, now: number, timeZone: string): number {
  return Math.max(0, calendarDay(now, timeZone) - calendarDay(due, 'UTC'));
}

/**
 * A balance movement in the words the balance tile uses.
 *
 * The tile says "$100.00 of credit, which comes off the next invoice" and the
 * ledger under it said "-$100.00" for the same fact. Both are true of the same
 * signed number; printing them side by side without saying which convention is
 * in force is what makes an operator ask which one is wrong.
 */
export function balanceWords(
  amount: number,
  currency: string,
  f: BillingFormatter,
  zero: 'settled' | 'nothing' = 'nothing',
): string {
  if (amount === 0) return zero === 'settled' ? 'Settled' : '—';
  const money = f.money(Math.abs(amount), { currency });
  return amount < 0 ? `${money} credit` : `${money} owed`;
}

/* ------------------------- the whole book, not a page --------------------- */

export interface BookList<T> {
  rows: T[];
  /** What the server says the unfiltered book holds. */
  total: number;
  /** True once `rows` is the entire book, so counts and totals over it are facts. */
  complete: boolean;
  /** The book is larger than this screen will hold in memory. */
  truncated: boolean;
  loading: boolean;
  /** Later pages still arriving behind the rows already on screen. */
  sweeping: boolean;
  error: ApiClientError | null;
  retry: () => void;
}

const PAGE = 200;
const MAX_PAGES = 12;

/**
 * Every row a filter could match, not the first page of them.
 *
 * A grid whose search, ranges and totals run in the browser is only honest if
 * the browser holds the whole set. Paging the server and *then* filtering the
 * page produces the worst answer a receivables screen can give: a partial list
 * under a full count — "44 rows" beside "1–100 of 344" — where both halves are
 * true of different things and neither is the number that was asked for.
 *
 * So the first page renders immediately and the rest is swept in behind it,
 * with `complete` saying whether the arithmetic on screen is yet a statement
 * about the book or only about what has arrived. Past `MAX_PAGES` the sweep
 * stops and says so rather than pretending, because a browser that has run out
 * of rows must not go on reporting counts.
 */
export function useBookList<T>(path: string, query: Query, enabled = true): BookList<T> {
  const first = useQuery<ListEnvelope<T>>(path, { ...query, limit: PAGE }, { enabled });
  // Keyed on the first page's identity, not on its cursor: a refetch after a
  // bulk action can hand back the same `next_cursor` over different rows, and
  // keying on the cursor left every page after the first one stale behind a
  // freshly-read page one.
  const runs = useRef(0);
  const [swept, setSwept] = useState<{ run: number; rows: T[]; done: boolean; truncated: boolean }>(
    { run: -1, rows: [], done: false, truncated: false },
  );
  const [sweepError, setSweepError] = useState<ApiClientError | null>(null);
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    const page = first.data;
    if (!page) return;
    const run = (runs.current += 1);
    let live = true;
    setSweepError(null);
    if (!page.has_more || !page.next_cursor) {
      setSwept({ run, rows: [], done: true, truncated: false });
      return;
    }
    setSwept({ run, rows: [], done: false, truncated: false });
    void (async () => {
      const rows: T[] = [];
      let cursor: string | null = page.next_cursor;
      for (let i = 1; live && cursor && i < MAX_PAGES; i++) {
        try {
          const next: ListEnvelope<T> = await api.get<ListEnvelope<T>>(path, { ...query, limit: PAGE, cursor });
          if (!live) return;
          rows.push(...next.data);
          cursor = next.has_more ? next.next_cursor : null;
          setSwept({ run, rows: [...rows], done: !cursor, truncated: false });
        } catch (e) {
          if (live) setSweepError(e as ApiClientError);
          return;
        }
      }
      if (live && cursor) setSwept({ run, rows: [...rows], done: false, truncated: true });
    })();
    return () => { live = false; };
  }, [first.data, path, queryKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const mine = swept.run === runs.current;
  const rows = useMemo(
    () => [...(first.data?.data ?? []), ...(mine ? swept.rows : [])],
    [first.data, mine, swept.rows],
  );
  // Whether a sweep is owed is known from the first page itself, so a book that
  // fits in one page is complete on the render that receives it rather than
  // flashing "still reading the rest" for the frame before the effect runs.
  const owesSweep = !!first.data?.has_more && !!first.data?.next_cursor;
  const settled = !owesSweep || (mine && swept.done);
  const total = first.data?.total_count ?? rows.length;
  return {
    rows,
    total,
    complete: !!first.data && settled,
    truncated: mine && swept.truncated,
    loading: first.loading && !first.data,
    sweeping: !!first.data && !settled && !(mine && swept.truncated) && !sweepError,
    error: first.error ?? sweepError,
    retry: first.refetch,
  };
}

/**
 * How many rows the book holds when nothing is asked of it.
 *
 * `useBookList` reports the count of the *filtered* set, because that is what
 * the server answered. Saying "the whole book" needs the other number, and the
 * cheapest honest way to have it is to ask for one row of the unnarrowed list
 * and read its `total_count`. Without this the caption calls a server-narrowed
 * set the book — the filtered total and the row count agree, so nothing on
 * screen looks wrong, and a reader takes an Open-only receivables figure for
 * the workspace's.
 */
export function useBookTotal(path: string, whole: Query, enabled = true): number | null {
  const probe = useQuery<ListEnvelope<unknown>>(path, { ...whole, limit: 1 }, { enabled });
  return probe.data?.total_count ?? null;
}

/**
 * The count line under a whole-book grid.
 *
 * It states two things and never confuses them: how many rows the filters on
 * screen match, and how many the book holds. While the sweep is still running
 * neither is asserted as final, because a number that is about to change is not
 * an answer an AR clerk can act on.
 *
 * Narrowing is measured against the *unfiltered* book (`whole`), not against
 * what the server returned for the filters in force, so a status chip narrows
 * the caption exactly as the grid's own search does. Every path through here
 * that names a total names the same one.
 */
export function BookFooter({ book, noun, shown, whole }: {
  book: BookList<unknown>;
  noun: string;
  /** Rows the grid is displaying after every filter, server-side and client-side. */
  shown: number;
  /** What the book holds with no filter at all, or null while that is unknown. */
  whole: number | null;
}) {
  // Until the unfiltered count answers, the book's size is not known — and
  // "the whole book" is a claim about a number nobody has. The fallback states
  // only what is certain: how many rows the totals below cover.
  const total = whole ?? book.total;
  const filtered = shown !== total;
  const unknownBook = whole === null;
  const f = useBillingFormat();
  // The grid prints its own "44 of 345 rows" to the left of this. What it
  // cannot say is what those numbers are *about*: whether they cover the book
  // or a page of it, and whether the sweep behind them has finished. That is
  // the only thing said here, so one line never restates the other.
  const scope = book.error
    ? `The ${noun} could not be loaded, so nothing below is a count`
    : book.loading
      ? `Reading the ${noun}…`
      : book.truncated
        ? `Only the first ${f.number(book.rows.length)} of ${f.number(book.total)} ${noun} are held here — every figure below covers those`
        : book.sweeping
          ? `${f.number(book.rows.length)} of ${f.number(book.total)} read so far — still reading the rest of the book`
          : unknownBook
            ? `${f.number(shown)} ${noun} on screen, and the totals cover all of them`
            : filtered
              ? `${f.number(shown)} of the ${f.number(total)} ${noun} in the book match — the totals cover the ${f.number(shown)}, not a page of them`
              : `The whole book — every ${noun.replace(/s$/, '')} this workspace holds, and the totals cover all of them`;
  return (
    <Inline justify="between" gap={4} className="bl-listfoot">
      <span className="bl-listfoot__count">{scope}</span>
    </Inline>
  );
}

/* --------------------------------- export -------------------------------- */

/**
 * One column of a CSV, as a finance team reads it.
 *
 * The grid's own accessors are the wrong source: they hand back sortable
 * primitives, so `total` is `12784000` and a month-end file opens with every
 * amount a hundred times too big. Each book therefore declares what it exports
 * — the same figures the screen shows, formatted the same way, plus the ids and
 * the ISO dates a spreadsheet can pivot on.
 */
export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

/**
 * An amount as a spreadsheet reads it: a plain decimal in the major unit.
 *
 * Not the minor-unit integer the API carries — a file where $127,840.00 is
 * `12784000` is a file that gets summed wrong — and not the formatted string
 * either, because `€1.309,00` will not add up in a German locale's Excel. The
 * currency travels in its own column beside it.
 */
export const csvAmount = (minor: number, currency: string): string => (
  (minor / 10 ** exponentOf(currency as Currency)).toFixed(exponentOf(currency as Currency))
);

/** The UTC calendar day an instant falls on — the day the invoice document carries. */
export const csvDay = (ts: number | null | undefined): string => (
  ts === null || ts === undefined ? '' : new Date(ts).toISOString().slice(0, 10)
);

/** The full instant, for the columns that are about when something happened. */
export const csvInstant = (ts: number | null | undefined): string => (
  ts === null || ts === undefined ? '' : new Date(ts).toISOString()
);

/** RFC 4180: quote anything with a comma, a quote or a newline; double the quotes. */
const csvCell = (raw: string | number | null | undefined): string => {
  if (raw === null || raw === undefined) return '';
  const text = String(raw);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((c) => csvCell(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row))).join(','));
  // Excel on Windows needs the CRLF, and a BOM to read the € and £ signs the
  // multi-currency books are full of. Both are what "opens correctly" means.
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

/** The day the file is named for, in the workspace's own zone rather than UTC. */
const fileStamp = (now: number, timeZone: string): string => new Intl.DateTimeFormat('en-CA', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now);

/**
 * Hand the rows on screen to whoever is closing the month.
 *
 * Everything exported is what the grid is showing at that moment — the same
 * filters, the same order — because a file that quietly holds more rows than
 * the screen did is how a reconciliation goes wrong twice.
 */
export function ExportCsvButton<T>({ rows, columns, name, noun, disabled, reason }: {
  rows: T[];
  columns: CsvColumn<T>[];
  /** Slug for the filename: `ain-invoices-2026-09-01.csv`. */
  name: string;
  noun: string;
  disabled?: boolean;
  /** Why it is unavailable, said in a sentence rather than left to guesswork. */
  reason?: string;
}) {
  const f = useFormat();
  const toast = useToast();
  const count = rows.length;
  const blocked = disabled || count === 0;
  const title = reason ?? (count === 0 ? `There is nothing to export — no ${noun} match the filters in force.` : undefined);

  const run = () => {
    const csv = toCsv(rows, columns);
    const stamp = fileStamp(f.now(), f.timeZone);
    const file = `ain-${name}-${stamp}.csv`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
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
      `Exported ${count} ${count === 1 ? noun.replace(/s$/, '') : noun}`,
      `${file} — the rows on screen, in the order they are shown, with every amount formatted as it reads here.`,
    );
  };

  return (
    <Button
      size="sm"
      variant="secondary"
      iconLeft={<Icons.download size={14} />}
      disabled={blocked}
      title={title}
      onClick={run}
    >
      Export
    </Button>
  );
}

/**
 * How many rows a DataTable is showing, computed with the grid's own rules.
 *
 * The footer has to quote the same number the operator can count, and the table
 * does not hand it out, so the search and the column filters are replayed here
 * against the same accessors the columns were defined with.
 */
export function visibleRows<T>(
  rows: T[],
  columns: { id: string; accessor?: (row: T) => CellValue; unsearchable?: boolean }[],
  view: TableState,
): T[] {
  const byId = new Map(columns.map((c) => [c.id, c]));
  const read = (row: T, columnId: string): CellValue => {
    const column = byId.get(columnId);
    if (column?.accessor) return column.accessor(row);
    const raw = (row as Record<string, unknown>)[columnId];
    return typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' || raw == null
      ? (raw as CellValue)
      : String(raw);
  };
  const searchable = columns.filter((c) => !c.unsearchable).map((c) => c.id);
  return searchRows(filterRows(rows, view.filters, read), view.query, searchable, read);
}

/* ---------------------------- money range filter -------------------------- */

export interface MoneyRange {
  /** Which figure the range is asked about. */
  field: string;
  currency: string;
  min: number | null;
  max: number | null;
}

export const EMPTY_RANGE: MoneyRange = { field: '', currency: '', min: null, max: null };
export const rangeActive = (r: MoneyRange): boolean => !!r.field && (r.min !== null || r.max !== null);

/** `total:usd:100000:` — short enough to live in the address bar unescaped. */
export function encodeRange(r: MoneyRange): string {
  return rangeActive(r) ? `${r.field}:${r.currency}:${r.min ?? ''}:${r.max ?? ''}` : '';
}

export function decodeRange(raw: string, fallbackCurrency: string): MoneyRange {
  const [field = '', currency = '', min = '', max = ''] = raw.split(':');
  if (!field) return EMPTY_RANGE;
  return {
    field,
    currency: currency || fallbackCurrency,
    min: min === '' ? null : Number(min),
    max: max === '' ? null : Number(max),
  };
}

export const matchesRange = (amount: number, currency: string, r: MoneyRange): boolean => {
  if (r.currency && currency.toLowerCase() !== r.currency.toLowerCase()) return false;
  if (r.min !== null && amount < r.min) return false;
  if (r.max !== null && amount > r.max) return false;
  return true;
};

/**
 * The currencies a book actually holds, and the one an amount filter should
 * open on.
 *
 * Alphabetical order picked EUR for a workspace that reads in dollars and
 * whose book is 80% dollars, so the first thing the filter did was hide almost
 * everything. The list stays alphabetical because that is where an operator
 * looks for a code; the default is the workspace's own currency when the book
 * has any of it, and otherwise whichever currency has the most rows.
 */
export function useCurrencyChoices<T>(rows: T[], currencyOf: (row: T) => string, fallback: string): {
  currencies: string[];
  preferred: string;
} {
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = currencyOf(row).toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (!counts.size) return { currencies: [fallback], preferred: fallback };
    const currencies = [...counts.keys()].sort();
    const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return { currencies, preferred: counts.has(fallback) ? fallback : busiest };
  }, [rows, currencyOf, fallback]);
}

/**
 * An amount filter that says what it means.
 *
 * Two things make a money range on a mixed-currency book meaningless, and both
 * are fixed here rather than explained away. The numbers are typed in major
 * units against a currency symbol, so "1,000" is a thousand dollars and not ten
 * of them. And the currency is part of the filter, because "between 1,000 and
 * 2,000" across dollars, euros and pounds is three different questions asked at
 * once and this platform has no exchange-rate table to settle them with.
 */
export function MoneyRangeFilter({ value, onChange, fields, currencies, defaultCurrency }: {
  value: MoneyRange;
  onChange: (next: MoneyRange) => void;
  fields: { value: string; label: string }[];
  currencies: string[];
  defaultCurrency: string;
}) {
  const f = useBillingFormat();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<MoneyRange>(value);
  useEffect(() => { if (open) setDraft(rangeActive(value) ? value : { ...EMPTY_RANGE, field: fields[0].value, currency: defaultCurrency }); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = rangeActive(value);
  const fieldLabel = fields.find((x) => x.value === value.field)?.label ?? 'Amount';
  // The code is on the chip because the symbol is not enough: "$1,000" is a
  // different question in three of the currencies this book holds, and the
  // filter has pinned exactly one of them.
  const code = value.currency.toUpperCase();
  const chip = active
    ? value.min !== null && value.max !== null
      ? `${fieldLabel} ${f.money(value.min, { currency: value.currency })}–${f.money(value.max, { currency: value.currency })} ${code}`
      : value.min !== null
        ? `${fieldLabel} ≥ ${f.money(value.min, { currency: value.currency })} ${code}`
        : `${fieldLabel} ≤ ${f.money(value.max as number, { currency: value.currency })} ${code}`
    : 'Amount';

  const apply = () => {
    onChange(draft.min === null && draft.max === null ? EMPTY_RANGE : draft);
    setOpen(false);
  };

  return (
    <>
      <Button
        ref={anchor}
        size="sm"
        variant={active ? 'primary' : 'secondary'}
        selected={active}
        iconLeft={<Icons.hash size={14} />}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        {chip}
      </Button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        placement="bottom-start"
        title="Filter by amount"
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }}
        footer={
          <Inline justify="between" gap={3}>
            <Button size="sm" variant="ghost" onClick={() => { onChange(EMPTY_RANGE); setOpen(false); }}>Clear</Button>
            <Button size="sm" variant="primary" onClick={apply}>Apply</Button>
          </Inline>
        }
      >
        <Stack gap={4} className="bl-amountfilter">
          <Field label="Figure">
            <Select
              size="sm"
              aria-label="Which amount"
              value={draft.field || fields[0].value}
              options={fields}
              onChange={(field) => setDraft((d) => ({ ...d, field }))}
            />
          </Field>
          <Field label="Currency" hint="Nothing is converted, so a range belongs to one book.">
            <Select
              size="sm"
              aria-label="Currency"
              value={draft.currency || defaultCurrency}
              options={currencies.map((c) => ({ value: c, label: c.toUpperCase() }))}
              onChange={(currency) => setDraft((d) => ({ ...d, currency }))}
            />
          </Field>
          <Inline gap={3}>
            {/*
              No `aria-label` on either field: one would override the visible
              label, and an accessible name that does not contain the words on
              screen is a name nobody can say out loud to a voice control.
            */}
            <Field label="From (smallest amount)">
              <MoneyField
                value={draft.min}
                onChange={(min) => setDraft((d) => ({ ...d, min }))}
                currency={draft.currency || defaultCurrency}
                placeholder="no minimum"
              />
            </Field>
            <Field label="To (largest amount)">
              <MoneyField
                value={draft.max}
                onChange={(max) => setDraft((d) => ({ ...d, max }))}
                currency={draft.currency || defaultCurrency}
                placeholder="no maximum"
              />
            </Field>
          </Inline>
        </Stack>
      </Popover>
    </>
  );
}

/* ------------------------------ dialog keyboard --------------------------- */

export interface DialogForm {
  /** Spread on the element wrapping the dialog's fields. */
  formProps: {
    ref: React.MutableRefObject<HTMLDivElement | null>;
    onKeyDown: (e: React.KeyboardEvent) => void;
  };
}

const FOCUSABLE = [
  'input:not([type="hidden"]):not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const SUBMIT_ON_ENTER = new Set(['INPUT']);

/**
 * A dialog an operator can finish without touching the mouse.
 *
 * Two defaults fight this. A modal traps focus on its first focusable child,
 * and that child is the Close button in the header — so the dialog opens with
 * focus on the one control that throws the work away: type and nothing lands,
 * press Enter and the dialog you just opened is gone. And Enter inside a lone
 * `<input>` submits nothing unless something wires it, so the house rule
 * "Enter submits" was true of no dialog in this module.
 *
 * Focus is therefore moved onto the first real field a frame after the trap has
 * placed it (the trap runs in a child effect, this one in the parent's, so this
 * lands last and wins), and Enter from any single-line field runs the primary
 * action — guarded by the same condition that disables the primary button, so
 * Enter can never commit what the button would have refused. Textareas,
 * selects, checkboxes and anything with an open listbox keep their own Enter.
 */
export function useDialogForm(open: boolean, canSubmit: boolean, onSubmit: () => void): DialogForm {
  const ref = useRef<HTMLDivElement | null>(null);
  const submit = useRef(onSubmit);
  submit.current = onSubmit;

  useEffect(() => {
    if (!open) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const root = ref.current;
        if (!root) return;
        const first = root.querySelector<HTMLElement>(FOCUSABLE);
        // Only take focus back from the header. If the operator has already
        // clicked into the form, leave them where they are.
        const active = document.activeElement;
        if (first && (!active || !root.contains(active))) first.focus({ preventScroll: true });
      });
    });
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
  }, [open]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (!el || !SUBMIT_ON_ENTER.has(el.tagName)) return;
    const type = (el as HTMLInputElement).type;
    if (type === 'checkbox' || type === 'radio' || type === 'button') return;
    if (el.getAttribute('aria-expanded') === 'true' || el.getAttribute('role') === 'combobox') return;
    e.preventDefault();
    if (canSubmit) submit.current();
  }, [canSubmit]);

  return { formProps: { ref, onKeyDown } };
}

/**
 * The wrapper the dialog's keyboard behaviour is bound to. It generates no box
 * of its own — it exists so the focus scan and the Enter handler have one node
 * that contains every field and none of the header chrome.
 */
export function DialogFields({ form, children }: { form: DialogForm; children: ReactNode }) {
  return (
    <div className="bl-dialogform" ref={form.formProps.ref} onKeyDown={form.formProps.onKeyDown}>
      {children}
    </div>
  );
}

/* -------------------------------- quantities ------------------------------ */

/**
 * A quantity that never disagrees with itself.
 *
 * The shared `NumberInput` commits on blur, which on a dialog that prices as
 * you type means the summary and the priced primary button keep quoting the
 * old number while the field shows the new one — and, worse, the stepper
 * increments the *committed* value, so typing 7 and pressing ArrowUp gives 2
 * and the 7 is discarded without a word. This one commits every keystroke and
 * steps from whatever the field currently reads.
 */
export function QuantityField({ value, onChange, min = 1, max = 1_000_000, label, disabled }: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  label: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(value));
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) { setText(String(value)); last.current = value; }
  }, [value]);

  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
  const commit = (next: number) => { last.current = next; onChange(next); };

  const type = (raw: string) => {
    setText(raw);
    const digits = raw.replace(/[^0-9]/g, '');
    if (digits === '') return;
    const next = clamp(Number(digits));
    if (next !== last.current) commit(next);
  };

  const nudge = (delta: number) => {
    const typed = Number(text.replace(/[^0-9]/g, ''));
    const base = Number.isFinite(typed) && text.trim() !== '' ? typed : last.current;
    const next = clamp(base + delta);
    setText(String(next));
    commit(next);
  };

  return (
    <Input
      type="text"
      inputMode="numeric"
      value={text}
      disabled={disabled}
      aria-label={label}
      role="spinbutton"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      wrapperClassName="ain-input--number"
      onChange={(e) => type(e.target.value)}
      onBlur={() => setText(String(last.current))}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') { e.preventDefault(); nudge(e.shiftKey ? 10 : 1); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(e.shiftKey ? -10 : -1); }
      }}
      suffix={
        <span className="ain-input__stepper">
          <button type="button" className="ain-input__step" tabIndex={-1} aria-label={`Increase ${label}`} disabled={disabled} onClick={() => nudge(1)}>
            <ChevronUpIcon size={11} />
          </button>
          <button type="button" className="ain-input__step" tabIndex={-1} aria-label={`Decrease ${label}`} disabled={disabled} onClick={() => nudge(-1)}>
            <ChevronDownIcon size={11} />
          </button>
        </span>
      }
    />
  );
}

/**
 * A quantity that is fixed by the price rather than chosen by the operator —
 * a flat fee sells one of itself, and a metered line is counted from usage.
 */
export function FixedQuantity({ label, why }: { label: string; why: string }) {
  return (
    <div className="bl-fixedqty" title={why} aria-label={`${label}: 1, ${why}`}>
      <span className="bl-fixedqty__value">1</span>
      <span className="bl-fixedqty__lock"><Icons.lock size={12} /></span>
    </div>
  );
}

/* ------------------------------- missing records -------------------------- */

/**
 * A record that is not there, told apart from a record that would not load.
 *
 * "Try again" on a 404 fails identically forever; the only useful control is
 * the way back to the list the operator came from.
 */
export function RecordMissing({ error, path, backTo, backLabel, noun, onRetry }: {
  error: ApiClientError;
  path: string;
  backTo: string;
  backLabel: string;
  noun: string;
  onRetry: () => void;
}) {
  if (error.status === 404) {
    // Only invoices are ever voided in this product. Offering "voided" as the
    // explanation for a missing customer or subscription is the sentence
    // reading as boilerplate on the two records where it cannot be true.
    const gone = noun === 'invoice'
      ? 'It may have been voided and removed, or the address may have been mistyped.'
      : `It may have been deleted, or the address may have been mistyped.`;
    return (
      <EmptyState
        title={`No such ${noun}`}
        // The server's sentence does not always end in one, and two sentences
        // run together read as one broken one.
        body={`${error.body.message.replace(/\s*\.?$/, '.')} ${gone}`}
        action={<Button variant="primary" href={backTo} iconLeft={<ChevronLeftIcon size={14} />}>{backLabel}</Button>}
      />
    );
  }
  return <SectionError error={error} path={path} onRetry={onRetry} />;
}
