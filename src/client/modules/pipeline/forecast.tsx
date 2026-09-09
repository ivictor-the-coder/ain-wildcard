/**
 * The forecast.
 *
 * The deals closing in a period, by who owns them and by how sure their stage
 * says they are — Closed won, Commit, Best case, Pipeline — the grid a sales
 * leader runs the Monday call from. The board could already answer any one of
 * those cells with three filters; it could not put them side by side, so
 * comparing Priya's commit with Marcus's meant three passes and a notepad.
 *
 * Every figure is the server's. The set is read through the record search,
 * whole and cursor-followed rather than a page of 200, and each deal lands in
 * a column by the `forecast_category` and `deal_status` its stage stamped on
 * it; the cells are sums of `amount` and `weighted_amount` over that set. Each
 * cell is a link into the board with the same filters, where the stat tiles
 * total the same deals — so a cell can always be checked against the screen
 * it opens.
 */
import { useMemo } from 'react';
import { Link, useRouter } from '@/client/kernel/router';
import {
  Avatar, Banner, Button, Card, EmptyState, ErrorState, Icons, MetricTile, Page, SegmentedControl,
  Select, Skeleton, SkeletonText, Stat, type SelectOption,
} from '@/client/design';
import {
  ALL_PIPELINES, FORECAST_PERIODS, PERIOD_LABEL, horizonWindow, num, quarterName, quarterStart, str,
  useDealFormat, useDealSearch, usePipelines, useUserIndex, useUsers,
  type DealSearchBody, type FilterCondition, type ForecastPeriod,
} from './api';
import {
  BUCKET_HINT, BUCKET_LABEL, FORECAST_BUCKETS, UNASSIGNED, byOwner, byPipeline, composition,
  rollupForecast, type ForecastBucket, type ForecastDeal, type ForecastLine,
} from './forecast-core';
import { DisplaySwitch, type DealDisplay } from './display';

type Rows = 'owner' | 'pipeline';

const isPeriod = (value: string | undefined): value is ForecastPeriod =>
  (FORECAST_PERIODS as string[]).includes(value ?? '');

export function ForecastPage() {
  const f = useDealFormat();
  const { location, navigate, setQuery } = useRouter();

  const pipelines = usePipelines();
  const users = useUsers();
  const userIndex = useUserIndex(users.data?.data);
  const known = useMemo(() => pipelines.data?.data ?? [], [pipelines.data]);

  const pipelineParam = location.query.pipeline ?? '';
  const one = known.find((p) => p.name === pipelineParam);
  const period: ForecastPeriod = isPeriod(location.query.period) ? location.query.period : 'quarter';
  // Rows by pipeline mean nothing on a single pipeline: one row, same as the total.
  const rows: Rows = location.query.rows === 'pipeline' && !one ? 'pipeline' : 'owner';

  const today = f.calendarToday();
  const span = horizonWindow(period, today);
  const from = span?.from ?? null;
  const to = span?.to ?? null;

  const body = useMemo<DealSearchBody>(() => {
    const filters: FilterCondition[] = [];
    if (from !== null && to !== null) filters.push({ property: 'close_date', operator: 'between', values: [from, to] });
    if (one) filters.push({ property: 'pipeline', operator: 'eq', value: one.name });
    return {
      ...(filters.length ? { filter: { op: 'and' as const, filters } } : {}),
      sort: [{ property: 'amount', direction: 'desc' as const }],
      properties: ['amount', 'weighted_amount', 'forecast_category', 'deal_status', 'pipeline', 'close_date'],
    };
  }, [from, to, one]);

  const search = useDealSearch(body);

  const deals = useMemo<ForecastDeal[]>(() => search.deals.map((deal) => ({
    id: deal.id,
    owner_id: deal.owner_id ?? null,
    pipeline: str(deal.properties.pipeline),
    amount: num(deal.properties.amount),
    weighted: num(deal.properties.weighted_amount),
    status: str(deal.properties.deal_status),
    category: str(deal.properties.forecast_category),
  })), [search.deals]);

  const rollup = useMemo(() => rollupForecast(deals, rows === 'owner' ? byOwner : byPipeline), [deals, rows]);
  const { total } = rollup;

  /* -------------------------------- naming -------------------------------- */

  const periodName = period === 'quarter'
    ? quarterName(today)
    : period === 'next_quarter'
      ? quarterName(quarterStart(today, 1))
      : period === 'last_quarter'
        ? quarterName(quarterStart(today, -1))
        : period === 'year'
          ? String(new Date(today).getUTCFullYear())
          : 'any close date';
  const periodRange = from !== null && to !== null ? f.dateRange(from, to, { timeZone: 'UTC' }) : null;
  const scope = one ? one.label : 'every pipeline';

  const lineName = (line: ForecastLine): string => {
    if (rows === 'pipeline') return known.find((p) => p.name === line.key)?.label ?? line.key;
    if (line.key === UNASSIGNED) return 'Unassigned';
    return userIndex.get(line.key)?.name ?? 'A former teammate';
  };

  /**
   * Where a cell opens: the board, filtered to exactly the deals the cell
   * summed. Won and lost deals sit in closed stages, so those links switch the
   * closed columns on and narrow by status; the three open columns narrow by
   * forecast category. An unassigned row has no owner to filter on, so its
   * cells are figures rather than links.
   */
  const cellHref = (line: ForecastLine | null, bucket: ForecastBucket): string | null => {
    const params = new URLSearchParams();
    params.set('pipeline', line && rows === 'pipeline' ? line.key : one ? one.name : ALL_PIPELINES);
    if (line && rows === 'owner') {
      if (line.key === UNASSIGNED) return null;
      params.set('owner', line.key);
    }
    if (bucket === 'won' || bucket === 'lost') {
      params.set('status', bucket);
      params.set('closed', '1');
    } else {
      params.set('forecast', bucket);
    }
    if (period !== 'all') params.set('horizon', period);
    return `/deals?${params.toString()}`;
  };

  const switchDisplay = (next: DealDisplay) => {
    if (next === 'forecast') return;
    const params = new URLSearchParams();
    if (one) params.set('pipeline', one.name);
    else if (known.length > 1) params.set('pipeline', ALL_PIPELINES);
    if (period !== 'all') params.set('horizon', period);
    if (next === 'table') params.set('display', 'table');
    const query = params.toString();
    navigate(`/deals${query ? `?${query}` : ''}`);
  };

  /* -------------------------------- render -------------------------------- */

  const share = (bucket: ForecastBucket): string =>
    (total.forecast.amount > 0 ? f.percent(total.cells[bucket].amount / total.forecast.amount, { decimals: 0 }) : '0%');

  const subtitle = search.error
    ? 'The forecast could not be read'
    : search.loading
      ? `Reading the deals closing ${period === 'all' ? 'on' : 'in'} ${periodName}…`
      : [
        `${f.plural(total.forecast.count, 'deal')} in the ${periodName} forecast on ${scope}`,
        `${f.money(total.forecast.amount)} forecast`,
        `${f.money(total.weighted)} weighted`,
      ].join(' · ');

  return (
    <Page
      width="wide"
      eyebrow="Deals"
      title="Forecast"
      subtitle={subtitle}
      actions={
        <>
          <DisplaySwitch value="forecast" onChange={switchDisplay} />
          <Button variant="primary" iconLeft={<Icons.plus size={14} />} onClick={() => navigate('/deals?new=1')}>
            New deal
          </Button>
        </>
      }
    >
      <div className="pl-toolbar">
        <Select
          value={one?.name ?? ALL_PIPELINES}
          onChange={(next) => setQuery({ pipeline: next === ALL_PIPELINES ? undefined : next, rows: undefined })}
          size="sm"
          icon={<Icons.layers size={13} />}
          aria-label="Pipeline"
          options={[
            { value: ALL_PIPELINES, label: 'Every pipeline' },
            ...known.map<SelectOption>((p) => ({ value: p.name, label: `${p.label}${p.is_default ? ' (default)' : ''}` })),
          ]}
        />
        <Select
          value={period}
          onChange={(next) => setQuery({ period: next === 'quarter' ? undefined : next })}
          size="sm"
          icon={<Icons.calendar size={13} />}
          aria-label="Period"
          options={FORECAST_PERIODS.map<SelectOption>((value) => ({ value, label: PERIOD_LABEL[value] }))}
        />
        <span className="pl-note">
          {periodRange ? `${periodName} · ${periodRange}` : 'Every deal, whatever its close date'}
        </span>
        <div className="pl-toolbar__spacer" />
        <SegmentedControl<Rows>
          value={rows}
          onChange={(next) => setQuery({ rows: next === 'owner' ? undefined : next })}
          size="sm"
          aria-label="Rows"
          options={[
            { value: 'owner', label: 'By owner' },
            { value: 'pipeline', label: 'By pipeline', disabled: !!one, title: one ? 'Pick every pipeline to compare them' : undefined },
          ]}
        />
      </div>

      {search.error && (
        <Card>
          <ErrorState
            title="The forecast could not be read"
            message={search.error.body.message}
            code={`${search.error.status} /v1/records/deal/search`}
            requestId={search.error.body.request_id ?? null}
            action={<Button variant="primary" iconLeft={<Icons.refresh size={14} />} onClick={search.refetch}>Try again</Button>}
          />
        </Card>
      )}

      {!search.error && search.loading && (
        <>
          <div className="pl-summary">
            {FORECAST_BUCKETS.map((bucket) => <Skeleton key={bucket} height={96} />)}
          </div>
          <Card><SkeletonText lines={6} /></Card>
        </>
      )}

      {!search.error && !search.loading && (
        <>
          {search.truncated && (
            <Banner tone="warning" compact bar>
              More deals close {period === 'all' ? 'on' : 'in'} {periodName} than this screen can total — the first
              {' '}{f.number(search.deals.length)} of {f.number(search.total)} are counted here. Narrow the pipeline or the period.
            </Banner>
          )}

          <div className="pl-summary">
            {FORECAST_BUCKETS.map((bucket) => {
              const cell = total.cells[bucket];
              const href = cellHref(null, bucket);
              return (
                <MetricTile
                  key={bucket}
                  className={`pl-forecast-tile is-${bucket}`}
                  label={BUCKET_LABEL[bucket]}
                  value={f.money(cell.amount)}
                  caption={cell.count === 0
                    ? BUCKET_HINT[bucket]
                    : `${f.plural(cell.count, 'deal')} · ${share(bucket)} of the forecast`}
                  onClick={href && cell.count > 0 ? () => navigate(href) : undefined}
                />
              );
            })}
            <Card padding="tight">
              <Stat
                label="Weighted forecast"
                value={f.money(total.weighted)}
                icon={<Icons.target size={15} />}
                caption="Commit, best case and pipeline at their stage probabilities"
              />
            </Card>
          </div>

          {rollup.deals === 0 && (
            <EmptyState
              title={period === 'all' ? `No deals on ${scope} yet` : `Nothing closes in ${periodName} yet`}
              body={period === 'all'
                ? 'Open the first opportunity and it rolls up here by owner and forecast category.'
                : `No deal on ${scope} has a close date between ${periodRange}. Set close dates on the board and they land here.`}
              action={period === 'all'
                ? <Button variant="primary" iconLeft={<Icons.plus size={14} />} onClick={() => navigate('/deals?new=1')}>New deal</Button>
                : <Button variant="primary" onClick={() => setQuery({ period: 'all' })}>Any close date</Button>}
              secondaryAction={period === 'all' ? undefined : <Button onClick={() => navigate('/deals?new=1')}>New deal</Button>}
            />
          )}

          {rollup.deals > 0 && (
            <Card
              title={rows === 'owner' ? 'By owner' : 'By pipeline'}
              description={`Each cell opens the board on exactly those deals. ${rows === 'owner' ? 'Largest forecast first.' : 'Largest forecast first.'}`}
            >
              <div className="pl-forecast__scroll">
                <table className={`pl-forecast${rows === 'pipeline' ? ' pl-forecast--pipelines' : ''}`}>
                  <thead>
                    <tr>
                      <th scope="col">{rows === 'owner' ? 'Owner' : 'Pipeline'}</th>
                      {FORECAST_BUCKETS.map((bucket) => (
                        <th scope="col" className="is-num" key={bucket} title={BUCKET_HINT[bucket]}>{BUCKET_LABEL[bucket]}</th>
                      ))}
                      <th scope="col" className="is-num" title="Open deals in the forecast at their stage probabilities">Weighted</th>
                      <th scope="col" className="is-num" title="Closed won, commit, best case and pipeline together">Forecast</th>
                      <th scope="col" className="pl-forecast__mixhead">Mix</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rollup.lines.map((line) => (
                      <tr key={line.key || 'unassigned'}>
                        <th scope="row">
                          <span className="pl-forecast__who">
                            {rows === 'owner' && line.key !== UNASSIGNED && (
                              <Avatar name={lineName(line)} seed={line.key} size={20} />
                            )}
                            <span className="u-truncate">{lineName(line)}</span>
                          </span>
                        </th>
                        {FORECAST_BUCKETS.map((bucket) => (
                          <td className="is-num" key={bucket}>
                            <CellView cell={line.cells[bucket]} href={cellHref(line, bucket)} f={f} />
                          </td>
                        ))}
                        <td className="is-num pl-forecast__weighted">{line.weighted > 0 ? f.money(line.weighted) : <span className="pl-muted">—</span>}</td>
                        <td className="is-num">
                          <span className="pl-forecast__amount">{f.money(line.forecast.amount)}</span>
                          <span className="pl-forecast__count">{f.plural(line.forecast.count, 'deal')}</span>
                        </td>
                        <td><Mix line={line} f={f} /></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">Total</th>
                      {FORECAST_BUCKETS.map((bucket) => (
                        <td className="is-num" key={bucket}>
                          <CellView cell={total.cells[bucket]} href={cellHref(null, bucket)} f={f} />
                        </td>
                      ))}
                      <td className="is-num pl-forecast__weighted">{f.money(total.weighted)}</td>
                      <td className="is-num">
                        <span className="pl-forecast__amount">{f.money(total.forecast.amount)}</span>
                        <span className="pl-forecast__count">{f.plural(total.forecast.count, 'deal')}</span>
                      </td>
                      <td><Mix line={total} f={f} /></td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {(total.cells.omitted.count > 0 || total.cells.lost.count > 0) && (
                <ul className="pl-forecast__notes">
                  {total.cells.omitted.count > 0 && (
                    <li>
                      <Link to={cellHref(null, 'omitted') ?? '/deals'}>
                        {f.plural(total.cells.omitted.count, 'open deal')} worth {f.money(total.cells.omitted.amount)}
                      </Link>
                      {' '}{total.cells.omitted.count === 1 ? 'is' : 'are'} marked Omitted and left out of every column.
                    </li>
                  )}
                  {total.cells.lost.count > 0 && (
                    <li>
                      <Link to={cellHref(null, 'lost') ?? '/deals'}>
                        {f.plural(total.cells.lost.count, 'deal')} worth {f.money(total.cells.lost.amount)}
                      </Link>
                      {' '}{total.cells.lost.count === 1 ? 'was' : 'were'} lost {period === 'all' ? 'altogether' : `in ${periodName}`}.
                    </li>
                  )}
                </ul>
              )}
            </Card>
          )}
        </>
      )}
    </Page>
  );
}

/* --------------------------------- pieces --------------------------------- */

type Fmt = ReturnType<typeof useDealFormat>;

/** One cell: the money and the count, as a link into the board when there is one. */
function CellView({ cell, href, f }: { cell: { amount: number; count: number }; href: string | null; f: Fmt }) {
  if (cell.count === 0) return <span className="pl-muted">—</span>;
  const inner = (
    <>
      <span className="pl-forecast__amount">{f.money(cell.amount)}</span>
      <span className="pl-forecast__count">{f.plural(cell.count, 'deal')}</span>
    </>
  );
  if (!href) return <span className="pl-forecast__cell">{inner}</span>;
  return <Link to={href} className="pl-forecast__cell pl-forecast__cell--link">{inner}</Link>;
}

/** The row's forecast as a bar of its four columns, so the shape reads before the figures do. */
function Mix({ line, f }: { line: ForecastLine; f: Fmt }) {
  const parts = composition(line);
  if (!parts.length) return <span className="pl-muted">—</span>;
  const label = parts.map((part) => `${BUCKET_LABEL[part.bucket]} ${f.percent(part.share, { decimals: 0 })}`).join(', ');
  return (
    <span className="pl-mix" role="img" aria-label={label} title={label}>
      {parts.map((part) => (
        <span key={part.bucket} className={`pl-mix__part is-${part.bucket}`} style={{ width: `${Math.max(1, Math.round(part.share * 100))}%` }} />
      ))}
    </span>
  );
}
