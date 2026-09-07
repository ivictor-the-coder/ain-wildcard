/**
 * Payments: every presentation of money the workspace has made, and every
 * refund it has sent back.
 *
 * Until now a charge was visible in exactly one place — the Collection tab of
 * the invoice it was made against — so "which cards declined this week" had no
 * answer. This is the register: each payment instruction with what state it is
 * in, what it was presented for, what the issuer said, and what has since gone
 * back. Nothing is summed across currencies, and the total under the amount
 * column counts only the money that actually arrived.
 */
import { useMemo, useState } from 'react';
import { api, useQuery, type ListEnvelope } from '../../kernel/api';
import { useNavigate, useSearchParam } from '../../kernel/router';
import {
  Badge, Button, DataTable, Icons, Inline, Page, Select, Tabs, humanize,
  type DataTableColumn, type MenuSection,
} from '../../design';
import { ArrowUpRightIcon, XCircleIcon } from '../../design';
import {
  BookFooter, EmptyList, ExportCsvButton, ListFailure, LoadFailedEmpty, MoneyRangeFilter, MoneyTotals, RecordLink,
  StatusPill, TableSearch, csvAmount, csvInstant, customerHref, decodeRange, encodeRange, invoiceHref, 
  matchesRange, moneyRank, rangeActive, statusLabel, totalsByCurrency, useAction, useBillingFormat, useBookList,
  useBookTotal, useCurrencyChoices, useDebounced, useTableView, visibleRows,
} from './common';
import type { CsvColumn } from './common';
import { CustomerPicker } from './subscriptions';
import type { Customer, Invoice, PaymentIntent, PaymentMethod, Refund } from './types';

/* ------------------------------- vocabulary -------------------------------- */

/** Who raised the instruction, in the operator's words rather than the enum's. */
const SOURCE_COPY: Record<PaymentIntent['source'], string> = {
  invoice_collection: 'Collected when the bill was raised',
  dunning_retry: 'Retried by the recovery schedule',
  manual_retry: 'Presented by hand',
  api: 'Raised through the API',
};

const SOURCE_SHORT: Record<PaymentIntent['source'], string> = {
  invoice_collection: 'Collector',
  dunning_retry: 'Retry',
  manual_retry: 'By hand',
  api: 'API',
};

const STATUS_FILTERS = [
  { value: 'all', label: 'Every payment' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'requires_payment_method', label: 'Declined' },
  { value: 'processing', label: 'With the bank' },
  { value: 'requires_action', label: 'Needs the cardholder' },
  { value: 'requires_confirmation', label: 'Ready to present' },
  { value: 'canceled', label: 'Canceled' },
];

const currencyOfRow = (row: { currency: string }): string => row.currency;

/**
 * The names behind the ids a payment carries.
 *
 * An intent names its customer, invoice and method by id. The three books are
 * read once and joined here, so a row reads "Meridian Foods · NR-000212 · Visa
 * ending 4242" — and says when a name is not yet known rather than printing
 * the id in its place.
 */
function useNames() {
  const customers = useBookList<Customer>('/v1/customers', {});
  const invoices = useBookList<Invoice>('/v1/invoices', { status: 'all' });
  const methods = useQuery<ListEnvelope<PaymentMethod>>('/v1/payment_methods', { limit: 200 });
  return useMemo(() => {
    const customer = new Map(customers.rows.map((row) => [row.id, row.name]));
    const invoice = new Map(invoices.rows.map((row) => [row.id, row]));
    const method = new Map((methods.data?.data ?? []).map((row) => [row.id, row.display_name]));
    return {
      ready: customers.complete && invoices.complete && !!methods.data,
      customerName: (id: string) => customer.get(id) ?? null,
      invoiceOf: (id: string | null) => (id ? invoice.get(id) ?? null : null),
      methodName: (id: string | null) => (id ? method.get(id) ?? null : null),
    };
  }, [customers.rows, customers.complete, invoices.rows, invoices.complete, methods.data]);
}

type Names = ReturnType<typeof useNames>;

/* ================================== page ================================== */

export function PaymentsPage() {
  const [view, setView] = useSearchParam('view', 'payments');
  const navigate = useNavigate();
  const names = useNames();
  return (
    <Page
      title="Payments"
      eyebrow="Revenue"
      subtitle="Every presentation of money this workspace has made — what was asked for, what the issuer said, and what has gone back."
      actions={
        <Inline gap={3}>
          <Button variant="secondary" iconLeft={<Icons.invoice size={15} />} onClick={() => navigate('/billing/invoices?status=open_like')}>
            What is owed
          </Button>
        </Inline>
      }
      tabs={
        <Tabs
          aria-label="Payment registers"
          value={view}
          onChange={(next) => setView(next === 'payments' ? undefined : next)}
          tabs={[
            { id: 'payments', label: 'Payments' },
            { id: 'refunds', label: 'Refunds' },
          ]}
        />
      }
    >
      {view === 'refunds' ? <RefundsBook names={names} /> : <PaymentsBook names={names} />}
    </Page>
  );
}

/* ================================ payments ================================ */

function PaymentsBook({ names }: { names: Names }) {
  const f = useBillingFormat();
  const navigate = useNavigate();
  const action = useAction();
  const [status, setStatus] = useSearchParam('status', 'all');
  const [source, setSource] = useSearchParam('source', '');
  const [customer, setCustomer] = useSearchParam('customer', '');
  const [table, setTable] = useTableView({ columnId: 'created', direction: 'desc' });
  const [rangeParam, setRangeParam] = useSearchParam('amount', '');
  const search = useDebounced(table.query.trim(), 250);

  const book = useBookList<PaymentIntent>('/v1/payment_intents', useMemo(() => ({
    status,
    ...(source ? { source } : {}),
    ...(customer ? { customer } : {}),
  }), [status, source, customer]));
  const whole = useBookTotal('/v1/payment_intents', { status: 'all' });
  const { currencies, preferred } = useCurrencyChoices(book.rows, currencyOfRow, f.currency);
  const range = useMemo(() => decodeRange(rangeParam, preferred), [rangeParam, preferred]);

  const columns = useMemo<DataTableColumn<PaymentIntent>[]>(() => [
    {
      id: 'amount',
      header: 'Amount',
      pinned: true,
      width: 120,
      sortable: true,
      align: 'right',
      headerTitle: 'Amount',
      accessor: (row) => moneyRank(row.amount, row.currency),
      cell: (row) => <span className="bl-strong">{f.money(row.amount, { currency: row.currency })}</span>,
      // Only the money that arrived is a total anyone can bank; a declined
      // presentation is a fact about a card, not a figure to add up.
      total: (rows) => (
        <MoneyTotals totals={totalsByCurrency(rows.filter((row) => row.status === 'succeeded'), (row) => row.amount, (row) => row.currency)} />
      ),
    },
    {
      id: 'status',
      header: 'Status',
      width: 120,
      filter: 'set',
      accessor: (row) => row.status,
      filterOptionLabel: statusLabel,
      cell: (row) => <StatusPill status={row.status} title={row.last_payment_error?.message ?? row.next_action?.description ?? undefined} />,
    },
    {
      id: 'customer',
      header: 'Account',
      width: 200,
      accessor: (row) => names.customerName(row.customer) ?? row.customer,
      cell: (row) => (
        <RecordLink to={customerHref(row.customer)}>
          {names.customerName(row.customer) ?? (names.ready ? 'Account since removed' : 'Reading the account…')}
        </RecordLink>
      ),
    },
    {
      id: 'invoice',
      header: 'For',
      width: 120,
      accessor: (row) => names.invoiceOf(row.invoice)?.number ?? (row.invoice ? row.invoice : ''),
      cell: (row) => {
        if (!row.invoice) return <span className="bl-muted">Not against a bill</span>;
        const invoice = names.invoiceOf(row.invoice);
        return (
          <RecordLink to={`${invoiceHref(row.invoice)}?tab=collection`}>
            {invoice?.number ?? (names.ready ? 'Invoice since removed' : 'Reading the invoice…')}
          </RecordLink>
        );
      },
    },
    {
      id: 'method',
      header: 'Method',
      width: 210,
      accessor: (row) => names.methodName(row.payment_method) ?? '',
      // "Visa ending 8512, expires 05/2028" truncated at every width the grid
      // was shot at. The instrument goes on the first line and its expiry on
      // the second, so the part that identifies the card is always whole.
      cell: (row) => {
        if (!row.payment_method) return <span className="bl-muted">No method on file</span>;
        const name = names.methodName(row.payment_method);
        if (!name) return <span className="bl-muted">{names.ready ? 'A method since removed' : 'Reading the method…'}</span>;
        const [instrument, ...rest] = name.split(/,\s*/);
        return (
          <div className="bl-cellstack" title={name}>
            <span>{instrument}</span>
            {rest.length > 0 && <span className="bl-cellstack__sub">{rest.join(', ')}</span>}
          </div>
        );
      },
    },
    {
      id: 'source',
      header: 'Raised by',
      width: 100,
      filter: 'set',
      accessor: (row) => row.source,
      filterOptionLabel: (value) => SOURCE_SHORT[value as PaymentIntent['source']] ?? humanize(value),
      cell: (row) => <Badge tone="neutral">{SOURCE_SHORT[row.source] ?? humanize(row.source)}</Badge>,
    },
    {
      id: 'reason',
      header: 'What the issuer said',
      // The one column without a fixed width takes what the others leave. They
      // used to leave it nothing at 1512px, so the issuer's answer — the reason
      // a declined payment is on this screen at all — was never drawn.
      width: 170,
      accessor: (row) => row.last_payment_error?.message ?? row.next_action?.description ?? '',
      cell: (row) => (
        row.last_payment_error
          ? (
            <div className="bl-cellstack" title={row.last_payment_error.message}>
              <span className="bl-cellstack__top">{humanize(row.last_payment_error.code)}</span>
              <span className="bl-cellstack__sub">{row.last_payment_error.message}</span>
            </div>
          )
          : row.next_action?.description
            ? <span className="bl-sub">{row.next_action.description}</span>
            : row.status === 'succeeded'
              ? <span className="bl-muted">Approved</span>
              : <span className="bl-muted">—</span>
      ),
    },
    {
      id: 'attempts',
      header: 'Attempts',
      width: 100,
      align: 'right',
      defaultHidden: true,
      accessor: (row) => row.attempt_count,
      cell: (row) => f.number(row.attempt_count),
    },
    {
      id: 'created',
      header: 'When',
      width: 150,
      sortable: true,
      filter: 'date',
      accessor: (row) => row.created,
      cell: (row) => <span className="bl-nowrap">{f.dateTime(row.succeeded_at ?? row.created)}</span>,
    },
    {
      id: 'currency',
      header: 'Currency',
      width: 100,
      filter: 'set',
      defaultHidden: true,
      accessor: (row) => row.currency.toUpperCase(),
    },
  ], [f, names]);

  const rows = useMemo(() => (rangeActive(range)
    ? book.rows.filter((row) => matchesRange(row.amount, row.currency, range))
    : book.rows), [book.rows, range]);
  const visible = useMemo(() => visibleRows(rows, columns, table), [rows, columns, table]);

  const csv = useMemo<CsvColumn<PaymentIntent>[]>(() => [
    { header: 'Status', value: (row) => statusLabel(row.status) },
    { header: 'Currency', value: (row) => row.currency.toUpperCase() },
    { header: 'Amount', value: (row) => csvAmount(row.amount, row.currency) },
    { header: 'Account', value: (row) => names.customerName(row.customer) ?? '' },
    { header: 'Invoice', value: (row) => names.invoiceOf(row.invoice)?.number ?? '' },
    { header: 'Method', value: (row) => names.methodName(row.payment_method) ?? '' },
    { header: 'Raised by', value: (row) => SOURCE_COPY[row.source] ?? row.source },
    { header: 'Attempts', value: (row) => row.attempt_count },
    { header: 'Failure code', value: (row) => row.last_payment_error?.code ?? '' },
    { header: 'Failure message', value: (row) => row.last_payment_error?.message ?? '' },
    { header: 'Created', value: (row) => csvInstant(row.created) },
    { header: 'Succeeded at', value: (row) => csvInstant(row.succeeded_at) },
    { header: 'Customer id', value: (row) => row.customer },
    { header: 'Invoice id', value: (row) => row.invoice ?? '' },
    { header: 'Payment method id', value: (row) => row.payment_method ?? '' },
    { header: 'Payment intent id', value: (row) => row.id },
  ], [names]);

  const open = (row: PaymentIntent) => navigate(row.invoice ? `${invoiceHref(row.invoice)}?tab=collection` : customerHref(row.customer));

  const rowMenu = (row: PaymentIntent): MenuSection[] => [{
    id: 'payment',
    items: [
      {
        id: 'invoice',
        label: 'Open the invoice',
        icon: <ArrowUpRightIcon size={14} />,
        disabled: !row.invoice,
        onSelect: () => { if (row.invoice) navigate(`${invoiceHref(row.invoice)}?tab=collection`); },
      },
      { id: 'customer', label: 'Open the account', icon: <Icons.wallet size={14} />, onSelect: () => navigate(customerHref(row.customer)) },
      {
        id: 'refund',
        label: 'Refund it…',
        icon: <Icons.refresh size={14} />,
        disabled: row.status !== 'succeeded' || !row.invoice,
        onSelect: () => { if (row.invoice) navigate(`${invoiceHref(row.invoice)}?tab=collection&refund=1`); },
      },
      {
        id: 'cancel',
        label: 'Cancel the instruction',
        icon: <XCircleIcon size={14} />,
        danger: true,
        disabled: !(row.status === 'requires_payment_method' || row.status === 'requires_confirmation'),
        onSelect: () => {
          void action.run(
            api.post(`/v1/payment_intents/${row.id}/cancel`, { cancellation_reason: 'abandoned' }),
            { success: 'Payment cancelled', description: 'Nothing was taken, and the bill is free to be presented again.', failure: 'It could not be cancelled' },
            ['/v1/payment_intents', '/v1/invoices'],
          ).then(() => book.retry());
        },
      },
    ],
  }];

  return (
    <>
      {book.error && <ListFailure error={book.error} path="GET /v1/payment_intents" onRetry={book.retry} />}
      <div className={book.loading ? 'bl-grid is-loading' : 'bl-grid'}>
        <DataTable
          rows={rows}
          columns={columns}
          getRowId={(row) => row.id}
          caption="Payments"
          loading={book.loading}
          error={null}
          onRetry={book.retry}
          value={table}
          onChange={setTable}
          initialSort={{ columnId: 'created', direction: 'desc' }}
          searchable={false}
          onRowClick={open}
          rowActions={rowMenu}
          rowTone={(row) => (row.status === 'requires_payment_method' ? 'danger' : 'default')}
          maxHeight={640}
          stickyFooter
          toolbar={
            <Inline gap={3} wrap>
              <TableSearch view={table} onChange={setTable} label="Search account, invoice or reason" />
              <Select
                size="sm"
                aria-label="Status"
                value={status}
                onChange={(value) => setStatus(value === 'all' ? undefined : value)}
                options={STATUS_FILTERS}
                icon={<Icons.filter size={14} />}
              />
              <Select
                size="sm"
                aria-label="Raised by"
                value={source}
                onChange={(value) => setSource(value || undefined)}
                options={[
                  { value: '', label: 'Raised by anyone' },
                  { value: 'invoice_collection', label: 'The collector' },
                  { value: 'dunning_retry', label: 'The recovery schedule' },
                  { value: 'manual_retry', label: 'By hand' },
                  { value: 'api', label: 'The API' },
                ]}
              />
              <div className="bl-acctfilter">
                <CustomerPicker
                  value={customer}
                  onChange={(value) => setCustomer(value || undefined)}
                  placeholder="Any account"
                  emptyOption="Any account"
                  size="sm"
                  label="Account"
                />
              </div>
              <MoneyRangeFilter
                value={range}
                onChange={(next) => setRangeParam(encodeRange(next) || undefined)}
                fields={[{ value: 'amount', label: 'Amount' }]}
                currencies={currencies}
                defaultCurrency={preferred}
              />
              <ExportCsvButton
                rows={visible}
                columns={csv}
                name="payments"
                noun="payments"
                disabled={!book.complete || !names.ready}
                reason={book.complete && names.ready ? undefined : 'Still reading the book — the file would hold fewer rows, or fewer names, than the screen.'}
              />
            </Inline>
          }
          empty={book.error
            ? <LoadFailedEmpty noun="payments" />
            : (
              <EmptyList
                title="No payment matches this filter"
                body="A payment is recorded every time a bill is presented to a method on file — by the collector when the bill is raised, by the recovery schedule when it retries, or by a person from the invoice."
              />
            )}
          footer={<BookFooter book={book} noun="payments" shown={visible.length} whole={whole} />}
        />
      </div>
      <p className="bl-gridnote">
        The total under Amount counts only payments that succeeded, one figure per currency — a declined presentation
        is a fact about a card, not money. Nothing is converted between currencies.
      </p>
    </>
  );
}

/* ================================= refunds ================================ */

function RefundsBook({ names }: { names: Names }) {
  const f = useBillingFormat();
  const navigate = useNavigate();
  const [customer, setCustomer] = useSearchParam('customer', '');
  const [table, setTable] = useTableView({ columnId: 'created', direction: 'desc' });
  const book = useBookList<Refund>('/v1/refunds', useMemo(() => ({ ...(customer ? { customer } : {}) }), [customer]));
  const whole = useBookTotal('/v1/refunds', {});

  const columns = useMemo<DataTableColumn<Refund>[]>(() => [
    {
      id: 'amount',
      header: 'Amount',
      pinned: true,
      width: 150,
      sortable: true,
      align: 'right',
      headerTitle: 'Amount',
      accessor: (row) => moneyRank(row.amount, row.currency),
      cell: (row) => <span className="bl-strong">{f.money(row.amount, { currency: row.currency })}</span>,
      total: (rows) => <MoneyTotals totals={totalsByCurrency(rows.filter((row) => row.status === 'succeeded'), (row) => row.amount, (row) => row.currency)} />,
    },
    {
      id: 'status',
      header: 'Status',
      width: 120,
      filter: 'set',
      accessor: (row) => row.status,
      filterOptionLabel: statusLabel,
      cell: (row) => <StatusPill status={row.status} />,
    },
    {
      id: 'reason',
      header: 'Reason',
      width: 200,
      filter: 'set',
      accessor: (row) => row.reason ?? '',
      filterOptionLabel: (value) => humanize(value),
      cell: (row) => (
        <div className="bl-cellstack">
          <span className="bl-cellstack__top">{humanize(row.reason ?? 'refund')}</span>
          {row.description && <span className="bl-cellstack__sub">{row.description}</span>}
        </div>
      ),
    },
    {
      id: 'customer',
      header: 'Account',
      width: 220,
      accessor: (row) => names.customerName(row.customer) ?? row.customer,
      cell: (row) => (
        <RecordLink to={customerHref(row.customer)}>
          {names.customerName(row.customer) ?? (names.ready ? 'Account since removed' : 'Reading the account…')}
        </RecordLink>
      ),
    },
    {
      id: 'invoice',
      header: 'Against',
      width: 150,
      accessor: (row) => names.invoiceOf(row.invoice)?.number ?? (row.invoice ?? ''),
      cell: (row) => {
        if (!row.invoice) return <span className="bl-muted">Not against a bill</span>;
        const invoice = names.invoiceOf(row.invoice);
        return (
          <RecordLink to={`${invoiceHref(row.invoice)}?tab=collection`}>
            {invoice?.number ?? (names.ready ? 'Invoice since removed' : 'Reading the invoice…')}
          </RecordLink>
        );
      },
    },
    {
      id: 'effect',
      header: 'What it did to the bill',
      accessor: (row) => row.invoice_effect ?? '',
      // A sentence, so it wraps to a second line rather than being cut mid-word;
      // the whole of it is on hover for the rare one that needs a third.
      cell: (row) => (row.invoice_effect
        ? <span className="bl-sub bl-clamp2" title={row.invoice_effect}>{row.invoice_effect}</span>
        : <span className="bl-muted">—</span>),
    },
    {
      id: 'created',
      header: 'When',
      width: 170,
      sortable: true,
      filter: 'date',
      accessor: (row) => row.created,
      cell: (row) => <span className="bl-nowrap">{f.dateTime(row.created)}</span>,
    },
  ], [f, names]);

  const visible = useMemo(() => visibleRows(book.rows, columns, table), [book.rows, columns, table]);

  const csv = useMemo<CsvColumn<Refund>[]>(() => [
    { header: 'Status', value: (row) => statusLabel(row.status) },
    { header: 'Currency', value: (row) => row.currency.toUpperCase() },
    { header: 'Amount', value: (row) => csvAmount(row.amount, row.currency) },
    { header: 'Reason', value: (row) => humanize(row.reason ?? 'refund') },
    { header: 'Note', value: (row) => row.description ?? '' },
    { header: 'Account', value: (row) => names.customerName(row.customer) ?? '' },
    { header: 'Invoice', value: (row) => names.invoiceOf(row.invoice)?.number ?? '' },
    { header: 'Effect on the bill', value: (row) => row.invoice_effect ?? '' },
    { header: 'Created', value: (row) => csvInstant(row.created) },
    { header: 'Customer id', value: (row) => row.customer },
    { header: 'Invoice id', value: (row) => row.invoice ?? '' },
    { header: 'Charge id', value: (row) => row.charge ?? '' },
    { header: 'Refund id', value: (row) => row.id },
  ], [names]);

  return (
    <>
      {book.error && <ListFailure error={book.error} path="GET /v1/refunds" onRetry={book.retry} />}
      <div className={book.loading ? 'bl-grid is-loading' : 'bl-grid'}>
        <DataTable
          rows={book.rows}
          columns={columns}
          getRowId={(row) => row.id}
          caption="Refunds"
          loading={book.loading}
          error={null}
          onRetry={book.retry}
          value={table}
          onChange={setTable}
          initialSort={{ columnId: 'created', direction: 'desc' }}
          searchable={false}
          onRowClick={(row) => navigate(row.invoice ? `${invoiceHref(row.invoice)}?tab=collection` : customerHref(row.customer))}
          maxHeight={640}
          stickyFooter
          toolbar={
            <Inline gap={3} wrap>
              <TableSearch view={table} onChange={setTable} label="Search account, invoice or reason" />
              <div className="bl-acctfilter">
                <CustomerPicker
                  value={customer}
                  onChange={(value) => setCustomer(value || undefined)}
                  placeholder="Any account"
                  emptyOption="Any account"
                  size="sm"
                  label="Account"
                />
              </div>
              <ExportCsvButton
                rows={visible}
                columns={csv}
                name="refunds"
                noun="refunds"
                disabled={!book.complete || !names.ready}
                reason={book.complete && names.ready ? undefined : 'Still reading the book — the file would hold fewer rows, or fewer names, than the screen.'}
              />
            </Inline>
          }
          empty={book.error
            ? <LoadFailedEmpty noun="refunds" />
            : (
              <EmptyList
                title="Nothing has been refunded"
                body="A refund is raised from the invoice that collected the money — open its Collection tab and choose Refund on the charge. The bill is owed again for the amount sent back."
                action={<Button variant="secondary" onClick={() => navigate('/billing/invoices?status=paid')}>Paid invoices</Button>}
              />
            )}
          footer={<BookFooter book={book} noun="refunds" shown={visible.length} whole={whole} />}
        />
      </div>
      <p className="bl-gridnote">
        A refund moves cash back and leaves the bill owed again for that amount; it never rewrites what was billed — that is
        a credit note. Totals are one figure per currency and nothing is converted.
      </p>
    </>
  );
}
