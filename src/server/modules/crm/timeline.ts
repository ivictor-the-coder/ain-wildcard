import type { Ctx } from '../../kernel/context';
import { parseJson } from '../../kernel/db';
import { badRequest } from '../../../shared/errors';
import { ValueFormatter } from './format';
import { encodeHistoryCursor, type Crm } from './store';
import type { CrmRecord, HistoryEntry, PropertyValue, TimelineItem } from './types';

/**
 * The timeline is the reason people trust a CRM: one column that merges what
 * was said (activities), what changed (property history), what the platform
 * did (events) and who is connected to whom (associations). A company's
 * timeline rolls up the activity logged against its contacts and deals, which
 * is how an account manager actually thinks about an account.
 *
 * Every one of those four legs is read as a *cursor walk*, never as a window
 * sized from the page limit. A window in rows cannot answer a question asked
 * in items: one stage change writes ten history rows and folds to one line, an
 * activity linked to a contact and its company arrives twice and folds to one,
 * and a `.updated` event is dropped outright. Sizing a read as `limit * 4` rows
 * therefore ran out mid-page and the pager then reported `has_more: false` on a
 * story that was very much not over. Each leg here keeps reading until it holds
 * `limit` items *of its own kind* or its source is exhausted, so the merged
 * top-`limit` is the true top-`limit` and `has_more` is a fact.
 */

export interface TimelineOptions {
  limit?: number;
  /** A time filter a person can type: only what happened strictly before it. */
  before?: number;
  /** The opaque cursor this module emits — a position, not an instant. */
  after?: string;
  rollUp?: boolean;
  kinds?: TimelineItem['kind'][];
}

export interface TimelinePage {
  items: TimelineItem[];
  has_more: boolean;
  next_cursor: string | null;
  /** How many child records this account's roll-up read activity through. */
  roll_up_anchors: number;
  /** True when the account has more children than one roll-up may anchor. */
  roll_up_truncated: boolean;
}

/** One past the page ceiling, because the pager reads a row it will not show. */
const MAX_TIMELINE_LIMIT = 200;

/**
 * History is read in row-sized gulps because that is what the audit trail is
 * indexed on; a save is roughly ten rows, so this is ~24 saves per round trip
 * and the loop above it almost never needs a second one.
 */
const HISTORY_PAGE_ROWS = 240;

/**
 * SQLite takes about 32k bound parameters and the activity read binds every
 * anchor four times, so an account's children are queried in batches. Each
 * batch returns its own top-`limit`, and the top-`limit` of the union of those
 * is the true global one — partitioning cannot hide an item that would rank.
 */
const ANCHOR_BATCH = 400;

/**
 * A roll-up still has to end somewhere, and an account with more children than
 * this is a data-quality problem rather than a page of history. When it
 * happens the response says so in `roll_up_truncated` instead of quietly
 * reporting that the timeline is finished.
 */
const ROLL_UP_ANCHOR_CEILING = 5_000;

/**
 * The activity walk's stop: each pass advances a whole window of edges, so
 * this is thirty thousand association rows for one page — far past any account
 * that is not a data-quality incident, and bounded either way.
 */
const MAX_ACTIVITY_READS = 64;

/**
 * A timeline position: the instant, the tiebreak within it, and the item's id.
 * A millisecond alone cannot address a row — six calls backfilled by one
 * import share an instant, and `before=<that instant>` skips five of them —
 * so the cursor carries the whole sort key and resumes on exactly one row.
 */
interface TimelineCursor { at: number; rank: number; id: string }

const encodeCursor = (at: number, rank: number, id: string): string =>
  Buffer.from(`t1.${at}.${rank}.${id}`).toString('base64url');

function decodeCursor(cursor: string | undefined): TimelineCursor | null {
  if (!cursor) return null;
  const [tag, at, rank, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('.');
  const id = rest.join('.');
  if (tag !== 't1' || !id || !Number.isInteger(Number(at)) || !Number.isInteger(Number(rank))) {
    throw badRequest(
      'cursor_invalid',
      'That is not a timeline cursor. Pass the previous page’s `next_cursor` back as `after`, or start again without it. `before` is a time filter and cannot page — items sharing a millisecond would fall through it.',
      'after',
    );
  }
  return { at: Number(at), rank: Number(rank), id };
}

/**
 * Titles for `<object type>.<verb>` events — the ones whose subject is the
 * record the timeline belongs to. They are keyed on the verb, so they may only
 * be consulted once the prefix is known to be an object type: `association.
 * created` is not a record being created, and titling it off its last
 * dot-segment is how a deal opened in March grew a "Record created" dated
 * today.
 */
const RECORD_EVENT_TITLES: Record<string, string> = {
  created: 'Record created',
  updated: 'Record updated',
  archived: 'Record archived',
  restored: 'Record restored',
  deleted: 'Record deleted',
  merged: 'Duplicate merged in',
};

type Draft = Omit<TimelineItem, 'cursor'>;

interface Collected {
  items: Draft[];
  /**
   * The within-instant tiebreak. A property change ranks on the first write
   * sequence of the save it belongs to (always ≥ 1); everything else ranks 0,
   * so a save always sorts above a plain item inside the same millisecond.
   */
  order: Map<string, number>;
  rollUpAnchors: number;
  rollUpTruncated: boolean;
}

interface ActivityRow {
  rid: string; aid: string; at: number; via_id: string;
  object_type: string; display_name: string; properties: string;
  created: number; created_by: string | null; owner_id: string | null;
}

interface AssociationRow {
  id: string; association_type: string; is_primary: number; created: number;
  direction: 'outgoing' | 'incoming'; record_id: string; object_type: string; display_name: string;
}

interface EventRow {
  id: string; type: string; created: number;
  actor_id: string | null; actor_type: TimelineItem['actor_type']; data: string;
}

/** `COALESCE(v.value_date, r.created)` — when an activity says it happened. */
const OCCURRED = 'COALESCE(v.value_date, r.created)';

export function buildTimeline(
  ctx: Ctx, crm: Crm, orgId: string, record: CrmRecord, options: TimelineOptions = {},
): TimelineItem[] {
  return finish(collect(ctx, crm, orgId, record, options), options);
}

/**
 * One page of the timeline and the cursor that resumes immediately after it.
 * The page is measured by reading one item it will not show: `has_more` is
 * then a fact, where `items.length === limit` lies every time a page lands
 * exactly on the end of the record's history.
 */
export function buildTimelinePage(
  ctx: Ctx, crm: Crm, orgId: string, record: CrmRecord, options: TimelineOptions = {},
): TimelinePage {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_TIMELINE_LIMIT);
  const collected = collect(ctx, crm, orgId, record, { ...options, limit: limit + 1 });
  const rows = finish(collected, { ...options, limit: limit + 1 });
  const has_more = rows.length > limit;
  const items = has_more ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    has_more,
    next_cursor: has_more && last ? last.cursor : null,
    roll_up_anchors: collected.rollUpAnchors,
    roll_up_truncated: collected.rollUpTruncated,
  };
}

/**
 * `(at, rank, id)` is a total order — no two items can tie — which is what
 * makes the cursor exact and `has_more` a fact rather than a guess.
 *
 * The id tiebreak is a byte comparison, not `localeCompare`: ids are mixed
 * case, SQLite orders them by code point, and a locale collation that reads
 * "b" before "C" disagrees with the window the query returned — enough to hand
 * back one item twice and never return another.
 */
function finish(collected: Collected, options: TimelineOptions): TimelineItem[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_TIMELINE_LIMIT + 1);
  const rankOf = (item: Draft): number => collected.order.get(item.id) ?? 0;
  const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return collected.items
    .sort((a, b) => b.at - a.at || rankOf(b) - rankOf(a) || byId(a.id, b.id))
    .slice(0, limit)
    .map((item) => ({ ...item, cursor: encodeCursor(item.at, rankOf(item), item.id) }));
}

function collect(ctx: Ctx, crm: Crm, orgId: string, record: CrmRecord, options: TimelineOptions): Collected {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_TIMELINE_LIMIT + 1);
  const cursor = decodeCursor(options.after);
  // Resuming from a cursor has to re-read the millisecond the last page ended
  // in — everything else in that tick is still to come — and drop only what
  // sits at or before the cursor's own position inside it.
  const before = Math.min(options.before ?? Number.MAX_SAFE_INTEGER, cursor ? cursor.at + 1 : Number.MAX_SAFE_INTEGER);
  const wanted = new Set<TimelineItem['kind']>(options.kinds?.length ? options.kinds : ['activity', 'property_change', 'event', 'association']);
  const activityTypes = crm.activityTypes(orgId);
  const items: Draft[] = [];
  const order = new Map<string, number>();

  // An account rolls up the activity logged against the records that point at
  // it; a deal or a contact shows only what is attached directly. The rule is
  // read off the association graph, so a custom "Site" object behaves the same.
  const isAccountLike = crm.associationTypes(orgId).some(
    (t) => t.to_object === record.object_type && t.from_object !== record.object_type && t.cardinality === 'many_to_one',
  );
  const rollUp = options.rollUp ?? isAccountLike;
  const anchors = [record.id];
  let rollUpTruncated = false;
  if (rollUp && !activityTypes.includes(record.object_type)) {
    const children = readAnchors(ctx, orgId, record.id, activityTypes);
    rollUpTruncated = children.truncated;
    for (const id of children.ids) if (id !== record.id) anchors.push(id);
  }

  if (wanted.has('activity') && activityTypes.length) {
    const best = new Map<string, ActivityRow>();
    for (let start = 0; start < anchors.length; start += ANCHOR_BATCH) {
      for (const [rid, row] of readActivities(
        ctx, orgId, record.id, anchors.slice(start, start + ANCHOR_BATCH), activityTypes, before, cursor, limit,
      )) {
        // An activity linked to both a contact and its company arrives twice;
        // keep the row that names the contact so the account timeline reads
        // "via Elena" rather than pointing back at the account itself.
        const existing = best.get(rid);
        if (!existing || (existing.via_id === record.id && row.via_id !== record.id)) best.set(rid, row);
      }
    }
    const viaRecords = new Map<string, CrmRecord>();
    const formatter = new ValueFormatter(ctx, orgId);
    for (const row of best.values()) {
      const props = parseJson<Record<string, PropertyValue>>(row.properties, {});
      let via: TimelineItem['via'] = null;
      if (row.via_id !== record.id) {
        let neighbour = viaRecords.get(row.via_id);
        if (!neighbour) {
          const found = crm.get(orgId, '', row.via_id);
          if (found) { neighbour = found; viaRecords.set(row.via_id, found); }
        }
        if (neighbour) via = { id: neighbour.id, object_type: neighbour.object_type, display_name: neighbour.display_name };
      }
      items.push({
        object: 'timeline_item',
        id: row.rid,
        kind: 'activity',
        at: Number(row.at),
        title: row.display_name,
        body: typeof props.body === 'string' ? props.body : null,
        icon: row.object_type,
        actor_id: row.owner_id ?? row.created_by ?? null,
        actor_type: 'user',
        record_id: row.rid,
        via,
        // A call's properties are stored to be computed with — `duration_minutes`
        // as a number, `outcome` as a machine value — so the card gets both:
        // the raw map, and the same fields as the person reads them.
        data: {
          object_type: row.object_type,
          properties: props,
          formatted: formatter.record(crm.propertyIndex(orgId, row.object_type), props),
        },
      });
    }
  }

  if (wanted.has('property_change')) {
    for (const item of readPropertyChanges(crm, orgId, record, before, cursor, limit, order)) items.push(item);
  }

  if (wanted.has('event')) {
    const objectTypeNames = new Set(crm.objectTypes(orgId).map((t) => t.name));
    const associationLabels = new Map(crm.associationTypes(orgId).map((t) => [t.name, t]));
    const eventRows = readEvents(ctx, orgId, record.id, before, cursor, limit);
    // The association lane renders every link that still exists, so a
    // `association.created` event for one of them is the same fact twice — one
    // POST used to print three lines. The event is kept for links that are
    // *gone*, which is the only place the timeline can still say they existed.
    const shadowed = wanted.has('association')
      ? liveAssociations(ctx, orgId, eventRows.map((row) => parseJson<Record<string, unknown>>(row.data, {})))
      : new Set<string>();
    for (const row of eventRows) {
      const data = parseJson<Record<string, unknown>>(row.data, {});
      if (row.type === 'association.created' && typeof data.id === 'string' && shadowed.has(data.id)) continue;
      const link = linkEvent(row.type, data, record.id, associationLabels);
      const summary = summarise(data);
      items.push({
        object: 'timeline_item',
        id: row.id,
        kind: 'event',
        at: Number(row.created),
        title: link?.title ?? titleForEvent(row.type, objectTypeNames),
        // The readable sentence used to reach `data.summary` and stop there,
        // so a card that said "Record archived" said nothing about what.
        body: link?.body ?? (summary || null),
        icon: link ? 'link' : 'zap',
        actor_id: row.actor_id,
        actor_type: row.actor_type,
        record_id: record.id,
        via: null,
        data: { type: row.type, ...(link ? link.data : {}), summary },
      });
    }
  }

  if (wanted.has('association')) {
    const labels = new Map(crm.associationTypes(orgId).map((t) => [t.name, t]));
    for (const row of readAssociations(ctx, orgId, record.id, activityTypes, before, cursor, limit)) {
      const type = labels.get(row.association_type);
      items.push({
        object: 'timeline_item',
        id: row.id,
        kind: 'association',
        at: Number(row.created),
        title: `Linked to ${row.display_name}`,
        body: null,
        icon: 'link',
        actor_id: null,
        actor_type: 'user',
        record_id: row.record_id,
        via: null,
        data: {
          association_type: row.association_type,
          relationship: (row.direction === 'outgoing' ? type?.label : type?.inverse_label) ?? row.association_type,
          object_type: row.object_type,
          is_primary: !!row.is_primary,
        },
      });
    }
  }

  return { items, order, rollUpAnchors: anchors.length - 1, rollUpTruncated };
}

/* ------------------------------ property changes ------------------------- */

/**
 * One save is one line. Moving a deal to Closed won changes six properties —
 * the stage a person chose, and the five Ain restamped from it — and a
 * timeline that lists all six as separate events is unreadable.
 *
 * The fold is on the write, never on the clock. Grouping by
 * `${record}|${changed_at}|${actor}` merged genuinely separate saves whenever
 * two landed in the same millisecond, which is most of the time on a fast
 * machine: a create and a stage change became one row titled after whichever
 * property happened to sort first.
 *
 * A save's rows are consecutive in the write sequence, so a group is addressed
 * by its first `seq` and the walk below only ever advances a whole group at a
 * time. The read that fills a page is the one that used to slice: `LIMIT n`
 * rows lands mid-save roughly every time, and the leftover tail then folded
 * into a second entry titled after whatever it contained — "Weighted amount
 * changed", a calculated property nobody typed, standing in for the stage move
 * that produced it. Here a page that comes back full has its trailing group
 * completed from `historyOfWrite` before anything is folded, so a partial save
 * is not merely unlikely, it never reaches the folder.
 */
function readPropertyChanges(
  crm: Crm, orgId: string, record: CrmRecord, before: number,
  cursor: TimelineCursor | null, limit: number, order: Map<string, number>,
): Draft[] {
  const creationWrite = crm.creationWriteId(orgId, record.id);
  const stageProperty = crm.pipelines.binding(orgId, record.object_type)?.stage_property ?? null;
  // A cursor sitting on a plain item excludes that whole tick's changes: a save
  // always outranks an item of rank 0 inside its own millisecond.
  const changesBefore = cursor && cursor.rank === 0 ? Math.min(before, cursor.at) : before;
  let after = cursor && cursor.rank > 0 ? encodeHistoryCursor(cursor.at, cursor.rank) : undefined;
  const items: Draft[] = [];

  // Each pass folds at least one whole save, so `limit + 2` passes can always
  // reach a full page however many rows a single save happens to have written.
  for (let read = 0; read < limit + 2 && items.length < limit; read++) {
    const rows = crm.history(orgId, record.id, {
      limit: HISTORY_PAGE_ROWS,
      before: changesBefore === Number.MAX_SAFE_INTEGER ? undefined : changesBefore,
      after,
    });
    if (!rows.length) break;

    const groups: HistoryEntry[][] = [];
    for (const entry of rows) {
      const open = groups[groups.length - 1];
      if (open && open[0].write_id === entry.write_id) open.push(entry);
      else groups.push([entry]);
    }
    // The row window can end inside a save. Complete that last group from the
    // write itself rather than folding the fragment it happened to catch. The
    // completion is bounded to the record and instant the fragment came from,
    // so it can only ever add rows this page was already entitled to.
    const exhausted = rows.length < HISTORY_PAGE_ROWS;
    if (!exhausted) {
      const tail = groups[groups.length - 1];
      const whole = crm.historyOfWrite(orgId, tail[0].write_id)
        .filter((e) => e.record_id === tail[0].record_id && e.changed_at === tail[0].changed_at);
      groups[groups.length - 1] = whole.length >= tail.length ? whole : tail;
    }

    for (const group of groups) {
      const item = foldWrite(crm, orgId, record, group, creationWrite, stageProperty, order);
      if (item) items.push(item);
    }
    if (exhausted) break;
    const last = groups[groups.length - 1];
    after = encodeHistoryCursor(last[0].changed_at, last.reduce((low, e) => Math.min(low, e.seq), last[0].seq));
  }
  return items;
}

function foldWrite(
  crm: Crm, orgId: string, record: CrmRecord, rows: HistoryEntry[],
  creationWrite: string | null, stageProperty: string | null, order: Map<string, number>,
): Draft | null {
  if (!rows.length) return null;
  // Read in the order the save wrote them, whichever direction the window that
  // caught them ran in, so one save renders the same line at every page size.
  const group = rows.slice().sort((a, b) => a.seq - b.seq);
  // The values a record was born with are already the "Record created" event;
  // repeating them as fourteen changes is noise, not history.
  const bornWith = group.every((e) => e.from_value === null || e.from_value === '');
  if (bornWith && group[0].write_id === creationWrite && group[0].record_id === record.id) return null;

  // The person changed the stage; Ain changed the five fields that follow from
  // it. Lead with what a person did, on the property the record is organised
  // around, preferring a real before→after over a blank filled in.
  const positionOf = (entry: HistoryEntry): number =>
    crm.propertyOrNull(orgId, entry.object_type, entry.property)?.position ?? 900;
  const rank = (entry: HistoryEntry): number =>
    (entry.property === stageProperty ? 0 : 1_000_000)
    + (entry.from_value === null || entry.from_value === '' ? 100_000 : 0)
    + positionOf(entry);
  const chosen = group.filter((e) => e.source !== 'system');
  const lead = (chosen.length ? chosen : group).slice().sort((a, b) => rank(a) - rank(b) || a.seq - b.seq)[0];
  const rest = group.filter((e) => e !== lead);
  // Every value is printed through its property's type. The audit trail stores
  // money in minor units, dates as ISO text, an enum as its machine value and
  // an owner as a user id; a timeline that shows those raw tells an account
  // manager their $80,000 deal moved from 8000000 to 8000001.
  const render = (entry: HistoryEntry): string =>
    `${entry.from_display ?? 'empty'} → ${entry.to_display ?? 'empty'}`;
  const shown = rest.slice(0, 4);
  const body = [render(lead), ...shown.map((e) => `${e.property_label} ${render(e)}`)].join(' · ')
    + (rest.length > shown.length ? ` · and ${rest.length - shown.length} more` : '');
  order.set(lead.id, group.reduce((low, e) => Math.min(low, e.seq), lead.seq));
  return {
    object: 'timeline_item',
    id: lead.id,
    kind: 'property_change',
    at: lead.changed_at,
    title: titleOf(lead),
    body,
    icon: 'history',
    actor_id: lead.actor_id,
    actor_type: lead.actor_type,
    record_id: lead.record_id,
    via: lead.record_id === record.id ? null : { id: lead.record_id, object_type: lead.object_type, display_name: 'merged duplicate' },
    data: {
      property: lead.property, from: lead.from_value, to: lead.to_value,
      from_display: lead.from_display, to_display: lead.to_display,
      source: lead.source, write_id: lead.write_id, seq: lead.seq,
      ...(rest.length ? {
        also: rest.map((e) => ({
          property: e.property, label: e.property_label,
          from: e.from_value, to: e.to_value,
          from_display: e.from_display, to_display: e.to_display,
          source: e.source,
        })),
      } : {}),
    },
  };
}

/* --------------------------------- anchors ------------------------------- */

/**
 * Every child record whose activity rolls up into this account. Ids only, so
 * an account with two thousand contacts costs one indexed scan rather than two
 * thousand hydrations — and no `LIMIT 250` deciding on the client's behalf
 * that the account stopped having history after its 250th contact.
 */
function readAnchors(
  ctx: Ctx, orgId: string, recordId: string, activityTypes: string[],
): { ids: string[]; truncated: boolean } {
  const exclude = activityTypes.length ? `AND r.object_type NOT IN (${activityTypes.map(() => '?').join(',')})` : '';
  const rows = ctx.db.all<{ id: string }>(
    `SELECT r.id AS id FROM crm_associations a JOIN crm_records r ON r.id = a.to_id
      WHERE a.org_id = ? AND a.from_id = ? AND r.archived = 0 ${exclude}
     UNION
     SELECT r.id AS id FROM crm_associations a JOIN crm_records r ON r.id = a.from_id
      WHERE a.org_id = ? AND a.to_id = ? AND r.archived = 0 ${exclude}
     LIMIT ?`,
    orgId, recordId, ...(activityTypes as never[]),
    orgId, recordId, ...(activityTypes as never[]),
    ROLL_UP_ANCHOR_CEILING + 1,
  );
  return {
    ids: rows.slice(0, ROLL_UP_ANCHOR_CEILING).map((r) => r.id),
    truncated: rows.length > ROLL_UP_ANCHOR_CEILING,
  };
}

/* -------------------------------- activities ----------------------------- */

/**
 * The activity leg for one batch of anchors, walked on `(occurred_at, record
 * id, association id)` until it holds `limit` distinct activities or the batch
 * runs out. An import that backfills a day of calls stamps them all with the
 * same instant, so the window has to be cut on the position it reached and not
 * on the tick it fell in — otherwise page two re-reads the same few rows the
 * clock hands back first and the rest of the cluster is never returned.
 */
function readActivities(
  ctx: Ctx, orgId: string, subjectId: string, ids: string[], activityTypes: string[],
  before: number, cursor: TimelineCursor | null, limit: number,
): Map<string, ActivityRow> {
  const idIn = ids.map(() => '?').join(',');
  const typeIn = activityTypes.map(() => '?').join(',');
  // `rank === 0` for every non-property item, so an id comparison is the whole
  // tiebreak within the instant the caller's cursor sits in.
  const withinTick = cursor && cursor.rank === 0 ? `AND (${OCCURRED} < ? OR r.id > ?)` : '';
  const pageRows = Math.min(500, Math.max(limit * 3, 48));
  const best = new Map<string, ActivityRow>();
  let leg: { at: number; rid: string; aid: string } | null = null;

  for (let read = 0; read < MAX_ACTIVITY_READS; read++) {
    const walked = leg
      ? `AND (${OCCURRED} < ? OR (${OCCURRED} = ? AND r.id > ?) OR (${OCCURRED} = ? AND r.id = ? AND a.id > ?))`
      : '';
    const rows: ActivityRow[] = ctx.db.all<ActivityRow>(
      `SELECT r.id AS rid, a.id AS aid, r.object_type AS object_type, r.display_name AS display_name,
              r.properties AS properties, r.created AS created, r.created_by AS created_by, r.owner_id AS owner_id,
              ${OCCURRED} AS at,
              (CASE WHEN a.from_id IN (${idIn}) THEN a.from_id ELSE a.to_id END) AS via_id
         FROM crm_associations a
         JOIN crm_records r ON r.id = (CASE WHEN a.from_id IN (${idIn}) THEN a.to_id ELSE a.from_id END)
         LEFT JOIN crm_record_values v ON v.record_id = r.id AND v.property = 'occurred_at'
        WHERE a.org_id = ? AND (a.from_id IN (${idIn}) OR a.to_id IN (${idIn}))
          AND r.object_type IN (${typeIn}) AND r.archived = 0
          AND ${OCCURRED} < ?
          ${withinTick} ${walked}
        ORDER BY at DESC, rid ASC, aid ASC LIMIT ?`,
      ...(ids as never[]), ...(ids as never[]), orgId, ...(ids as never[]), ...(ids as never[]),
      ...(activityTypes as never[]), before,
      ...(withinTick ? [cursor!.at, cursor!.id] as never[] : []),
      ...(leg ? [leg.at, leg.at, leg.rid, leg.at, leg.rid, leg.aid] as never[] : []),
      pageRows,
    );
    if (!rows.length) return best;
    for (const row of rows) {
      const existing = best.get(row.rid);
      if (!existing || (existing.via_id === subjectId && row.via_id !== subjectId)) best.set(row.rid, row);
    }
    const last: ActivityRow = rows[rows.length - 1];
    // A full window may have cut between two edges pointing at the same
    // activity, so the trailing record does not count as held yet.
    const openRid = rows.length < pageRows ? null : last.rid;
    const held = best.size - (openRid !== null && best.has(openRid) ? 1 : 0);
    if (openRid === null) return best;
    if (held >= limit) { best.delete(openRid); return best; }
    leg = { at: Number(last.at), rid: last.rid, aid: last.aid };
  }
  return best;
}

/* ---------------------------------- events -------------------------------- */

/**
 * `*.updated` is dropped because property history already says what changed,
 * so the filter belongs in the query: asking for `limit * 2` rows and throwing
 * half away is how a page comes back short.
 */
function readEvents(
  ctx: Ctx, orgId: string, recordId: string, before: number, cursor: TimelineCursor | null, limit: number,
): EventRow[] {
  const withinTick = cursor && cursor.rank === 0 ? 'AND (created < ? OR id > ?)' : '';
  return ctx.db.all<EventRow>(
    `SELECT id, type, created, actor_id, actor_type, data FROM events
      WHERE org_id = ? AND object_id = ? AND type NOT GLOB '*.updated' AND created < ? ${withinTick}
      ORDER BY created DESC, id ASC LIMIT ?`,
    orgId, recordId, before,
    ...(withinTick ? [cursor!.at, cursor!.id] as never[] : []),
    limit,
  );
}

/** Which of these events' association ids still exist as edges. */
function liveAssociations(ctx: Ctx, orgId: string, payloads: Record<string, unknown>[]): Set<string> {
  const ids = [...new Set(payloads.map((d) => d.id).filter((id): id is string => typeof id === 'string'))];
  if (!ids.length) return new Set();
  const rows = ctx.db.all<{ id: string }>(
    `SELECT id FROM crm_associations WHERE org_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    orgId, ...(ids as never[]),
  );
  return new Set(rows.map((r) => r.id));
}

/* ------------------------------- associations ----------------------------- */

/**
 * The links themselves, newest first, read straight off the association table
 * in the timeline's own order. The old read took the first hundred rows of the
 * record page's order (primary first, then newest) and called it a page, which
 * is how a company with 130 contacts showed 100 "Linked to …" lines and then
 * claimed there was nothing more.
 */
function readAssociations(
  ctx: Ctx, orgId: string, recordId: string, activityTypes: string[],
  before: number, cursor: TimelineCursor | null, limit: number,
): AssociationRow[] {
  const exclude = activityTypes.length ? `AND r.object_type NOT IN (${activityTypes.map(() => '?').join(',')})` : '';
  const withinTick = cursor && cursor.rank === 0 ? 'AND (a.created < ? OR a.id > ?)' : '';
  const tick = withinTick ? [cursor!.at, cursor!.id] : [];
  const branch = (join: string, match: string, direction: string): string =>
    `SELECT a.id AS id, a.association_type AS association_type, a.is_primary AS is_primary,
            a.created AS created, '${direction}' AS direction, r.id AS record_id,
            r.object_type AS object_type, r.display_name AS display_name
       FROM crm_associations a JOIN crm_records r ON r.id = a.${join}
      WHERE a.org_id = ? AND a.${match} = ? AND r.archived = 0 ${exclude}
        AND a.created < ? ${withinTick}`;
  return ctx.db.all<AssociationRow>(
    `${branch('to_id', 'from_id', 'outgoing')}
     UNION ALL
     ${branch('from_id', 'to_id', 'incoming')}
     ORDER BY created DESC, id ASC LIMIT ?`,
    orgId, recordId, ...(activityTypes as never[]), before, ...(tick as never[]),
    orgId, recordId, ...(activityTypes as never[]), before, ...(tick as never[]),
    limit,
  );
}

/**
 * A few history rows are record-level facts rather than property edits, and
 * "Duplicate merged in changed" is not a sentence anybody wrote on purpose.
 */
function titleOf(lead: HistoryEntry): string {
  if (lead.property === 'merged_from') return 'Duplicate merged in';
  if (lead.property === 'archived') return lead.to_value === 'true' ? 'Record archived' : 'Record restored';
  return `${lead.property_label} changed`;
}

/**
 * `deal.archived` is a verb about this record; `association.deleted` and
 * anything a module emits under its own namespace are not. Only a type whose
 * prefix is a real object type may take a record title.
 */
function titleForEvent(type: string, objectTypes: Set<string>): string {
  const dot = type.indexOf('.');
  const prefix = dot < 0 ? '' : type.slice(0, dot);
  const verb = dot < 0 ? type : type.slice(dot + 1);
  if (objectTypes.has(prefix) && RECORD_EVENT_TITLES[verb]) return RECORD_EVENT_TITLES[verb];
  return humanise(type);
}

/**
 * An association event, rendered through the record on the other end of the
 * link rather than through its own dot-segments. "Deleted" with an empty body
 * is the removal of an account nobody can name afterwards, because the edge it
 * described no longer exists to be looked up.
 */
function linkEvent(
  type: string, data: Record<string, unknown>, subjectId: string,
  labels: Map<string, { label: string; inverse_label: string }>,
): { title: string; body: string | null; data: Record<string, unknown> } | null {
  if (type !== 'association.created' && type !== 'association.deleted') return null;
  const endpoint = (side: unknown): { id: string; object_type: string; display_name: string } | null => {
    if (!side || typeof side !== 'object') return null;
    const row = side as Record<string, unknown>;
    return typeof row.id === 'string'
      ? { id: row.id, object_type: String(row.object_type ?? ''), display_name: String(row.display_name ?? row.id) }
      : null;
  };
  const from = endpoint(data.from);
  const to = endpoint(data.to);
  const outgoing = !from || from.id === subjectId;
  const other = outgoing ? to : from;
  if (!other) return null;
  const associationType = typeof data.association_type === 'string' ? data.association_type : '';
  const type_ = labels.get(associationType);
  const relationship = (outgoing ? type_?.label : type_?.inverse_label) ?? associationType;
  return {
    title: type === 'association.created' ? `Linked to ${other.display_name}` : `Unlinked ${other.display_name}`,
    body: relationship || null,
    data: {
      association_type: associationType,
      relationship,
      record_id: other.id,
      object_type: other.object_type,
      display_name: other.display_name,
    },
  };
}

const humanise = (type: string): string => {
  const tail = type.split('.').slice(1).join(' ') || type;
  return tail.charAt(0).toUpperCase() + tail.slice(1).replace(/_/g, ' ');
};

function summarise(data: unknown): string {
  if (!data || typeof data !== 'object') return String(data ?? '');
  const record = data as Record<string, unknown>;
  const label = record.display_name ?? record.name ?? record.subject ?? record.label;
  return label ? String(label) : '';
}
