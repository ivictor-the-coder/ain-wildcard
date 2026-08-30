import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Bindable = SqlValue | boolean | undefined | Record<string, unknown> | unknown[];

export interface Migration {
  /** Globally unique, ordered id, e.g. `billing.0003_credit_grants`. */
  id: string;
  sql: string;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** Normalise JS values into something SQLite accepts. */
export function bind(value: Bindable): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object' && !(value instanceof Uint8Array)) return JSON.stringify(value);
  return value as SqlValue;
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw === 'object') return raw as T;
  try { return JSON.parse(String(raw)) as T; } catch { return fallback; }
}

export class Db {
  readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private depth = 0;
  private savepointSeq = 0;

  constructor(location: string) {
    if (location !== ':memory:') mkdirSync(dirname(location), { recursive: true });
    this.raw = new DatabaseSync(location);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec(`CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`);
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) { s = this.raw.prepare(sql); this.cache.set(sql, s); }
    return s;
  }

  exec(sql: string): void { this.raw.exec(sql); }

  all<T = Record<string, unknown>>(sql: string, ...params: Bindable[]): T[] {
    return this.stmt(sql).all(...params.map(bind)) as unknown as T[];
  }

  get<T = Record<string, unknown>>(sql: string, ...params: Bindable[]): T | undefined {
    return this.stmt(sql).get(...params.map(bind)) as unknown as T | undefined;
  }

  run(sql: string, ...params: Bindable[]): RunResult {
    const r = this.stmt(sql).run(...params.map(bind));
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  pluck<T = unknown>(sql: string, ...params: Bindable[]): T | undefined {
    const row = this.get<Record<string, unknown>>(sql, ...params);
    if (!row) return undefined;
    const keys = Object.keys(row);
    return keys.length ? (row[keys[0]] as T) : undefined;
  }

  count(sql: string, ...params: Bindable[]): number {
    return Number(this.pluck<number>(sql, ...params) ?? 0);
  }

  /** Transactions nest safely using savepoints. */
  tx<T>(fn: () => T): T {
    if (this.depth === 0) {
      this.raw.exec('BEGIN IMMEDIATE');
      this.depth++;
      try { const out = fn(); this.raw.exec('COMMIT'); this.depth--; return out; }
      catch (e) { try { this.raw.exec('ROLLBACK'); } catch { /* already rolled back */ } this.depth--; throw e; }
    }
    const name = `sp_${this.savepointSeq++}`;
    this.raw.exec(`SAVEPOINT ${name}`);
    this.depth++;
    try { const out = fn(); this.raw.exec(`RELEASE ${name}`); this.depth--; return out; }
    catch (e) { try { this.raw.exec(`ROLLBACK TO ${name}`); this.raw.exec(`RELEASE ${name}`); } catch { /* noop */ } this.depth--; throw e; }
  }

  get inTransaction(): boolean { return this.depth > 0; }

  insert(table: string, row: Record<string, Bindable>): RunResult {
    const keys = Object.keys(row);
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    return this.run(sql, ...keys.map((k) => row[k]));
  }

  upsert(table: string, row: Record<string, Bindable>, conflictKeys: string[]): RunResult {
    const keys = Object.keys(row);
    const updates = keys.filter((k) => !conflictKeys.includes(k));
    const sql =
      `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) ` +
      `ON CONFLICT(${conflictKeys.join(', ')}) DO UPDATE SET ${updates.map((k) => `${k}=excluded.${k}`).join(', ')}`;
    return this.run(sql, ...keys.map((k) => row[k]));
  }

  patch(table: string, idColumn: string, id: string, changes: Record<string, Bindable>): RunResult {
    const keys = Object.keys(changes);
    if (!keys.length) return { changes: 0, lastInsertRowid: 0 };
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${idColumn} = ?`;
    return this.run(sql, ...keys.map((k) => changes[k]), id);
  }

  migrate(migrations: Migration[], now: number): string[] {
    const applied = new Set(this.all<{ id: string }>('SELECT id FROM _migrations').map((r) => r.id));
    const ran: string[] = [];
    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      try {
        this.raw.exec('BEGIN IMMEDIATE');
        this.raw.exec(m.sql);
        this.raw.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run(m.id, now);
        this.raw.exec('COMMIT');
      } catch (e) {
        try { this.raw.exec('ROLLBACK'); } catch { /* noop */ }
        throw new Error(`Migration "${m.id}" failed: ${(e as Error).message}`);
      }
      ran.push(m.id);
    }
    return ran;
  }

  close(): void { this.cache.clear(); this.raw.close(); }
}

export function openDb(location = process.env.AIN_DB || 'data/ain.db'): Db {
  return new Db(location === 'memory' ? ':memory:' : location);
}
