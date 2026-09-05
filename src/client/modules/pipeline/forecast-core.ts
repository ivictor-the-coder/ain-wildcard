/**
 * The forecast rollup, as arithmetic.
 *
 * A forecast is the deals closing in a period, grouped by who owns them and by
 * how sure the stage says they are. Nothing here is computed from a probability:
 * `forecast_category` and `deal_status` are stamped on the deal by the stage it
 * sits in, `weighted_amount` is the CRM's own product, and this file only sorts
 * those figures into cells and adds them up — so a cell on the forecast is the
 * same sum the board's stat tiles make for the same filter.
 */

/** The columns of the forecast, in the order a forecast call reads them. */
export type ForecastBucket = 'won' | 'commit' | 'best_case' | 'pipeline' | 'omitted' | 'lost';

/** The four that make up the forecast; `omitted` and `lost` are footnotes. */
export const FORECAST_BUCKETS: ForecastBucket[] = ['won', 'commit', 'best_case', 'pipeline'];

export const BUCKET_LABEL: Record<ForecastBucket, string> = {
  won: 'Closed won',
  commit: 'Commit',
  best_case: 'Best case',
  pipeline: 'Pipeline',
  omitted: 'Omitted',
  lost: 'Closed lost',
};

/** What each column means, in the words the stage definitions use. */
export const BUCKET_HINT: Record<ForecastBucket, string> = {
  won: 'Booked in this period',
  commit: 'Stages the workspace counts as committed',
  best_case: 'Likely if the quarter goes well',
  pipeline: 'Open, early, not yet forecast',
  omitted: 'Left out of the forecast on purpose',
  lost: 'Lost in this period',
};

/** The fields of a deal the rollup reads — a structural slice of the record. */
export interface ForecastDeal {
  id: string;
  owner_id: string | null;
  pipeline: string;
  amount: number;
  weighted: number;
  status: string;
  category: string;
}

export interface ForecastCell { amount: number; count: number }

export interface ForecastLine {
  /** Whatever the rows are grouped by — an owner id, a pipeline name. */
  key: string;
  cells: Record<ForecastBucket, ForecastCell>;
  /** Won + commit + best case + pipeline: the figure the row is ranked on. */
  forecast: ForecastCell;
  /** Open deals in the three forecast columns, at their stage probabilities. */
  weighted: number;
}

export interface ForecastRollup {
  lines: ForecastLine[];
  total: ForecastLine;
  deals: number;
}

/**
 * Which column a deal belongs in.
 *
 * Status decides first: a won deal is won and a lost deal is lost whatever
 * category its closing stage carries (both closed stages say `closed`). An
 * open deal goes where its stage's forecast category puts it; an open deal
 * whose category is not one of the three forecast columns — `omitted`, or a
 * category the workspace defined and this rollup has no column for — is left
 * out of the forecast and counted in the footnote so it is not silently lost.
 */
export function bucketOf(deal: Pick<ForecastDeal, 'status' | 'category'>): ForecastBucket {
  if (deal.status === 'won') return 'won';
  if (deal.status === 'lost') return 'lost';
  if (deal.category === 'commit' || deal.category === 'best_case' || deal.category === 'pipeline') return deal.category;
  return 'omitted';
}

const emptyCell = (): ForecastCell => ({ amount: 0, count: 0 });

const emptyLine = (key: string): ForecastLine => ({
  key,
  cells: { won: emptyCell(), commit: emptyCell(), best_case: emptyCell(), pipeline: emptyCell(), omitted: emptyCell(), lost: emptyCell() },
  forecast: emptyCell(),
  weighted: 0,
});

const add = (cell: ForecastCell, amount: number) => { cell.amount += amount; cell.count += 1; };

function place(line: ForecastLine, deal: ForecastDeal): void {
  const bucket = bucketOf(deal);
  add(line.cells[bucket], deal.amount);
  if (bucket === 'omitted' || bucket === 'lost') return;
  add(line.forecast, deal.amount);
  if (bucket !== 'won') line.weighted += deal.weighted;
}

/**
 * Group the deals into lines and total them.
 *
 * Lines come back largest forecast first, then by key so two equal rows keep a
 * stable order between renders. The total is the same arithmetic over every
 * deal, not a sum of the lines — the two agree by construction, and computing
 * it separately is what lets a test say so.
 */
export function rollupForecast(deals: ForecastDeal[], keyOf: (deal: ForecastDeal) => string): ForecastRollup {
  const lines = new Map<string, ForecastLine>();
  const total = emptyLine('total');
  for (const deal of deals) {
    const key = keyOf(deal);
    let line = lines.get(key);
    if (!line) { line = emptyLine(key); lines.set(key, line); }
    place(line, deal);
    place(total, deal);
  }
  return {
    lines: [...lines.values()].sort((a, b) => (b.forecast.amount - a.forecast.amount) || a.key.localeCompare(b.key)),
    total,
    deals: deals.length,
  };
}

/** A line's forecast columns as shares of its own forecast, for the composition bar. */
export function composition(line: ForecastLine): { bucket: ForecastBucket; share: number }[] {
  const whole = line.forecast.amount;
  if (whole <= 0) return [];
  return FORECAST_BUCKETS
    .map((bucket) => ({ bucket, share: line.cells[bucket].amount / whole }))
    .filter((part) => part.share > 0);
}

/** Rows keyed by owner; a deal nobody owns is its own row rather than dropped. */
export const UNASSIGNED = '';

export const byOwner = (deal: ForecastDeal): string => deal.owner_id ?? UNASSIGNED;
export const byPipeline = (deal: ForecastDeal): string => deal.pipeline;
