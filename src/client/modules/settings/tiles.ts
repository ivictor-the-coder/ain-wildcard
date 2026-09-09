/**
 * What a summary tile may say when the read behind it has not answered.
 *
 * Every tile on this surface is a number computed off a list read — the active
 * tax registrations, the jobs waiting, the features defined. The lists rendered
 * their failure honestly, with the route and a retry, while the tiles above
 * them fell through `?? []` into a real-looking zero: a register whose read had
 * just answered 500 read "Active registrations 0 · Across 0 countries". A zero
 * is a claim about the workspace; a read that did not answer supports no claim
 * at all. So a tile is computed only once every read it depends on has data,
 * and until then it shows a dash and says which read it is waiting on.
 */

export interface TileRead {
  error: unknown | null;
  loading: boolean;
}

export interface TileText {
  value: string;
  caption: string;
}

export type Tile = TileText & {
  /** `ready` is a number; `reading` and `unread` are a dash with a reason. */
  state: 'ready' | 'reading' | 'unread';
};

export const TILE_DASH = '—';

/**
 * `reads` are the queries the number is derived from; `route` names the one an
 * operator would retry, in the words the failure banner uses. `ready` is only
 * called once nothing is loading and nothing has failed.
 */
export function tileOf(reads: readonly TileRead[], route: string, ready: () => TileText): Tile {
  if (reads.some((read) => read.error)) {
    return {
      value: TILE_DASH,
      caption: `Not read — ${route} did not answer, so this is not a count of zero`,
      state: 'unread',
    };
  }
  if (reads.some((read) => read.loading)) {
    return { value: TILE_DASH, caption: `Reading ${route}…`, state: 'reading' };
  }
  return { ...ready(), state: 'ready' };
}
