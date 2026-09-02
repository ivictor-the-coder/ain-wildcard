/**
 * What the deal board *is*, as values rather than as components.
 *
 * The close-date windows, the sort list, the shape of a board's state and the
 * translation between that state and the filter tree `/v1/views` stores are all
 * pure — no React, no fetch — so they can be reasoned about, and tested, on
 * their own. `api.ts` re-exports every one of them, so nothing that reads the
 * board has to know they moved.
 */

/** One calendar day. Close dates are days, stored at midnight UTC. */
export const DAY_MS = 86_400_000;

export type Horizon = 'all' | 'overdue' | '30' | '42' | 'quarter';

export const HORIZON_LABEL: Record<Horizon, string> = {
  all: 'Any close date',
  overdue: 'Past its close date',
  '30': 'Closing within 30 days',
  '42': 'Closing within six weeks',
  quarter: 'Closing this quarter',
};

/**
 * The order the close-date control offers them in.
 *
 * Not `Object.keys(HORIZON_LABEL)`: two of the keys are integer-like, so the
 * runtime hoists "30" and "42" above everything else and the menu opened on
 * "Closing within 30 days" with the default, "Any close date", third. The
 * widest window first, then the past, then the three that narrow forward.
 */
export const HORIZONS: Horizon[] = ['all', 'overdue', '30', '42', 'quarter'];

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


/** Midnight UTC of the first day of the quarter `today` falls in. */
export const quarterStart = (today: number): number => {
  const date = new Date(today);
  const month = date.getUTCMonth();
  return Date.UTC(date.getUTCFullYear(), month - (month % 3), 1);
};

/** Midnight UTC of the last day of that quarter. */
export const quarterEnd = (today: number): number => {
  const date = new Date(today);
  const month = date.getUTCMonth();
  return Date.UTC(date.getUTCFullYear(), month - (month % 3) + 3, 1) - DAY_MS;
};

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
};

/**
 * A saved view, read back as the board controls that produced it.
 *
 * The server stores a real filter tree — the same one the record search
 * compiles — so a view saved here is a view the API understands, not an opaque
 * blob only this screen can read. Reading it back means recognising the handful
 * of shapes these controls can write; `readable` says whether that succeeded,
 * so a view built elsewhere is never silently shown as something it is not.
 */
export function viewToState(view: StoredView): { state: BoardState; readable: boolean } {
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
      const key = (condition.values ?? []).map(String).join('|');
      if (CLOSE_WINDOW[key]) state.horizon = CLOSE_WINDOW[key];
      else readable = false;
    } else readable = false;
  }
  const sort = SORTS.find((row) => row.sort === view.sort[0]?.property && row.order === (view.sort[0]?.direction ?? 'asc'));
  if (sort) state.sort = sort.value;
  return { state, readable };
}

/** The same journey the other way: the board's controls as a stored filter. */
export function stateToView(state: BoardState): { filter: FilterNode | null; sort: StoredView['sort'] } {
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
