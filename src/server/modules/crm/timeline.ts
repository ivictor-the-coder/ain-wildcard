import type { Ctx } from '../../kernel/context';
import { parseJson } from '../../kernel/db';
import { badRequest } from '../../../shared/errors';
import { formatDate, formatDateTime } from '../../../shared/time';
import { encodeHistoryCursor, type Crm } from './store';
import type { CrmRecord, HistoryEntry, PropertyDef, PropertyValue, TimelineItem } from './types';

/**
 * The timeline is the reason people trust a CRM: one column that merges what
 * was said (activities), what changed (property history), what the platform
 * did (events) and who is connected to whom (associations). A company's
 * timeline rolls up the activity logged against its contacts and deals, which
 * is how an account manager actually thinks about an account.
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
}

/** One past the page ceiling, because the pager reads a row it will not show. */
const MAX_TIMELINE_LIMIT = 200;

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

const EVENT_TITLES: Record<string, string> = {
  created: 'Record created',
  updated: 'Record updated',
  archived: 'Record archived',
  restored: 'Record restored',
  merged: 'Duplicate merged in',
};

export function buildTimeline(ctx: Ctx, crm: Crm, orgId: string, record: CrmRecord, options: TimelineOptions = {}): TimelineItem[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_TIMELINE_LIMIT + 1);
  const cursor = decodeCursor(options.after);
  // Resuming from a cursor has to re-read the millisecond the last page ended
  // in — everything else in that tick is still to come — and drop only what
  // sits at or before the cursor's own position inside it.
  const before = Math.min(options.before ?? Number.MAX_SAFE_INTEGER, cursor ? cursor.at + 1 : Number.MAX_SAFE_INTEGER);
  const wanted = new Set<TimelineItem['kind']>(options.kinds?.length ? options.kinds : ['activity', 'property_change', 'event', 'association']);
  const activityTypes = crm.activityTypes(orgId);
  const items: Omit<TimelineItem, 'cursor'>[] = [];
  // Two saves can share a millisecond, so the timeline needs a tiebreak that
  // is not the clock. Property changes carry the write sequence; everything
  // else falls back to its id, which is stable across requests either way.
  const order = new Map<string, number>();

  // An account rolls up the activity logged against the records that point at
  // it; a deal or a contact shows only what is attached directly. The rule is
  // read off the association graph, so a custom "Site" object behaves the same.
  const isAccountLike = crm.associationTypes(orgId).some(
    (t) => t.to_object === record.object_type && t.from_object !== record.object_type && t.cardinality === 'many_to_one',
  );
  const rollUp = options.rollUp ?? isAccountLike;
  const anchors = [record.id];
  if (rollUp && !activityTypes.includes(record.object_type)) {
    for (const edge of crm.associationsOf(orgId, record.id, { limit: 250 })) {
      if (!activityTypes.includes(edge.object_type)) anchors.push(edge.record_id);
    }
  }

  if (wanted.has('activity') && activityTypes.length) {
    const ids = anchors.slice(0, 250);
    const idPlaceholders = ids.map(() => '?').join(',');
    const typePlaceholders = activityTypes.map(() => '?').join(',');
    // An import that backfills a day of calls stamps them all with the same
    // instant, so the window this page reads has to be cut on the cursor
    // itself, not on the tick it fell in — otherwise page two re-reads the
    // same few rows the clock happens to hand back first and the rest of the
    // cluster is never returned at all. `rank === 0` for every non-property
    // item, so an id comparison is the whole tiebreak within the instant.
    const withinTick = cursor && cursor.rank === 0
      ? 'AND (COALESCE(v.value_date, r.created) < ? OR r.id > ?)' : '';
    const rows = ctx.db.all<any>(
      `SELECT r.id AS rid, r.object_type, r.display_name, r.properties, r.created, r.created_by, r.owner_id,
              COALESCE(v.value_date, r.created) AS at,
              (CASE WHEN a.from_id IN (${idPlaceholders}) THEN a.from_id ELSE a.to_id END) AS via_id
         FROM crm_associations a
         JOIN crm_records r ON r.id = (CASE WHEN a.from_id IN (${idPlaceholders}) THEN a.to_id ELSE a.from_id END)
         LEFT JOIN crm_record_values v ON v.record_id = r.id AND v.property = 'occurred_at'
        WHERE a.org_id = ? AND (a.from_id IN (${idPlaceholders}) OR a.to_id IN (${idPlaceholders}))
          AND r.object_type IN (${typePlaceholders}) AND r.archived = 0
          AND COALESCE(v.value_date, r.created) < ?
          ${withinTick}
        ORDER BY at DESC, rid ASC LIMIT ?`,
      ...(ids as never[]), ...(ids as never[]), orgId, ...(ids as never[]), ...(ids as never[]),
      ...(activityTypes as never[]), before,
      ...(withinTick ? [cursor!.at, cursor!.id] as never[] : []),
      limit * 3,
    );
    // An activity linked to both a contact and its company arrives twice; keep
    // the row that names the contact so the account timeline reads "via Elena".
    const best = new Map<string, any>();
    for (const row of rows) {
      const existing = best.get(row.rid);
      if (!existing || (existing.via_id === record.id && row.via_id !== record.id)) best.set(row.rid, row);
    }
    const viaRecords = new Map<string, CrmRecord>();
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
        data: { object_type: row.object_type, properties: props },
      });
    }
  }

  if (wanted.has('property_change')) {
    // One save is one line. Moving a deal to Closed won changes six properties
    // — the stage a person chose, and the five Ain restamped from it — and a
    // timeline that lists all six as separate events is unreadable.
    //
    // The fold is on the write, never on the clock. Grouping by
    // `${record}|${changed_at}|${actor}` merged genuinely separate saves
    // whenever two landed in the same millisecond, which is most of the time
    // on a fast machine: a create and a stage change became one row titled
    // after whichever property happened to sort first.
    //
    // One save's rows are consecutive in the write sequence, so the group is
    // addressed by its first `seq`: a cursor cut there lands between two saves
    // and can never slice one in half and re-fold the remainder into a phantom
    // second entry. A cursor on any other kind of item excludes the whole
    // tick's changes, because a change never sorts after a plain item inside
    // its own millisecond.
    const grouped = new Map<string, HistoryEntry[]>();
    const changesBefore = cursor && cursor.rank === 0 ? Math.min(before, cursor.at) : before;
    for (const entry of crm.history(orgId, record.id, {
      limit: limit * 4,
      before: changesBefore === Number.MAX_SAFE_INTEGER ? undefined : changesBefore,
      after: cursor && cursor.rank > 0 ? encodeHistoryCursor(cursor.at, cursor.rank) : undefined,
    })) {
      const bucket = grouped.get(entry.write_id);
      if (bucket) bucket.push(entry); else grouped.set(entry.write_id, [entry]);
    }
    const creationWrite = crm.creationWriteId(orgId, record.id);
    const stageProperty = crm.pipelines.binding(orgId, record.object_type)?.stage_property ?? null;
    for (const group of grouped.values()) {
      // The values a record was born with are already the "Record created"
      // event; repeating them as fourteen changes is noise, not history.
      const bornWith = group.every((e) => e.from_value === null || e.from_value === '');
      if (bornWith && group[0].write_id === creationWrite && group[0].record_id === record.id) continue;

      // The person changed the stage; Ain changed the five fields that follow
      // from it. Lead with what a person did, on the property the record is
      // organised around, preferring a real before→after over a blank filled in.
      const positionOf = (entry: HistoryEntry): number =>
        crm.propertyOrNull(orgId, entry.object_type, entry.property)?.position ?? 900;
      const rank = (entry: HistoryEntry): number =>
        (entry.property === stageProperty ? 0 : 1_000_000)
        + (entry.from_value === null || entry.from_value === '' ? 100_000 : 0)
        + positionOf(entry);
      const chosen = group.filter((e) => e.source !== 'system');
      const lead = (chosen.length ? chosen : group).slice().sort((a, b) => rank(a) - rank(b) || a.seq - b.seq)[0];
      const rest = group.filter((e) => e !== lead);
      const render = (entry: HistoryEntry): string => {
        const prop = crm.propertyOrNull(orgId, entry.object_type, entry.property);
        return `${display(prop, entry.from_value) ?? 'empty'} → ${display(prop, entry.to_value) ?? 'empty'}`;
      };
      const shown = rest.slice(0, 4);
      const body = [render(lead), ...shown.map((e) => `${e.property_label} ${render(e)}`)].join(' · ')
        + (rest.length > shown.length ? ` · and ${rest.length - shown.length} more` : '');
      order.set(lead.id, group.reduce((low, e) => Math.min(low, e.seq), lead.seq));
      items.push({
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
          property: lead.property, from: lead.from_value, to: lead.to_value, source: lead.source,
          write_id: lead.write_id, seq: lead.seq,
          ...(rest.length ? {
            also: rest.map((e) => ({ property: e.property, label: e.property_label, from: e.from_value, to: e.to_value, source: e.source })),
          } : {}),
        },
      });
    }
  }

  if (wanted.has('event')) {
    for (const event of ctx.events.list(orgId, { objectId: record.id, limit: limit * 2, before: before === Number.MAX_SAFE_INTEGER ? undefined : before })) {
      if (event.type.endsWith('.updated')) continue; // property history already says what changed
      const suffix = event.type.split('.').pop() ?? event.type;
      items.push({
        object: 'timeline_item',
        id: event.id,
        kind: 'event',
        at: event.created,
        title: EVENT_TITLES[suffix] ?? humanise(event.type),
        body: null,
        icon: 'zap',
        actor_id: event.actor_id,
        actor_type: event.actor_type,
        record_id: record.id,
        via: null,
        data: { type: event.type, ...(event.data && typeof event.data === 'object' ? { summary: summarise(event.data) } : {}) },
      });
    }
  }

  if (wanted.has('association')) {
    for (const edge of crm.associationsOf(orgId, record.id, { limit: 100 })) {
      if (activityTypes.includes(edge.object_type)) continue;
      if (edge.created >= before) continue;
      items.push({
        object: 'timeline_item',
        id: edge.id,
        kind: 'association',
        at: edge.created,
        title: `Linked to ${edge.display_name}`,
        body: null,
        icon: 'link',
        actor_id: null,
        actor_type: 'user',
        record_id: edge.record_id,
        via: null,
        data: { association_type: edge.association_type, relationship: edge.label, object_type: edge.object_type, is_primary: edge.is_primary },
      });
    }
  }

  // `(at, rank, id)` is a total order — no two items can tie — which is what
  // makes the cursor exact and `has_more` a fact rather than a guess.
  //
  // The id tiebreak is a byte comparison, not `localeCompare`: ids are mixed
  // case, SQLite orders them by code point, and a locale collation that reads
  // "b" before "C" disagrees with the window the query returned — enough to
  // hand back one item twice and never return another.
  const rankOf = (item: Omit<TimelineItem, 'cursor'>): number => order.get(item.id) ?? 0;
  const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const beyondCursor = (item: Omit<TimelineItem, 'cursor'>): boolean => {
    if (!cursor) return true;
    if (item.at !== cursor.at) return item.at < cursor.at;
    const rank = rankOf(item);
    if (rank !== cursor.rank) return rank < cursor.rank;
    return item.id > cursor.id;
  };
  return items
    .filter(beyondCursor)
    .sort((a, b) => b.at - a.at || rankOf(b) - rankOf(a) || byId(a.id, b.id))
    .slice(0, limit)
    .map((item) => ({ ...item, cursor: encodeCursor(item.at, rankOf(item), item.id) }));
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
  const rows = buildTimeline(ctx, crm, orgId, record, { ...options, limit: limit + 1 });
  const has_more = rows.length > limit;
  const items = has_more ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, has_more, next_cursor: has_more && last ? last.cursor : null };
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

function display(prop: PropertyDef | null, value: PropertyValue): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  // History stores dates as ISO text; a timeline reads better in words.
  if (prop && (prop.type === 'date' || prop.type === 'datetime')) {
    const ts = Date.parse(text);
    if (Number.isFinite(ts)) return prop.type === 'date' ? formatDate(ts) : formatDateTime(ts);
  }
  if (!prop?.options?.length) return text;
  return text.split(', ').map((part) => prop.options.find((o) => o.value === part)?.label ?? part).join(', ');
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
