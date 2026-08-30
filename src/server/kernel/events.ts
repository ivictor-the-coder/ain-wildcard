import type { Db } from './db';
import { parseJson } from './db';
import { newId } from '../../shared/ids';

/**
 * Every meaningful state change in the platform emits a typed event. Events are
 * the substrate for webhooks, workflow automation triggers, the activity
 * timeline, agent observability and the audit log — one log, many readers.
 */
export interface AinEvent<T = unknown> {
  id: string;
  type: string;
  org_id: string;
  object_id: string | null;
  object_type: string | null;
  actor_id: string | null;
  actor_type: 'user' | 'api_key' | 'system' | 'agent' | 'workflow';
  request_id: string | null;
  created: number;
  data: T;
  /** Previous values for changed fields, Stripe's `previous_attributes`. */
  previous: Record<string, unknown> | null;
}

export interface EmitOptions {
  objectId?: string | null;
  objectType?: string | null;
  previous?: Record<string, unknown> | null;
  actorId?: string | null;
  actorType?: AinEvent['actor_type'];
  requestId?: string | null;
}

export type EventHandler = (event: AinEvent<any>) => void;

interface Subscription { pattern: string; regex: RegExp; handler: EventHandler; name: string }

export class EventBus {
  private subs: Subscription[] = [];
  private buffered: AinEvent[] | null = null;

  constructor(private readonly db: Db, private readonly onError: (e: Error, evt: AinEvent, sub: string) => void) {}

  /** `on('invoice.*')`, `on('*')` and exact types are all supported. */
  on(pattern: string, handler: EventHandler, name = 'anonymous'): void {
    const regex = new RegExp('^' + pattern.split('*').map(escapeRe).join('[^ ]*') + '$');
    this.subs.push({ pattern, regex, handler, name });
  }

  listSubscriptions(): { pattern: string; name: string }[] {
    return this.subs.map((s) => ({ pattern: s.pattern, name: s.name }));
  }

  emit<T>(orgId: string, type: string, data: T, now: number, opts: EmitOptions = {}): AinEvent<T> {
    const event: AinEvent<T> = {
      id: newId('event'),
      type,
      org_id: orgId,
      object_id: opts.objectId ?? null,
      object_type: opts.objectType ?? null,
      actor_id: opts.actorId ?? null,
      actor_type: opts.actorType ?? 'system',
      request_id: opts.requestId ?? null,
      created: now,
      data,
      previous: opts.previous ?? null,
    };
    this.db.insert('events', {
      id: event.id, type, org_id: orgId, object_id: event.object_id, object_type: event.object_type,
      actor_id: event.actor_id, actor_type: event.actor_type, request_id: event.request_id,
      created: now, data: data as any, previous: event.previous,
    });
    if (this.buffered) { this.buffered.push(event as AinEvent); return event; }
    this.dispatch(event as AinEvent);
    return event;
  }

  /** Collect events emitted inside `fn` and dispatch them only if it succeeds. */
  transactional<T>(fn: () => T): T {
    const outer = this.buffered;
    const mine: AinEvent[] = [];
    this.buffered = mine;
    try {
      const out = fn();
      this.buffered = outer;
      if (outer) outer.push(...mine);
      else for (const e of mine) this.dispatch(e);
      return out;
    } catch (e) {
      this.buffered = outer;
      throw e;
    }
  }

  private dispatch(event: AinEvent): void {
    for (const sub of this.subs) {
      if (!sub.regex.test(event.type)) continue;
      try { sub.handler(event); }
      catch (e) { this.onError(e as Error, event, sub.name); }
    }
  }

  list(orgId: string, opts: { types?: string[]; objectId?: string; limit?: number; after?: number; before?: number } = {}): AinEvent[] {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (opts.types?.length) {
      const parts = opts.types.map((t) => (t.includes('*') ? 'type LIKE ?' : 'type = ?'));
      clauses.push(`(${parts.join(' OR ')})`);
      params.push(...opts.types.map((t) => t.replace(/\*/g, '%')));
    }
    if (opts.objectId) { clauses.push('object_id = ?'); params.push(opts.objectId); }
    if (opts.after) { clauses.push('created > ?'); params.push(opts.after); }
    if (opts.before) { clauses.push('created < ?'); params.push(opts.before); }
    const rows = this.db.all<any>(
      `SELECT * FROM events WHERE ${clauses.join(' AND ')} ORDER BY created DESC, rowid DESC LIMIT ?`,
      ...(params as any[]), Math.min(opts.limit ?? 50, 500),
    );
    return rows.map(hydrateEvent);
  }

  find(orgId: string, id: string): AinEvent | undefined {
    const row = this.db.get<any>('SELECT * FROM events WHERE org_id = ? AND id = ?', orgId, id);
    return row ? hydrateEvent(row) : undefined;
  }
}

export function hydrateEvent(row: any): AinEvent {
  return { ...row, data: parseJson(row.data, {}), previous: row.previous ? parseJson(row.previous, {}) : null };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
