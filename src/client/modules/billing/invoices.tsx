/**
 * Invoices: the book, one bill, and every way a finance team acts on it.
 *
 * Two things this screen refuses to hide. Every line can be expanded to the
 * per-tier arithmetic that produced its number — the same `breakdown` rows the
 * pricing engine emitted — and every tax figure carries the sentence that
 * explains it, including the reason behind a zero. And a credit note is priced
 * by `POST /v1/credit_notes/preview` before it is issued, which refuses an
 * over-credit rather than clamping it, so the refusal is on screen before the
 * operator commits rather than after.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, invalidate, useQuery, type ApiClientError, type ListEnvelope } from '../../kernel/api';
import { useNavigate, useParams, useSearchParam } from '../../kernel/router';
import { usePlatform } from '../../kernel/platform';
import { useCurrentCrumb } from '../../kernel/shell';
import {
  Badge, Banner, Button, Card, Checkbox, ConfirmDialog, DataTable, Divider, Drawer, EmptyState, Field, Grid,
  GridItem, Icons, Inline, Input, Modal, Page, Select, Stack, Tabs, Textarea, Tooltip, humanize, useToast,
  type DataTableColumn, type MenuSection, type TableState,
} from '../../design';
import { AlertTriangleIcon, ArrowUpRightIcon, CheckCircleIcon, ChevronDownIcon, ChevronUpIcon, CreditCardIcon, XCircleIcon } from '../../design';
import { ActionMenu, CreditDialog, CustomerPicker, Headline } from './subscriptions';
import { PaymentMethodDialog } from './payments';
import {
  BookFooter, DialogFields, EmptyList, ExportCsvButton, FieldRow, ListFailure, ListFooter, LoadFailedEmpty, Loading, MoneyField,
  MoneyRangeFilter, copyFormat, keepRowMenuKeys,
  MoneyTotals, RecordLink, RecordMissing, SectionError, StatusPill, TableSearch, breakdownLabel, decodeRange,
  encodeRange,
  formatUnitRate, invoiceStatusDetail, lineWhy, matchesRange, prorationCopy, rangeActive,
  statusLabel, customerHref, idem,
  invoiceClockNote, invoiceHref, moneyRank, subscriptionHref, totalsByCurrency, useAction, useBillingFormat, useBookList, useCurrencyChoices,
  csvAmount, csvDay, csvInstant, useBookTotal,
  useCursorList, useDebounced, useDialogForm, useOpenOnQuery, useRecord, useRecordTab, useTableView, visibleRows,
} from './common';
import { billedTotal, bulkSkipReason, coversNoPeriod, humaniseNote, invoiceActions, type BulkInvoiceKind } from './copy';
import type { CsvColumn } from './common';
import type {
  Charge, CreditNote, Customer, Invoice, InvoiceDunning, InvoiceLine, InvoicePayments, PaymentIntent, PaymentMethod,
  PaymentSettings, PendingItem, Refund,
} from './types';

/** Everything a payment moves, so one write refreshes every screen reading it. */
const INVALIDATE_MONEY = ['/v1/invoices', '/v1/customers', '/v1/subscriptions', '/v1/revenue', '/v1/payment_intents', '/v1/charges', '/v1/refunds', '/v1/dunning'];

/** The gateway's reasons for sending money back — the same list `POST /v1/refunds` validates. */
const REFUND_REASONS = ['requested_by_customer', 'duplicate', 'fraudulent', 'service_not_delivered', 'goodwill'] as const;

/** What a charge still has to give back — refunds and disputes both come off it. */
const refundable = (charge: Charge): number => charge.amount - charge.amount_refunded - charge.amount_disputed;
const canRefund = (charge: Charge): boolean => charge.status === 'succeeded' && refundable(charge) > 0;

/** The words for where a bill's service period is printed, when it has one. */
function coversText(invoice: Invoice): React.ReactNode {
  return coversNoPeriod(invoice)
    ? <span className="bl-muted">One-off — no service period</span>
    : invoice.period_display;
}

/**
 * The invoice book as a month-end file.
 *
 * Amounts are plain decimals in the major unit with the currency beside them,
 * dates are the UTC calendar days the documents carry, and the ids are here so
 * a reconciliation can be matched back rather than retyped.
 */
const INVOICE_CSV: CsvColumn<Invoice>[] = [
  { header: 'Number', value: (row) => row.number },
  { header: 'Account', value: (row) => row.customer_name ?? row.customer },
  { header: 'Status', value: (row) => statusLabel(row.status) },
  { header: 'Reason', value: (row) => humanize(row.billing_reason) },
  { header: 'Collection', value: (row) => humanize(row.collection_method) },
  { header: 'Currency', value: (row) => row.currency.toUpperCase() },
  { header: 'Subtotal', value: (row) => csvAmount(row.subtotal, row.currency) },
  { header: 'Tax', value: (row) => csvAmount(row.tax, row.currency) },
  { header: 'Total', value: (row) => csvAmount(billedTotal(row), row.currency) },
  { header: 'Balance applied', value: (row) => csvAmount(row.balance_applied, row.currency) },
  { header: 'Amount paid', value: (row) => csvAmount(row.amount_paid, row.currency) },
  { header: 'Amount due', value: (row) => csvAmount(row.amount_due, row.currency) },
  { header: 'Issued', value: (row) => csvDay(row.created) },
  { header: 'Due', value: (row) => csvDay(row.due_date) },
  { header: 'Paid at', value: (row) => csvInstant(row.paid_at) },
  { header: 'Period start', value: (row) => csvDay(row.period.start) },
  { header: 'Period end', value: (row) => csvDay(row.period.end) },
  { header: 'Customer id', value: (row) => row.customer },
  { header: 'Subscription id', value: (row) => row.subscription ?? '' },
  { header: 'Invoice id', value: (row) => row.id },
];

/** The "no method was presented" option, which is a real choice rather than an absence. */
const BY_HAND = 'by_hand';

/* ------------------------------- list columns ---------------------------- */

export function useInvoiceColumns(showCustomer = true): DataTableColumn<Invoice>[] {
  const f = useBillingFormat();
  return useMemo(() => {
    const columns: DataTableColumn<Invoice>[] = [
      {
        id: 'number',
        header: 'Invoice',
        pinned: true,
        width: 150,
        sortable: true,
        accessor: (row) => row.number,
        cell: (row) => (
          <div className="bl-cellstack">
            <RecordLink to={invoiceHref(row.id)}>{row.number}</RecordLink>
            <span className="bl-cellstack__sub">{humanize(row.billing_reason)}</span>
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        width: 130,
        filter: 'set',
        accessor: (row) => row.status,
        cell: (row) => <StatusPill status={row.status} title={invoiceStatusDetail(row, f)} />,
      },
    ];
    if (showCustomer) {
      columns.push({
        id: 'customer',
        header: 'Account',
        width: 220,
        accessor: (row) => row.customer_name ?? row.customer,
        cell: (row) => <RecordLink to={customerHref(row.customer)}>{row.customer_name ?? row.customer}</RecordLink>,
      });
    }
    columns.push(
      {
        id: 'period',
        header: 'Covers',
        width: 210,
        accessor: (row) => row.period.start,
        // A bill raised by hand covers no period; the engine stamps both ends
        // on the day it was raised, which reads as a one-day subscription.
        cell: (row) => <span className="bl-nowrap">{coversText(row)}</span>,
      },
      {
        id: 'currency',
        header: 'Currency',
        width: 100,
        filter: 'set',
        accessor: (row) => row.currency.toUpperCase(),
      },
      {
        id: 'total',
        header: 'Total',
        // The Columns menu and the filter list both label a checkbox with this
        // string, so it has to be the column's name. The reason the ranking is
        // grouped by currency is stated once, under the grid, where it is read
        // rather than hovered.
        headerTitle: 'Total',
        align: 'right',
        width: 120,
        sortable: true,
        // The bill as raised — lines plus tax. The API's `total` is what was
        // left after the account balance was drawn, which made a $106.53
        // invoice settled from credit read "$0.00" in this column.
        accessor: (row) => moneyRank(billedTotal(row), row.currency),
        cell: (row) => f.money(billedTotal(row), { currency: row.currency }),
        total: (rows) => <MoneyTotals totals={totalsByCurrency(rows, billedTotal, (r) => r.currency)} />,
      },
      {
        id: 'amount_due',
        header: 'Amount due',
        headerTitle: 'Amount due',
        align: 'right',
        width: 130,
        sortable: true,
        accessor: (row) => moneyRank(row.amount_due, row.currency),
        cell: (row) => (
          row.amount_due > 0
            ? <span className="bl-strong">{row.amount_due_display}</span>
            : <span className="bl-muted">{row.amount_due_display}</span>
        ),
        // One receivables figure per currency. Adding across three books would
        // need an exchange-rate table this platform does not have, and printing
        // "mixed currencies" left the AR screen unable to state any total.
        total: (rows) => <MoneyTotals totals={totalsByCurrency(rows, (r) => r.amount_due, (r) => r.currency)} />,
      },
      {
        id: 'due_date',
        header: 'Due',
        width: 140,
        sortable: true,
        filter: 'date',
        accessor: (row) => row.due_date ?? row.created,
        cell: (row) => (row.due_date === null ? <span className="bl-muted">on receipt</span> : f.day(row.due_date)),
      },
      {
        // The date on the document the customer holds. For a cycle invoice the
        // engine stamps it at the period's own 00:00 UTC boundary, so it is a
        // calendar date, not an instant — printing it in the workspace zone put
        // "May 21, 8:00 PM" against a document that says "issued May 22".
        id: 'created',
        header: 'Issued',
        width: 130,
        sortable: true,
        defaultHidden: true,
        accessor: (row) => row.created,
        cell: (row) => f.date(row.created),
      },
    );
    return columns;
  }, [f, showCustomer]);
}

/* ================================== list ================================== */

const currencyOfRow = (row: { currency: string }): string => row.currency;

export function InvoicesPage() {
  const f = useBillingFormat();
  const navigate = useNavigate();
  const toast = useToast();
  const [status, setStatus] = useSearchParam('status', 'all');
  const [reason, setReason] = useSearchParam('reason', '');
  const [customer, setCustomer] = useSearchParam('customer', '');
  const [tax, setTax] = useSearchParam('tax', '');
  const [view, setView] = useTableView({ columnId: 'created', direction: 'desc' });
  const [selected, setSelected] = useState<string[]>([]);
  const [billing, setBilling] = useState(false);
  // Every bulk write on this grid — void, mark paid, finalise — is confirmed
  // with each invoice named beside its own figures before it runs.
  const [bulk, setBulk] = useState<{ kind: BulkInvoiceKind; ids: string[] } | null>(null);
  const action = useAction();
  useOpenOnQuery('new', useCallback(() => setBilling(true), []));

  const [rangeParam, setRangeParam] = useSearchParam('amount', '');

  const search = useDebounced(view.query.trim(), 250);
  // The whole book, not its first page. Every figure this screen states —
  // the count, the receivables total, what an amount range matches — is an
  // answer about the filtered set, and it can only be one if the filtered set
  // is what the browser is holding.
  const book = useBookList<Invoice>('/v1/invoices', useMemo(() => ({
    status,
    ...(search ? { query: search } : {}),
    ...(customer ? { customer } : {}),
    ...(reason ? { billing_reason: reason } : {}),
    ...(tax ? { tax } : {}),
  }), [status, search, customer, reason, tax]));
  const columns = useInvoiceColumns(true);

  const { currencies, preferred } = useCurrencyChoices(book.rows, currencyOfRow, f.currency);
  const range = useMemo(() => decodeRange(rangeParam, preferred), [rangeParam, preferred]);

  const rows = useMemo(() => (rangeActive(range)
    ? book.rows.filter((row) => matchesRange(
      range.field === 'amount_due' ? row.amount_due : billedTotal(row), row.currency, range,
    ))
    : book.rows), [book.rows, range]);
  // The grid's own search and column filters, replayed so the footer can quote
  // the number of rows on screen instead of the number the server holds.
  // What the book holds with no filter at all. `book.total` is the count of the
  // *filtered* set, so measuring narrowing against it made every server filter
  // — status, reason, tax, account, the search box — describe itself as the
  // whole book, under totals that only covered the filtered part of it.
  const whole = useBookTotal('/v1/invoices', { status: 'all' });
  const visible = useMemo(() => visibleRows(rows, columns, view), [rows, columns, view]);
  const shown = visible.length;

  // The rows a bulk dialog is about — resolved from the book so it can print
  // each invoice's own figures rather than the ids it was handed.
  const bulkTargets = useMemo(
    () => rows.filter((row) => bulk?.ids.includes(row.id)),
    [rows, bulk],
  );

  /**
   * The same row menu the Customers and Subscriptions grids carry, built from
   * what the invoice's state allows rather than listing every action greyed.
   * Finalise runs here because it is safe and reversible by nothing worse than
   * a void; the money and the destruction go through the record's own dialogs.
   */
  const rowMenu = (row: Invoice): MenuSection[] => {
    const allowed = invoiceActions(row);
    return [{
      id: 'invoice',
      items: [
        { id: 'open', label: 'Open', icon: <ArrowUpRightIcon size={14} />, onSelect: () => navigate(invoiceHref(row.id)) },
        { id: 'customer', label: 'Open the account', icon: <Icons.wallet size={14} />, onSelect: () => navigate(customerHref(row.customer)) },
        ...(allowed.includes('finalize') ? [{
          id: 'finalize',
          label: 'Finalise this draft',
          icon: <Icons.check size={14} />,
          onSelect: () => {
            void action.run(
              api.post<Invoice>(`/v1/invoices/${row.id}/finalize`, {}),
              { success: `${row.number} finalised`, description: 'It is now owed and carries a due date.', failure: 'It could not be finalised' },
              ['/v1/invoices', '/v1/customers'],
            ).then(() => book.retry());
          },
        }] : []),
        ...(allowed.includes('pay') ? [{
          id: 'pay',
          label: 'Take a payment…',
          icon: <CheckCircleIcon size={14} />,
          onSelect: () => navigate(`${invoiceHref(row.id)}?pay=1`),
        }] : []),
        ...(allowed.includes('refund') ? [{
          id: 'refund',
          label: 'Refund a payment…',
          icon: <Icons.refresh size={14} />,
          onSelect: () => navigate(`${invoiceHref(row.id)}?tab=collection&refund=1`),
        }] : []),
        ...(allowed.includes('void') ? [{
          id: 'void',
          label: 'Void…',
          icon: <XCircleIcon size={14} />,
          danger: true,
          onSelect: () => setBulk({ kind: 'void', ids: [row.id] }),
        }] : []),
      ],
    }];
  };

  return (
    <Page
      title="Invoices"
      eyebrow="Revenue"
      subtitle="Every bill this workspace has raised, what it covers and what is still owed on it."
      actions={
        <Button variant="primary" iconLeft={<Icons.plus size={15} />} onClick={() => setBilling(true)}>
          Bill an account
        </Button>
      }
    >
      {book.error && <ListFailure error={book.error} path="GET /v1/invoices" onRetry={book.retry} />}
      <div className={book.loading ? 'bl-grid is-loading' : 'bl-grid'} onKeyDownCapture={keepRowMenuKeys}>
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        caption="Invoices"
        loading={book.loading}
        error={null}
        onRetry={book.retry}
        value={view}
        onChange={setView}
        initialSort={{ columnId: 'created', direction: 'desc' }}
        searchable={false}
        selectable
        selected={selected}
        onSelectionChange={setSelected}
        onRowClick={(row) => navigate(invoiceHref(row.id))}
        rowActions={rowMenu}
        maxHeight={640}
        stickyFooter
        toolbar={
          <Inline gap={3} wrap>
            <TableSearch view={view} onChange={setView} label="Search number, account or id" />
            <Select
              size="sm"
              aria-label="Status"
              value={status}
              onChange={(value) => { setStatus(value || undefined); setSelected([]); }}
              icon={<Icons.filter size={14} />}
              options={[
                { value: 'all', label: 'All invoices' },
                { value: 'open_like', label: 'Everything owed' },
                { value: 'draft', label: 'Drafts' },
                { value: 'open', label: 'Open' },
                { value: 'paid', label: 'Paid' },
                // The filter, the badge and the menu item that produces the
                // state all say the same word.
                { value: 'uncollectible', label: 'Written off' },
                { value: 'void', label: 'Voided' },
              ]}
            />
            <Select
              size="sm"
              aria-label="Billing reason"
              value={reason}
              onChange={(value) => setReason(value || undefined)}
              options={[
                { value: '', label: 'Any reason' },
                { value: 'subscription_cycle', label: 'Renewal' },
                { value: 'subscription_create', label: 'New subscription' },
                { value: 'subscription_update', label: 'Change' },
                { value: 'manual', label: 'Manual' },
              ]}
            />
            <Select
              size="sm"
              aria-label="Tax"
              value={tax}
              onChange={(value) => { setTax(value || undefined); setSelected([]); }}
              options={[
                { value: '', label: 'Any tax status' },
                // 0% means two different things on a bill, and only one of them
                // is fine. This is the queue for the other one.
                { value: 'missing', label: 'No tax location' },
                { value: 'charged', label: 'Tax charged' },
                { value: 'zero', label: 'Nothing due' },
              ]}
            />
            <div className="bl-acctfilter">
              <CustomerPicker
                value={customer}
                onChange={(value) => { setCustomer(value || undefined); setSelected([]); }}
                placeholder="Any account"
                emptyOption="Any account"
                size="sm"
                label="Account"
              />
            </div>
            <MoneyRangeFilter
              value={range}
              onChange={(next) => { setRangeParam(encodeRange(next) || undefined); setSelected([]); }}
              fields={[
                { value: 'total', label: 'Total' },
                { value: 'amount_due', label: 'Amount due' },
              ]}
              currencies={currencies}
              defaultCurrency={preferred}
            />
            <ExportCsvButton
              rows={visible}
              columns={INVOICE_CSV}
              name="invoices"
              noun="invoices"
              disabled={!book.complete}
              reason={book.complete ? undefined : 'Still reading the book — the file would hold fewer rows than the screen.'}
            />
          </Inline>
        }
        bulkActions={(ids) => (
          <Inline gap={3}>
            <Button size="sm" variant="secondary" onClick={() => setBulk({ kind: 'finalize', ids })}>Finalise {ids.length}</Button>
            <Button size="sm" variant="secondary" onClick={() => setBulk({ kind: 'pay', ids })}>
              Mark {ids.length} paid
            </Button>
            <Button size="sm" variant="danger-ghost" onClick={() => setBulk({ kind: 'void', ids })}>Void {ids.length}</Button>
          </Inline>
        )}
        empty={book.error
          ? <LoadFailedEmpty noun="invoices" />
          : (
            <EmptyList
              title="No invoice matches this filter"
              body="Bills are raised when a period opens, when a change is invoiced immediately, or when you bill an account by hand."
              action={<Button variant="primary" iconLeft={<Icons.plus size={15} />} onClick={() => setBilling(true)}>Bill an account</Button>}
            />
          )}
        footer={<BookFooter book={book} noun="invoices" shown={shown} whole={whole} />}
      />
      </div>
      <p className="bl-gridnote">
        Money columns are ranked and totalled inside each currency. There is no exchange-rate table in this
        platform, so nothing here is converted and no figure is added across two books.
      </p>
      <BillNowDialog open={billing} onClose={() => setBilling(false)} />
      {bulk && (
        <BulkInvoiceDialog
          kind={bulk.kind}
          invoices={bulkTargets}
          open
          onClose={() => setBulk(null)}
          onDone={() => { setBulk(null); setSelected([]); book.retry(); }}
        />
      )}
    </Page>
  );
}

/* ============================ bulk invoice writes ========================== */

const BULK_COPY: Record<BulkInvoiceKind, {
  title: (count: number, single: Invoice | null) => string;
  intro: string;
  confirm: (count: number) => string;
  done: string;
  tone: 'danger' | 'primary';
}> = {
  void: {
    title: (count, single) => (single ? `Void ${single.number}?` : `Void ${count} invoices?`),
    intro: 'Each is withdrawn and stops being owed. Anything it swept up goes back to be billed on a later invoice, and any recovery schedule chasing it stands down. There is no route that un-voids an invoice.',
    confirm: (count) => `Void ${count}`,
    done: 'Voided',
    tone: 'danger',
  },
  pay: {
    title: (count, single) => (single ? `Mark ${single.number} paid?` : `Mark ${count} invoices paid?`),
    intro: 'Records that the money arrived outside this platform — a transfer, a cheque, an offset — and settles each bill in full. Nothing is presented to a card.',
    confirm: (count) => `Mark ${count} paid`,
    done: 'Recorded payment on',
    tone: 'primary',
  },
  finalize: {
    title: (count, single) => (single ? `Finalise ${single.number}?` : `Finalise ${count} invoices?`),
    intro: 'Each draft becomes an open bill with a due date and starts being owed. A draft held by a paused subscription is released the same way.',
    confirm: (count) => `Finalise ${count}`,
    done: 'Finalised',
    tone: 'primary',
  },
};

/**
 * A bulk write on invoices, confirmed with every invoice's own figures.
 *
 * The old confirmation joined the numbers with one comma and the amounts with
 * another — "NR-000341, NR-000340 — £1,560.00 and $500.00" — which paired the
 * first number with the second amount, and quoted the full total of a bill
 * that was already part paid. This lists each invoice on its own row with what
 * is owed and what has been collected against it, says which of the selection
 * the action would refuse and why, and warns when voiding would orphan money
 * already taken.
 */
function BulkInvoiceDialog({ kind, invoices, open, onClose, onDone }: {
  kind: BulkInvoiceKind; invoices: Invoice[]; open: boolean; onClose: () => void; onDone: () => void;
}) {
  const f = useBillingFormat();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const copy = BULK_COPY[kind];
  const verdicts = useMemo(
    () => invoices.map((invoice) => ({ invoice, skip: bulkSkipReason(kind, invoice) })),
    [invoices, kind],
  );
  const targets = verdicts.filter((row) => row.skip === null).map((row) => row.invoice);
  const collectedOnTargets = kind === 'void' ? targets.filter((row) => row.amount_paid > 0) : [];
  const owed = totalsByCurrency(targets, (row) => row.amount_due, (row) => row.currency);
  const single = invoices.length === 1 ? invoices[0] : null;

  const submit = async () => {
    setBusy(true);
    let ok = 0;
    const refused: string[] = [];
    for (const invoice of targets) {
      try {
        await api.post(`/v1/invoices/${invoice.id}/${kind}`,
          kind === 'pay' ? { note: note.trim() || 'Recorded in bulk from the invoice list.' } : {});
        ok++;
      } catch {
        refused.push(invoice.number);
      }
    }
    setBusy(false);
    invalidate('/v1/invoices', '/v1/customers', '/v1/subscriptions', '/v1/revenue', '/v1/dunning');
    if (refused.length === 0) toast.success(`${copy.done} ${f.plural(ok, 'invoice')}`);
    else toast.warning(`${copy.done} ${ok} of ${targets.length}`, `Refused: ${f.list(refused)} — open each to see why.`, { duration: 0 });
    onDone();
  };

  const form = useDialogForm(open, targets.length > 0 && !busy, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={copy.title(invoices.length, single)}
      description={copy.intro}
      icon={copy.tone === 'danger' ? <AlertTriangleIcon size={18} /> : undefined}
      iconTone={copy.tone === 'danger' ? 'danger' : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={copy.tone} loading={busy} disabled={targets.length === 0} onClick={() => { void submit(); }}>
            {copy.confirm(targets.length)}
          </Button>
        </>
      }
    >
      <DialogFields form={form}>
      <Stack gap={5}>
        <div className="bl-tablewrap">
          <table className="bl-lines">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Account</th>
                <th className="bl-num">Owed</th>
                <th className="bl-num">Collected</th>
              </tr>
            </thead>
            <tbody>
              {verdicts.map(({ invoice, skip }) => (
                <tr key={invoice.id} className={skip ? 'bl-lines__row--skipped' : undefined}>
                  <td>
                    <div className="bl-cellstack">
                      <span className="bl-cellstack__top">{invoice.number}</span>
                      <span className="bl-cellstack__sub">{skip ?? statusLabel(invoice.status)}</span>
                    </div>
                  </td>
                  <td>{invoice.customer_name ?? invoice.customer}</td>
                  <td className="bl-num">{invoice.amount_due_display}</td>
                  <td className="bl-num">
                    {invoice.amount_paid > 0
                      ? f.money(invoice.amount_paid, { currency: invoice.currency })
                      : <span className="bl-muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {targets.length > 0 && kind !== 'finalize' && (
          <div className="bl-totals">
            <div className="bl-total bl-total--grand">
              <span className="bl-total__label">{kind === 'void' ? 'Stops being owed' : 'Recorded as collected'}</span>
              <span className="bl-total__value"><MoneyTotals totals={owed} /></span>
            </div>
          </div>
        )}
        {collectedOnTargets.length > 0 && (
          <Banner tone="warning" compact title={`${f.plural(collectedOnTargets.length, 'invoice')} already ${collectedOnTargets.length === 1 ? 'has' : 'have'} money collected`}>
            {`${f.list(collectedOnTargets.map((row) => `${row.number} (${f.money(row.amount_paid, { currency: row.currency })})`))} — voiding withdraws the bill but not the money, which stays on the account with no bill to belong to. If the intent is to give it back, refund or credit the invoice instead.`}
          </Banner>
        )}
        {targets.length === 0 && (
          <Banner tone="info" compact>
            {kind === 'void'
              ? 'Nothing selected can be voided — a settled bill is credited instead, and a voided one is already withdrawn.'
              : kind === 'pay'
                ? 'Nothing selected is owed, so there is nothing to record a payment against.'
                : 'Nothing selected is a draft, so there is nothing to finalise.'}
          </Banner>
        )}
        {kind === 'pay' && targets.length > 0 && (
          <Field label="How it was collected" optional hint="Recorded on every invoice in the list.">
            <Input
              value={note}
              maxLength={300}
              placeholder="Bank transfer received 5 September"
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        )}
      </Stack>
      </DialogFields>
    </Modal>
  );
}

/**
 * A pending line's explanation: the sentence on the line, the exact rational
 * behind the disclosure, exactly as the invoice's own lines print it.
 */
function PendingWhy({ item }: { item: PendingItem }) {
  const [open, setOpen] = useState(false);
  const why = prorationCopy(item.explanation ?? '', item.proration.denominator ? item.proration : null);
  const sentence = lineWhy(item.description, why.sentence);
  if (!sentence && !why.exact) return null;
  return (
    <>
      {sentence && <div className="bl-lines__why">{sentence}</div>}
      {why.exact && (
        <>
          <button type="button" className="bl-lines__toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />}
            {open ? 'Hide the arithmetic' : 'Show the arithmetic'}
          </button>
          {open && (
            <div className="bl-prorow__exact">
              {`Exactly ${why.exact.numerator} / ${why.exact.denominator} of the period in milliseconds`}
              {why.exact.reduced && ` — ${why.exact.reduced.numerator} / ${why.exact.reduced.denominator} in lowest terms`}
              .
            </div>
          )}
        </>
      )}
    </>
  );
}

export function BillNowDialog({ open, onClose, customer, subscription }: {
  open: boolean;
  onClose: () => void;
  customer?: string;
  /**
   * Opened from a subscription: the bill is raised against it, so it carries
   * the subscription's period and collection method — presented to the card
   * on a charge_automatically agreement — exactly as the menu item did before
   * it was routed through this dialog.
   */
  subscription?: string;
}) {
  const f = useBillingFormat();
  const navigate = useNavigate();
  const action = useAction();
  const [customerId, setCustomerId] = useState(customer ?? '');
  useEffect(() => { if (open) { setCustomerId(customer ?? ''); action.clear(); } }, [open, customer]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every other mutation in this module prices itself first. This one used to
  // be a coin flip: the same button gave one account a $1,275.42 invoice and
  // the next a 409, and which one you were about to get was only discoverable
  // by pressing it. These are the exact lines the invoice would sweep up.
  const pending = useQuery<ListEnvelope<PendingItem>>(
    customerId ? `/v1/customers/${customerId}/pending_items` : null,
    undefined,
    { enabled: open && !!customerId },
  );
  // The account carries the currency, and the dialog needs it even when there
  // is nothing pending to read one off.
  const account = useQuery<Customer>(customerId ? `/v1/customers/${customerId}` : null, undefined, { enabled: open && !!customerId });
  const items = pending.data?.data ?? [];
  const currency = items[0]?.currency ?? account.data?.currency ?? 'usd';
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  const nothing = !pending.loading && !pending.error && !!customerId && items.length === 0;
  const [oneOff, setOneOff] = useState(false);

  const submit = async () => {
    const invoice = await action.run(
      api.post<Invoice>('/v1/invoices', {
        customer: customerId,
        ...(subscription && customerId === customer ? { subscription } : {}),
      }, { idempotencyKey: idem() }),
      {
        success: 'Invoice raised',
        description: 'Every proration waiting, the usage already settled and the account balance are on it.',
        failure: 'Nothing could be billed',
      },
      ['/v1/invoices', '/v1/customers', '/v1/subscriptions'],
    );
    if (invoice) { onClose(); navigate(invoiceHref(invoice.id)); }
  };

  const form = useDialogForm(open, !!customerId && !nothing && !action.busy, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Bill what this account owes"
      description="The recurring fee is not billed again — that happened when the period opened. This sweeps up everything waiting on top of it."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={action.busy}
            disabled={!customerId || nothing}
            onClick={() => { void submit(); }}
          >
            {items.length ? `Raise the invoice · ${f.money(total, { currency })}` : 'Raise the invoice'}
          </Button>
        </>
      }
    >
      <DialogFields form={form}>
      <Stack gap={5}>
        <Field
          label="Customer"
          required
          error={action.errorFor('customer')}
          hint={account.data ? `Bills in ${account.data.currency.toUpperCase()}.` : undefined}
        >
          {/* Opened from an account, this field decides whose money is billed,
              so it shows the name — the same locked-field pattern the
              subscription dialog uses, rather than a raw `cus_…`. */}
          {customer
            ? (
              <div className="bl-lockedfield">
                <span className="bl-lockedfield__name">{account.data?.name ?? 'Reading the account…'}</span>
                <span className="bl-lockedfield__id u-mono">{customerId}</span>
              </div>
            )
            : <CustomerPicker value={customerId} onChange={setCustomerId} invalid={!!action.errorFor('customer')} />}
        </Field>

        {!customerId && (
          <EmptyState
            size="sm"
            inline
            illustration={null}
            title="Pick an account"
            body="Everything the next invoice would pick up is listed here before you raise it."
          />
        )}
        {customerId && pending.loading && <Loading label="Reading what is waiting…" />}
        {customerId && pending.error && (
          <SectionError error={pending.error} path={`GET /v1/customers/${customerId}/pending_items`} onRetry={pending.refetch} />
        )}
        {nothing && (
          <Banner tone="info" title="Nothing is waiting on this account">
            <div>
              No proration and no settled usage is unbilled here, so raising an invoice now would be refused.
              The recurring fee is billed when the next period opens. An invoice here only ever carries what a
              subscription has priced — there is no route that puts a hand-written line on one.
            </div>
            {/* Where a hand-written charge went. Without this the dialog says
                "nothing is waiting" straight after one was carried, and the
                money looks lost. */}
            {!!account.data && account.data.balance > 0 && (
              <div style={{ marginTop: 'var(--space-3)' }}>
                {`${f.money(account.data.balance, { currency: account.data.currency })} is carried on this account and comes off the next invoice raised for it — `}
                <RecordLink to={`${customerHref(customerId)}?tab=ledger`}>see the balance ledger</RecordLink>
                {'.'}
              </div>
            )}
            {/* A refusal that names no next move is a dead end. This platform
                bills a hand-written amount by carrying it on the account
                balance, which the next invoice draws down — so that is offered
                here, in the same dialog, rather than left to be found. It is
                named for what it does: the button used to say "Charge", and a
                balance debit raises no document and collects nothing today. */}
            <Inline gap={3} style={{ marginTop: 'var(--space-4)' }}>
              <Button size="sm" variant="secondary" iconLeft={<Icons.percent size={13} />} onClick={() => setOneOff(true)}>
                Adjust the balance instead…
              </Button>
            </Inline>
          </Banner>
        )}
        {items.length > 0 && (
          <Stack gap={4}>
            <div className="bl-tablewrap">
              <table className="bl-lines">
                <thead>
                  <tr><th>What would be billed</th><th>Period</th><th className="bl-num">Amount</th></tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className={item.amount < 0 ? 'bl-lines__row--credit' : undefined}>
                      <td>
                        <div>{item.description}</div>
                        {/* The server's explanation carries both halves — the
                            sentence and the unreduced rational behind it. The
                            sentence belongs on the line; a ten-digit fraction
                            printed inline is how a bill starts reading like a
                            stack trace, so it goes where the invoice lines put
                            it, behind the same disclosure. */}
                        <PendingWhy item={item} />
                      </td>
                      <td className="bl-nowrap">{f.dayRange(item.period.start, item.period.end)}</td>
                      <td className="bl-num">{f.money(item.amount, { currency: item.currency })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="bl-totals">
              <div className="bl-total bl-total--grand">
                <span className="bl-total__label">{f.plural(items.length, 'line')} before tax</span>
                <span className="bl-total__value">{f.money(total, { currency })}</span>
              </div>
            </div>
            <div className="bl-sub">
              Tax and the account balance are applied when the bill is raised, so the total on the invoice may differ from this subtotal.
            </div>
            <Inline gap={3}>
              <Button size="sm" variant="ghost" iconLeft={<Icons.percent size={13} />} onClick={() => setOneOff(true)}>
                Adjust the balance first…
              </Button>
            </Inline>
          </Stack>
        )}
      </Stack>
      </DialogFields>
      {customerId && (
        <CreditDialog
          customer={customerId}
          currency={currency}
          open={oneOff}
          onClose={() => { setOneOff(false); pending.refetch(); account.refetch(); }}
          initialDirection="debit"
          description={'A debit here is carried on the account balance, not charged: the next invoice raised for this '
            + 'account draws it down as a line of its own, and the reason you type shows on the balance ledger. Nothing '
            + 'is presented to a card and no document is raised today.'}
        />
      )}
    </Modal>
  );
}

/* ============================== bulk billing ============================== */

/** What one account would be billed if the bulk action ran, or why it would not. */
interface AccountPreview {
  customer: Customer;
  items: PendingItem[] | null;
  error: ApiClientError | null;
}

/**
 * Billing several accounts at once, priced per account before anything runs.
 *
 * "Bill 3 accounts" used to post three invoices on the click and report
 * "Raised 0 of 3" afterwards — the refusal arriving after the attempt, for a
 * write whose outcome was knowable beforehand. This reads what each account
 * has waiting, names the lines and the subtotal it would be billed, says which
 * accounts have nothing and will be left alone, and only then offers to raise
 * the invoices that would actually be raised.
 */
export function BulkBillDialog({ customers, open, onClose, onDone }: {
  customers: Customer[]; open: boolean; onClose: () => void; onDone: (raised: Invoice[]) => void;
}) {
  const f = useBillingFormat();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [previews, setPreviews] = useState<Record<string, AccountPreview>>({});
  const ids = useMemo(() => customers.map((row) => row.id), [customers]);
  const idsKey = ids.join(',');

  useEffect(() => {
    if (!open) return;
    let live = true;
    setPreviews(Object.fromEntries(customers.map((row) => [row.id, { customer: row, items: null, error: null }])));
    for (const customer of customers) {
      api.get<ListEnvelope<PendingItem>>(`/v1/customers/${customer.id}/pending_items`)
        .then((page) => { if (live) setPreviews((rows) => ({ ...rows, [customer.id]: { customer, items: page.data, error: null } })); })
        .catch((e: ApiClientError) => { if (live) setPreviews((rows) => ({ ...rows, [customer.id]: { customer, items: null, error: e } })); });
    }
    return () => { live = false; };
  }, [open, idsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = ids.map((id) => previews[id]).filter((row): row is AccountPreview => !!row);
  const reading = rows.some((row) => row.items === null && row.error === null);
  const billable = rows.filter((row) => (row.items?.length ?? 0) > 0);
  const totals = totalsByCurrency(
    billable.flatMap((row) => row.items ?? []),
    (item) => item.amount,
    (item) => item.currency,
  );

  const submit = async () => {
    setBusy(true);
    const raised: Invoice[] = [];
    const refused: string[] = [];
    for (const row of billable) {
      try {
        raised.push(await api.post<Invoice>('/v1/invoices', { customer: row.customer.id }, { idempotencyKey: idem() }));
      } catch {
        refused.push(row.customer.name);
      }
    }
    setBusy(false);
    invalidate('/v1/invoices', '/v1/customers', '/v1/subscriptions');
    if (refused.length === 0) {
      toast.success(
        `Raised ${f.plural(raised.length, 'invoice')}`,
        raised.length === 1 ? `${raised[0].number} is open and carries its due date.` : 'Each is open and carries its due date.',
      );
    } else {
      toast.warning(`Raised ${raised.length} of ${billable.length}`, `Refused for ${f.list(refused)} — open the account to see why.`, { duration: 0 });
    }
    onDone(raised);
    if (raised.length === 1) navigate(invoiceHref(raised[0].id));
  };

  const form = useDialogForm(open, billable.length > 0 && !reading && !busy, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={`Bill ${f.plural(customers.length, 'account')}`}
      description="The recurring fee is not billed again — that happened when each period opened. This sweeps up what is waiting on each account, and skips the ones with nothing."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={reading || billable.length === 0} onClick={() => { void submit(); }}>
            {reading
              ? 'Reading what is waiting…'
              : billable.length === 0
                ? 'Nothing to raise'
                : `Raise ${f.plural(billable.length, 'invoice')} · ${f.list(totals.map((total) => f.money(total.amount, { currency: total.currency })))}`}
          </Button>
        </>
      }
    >
      <DialogFields form={form}>
      <Stack gap={5}>
        <div className="bl-tablewrap">
          <table className="bl-lines">
            <thead>
              <tr><th>Account</th><th>What would be billed</th><th className="bl-num">Before tax</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const items = row.items ?? [];
                const subtotal = items.reduce((sum, item) => sum + item.amount, 0);
                return (
                  <tr key={row.customer.id} className={row.items !== null && items.length === 0 ? 'bl-lines__row--skipped' : undefined}>
                    <td>{row.customer.name}</td>
                    {row.error && (
                      <td colSpan={2} className="bl-sub">{`Could not be read — ${row.error.body.message}`}</td>
                    )}
                    {!row.error && row.items === null && <td colSpan={2} className="bl-sub">Reading what is waiting…</td>}
                    {!row.error && row.items !== null && items.length === 0 && (
                      <td colSpan={2} className="bl-sub">Nothing waiting — no invoice will be raised for this account</td>
                    )}
                    {!row.error && items.length > 0 && (
                      <>
                        <td>
                          <div>{f.plural(items.length, 'line')}</div>
                          <div className="bl-lines__why">{f.list(items.slice(0, 3).map((item) => item.description))}{items.length > 3 ? ` and ${items.length - 3} more` : ''}</div>
                        </td>
                        <td className="bl-num">{f.money(subtotal, { currency: row.customer.currency })}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!reading && billable.length === 0 && (
          <Banner tone="info" compact>
            None of these accounts has a proration or settled usage waiting, so no invoice can be raised for them now.
            Their recurring fees are billed when their next periods open.
          </Banner>
        )}
        {billable.length > 0 && (
          <div className="bl-sub">
            Tax and each account balance are applied when the bills are raised, so the totals on the invoices may differ from these subtotals.
          </div>
        )}
      </Stack>
      </DialogFields>
    </Modal>
  );
}

/* ================================= detail ================================= */

const INVOICE_TABS = ['lines', 'collection', 'credits', 'document'] as const;

export function InvoiceDetailPage() {
  const { id } = useParams();
  const f = useBillingFormat();
  const navigate = useNavigate();
  const action = useAction();
  const platform = usePlatform(true);
  const [rawTab, setTab] = useRecordTab(INVOICE_TABS, 'lines');
  const toast = useToast();
  const [dialog, setDialog] = useState<null | 'pay' | 'credit' | 'refund'>(null);
  const [refundCharge, setRefundCharge] = useState<Charge | null>(null);
  const [destroy, setDestroy] = useState<null | 'void' | 'uncollectible'>(null);
  const [docOpen, setDocOpen] = useState(false);
  // Reached from a list row: `?pay=1` opens the payment dialog, `?refund=1`
  // the refund dialog, once the record is on screen.
  useOpenOnQuery('pay', useCallback(() => setDialog('pay'), []));
  useOpenOnQuery('refund', useCallback(() => { setRefundCharge(null); setDialog('refund'); }, []));

  const { data: invoice, error, loading, refetch } = useRecord<Invoice>(`/v1/invoices/${id}`);
  const notes = useQuery<ListEnvelope<CreditNote>>('/v1/credit_notes', { invoice: id, status: 'all', limit: 50 });
  useCurrentCrumb(invoice?.number);

  if (loading) return <Page title="Invoice"><Loading label="Loading this invoice…" /></Page>;
  if (error || !invoice) {
    return (
      <Page title="Invoice" eyebrow="Revenue">
        <Card>
          <RecordMissing
            error={error ?? ({ status: 404, body: { message: `No invoice with the id ${id}.` } } as ApiClientError)}
            path={`GET /v1/invoices/${id}`}
            onRetry={refetch}
            noun="invoice"
            backTo="/billing/invoices"
            backLabel="Back to invoices"
          />
        </Card>
      </Page>
    );
  }

  const act = (path: string, copy: { success: string; description?: string; failure: string }) => {
    void action.run(api.post<Invoice>(path, {}), copy, ['/v1/invoices', '/v1/customers', '/v1/subscriptions']);
  };

  // Why the money button is closed, in the house voice, so the disabled state
  // is a closed door rather than a dead control.
  const payBlocked = invoice.status === 'void'
    ? `${invoice.number} was withdrawn, so there is nothing left to collect on it.`
    : invoice.status === 'draft'
      ? `Finalise it first — a draft is not owed yet, so nothing can be collected against it.`
      : invoice.amount_due <= 0
      ? invoice.paid_at
        ? `Nothing left to collect — ${invoice.number} was settled ${f.day(invoice.paid_at, { withYear: true })}.`
        : `Nothing is owed on ${invoice.number}, so there is nothing to record against it.`
      : null;

  const hasPayments = platform.serves('GET', '/v1/invoices/:id/payments');
  const tab = rawTab === 'collection' && !hasPayments ? 'lines' : rawTab;
  const canCollect = platform.serves('POST', '/v1/invoices/:id/retry') && invoice.status === 'open' && invoice.amount_due > 0;
  /**
   * The destructive pair sits last, behind a separator and behind a confirm.
   *
   * A menu opens with focus on its first enabled item, so a receivable used to
   * be one Enter away from being voided — and there is no un-void route. The
   * safe actions lead; voiding and writing off name the invoice, the amount and
   * the account before they run, the way the credit-note void already does.
   */
  // Only what this bill's state allows. The menu used to list every action on
  // every invoice and grey the rest — "Finalise this draft" on a paid bill,
  // "Void" on a voided one — with nothing to say why; Stripe hides them.
  const allowed = invoiceActions(invoice);
  const moneyItems: MenuSection['items'] = [
    ...(allowed.includes('credit') ? [{ id: 'credit', label: 'Issue a credit note…', icon: <Icons.receipt size={14} />, onSelect: () => setDialog('credit') }] : []),
    // Money that has been collected can be sent back. The route exists,
    // the Collection tab renders refunds — the menu never offered one.
    ...(hasPayments && allowed.includes('refund') ? [{
      id: 'refund',
      label: 'Refund a payment…',
      icon: <Icons.refresh size={14} />,
      onSelect: () => { setRefundCharge(null); setDialog('refund'); },
    }] : []),
    ...(canCollect ? [{
      id: 'collect',
      label: 'Present it for collection now',
      icon: <CreditCardIcon size={14} />,
      onSelect: () => act(`/v1/invoices/${invoice.id}/retry`, {
        success: 'Presented for collection',
        description: 'The attempt is recorded against the recovery campaign like any other.',
        failure: 'The collection attempt failed',
      }),
    }] : []),
  ];
  const statusItems: MenuSection['items'] = [
    ...(allowed.includes('finalize') ? [{
      id: 'finalize',
      label: 'Finalise this draft',
      icon: <Icons.check size={14} />,
      onSelect: () => act(`/v1/invoices/${invoice.id}/finalize`, { success: 'Invoice finalised', description: 'It is now owed and carries a due date.', failure: 'It could not be finalised' }),
    }] : []),
    ...(allowed.includes('void') ? [{
      id: 'void',
      label: 'Void this invoice…',
      icon: <XCircleIcon size={14} />,
      danger: true,
      onSelect: () => setDestroy('void'),
    }] : []),
    ...(allowed.includes('uncollectible') ? [{
      id: 'uncollectible',
      label: 'Write it off…',
      icon: <AlertTriangleIcon size={14} />,
      danger: true,
      onSelect: () => setDestroy('uncollectible'),
    }] : []),
  ];
  const sections: MenuSection[] = [
    ...(moneyItems.length ? [{ id: 'money', label: 'Money', items: moneyItems }] : []),
    {
      id: 'doc',
      label: 'Document',
      items: [
        { id: 'preview', label: 'Open the printable document', icon: <Icons.receipt size={14} />, onSelect: () => setDocOpen(true) },
        {
          id: 'print',
          label: 'Print or save as PDF',
          icon: <Icons.print size={14} />,
          onSelect: () => printDocument(invoice, () => toast.error(
            'The document could not be opened',
            'The browser blocked the new window. Allow pop-ups for this site, or open the document in a tab and print from there.',
            { duration: 0 },
          )),
        },
        { id: 'tab', label: 'Open it in a new tab', icon: <Icons.external size={14} />, onSelect: () => window.open(`/api${invoice.document_url}`, '_blank', 'noopener') },
      ],
    },
    ...(statusItems.length ? [{ id: 'status', label: 'Change the status', items: statusItems }] : []),
  ];

  return (
    <Page
      title={invoice.number}
      eyebrow="Invoice"
      badge={<span style={{ marginLeft: 'var(--space-4)' }}><StatusPill status={invoice.status} title={invoiceStatusDetail(invoice, f)} /></span>}
      subtitle={invoiceStatusDetail(invoice, f)}
      actions={
        <Inline gap={3}>
          {/* The bulk bar exposes Finalise and Void as first-class buttons on
              twenty invoices; hiding the same decision behind an icon-only
              overflow on one is the surface contradicting itself. Whichever
              status change applies to *this* bill stands in the open, and the
              rest stay in the menu. */}
          {invoice.status === 'draft' && (
            <Button
              variant="secondary"
              iconLeft={<Icons.check size={15} />}
              loading={action.busy}
              onClick={() => act(`/v1/invoices/${invoice.id}/finalize`, { success: 'Invoice finalised', failure: 'It could not be finalised' })}
            >
              Finalise
            </Button>
          )}
          {invoice.status === 'open' && (
            <Button variant="danger-ghost" iconLeft={<XCircleIcon size={15} />} onClick={() => setDestroy('void')}>
              Void…
            </Button>
          )}
          <Button variant="secondary" iconLeft={<Icons.print size={15} />} onClick={() => setDocOpen(true)}>Document</Button>
          <Button
            variant="primary"
            iconLeft={<CheckCircleIcon size={15} />}
            disabled={!!payBlocked}
            // Every other refusal on this surface explains itself in a
            // sentence. A greyed button with no reason reads as broken.
            title={payBlocked ?? undefined}
            onClick={() => setDialog('pay')}
          >
            Take a payment
          </Button>
          <ActionMenu sections={sections} label="More invoice actions" />
        </Inline>
      }
      tabs={
        <Tabs
          aria-label="Invoice sections"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'lines', label: 'Lines and totals' },
            ...(hasPayments ? [{ id: 'collection' as const, label: 'Collection' }] : []),
            { id: 'credits', label: 'Credit notes', count: notes.data?.data.length ?? 0 },
            { id: 'document', label: 'Document' },
          ]}
        />
      }
    >
      <Stack gap={6}>
        <Card>
          <div className="bl-headline">
            {/* What was billed — lines plus tax — not the API's `total`, which
                has the account balance already taken off it and read "$0.00"
                over a bill the balance settled. */}
            <Headline label="Total" value={f.money(billedTotal(invoice), { currency: invoice.currency })} caption={coversText(invoice)} />
            <Headline
              label="Amount due"
              value={invoice.amount_due_display}
              caption={
                invoice.amount_due <= 0
                  ? (invoice.paid_at ? `Settled ${f.day(invoice.paid_at, { withYear: true })}` : 'Nothing is owed on it')
                  : invoice.due_date ? `Due ${f.day(invoice.due_date)}` : 'Payable on receipt'
              }
            />
            <Headline
              label="Collected"
              value={f.money(invoice.amount_paid, { currency: invoice.currency })}
              caption={invoice.paid_at
                // The one figure on this card that is about the operator's day
                // rather than the document's, so it is the one that carries a
                // clock and names the zone — in the same words the Details
                // block uses for the same kind of instant.
                ? invoiceClockNote(invoice.paid_at, f)
                : invoice.amount_paid > 0 ? 'Part paid — the rest is still owed' : 'Nothing collected yet'}
            />
            <Headline
              label="Account"
              value={<RecordLink to={customerHref(invoice.customer)}>{invoice.customer_name ?? invoice.customer}</RecordLink>}
              caption={invoice.subscription ? <RecordLink to={subscriptionHref(invoice.subscription)}>On a subscription</RecordLink> : 'Raised by hand'}
            />
          </div>
        </Card>

        {!invoice.reconciles && (
          <Banner tone="danger" title="This invoice does not reconcile">
            Its lines no longer add up to its total. That is a bug worth reporting with the invoice id.
          </Banner>
        )}
        {/* The Collection tab tells this story in full, so the one-line
            version stands down rather than repeating itself above it. */}
        {invoice.payment_note && tab !== 'collection' && (
          <Banner tone="info" compact title="How it was collected">
            {humaniseNote(invoice.payment_note, copyFormat(f))}
            {/* The gateway writes its own note and names the charge in it. The
                place that explains a charge is the Collection tab, so the note
                points at it rather than leaving an id to be searched for. */}
            {/ch_[A-Za-z0-9]+/.test(invoice.payment_note) && hasPayments && (
              <>
                {' '}
                <button type="button" className="bl-lines__toggle" onClick={() => setTab('collection')}>
                  See every presentation
                </button>
              </>
            )}
          </Banner>
        )}

        {tab === 'lines' && <LinesTab invoice={invoice} />}
        {tab === 'collection' && hasPayments && (
          <CollectionTab
            invoice={invoice}
            onRetry={() => act(`/v1/invoices/${invoice.id}/retry`, {
              success: 'Presented for collection',
              description: 'The attempt is recorded against the recovery campaign like any other.',
              failure: 'The collection attempt failed',
            })}
            onRefund={(charge) => { setRefundCharge(charge); setDialog('refund'); }}
            busy={action.busy}
          />
        )}
        {tab === 'credits' && (
          <CreditNotesTab
            invoice={invoice}
            notes={notes.data?.data ?? []}
            loading={notes.loading}
            error={notes.error}
            onRetry={notes.refetch}
            onIssue={() => setDialog('credit')}
          />
        )}
        {tab === 'document' && <DocumentCard invoice={invoice} />}
      </Stack>

      <RecordPaymentDialog invoice={invoice} open={dialog === 'pay'} onClose={() => setDialog(null)} />
      <CreditNoteDialog invoice={invoice} open={dialog === 'credit'} onClose={() => setDialog(null)} />
      {hasPayments && (
        <RefundDialog
          invoice={invoice}
          charge={refundCharge}
          open={dialog === 'refund'}
          onClose={() => { setDialog(null); setRefundCharge(null); }}
        />
      )}
      <ConfirmDialog
        open={destroy !== null}
        onCancel={() => setDestroy(null)}
        loading={action.busy}
        title={destroy === 'uncollectible' ? `Write off ${invoice.number}?` : `Void ${invoice.number}?`}
        body={destroy === 'uncollectible'
          ? `${invoice.amount_due_display} owed by ${invoice.customer_name ?? invoice.customer} stops being chased and is `
            + 'recognised as a loss. The bill stays on the books and stays owed — it is simply not going to be collected. '
            + 'There is no route that un-writes it off.'
          : `${f.money(billedTotal(invoice), { currency: invoice.currency })} billed to ${invoice.customer_name ?? invoice.customer} is withdrawn. `
            + `${invoice.amount_due > 0 ? `${invoice.amount_due_display} stops being owed, ` : ''}`
            + 'anything it swept up goes back to be billed on a later invoice, and any recovery schedule chasing it stands down. '
            + 'There is no route that un-voids an invoice.'}
        confirmLabel={destroy === 'uncollectible' ? 'Write it off' : 'Void this invoice'}
        onConfirm={() => {
          const kind = destroy;
          setDestroy(null);
          if (kind === 'void') {
            act(`/v1/invoices/${invoice.id}/void`, { success: `${invoice.number} voided`, description: 'What it claimed went back to be billed properly.', failure: 'It could not be voided' });
          } else if (kind === 'uncollectible') {
            act(`/v1/invoices/${invoice.id}/mark_uncollectible`, { success: `${invoice.number} written off`, description: 'It stays billed; it is simply not going to be collected.', failure: 'It could not be written off' });
          }
        }}
      />
      <Drawer
        open={docOpen}
        onClose={() => setDocOpen(false)}
        size="xl"
        title={`${invoice.number} — the document the customer receives`}
        description="Rendered by the server from the same invoice record, with nothing to fetch and no script to run."
        actions={
          <Inline gap={3}>
            <Button size="sm" variant="secondary" iconLeft={<Icons.external size={14} />} href={`/api${invoice.document_url}`} target="_blank" rel="noopener">
              New tab
            </Button>
          </Inline>
        }
      >
        <InvoiceDocument invoice={invoice} tall />
      </Drawer>
    </Page>
  );
}

/**
 * What was actually attempted against this bill.
 *
 * The invoice says how much is owed; this says why it has not been collected —
 * the issuer's own words on every declined attempt, the risk it was scored at,
 * what has since been refunded or disputed and when the recovery campaign will
 * try again. Chasing a failing account from anywhere else means guessing.
 */
function CollectionTab({ invoice, onRetry, onRefund, busy }: {
  invoice: Invoice; onRetry: () => void; onRefund: (charge: Charge) => void; busy: boolean;
}) {
  const f = useBillingFormat();
  const navigate = useNavigate();
  const { data, error, loading, refetch } = useQuery<InvoicePayments>(`/v1/invoices/${invoice.id}/payments`);
  // A charge names its method by id. The account's methods are read once so
  // every row can say "Visa ending 4242" instead of `pm_card_meridianfo`.
  const methods = useQuery<ListEnvelope<PaymentMethod>>(`/v1/customers/${invoice.customer}/payment_methods`);
  const methodName = useMemo(() => {
    const map = new Map<string, string>();
    for (const method of methods.data?.data ?? []) map.set(method.id, method.display_name);
    return (id: string | null): string | null => (id ? map.get(id) ?? (methods.data ? 'a method since removed from the account' : null) : null);
  }, [methods.data]);
  const money = (amount: number) => f.money(amount, { currency: invoice.currency });

  if (error) return <Card><SectionError error={error} path={`GET /v1/invoices/${invoice.id}/payments`} onRetry={refetch} /></Card>;
  if (loading || !data) return <Card><Loading label="Reading every attempt against this bill…" /></Card>;

  const failed = data.charges.filter((charge) => charge.status !== 'succeeded');

  return (
    <div className="bl-cols">
      <Stack gap={6}>
        <Card
          title="Attempts"
          description={data.charges.length ? 'Every presentation of this bill, newest last, with what the issuer said.' : undefined}
          actions={
            <Button
              size="sm"
              variant={data.collectable ? 'primary' : 'secondary'}
              disabled={!data.collectable}
              loading={busy}
              iconLeft={<CreditCardIcon size={13} />}
              onClick={onRetry}
            >
              Present for collection
            </Button>
          }
        >
          {!data.collectable && <Banner tone="info" compact>{data.collectable_note}</Banner>}
          {data.charges.length === 0 && (
            <EmptyState
              size="sm"
              inline
              illustration={null}
              // "Nothing has been presented" is about charge records, and a
              // recovery schedule can have refused attempts that never produced
              // one. Saying both, rather than contradicting the card beside it.
              title={data.dunning && data.dunning.attempt_count > 0
                ? 'No charge is recorded against this bill'
                : 'Nothing has been presented yet'}
              body={data.dunning && data.dunning.attempt_count > 0
                ? `${data.summary} The recovery schedule has tried ${f.plural(data.dunning.attempt_count, 'time')} — every attempt is listed under Recovery with what the issuer said.`
                : data.summary}
              action={data.collectable
                ? <Button size="sm" variant="primary" loading={busy} onClick={onRetry}>Present it for collection</Button>
                : undefined}
            />
          )}
          {data.charges.map((charge) => (
            <ChargeRow key={charge.id} charge={charge} method={methodName(charge.payment_method)} onRefund={canRefund(charge) ? () => onRefund(charge) : undefined} />
          ))}
        </Card>

        {data.payment_intents.length > 0 && (
          <Card
            title="Payments"
            description="Each instruction raised against this bill and what state it is in — including the two that are usually hidden."
          >
            {data.payment_intents.map((intent) => (
              <IntentRow key={intent.id} intent={intent} number={data.number} onChanged={refetch} />
            ))}
          </Card>
        )}

        {data.disputes.length > 0 && (
          <Card title="Disputes" description="Money the customer has asked their bank to take back.">
            {data.disputes.map((dispute) => (
              <div key={dispute.id} className="bl-row">
                <div className="bl-row__main">
                  <div className="bl-row__title">{humanize(dispute.reason)}</div>
                  <div className="bl-row__sub">
                    {dispute.outcome_note
                      ?? (dispute.evidence_due_by ? `Evidence is due by ${f.date(dispute.evidence_due_by, { withYear: true })}.` : 'No deadline was set for evidence.')}
                  </div>
                </div>
                <div className="bl-row__aside">
                  <div>{f.money(dispute.amount, { currency: dispute.currency })}</div>
                  <div className="bl-sub"><StatusPill status={dispute.status} /></div>
                </div>
              </div>
            ))}
          </Card>
        )}

        {data.refunds.length > 0 && (
          <Card title="Refunds" description="Money sent back against this bill. A refund moves cash; it does not rewrite what was billed — that is a credit note.">
            {data.refunds.map((refund) => (
              <div key={refund.id} className="bl-row">
                <div className="bl-row__main">
                  <div className="bl-row__title">
                    {humanize(refund.reason ?? 'refund')}
                    {refund.description ? ` · ${refund.description}` : ''}
                  </div>
                  {refund.invoice_effect && <div className="bl-row__sub">{refund.invoice_effect}</div>}
                  <div className="bl-row__sub">{f.dateTime(refund.created)}</div>
                </div>
                <div className="bl-row__aside">
                  <div>{f.money(refund.amount, { currency: refund.currency })}</div>
                  <div className="bl-sub"><StatusPill status={refund.status} /></div>
                </div>
              </div>
            ))}
          </Card>
        )}
      </Stack>

      <Stack gap={6}>
        <Card title="Where the money stands">
          <Banner tone={data.amount_due > 0 ? 'warning' : 'success'} compact>{data.summary}</Banner>
          <div className="bl-totals" style={{ marginTop: 'var(--space-5)' }}>
            <div className="bl-total"><span className="bl-total__label">Billed</span><span className="bl-total__value">{money(data.total)}</span></div>
            <div className="bl-total"><span className="bl-total__label">Collected</span><span className="bl-total__value">{money(data.cash_collected)}</span></div>
            {data.amount_refunded > 0 && (
              <div className="bl-total"><span className="bl-total__label">Refunded</span><span className="bl-total__value">{money(data.amount_refunded)}</span></div>
            )}
            {data.amount_disputed > 0 && (
              <div className="bl-total"><span className="bl-total__label">Held by a dispute</span><span className="bl-total__value">{money(data.amount_disputed)}</span></div>
            )}
            {data.amount_overpaid > 0 && (
              <div className="bl-total"><span className="bl-total__label">Overpaid — held as credit</span><span className="bl-total__value">{money(data.amount_overpaid)}</span></div>
            )}
            <div className="bl-total bl-total--grand"><span className="bl-total__label">Still owed</span><span className="bl-total__value">{money(data.amount_due)}</span></div>
          </div>
        </Card>

        {data.dunning && <RecoveryCard campaign={data.dunning} onChanged={refetch} />}

        {failed.length > 0 && (
          <Card title="Why it is failing" description="The most recent refusal, in the issuer's own words.">
            <Banner tone="danger" compact title={humanize(failed[failed.length - 1].failure_code ?? 'declined')}>
              {failed[failed.length - 1].outcome?.explanation
                ?? failed[failed.length - 1].failure_message
                ?? 'The issuer gave no reason.'}
            </Banner>
            <div className="bl-sub" style={{ marginTop: 'var(--space-4)' }}>
              A card that keeps refusing is fixed on the account: attach a working method there and make it the default,
              then present this bill again.
            </div>
            <Inline gap={3} style={{ marginTop: 'var(--space-4)' }}>
              <Button size="sm" variant="secondary" onClick={() => navigate(`${customerHref(invoice.customer)}?tab=payments`)}>
                Open the payment methods
              </Button>
            </Inline>
          </Card>
        )}
      </Stack>
    </div>
  );
}

/**
 * One payment instruction, with the step it is waiting on.
 *
 * `requires_action` is the state a payments UI usually drops: the issuer wants
 * the cardholder, the money is authorised and not taken, and an operator with
 * the customer on the phone has nowhere to say yes. It is a button here, and so
 * is walking away from it — an intent left in that state holds a balance
 * against the bill that nothing else can collect.
 */
function IntentRow({ intent, number, onChanged }: { intent: PaymentIntent; number: string; onChanged: () => void }) {
  const f = useBillingFormat();
  const action = useAction();
  const money = f.money(intent.amount, { currency: intent.currency });

  const run = (path: string, body: unknown, copy: { success: string; description?: string; failure: string }) => {
    void action.run(api.post(path, body), copy, INVALIDATE_MONEY).then((result) => { if (result) onChanged(); });
  };

  return (
    <div className="bl-row">
      <div className="bl-row__main">
        {/* The gateway names an invoice-bound intent after the invoice, which
            on the invoice's own screen says nothing. Only a description the
            operator wrote is worth repeating here. */}
        <div className="bl-row__title">
          {money}
          {intent.description && intent.description !== `Invoice ${number}` ? ` · ${intent.description}` : ''}
        </div>
        <div className="bl-row__sub">
          {intent.last_payment_error?.message
            ?? intent.next_action?.description
            ?? (intent.status === 'processing'
              ? 'With the bank. A direct debit settles in a few days, and the bill stays owed until it does.'
              : intent.status === 'succeeded'
                ? `Taken ${f.dateTime(intent.succeeded_at ?? intent.created)}.`
                : `Raised ${f.dateTime(intent.created)}.`)}
        </div>
        {(intent.status === 'requires_action' || intent.status === 'requires_confirmation' || intent.status === 'requires_payment_method') && (
          <Inline gap={3} style={{ marginTop: 'var(--space-3)' }}>
            {intent.status === 'requires_action' && (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  loading={action.busy}
                  onClick={() => run(`/v1/payment_intents/${intent.id}/authenticate`, { result: 'approve' }, {
                    success: `${money} authenticated`,
                    description: 'The issuer accepted the cardholder, so the charge went through.',
                    failure: 'The authentication step failed',
                  })}
                >
                  The cardholder approved it
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={action.busy}
                  onClick={() => run(`/v1/payment_intents/${intent.id}/authenticate`, { result: 'abandon' }, {
                    success: 'Abandoned',
                    description: 'Nothing was taken. The bill is still owed and can be presented again.',
                    failure: 'It could not be abandoned',
                  })}
                >
                  They walked away
                </Button>
              </>
            )}
            {intent.status !== 'requires_action' && (
              <Button
                size="sm"
                variant="ghost"
                loading={action.busy}
                onClick={() => run(`/v1/payment_intents/${intent.id}/cancel`, { cancellation_reason: 'abandoned' }, {
                  success: 'Payment cancelled',
                  description: 'Nothing was taken, and the bill is free to be presented again.',
                  failure: 'It could not be cancelled',
                })}
              >
                Cancel it
              </Button>
            )}
          </Inline>
        )}
      </div>
      <div className="bl-row__aside">
        <div className="bl-sub"><StatusPill status={intent.status} /></div>
      </div>
    </div>
  );
}

/**
 * The retry schedule, made operable.
 *
 * "Dunning is retrying it" is not a fact an AR clerk can act on. This is: when
 * the next attempt lands, what it will present, what every earlier attempt
 * decided and why, how many are left before the platform gives up and what
 * giving up will do — plus the two controls that were missing, stopping the
 * schedule for this one bill and changing the schedule the workspace runs.
 */
function RecoveryCard({ campaign, onChanged }: { campaign: InvoiceDunning; onChanged: () => void }) {
  const f = useBillingFormat();
  const action = useAction();
  const [stopping, setStopping] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState('');
  const [showAttempts, setShowAttempts] = useState(false);

  const live = campaign.status === 'recovering' || campaign.status === 'open';
  const money = (amount: number) => f.money(amount, { currency: campaign.currency });

  const stop = async () => {
    const result = await action.run(
      api.post(`/v1/dunning/${campaign.id}/cancel`, reason.trim() ? { reason: reason.trim() } : {}),
      {
        success: `Recovery stopped on ${campaign.invoice_number}`,
        description: 'The bill is untouched and still owed — only the automatic retries stand down.',
        failure: 'The schedule could not be stopped',
      },
      ['/v1/dunning', '/v1/invoices'],
    );
    if (result) { setStopping(false); setReason(''); onChanged(); }
  };

  const stopForm = useDialogForm(stopping, !action.busy, () => { void stop(); });

  return (
    <Card
      title="Recovery"
      description={live
        ? 'What the platform will do next about this bill on its own, and when.'
        : 'How the platform chased this bill, and how it ended.'}
      actions={live
        ? <Button size="sm" variant="danger-ghost" iconLeft={<XCircleIcon size={13} />} onClick={() => setStopping(true)}>Stop chasing</Button>
        : undefined}
    >
      <Banner tone={campaign.needs_human ? 'warning' : live ? 'info' : 'success'} compact>
        {campaign.recommended_action}
      </Banner>

      <div className="bl-dunnext">
        <div>
          <div className="bl-headline__label">{live ? 'Next attempt' : 'Last attempt'}</div>
          <div className="bl-dunnext__when">
            {live
              ? campaign.next_attempt_at ? f.dateTime(campaign.next_attempt_at) : 'Nothing is scheduled'
              : campaign.last_attempt_at ? f.dateTime(campaign.last_attempt_at) : '—'}
          </div>
          <div className="bl-sub">
            {live && campaign.next_attempt_at
              ? `${f.relative(campaign.next_attempt_at)} · ${campaign.payment_method?.display_name ?? 'no method on file to present'}`
              : campaign.resolution ?? statusLabel(campaign.status)}
          </div>
        </div>
        <div className="bl-dunnext__meter" role="img" aria-label={`Attempt ${campaign.attempt_count} of ${campaign.max_attempts}`}>
          {Array.from({ length: campaign.max_attempts }, (_, i) => (
            <span
              key={i}
              className={`bl-dunpip${i < campaign.attempt_count ? ' bl-dunpip--spent' : ''}${i === campaign.attempt_count && live ? ' bl-dunpip--next' : ''}`}
            />
          ))}
        </div>
      </div>

      <FieldRow label="At risk">{money(campaign.amount_at_risk)}</FieldRow>
      <FieldRow label="Attempts">
        {`${f.number(campaign.attempt_count)} of ${f.number(campaign.max_attempts)} used`}
        {live ? ` · ${f.number(campaign.attempts_remaining)} left` : ''}
      </FieldRow>
      <FieldRow label="The schedule" hint="Gaps between attempts, not offsets from the first failure.">
        {campaign.retry_days.length
          ? f.list(campaign.retry_days.map((days) => f.plural(days, 'day')))
          : 'No retries — one attempt only'}
      </FieldRow>
      <FieldRow label="When it runs out">
        {campaign.end_behavior === 'mark_unpaid'
          ? 'The subscription is marked unpaid and stops being collected.'
          : campaign.end_behavior === 'cancel'
            ? 'The subscription is cancelled.'
            : humanize(campaign.end_behavior)}
      </FieldRow>
      {campaign.last_failure_message && (
        <FieldRow label="Last refusal">{campaign.last_failure_message}</FieldRow>
      )}

      {campaign.attempts.length > 0 && (
        <>
          <button type="button" className="bl-lines__toggle" onClick={() => setShowAttempts((v) => !v)} aria-expanded={showAttempts}>
            {showAttempts ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />}
            {showAttempts ? 'Hide every attempt' : `Show all ${f.number(campaign.attempts.length)} attempts`}
          </button>
          {showAttempts && (
            <div className="bl-tablewrap" style={{ marginTop: 'var(--space-4)' }}>
              <table className="bl-lines">
                <thead><tr><th>#</th><th>When</th><th>Outcome</th><th>What it decided</th></tr></thead>
                <tbody>
                  {campaign.attempts.map((attempt) => (
                    <tr key={attempt.id}>
                      <td>{f.number(attempt.attempt_number)}</td>
                      <td className="bl-nowrap">{f.dateTime(attempt.attempted_at)}</td>
                      <td><StatusPill status={attempt.outcome} /></td>
                      <td>
                        <div>{attempt.failure_message ?? statusLabel(attempt.outcome)}</div>
                        <div className="bl-lines__why">{attempt.decision}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <Inline gap={3} style={{ marginTop: 'var(--space-5)' }}>
        <Button size="sm" variant="secondary" iconLeft={<Icons.settings size={13} />} onClick={() => setEditing(true)}>
          Change the retry schedule…
        </Button>
      </Inline>

      <Modal
        open={stopping}
        onClose={() => setStopping(false)}
        size="sm"
        title={`Stop chasing ${campaign.invoice_number}?`}
        description="The bill is untouched — it stays open and stays owed. Only the automatic retries stand down, for an account you are collecting another way."
        icon={<AlertTriangleIcon size={18} />}
        iconTone="danger"
        footer={
          <>
            <Button variant="ghost" onClick={() => setStopping(false)}>Keep retrying</Button>
            <Button variant="danger" loading={action.busy} onClick={() => { void stop(); }}>Stop the schedule</Button>
          </>
        }
      >
        <DialogFields form={stopForm}>
          <Field label="Why" optional hint="Recorded on the campaign, for whoever reads the recovery queue next." error={action.errorFor('reason')}>
            <Input
              value={reason}
              maxLength={500}
              placeholder="Finance is collecting this one by bank transfer"
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        </DialogFields>
      </Modal>

      <RetryScheduleDialog open={editing} onClose={() => setEditing(false)} />
    </Card>
  );
}

/**
 * The retry policy the whole workspace runs on, edited where an operator hits
 * it. It is deliberately labelled as workspace-wide: this is not this bill's
 * schedule, it is every bill's, and changing it here changes it everywhere.
 */
function RetryScheduleDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const f = useBillingFormat();
  const action = useAction();
  const settings = useQuery<PaymentSettings>('/v1/payments/settings', undefined, { enabled: open });
  const [gaps, setGaps] = useState('');
  const [maxAttempts, setMaxAttempts] = useState('4');
  const [endBehavior, setEndBehavior] = useState('mark_unpaid');
  const [skipWeekends, setSkipWeekends] = useState(true);
  const policy = settings.data?.dunning;

  useEffect(() => {
    if (!open || !policy) return;
    setGaps(policy.retry_days.join(', '));
    setMaxAttempts(String(policy.max_attempts));
    setEndBehavior(policy.end_behavior);
    setSkipWeekends(policy.skip_weekends);
    action.clear();
  }, [open, policy]); // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = gaps.split(',').map((part) => Number(part.trim())).filter((n) => Number.isFinite(n) && n > 0);
  const valid = parsed.length > 0 && parsed.every((n) => n >= 1 && n <= 60);

  const submit = async () => {
    const result = await action.run(
      api.patch<PaymentSettings>('/v1/payments/settings', {
        dunning: {
          retry_days: parsed,
          max_attempts: Number(maxAttempts) || 1,
          end_behavior: endBehavior,
          skip_weekends: skipWeekends,
        },
      }),
      {
        success: 'Retry schedule saved',
        description: 'Every campaign still running picks it up at its next attempt.',
        failure: 'The schedule was refused',
      },
      ['/v1/payments/settings', '/v1/dunning', '/v1/invoices'],
    );
    if (result) onClose();
  };

  const form = useDialogForm(open, valid && !!policy && !action.busy, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="The retry schedule"
      description="This is the workspace's policy, not this invoice's — every campaign in Northwind runs on it."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={action.busy} disabled={!valid || !policy} onClick={() => { void submit(); }}>
            Save the schedule
          </Button>
        </>
      }
    >
      {settings.error && <SectionError error={settings.error} path="GET /v1/payments/settings" onRetry={settings.refetch} />}
      {!settings.error && !policy && <Loading label="Reading the policy…" />}
      {policy && (
        <DialogFields form={form}>
        <Stack gap={5}>
          <Banner tone="info" compact title="How it runs today">{settings.data?.schedule_explained}</Banner>
          <Field
            label="Gaps between attempts"
            required
            hint="Days between one attempt and the next, comma separated. An issuer that refused a card this morning refuses it this afternoon, so the gaps widen."
            error={action.errorFor('retry_days') ?? (gaps.trim() && !valid ? 'Each gap is a whole number of days between 1 and 60.' : undefined)}
          >
            <Input value={gaps} placeholder="3, 5, 7" onChange={(e) => setGaps(e.target.value)} invalid={!!gaps.trim() && !valid} aria-label="Gaps between attempts" />
          </Field>
          <Grid columns={2} gap={5}>
            <GridItem>
              <Field label="Attempts in total" hint="Counts the first, failed collection." error={action.errorFor('max_attempts')}>
                <Select
                  value={maxAttempts}
                  onChange={setMaxAttempts}
                  options={Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: f.plural(i + 1, 'attempt') }))}
                />
              </Field>
            </GridItem>
            <GridItem>
              <Field label="When they run out" error={action.errorFor('end_behavior')}>
                <Select
                  value={endBehavior}
                  onChange={setEndBehavior}
                  options={[
                    { value: 'mark_unpaid', label: 'Mark the subscription unpaid and stop collecting' },
                    { value: 'cancel', label: 'Cancel the subscription' },
                    { value: 'leave_open', label: 'Leave it open and chase it by hand' },
                  ]}
                />
              </Field>
            </GridItem>
          </Grid>
          <Checkbox
            checked={skipWeekends}
            onChange={setSkipWeekends}
            label="Never present on a weekend"
            hint="Nobody's payroll clears on a Sunday, and no one is in to fix a decline."
          />
          <div className="bl-sub">
            {`Retries land in the ${f.number(policy.collection_hour)}:00 UTC window, spread across the `
              + `${f.plural(policy.jitter_hours, 'hour')} after it so a thousand accounts do not present at once. `
              + `A hard decline waits ${policy.hard_decline_multiplier}× longer, and `
              + `${f.list(policy.give_up_codes.map(humanize))} stop the schedule outright — none of them clear by waiting.`}
          </div>
        </Stack>
        </DialogFields>
      )}
    </Modal>
  );
}

function ChargeRow({ charge, method, onRefund }: { charge: Charge; method: string | null; onRefund?: () => void }) {
  const f = useBillingFormat();
  const ok = charge.status === 'succeeded';
  const money = (amount: number) => f.money(amount, { currency: charge.currency });
  return (
    <div className="bl-row">
      <span className="bl-row__icon">{ok ? <CheckCircleIcon size={16} /> : <XCircleIcon size={16} />}</span>
      <div className="bl-row__main">
        <div className="bl-row__title">
          {ok ? 'Authorised' : humanize(charge.failure_code ?? 'Declined')}
          {charge.authorization_code && <span className="bl-sub"> · auth {charge.authorization_code}</span>}
        </div>
        <div className="bl-row__sub">{charge.outcome?.explanation ?? charge.failure_message ?? charge.outcome?.seller_message ?? ''}</div>
        <div className="bl-row__sub">
          {f.dateTime(charge.created)}
          {charge.outcome?.risk_level ? ` · risk ${charge.outcome.risk_level}${charge.outcome.risk_score !== null ? ` (${charge.outcome.risk_score})` : ''}` : ''}
          {method ? ` · ${method}` : ''}
        </div>
        {(charge.amount_refunded > 0 || charge.amount_disputed > 0) && (
          <div className="bl-row__sub">
            {charge.amount_refunded > 0 ? `${money(charge.amount_refunded)} refunded` : ''}
            {charge.amount_refunded > 0 && charge.amount_disputed > 0 ? ' · ' : ''}
            {charge.amount_disputed > 0 ? `${money(charge.amount_disputed)} held by a dispute` : ''}
          </div>
        )}
      </div>
      <div className="bl-row__aside">
        <div>{money(charge.amount)}</div>
        <div className="bl-sub"><StatusPill status={ok ? 'paid' : 'unpaid'} /></div>
      </div>
      {onRefund && (
        <div className="bl-row__act">
          <Button size="sm" variant="ghost" iconLeft={<Icons.refresh size={14} />} aria-label={`Refund the ${money(charge.amount)} charge`} onClick={onRefund}>
            Refund…
          </Button>
        </div>
      )}
    </div>
  );
}

/* ================================= refunds ================================ */

/**
 * Send collected money back.
 *
 * The gateway does two things with a refund and the dialog says both before
 * they happen: the cash goes back to the customer, and the bill it settled is
 * owed again for that amount — nothing charges the reopened balance on its own,
 * so the invoice goes into the recovery queue held for a person. What it does
 * *not* do is reduce the bill; that is a credit note, and the dialog points
 * there for anyone who reached for the wrong tool.
 */
function RefundDialog({ invoice, charge, open, onClose }: {
  invoice: Invoice; charge: Charge | null; open: boolean; onClose: () => void;
}) {
  const f = useBillingFormat();
  const action = useAction();
  const toast = useToast();
  const payments = useQuery<InvoicePayments>(`/v1/invoices/${invoice.id}/payments`, undefined, { enabled: open });
  const methods = useQuery<ListEnvelope<PaymentMethod>>(`/v1/customers/${invoice.customer}/payment_methods`, undefined, { enabled: open });
  const candidates = useMemo(() => (payments.data?.charges ?? []).filter(canRefund), [payments.data]);
  const [chargeId, setChargeId] = useState<string>(charge?.id ?? '');
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState<string>('requested_by_customer');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (!open) return;
    setChargeId(charge?.id ?? '');
    setAmount(null);
    setReason('requested_by_customer');
    setDescription('');
    action.clear();
  }, [open, charge?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The first refundable charge is chosen once the list arrives, and the
  // amount defaults to everything it still has to give back.
  const chosen = candidates.find((row) => row.id === chargeId) ?? candidates[0] ?? null;
  useEffect(() => {
    if (!open || !chosen) return;
    if (chosen.id !== chargeId) setChargeId(chosen.id);
    if (amount === null) setAmount(refundable(chosen));
  }, [open, chosen, chargeId, amount]);

  const money = (value: number) => f.money(value, { currency: invoice.currency });
  const remaining = chosen ? refundable(chosen) : 0;
  const value = amount ?? 0;
  const invalid = !chosen
    ? null
    : value <= 0
      ? 'Enter the amount to send back.'
      : value > remaining
        ? `${money(value)} is more than the ${money(remaining)} this charge still has to give back.`
        : null;
  const methodName = (id: string | null) => (methods.data?.data ?? []).find((row) => row.id === id)?.display_name ?? 'the method it was taken from';

  const submit = async () => {
    if (!chosen || invalid) return;
    const refund = await action.run(
      api.post<Refund>('/v1/refunds', {
        charge: chosen.id,
        amount: value,
        reason,
        ...(description.trim() ? { description: description.trim() } : {}),
      }, { idempotencyKey: idem() }),
      { success: `${money(value)} refunded`, silent: true, failure: 'The refund was refused' },
      INVALIDATE_MONEY,
    );
    if (!refund) return;
    // The gateway writes what the refund did to the bill; that sentence, not
    // a canned one, is the toast.
    toast.success(`${money(refund.amount)} refunded to ${invoice.customer_name ?? invoice.customer}`, refund.invoice_effect ?? undefined, { duration: 0 });
    onClose();
  };

  const form = useDialogForm(open, !!chosen && !invalid && !action.busy, () => { void submit(); });
  const owedAfter = invoice.amount_due + value;
  const collectedAfter = Math.max(0, invoice.amount_paid - value);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={`Refund a payment on ${invoice.number}`}
      description={`${money(invoice.amount_paid)} has been collected against this bill. A refund sends cash back; it does not change what was billed.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={action.busy} disabled={!chosen || !!invalid} onClick={() => { void submit(); }}>
            {chosen && !invalid ? `Refund ${money(value)}` : 'Refund'}
          </Button>
        </>
      }
    >
      <DialogFields form={form}>
        <Stack gap={5}>
          {payments.error && <SectionError error={payments.error} path={`GET /v1/invoices/${invoice.id}/payments`} onRetry={payments.refetch} />}
          {!payments.error && payments.loading && <Loading label="Reading what was collected…" />}
          {payments.data && candidates.length === 0 && (
            <EmptyState
              size="sm"
              inline
              illustration={null}
              title="Nothing here can be refunded"
              body={invoice.amount_paid > 0
                ? `${money(invoice.amount_paid)} was settled without a charge to reverse — by hand, or from the account balance. Give it back as a credit note or a balance adjustment instead.`
                : `Nothing has been collected against ${invoice.number}, so there is nothing to send back.`}
            />
          )}
          {chosen && (
            <>
              {candidates.length > 1 && (
                <Field label="Which charge" required>
                  <Select
                    value={chosen.id}
                    onChange={(next) => { setChargeId(next); setAmount(null); }}
                    options={candidates.map((row) => ({
                      value: row.id,
                      label: `${money(row.amount)} on ${f.date(row.created, { withYear: true })} · ${methodName(row.payment_method)}${refundable(row) < row.amount ? ` · ${money(refundable(row))} left` : ''}`,
                    }))}
                  />
                </Field>
              )}
              {candidates.length === 1 && (
                <FieldRow label="Charge">
                  {`${money(chosen.amount)} taken ${f.dateTime(chosen.created)} from ${methodName(chosen.payment_method)}`}
                  {refundable(chosen) < chosen.amount ? ` — ${money(refundable(chosen))} left to give back` : ''}
                </FieldRow>
              )}
              <Field
                label="Amount to refund"
                required
                error={action.errorFor('amount') ?? invalid ?? undefined}
                hint={`Up to ${money(remaining)}. A part refund leaves the rest collected.`}
              >
                <MoneyField value={amount} onChange={setAmount} currency={invoice.currency} min={0} max={remaining} label="Amount to refund" />
              </Field>
              <Field label="Reason" error={action.errorFor('reason')}>
                <Select value={reason} onChange={setReason} options={REFUND_REASONS.map((row) => ({ value: row, label: humanize(row) }))} />
              </Field>
              <Field label="Note" optional counter={{ value: description.length, max: 500 }} error={action.errorFor('description')}>
                <Input value={description} maxLength={500} placeholder="What the customer was told." onChange={(e) => setDescription(e.target.value)} />
              </Field>
              {!invalid && value > 0 && (
                <Banner tone="warning" compact title="What this leaves">
                  {`${money(value)} goes back to ${methodName(chosen.payment_method)}. ${invoice.number} then shows ${money(collectedAfter)} collected and `}
                  {`${money(owedAfter)} owed again${invoice.status === 'paid' ? ' — it reopens' : ''}. Nothing charges that on its own: the bill goes to the `}
                  {'recovery queue held for a person, who credits it or presents it by hand. To make the bill itself smaller, issue a credit note instead.'}
                </Banner>
              )}
            </>
          )}
        </Stack>
      </DialogFields>
    </Modal>
  );
}

function LinesTab({ invoice }: { invoice: Invoice }) {
  const f = useBillingFormat();
  const [expanded, setExpanded] = useState<string[]>([]);
  const toggle = (id: string) => setExpanded((rows) => (rows.includes(id) ? rows.filter((r) => r !== id) : [...rows, id]));

  return (
    <div className="bl-cols">
      <Stack gap={6}>
        <Card title="Lines" description="Each one carries the window it covers and the sentence that reconstructs its number.">
          <div className="bl-tablewrap">
            <table className="bl-lines">
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Period</th>
                  <th className="bl-num">Qty</th>
                  <th className="bl-num">Tax</th>
                  <th className="bl-num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {invoice.lines.map((line) => (
                  <LineRow key={line.id} line={line} open={expanded.includes(line.id)} onToggle={() => toggle(line.id)} />
                ))}
                {invoice.lines.length === 0 && (
                  <tr><td colSpan={5}><span className="bl-muted">This invoice has no lines.</span></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        {invoice.total_taxes.length > 0 && (
          <Card title="Tax" description="Grouped by the rate that produced it, with the reason behind every figure — including every zero.">
            <div className="bl-tablewrap">
              <table className="bl-lines">
                <thead>
                  <tr><th>Rate</th><th>Where</th><th className="bl-num">Taxable</th><th className="bl-num">Tax</th></tr>
                </thead>
                <tbody>
                  {invoice.total_taxes.map((row, i) => (
                    <tr key={`${row.tax_rate ?? 'none'}-${i}`}>
                      <td>
                        <div>{row.display_name} {row.percentage}%</div>
                        <div className="bl-lines__why">{row.explanation}</div>
                      </td>
                      <td className="bl-nowrap">{row.jurisdiction ?? '—'}</td>
                      <td className="bl-num">{f.money(row.taxable_amount, { currency: row.currency })}</td>
                      <td className="bl-num">{row.amount_display}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </Stack>

      <Stack gap={6}>
        <Card title="Totals">
          <div className="bl-totals">
            <div className="bl-total"><span className="bl-total__label">Subtotal</span><span className="bl-total__value">{invoice.subtotal_display}</span></div>
            <div className="bl-total"><span className="bl-total__label">Tax</span><span className="bl-total__value">{invoice.tax_display}</span></div>
            {/* Total is the bill; the balance drawn against it is its own line
                under it, the way the document and Stripe both lay it out. */}
            <div className="bl-total bl-total--grand"><span className="bl-total__label">Total</span><span className="bl-total__value">{f.money(billedTotal(invoice), { currency: invoice.currency })}</span></div>
            {invoice.balance_applied !== 0 && (
              <div className="bl-total">
                <span className="bl-total__label">Account balance applied</span>
                <span className="bl-total__value">{invoice.balance_applied_display}</span>
              </div>
            )}
            <div className="bl-total"><span className="bl-total__label">Paid</span><span className="bl-total__value">{f.money(invoice.amount_paid, { currency: invoice.currency })}</span></div>
            {invoice.pre_payment_credit_notes_amount > 0 && (
              <div className="bl-total">
                <span className="bl-total__label">Credited before payment</span>
                <span className="bl-total__value">{f.money(invoice.pre_payment_credit_notes_amount, { currency: invoice.currency })}</span>
              </div>
            )}
            {invoice.post_payment_credit_notes_amount > 0 && (
              <div className="bl-total">
                <span className="bl-total__label">Credited after payment</span>
                <span className="bl-total__value">{f.money(invoice.post_payment_credit_notes_amount, { currency: invoice.currency })}</span>
              </div>
            )}
            <div className="bl-total bl-total--grand"><span className="bl-total__label">Amount due</span><span className="bl-total__value">{invoice.amount_due_display}</span></div>
          </div>
        </Card>

        <Card title="Details">
          <FieldRow label="Billing reason">{humanize(invoice.billing_reason)}</FieldRow>
          <FieldRow label="Collection">{humanize(invoice.collection_method)}</FieldRow>
          <FieldRow label="Service period">{coversText(invoice)}</FieldRow>
          {invoice.arrears_period && (
            <FieldRow label="Usage settled" hint="The window whose metered usage this bill settles, in arrears.">
              {f.dayRange(invoice.arrears_period.start, invoice.arrears_period.end)}
            </FieldRow>
          )}
          {/* One calendar names this invoice, and it is the document's: every
              date below is the UTC day the customer's copy carries, so the
              header, the tiles and the printed bill can never disagree. The
              operator's own clock is in the hint, labelled as their time. */}
          <FieldRow label="Issued" hint={invoiceClockNote(invoice.created, f)}>
            {f.day(invoice.created, { withYear: true })}
          </FieldRow>
          {invoice.finalized_at && (
            <FieldRow label="Finalised" hint={invoiceClockNote(invoice.finalized_at, f)}>
              {f.day(invoice.finalized_at, { withYear: true })}
            </FieldRow>
          )}
          {invoice.paid_at && (
            <FieldRow label="Paid" hint={invoiceClockNote(invoice.paid_at, f)}>
              {f.day(invoice.paid_at, { withYear: true })}
            </FieldRow>
          )}
          {invoice.voided_at && (
            <FieldRow label="Voided" hint={invoiceClockNote(invoice.voided_at, f)}>
              {f.day(invoice.voided_at, { withYear: true })}
            </FieldRow>
          )}
          <FieldRow label="Balance before">{f.money(invoice.starting_balance, { currency: invoice.currency })}</FieldRow>
          <FieldRow label="Balance after">{f.money(invoice.ending_balance, { currency: invoice.currency })}</FieldRow>
          <FieldRow label="Id"><span className="u-mono bl-sub">{invoice.id}</span></FieldRow>
        </Card>
      </Stack>
    </div>
  );
}

function LineRow({ line, open, onToggle }: { line: InvoiceLine; open: boolean; onToggle: () => void }) {
  const f = useBillingFormat();
  const expandable = line.breakdown.length > 0 || !!line.proration_fraction || line.taxes.length > 0;
  // The human half of the explanation stays on the line; the exact rational it
  // carries moves into the disclosure below, where an auditor looks for it.
  const why = prorationCopy(line.explanation, line.proration_fraction);
  return (
    <>
      <tr className={line.amount < 0 ? 'bl-lines__row--credit' : undefined}>
        <td>
          <div>
            {line.description}
            {line.proration && <Badge tone="info" size="sm" style={{ marginLeft: 'var(--space-3)' }}>proration</Badge>}
          </div>
          {lineWhy(line.description, why.sentence) && (
            <div className="bl-lines__why">{why.sentence}</div>
          )}
          {expandable && (
            <button type="button" className="bl-lines__toggle" onClick={onToggle} aria-expanded={open}>
              {open ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />}
              {open ? 'Hide the arithmetic' : 'Show the arithmetic'}
            </button>
          )}
        </td>
        <td className="bl-nowrap">{f.dayRange(line.period.start, line.period.end)}</td>
        <td className="bl-num">{f.number(line.quantity)}</td>
        <td className="bl-num">
          {line.tax.percentage
            ? (
              <Tooltip content={line.taxes.length > 1
                ? `${line.tax.percentage}% combined across ${line.taxes.length} jurisdictions — expand the line for each.`
                : line.tax.explanation ?? ''}
              >
                <span>{line.tax.amount_display}</span>
              </Tooltip>
            )
            : <span className="bl-muted">—</span>}
        </td>
        <td className="bl-num">{line.amount_display}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5}>
            <div className="bl-tierwrap">
              {why.exact && (
                <div className="bl-lines__why" style={{ marginBottom: 'var(--space-3)' }}>
                  Prorated by{' '}
                  <span className="bl-fraction">
                    {f.number(why.exact.numerator)} / {f.number(why.exact.denominator)} ms
                  </span>{' '}
                  of the interval
                  {why.exact.reduced
                    ? `, or ${f.number(why.exact.reduced.numerator)} / ${f.number(why.exact.reduced.denominator)} in lowest terms.`
                    : '.'}
                </div>
              )}
              {line.breakdown.length > 0 && (
                <table className="bl-tiers">
                  <thead>
                    <tr><th>How it was priced</th><th>Up to</th><th>Qty</th><th>Unit</th><th>Amount</th></tr>
                  </thead>
                  <tbody>
                    {line.breakdown.map((row, i) => (
                      <tr key={`${row.kind}-${i}`}>
                        {/* The engine writes "1 robot at 950 minor units each".
                            Exact, and the one thing this product will not print. */}
                        <td>{breakdownLabel(row.label, line.currency, f.locale)}{row.tier !== null ? ` (tier ${row.tier + 1})` : ''}</td>
                        <td>{row.up_to === null ? '—' : row.up_to === 'inf' ? 'no limit' : f.number(Number(row.up_to))}</td>
                        <td>{f.number(row.quantity)}</td>
                        {/* A metered rate can be worth 0.04 of a cent, which
                            rounds to nothing through the whole-unit formatter. */}
                        <td>{row.unit_amount_decimal ? formatUnitRate(row.unit_amount_decimal, line.currency, f.locale) : '—'}</td>
                        <td>{f.money(row.amount, { currency: line.currency })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {line.taxes.length > 0 && (
                <table className="bl-tiers" style={{ marginTop: 'var(--space-4)' }}>
                  <thead>
                    <tr><th>Jurisdiction</th><th>Rate</th><th>Taxable</th><th>Tax</th></tr>
                  </thead>
                  <tbody>
                    {line.taxes.map((entry, i) => (
                      <tr key={`${entry.rate ?? 'none'}-${i}`}>
                        <td>
                          <div>{entry.display_name ?? 'Tax'}{entry.jurisdiction ? ` — ${entry.jurisdiction}` : ''}</div>
                          {entry.explanation && <div className="bl-lines__why">{entry.explanation}</div>}
                        </td>
                        <td>{entry.percentage ? `${entry.percentage}%` : '—'}</td>
                        <td>{f.money(entry.taxable_amount, { currency: line.currency })}</td>
                        <td>{f.money(entry.amount, { currency: line.currency })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {line.taxes.length === 0 && line.tax.explanation && (
                <div className="bl-lines__why" style={{ marginTop: 'var(--space-3)' }}>{line.tax.explanation}</div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The document, fetched rather than framed by URL.
 *
 * `GET /v1/invoices/:id/render` answers with the page as a JSON-encoded string,
 * so pointing an iframe straight at it paints a stray `"` above the invoice —
 * on the one screen an operator might turn towards a customer. Reading it and
 * unwrapping the encoding puts the document on screen exactly as the customer
 * receives it, and the tolerant parse means it keeps working the day the route
 * starts sending text/html.
 */
function useInvoiceDocument(invoice: Invoice): { html: string | null; error: string | null; retry: () => void } {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setHtml(null);
    setError(null);
    fetch(`/api${invoice.document_url}`, { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(`${response.status} ${response.statusText}`))))
      .then((text) => {
        if (!live) return;
        const trimmed = text.trim();
        if (trimmed.startsWith('"')) {
          try { setHtml(JSON.parse(trimmed) as string); return; } catch { /* fall through to the raw body */ }
        }
        setHtml(text);
      })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [invoice.document_url, nonce]);
  return { html, error, retry: () => setNonce((n) => n + 1) };
}

function InvoiceDocument({ invoice, tall }: { invoice: Invoice; tall?: boolean }) {
  const { html, error, retry } = useInvoiceDocument(invoice);
  if (error) {
    return (
      <EmptyState
        size="sm"
        inline
        illustration={null}
        title="The document did not render"
        body={`The server answered ${error} for this invoice's printable page.`}
        action={<Button size="sm" variant="primary" iconLeft={<Icons.refresh size={13} />} onClick={retry}>Try again</Button>}
      />
    );
  }
  if (html === null) return <Loading label="Rendering the document…" />;
  return (
    <iframe
      className={tall ? 'bl-doc bl-doc--tall' : 'bl-doc'}
      title={`Invoice ${invoice.number}`}
      srcDoc={html}
      sandbox=""
    />
  );
}

/**
 * Print the customer's copy.
 *
 * There is no route in this platform that emails an invoice, and inventing a
 * "Send" button that only pretends to would be the one lie on a screen whose
 * whole job is to be the document. Printing is what a finance team actually
 * does with it — to paper or to a PDF — so the same window the "open" link
 * produces is asked to print itself once it has painted. The document is served
 * from this origin, so the handle stays scriptable; a blocked pop-up is
 * reported rather than silently doing nothing.
 */
function printDocument(invoice: Invoice, onBlocked: () => void): void {
  const opened = window.open(`/api${invoice.document_url}`, '_blank', 'noopener=no');
  if (!opened) { onBlocked(); return; }
  opened.addEventListener('load', () => { opened.focus(); opened.print(); }, { once: true });
}

function DocumentCard({ invoice }: { invoice: Invoice }) {
  const toast = useToast();
  return (
    <Card
      title="The printable document"
      description="One self-contained page — the issuer and bill-to blocks, every line with its window, the tax grouped by rate and how to pay."
      actions={
        <Inline gap={3}>
          <Button
            size="sm"
            variant="secondary"
            iconLeft={<Icons.print size={13} />}
            onClick={() => printDocument(invoice, () => toast.error(
              'The document could not be opened',
              'The browser blocked the new window. Allow pop-ups for this site, or use "Open in a new tab" and print from there.',
              { duration: 0 },
            ))}
          >
            Print or save as PDF
          </Button>
          <Button size="sm" variant="secondary" iconLeft={<Icons.external size={13} />} href={`/api${invoice.document_url}`} target="_blank" rel="noopener">
            Open in a new tab
          </Button>
        </Inline>
      }
    >
      <InvoiceDocument invoice={invoice} />
    </Card>
  );
}

function CreditNotesTab({ invoice, notes, loading, error, onRetry, onIssue }: {
  invoice: Invoice;
  notes: CreditNote[];
  loading: boolean;
  error: ApiClientError | null;
  onRetry: () => void;
  onIssue: () => void;
}) {
  const f = useBillingFormat();
  const action = useAction();
  const [voiding, setVoiding] = useState<CreditNote | null>(null);

  const voidNote = async () => {
    if (!voiding) return;
    const result = await action.run(
      api.post<CreditNote>(`/v1/credit_notes/${voiding.id}/void`, {}),
      {
        success: `${voiding.number} voided`,
        description: 'What it credited goes back onto the invoice, and the account balance is put back where it was.',
        failure: 'The credit note could not be voided',
      },
      ['/v1/credit_notes', '/v1/invoices', '/v1/customers'],
    );
    setVoiding(null);
    if (result) onRetry();
  };
  if (error) return <Card><SectionError error={error} path="GET /v1/credit_notes" onRetry={onRetry} /></Card>;
  return (
    <Card
      title="Credit notes"
      description="The only legal way to reduce a finalised invoice, and a document in its own right."
      actions={
        <Button size="sm" variant="secondary" iconLeft={<Icons.receipt size={13} />} disabled={invoice.status === 'draft' || invoice.status === 'void'} onClick={onIssue}>
          Issue a credit note
        </Button>
      }
    >
      {loading && <Loading label="Reading credit notes…" />}
      {!loading && notes.length === 0 && (
        <EmptyState
          size="sm"
          inline
          illustration={null}
          title="Nothing has been credited on this invoice"
          body={invoice.status === 'draft'
            ? 'A draft can simply be corrected — a credit note is for a bill that has already been finalised.'
            : 'Issue one to reduce it. The preview refuses to credit more than the invoice has left.'}
          action={invoice.status === 'draft' ? undefined : <Button size="sm" variant="primary" onClick={onIssue}>Issue a credit note</Button>}
        />
      )}
      {!loading && notes.map((note) => (
        <div key={note.id} className="bl-row">
          <div className="bl-row__main">
            <div className="bl-row__title">
              {note.number} · {humanize(note.reason)}
              {note.status === 'void' && (
                <span style={{ marginLeft: 'var(--space-3)' }}><StatusPill status={note.status} /></span>
              )}
            </div>
            {/* `routing_detail` is written at issue and stays in the present
                tense — "came off what the invoice asks for" — which is a claim
                the void above has already reversed. A voided note says so. */}
            <div className="bl-row__sub">
              {note.status === 'void'
                ? `Voided${note.voided_at ? ` ${f.dateTime(note.voided_at)}` : ''}. The ${note.total_display} it credited went back onto ${invoice.number}.`
                : note.routing_detail}
            </div>
            {note.memo && <div className="bl-row__sub">{note.memo}</div>}
          </div>
          <div className="bl-row__aside">
            <div>{note.total_display}</div>
            <div className="bl-sub">{f.date(note.created)}</div>
          </div>
          <div className="bl-row__act">
            <Button
              size="sm"
              variant="ghost"
              disabled={note.status === 'void'}
              iconLeft={<XCircleIcon size={14} />}
              aria-label={`Void ${note.number}`}
              onClick={() => setVoiding(note)}
            >
              Void
            </Button>
          </div>
        </div>
      ))}

      <ConfirmDialog
        open={!!voiding}
        onCancel={() => setVoiding(null)}
        onConfirm={() => { void voidNote(); }}
        loading={action.busy}
        title={voiding ? `Void ${voiding.number}?` : 'Void this credit note?'}
        body={voiding
          ? `${voiding.total_display} goes back onto ${invoice.number}, and whatever this note pushed onto the account balance comes off it. The note stays on the record as a voided document.`
          : undefined}
        confirmLabel="Void the credit note"
      />
    </Card>
  );
}

/**
 * Money arriving against one bill — all of it, or the part of it that landed.
 *
 * The version this replaces had one button, "Record payment of $127,840.00",
 * and one free-text field. An AR clerk who received a $40,000 wire against it
 * typed 40000 into the note, and the invoice was marked settled in full: the
 * ledger said collected, the bank said otherwise, and nothing on the screen
 * had refused. A receivables tool that cannot write down what actually arrived
 * is not a ledger.
 *
 * There are two honest routes for money and this dialog offers both, priced
 * before it commits:
 *
 *  - **Presented against a method on file** — `POST /v1/payment_intents` with
 *    an `amount`, which the gateway takes as a ceiling and re-prices down (never
 *    up) against the live balance at confirm time. A part payment stays a part
 *    payment; `amount_paid` rises, `amount_due` falls, the bill stays open, and
 *    the attempt appears on the Collection tab with the issuer's own words.
 *  - **Settled by hand** — `POST /v1/invoices/:id/pay`, which takes a note and
 *    no amount, so it can only ever settle in full. The dialog says so rather
 *    than letting it be discovered afterwards, and refuses to run it for a
 *    smaller figure.
 */
function RecordPaymentDialog({ invoice, open, onClose }: { invoice: Invoice; open: boolean; onClose: () => void }) {
  const f = useBillingFormat();
  const action = useAction();
  const toast = useToast();
  const platform = usePlatform(true);
  const canPresent = platform.serves('POST', '/v1/payment_intents');
  const [amount, setAmount] = useState<number | null>(invoice.amount_due);
  const [note, setNote] = useState('');
  const [method, setMethod] = useState(BY_HAND);
  const [attaching, setAttaching] = useState(false);

  const methods = useQuery<ListEnvelope<PaymentMethod>>(
    `/v1/customers/${invoice.customer}/payment_methods`,
    undefined,
    { enabled: open && canPresent },
  );
  const account = useQuery<Customer>(`/v1/customers/${invoice.customer}`, undefined, { enabled: open });
  const attached = useMemo(
    () => (methods.data?.data ?? []).filter((row) => row.status === 'attached'),
    [methods.data],
  );

  useEffect(() => {
    if (!open) return;
    setAmount(invoice.amount_due);
    setNote('');
    action.clear();
  }, [open, invoice.amount_due]); // eslint-disable-line react-hooks/exhaustive-deps

  // Defaults to the account's default method once they are read, because that
  // is the one an automatic charge would have used.
  useEffect(() => {
    if (!open || !canPresent) return;
    setMethod(attached.find((row) => row.default_for_customer)?.id ?? attached[0]?.id ?? BY_HAND);
  }, [open, canPresent, attached]);

  const money = (value: number) => f.money(value, { currency: invoice.currency });
  const due = invoice.amount_due;
  const value = amount ?? 0;
  const remaining = Math.max(0, due - value);
  const byHand = method === BY_HAND;
  const partial = value > 0 && value < due;
  // The one combination the platform has no route for, said before it is tried
  // rather than after: `POST /v1/invoices/:id/pay` has no `amount`.
  const handBlocked = byHand && partial;
  const tooMuch = value > due;
  const invalid = value <= 0 ? 'Enter the amount that arrived.'
    : tooMuch ? `${money(value)} is more than the ${money(due)} still owed on ${invoice.number}.`
      : handBlocked ? 'Recorded by hand settles the whole bill.'
        : null;

  const submit = async () => {
    if (invalid || amount === null) return;
    if (byHand) {
      const result = await action.run(
        api.post<Invoice>(`/v1/invoices/${invoice.id}/pay`, note.trim() ? { note: note.trim() } : {}, { idempotencyKey: idem() }),
        {
          success: `${invoice.number} settled in full`,
          description: invoice.subscription
            ? 'A subscription that was past due comes back to active on the invoice that clears it.'
            : 'Anything collected beyond what was owed stays on the account as credit.',
          failure: 'The payment was not recorded',
        },
        INVALIDATE_MONEY,
      );
      if (result) onClose();
      return;
    }
    const intent = await action.run(
      api.post<PaymentIntent>('/v1/payment_intents', {
        customer: invoice.customer,
        invoice: invoice.id,
        amount,
        payment_method: method,
        confirm: true,
        off_session: false,
        ...(note.trim() ? { description: note.trim().slice(0, 500) } : {}),
      }, { idempotencyKey: idem() }),
      {
        success: `${money(amount)} presented against ${invoice.number}`,
        description: remaining > 0
          ? `${money(remaining)} is still owed on it.`
          : 'It settles the bill.',
        failure: 'The payment could not be presented',
      },
      INVALIDATE_MONEY,
    );
    if (!intent) return;
    // The intent came back; what it came back *as* is the thing worth saying.
    // "Succeeded" over a `processing` debit is how a customer is told their
    // money arrived three days before it does.
    if (intent.status === 'processing') {
      toast.info(
        `${money(intent.amount)} is with the bank`,
        `A direct debit settles in a few days. ${invoice.number} stays owed until it does, and the Collection tab tracks it.`,
        { duration: 0 },
      );
    } else if (intent.status === 'requires_action') {
      toast.warning(
        'The issuer wants the cardholder',
        `${money(intent.amount)} is authorised but not taken — open the Collection tab to complete the authentication step.`,
        { duration: 0 },
      );
    } else if (intent.status !== 'succeeded') {
      toast.error(
        'The card was declined',
        intent.last_payment_error?.message ?? 'Nothing was collected. The attempt is on the Collection tab with the issuer’s reason.',
        { duration: 0 },
      );
    }
    onClose();
  };

  const form = useDialogForm(open, !invalid && !action.busy, () => { void submit(); });
  const methodOptions = [
    ...attached.map((row) => ({
      value: row.id,
      label: `${row.display_name}${row.default_for_customer ? ' · default' : ''}`,
    })),
    { value: BY_HAND, label: 'Recorded by hand — nothing is presented' },
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={`Take a payment on ${invoice.number}`}
      description={`${money(due)} is owed by ${invoice.customer_name ?? invoice.customer}. Record what arrived, not what was billed.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={action.busy} disabled={!!invalid} onClick={() => { void submit(); }}>
            {/* The button carries the money and its consequence, so the last
                thing read before committing is the balance this leaves. */}
            {value > 0 && !tooMuch
              ? remaining > 0
                ? `Record ${money(value)} · ${money(remaining)} still owed`
                : `Record ${money(value)} · settles ${invoice.number}`
              : 'Record the payment'}
          </Button>
        </>
      }
    >
      <DialogFields form={form}>
        <Stack gap={5}>
          <Field
            label="Amount received"
            required
            error={action.errorFor('amount') ?? invalid ?? undefined}
            hint={partial && !handBlocked
              ? `A part payment. ${invoice.number} stays open for the remaining ${money(remaining)}.`
              : `Defaults to the whole balance. The most this bill can take is ${money(due)}.`}
          >
            <MoneyField
              value={amount}
              onChange={setAmount}
              currency={invoice.currency}
              min={0}
              max={due}
            />
          </Field>

          {canPresent && (
            <Field
              label="How it was taken"
              required
              error={action.errorFor('payment_method')}
              hint={byHand
                ? 'Nothing is presented — the bill is marked settled and the note below says how the money arrived.'
                : 'Presented against this method now, and recorded on the Collection tab with the issuer’s answer.'}
            >
              <Stack gap={3}>
                {/* No aria-label: the Field's own label already names it, and
                    an aria-label would override the words on screen. */}
                <Select value={method} onChange={setMethod} options={methodOptions} />
                {account.data && (
                  <Inline gap={3}>
                    <Button size="sm" variant="ghost" iconLeft={<Icons.plus size={13} />} onClick={() => setAttaching(true)}>
                      Attach a card or bank account…
                    </Button>
                  </Inline>
                )}
              </Stack>
            </Field>
          )}

          {handBlocked && (
            <Banner tone="warning" title="A part payment has to be presented">
              <div>
                {`Recording by hand marks ${invoice.number} settled in full — the platform has no route that writes down `}
                {`part of a bill without presenting something against it. To record the ${money(value)} that actually `}
                {'arrived, present it against a method on file, or attach the bank account the transfer came from.'}
              </div>
              <Inline gap={3} style={{ marginTop: 'var(--space-4)' }}>
                {attached.length > 0 && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setMethod(attached.find((row) => row.default_for_customer)?.id ?? attached[0].id)}
                  >
                    {`Present it against ${(attached.find((row) => row.default_for_customer) ?? attached[0]).display_name}`}
                  </Button>
                )}
                {account.data && (
                  <Button size="sm" variant={attached.length ? 'ghost' : 'secondary'} iconLeft={<Icons.plus size={13} />} onClick={() => setAttaching(true)}>
                    Attach the account it came from…
                  </Button>
                )}
              </Inline>
            </Banner>
          )}

          <Field
            label={byHand ? 'How it was collected' : 'What to call it'}
            optional
            error={action.errorFor('note')}
            counter={{ value: note.length, max: 300 }}
          >
            <Input
              value={note}
              maxLength={300}
              placeholder={byHand ? 'Bank transfer, reference NW-4471' : 'Part settlement of NW-4471'}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>

          {methods.error && canPresent && (
            <SectionError
              error={methods.error}
              path={`GET /v1/customers/${invoice.customer}/payment_methods`}
              onRetry={methods.refetch}
            />
          )}
        </Stack>
      </DialogFields>
      {account.data && (
        <PaymentMethodDialog
          customer={account.data}
          open={attaching}
          onClose={() => { setAttaching(false); methods.refetch(); }}
        />
      )}
    </Modal>
  );
}

/* ============================== credit notes ============================== */

export function CreditNoteDialog({ invoice, open, onClose }: { invoice: Invoice; open: boolean; onClose: () => void }) {
  const f = useBillingFormat();
  const action = useAction();
  const [mode, setMode] = useState<'amount' | 'lines'>('amount');
  const [amount, setAmount] = useState<number | null>(null);
  const [lineAmounts, setLineAmounts] = useState<Record<string, number | null>>({});
  const [reason, setReason] = useState('service_credit');
  const [memo, setMemo] = useState('');
  const [preview, setPreview] = useState<CreditNote | null>(null);
  const [previewError, setPreviewError] = useState<ApiClientError | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode('amount');
    setAmount(null);
    setLineAmounts({});
    setPreview(null);
    setPreviewError(null);
    action.clear();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = useMemo(() => {
    if (mode === 'amount') {
      return amount && amount > 0 ? { invoice: invoice.id, amount, reason, ...(memo.trim() ? { memo: memo.trim() } : {}) } : null;
    }
    const lines = Object.entries(lineAmounts)
      .filter(([, value]) => !!value && value > 0)
      .map(([lineId, value]) => ({ invoice_line_item: lineId, amount: value as number }));
    return lines.length ? { invoice: invoice.id, lines, reason, ...(memo.trim() ? { memo: memo.trim() } : {}) } : null;
  }, [mode, amount, lineAmounts, reason, memo, invoice.id]);
  const bodyKey = body ? JSON.stringify(body) : '';

  useEffect(() => {
    if (!open || !bodyKey) { setPreview(null); setPreviewError(null); return; }
    let live = true;
    setPending(true);
    const timer = setTimeout(() => {
      api.post<CreditNote>('/v1/credit_notes/preview', JSON.parse(bodyKey))
        .then((result) => { if (live) { setPreview(result); setPreviewError(null); } })
        .catch((e: ApiClientError) => { if (live) { setPreviewError(e); setPreview(null); } })
        .finally(() => { if (live) setPending(false); });
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [bodyKey, open]);

  const submit = async () => {
    if (!bodyKey) return;
    const result = await action.run(
      api.post<CreditNote>('/v1/credit_notes', JSON.parse(bodyKey), { idempotencyKey: idem() }),
      {
        success: 'Credit note issued',
        description: preview?.routing_detail,
        failure: 'The credit note was refused',
      },
      ['/v1/invoices', '/v1/credit_notes', '/v1/customers'],
    );
    if (result) onClose();
  };

  const creditable = preview?.remaining_creditable;
  const form = useDialogForm(open, !!preview && !pending && !action.busy, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={`Credit ${invoice.number}`}
      description="Priced by the same function that issues it — including the refusal, so an over-credit is caught here rather than at the moment of issue."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={action.busy} disabled={!preview || pending} onClick={() => { void submit(); }}>
            {preview ? `Issue ${preview.total_display}` : 'Issue credit note'}
          </Button>
        </>
      }
    >
      <DialogFields form={form}>
      <Stack gap={5}>
        <Field label="What to credit">
          <Select
            value={mode}
            onChange={(value) => setMode(value as 'amount' | 'lines')}
            options={[
              { value: 'amount', label: 'An amount, spread across the lines in proportion' },
              { value: 'lines', label: 'Specific lines' },
            ]}
          />
        </Field>

        {mode === 'amount' ? (
          <Field
            label="Amount to credit"
            required
            hint="Gross — tax included. It is spread across the lines in proportion to what each has left, and priced as you type."
            error={action.errorFor('amount')}
          >
            {/* Deliberately unbounded: an over-credit is refused by the server
                with the sentence that explains why, and silently clamping the
                figure would hide the very refusal worth reading. */}
            <MoneyField value={amount} onChange={setAmount} currency={invoice.currency} min={1} label="Amount to credit" />
          </Field>
        ) : (
          <Stack gap={4}>
            {invoice.lines.filter((line) => line.amount > 0).map((line) => (
              <div key={line.id} className="bl-item">
                <div>
                  <div className="bl-row__title">{line.description}</div>
                  <div className="bl-row__sub">{`Billed ${line.amount_display}`}</div>
                </div>
                <MoneyField
                  value={lineAmounts[line.id] ?? null}
                  onChange={(value) => setLineAmounts((rows) => ({ ...rows, [line.id]: value }))}
                  currency={invoice.currency}
                  min={0}
                  label={`Credit against ${line.description}`}
                />
                <span />
              </div>
            ))}
          </Stack>
        )}

        <Field label="Reason">
          <Select
            value={reason}
            onChange={setReason}
            options={['service_credit', 'billing_error', 'order_change', 'product_unsatisfactory', 'duplicate', 'fraudulent']
              .map((value) => ({ value, label: humanize(value) }))}
          />
        </Field>
        <Field label="Memo" optional counter={{ value: memo.length, max: 600 }}>
          <Textarea value={memo} maxLength={600} onChange={(e) => setMemo(e.target.value)} placeholder="What the customer was told." />
        </Field>

        <Divider />

        {previewError && (
          <Banner tone="danger" title="This credit note would be refused">
            {previewError.body.message}
          </Banner>
        )}
        {!body && !previewError && (
          <EmptyState
            size="sm"
            inline
            illustration={null}
            title={mode === 'amount' ? 'Name an amount' : 'Name an amount against a line'}
            body="The exact lines it would reduce, and where the money goes, appear here as you type."
          />
        )}
        {preview && (
          <Stack gap={4}>
            <div className="bl-tablewrap">
              <table className="bl-lines">
                <thead><tr><th>Line credited</th><th className="bl-num">Tax</th><th className="bl-num">Amount</th></tr></thead>
                <tbody>
                  {preview.lines.map((line) => (
                    <tr key={line.id}>
                      <td>
                        <div>{line.description}</div>
                        <div className="bl-lines__why">{line.explanation}</div>
                      </td>
                      <td className="bl-num">{f.money(line.tax_amount, { currency: preview.currency })}</td>
                      <td className="bl-num">{line.amount_including_tax_display}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="bl-totals">
              <div className="bl-total"><span className="bl-total__label">Subtotal</span><span className="bl-total__value">{preview.subtotal_display}</span></div>
              <div className="bl-total"><span className="bl-total__label">Tax reversed</span><span className="bl-total__value">{preview.tax_display}</span></div>
              <div className="bl-total bl-total--grand"><span className="bl-total__label">Credited</span><span className="bl-total__value">{preview.total_display}</span></div>
            </div>
            <Banner tone="info" compact>{preview.routing_detail}</Banner>
            {creditable !== undefined && (
              <div className="bl-sub">
                {`After this note, ${f.money(Math.max(creditable - preview.total, 0), { currency: preview.currency })} of ${invoice.number} would still be creditable.`}
              </div>
            )}
          </Stack>
        )}
      </Stack>
      </DialogFields>
    </Modal>
  );
}

/* --------------------------- reusable sub-table -------------------------- */

/** The invoice grid used inside a customer, without the account column. */
export function CustomerInvoices({ customerId }: { customerId: string }) {
  const navigate = useNavigate();
  const columns = useInvoiceColumns(false);
  const list = useCursorList<Invoice>('/v1/invoices', { customer: customerId, status: 'all' }, 50);
  const [view, setView] = useState<TableState>({ query: '', sort: { columnId: 'created', direction: 'desc' }, filters: {} });
  const [billing, setBilling] = useState(false);
  return (
    <Card padding="none">
      <DataTable
        rows={list.rows}
        columns={columns}
        getRowId={(row) => row.id}
        caption="Invoices for this account"
        loading={list.loading}
        error={list.error ? { message: list.error.body.message, requestId: list.error.body.request_id ?? null, code: `${list.error.status} GET /v1/invoices` } : null}
        onRetry={list.retry}
        value={view}
        onChange={setView}
        onRowClick={(row) => navigate(invoiceHref(row.id))}
        maxHeight={520}
        plain
        empty={
          <EmptyList
            title="Nothing has been billed to this account yet"
            body="The first invoice is raised when a subscription opens its first period, or when you bill the account by hand."
            action={<Button variant="primary" onClick={() => setBilling(true)}>Bill this account</Button>}
          />
        }
        footer={<ListFooter list={list} noun="invoices" />}
      />
      <BillNowDialog open={billing} onClose={() => setBilling(false)} customer={customerId} />
    </Card>
  );
}
