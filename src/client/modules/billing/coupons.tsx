/**
 * Discounts: the coupons this workspace has agreed to, and the codes that hand
 * them out.
 *
 * The catalogue has had coupons, promotion codes and redemption rows with full
 * CRUD for a while, and the deal desk's standing 20% was attached to four live
 * subscriptions — with nothing in the product that could show any of it. The
 * only way to answer "what have we promised, to whom, and for how long?" was
 * `GET /v1/coupons` in a terminal.
 *
 * Two rules this screen keeps, both of them the price book's.
 *
 * **Nothing here computes a discount.** What a coupon takes off is
 * `coupon.summary` and the display strings beside it, written by the catalogue
 * in the workspace's locale; what it took off a particular bill is on that
 * bill. A second rounding rule in the browser would eventually disagree with
 * an invoice, and the invoice is the one the customer has.
 *
 * **Terms freeze on first redemption.** `editable` on the record says so, and
 * the screen offers archiving rather than editing once it is false — a coupon
 * that has cut an invoice has to keep saying what it cut, so a campaign that
 * needs different terms is a new coupon and a new code.
 */
import { useCallback, useMemo, useState } from 'react';
import { api, useQuery, type ApiClientError, type ListEnvelope } from '../../kernel/api';
import { useNavigate, useParams, useSearchParam } from '../../kernel/router';
import { useCurrentCrumb } from '../../kernel/shell';
import {
  Badge, Banner, Button, Card, DataTable, DatePicker, Divider, EmptyState, Field, Grid, GridItem, Icons, Inline,
  Input, Modal, NumberInput, Page, Select, Stack, Switch, Tooltip, humanize,
  type DataTableColumn, type MenuSection,
} from '../../design';
import { XCircleIcon } from '../../design';
import {
  BookFooter, DialogFields, ExportCsvButton, FieldRow, ListFailure, LoadFailedEmpty, Loading, MoneyField,
  PreviewFailure, RecordLink, RecordMissing, StatusPill, TableSearch, copyFormat, csvDay, customerHref, idem,
  invoiceHref, statusLabel, subscriptionHref, useAction, useBillingFormat, useBookList, useBookTotal, useDebounced,
  useDialogForm, useOpenOnQuery, useRecord, useTableView, visibleRows,
} from './common';
import { ActionMenu } from './subscriptions';
import { productHref } from './pricebook';
import {
  couponBody, couponCeilingWords, couponDraftBlocker, couponDurationWords, couponRedemptionWords, couponScopeWords,
  couponStanding, promotionCodeRestrictionWords, type CouponDraft,
} from './copy';
import type { CsvColumn } from './common';
import type {
  CatalogCurrency, Coupon, CouponDetail, CouponRedemption, Customer, Price, Product, PromotionCode,
} from './types';

/* ------------------------------- vocabulary ------------------------------- */

export const couponHref = (id: string): string => `/catalog/coupons/${id}`;

/** What each duration means for something that renews, in one line. */
const DURATION_COPY: Record<string, string> = {
  once: 'Comes off the first bill and then stops, however long the subscription runs.',
  repeating: 'Comes off a fixed number of billing periods — the concession a "20% off year one" really is.',
  forever: 'Comes off every bill for as long as the subscription lives.',
};

const DURATIONS = ['once', 'repeating', 'forever'] as const;

/**
 * The standing badge. Three of the four words are the kit's own lifecycle
 * vocabulary; a coupon redeemed to its ceiling is not, because the kit already
 * spends `exhausted` on a dunning campaign it has given up chasing.
 */
function CouponStandingPill({ coupon }: { coupon: Pick<Coupon, 'active' | 'invalid_reason' | 'invalid_message'> }) {
  const standing = couponStanding(coupon);
  if (standing === 'fully_redeemed') {
    return (
      <Tooltip content={coupon.invalid_message ?? 'Every redemption this campaign allowed has been taken.'}>
        <span className="ain-statuspill"><Badge tone="warning" dot pill>Fully redeemed</Badge></span>
      </Tooltip>
    );
  }
  const status = standing === 'live' ? 'active' : standing;
  return <StatusPill status={status} title={coupon.invalid_message ?? undefined} />;
}

const couponName = (coupon: Pick<Coupon, 'id' | 'name'>): string => coupon.name || coupon.id;

/* --------------------------------- the list -------------------------------- */

export function CouponsPage() {
  const f = useBillingFormat();
  const navigate = useNavigate();
  const [standing, setStanding] = useSearchParam('standing', 'live');
  const [duration, setDuration] = useSearchParam('duration', '');
  const [view, setView] = useTableView({ columnId: 'created', direction: 'desc' });
  const [creating, setCreating] = useState(false);
  useOpenOnQuery('new', useCallback(() => setCreating(true), []));

  const search = useDebounced(view.query.trim(), 250);
  const book = useBookList<Coupon>('/v1/coupons', useMemo(() => ({
    ...(search ? { query: search } : {}),
    ...(duration ? { duration } : {}),
    ...(standing === 'live' ? { active: true } : standing === 'archived' ? { active: false } : {}),
  }), [search, duration, standing]));
  const whole = useBookTotal('/v1/coupons', {});

  // The codes are read once for the whole screen rather than per row: a coupon
  // with no code is negotiated by the deal desk and a coupon with three is a
  // campaign, and that is the difference this column exists to show.
  const codes = useQuery<ListEnvelope<PromotionCode>>('/v1/promotion_codes', { limit: 200 });
  const codesByCoupon = useMemo(() => {
    const map = new Map<string, PromotionCode[]>();
    for (const code of codes.data?.data ?? []) {
      const bucket = map.get(code.coupon) ?? [];
      bucket.push(code);
      map.set(code.coupon, bucket);
    }
    return map;
  }, [codes.data]);

  const columns = useMemo<DataTableColumn<Coupon>[]>(() => [
    {
      id: 'name',
      header: 'Coupon',
      pinned: true,
      width: 300,
      sortable: true,
      accessor: (row) => couponName(row),
      cell: (row) => (
        <div className="bl-cellstack">
          <RecordLink to={couponHref(row.id)}>{couponName(row)}</RecordLink>
          <span className="bl-cellstack__sub">{row.summary}</span>
        </div>
      ),
    },
    {
      id: 'takes_off',
      header: 'Takes off',
      width: 130,
      align: 'right',
      // Ranked on the figure, not on the string: "9%" sorts above "10%" as text.
      accessor: (row) => row.percent_off_basis_points ?? row.amount_off ?? 0,
      cell: (row) => (
        <span className="bl-strong">{row.percent_off_display ?? row.amount_off_display ?? '—'}</span>
      ),
    },
    {
      id: 'duration',
      header: 'For how long',
      width: 160,
      filter: 'set',
      accessor: (row) => couponDurationWords(row),
      cell: (row) => (
        <Tooltip content={DURATION_COPY[row.duration]}>
          <span className="bl-sub">{couponDurationWords(row)}</span>
        </Tooltip>
      ),
    },
    {
      id: 'scope',
      header: 'Applies to',
      width: 150,
      accessor: (row) => couponScopeWords(row),
      cell: (row) => <span className="bl-sub">{couponScopeWords(row)}</span>,
    },
    {
      id: 'redeemed',
      header: 'Redeemed',
      width: 160,
      sortable: true,
      accessor: (row) => row.times_redeemed,
      cell: (row) => (
        <div className="bl-cellstack">
          <span>{f.number(row.times_redeemed)}</span>
          <span className="bl-cellstack__sub">{couponCeilingWords(row)}</span>
        </div>
      ),
    },
    {
      id: 'codes',
      header: 'Codes',
      width: 170,
      accessor: (row) => (codesByCoupon.get(row.id) ?? []).length,
      cell: (row) => {
        const rows = codesByCoupon.get(row.id) ?? [];
        // "Attached by hand" is a claim this column cannot make while the codes
        // are unread or the read failed — an empty map would print it for every
        // coupon in the workspace.
        if (codes.error) return <Tooltip content="The promotion codes could not be read."><span className="bl-muted">—</span></Tooltip>;
        if (codes.loading && !codes.data) return <span className="bl-muted">…</span>;
        if (rows.length === 0) return <span className="bl-muted">Attached by hand</span>;
        return (
          <span className="u-mono bl-sub">{rows.slice(0, 2).map((code) => code.code).join(' · ')}
            {rows.length > 2 ? ` +${rows.length - 2}` : ''}
          </span>
        );
      },
    },
    {
      id: 'redeem_by',
      header: 'Redeem by',
      width: 140,
      sortable: true,
      defaultHidden: true,
      accessor: (row) => row.redeem_by ?? 0,
      cell: (row) => (row.redeem_by ? <span>{f.day(row.redeem_by, { withYear: true })}</span> : <span className="bl-muted">No end date</span>),
    },
    {
      id: 'created',
      header: 'Created',
      width: 130,
      sortable: true,
      defaultHidden: true,
      accessor: (row) => row.created,
      cell: (row) => <span className="bl-sub">{f.day(row.created, { withYear: true })}</span>,
    },
    {
      id: 'standing',
      header: 'Standing',
      width: 140,
      filter: 'set',
      accessor: (row) => couponStanding(row),
      filterOptionLabel: (value) => STANDING_LABEL[value] ?? value,
      cell: (row) => <CouponStandingPill coupon={row} />,
    },
  ], [f, codesByCoupon, codes.loading, codes.data, codes.error]);

  const visible = useMemo(() => visibleRows(book.rows, columns, view), [book.rows, columns, view]);

  const csv = useMemo<CsvColumn<Coupon>[]>(() => [
    { header: 'Coupon', value: (row) => couponName(row) },
    { header: 'What it takes off', value: (row) => row.summary },
    { header: 'Percent off', value: (row) => row.percent_off_display ?? '' },
    { header: 'Amount off', value: (row) => row.amount_off_display ?? '' },
    { header: 'Currency', value: (row) => (row.currency ?? '').toUpperCase() },
    { header: 'For how long', value: (row) => couponDurationWords(row) },
    { header: 'Applies to', value: (row) => couponScopeWords(row) },
    { header: 'Times redeemed', value: (row) => row.times_redeemed },
    { header: 'Redemption ceiling', value: (row) => row.max_redemptions ?? '' },
    { header: 'Redeem by', value: (row) => csvDay(row.redeem_by) },
    { header: 'Standing', value: (row) => STANDING_LABEL[couponStanding(row)] },
    { header: 'Codes', value: (row) => (codesByCoupon.get(row.id) ?? []).map((code) => code.code).join(' ') },
    { header: 'Coupon id', value: (row) => row.id },
  ], [codesByCoupon]);

  return (
    <Page
      title="Discounts"
      eyebrow="Revenue"
      subtitle="Every coupon this workspace has agreed to, what it takes off and for how long, and the codes that hand it out."
      actions={
        <Inline gap={3}>
          <Button variant="secondary" iconLeft={<Icons.tag size={15} />} onClick={() => navigate('/catalog/products')}>
            Price book
          </Button>
          <Button variant="primary" iconLeft={<Icons.plus size={15} />} onClick={() => setCreating(true)}>New coupon</Button>
        </Inline>
      }
    >
      {book.error && <ListFailure error={book.error} path="GET /v1/coupons" onRetry={book.retry} />}
      <div className={book.loading ? 'bl-grid is-loading' : 'bl-grid'}>
        <DataTable
          rows={book.rows}
          columns={columns}
          getRowId={(row) => row.id}
          caption="Coupons"
          loading={book.loading}
          error={null}
          onRetry={book.retry}
          value={view}
          onChange={setView}
          initialSort={{ columnId: 'created', direction: 'desc' }}
          searchable={false}
          onRowClick={(row) => navigate(couponHref(row.id))}
          maxHeight={640}
          stickyFooter
          empty={book.error
            ? <LoadFailedEmpty noun="coupons" />
            : (
              <EmptyState
                size="sm"
                inline
                illustration={null}
                title={standing === 'archived' ? 'Nothing has been archived' : 'No coupon has been agreed yet'}
                body={standing === 'archived'
                  ? 'A coupon is archived rather than deleted once it has been redeemed, so the invoices it cut keep explaining themselves.'
                  : 'A coupon is the concession; a promotion code is one way of handing it out. Create the coupon first — a code needs one to point at.'}
                action={<Button size="sm" variant="primary" onClick={() => setCreating(true)}>New coupon</Button>}
              />
            )}
          toolbar={
            <Inline gap={3} wrap>
              <TableSearch view={view} onChange={setView} label="Search coupons" />
              <Select
                size="sm"
                aria-label="Filter by duration"
                value={duration}
                onChange={(value) => setDuration(value || undefined)}
                icon={<Icons.filter size={14} />}
                options={[
                  { value: '', label: 'Any duration' },
                  { value: 'once', label: 'The first bill only' },
                  { value: 'repeating', label: 'A fixed number of periods' },
                  { value: 'forever', label: 'Every bill, without end' },
                ]}
              />
              <Select
                size="sm"
                aria-label="Standing"
                value={standing}
                onChange={(value) => setStanding(value === 'live' ? undefined : value)}
                // Not "redeemable today": `active` is only whether the campaign
                // has been archived. Whether it can still be redeemed also
                // depends on its date and its ceiling, which is what the
                // Standing column says for each row.
                options={[
                  { value: 'live', label: 'Live campaigns' },
                  { value: 'archived', label: 'Archived' },
                  { value: 'all', label: 'Everything' },
                ]}
              />
            </Inline>
          }
          toolbarEnd={<ExportCsvButton rows={visible} columns={csv} name="coupons" noun="coupons" />}
          footer={<BookFooter book={book} noun="coupons" shown={visible.length} whole={whole} />}
        />
      </div>
      <CouponCreateDialog open={creating} onClose={() => setCreating(false)} />
    </Page>
  );
}

/**
 * The filter menu's and the CSV's word for each standing — the same word the
 * badge shows, so a column cannot be filtered by a name it never prints. The
 * first three are `statusLabel`'s; only the fourth is this screen's own.
 */
const STANDING_LABEL: Record<string, string> = {
  live: statusLabel('active'),
  archived: statusLabel('archived'),
  expired: statusLabel('expired'),
  fully_redeemed: 'Fully redeemed',
};

/* -------------------------------- the record ------------------------------- */

export function CouponDetailPage() {
  const { id } = useParams();
  const f = useBillingFormat();
  const action = useAction();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<null | 'code'>(null);
  const { data, error, loading, refetch } = useRecord<CouponDetail>(`/v1/coupons/${id}`);
  useCurrentCrumb(data ? couponName(data) : undefined);

  if (loading) return <Page title="Coupon"><Loading label="Reading the coupon…" /></Page>;
  if (error || !data) {
    return (
      <Page title="Coupon" eyebrow="Discounts">
        <Card>
          <RecordMissing
            error={error ?? ({ status: 404, body: { message: `No coupon with the id ${id}.` } } as ApiClientError)}
            path={`GET /v1/coupons/${id}`}
            onRetry={refetch}
            noun="coupon"
            backTo="/catalog/coupons"
            backLabel="Back to the discounts"
          />
        </Card>
      </Page>
    );
  }

  const setActive = (active: boolean) => action.run(
    api.patch<Coupon>(`/v1/coupons/${data.id}`, { active }),
    {
      success: active ? `${couponName(data)} can be redeemed again` : `${couponName(data)} archived`,
      description: active
        ? 'It can be attached to an account again, and its codes resolve to it once more.'
        : 'Nothing new can redeem it. The discounts already running on it carry on to the end of their duration, and the invoices it cut keep explaining themselves.',
      failure: 'That change was refused',
    },
    ['/v1/coupons', '/v1/promotion_codes'],
  ).then(() => refetch());

  const sections: MenuSection[] = [{
    id: 'coupon',
    items: [
      { id: 'code', label: 'Add a promotion code…', icon: <Icons.plus size={14} />, onSelect: () => setDialog('code') },
      data.active
        ? { id: 'archive', label: 'Archive it', icon: <XCircleIcon size={14} />, danger: true, onSelect: () => { void setActive(false); } }
        : { id: 'restore', label: 'Make it redeemable again', icon: <Icons.refresh size={14} />, onSelect: () => { void setActive(true); } },
    ],
  }];

  return (
    <Page
      title={couponName(data)}
      eyebrow="Discounts"
      badge={<span style={{ marginLeft: 'var(--space-4)' }}><CouponStandingPill coupon={data} /></span>}
      subtitle={data.summary}
      actions={
        <Inline gap={3}>
          <Button variant="secondary" iconLeft={<Icons.list size={15} />} onClick={() => navigate('/catalog/coupons')}>
            Every discount
          </Button>
          <Button variant="primary" iconLeft={<Icons.plus size={15} />} onClick={() => setDialog('code')}>Add a code</Button>
          <ActionMenu sections={sections} label="More coupon actions" />
        </Inline>
      }
    >
      <Stack gap={6}>
        {!data.valid && data.invalid_message && (
          <Banner tone={data.active ? 'warning' : 'info'} title="This coupon cannot be redeemed">
            {data.invalid_message}
            {' The discounts already attached to accounts on it are unaffected — a concession that is running keeps '}
            running to the end of its duration.
          </Banner>
        )}
        {!data.editable && data.active && (
          <Banner tone="info" compact title="Its terms are frozen">
            {`${couponName(data)} has been redeemed ${f.plural(data.times_redeemed, 'time')}, so what it is worth — the `}
            percentage, the currency, the duration and what it applies to — can no longer change. An invoice that took
            this discount has to keep saying what it took. A campaign on different terms is a new coupon and a new code.
          </Banner>
        )}

        <div className="bl-cols">
          <Stack gap={6}>
            <PromotionCodesCard coupon={data} onChanged={refetch} onAdd={() => setDialog('code')} />
            <RedemptionsCard coupon={data} />
          </Stack>

          <Stack gap={6}>
            <Card title="The offer" description="What this coupon takes off, and every condition on it.">
              <div className="bl-schedmeta">
                <FieldRow label="Takes off" hint="Written by the catalogue in this workspace's locale.">
                  {data.percent_off_display ?? data.amount_off_display ?? '—'}
                </FieldRow>
                <FieldRow label="For how long" hint={DURATION_COPY[data.duration]}>
                  {couponDurationWords(data)}
                </FieldRow>
                <FieldRow label="Applies to" hint="A line qualifies only by naming one of these; both lists empty is the whole bill.">
                  {couponScopeWords(data)}
                </FieldRow>
                <FieldRow label="Redeemed">{couponRedemptionWords(data)}</FieldRow>
                <FieldRow label="Redeem by" hint="After this, the coupon stops being redeemable — running discounts are not touched.">
                  {data.redeem_by ? `${f.day(data.redeem_by, { withYear: true })} · ${f.relative(data.redeem_by)}` : 'No end date'}
                </FieldRow>
                <FieldRow label="Created">{f.day(data.created, { withYear: true })}</FieldRow>
                <FieldRow label="Id"><span className="u-mono bl-sub">{data.id}</span></FieldRow>
              </div>
              {Object.keys(data.metadata).length > 0 && (
                <>
                  <Divider />
                  <div className="bl-schedmeta">
                    {Object.entries(data.metadata).map(([key, value]) => (
                      <FieldRow key={key} label={humanize(key)}>{value}</FieldRow>
                    ))}
                  </div>
                </>
              )}
            </Card>
            <CouponScopeCard coupon={data} />
          </Stack>
        </div>
      </Stack>

      <PromotionCodeCreateDialog coupon={data} open={dialog === 'code'} onClose={() => setDialog(null)} onCreated={refetch} />
    </Page>
  );
}

/**
 * What the coupon is narrowed to, resolved to the things it names.
 *
 * A restriction shown as `price_nw_starter_monthly` is a restriction nobody
 * can check. The price book is asked what those ids are, and each one links
 * back to the product it belongs to.
 */
function CouponScopeCard({ coupon }: { coupon: CouponDetail }) {
  const ids = [...coupon.applies_to.products, ...coupon.applies_to.prices];
  const products = useQuery<ListEnvelope<Product>>('/v1/products', { limit: 200 }, { enabled: ids.length > 0 });
  const prices = useQuery<ListEnvelope<Price>>('/v1/prices', { limit: 200 }, { enabled: coupon.applies_to.prices.length > 0 });
  if (ids.length === 0) return null;

  const productById = new Map((products.data?.data ?? []).map((row) => [row.id, row]));
  const priceById = new Map((prices.data?.data ?? []).map((row) => [row.id, row]));

  return (
    <Card
      title="Narrowed to"
      description="Only a line naming one of these takes the discount; everything else on the bill is charged at list."
    >
      {(products.loading || prices.loading) && <Loading label="Reading the price book…" />}
      {coupon.applies_to.products.map((productId) => {
        const product = productById.get(productId);
        return (
          <div key={productId} className="bl-row">
            <div className="bl-row__main">
              <div className="bl-row__title">
                <RecordLink to={productHref(productId)}>{product?.name ?? productId}</RecordLink>
              </div>
              <div className="bl-row__sub">Every price on this product</div>
            </div>
            <div className="bl-row__aside"><Badge tone="neutral">Product</Badge></div>
          </div>
        );
      })}
      {coupon.applies_to.prices.map((priceId) => {
        const price = priceById.get(priceId);
        return (
          <div key={priceId} className="bl-row">
            <div className="bl-row__main">
              <div className="bl-row__title">
                {price?.product
                  ? <RecordLink to={productHref(price.product)}>{price.nickname || price.product_name || priceId}</RecordLink>
                  : <span className="u-mono">{priceId}</span>}
              </div>
              <div className="bl-row__sub">{price?.display?.summary ?? 'This price only'}</div>
            </div>
            <div className="bl-row__aside"><Badge tone="neutral">Price</Badge></div>
          </div>
        );
      })}
    </Card>
  );
}

/* ----------------------------- promotion codes ---------------------------- */

function PromotionCodesCard({ coupon, onChanged, onAdd }: {
  coupon: CouponDetail; onChanged: () => void; onAdd: () => void;
}) {
  const f = useBillingFormat();
  const action = useAction();
  const codes = coupon.promotion_codes;
  // Which code is being switched, so one write does not put every button on
  // the card into a spinner.
  const [pending, setPending] = useState<string | null>(null);

  const setActive = (code: PromotionCode, active: boolean) => action.run(
    api.patch<PromotionCode>(`/v1/promotion_codes/${code.id}`, { active }),
    {
      success: active ? `${code.code} works again` : `${code.code} switched off`,
      description: active
        ? 'A customer typing it is offered the coupon again.'
        : 'A customer typing it is told it cannot be used. The discounts it already granted are untouched.',
      failure: 'That change was refused',
    },
    ['/v1/promotion_codes', `/v1/coupons/${coupon.id}`],
  ).then(() => { setPending(null); onChanged(); });

  return (
    <Card
      title="Promotion codes"
      description={codes.length
        ? 'What a customer types to get this coupon. Two codes for one coupon can carry different expiries, ceilings and floors.'
        : 'Nothing hands this coupon out by code — it is attached to an account or a subscription by hand.'}
      actions={<Button size="sm" variant="secondary" iconLeft={<Icons.plus size={13} />} onClick={onAdd}>Add a code</Button>}
    >
      {codes.length === 0 && (
        <EmptyState
          size="sm"
          inline
          illustration={null}
          title="No code points at this coupon"
          body="A coupon is the concession and a code is one way of handing it out. Without one, only the deal desk can attach this — which is exactly right for a negotiated discount."
          action={<Button size="sm" variant="primary" onClick={onAdd}>Add a code</Button>}
        />
      )}
      {codes.map((code) => {
        const restrictions = promotionCodeRestrictionWords(code, copyFormat(f));
        return (
          <div key={code.id} className="bl-row">
            <div className="bl-row__main">
              <div className="bl-row__title"><span className="u-mono">{code.code}</span></div>
              <div className="bl-row__sub">
                {restrictions.length ? restrictions.join(' · ') : 'No restrictions of its own'}
              </div>
            </div>
            <div className="bl-row__aside">
              <div>{f.plural(code.times_redeemed, 'redemption')}</div>
              <div className="bl-sub">
                <Inline gap={2}>
                  <StatusPill status={code.active ? 'active' : 'inactive'} />
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={pending === code.id}
                    disabled={action.busy && pending !== code.id}
                    aria-label={`${code.active ? 'Switch off' : 'Switch on'} ${code.code}`}
                    onClick={() => { setPending(code.id); void setActive(code, !code.active); }}
                  >
                    {code.active ? 'Switch off' : 'Switch on'}
                  </Button>
                </Inline>
              </div>
            </div>
          </div>
        );
      })}
    </Card>
  );
}

/* -------------------------------- redemptions ------------------------------ */

/**
 * Who has taken this coupon up, and what holds each one.
 *
 * `times_redeemed` is counted from exactly these rows, so the card states the
 * server's total beside the rows it could read rather than counting them again
 * and quietly disagreeing when a page is missing.
 */
function RedemptionsCard({ coupon }: { coupon: CouponDetail }) {
  const f = useBillingFormat();
  const redemptions = useQuery<ListEnvelope<CouponRedemption>>(`/v1/coupons/${coupon.id}/redemptions`, { limit: 200 });
  // The rows carry customer ids; every other screen prints names. The book is
  // read once and the id stays the fallback for an account since deleted.
  const customers = useQuery<ListEnvelope<Customer>>(
    '/v1/customers', { limit: 200 }, { enabled: coupon.times_redeemed > 0 },
  );
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const customer of customers.data?.data ?? []) map.set(customer.id, customer.name);
    return map;
  }, [customers.data]);
  const codeById = useMemo(
    () => new Map(coupon.promotion_codes.map((code) => [code.id, code.code])),
    [coupon.promotion_codes],
  );
  const rows = redemptions.data?.data ?? [];

  return (
    <Card
      title="Redemptions"
      description={coupon.times_redeemed === 0
        ? 'Nothing has taken this coupon up yet.'
        : `${f.plural(coupon.times_redeemed, 'account')} took this up. Releasing one — a subscription undone before it ever billed — gives the redemption back.`}
    >
      {redemptions.error && (
        <ListFailure error={redemptions.error} path={`GET /v1/coupons/${coupon.id}/redemptions`} onRetry={redemptions.refetch} />
      )}
      {!redemptions.error && redemptions.loading && <Loading label="Reading the redemptions…" />}
      {!redemptions.error && !redemptions.loading && rows.length === 0 && (
        <EmptyState
          size="sm"
          inline
          illustration={null}
          title="No account holds this discount"
          body="A redemption is written the moment the coupon is attached to a customer or a subscription — before the first bill it cuts."
        />
      )}
      {rows.map((row) => (
        <div key={row.id} className="bl-row">
          <div className="bl-row__main">
            <div className="bl-row__title">
              {row.customer
                ? <RecordLink to={customerHref(row.customer)}>{names.get(row.customer) ?? row.customer}</RecordLink>
                : <span className="bl-muted">No account named</span>}
            </div>
            <div className="bl-row__sub">
              {row.promotion_code
                ? <>Typed <span className="u-mono">{codeById.get(row.promotion_code) ?? row.promotion_code}</span></>
                : 'Attached by hand'}
              {' · '}
              {f.day(row.created, { withYear: true })}
            </div>
          </div>
          <div className="bl-row__aside">
            {row.ref?.type === 'subscription'
              ? <RecordLink to={subscriptionHref(row.ref.id)} mono>Subscription</RecordLink>
              : row.ref?.type === 'invoice'
                ? <RecordLink to={invoiceHref(row.ref.id)} mono>Invoice</RecordLink>
                : <span className="bl-muted">{row.ref?.type ?? '—'}</span>}
          </div>
        </div>
      ))}
      {rows.length > 0 && rows.length < coupon.times_redeemed && (
        <div className="bl-rank__rest">
          {`${f.plural(coupon.times_redeemed - rows.length, 'further redemption')} beyond the rows read here.`}
        </div>
      )}
    </Card>
  );
}

/* --------------------------------- writing --------------------------------- */

const emptyDraft = (currency: string): CouponDraft => ({
  name: '',
  kind: 'percent',
  percent: null,
  amount: null,
  currency,
  duration: 'once',
  periods: null,
  maxRedemptions: null,
  redeemBy: null,
});

function useHomeCurrency(enabled: boolean): string {
  const { data } = useQuery<ListEnvelope<CatalogCurrency>>('/v1/catalog/currencies', undefined, { enabled });
  const rows = data?.data ?? [];
  return rows.find((row) => row.default)?.code ?? rows[0]?.code ?? 'usd';
}

function CouponCreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const f = useBillingFormat();
  const action = useAction();
  const navigate = useNavigate();
  const home = useHomeCurrency(open);
  const [draft, setDraft] = useState<CouponDraft>(() => emptyDraft(home));
  const set = (patch: Partial<CouponDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const currency = draft.currency || home;

  const reset = () => { setDraft(emptyDraft(home)); action.clear(); };
  const blocked = couponDraftBlocker({ ...draft, currency }, f.now());

  const submit = async () => {
    if (blocked) return;
    const created = await action.run(
      api.post<Coupon>('/v1/coupons', couponBody({ ...draft, currency }), { idempotencyKey: idem() }),
      {
        success: `${draft.name.trim()} created`,
        description: 'Its terms freeze the first time anything redeems it, exactly as a price freezes the first time it bills.',
        failure: 'The coupon was refused',
        inlineOnly: true,
      },
      ['/v1/coupons'],
    );
    if (created) { reset(); onClose(); navigate(couponHref(created.id)); }
  };

  const form = useDialogForm(open, !blocked && !action.busy, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      size="lg"
      title="New coupon"
      description="A coupon takes a percentage or an amount off, never both, and says how long it keeps doing so. A code that hands it out is added afterwards."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" loading={action.busy} disabled={!!blocked} onClick={() => { void submit(); }}>
            Create the coupon
          </Button>
        </>
      }
    >
      <DialogFields form={form}>
        <Stack gap={5}>
          <Field
            label="Name"
            required
            hint="What the deal desk calls it — not the code a customer types."
            error={action.errorFor('name')}
          >
            <Input
              aria-label="Coupon name"
              value={draft.name}
              maxLength={160}
              placeholder="Negotiated contract — 20% off year one"
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>

          <Grid columns={2} gap={5}>
            <GridItem>
              <Field
                label="What it takes off"
                hint={draft.kind === 'percent'
                  ? 'A percentage travels: 20% off is 20% off in every currency the book sells in.'
                  : 'A fixed amount is denominated in one currency — $50 off is not €50 off.'}
              >
                <Select
                  aria-label="What it takes off"
                  value={draft.kind}
                  onChange={(value) => set({ kind: value as CouponDraft['kind'] })}
                  options={[
                    { value: 'percent', label: 'A percentage' },
                    { value: 'amount', label: 'A fixed amount' },
                  ]}
                />
              </Field>
            </GridItem>
            <GridItem>
              {draft.kind === 'percent' ? (
                <Field label="Percentage off" required error={action.errorFor('percent_off_basis_points')}>
                  <NumberInput
                    aria-label="Percentage off"
                    value={draft.percent}
                    onChange={(percent) => set({ percent })}
                    min={0}
                    max={100}
                    step={1}
                    precision={2}
                    suffix="%"
                    placeholder="20"
                  />
                </Field>
              ) : (
                <Field label="Amount off" required error={action.errorFor('amount_off') ?? action.errorFor('currency')}>
                  <MoneyField
                    label="Amount off"
                    value={draft.amount}
                    onChange={(amount) => set({ amount })}
                    currency={currency}
                    min={0}
                  />
                </Field>
              )}
            </GridItem>
          </Grid>

          <Grid columns={2} gap={5}>
            <GridItem>
              <Field label="For how long" hint={DURATION_COPY[draft.duration]}>
                <Select
                  aria-label="For how long"
                  value={draft.duration}
                  onChange={(value) => set({
                    duration: value as CouponDraft['duration'],
                    // `duration_in_periods` only means something on a repeating
                    // coupon; the catalogue refuses it on the other two.
                    periods: value === 'repeating' ? (draft.periods ?? 12) : null,
                  })}
                  options={DURATIONS.map((value) => ({
                    value,
                    label: value === 'once' ? 'The first bill only'
                      : value === 'repeating' ? 'A fixed number of billing periods'
                        : 'Every bill, without end',
                  }))}
                />
              </Field>
            </GridItem>
            <GridItem>
              {draft.duration === 'repeating' && (
                <Field
                  label="Billing periods"
                  required
                  hint="Periods, not months — a subscription's period is whatever its price says it is."
                  error={action.errorFor('duration_in_periods')}
                >
                  <NumberInput
                    aria-label="Billing periods"
                    value={draft.periods}
                    onChange={(periods) => set({ periods })}
                    min={1}
                    max={600}
                  />
                </Field>
              )}
            </GridItem>
          </Grid>

          <Divider />

          <Grid columns={2} gap={5}>
            <GridItem>
              <Field
                label="Redemption ceiling"
                optional
                hint="How many accounts may take it up in total. Leave it empty for a standing concession."
                error={action.errorFor('max_redemptions')}
              >
                <NumberInput
                  aria-label="Redemption ceiling"
                  value={draft.maxRedemptions}
                  onChange={(maxRedemptions) => set({ maxRedemptions })}
                  min={1}
                  placeholder="No ceiling"
                />
              </Field>
            </GridItem>
            <GridItem>
              <Field
                label="Redeem by"
                optional
                hint="After this date nothing new can redeem it. Discounts already running are unaffected."
                error={action.errorFor('redeem_by')}
              >
                <DatePicker
                  aria-label="Redeem by"
                  value={draft.redeemBy}
                  onChange={(redeemBy) => set({ redeemBy })}
                  min={f.now()}
                  placeholder="No end date"
                />
              </Field>
            </GridItem>
          </Grid>

          {blocked && <Banner tone="info" compact>{blocked}</Banner>}
          {action.error && (
            <PreviewFailure
              error={action.error}
              path="POST /v1/coupons"
              onRetry={action.clear}
              refusalTitle="The coupon was refused"
            />
          )}
        </Stack>
      </DialogFields>
    </Modal>
  );
}

function PromotionCodeCreateDialog({ coupon, open, onClose, onCreated }: {
  coupon: CouponDetail; open: boolean; onClose: () => void; onCreated: () => void;
}) {
  const f = useBillingFormat();
  const action = useAction();
  const [code, setCode] = useState('');
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [maxRedemptions, setMaxRedemptions] = useState<number | null>(null);
  const [perCustomer, setPerCustomer] = useState<number | null>(1);
  const [firstTime, setFirstTime] = useState(false);
  const [minimum, setMinimum] = useState<number | null>(null);
  const currency = coupon.currency ?? 'usd';

  const reset = () => {
    setCode(''); setExpiresAt(null); setMaxRedemptions(null); setPerCustomer(1);
    setFirstTime(false); setMinimum(null); action.clear();
  };

  const blocked = code.trim() && code.trim().length < 3
    ? 'A code is at least three characters — it has to survive being read out over the phone.'
    : expiresAt !== null && expiresAt <= f.now()
      ? 'That expiry has passed, so the code would be born dead.'
      : null;

  const submit = async () => {
    if (blocked) return;
    const created = await action.run(
      api.post<PromotionCode>('/v1/promotion_codes', {
        coupon: coupon.id,
        ...(code.trim() ? { code: code.trim().toUpperCase() } : {}),
        ...(expiresAt !== null ? { expires_at: expiresAt } : {}),
        ...(maxRedemptions !== null ? { max_redemptions: maxRedemptions } : {}),
        ...(perCustomer !== null ? { max_redemptions_per_customer: perCustomer } : {}),
        ...(minimum !== null ? { minimum_amount: minimum, minimum_amount_currency: currency } : {}),
        ...(firstTime ? { first_time_transaction: true } : {}),
      }, { idempotencyKey: idem() }),
      {
        success: 'Promotion code created',
        description: 'The string and the coupon behind it never move — it is already in an email the moment it exists.',
        failure: 'The code was refused',
        inlineOnly: true,
      },
      ['/v1/promotion_codes', `/v1/coupons/${coupon.id}`],
    );
    if (created) { reset(); onCreated(); onClose(); }
  };

  const form = useDialogForm(open, !blocked && !action.busy, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      size="md"
      title={`Add a code to ${couponName(coupon)}`}
      description="The customer-facing half of the coupon. Its expiry, ceilings and floor are its own — two codes for one coupon can differ on all of them."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" loading={action.busy} disabled={!!blocked} onClick={() => { void submit(); }}>
            Create the code
          </Button>
        </>
      }
    >
      <DialogFields form={form}>
        <Stack gap={5}>
          <Field
            label="Code"
            optional
            hint="Upper-cased and unique in this workspace. Leave it empty and one is generated from an alphabet with no O/0 or I/1 in it — these get read out over the phone."
            error={action.errorFor('code')}
          >
            <Input
              aria-label="Code"
              value={code}
              maxLength={40}
              placeholder="SPRING20"
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </Field>
          <Grid columns={2} gap={5}>
            <GridItem>
              <Field label="Expires" optional hint="The code stops working; the coupon behind it is untouched." error={action.errorFor('expires_at')}>
                <DatePicker aria-label="Expires" value={expiresAt} onChange={setExpiresAt} min={f.now()} placeholder="No expiry" />
              </Field>
            </GridItem>
            <GridItem>
              <Field label="Total redemptions" optional error={action.errorFor('max_redemptions')}>
                <NumberInput aria-label="Total redemptions" value={maxRedemptions} onChange={setMaxRedemptions} min={1} placeholder="No ceiling" />
              </Field>
            </GridItem>
          </Grid>
          <Grid columns={2} gap={5}>
            <GridItem>
              <Field label="Per account" optional hint="How many times one account may use it." error={action.errorFor('max_redemptions_per_customer')}>
                <NumberInput aria-label="Per account" value={perCustomer} onChange={setPerCustomer} min={1} placeholder="No limit" />
              </Field>
            </GridItem>
            <GridItem>
              <Field label={`Order floor (${currency.toUpperCase()})`} optional hint="The order has to reach this before the code applies.">
                <MoneyField label="Order floor" value={minimum} onChange={setMinimum} currency={currency} min={0} placeholder="No floor" />
              </Field>
            </GridItem>
          </Grid>
          <Switch
            checked={firstTime}
            onChange={setFirstTime}
            label="Only an account that has never been billed"
            hint="An acquisition code, refused to an account already on the book."
          />
          {blocked && <Banner tone="info" compact>{blocked}</Banner>}
          {action.error && (
            <PreviewFailure
              error={action.error}
              path="POST /v1/promotion_codes"
              onRetry={action.clear}
              refusalTitle="The code was refused"
            />
          )}
        </Stack>
      </DialogFields>
    </Modal>
  );
}
