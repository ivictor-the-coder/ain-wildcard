/**
 * The price book: everything this workspace sells, and exactly what it costs.
 *
 * The shell has been advertising it for a while — "Search records, customers
 * and the price book", and global search returns product hits — while the
 * catalog had no screen at all, so every one of those hits led nowhere and the
 * only way to read a price was `GET /v1/prices`. This is the screen: products
 * with the prices hanging off them, the cadence each bills on, the model that
 * turns a quantity into money, and what a given quantity actually comes to.
 *
 * Two rules it keeps.
 *
 * **Nothing here computes money.** A price is a ladder, a package divisor or a
 * negotiated band as often as it is a number, and a second implementation of
 * `computeLineAmount` in the browser would eventually disagree with the invoice.
 * Every figure on screen is either a display string the catalog wrote or the
 * answer to `POST /v1/prices/:id/preview` — the same function the bill runs.
 *
 * **A price quoted in one currency is not a price in another.** `currency_options`
 * holds a separate amount per currency, not a conversion, so the calculator
 * asks the engine again whenever the currency changes rather than converting
 * anything. This is the same mistake the subscription schedule's phase summary
 * makes on the server, one screen over.
 */
import { useCallback, useMemo, useState } from 'react';
import { api, useQuery, type ApiClientError, type ListEnvelope } from '../../kernel/api';
import { useNavigate, useParams, useSearchParam } from '../../kernel/router';
import { useCurrentCrumb } from '../../kernel/shell';
import {
  Badge, Banner, Button, Card, DataTable, Divider, EmptyState, Field, Grid, GridItem, Icons, Inline, Input,
  Modal, NumberInput, Page, Section, Select, Stack, Switch, Textarea, Tooltip, humanize,
  type DataTableColumn, type MenuSection,
} from '../../design';
import { XCircleIcon } from '../../design';
import {
  BookFooter, DialogFields, ExportCsvButton, FieldRow, ListFailure, LoadFailedEmpty, Loading, MoneyField,
  PreviewFailure, RecordLink, RecordMissing, TableSearch, breakdownLabel, idem, useAction,
  useBillingFormat, useBookList, useBookTotal, useDebounced, useDialogForm, useOpenOnQuery, usePricedPreview,
  useRecord, useTableView, visibleRows,
} from './common';
import { ActionMenu } from './subscriptions';
import type { CsvColumn } from './common';
import type { CatalogCurrency, Price, PriceDetail, PricePreview, Product } from './types';

/* ------------------------------- vocabulary ------------------------------- */

export const productHref = (id: string): string => `/catalog/products/${id}`;

/** What a category *is*, in the words a pricing conversation uses. */
const CATEGORY_COPY: Record<string, string> = {
  plan: 'A plan an account subscribes to.',
  component: 'Billed alongside a plan — seats, usage, storage.',
  add_on: 'Bought on top of a plan.',
  credit_pack: 'Prepaid credit, drawn down by usage.',
  service: 'One-off work — onboarding, migration, training.',
};

/**
 * How a quantity becomes money, said once. The enum is the contract between
 * the catalog and the invoice engine, and an operator choosing between two
 * prices needs to know which of these they are looking at before the number.
 */
const MODEL_COPY: Record<string, string> = {
  flat: 'One charge for the whole subscription, whatever the quantity.',
  per_unit: 'The unit rate multiplied by the quantity.',
  tiered: 'A ladder of tiers — the rate changes as the quantity climbs.',
  package: 'Charged per block of units, rounded to whole blocks.',
  usage: 'Metered: the quantity comes from recorded usage when the period closes.',
  custom: 'Negotiated per account, within the bounds set on the price.',
};

const CATEGORIES = ['plan', 'component', 'add_on', 'credit_pack', 'service'] as const;

const priceLabel = (price: Price): string => price.nickname || price.product_name || price.id;

/** "monthly", "every 3 months", "one-time" — the cadence, not the amount. */
const cadenceOf = (price: Price): string => {
  if (!price.recurring) return 'one-time';
  const { interval, interval_count: count } = price.recurring;
  return count === 1 ? `every ${interval}` : `every ${count} ${interval}s`;
};

const isMetered = (price: Price): boolean => price.recurring?.usage_type === 'metered';

/* --------------------------------- the book -------------------------------- */

export function PriceBookPage() {
  const f = useBillingFormat();
  const navigate = useNavigate();
  const [category, setCategory] = useSearchParam('category', '');
  const [standing, setStanding] = useSearchParam('standing', 'live');
  const [view, setView] = useTableView({ columnId: 'name', direction: 'asc' });
  const [creating, setCreating] = useState(false);
  useOpenOnQuery('new', useCallback(() => setCreating(true), []));

  const search = useDebounced(view.query.trim(), 250);
  const book = useBookList<Product>('/v1/products', useMemo(() => ({
    expand: 'prices',
    ...(search ? { query: search } : {}),
    ...(category ? { category } : {}),
    ...(standing === 'live' ? { active: true } : standing === 'archived' ? { active: false } : {}),
  }), [search, category, standing]));
  const whole = useBookTotal('/v1/products', { });

  const columns = useMemo<DataTableColumn<Product>[]>(() => [
    {
      id: 'name',
      header: 'Product',
      pinned: true,
      width: 280,
      sortable: true,
      accessor: (row) => row.name,
      cell: (row) => (
        <div className="bl-cellstack">
          <RecordLink to={productHref(row.id)}>{row.name}</RecordLink>
          <span className="bl-cellstack__sub">{row.tagline ?? row.description ?? 'No description'}</span>
        </div>
      ),
    },
    {
      id: 'category',
      header: 'Kind',
      width: 130,
      filter: 'set',
      accessor: (row) => row.category,
      cell: (row) => (
        <Tooltip content={CATEGORY_COPY[row.category] ?? humanize(row.category)}>
          <span><Badge tone={row.category === 'plan' ? 'brand' : 'neutral'}>{humanize(row.category)}</Badge></span>
        </Tooltip>
      ),
    },
    {
      id: 'headline',
      header: 'From',
      width: 170,
      align: 'right',
      accessor: (row) => defaultPriceOf(row)?.display?.from ?? '',
      cell: (row) => {
        const price = defaultPriceOf(row);
        if (!price) return <span className="bl-muted">No price yet</span>;
        return (
          <div className="bl-cellstack" title={price.display?.summary ?? undefined}>
            <span className="bl-strong">{price.display?.headline ?? price.display?.from ?? '—'}</span>
            <span className="bl-cellstack__sub">{price.display?.cadence ?? cadenceOf(price)}</span>
          </div>
        );
      },
    },
    {
      id: 'prices',
      header: 'Prices',
      width: 200,
      accessor: (row) => (row.prices ?? []).filter((price) => price.active).length,
      cell: (row) => {
        const prices = row.prices ?? [];
        const live = prices.filter((price) => price.active);
        if (prices.length === 0) return <span className="bl-muted">None</span>;
        const cadences = [...new Set(live.map(cadenceOf))];
        return (
          <div className="bl-cellstack">
            <span>{f.plural(live.length, 'live price')}</span>
            <span className="bl-cellstack__sub">
              {cadences.length ? f.list(cadences) : `${prices.length} archived`}
            </span>
          </div>
        );
      },
    },
    {
      id: 'currencies',
      header: 'Sold in',
      width: 140,
      accessor: (row) => currenciesOf(row).join(' '),
      cell: (row) => {
        const codes = currenciesOf(row);
        return codes.length
          ? <span className="u-mono bl-sub">{codes.map((code) => code.toUpperCase()).join(' · ')}</span>
          : <span className="bl-muted">—</span>;
      },
    },
    {
      id: 'unit',
      header: 'Unit',
      width: 110,
      defaultHidden: true,
      accessor: (row) => row.unit_label ?? '',
      cell: (row) => (row.unit_label ? <span>{row.unit_label}</span> : <span className="bl-muted">—</span>),
    },
    {
      id: 'active',
      header: 'Status',
      width: 110,
      filter: 'set',
      accessor: (row) => (row.active ? 'Sold' : 'Archived'),
      cell: (row) => <Badge tone={row.active ? 'success' : 'neutral'}>{row.active ? 'Sold' : 'Archived'}</Badge>,
    },
  ], [f]);

  const visible = useMemo(() => visibleRows(book.rows, columns, view), [book.rows, columns, view]);

  const csv = useMemo<CsvColumn<Product>[]>(() => [
    { header: 'Product', value: (row) => row.name },
    { header: 'Kind', value: (row) => humanize(row.category) },
    { header: 'Tagline', value: (row) => row.tagline ?? '' },
    { header: 'Unit', value: (row) => row.unit_label ?? '' },
    { header: 'Status', value: (row) => (row.active ? 'Sold' : 'Archived') },
    { header: 'Live prices', value: (row) => (row.prices ?? []).filter((price) => price.active).length },
    { header: 'Sold in', value: (row) => currenciesOf(row).map((code) => code.toUpperCase()).join(' ') },
    { header: 'Default price', value: (row) => defaultPriceOf(row)?.display?.summary ?? '' },
    { header: 'Product id', value: (row) => row.id },
    { header: 'Default price id', value: (row) => row.default_price ?? '' },
  ], []);

  return (
    <Page
      title="Price book"
      eyebrow="Revenue"
      subtitle="Every product this workspace sells, the prices hanging off it, and what each one bills."
      actions={
        <Inline gap={3}>
          <Button variant="secondary" iconLeft={<Icons.repeat size={15} />} onClick={() => navigate('/billing/subscriptions')}>
            Who is on what
          </Button>
          <Button variant="primary" iconLeft={<Icons.plus size={15} />} onClick={() => setCreating(true)}>New product</Button>
        </Inline>
      }
    >
      {book.error && <ListFailure error={book.error} path="GET /v1/products" onRetry={book.retry} />}
      <div className={book.loading ? 'bl-grid is-loading' : 'bl-grid'}>
        <DataTable
          rows={book.rows}
          columns={columns}
          getRowId={(row) => row.id}
          caption="Price book"
          loading={book.loading}
          error={null}
          onRetry={book.retry}
          value={view}
          onChange={setView}
          initialSort={{ columnId: 'name', direction: 'asc' }}
          searchable={false}
          onRowClick={(row) => navigate(productHref(row.id))}
          maxHeight={640}
          stickyFooter
          empty={book.error
            ? <LoadFailedEmpty noun="products" />
            : (
              <EmptyState
                size="sm"
                inline
                illustration={null}
                title={standing === 'archived' ? 'Nothing has been archived' : 'Nothing is sold yet'}
                body={standing === 'archived'
                  ? 'A product is archived rather than deleted, so the invoices that reference it keep explaining themselves.'
                  : 'A product is the thing you sell; its prices are what it costs. Create one and its first price together.'}
                action={<Button size="sm" variant="primary" onClick={() => setCreating(true)}>New product</Button>}
              />
            )}
          toolbar={
            <Inline gap={3} wrap>
              <TableSearch view={view} onChange={setView} label="Search products" />
              <Select
                size="sm"
                aria-label="Kind"
                value={category}
                onChange={(value) => setCategory(value || undefined)}
                icon={<Icons.filter size={14} />}
                options={[
                  { value: '', label: 'Every kind' },
                  ...CATEGORIES.map((value) => ({ value, label: humanize(value) })),
                ]}
              />
              <Select
                size="sm"
                aria-label="Standing"
                value={standing}
                onChange={(value) => setStanding(value === 'live' ? undefined : value)}
                options={[
                  { value: 'live', label: 'Sold today' },
                  { value: 'archived', label: 'Archived' },
                  { value: 'all', label: 'Everything' },
                ]}
              />
            </Inline>
          }
          toolbarEnd={<ExportCsvButton rows={visible} columns={csv} name="price-book" noun="products" />}
          footer={<BookFooter book={book} noun="products" shown={visible.length} whole={whole} />}
        />
      </div>
      <ProductCreateDialog open={creating} onClose={() => setCreating(false)} />
    </Page>
  );
}

const defaultPriceOf = (product: Product): Price | null => {
  const prices = product.prices ?? [];
  return prices.find((price) => price.id === product.default_price)
    ?? prices.find((price) => price.active)
    ?? prices[0]
    ?? null;
};

const currenciesOf = (product: Product): string[] => {
  const codes = new Set<string>();
  for (const price of product.prices ?? []) for (const code of price.currencies) codes.add(code);
  return [...codes].sort();
};

/* -------------------------------- the record ------------------------------- */

export function ProductDetailPage() {
  const { id } = useParams();
  const f = useBillingFormat();
  const action = useAction();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<null | 'edit' | 'price'>(null);
  const { data, error, loading, refetch } = useRecord<Product>(`/v1/products/${id}?expand=prices`);
  useCurrentCrumb(data?.name);

  if (loading) return <Page title="Product"><Loading label="Reading the price book…" /></Page>;
  if (error || !data) {
    return (
      <Page title="Product" eyebrow="Price book">
        <Card>
          <RecordMissing
            error={error ?? ({ status: 404, body: { message: `No product with the id ${id}.` } } as ApiClientError)}
            path={`GET /v1/products/${id}`}
            onRetry={refetch}
            noun="product"
            backTo="/catalog/products"
            backLabel="Back to the price book"
          />
        </Card>
      </Page>
    );
  }

  const prices = data.prices ?? [];
  const live = prices.filter((price) => price.active);
  const setActive = (active: boolean) => action.run(
    api.patch<Product>(`/v1/products/${data.id}`, { active }),
    {
      success: active ? `${data.name} is sold again` : `${data.name} archived`,
      description: active
        ? 'It appears in the pickers again; its prices keep whatever standing they had.'
        : 'Nothing new can be sold on it. Subscriptions already on its prices go on billing, and old invoices still explain themselves.',
      failure: 'That change was refused',
    },
    ['/v1/products', '/v1/prices', '/v1/catalog'],
  ).then(() => refetch());

  const sections: MenuSection[] = [{
    id: 'product',
    items: [
      { id: 'edit', label: 'Edit this product…', icon: <Icons.edit size={14} />, onSelect: () => setDialog('edit') },
      { id: 'price', label: 'Add a price…', icon: <Icons.plus size={14} />, onSelect: () => setDialog('price') },
      data.active
        ? { id: 'archive', label: 'Archive it', icon: <XCircleIcon size={14} />, danger: true, onSelect: () => { void setActive(false); } }
        : { id: 'restore', label: 'Sell it again', icon: <Icons.refresh size={14} />, onSelect: () => { void setActive(true); } },
    ],
  }];

  return (
    <Page
      title={data.name}
      eyebrow="Price book"
      badge={!data.active
        ? <span style={{ marginLeft: 'var(--space-4)' }}><Badge tone="neutral" pill>Archived</Badge></span>
        : undefined}
      subtitle={data.tagline ?? CATEGORY_COPY[data.category] ?? humanize(data.category)}
      actions={
        <Inline gap={3}>
          <Button variant="secondary" iconLeft={<Icons.list size={15} />} onClick={() => navigate('/catalog/products')}>
            The whole book
          </Button>
          <Button variant="primary" iconLeft={<Icons.plus size={15} />} onClick={() => setDialog('price')}>Add a price</Button>
          <ActionMenu sections={sections} label="More product actions" />
        </Inline>
      }
    >
      <Stack gap={6}>
        {!data.active && (
          <Banner tone="info" title="This product is archived">
            It cannot be put on a new subscription. Everything already billing on its prices carries on, which is why
            archiving is the way to withdraw a product rather than deleting it.
          </Banner>
        )}
        {prices.length === 0 && (
          <Banner tone="warning" title="This product has no price">
            A product with no price cannot be sold — a subscription item names a price, never a product. Add one and it
            becomes the default.
          </Banner>
        )}

        <div className="bl-cols">
          <Stack gap={6}>
            <PricesCard product={data} onChanged={refetch} onAdd={() => setDialog('price')} />
            {data.features.length > 0 && (
              <Card title="What it includes" description="The features this product grants, and the keys entitlements are checked against.">
                {data.features.map((feature) => (
                  <div key={feature.lookup_key} className="bl-row">
                    <div className="bl-row__main">
                      <div className="bl-row__title">{feature.name}</div>
                      {feature.description && <div className="bl-row__sub">{feature.description}</div>}
                    </div>
                    <div className="bl-row__aside"><span className="u-mono bl-sub">{feature.lookup_key}</span></div>
                  </div>
                ))}
              </Card>
            )}
          </Stack>

          <Stack gap={6}>
            <Card title="The product" description="What is sold, and the words the rest of the platform uses for it.">
              <div className="bl-schedmeta">
                <FieldRow label="Kind" hint={CATEGORY_COPY[data.category]}>{humanize(data.category)}</FieldRow>
                <FieldRow label="Unit" hint="The noun every per-unit price on it is quoted in.">
                  {data.unit_label ?? '—'}
                </FieldRow>
                <FieldRow label="Live prices">{f.plural(live.length, 'price')}</FieldRow>
                <FieldRow label="On a statement" hint="What a cardholder sees on their statement.">
                  {data.statement_descriptor ?? '—'}
                </FieldRow>
                <FieldRow label="Tax code">{data.tax_code ?? '—'}</FieldRow>
                <FieldRow label="Id"><span className="u-mono bl-sub">{data.id}</span></FieldRow>
              </div>
              {data.description && (
                <>
                  <Divider />
                  <div className="bl-phase__desc">{data.description}</div>
                </>
              )}
            </Card>
          </Stack>
        </div>
      </Stack>

      <ProductEditDialog product={data} open={dialog === 'edit'} onClose={() => setDialog(null)} onSaved={refetch} />
      <PriceCreateDialog product={data} open={dialog === 'price'} onClose={() => setDialog(null)} onCreated={refetch} />
    </Page>
  );
}

/* -------------------------------- the prices ------------------------------- */

function PricesCard({ product, onChanged, onAdd }: { product: Product; onChanged: () => void; onAdd: () => void }) {
  const action = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const prices = product.prices ?? [];

  const invalidates = ['/v1/products', '/v1/prices', '/v1/catalog'];
  const patch = (price: Price, body: Record<string, unknown>, copy: { success: string; description: string }) => action.run(
    api.patch<Price>(`/v1/prices/${price.id}`, body),
    { ...copy, failure: 'That change was refused' },
    invalidates,
  ).then(() => onChanged());

  const menu = (price: Price): MenuSection[] => [{
    id: 'price',
    items: [
      {
        id: 'default',
        label: 'Make it the default price',
        icon: <Icons.star size={14} />,
        disabled: price.id === product.default_price || !price.active,
        onSelect: () => {
          void action.run(
            api.patch<Product>(`/v1/products/${product.id}`, { default_price: price.id }),
            {
              success: `${priceLabel(price)} is the default`,
              description: 'The default price is the one that speaks for the product on a pricing page and in the pickers.',
              failure: 'That change was refused',
            },
            invalidates,
          ).then(() => onChanged());
        },
      },
      price.active
        ? {
          id: 'archive',
          label: 'Archive this price',
          icon: <XCircleIcon size={14} />,
          danger: true,
          onSelect: () => {
            void patch(price, { active: false }, {
              success: `${priceLabel(price)} archived`,
              description: 'Nothing new can be sold on it. Subscriptions already on it keep billing, and old invoices still reference it.',
            });
          },
        }
        : {
          id: 'restore',
          label: 'Sell it again',
          icon: <Icons.refresh size={14} />,
          onSelect: () => {
            void patch(price, { active: true }, {
              success: `${priceLabel(price)} is sellable again`,
              description: 'It appears in the price pickers from now on.',
            });
          },
        },
    ],
  }];

  return (
    <Card
      title="Prices"
      description="A price is what a quantity costs. Amounts, tiers, currency and cadence freeze the moment anything bills against one — that is what keeps every historical invoice reproducible."
      actions={<Button size="sm" variant="secondary" iconLeft={<Icons.plus size={13} />} onClick={onAdd}>Add a price</Button>}
    >
      {prices.length === 0 && (
        <EmptyState
          size="sm"
          inline
          illustration={null}
          title="No price on this product yet"
          body="Until it has one, nothing can subscribe to it — a subscription item names a price, not a product."
          action={<Button size="sm" variant="primary" onClick={onAdd}>Add the first price</Button>}
        />
      )}
      {prices.map((price) => (
        <div key={price.id} className="bl-row">
          <div className="bl-row__main">
            <div className="bl-row__title">
              {priceLabel(price)}
              {price.id === product.default_price && (
                <span style={{ marginLeft: 'var(--space-3)' }}><Badge tone="brand">Default</Badge></span>
              )}
              {!price.active && (
                <span style={{ marginLeft: 'var(--space-3)' }}><Badge tone="neutral">Archived</Badge></span>
              )}
            </div>
            <div className="bl-row__sub">{price.display?.summary ?? `${humanize(price.model)} · ${cadenceOf(price)}`}</div>
            <div className="bl-row__sub">{MODEL_COPY[price.model] ?? humanize(price.model)}</div>
            {price.lookup_key && (
              <div className="bl-row__sub">
                {'Lookup key '}
                <span className="u-mono">{price.lookup_key}</span>
              </div>
            )}
            <Button
              size="sm"
              variant="link"
              aria-expanded={open === price.id}
              onClick={() => setOpen((current) => (current === price.id ? null : price.id))}
            >
              {open === price.id ? 'Hide the calculator' : 'What would a quantity cost?'}
            </Button>
            {open === price.id && <PriceCalculator price={price} />}
          </div>
          <div className="bl-row__aside">
            <div>{price.display?.headline ?? '—'}</div>
            <div className="bl-sub">{price.display?.cadence ?? cadenceOf(price)}</div>
          </div>
          <div className="bl-row__act">
            <ActionMenu sections={menu(price)} label={`Actions for ${priceLabel(price)}`} />
          </div>
        </div>
      ))}
    </Card>
  );
}

/**
 * What a quantity costs, in a currency the price is actually sold in.
 *
 * Everything here is `POST /v1/prices/:id/preview` — the invoice engine's own
 * `computeLineAmount`, breakdown rows and all — because a tiered ladder, a
 * package divisor and a per-currency amount are three different reasons the
 * obvious multiplication in a browser would be wrong.
 */
function PriceCalculator({ price }: { price: Price }) {
  const f = useBillingFormat();
  const [quantity, setQuantity] = useState<number | null>(isMetered(price) ? 100_000 : 1);
  const [currency, setCurrency] = useState(price.currency);
  const detail = useQuery<PriceDetail>(`/v1/prices/${price.id}`);
  const preview = usePricedPreview<PricePreview>(
    `/v1/prices/${price.id}/preview`,
    useMemo(() => ({ quantity: Math.max(0, quantity ?? 0), currency }), [quantity, currency]),
    true,
  );
  const usage = detail.data?.usage ?? null;

  return (
    <div className="bl-phasepreview" style={{ marginTop: 'var(--space-4)' }}>
      <Grid columns={2} gap={4} style={{ marginBottom: 'var(--space-4)' }}>
        <GridItem>
          <Field
            label={isMetered(price) ? 'Units recorded in the period' : 'Quantity'}
            hint={isMetered(price) ? 'What a period with this much usage in it would bill.' : undefined}
          >
            <NumberInput
              aria-label={`Quantity for ${priceLabel(price)}`}
              value={quantity}
              min={0}
              max={100_000_000}
              onChange={setQuantity}
            />
          </Field>
        </GridItem>
        <GridItem>
          <Field label="Currency" hint="Each currency has its own amount on the price — never a conversion of another.">
            <Select
              aria-label={`Currency for ${priceLabel(price)}`}
              value={currency}
              onChange={setCurrency}
              options={price.currencies.map((code) => ({ value: code, label: code.toUpperCase() }))}
            />
          </Field>
        </GridItem>
      </Grid>

      {preview.error && (
        <PreviewFailure
          error={preview.error}
          path={`POST /v1/prices/${price.id}/preview`}
          onRetry={preview.refetch}
          refusalTitle="This quantity could not be priced"
        />
      )}
      {!preview.error && !preview.data && <Loading label="Pricing it…" />}
      {!preview.error && preview.data && (
        <>
          <div className="bl-phasepreview__head">
            <span>{`${f.number(preview.data.quantity)} × ${priceLabel(price)}`}</span>
            <span className="bl-phasepreview__total">{preview.data.amount_display}</span>
          </div>
          {preview.data.breakdown.map((row, index) => (
            <div key={`${row.kind}-${index}`} className="bl-phasepreview__row">
              <span>{breakdownLabel(row.label, currency, f.locale)}</span>
              <span>{f.money(row.amount, { currency })}</span>
            </div>
          ))}
          {preview.data.warning && (
            <Banner tone="warning" compact>{preview.data.warning.message}</Banner>
          )}
          <div className="bl-phasepreview__foot">
            {`Priced by POST /v1/prices/${price.id}/preview — the same computeLineAmount the invoice engine runs. `}
            {`Effective ${preview.data.effective_unit_display} per unit; the next unit costs ${preview.data.marginal_unit_display}.`}
            {usage?.in_use
              ? ` This price has already billed ${usage.summary}, so its amounts, tiers, currency and cadence can no longer change.`
              : usage
                ? ' Nothing has billed against it yet, so it can still be repriced in place.'
                : ''}
          </div>
        </>
      )}
    </div>
  );
}

/* -------------------------------- the writes ------------------------------- */

interface PriceDraft {
  currency: string;
  amount: number | null;
  model: 'flat' | 'per_unit' | 'package';
  type: 'recurring' | 'one_time';
  interval: 'day' | 'week' | 'month' | 'year';
  intervalCount: number;
  divideBy: number;
  nickname: string;
  lookupKey: string;
  extra: Record<string, number | null>;
}

const emptyPrice = (currency: string): PriceDraft => ({
  currency,
  amount: null,
  model: 'per_unit',
  type: 'recurring',
  interval: 'month',
  intervalCount: 1,
  divideBy: 10,
  nickname: '',
  lookupKey: '',
  extra: {},
});

/** The price body the catalog takes, built from the draft the form holds. */
function priceBody(draft: PriceDraft): Record<string, unknown> {
  const options = Object.entries(draft.extra)
    .filter(([, amount]) => amount !== null && amount !== undefined)
    .map(([code, amount]) => [code, { unit_amount: amount as number }]);
  return {
    currency: draft.currency,
    model: draft.model,
    type: draft.type,
    unit_amount: draft.amount ?? 0,
    ...(draft.model === 'package' ? { transform_quantity: { divide_by: draft.divideBy, round: 'up' } } : {}),
    ...(draft.type === 'recurring'
      ? { recurring: { interval: draft.interval, interval_count: draft.intervalCount, usage_type: 'licensed' } }
      : {}),
    ...(draft.nickname.trim() ? { nickname: draft.nickname.trim() } : {}),
    ...(draft.lookupKey.trim() ? { lookup_key: draft.lookupKey.trim() } : {}),
    ...(options.length ? { currency_options: Object.fromEntries(options) } : {}),
  };
}

/**
 * The currencies this book already sells in, so a new price can be quoted in
 * every one of them at the moment it is written rather than being dollars-only
 * until somebody notices. A price with no amount for an account's currency is
 * exactly what makes a EUR subscription unsellable.
 */
function useBookCurrencies(enabled: boolean): { home: string; others: CatalogCurrency[] } {
  const { data } = useQuery<ListEnvelope<CatalogCurrency>>('/v1/catalog/currencies', undefined, { enabled });
  const rows = data?.data ?? [];
  const home = rows.find((row) => row.default)?.code ?? rows[0]?.code ?? 'usd';
  return { home, others: rows.filter((row) => row.code !== home) };
}

function PriceFields({ draft, set, currencies, prefix }: {
  draft: PriceDraft;
  set: (patch: Partial<PriceDraft>) => void;
  currencies: CatalogCurrency[];
  prefix: string;
}) {
  return (
    <Stack gap={5}>
      <Grid columns={2} gap={5}>
        <GridItem>
          <Field label="How it charges" hint={MODEL_COPY[draft.model]}>
            <Select
              aria-label={`${prefix} pricing model`}
              value={draft.model}
              onChange={(value) => set({ model: value as PriceDraft['model'] })}
              options={[
                { value: 'per_unit', label: 'Per unit — the rate × the quantity' },
                { value: 'flat', label: 'Flat — one charge whatever the quantity' },
                { value: 'package', label: 'Package — charged per block of units' },
              ]}
            />
          </Field>
        </GridItem>
        <GridItem>
          <Field label="Cadence" hint={draft.type === 'recurring' ? 'Every subscription item on this price bills on it.' : 'Charged once, when it is added to a bill.'}>
            <Select
              aria-label={`${prefix} cadence`}
              value={draft.type === 'one_time' ? 'one_time' : `${draft.intervalCount}:${draft.interval}`}
              onChange={(value) => {
                if (value === 'one_time') { set({ type: 'one_time' }); return; }
                const [count, interval] = value.split(':');
                set({ type: 'recurring', intervalCount: Number(count), interval: interval as PriceDraft['interval'] });
              }}
              options={[
                { value: '1:month', label: 'Monthly' },
                { value: '3:month', label: 'Every 3 months' },
                { value: '1:year', label: 'Yearly' },
                { value: '1:week', label: 'Weekly' },
                { value: 'one_time', label: 'One-time' },
              ]}
            />
          </Field>
        </GridItem>
      </Grid>

      <Grid columns={2} gap={5}>
        <GridItem>
          <Field label={`Amount in ${draft.currency.toUpperCase()}`} required hint="Integer minor units under the hood — no floats ever touch a price.">
            <MoneyField
              value={draft.amount}
              onChange={(value) => set({ amount: value })}
              currency={draft.currency}
              min={0}
              label={`Amount in ${draft.currency.toUpperCase()}`}
            />
          </Field>
        </GridItem>
        {draft.model === 'package' && (
          <GridItem>
            <Field label="Units in a block" hint="A part-block is rounded up, so 11 units on a block of 10 is two blocks.">
              <NumberInput
                aria-label={`${prefix} units per block`}
                value={draft.divideBy}
                min={1}
                max={1_000_000}
                onChange={(value) => set({ divideBy: Math.max(1, value ?? 1) })}
              />
            </Field>
          </GridItem>
        )}
      </Grid>

      {currencies.length > 0 && (
        <Section
          title="The other currencies this book sells in"
          description="Each is its own amount, not a conversion. A price with nothing here cannot be put on an account that bills in that currency."
        >
          <Grid columns={2} gap={5}>
            {currencies.map((row) => (
              <GridItem key={row.code}>
                <Field label={`Amount in ${row.code.toUpperCase()}`} optional>
                  <MoneyField
                    value={draft.extra[row.code] ?? null}
                    onChange={(value) => set({ extra: { ...draft.extra, [row.code]: value } })}
                    currency={row.code}
                    min={0}
                    label={`Amount in ${row.code.toUpperCase()}`}
                  />
                </Field>
              </GridItem>
            ))}
          </Grid>
        </Section>
      )}

      <Grid columns={2} gap={5}>
        <GridItem>
          <Field label="Nickname" optional hint="What this price is called on an invoice line when it is not the product's own.">
            <Input
              aria-label={`${prefix} nickname`}
              value={draft.nickname}
              maxLength={160}
              placeholder="Growth operator seat — monthly"
              onChange={(e) => set({ nickname: e.target.value })}
            />
          </Field>
        </GridItem>
        <GridItem>
          <Field label="Lookup key" optional hint="A stable handle the API can name instead of the id: growth_monthly.">
            <Input
              aria-label={`${prefix} lookup key`}
              value={draft.lookupKey}
              maxLength={80}
              mono
              placeholder="growth_monthly"
              onChange={(e) => set({ lookupKey: e.target.value })}
            />
          </Field>
        </GridItem>
      </Grid>
    </Stack>
  );
}

function ProductCreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const action = useAction();
  const navigate = useNavigate();
  const { home, others } = useBookCurrencies(open);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<string>('plan');
  const [tagline, setTagline] = useState('');
  const [unitLabel, setUnitLabel] = useState('');
  const [description, setDescription] = useState('');
  const [withPrice, setWithPrice] = useState(true);
  const [draft, setDraft] = useState<PriceDraft>(emptyPrice(home));
  const set = (patch: Partial<PriceDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const reset = () => {
    setName(''); setCategory('plan'); setTagline(''); setUnitLabel(''); setDescription('');
    setWithPrice(true); setDraft(emptyPrice(home)); action.clear();
  };

  const blocked = !name.trim()
    ? 'Give the product a name.'
    : withPrice && (draft.amount === null || draft.amount < 0)
      ? 'Name what the first price charges, or add the product without one.'
      : null;

  const submit = async () => {
    if (blocked) return;
    const result = await action.run(
      api.post<Product>('/v1/products', {
        name: name.trim(),
        category,
        ...(tagline.trim() ? { tagline: tagline.trim() } : {}),
        ...(unitLabel.trim() ? { unit_label: unitLabel.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(withPrice ? { default_price_data: priceBody({ ...draft, currency: draft.currency || home }) } : {}),
      }, { idempotencyKey: idem() }),
      {
        success: `${name.trim()} added to the price book`,
        description: withPrice
          ? 'The product and its first price were written in one transaction, and that price is now its default.'
          : 'It has no price yet, so nothing can subscribe to it until one is added.',
        failure: 'The product was refused',
        inlineOnly: true,
      },
      ['/v1/products', '/v1/prices', '/v1/catalog'],
    );
    if (result) { reset(); onClose(); navigate(productHref(result.id)); }
  };

  const form = useDialogForm(open, !blocked && !action.busy, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      size="lg"
      title="New product"
      description="A product is the thing you sell; a price is what it costs. Both are written in one call, so a product never exists without a way to buy it."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" loading={action.busy} disabled={!!blocked} onClick={() => { void submit(); }}>
            {withPrice ? 'Create the product and its price' : 'Create the product'}
          </Button>
        </>
      }
    >
      <DialogFields form={form}>
        <Stack gap={5}>
          <Grid columns={2} gap={5}>
            <GridItem>
              <Field label="Name" required error={action.errorFor('name')}>
                <Input aria-label="Product name" value={name} maxLength={150} placeholder="Telemetry Cloud Growth" onChange={(e) => setName(e.target.value)} />
              </Field>
            </GridItem>
            <GridItem>
              <Field label="Kind" hint={CATEGORY_COPY[category]}>
                <Select
                  aria-label="Kind"
                  value={category}
                  onChange={setCategory}
                  options={CATEGORIES.map((value) => ({ value, label: humanize(value) }))}
                />
              </Field>
            </GridItem>
          </Grid>
          <Field label="Tagline" optional hint="One line, as a pricing page would print it.">
            <Input aria-label="Tagline" value={tagline} maxLength={200} placeholder="Every line in the plant, one dashboard." onChange={(e) => setTagline(e.target.value)} />
          </Field>
          <Field label="Unit" optional hint="The noun a per-unit price on this product is quoted in: seat, robot, GB.">
            <Input aria-label="Unit" value={unitLabel} maxLength={40} placeholder="seat" onChange={(e) => setUnitLabel(e.target.value)} />
          </Field>
          <Field label="Description" optional counter={{ value: description.length, max: 2000 }}>
            <Textarea
              aria-label="Description"
              value={description}
              maxLength={2000}
              minRows={2}
              maxRows={5}
              placeholder="What the customer gets."
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          <Divider />

          <Switch
            checked={withPrice}
            onChange={setWithPrice}
            label="Give it a price now"
            hint="Without one it cannot be subscribed to — a subscription item names a price, never a product."
          />
          {withPrice && <PriceFields draft={draft} set={set} currencies={others} prefix="First price" />}

          {action.error && (
            <PreviewFailure
              error={action.error}
              path="POST /v1/products"
              onRetry={action.clear}
              refusalTitle="The product was refused"
            />
          )}
        </Stack>
      </DialogFields>
    </Modal>
  );
}

function PriceCreateDialog({ product, open, onClose, onCreated }: {
  product: Product; open: boolean; onClose: () => void; onCreated: () => void;
}) {
  const action = useAction();
  const { home, others } = useBookCurrencies(open);
  const [draft, setDraft] = useState<PriceDraft>(emptyPrice(home));
  const [makeDefault, setMakeDefault] = useState(false);
  const set = (patch: Partial<PriceDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const blocked = draft.amount === null ? 'Name what this price charges.' : null;

  const submit = async () => {
    if (blocked) return;
    const price = await action.run(
      api.post<Price>('/v1/prices', { product: product.id, ...priceBody({ ...draft, currency: draft.currency || home }) }, { idempotencyKey: idem() }),
      {
        success: 'Price added',
        description: 'Its amounts are frozen the moment anything bills against it, which is what keeps old invoices reproducible.',
        failure: 'The price was refused',
        inlineOnly: true,
      },
      ['/v1/products', '/v1/prices', '/v1/catalog'],
    );
    if (!price) return;
    if (makeDefault) {
      await action.run(
        api.patch<Product>(`/v1/products/${product.id}`, { default_price: price.id }),
        { success: 'It is now the default price', failure: 'It was created, but could not be made the default', inlineOnly: true },
        ['/v1/products', '/v1/catalog'],
      );
    }
    setDraft(emptyPrice(home));
    setMakeDefault(false);
    onCreated();
    onClose();
  };

  const form = useDialogForm(open, !blocked && !action.busy, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={`Add a price to ${product.name}`}
      description="Amounts, tiers, currency and cadence can only change while nothing has billed against a price. After that, add another and migrate."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={action.busy} disabled={!!blocked} onClick={() => { void submit(); }}>Add the price</Button>
        </>
      }
    >
      <DialogFields form={form}>
        <Stack gap={5}>
          <PriceFields draft={draft} set={set} currencies={others} prefix="Price" />
          <Switch
            checked={makeDefault}
            onChange={setMakeDefault}
            label="Make it this product's default price"
            hint="The default is the one that speaks for the product on a pricing page and in the pickers."
          />
          {action.error && (
            <PreviewFailure
              error={action.error}
              path="POST /v1/prices"
              onRetry={action.clear}
              refusalTitle="The price was refused"
            />
          )}
        </Stack>
      </DialogFields>
    </Modal>
  );
}

function ProductEditDialog({ product, open, onClose, onSaved }: {
  product: Product; open: boolean; onClose: () => void; onSaved: () => void;
}) {
  const action = useAction();
  const [name, setName] = useState(product.name);
  const [category, setCategory] = useState(product.category);
  const [tagline, setTagline] = useState(product.tagline ?? '');
  const [unitLabel, setUnitLabel] = useState(product.unit_label ?? '');
  const [statement, setStatement] = useState(product.statement_descriptor ?? '');
  const [description, setDescription] = useState(product.description ?? '');

  const submit = async () => {
    const result = await action.run(
      api.patch<Product>(`/v1/products/${product.id}`, {
        name: name.trim(),
        category,
        // Nullable, not merely optional: a tagline typed by mistake has to be
        // removable, and the store has always known how to clear these.
        tagline: tagline.trim() || null,
        unit_label: unitLabel.trim() || null,
        statement_descriptor: statement.trim() || null,
        description: description.trim() || null,
      }),
      { success: 'Saved', description: 'The price book reads the new words everywhere they appear.', failure: 'That edit was refused', inlineOnly: true },
      ['/v1/products', '/v1/catalog'],
    );
    if (result) { onSaved(); onClose(); }
  };

  const form = useDialogForm(open, !!name.trim() && !action.busy, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={`Edit ${product.name}`}
      description="The words only — a product's prices are edited on their own, because money that has already billed cannot move."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={action.busy} disabled={!name.trim()} onClick={() => { void submit(); }}>Save</Button>
        </>
      }
    >
      <DialogFields form={form}>
        <Stack gap={5}>
          <Field label="Name" required error={action.errorFor('name')}>
            <Input aria-label="Product name" value={name} maxLength={150} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Grid columns={2} gap={5}>
            <GridItem>
              <Field label="Kind" hint={CATEGORY_COPY[category]}>
                <Select aria-label="Kind" value={category} onChange={setCategory} options={CATEGORIES.map((value) => ({ value, label: humanize(value) }))} />
              </Field>
            </GridItem>
            <GridItem>
              <Field label="Unit" optional hint="seat, robot, GB — the noun per-unit prices are quoted in.">
                <Input aria-label="Unit" value={unitLabel} maxLength={40} onChange={(e) => setUnitLabel(e.target.value)} />
              </Field>
            </GridItem>
          </Grid>
          <Field label="Tagline" optional>
            <Input aria-label="Tagline" value={tagline} maxLength={200} onChange={(e) => setTagline(e.target.value)} />
          </Field>
          <Field label="On a card statement" optional hint="At most 22 characters — what a cardholder sees on their statement.">
            <Input aria-label="Statement descriptor" value={statement} maxLength={22} onChange={(e) => setStatement(e.target.value)} />
          </Field>
          <Field label="Description" optional counter={{ value: description.length, max: 2000 }}>
            <Textarea aria-label="Description" value={description} maxLength={2000} minRows={2} maxRows={6} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          {action.error && (
            <PreviewFailure error={action.error} path={`PATCH /v1/products/${product.id}`} onRetry={action.clear} refusalTitle="That edit was refused" />
          )}
        </Stack>
      </DialogFields>
    </Modal>
  );
}
