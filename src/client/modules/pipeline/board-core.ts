/**
 * What the deal board *is*, as values rather than as components.
 *
 * The close-date windows, the sort list, the shape of a board's state and the
 * translation between that state and the filter tree `/v1/views` stores are all
 * pure — no React, no fetch — so they can be reasoned about, and tested, on
 * their own. `api.ts` re-exports every one of them, so nothing that reads the
 * board has to know they moved.
 */

import type { SortState } from '../../design/table-core';

/** One calendar day. Close dates are days, stored at midnight UTC. */
export const DAY_MS = 86_400_000;

export type Horizon = 'all' | 'overdue' | '30' | '42' | 'quarter' | 'next_quarter' | 'last_quarter' | 'year';

export const HORIZON_LABEL: Record<Horizon, string> = {
  all: 'Any close date',
  overdue: 'Past its close date',
  '30': 'Closing within 30 days',
  '42': 'Closing within six weeks',
  quarter: 'Closing this quarter',
  next_quarter: 'Closing next quarter',
  last_quarter: 'Close date last quarter',
  year: 'Closing this year',
};

/**
 * The order the close-date control offers them in.
 *
 * Not `Object.keys(HORIZON_LABEL)`: two of the keys are integer-like, so the
 * runtime hoists "30" and "42" above everything else and the menu opened on
 * "Closing within 30 days" with the default, "Any close date", third. The
 * widest window first, then the past, then the three that narrow forward.
 */
export const HORIZONS: Horizon[] = ['all', 'overdue', '30', '42', 'quarter', 'next_quarter', 'last_quarter', 'year'];

/**
 * The windows a forecast is read over.
 *
 * A subset of the board's horizons, because every cell of the forecast links
 * into the board with the same window: "Priya's commit next quarter" on the
 * forecast has to be the set the board draws when the cell is opened.
 */
export type ForecastPeriod = Extract<Horizon, 'quarter' | 'next_quarter' | 'last_quarter' | 'year' | 'all'>;

export const FORECAST_PERIODS: ForecastPeriod[] = ['quarter', 'next_quarter', 'last_quarter', 'year', 'all'];

export const PERIOD_LABEL: Record<ForecastPeriod, string> = {
  quarter: 'This quarter',
  next_quarter: 'Next quarter',
  last_quarter: 'Last quarter',
  year: 'This year',
  all: 'Any close date',
};

/** The six-week commit window, as the dashboard widget and the board both read it. */
export const SIX_WEEK_DAYS = 42;

/**
 * The board with every pipeline on it at once.
 *
 * A workspace's deals do not live on one pipeline, and every number that counts
 * across them — the dashboard's six-week commit, a quarter's open pipeline —
 * had nowhere to land: the board could only ever be one pipeline, so a card
 * counting 14 deals linked to a board showing 7 of them. `all` is the value the
 * pipeline control and the `?pipeline=` parameter carry for that. A pipeline
 * whose own `name` is literally `all` still wins the lookup, so this can never
 * shadow a real one.
 */
export const ALL_PIPELINES = 'all';

/**
 * A stage is only identified by its pipeline *and* its name.
 *
 * Three pipelines here each have a stage called `qualification`, and two call it
 * something different on screen — New business says "Qualification", Expansion
 * says "Expansion identified". Anything keyed on the bare stage name silently
 * merges them, which is how a stalled-deal threshold from one pipeline ends up
 * badged on another pipeline's card.
 */
export const stageKey = (pipeline: string, stage: string): string => `${pipeline}\u0000${stage}`;


/**
 * Midnight UTC of the first day of the quarter `today` falls in — or, with an
 * offset, of the quarter that many quarters away. `Date.UTC` carries a month
 * of 12 or -3 into the neighbouring year by itself.
 */
export const quarterStart = (today: number, offset = 0): number => {
  const date = new Date(today);
  const month = date.getUTCMonth();
  return Date.UTC(date.getUTCFullYear(), month - (month % 3) + 3 * offset, 1);
};

/** Midnight UTC of the last day of that quarter. */
export const quarterEnd = (today: number, offset = 0): number => quarterStart(today, offset + 1) - DAY_MS;

/** "Q4 2026" — the quarter a calendar day falls in, the way a forecast call names it. */
export const quarterName = (day: number): string => {
  const date = new Date(day);
  return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`;
};

/**
 * Whether a calendar day needs its year said.
 *
 * A card reading "Oct 21" under a deal booked on 21 October *last* year reads as
 * next month. Dates in the year the workspace is in drop the year, as every
 * card always did; a date in any other year keeps it. Both are UTC days — close
 * dates are stored as midnight UTC, and `today` is the workspace's civil day
 * already resolved to one.
 */
export const needsYear = (day: number, today: number): boolean =>
  new Date(day).getUTCFullYear() !== new Date(today).getUTCFullYear();

/**
 * The verb the record's close-date hint opens with, or null for a deal that is
 * still open. A lost deal's close date is the day it was lost — it was never
 * "Booked", and a forecast reviewer reading "Booked in 4 days" over a
 * Closed-lost badge has been told two things at once.
 */
export const closedVerb = (stage: { is_closed: boolean; is_won: boolean } | undefined): 'Booked' | 'Lost' | null =>
  (!stage?.is_closed ? null : stage.is_won ? 'Booked' : 'Lost');

/**
 * The close-date window a horizon names, as inclusive calendar days.
 *
 * Both windows used to be open at the bottom — "closing within 30 days" was
 * really "closing before the 30th", so a deal whose close date passed eight
 * months ago sat in it, and in "closing this quarter", and in "past its close
 * date" all at once. It also disagreed with what saving the board as a view
 * stored (`close_date between today and +30d`), so a view read back showed a
 * different set of deals than the board it was saved from. One window
 * definition now answers both.
 */
export function horizonWindow(horizon: Horizon, today: number): { from: number | null; to: number | null } | null {
  switch (horizon) {
    case 'overdue': return { from: null, to: today - DAY_MS };
    case '30': return { from: today, to: today + 30 * DAY_MS };
    case '42': return { from: today, to: today + SIX_WEEK_DAYS * DAY_MS };
    case 'quarter': return { from: quarterStart(today), to: quarterEnd(today) };
    case 'next_quarter': return { from: quarterStart(today, 1), to: quarterEnd(today, 1) };
    case 'last_quarter': return { from: quarterStart(today, -1), to: quarterEnd(today, -1) };
    case 'year': {
      const year = new Date(today).getUTCFullYear();
      return { from: Date.UTC(year, 0, 1), to: Date.UTC(year + 1, 0, 1) - DAY_MS };
    }
    default: return null;
  }
}

/** Whether a stored close date falls inside the horizon's window. */
export function matchesHorizon(close: number | null, horizon: Horizon, today: number): boolean {
  const window = horizonWindow(horizon, today);
  if (!window) return true;
  if (close === null) return false;
  if (window.from !== null && close < window.from) return false;
  if (window.to !== null && close > window.to) return false;
  return true;
}

export const SORTS: { value: string; label: string; sort: string; order: 'asc' | 'desc' }[] = [
  { value: 'amount', label: 'Largest first', sort: 'amount', order: 'desc' },
  { value: 'close', label: 'Closing soonest', sort: 'close_date', order: 'asc' },
  { value: 'stage', label: 'Longest in stage', sort: 'stage_entered_at', order: 'asc' },
  { value: 'updated', label: 'Recently updated', sort: 'updated', order: 'desc' },
];

/**
 * Everything a saved view remembers.
 *
 * Not the free-text search: a view is the shape of the question ("Priya's
 * commit deals closing this quarter"), and the search box is how you find one
 * record inside it. HubSpot draws the same line, and saving the search would
 * make every view stale the moment the deal it named was renamed.
 */
export interface BoardState {
  pipeline: string;
  owner: string;
  forecast: string;
  horizon: Horizon;
  sort: string;
  closed: boolean;
}


/* ------------------------------ saved views ------------------------------- */

export interface FilterCondition { property: string; operator: string; value?: unknown; values?: unknown[] }
export interface FilterGroup { op: 'and' | 'or'; filters: (FilterGroup | FilterCondition)[] }
export type FilterNode = FilterGroup | FilterCondition;

/** The part of a saved view these two translators actually read. */
export interface StoredView {
  filter: FilterNode | null;
  sort: { property: string; direction?: 'asc' | 'desc' }[];
}

const isGroup = (node: FilterNode): node is FilterGroup =>
  typeof (node as FilterGroup).op === 'string' && Array.isArray((node as FilterGroup).filters);

/** Every leaf condition in a view's filter, whatever it is nested inside. */
export function conditionsOf(node: FilterNode | null): FilterCondition[] {
  if (!node) return [];
  if (!isGroup(node)) return [node];
  return node.filters.flatMap((child) => conditionsOf(child));
}

const CLOSE_WINDOW: Record<string, Horizon> = {
  'today|+30d': '30',
  'today|+42d': '42',
  'start_of_quarter|end_of_quarter': 'quarter',
  'start_of_year|end_of_year': 'year',
};

/**
 * The horizons whose windows are written to a view as calendar days rather
 * than as tokens: the filter engine has `start_of_quarter` but no word for the
 * quarter after it, so "closing next quarter" is stored as the two dates that
 * quarter has today. Read back, those dates are recognised as whichever
 * quarter they are *now* — a view saved in September as next quarter is, in
 * November, the deals closing this quarter, which is the same deals.
 */
const DATED_HORIZONS: Horizon[] = ['quarter', 'next_quarter', 'last_quarter', 'year'];

const sameWindow = (a: { from: number | null; to: number | null } | null, from: number, to: number): boolean =>
  !!a && a.from === from && a.to === to;

/**
 * A saved view, read back as the board controls that produced it.
 *
 * The server stores a real filter tree — the same one the record search
 * compiles — so a view saved here is a view the API understands, not an opaque
 * blob only this screen can read. Reading it back means recognising the handful
 * of shapes these controls can write; `readable` says whether that succeeded,
 * so a view built elsewhere is never silently shown as something it is not.
 */
export function viewToState(view: StoredView, today?: number): { state: BoardState; readable: boolean } {
  // No pipeline condition means the view does not filter by pipeline, which is
  // every pipeline — not "whichever happens to be the default", which is what
  // this used to read it back as and is a different set of deals.
  const state: BoardState = {
    pipeline: ALL_PIPELINES, owner: '', forecast: '', horizon: 'all', sort: 'amount', closed: true,
  };
  let readable = view.filter === null || isGroup(view.filter);
  for (const condition of conditionsOf(view.filter)) {
    const value = typeof condition.value === 'string' ? condition.value : '';
    if (condition.property === 'pipeline' && condition.operator === 'eq') state.pipeline = value;
    else if (condition.property === 'owner_id' && condition.operator === 'eq') state.owner = value;
    else if (condition.property === 'forecast_category' && condition.operator === 'eq') state.forecast = value;
    else if (condition.property === 'deal_status' && condition.operator === 'eq' && value === 'open') state.closed = false;
    else if (condition.property === 'close_date' && condition.operator === 'before' && value === 'today') state.horizon = 'overdue';
    else if (condition.property === 'close_date' && condition.operator === 'between') {
      const values = condition.values ?? [];
      const key = values.map(String).join('|');
      const [from, to] = values;
      const dated = typeof from === 'number' && typeof to === 'number' && today !== undefined
        ? DATED_HORIZONS.find((horizon) => sameWindow(horizonWindow(horizon, today), from, to))
        : undefined;
      if (CLOSE_WINDOW[key]) state.horizon = CLOSE_WINDOW[key];
      else if (dated) state.horizon = dated;
      else readable = false;
    } else readable = false;
  }
  const sort = SORTS.find((row) => row.sort === view.sort[0]?.property && row.order === (view.sort[0]?.direction ?? 'asc'));
  if (sort) state.sort = sort.value;
  return { state, readable };
}

/**
 * The same journey the other way: the board's controls as a stored filter.
 *
 * `today` is the workspace's civil day; it is only read for the two quarter
 * windows the filter engine has no token for, which are stored as dates.
 */
export function stateToView(state: BoardState, today?: number): { filter: FilterNode | null; sort: StoredView['sort'] } {
  const filters: FilterCondition[] = [];
  if (state.pipeline && state.pipeline !== ALL_PIPELINES) {
    filters.push({ property: 'pipeline', operator: 'eq', value: state.pipeline });
  }
  if (!state.closed) filters.push({ property: 'deal_status', operator: 'eq', value: 'open' });
  if (state.owner) filters.push({ property: 'owner_id', operator: 'eq', value: state.owner });
  if (state.forecast) filters.push({ property: 'forecast_category', operator: 'eq', value: state.forecast });
  if (state.horizon === 'overdue') filters.push({ property: 'close_date', operator: 'before', value: 'today' });
  if (state.horizon === '30') filters.push({ property: 'close_date', operator: 'between', values: ['today', '+30d'] });
  if (state.horizon === '42') filters.push({ property: 'close_date', operator: 'between', values: ['today', `+${SIX_WEEK_DAYS}d`] });
  if (state.horizon === 'quarter') filters.push({ property: 'close_date', operator: 'between', values: ['start_of_quarter', 'end_of_quarter'] });
  if (state.horizon === 'year') filters.push({ property: 'close_date', operator: 'between', values: ['start_of_year', 'end_of_year'] });
  if (state.horizon === 'next_quarter' || state.horizon === 'last_quarter') {
    const window = horizonWindow(state.horizon, today ?? Date.now());
    if (window && window.from !== null && window.to !== null) {
      filters.push({ property: 'close_date', operator: 'between', values: [window.from, window.to] });
    }
  }
  const chosen = SORTS.find((row) => row.value === state.sort) ?? SORTS[0];
  return {
    filter: filters.length ? { op: 'and', filters } : null,
    sort: [{ property: chosen.sort, direction: chosen.order }],
  };
}

export const sameBoardState = (a: BoardState, b: BoardState): boolean =>
  a.pipeline === b.pipeline && a.owner === b.owner && a.forecast === b.forecast
  && a.horizon === b.horizon && a.sort === b.sort && a.closed === b.closed;

/** What a view narrows to, in the words its own controls use. */
export function describeBoardState(state: BoardState, o: {
  pipelineLabel: (name: string) => string;
  ownerName: (id: string) => string;
  forecastLabel: (value: string) => string;
}): string {
  const parts = [
    state.pipeline === ALL_PIPELINES ? 'every pipeline' : state.pipeline && o.pipelineLabel(state.pipeline),
    state.owner && o.ownerName(state.owner),
    state.forecast && o.forecastLabel(state.forecast),
    state.horizon !== 'all' && HORIZON_LABEL[state.horizon].toLowerCase(),
    state.closed ? 'closed stages included' : 'open stages only',
    (SORTS.find((row) => row.value === state.sort) ?? SORTS[0]).label.toLowerCase(),
  ].filter(Boolean);
  return parts.join(' · ');
}


/* ------------------------------ typed dates ------------------------------- */

/** The order a locale writes a numeric date in: 3/10/2026 is March in one and October in another. */
export type DateOrder = 'mdy' | 'dmy' | 'ymd';

/** Read the order off the locale's own formatting of a known date. */
export function dateOrderOf(locale: string): DateOrder {
  try {
    const parts = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' })
      .formatToParts(Date.UTC(2001, 1, 3))
      .filter((part) => part.type === 'year' || part.type === 'month' || part.type === 'day')
      .map((part) => part.type[0])
      .join('');
    if (parts === 'dmy' || parts === 'ymd') return parts;
  } catch { /* an unknown locale reads like en-US */ }
  return 'mdy';
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
];

/** "oct", "octo", "october" all name the tenth month; "octember" names nothing. */
const monthIndex = (word: string): number => {
  const key = word.toLowerCase();
  if (key.length < 3) return -1;
  return MONTH_NAMES.findIndex((name) => name.startsWith(key));
};

const fullYear = (raw: number): number => (raw < 100 ? 2000 + raw : raw);

/** Midnight UTC of the day, or null when the month has no such day. */
const civilUtc = (year: number, month: number, day: number): number | null => {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ts = Date.UTC(year, month - 1, day);
  const back = new Date(ts);
  return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day ? ts : null;
};

/**
 * A date as a person types one, read back as the calendar day it names.
 *
 * The calendar was the only way to enter a close date, and a forecast review
 * that moves twelve close dates by a fortnight is twelve rounds of clicking
 * through months. Accepted: ISO (`2026-10-21`), numeric in the workspace
 * locale's own order (`10/21/2026`, `21.10.2026`, `21/10`), a month by name in
 * either position (`Oct 21`, `21 October 2026`, `October 21, 2026`), a two-digit
 * year, and `today` / `tomorrow` / `yesterday`. A missing year is this year.
 * Anything else is null — never a guess written to the record.
 */
export function parseTypedDate(text: string, order: DateOrder, today: number): number | null {
  const raw = text.trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'today') return today;
  if (raw === 'tomorrow') return today + DAY_MS;
  if (raw === 'yesterday') return today - DAY_MS;
  const thisYear = new Date(today).getUTCFullYear();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (iso) return civilUtc(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const tokens = raw.split(/[\s,./-]+/).filter(Boolean);
  if (!tokens.length || tokens.length > 3) return null;

  const named = tokens.findIndex((token) => /^[a-z]+$/.test(token) && monthIndex(token) >= 0);
  if (named >= 0) {
    const month = monthIndex(tokens[named]) + 1;
    const numbers = tokens.filter((_, i) => i !== named);
    if (numbers.length === 0 || numbers.length > 2 || numbers.some((n) => !/^\d+$/.test(n))) return null;
    const values = numbers.map(Number);
    if (values.length === 1) return civilUtc(thisYear, month, values[0]);
    // Two numbers beside a month name: the year is the one that cannot be a day.
    const [first, second] = values;
    const yearFirst = numbers[0].length === 4 || first > 31;
    const day = yearFirst ? second : first;
    const year = fullYear(yearFirst ? first : second);
    return civilUtc(year, month, day);
  }

  if (tokens.some((token) => !/^\d+$/.test(token))) return null;
  const values = tokens.map(Number);
  if (values.length === 2) {
    const [a, b] = values;
    return order === 'dmy' ? civilUtc(thisYear, b, a) : civilUtc(thisYear, a, b);
  }
  if (tokens[0].length === 4) return civilUtc(values[0], values[1], values[2]);
  const [a, b, c] = values;
  if (order === 'dmy') return civilUtc(fullYear(c), b, a);
  if (order === 'ymd') return civilUtc(fullYear(a), b, c);
  return civilUtc(fullYear(c), a, b);
}

/** What to show under an empty typed-date field, in the locale's own order. */
export const dateExample = (order: DateOrder, today: number): string => {
  const sample = today;
  const y = new Date(sample).getUTCFullYear();
  const m = String(new Date(sample).getUTCMonth() + 1).padStart(2, '0');
  const d = String(new Date(sample).getUTCDate()).padStart(2, '0');
  return order === 'dmy' ? `${d}/${m}/${y}` : order === 'ymd' ? `${y}-${m}-${d}` : `${m}/${d}/${y}`;
};

/* ------------------------------ table sorting ----------------------------- */

/**
 * A sorted column that is clicked again reverses; it does not go blank first.
 *
 * The grid's own cycle is ascending → descending → unsorted, which on a money
 * column means the second click on "Amount" puts the deals in whatever order
 * the server sent them and the third finally flips the sort. The unsorted
 * state carries no information on this table — there is no natural order to
 * a set of deals — so a change that only clears the sort is read as a request
 * to reverse it. Anything else about the state (a search, a filter, a sort on
 * another column) passes through untouched.
 */
export function reverseClearedSort<T extends { sort: SortState | null; query: string; filters: unknown }>(prev: T, next: T): T {
  if (!prev.sort || next.sort !== null) return next;
  if (next.query !== prev.query || next.filters !== prev.filters) return next;
  return { ...next, sort: { columnId: prev.sort.columnId, direction: prev.sort.direction === 'asc' ? 'desc' : 'asc' } };
}

/* ------------------------- moving around the board ------------------------ */

/**
 * The board as a grid of deal ids: one array per column, in the order the
 * columns are drawn.
 */
export type BoardGrid = string[][];

/** The keys that move the roving focus, so the handler can ignore everything else. */
export const BOARD_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'] as const;

export type BoardKey = (typeof BOARD_KEYS)[number];

export const isBoardKey = (key: string): key is BoardKey => (BOARD_KEYS as readonly string[]).includes(key);

/**
 * Where a key press moves the keyboard on the board, or null for nowhere.
 *
 * The columns are deliberately not tab stops and the cards used to be, which
 * meant 36 Tab presses to reach the first card and then one press per card to
 * leave the column you were in — on a 22-card board, the keyboard could not
 * cross the board at all in any reasonable number of keystrokes. One card holds
 * the tab stop and these keys move it, which is the grid pattern every other
 * two-dimensional control uses.
 *
 * Left and right skip empty columns rather than stopping in them: a column with
 * no cards has nothing to put the keyboard on, and stopping there would make
 * crossing a sparse board take one press per empty stage.
 */
export function boardMove(grid: BoardGrid, from: string, key: BoardKey): string | null {
  let column = -1;
  let row = -1;
  for (let c = 0; c < grid.length; c += 1) {
    const at = grid[c].indexOf(from);
    if (at >= 0) { column = c; row = at; break; }
  }
  if (column < 0) return grid.flat()[0] ?? null;
  const here = grid[column];
  if (key === 'ArrowDown') return here[row + 1] ?? null;
  if (key === 'ArrowUp') return here[row - 1] ?? null;
  if (key === 'Home') return here[0] !== from ? here[0] : null;
  if (key === 'End') return here[here.length - 1] !== from ? here[here.length - 1] : null;
  const step = key === 'ArrowRight' ? 1 : -1;
  for (let c = column + step; c >= 0 && c < grid.length; c += step) {
    const next = grid[c];
    if (next.length) return next[Math.min(row, next.length - 1)];
  }
  return null;
}

/**
 * The card that holds the board's single tab stop.
 *
 * The last card the keyboard was on, while it is still on the board — a card
 * filtered away, moved to a hidden closed stage or dragged elsewhere takes the
 * tab stop with it, and a board where no card carries `tabindex="0"` cannot be
 * reached from the keyboard at all.
 */
export function boardTabStop(grid: BoardGrid, roving: string | null): string | null {
  if (roving && grid.some((column) => column.includes(roving))) return roving;
  for (const column of grid) if (column.length) return column[0];
  return null;
}

/* ------------------------------- closed deals ----------------------------- */

/**
 * The word a closed deal leads with on its card and its record, or null while
 * it is still open.
 *
 * `closedVerb` is the verb for its close *date* ("Booked 319 days ago"); this is
 * the outcome itself. A won or lost deal used to wear open-deal clothing — "95
 * days in stage" under a "$0.00" weighted chip — as if it were still waiting
 * somewhere. It is not: it is won, or it is lost, on a day, for a reason, and
 * that is what a closed-won review reads off the card.
 */
export const outcomeWord = (stage: { is_closed: boolean; is_won: boolean } | undefined): 'Won' | 'Lost' | null =>
  (!stage?.is_closed ? null : stage.is_won ? 'Won' : 'Lost');

/** The deal statuses the address can narrow to — how a forecast cell reaches its won or lost deals. */
export type OutcomeFilter = '' | 'won' | 'lost';

/**
 * The stages a pipeline contributes to the board.
 *
 * Narrowed to one outcome — the forecast's "5 deals were lost in Q3" link —
 * the only column that can hold a match is that outcome's own closed stage;
 * the five open columns before it are empty by construction, and drawing them
 * put every lost card off-screen to the right under a row of "Add a deal
 * here". So an outcome filter draws that column and nothing else. Otherwise the
 * closed stages come and go with the switch.
 */
export function columnsFor<S extends { is_closed: boolean; is_won: boolean }>(
  stages: S[], showClosed: boolean, status: OutcomeFilter,
): S[] {
  if (status) return stages.filter((stage) => stage.is_closed && stage.is_won === (status === 'won'));
  return stages.filter((stage) => showClosed || !stage.is_closed);
}

/**
 * The money a set of deals is described by, in the words the filter has chosen.
 *
 * "$0.00 open · $0.00 weighted" over five lost deals is arithmetic about the
 * wrong thing: a set narrowed to an outcome is worth what closed, not what is
 * still forecast.
 */
export function moneyLine(o: {
  status: OutcomeFilter;
  open: { amount: number; weighted: number };
  closed: { amount: number };
  money: (minor: number) => string;
}): string {
  if (o.status) return `${o.money(o.closed.amount)} ${o.status}`;
  return `${o.money(o.open.amount)} open · ${o.money(o.open.weighted)} weighted`;
}

/** The board's subtitle: how many deals, where, and what they are worth. */
export function boardHeadline(o: {
  shown: number;
  /** "on New business" or "across 3 pipelines". */
  where: string;
  showClosed: boolean;
  status: OutcomeFilter;
  open: { amount: number; weighted: number };
  closed: { amount: number };
  plural: (count: number, word: string) => string;
  money: (minor: number) => string;
}): string {
  const what = o.status ? `${o.status} deal` : 'deal';
  const scope = `${o.plural(o.shown, what)} ${o.where}${o.status || o.showClosed ? '' : ', open stages only'}`;
  return `${scope} · ${moneyLine(o)}`;
}

/* --------------------------- one sort, two controls ----------------------- */

/**
 * What each toolbar sort means on the table, as the column and direction the
 * grid would show it as.
 *
 * The toolbar's sort and the table's header sort were two controls over one
 * order: clicking "Close date" sorted the grid ascending by close date while
 * the toolbar still read "Largest first". The table's sort state is the truth
 * on the table view, and this is how the toolbar reads and writes it.
 */
export const TABLE_SORT: Record<string, SortState> = {
  amount: { columnId: 'amount', direction: 'desc' },
  close: { columnId: 'close_date', direction: 'asc' },
  stage: { columnId: 'stage_age', direction: 'desc' },
  updated: { columnId: 'updated', direction: 'desc' },
};

/**
 * The toolbar option a table sort *is*, or null when no option says it — a
 * grid sorted by probability, or by amount ascending, is an order the toolbar
 * has no word for, and it has to say so rather than keep reading "Largest first".
 */
export function sortKeyOf(sort: SortState | null): string | null {
  if (!sort) return null;
  for (const [key, state] of Object.entries(TABLE_SORT)) {
    if (state.columnId === sort.columnId && state.direction === sort.direction) return key;
  }
  return null;
}

/** The value the toolbar sort holds while the table is in an order it cannot name. */
export const CUSTOM_SORT = 'table';

/** "By close date, ascending" — the label the toolbar shows for such an order. */
export const describeTableSort = (sort: SortState, header: string): string =>
  `By ${header.toLowerCase()}, ${sort.direction === 'asc' ? 'ascending' : 'descending'}`;
