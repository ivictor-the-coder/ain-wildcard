import type { Ctx } from '../../kernel/context';
import { parseJson } from '../../kernel/db';
import { formatDate, formatDateTime } from '../../../shared/time';
import type { Crm } from './store';
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
  before?: number;
  rollUp?: boolean;
  kinds?: TimelineItem['kind'][];
}

const EVENT_TITLES: Record<string, string> = {
  created: 'Record created',
  updated: 'Record updated',
  archived: 'Record archived',
  restored: 'Record restored',
  merged: 'Duplicate merged in',
};

export function buildTimeline(ctx: Ctx, crm: Crm, orgId: string, record: CrmRecord, options: TimelineOptions = {}): TimelineItem[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const before = options.before ?? Number.MAX_SAFE_INTEGER;
  const wanted = new Set<TimelineItem['kind']>(options.kinds?.length ? options.kinds : ['activity', 'property_change', 'event', 'association']);
  const activityTypes = crm.activityTypes(orgId);
  const items: TimelineItem[] = [];
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
        ORDER BY at DESC LIMIT ?`,
      ...(ids as never[]), ...(ids as never[]), orgId, ...(ids as never[]), ...(ids as never[]),
      ...(activityTypes as never[]), before, limit * 3,
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
    const grouped = new Map<string, HistoryEntry[]>();
    for (const entry of crm.history(orgId, record.id, { limit: limit * 4, before: before === Number.MAX_SAFE_INTEGER ? undefined : before })) {
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
      order.set(lead.id, lead.seq);
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

  return items
    .sort((a, b) => b.at - a.at || (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0) || a.id.localeCompare(b.id))
    .slice(0, limit);
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
