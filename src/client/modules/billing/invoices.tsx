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
import { api, useQuery, type ApiClientError, type ListEnvelope } from '../../kernel/api';
import { useNavigate, useParams, useSearchParam } from '../../kernel/router';
import { usePlatform } from '../../kernel/platform';
import {
  Badge, Banner, Button, Card, Checkbox, ConfirmDialog, DataTable, Divider, Drawer, EmptyState, Field, Grid,
  GridItem, Icons, Inline, Input, Modal, Page, Select, Stack, Tabs, Textarea, Tooltip, humanize, useToast,
  type DataTableColumn, type MenuSection, type TableState,
} from '../../design';
import { AlertTriangleIcon, CheckCircleIcon, ChevronDownIcon, ChevronUpIcon, CreditCardIcon, XCircleIcon } from '../../design';
import { ActionMenu, CustomerPicker, Headline } from './subscriptions';
import {
  EmptyList, FieldRow, ListFailure, ListFooter, LoadFailedEmpty, Loading, MoneyField, MoneyTotals, RecordLink,
  SectionError, StatusPill, TableSearch, breakdownLabel, formatUnitRate, lineWhy, prorationCopy, statusLabel,
  customerHref, idem, invoiceHref, moneyRank, subscriptionHref, totalsByCurrency, useAction, useBillingFormat,
  useCursorList, useDebounced, useOpenOnQuery, useRecordTab, useTableView,
} from './common';
import type {
  Charge, CreditNote, Invoice, InvoiceDunning, InvoiceLine, InvoicePayments, PaymentSettings, PendingItem,
} from './types';

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
        cell: (row) => <StatusPill status={row.status} title={row.status_detail} />,
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
        cell: (row) => <span className="bl-nowrap">{row.period_display}</span>,
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
        align: 'right',
        width: 120,
        sortable: true,
        headerTitle: 'Ranked inside each currency — nothing is converted.',
        accessor: (row) => moneyRank(row.total, row.currency),
        cell: (row) => row.total_display,
        total: (rows) => <MoneyTotals totals={totalsByCurrency(rows, (r) => r.total, (r) => r.currency)} />,
      },
      {
        id: 'total_amount',
        header: 'Total amount',
        headerTitle: 'Total amount — a filter, not a column',
        filterLabel: 'Total amount',
        filter: 'number',
        align: 'right',
        width: 120,
        defaultHidden: true,
        hideable: false,
        unsearchable: true,
        accessor: (row) => row.total,
      },
      {
        id: 'amount_due',
        header: 'Amount due',
        align: 'right',
        width: 130,
        sortable: true,
        headerTitle: 'Ranked inside each currency, and totalled one currency at a time.',
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
        id: 'amount_due_amount',
        header: 'Amount due value',
        headerTitle: 'Amount due — a filter, not a column',
        filterLabel: 'Amount due',
        filter: 'number',
        align: 'right',
        width: 130,
        defaultHidden: true,
        hideable: false,
        unsearchable: true,
        accessor: (row) => row.amount_due,
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
        cell: (row) => f.day(row.created),
      },
    );
    return columns;
  }, [f, showCustomer]);
}

/* ================================== list ================================== */

export function InvoicesPage() {
  const f = useBillingFormat();
  const navigate = useNavigate();
  const toast = useToast();
  const [status, setStatus] = useSearchParam('status', 'all');
  const [reason, setReason] = useSearchParam('reason', '');
  const [customer, setCustomer] = useSearchParam('customer', '');
  const [view, setView] = useTableView({ columnId: 'created', direction: 'desc' });
  const [selected, setSelected] = useState<string[]>([]);
  const [billing, setBilling] = useState(false);
  const [voiding, setVoiding] = useState<string[] | null>(null);
  useOpenOnQuery('new', useCallback(() => setBilling(true), []));

  const search = useDebounced(view.query.trim(), 250);
  const list = useCursorList<Invoice>('/v1/invoices', {
    status,
    ...(search ? { query: search } : {}),
    ...(customer ? { customer } : {}),
    ...(reason ? { billing_reason: reason } : {}),
  }, 100);
  const columns = useInvoiceColumns(true);

  // Acts on the rows the bulk bar actually hands over, which is the selection
  // minus anything the current filter hides unless the operator opted those in.
  const bulk = async (ids: string[], label: string, action: string, body?: unknown) => {
    let ok = 0;
    for (const id of ids) {
      try { await api.post(`/v1/invoices/${id}/${action}`, body ?? {}); ok++; } catch { /* reported below */ }
    }
    list.retry();
    setSelected([]);
    if (ok === ids.length) toast.success(`${label} ${ok} ${ok === 1 ? 'invoice' : 'invoices'}`);
    else toast.warning(`${label} ${ok} of ${ids.length}`, 'The rest were refused — a paid bill cannot be voided, and a draft cannot be paid.', { duration: 0 });
  };

  // What a bulk void would destroy, stated per currency because there is no
  // exchange-rate table here and one number across three books is not a number.
  const voidTargets = useMemo(
    () => list.rows.filter((row) => voiding?.includes(row.id)),
    [list.rows, voiding],
  );

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
      {list.error && <ListFailure error={list.error} path="GET /v1/invoices" onRetry={list.retry} />}
      <DataTable
        rows={list.rows}
        columns={columns}
        getRowId={(row) => row.id}
        caption="Invoices"
        loading={list.loading}
        error={null}
        onRetry={list.retry}
        value={view}
        onChange={setView}
        initialSort={{ columnId: 'created', direction: 'desc' }}
        searchable={false}
        selectable
        selected={selected}
        onSelectionChange={setSelected}
        onRowClick={(row) => navigate(invoiceHref(row.id))}
        maxHeight={640}
        stickyFooter
        toolbar={
          <Inline gap={3}>
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
          </Inline>
        }
        bulkActions={(ids) => (
          <Inline gap={3}>
            <Button size="sm" variant="secondary" onClick={() => { void bulk(ids, 'Finalised', 'finalize'); }}>Finalise {ids.length}</Button>
            <Button size="sm" variant="secondary" onClick={() => { void bulk(ids, 'Recorded payment on', 'pay', { note: 'Recorded in bulk from the invoice list.' }); }}>
              Mark {ids.length} paid
            </Button>
            <Button size="sm" variant="danger-ghost" onClick={() => setVoiding(ids)}>Void {ids.length}</Button>
          </Inline>
        )}
        empty={list.error
          ? <LoadFailedEmpty noun="invoices" />
          : (
            <EmptyList
              title="No invoice matches this filter"
              body="Bills are raised when a period opens, when a change is invoiced immediately, or when you bill an account by hand."
              action={<Button variant="primary" iconLeft={<Icons.plus size={15} />} onClick={() => setBilling(true)}>Bill an account</Button>}
            />
          )}
        footer={<ListFooter list={list} noun="invoices" />}
      />
      <BillNowDialog open={billing} onClose={() => setBilling(false)} />
      <ConfirmDialog
        open={voiding !== null}
        onCancel={() => setVoiding(null)}
        title={`Void ${voidTargets.length} ${voidTargets.length === 1 ? 'invoice' : 'invoices'}?`}
        body={`${voidTargets.map((row) => row.number).join(', ')} — `
          + `${f.list(totalsByCurrency(voidTargets, (r) => r.total, (r) => r.currency)
            .map((total) => f.money(total.amount, { currency: total.currency })))}`
          + ' — are withdrawn and stop being owed. Anything they swept up goes back to be billed later.'
          + ' There is no route that un-voids an invoice.'}
        confirmLabel={`Void ${voidTargets.length}`}
        onConfirm={() => {
          const ids = voiding ?? [];
          setVoiding(null);
          void bulk(ids, 'Voided', 'void');
        }}
      />
    </Page>
  );
}

export function BillNowDialog({ open, onClose, customer }: { open: boolean; onClose: () => void; customer?: string }) {
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
  const items = pending.data?.data ?? [];
  const currency = items[0]?.currency ?? 'usd';
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  const nothing = !pending.loading && !pending.error && !!customerId && items.length === 0;

  const submit = async () => {
    const invoice = await action.run(
      api.post<Invoice>('/v1/invoices', { customer: customerId }, { idempotencyKey: idem() }),
      {
        success: 'Invoice raised',
        description: 'Every proration waiting, the usage already settled and the account balance are on it.',
        failure: 'Nothing could be billed',
      },
      ['/v1/invoices', '/v1/customers', '/v1/subscriptions'],
    );
    if (invoice) { onClose(); navigate(invoiceHref(invoice.id)); }
  };

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
      <Stack gap={5}>
        <Field label="Customer" required error={action.errorFor('customer')}>
          {customer
            ? <Input value={customerId} readOnly aria-label="Customer" />
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
            No proration and no settled usage is unbilled here, so raising an invoice now would be refused.
            The recurring fee is billed when the next period opens.
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
                        {lineWhy(item.description, item.explanation) && (
                          <div className="bl-lines__why">{item.explanation}</div>
                        )}
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
          </Stack>
        )}
      </Stack>
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
  const [dialog, setDialog] = useState<null | 'pay' | 'credit'>(null);
  const [destroy, setDestroy] = useState<null | 'void' | 'uncollectible'>(null);
  const [docOpen, setDocOpen] = useState(false);

  const { data: invoice, error, loading, refetch } = useQuery<Invoice>(`/v1/invoices/${id}`);
  const notes = useQuery<ListEnvelope<CreditNote>>('/v1/credit_notes', { invoice: id, status: 'all', limit: 50 });

  if (loading) return <Page title="Invoice"><Loading label="Loading this invoice…" /></Page>;
  if (error || !invoice) {
    return (
      <Page title="Invoice" eyebrow="Revenue">
        <Card>
          <SectionError
            error={error ?? ({ status: 404, body: { message: 'No invoice came back.' } } as ApiClientError)}
            path={`GET /v1/invoices/${id}`}
            onRetry={refetch}
          />
        </Card>
      </Page>
    );
  }

  const act = (path: string, copy: { success: string; description?: string; failure: string }) => {
    void action.run(api.post<Invoice>(path, {}), copy, ['/v1/invoices', '/v1/customers', '/v1/subscriptions']);
  };

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
  const sections: MenuSection[] = [
    {
      id: 'money',
      label: 'Money',
      items: [
        { id: 'credit', label: 'Issue a credit note…', icon: <Icons.receipt size={14} />, disabled: invoice.status === 'draft' || invoice.status === 'void', onSelect: () => setDialog('credit') },
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
      ],
    },
    {
      id: 'doc',
      label: 'Document',
      items: [
        { id: 'preview', label: 'Open the printable document', icon: <Icons.print size={14} />, onSelect: () => setDocOpen(true) },
        { id: 'tab', label: 'Open it in a new tab', icon: <Icons.external size={14} />, onSelect: () => window.open(`/api${invoice.document_url}`, '_blank', 'noopener') },
      ],
    },
    {
      id: 'status',
      label: 'Change the status',
      items: [
        {
          id: 'finalize',
          label: 'Finalise this draft',
          icon: <Icons.check size={14} />,
          disabled: invoice.status !== 'draft',
          onSelect: () => act(`/v1/invoices/${invoice.id}/finalize`, { success: 'Invoice finalised', description: 'It is now owed and carries a due date.', failure: 'It could not be finalised' }),
        },
        {
          id: 'void',
          label: 'Void this invoice…',
          icon: <XCircleIcon size={14} />,
          danger: true,
          disabled: invoice.status === 'paid' || invoice.status === 'void',
          onSelect: () => setDestroy('void'),
        },
        {
          id: 'uncollectible',
          label: 'Write it off…',
          icon: <AlertTriangleIcon size={14} />,
          danger: true,
          disabled: invoice.status !== 'open',
          onSelect: () => setDestroy('uncollectible'),
        },
      ],
    },
  ];

  return (
    <Page
      title={invoice.number}
      eyebrow="Invoice"
      badge={<span style={{ marginLeft: 'var(--space-4)' }}><StatusPill status={invoice.status} title={invoice.status_detail} /></span>}
      subtitle={invoice.status_detail}
      breadcrumbs={
        <Inline gap={3}>
          <RecordLink to="/billing/invoices">Invoices</RecordLink>
          <span className="bl-muted">/</span>
          <RecordLink to={customerHref(invoice.customer)}>{invoice.customer_name ?? invoice.customer}</RecordLink>
        </Inline>
      }
      actions={
        <Inline gap={3}>
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
          <Button variant="secondary" iconLeft={<Icons.print size={15} />} onClick={() => setDocOpen(true)}>Document</Button>
          <Button
            variant="primary"
            iconLeft={<CheckCircleIcon size={15} />}
            disabled={invoice.amount_due <= 0 || invoice.status === 'void'}
            onClick={() => setDialog('pay')}
          >
            Record payment
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
            <Headline label="Total" value={invoice.total_display} caption={invoice.period_display} />
            <Headline
              label="Amount due"
              value={invoice.amount_due_display}
              caption={
                invoice.amount_due <= 0
                  ? (invoice.paid_at ? `Settled ${f.date(invoice.paid_at, { withYear: true })}` : 'Nothing is owed on it')
                  : invoice.due_date ? `Due ${f.day(invoice.due_date)}` : 'Payable on receipt'
              }
            />
            <Headline label="Paid" value={f.money(invoice.amount_paid, { currency: invoice.currency })} caption={invoice.paid_at ? f.date(invoice.paid_at) : 'Nothing collected yet'} />
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
        {invoice.payment_note && <Banner tone="info" title="Payment note">{invoice.payment_note}</Banner>}

        {tab === 'lines' && <LinesTab invoice={invoice} />}
        {tab === 'collection' && hasPayments && <CollectionTab invoice={invoice} onRetry={() => act(`/v1/invoices/${invoice.id}/retry`, {
          success: 'Presented for collection',
          description: 'The attempt is recorded against the recovery campaign like any other.',
          failure: 'The collection attempt failed',
        })} busy={action.busy} />}
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
      <ConfirmDialog
        open={destroy !== null}
        onCancel={() => setDestroy(null)}
        loading={action.busy}
        title={destroy === 'uncollectible' ? `Write off ${invoice.number}?` : `Void ${invoice.number}?`}
        body={destroy === 'uncollectible'
          ? `${invoice.amount_due_display} owed by ${invoice.customer_name ?? invoice.customer} stops being chased and is `
            + 'recognised as a loss. The bill stays on the books and stays owed — it is simply not going to be collected. '
            + 'There is no route that un-writes it off.'
          : `${invoice.total_display} billed to ${invoice.customer_name ?? invoice.customer} is withdrawn. `
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
function CollectionTab({ invoice, onRetry, busy }: { invoice: Invoice; onRetry: () => void; busy: boolean }) {
  const f = useBillingFormat();
  const navigate = useNavigate();
  const { data, error, loading, refetch } = useQuery<InvoicePayments>(`/v1/invoices/${invoice.id}/payments`);
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
          {data.charges.map((charge) => <ChargeRow key={charge.id} charge={charge} />)}
        </Card>

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
          <Card title="Refunds" description="Money sent back against this bill.">
            {data.refunds.map((refund) => (
              <div key={refund.id} className="bl-row">
                <div className="bl-row__main">
                  <div className="bl-row__title">{refund.description ?? humanize(refund.reason ?? 'refund')}</div>
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
        <Field label="Why" optional hint="Recorded on the campaign, for whoever reads the recovery queue next." error={action.errorFor('reason')}>
          <Input
            value={reason}
            maxLength={500}
            placeholder="Finance is collecting this one by bank transfer"
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
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
      )}
    </Modal>
  );
}

function ChargeRow({ charge }: { charge: Charge }) {
  const f = useBillingFormat();
  const ok = charge.status === 'succeeded';
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
          {charge.payment_method ? ` · ${charge.payment_method}` : ''}
        </div>
      </div>
      <div className="bl-row__aside">
        <div>{f.money(charge.amount, { currency: charge.currency })}</div>
        <div className="bl-sub"><StatusPill status={ok ? 'paid' : 'unpaid'} /></div>
      </div>
    </div>
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
            {invoice.balance_applied !== 0 && (
              <div className="bl-total">
                <span className="bl-total__label">Account balance applied</span>
                <span className="bl-total__value">{invoice.balance_applied_display}</span>
              </div>
            )}
            <div className="bl-total bl-total--grand"><span className="bl-total__label">Total</span><span className="bl-total__value">{invoice.total_display}</span></div>
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
          <FieldRow label="Service period">{invoice.period_display}</FieldRow>
          {invoice.arrears_period && (
            <FieldRow label="Usage settled" hint="The window whose metered usage this bill settles, in arrears.">
              {f.dayRange(invoice.arrears_period.start, invoice.arrears_period.end)}
            </FieldRow>
          )}
          {/* Two clocks, and saying which is which is the difference between a
              record and a puzzle. Issued and finalised are the document's own
              dates, which the engine sets on a UTC calendar and the printable
              page prints the same way. Paid and voided are things that happened,
              stamped on the operator's own clock. */}
          <FieldRow label="Issued" hint="The date on the document, as the customer's copy prints it.">
            {f.day(invoice.created, { withYear: true })}
          </FieldRow>
          {invoice.finalized_at && (
            <FieldRow label="Finalised">{f.day(invoice.finalized_at, { withYear: true })}</FieldRow>
          )}
          {invoice.paid_at && (
            <FieldRow label="Paid" hint={`Recorded at ${f.timeZone.replace(/_/g, ' ')} time.`}>
              {f.dateTime(invoice.paid_at)}
            </FieldRow>
          )}
          {invoice.voided_at && (
            <FieldRow label="Voided" hint={`Recorded at ${f.timeZone.replace(/_/g, ' ')} time.`}>
              {f.dateTime(invoice.voided_at)}
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

function DocumentCard({ invoice }: { invoice: Invoice }) {
  return (
    <Card
      title="The printable document"
      description="One self-contained page — the issuer and bill-to blocks, every line with its window, the tax grouped by rate and how to pay."
      actions={
        <Button size="sm" variant="secondary" iconLeft={<Icons.external size={13} />} href={`/api${invoice.document_url}`} target="_blank" rel="noopener">
          Open in a new tab
        </Button>
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
            <div className="bl-sub">{f.day(note.created)}</div>
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

function RecordPaymentDialog({ invoice, open, onClose }: { invoice: Invoice; open: boolean; onClose: () => void }) {
  const action = useAction();
  const [note, setNote] = useState('');
  useEffect(() => { if (open) { setNote(''); action.clear(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    const result = await action.run(
      api.post<Invoice>(`/v1/invoices/${invoice.id}/pay`, note.trim() ? { note: note.trim() } : {}, { idempotencyKey: idem() }),
      {
        success: `${invoice.number} marked paid`,
        description: invoice.subscription
          ? 'A subscription that was past due comes back to active on the invoice that clears it.'
          : 'Anything collected beyond what was owed stays on the account as credit.',
        failure: 'The payment was not recorded',
      },
      ['/v1/invoices', '/v1/customers', '/v1/subscriptions', '/v1/revenue'],
    );
    if (result) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Record payment of ${invoice.amount_due_display}`}
      description="For money collected outside the platform — a transfer, a cheque, an offset against a purchase order."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={action.busy} onClick={() => { void submit(); }}>Record the payment</Button>
        </>
      }
    >
      <Field label="How it was collected" optional error={action.errorFor('note')} counter={{ value: note.length, max: 300 }}>
        <Input
          value={note}
          maxLength={300}
          placeholder="Bank transfer, reference NW-4471"
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
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
