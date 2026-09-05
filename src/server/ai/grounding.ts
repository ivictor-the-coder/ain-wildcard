/**
 * The engine's view of the workspace.
 *
 * Two jobs: describe the org (currency, timezone, people) so every number is
 * formatted the way that business writes numbers, and build a compact index of
 * every nameable record so a question can be attached to the records it is
 * actually about.
 *
 * The billing side of the platform is discovered at runtime rather than
 * imported, because modules boot independently: if an invoices table exists the
 * engine grounds money questions in invoices, and if it does not it says so and
 * falls back to closed-won pipeline instead of inventing a number.
 */
import type { Ctx } from '../kernel/context';
import type { Db } from '../kernel/db';
import { parseJson } from '../kernel/db';
import { acronymOf, coreName, normalise } from './text';

export interface WorkspaceProfile {
  orgId: string;
  name: string;
  domain: string | null;
  currency: string;
  locale: string;
  timezone: string;
  now: number;
  people: { id: string; name: string; email: string; title: string | null; role: string }[];
}

export interface EntityRef {
  id: string;
  /** `company`, `contact`, `deal`, `ticket`, `user`, `customer`, `invoice`, … */
  type: string;
  label: string;
  /** Extra searchable strings: domain, email, deal name, invoice number. */
  aliases: string[];
  sublabel: string | null;
  ownerId: string | null;
  updated: number;
  source: 'crm' | 'user' | 'billing' | 'catalog' | 'metering';
}

export interface EntityIndex {
  orgId: string;
  entities: EntityRef[];
  /** Inverse document frequency per token — stops "systems" outranking a name. */
  idf: Map<string, number>;
  stamp: string;
}

/* ---------------------------- schema discovery ---------------------------- */

interface SchemaInfo {
  tables: Map<string, Set<string>>;
}

const schemaCache = new WeakMap<Db, { stamp: number; info: SchemaInfo }>();

export function schemaOf(db: Db): SchemaInfo {
  const count = db.count(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'`);
  const cached = schemaCache.get(db);
  if (cached && cached.stamp === count) return cached.info;
  const tables = new Map<string, Set<string>>();
  for (const row of db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)) {
    const cols = db.all<{ name: string }>(`PRAGMA table_info(${row.name})`).map((c) => c.name);
    tables.set(row.name, new Set(cols));
  }
  const info: SchemaInfo = { tables };
  schemaCache.set(db, { stamp: count, info });
  return info;
}

export const hasTable = (db: Db, table: string): boolean => schemaOf(db).tables.has(table);
export const hasColumn = (db: Db, table: string, column: string): boolean => !!schemaOf(db).tables.get(table)?.has(column);

const firstColumn = (db: Db, table: string, candidates: string[]): string | null =>
  candidates.find((c) => hasColumn(db, table, c)) ?? null;

export interface InvoiceSource {
  table: string;
  amountColumn: string;
  paidColumn: string | null;
  /**
   * When the money landed. Only a question about cash collected may filter on
   * it: an unpaid invoice has no payment date, so a window on this column
   * silently excludes every row a receivables question is about.
   */
  paidDateColumn: string | null;
  /** When the bill was raised — the date every other invoice question means. */
  issuedDateColumn: string;
  /**
   * When the bill fell due.
   *
   * Outstanding is what is owed; overdue is what is *late*. On this workspace
   * that is $133,400, €1,007 and £1,560 across 7 invoices against $127,840
   * across 1 — and every "overdue", "past due" and "in arrears" question was
   * answered with the first pair of figures.
   */
  dueDateColumn: string | null;
  statusColumn: string | null;
  customerColumn: string | null;
  currencyColumn: string | null;
  numberColumn: string | null;
}

export interface CustomerSource {
  table: string;
  nameColumn: string | null;
  emailColumn: string | null;
  /** Column that points back at a CRM company record, when the module keeps one. */
  companyColumn: string | null;
}

export interface SubscriptionSource {
  table: string;
  customerColumn: string | null;
  statusColumn: string | null;
  amountColumn: string | null;
  intervalColumn: string | null;
}

export interface BillingSources {
  invoices: InvoiceSource | null;
  customers: CustomerSource | null;
  subscriptions: SubscriptionSource | null;
}

const billingCache = new WeakMap<Db, { stamp: number; sources: BillingSources }>();

/**
 * Find the billing module's tables without importing it. A table qualifies only
 * if it carries `org_id` plus the columns the aggregation actually needs, so a
 * partially-built module can never produce a half-correct number.
 */
export function billingSources(db: Db): BillingSources {
  const schema = schemaOf(db);
  const cached = billingCache.get(db);
  if (cached && cached.stamp === schema.tables.size) return cached.sources;

  const names = [...schema.tables.keys()];
  const pick = (test: (name: string) => boolean) =>
    names.filter((n) => test(n) && schema.tables.get(n)?.has('org_id'))
      .sort((a, b) => a.length - b.length)[0] ?? null;

  const invoiceTable = pick((n) => /invoice/.test(n) && !/(item|line|_seq|counter|number)/.test(n));
  const customerTable = pick((n) => /customer/.test(n) && !/(item|line|balance_txn|_seq)/.test(n));
  const subscriptionTable = pick((n) => /subscription/.test(n) && !/(item|schedule|phase|_seq)/.test(n));

  const invoices: InvoiceSource | null = invoiceTable
    ? (() => {
        const amountColumn = firstColumn(db, invoiceTable, ['total', 'amount_due', 'amount', 'subtotal', 'amount_total']);
        // Two different dates, kept apart on purpose. One cached "invoice date"
        // meant `paid_at` won for every question, and `paid_at IS NULL` on every
        // open invoice — so "what are we owed" matched no rows in any window.
        const issuedDateColumn = firstColumn(db, invoiceTable, ['finalized_at', 'issued_at', 'created', 'period_end', 'due_at']);
        if (!amountColumn || !issuedDateColumn) return null;
        return {
          table: invoiceTable,
          amountColumn,
          paidColumn: firstColumn(db, invoiceTable, ['amount_paid', 'paid_amount']),
          paidDateColumn: firstColumn(db, invoiceTable, ['paid_at', 'paid_date', 'settled_at']),
          issuedDateColumn,
          // When the bill fell due, which is the whole of the difference
          // between outstanding and overdue: an open invoice inside its terms
          // is money owed, not money late.
          dueDateColumn: firstColumn(db, invoiceTable, ['due_date', 'due_at', 'payment_due_at']),
          statusColumn: firstColumn(db, invoiceTable, ['status', 'state']),
          customerColumn: firstColumn(db, invoiceTable, ['customer_id', 'account_id', 'company_id', 'customer']),
          currencyColumn: firstColumn(db, invoiceTable, ['currency']),
          numberColumn: firstColumn(db, invoiceTable, ['number', 'invoice_number', 'reference']),
        };
      })()
    : null;

  const customers: CustomerSource | null = customerTable
    ? {
        table: customerTable,
        nameColumn: firstColumn(db, customerTable, ['name', 'display_name', 'legal_name']),
        emailColumn: firstColumn(db, customerTable, ['email', 'billing_email']),
        companyColumn: firstColumn(db, customerTable, ['company_id', 'crm_company_id', 'record_id', 'crm_record_id']),
      }
    : null;

  const subscriptions: SubscriptionSource | null = subscriptionTable
    ? {
        table: subscriptionTable,
        customerColumn: firstColumn(db, subscriptionTable, ['customer_id', 'account_id', 'company_id']),
        statusColumn: firstColumn(db, subscriptionTable, ['status', 'state']),
        amountColumn: firstColumn(db, subscriptionTable, ['amount', 'total', 'mrr', 'monthly_amount']),
        intervalColumn: firstColumn(db, subscriptionTable, ['interval', 'billing_interval', 'recurring_interval']),
      }
    : null;

  const sources: BillingSources = { invoices, customers, subscriptions };
  billingCache.set(db, { stamp: schema.tables.size, sources });
  return sources;
}

export interface MeterSource {
  table: string;
  nameColumn: string;
  /** The event name the meter reads — how a person says "telemetry events". */
  eventColumn: string | null;
  unitColumn: string | null;
  statusColumn: string | null;
}

const meterCache = new WeakMap<Db, { stamp: number; source: MeterSource | null }>();

/**
 * The metering module's meters, discovered the same way as the ledger's tables.
 *
 * A workspace that meters usage names its meters, and a question about
 * "telemetry events" is a question about one of them. Without them in the index
 * that phrase resolves to nothing and the engine answers about bookings
 * instead, which is a different question with a different number.
 */
export function meterSource(db: Db): MeterSource | null {
  const schema = schemaOf(db);
  const cached = meterCache.get(db);
  if (cached && cached.stamp === schema.tables.size) return cached.source;
  const table = [...schema.tables.keys()]
    .filter((n) => /(^|_)meters$/.test(n) && schema.tables.get(n)?.has('org_id'))
    .sort((a, b) => a.length - b.length)[0] ?? null;
  const nameColumn = table ? firstColumn(db, table, ['name', 'display_name', 'label']) : null;
  const source: MeterSource | null = table && nameColumn
    ? {
        table,
        nameColumn,
        eventColumn: firstColumn(db, table, ['event_name', 'event', 'key']),
        unitColumn: firstColumn(db, table, ['unit_label', 'unit']),
        statusColumn: firstColumn(db, table, ['status', 'state']),
      }
    : null;
  meterCache.set(db, { stamp: schema.tables.size, source });
  return source;
}

/* ----------------------------- workspace facts ---------------------------- */

export function workspaceProfile(ctx: Ctx, orgId: string): WorkspaceProfile {
  const org = ctx.db.get<{
    id: string; name: string; domain: string | null; default_currency: string; locale: string; timezone: string;
  }>(`SELECT id, name, domain, default_currency, locale, timezone FROM orgs WHERE id = ?`, orgId);
  const people = ctx.db.all<{ id: string; name: string; email: string; title: string | null; role: string }>(
    `SELECT u.id, u.name, u.email, u.title, m.role FROM users u
     JOIN memberships m ON m.user_id = u.id WHERE m.org_id = ? ORDER BY u.name`, orgId);
  return {
    orgId,
    // Every sentence in the engine starts with this name, so its fallback has
    // to be capitalised the way a name is: "this workspace is running at..."
    // was the first thing a brand-new workspace read.
    name: org?.name ?? 'This workspace',
    domain: org?.domain ?? null,
    currency: org?.default_currency ?? 'usd',
    locale: org?.locale ?? 'en-US',
    timezone: org?.timezone ?? 'UTC',
    now: ctx.now(),
    people,
  };
}

/* ------------------------------ entity index ------------------------------ */

/** Keyed by database as well as org: two apps in one process never share one. */
const indexCache = new WeakMap<Db, Map<string, EntityIndex>>();
const MAX_ENTITIES = 6000;

const cacheFor = (db: Db): Map<string, EntityIndex> => {
  let byOrg = indexCache.get(db);
  if (!byOrg) { byOrg = new Map(); indexCache.set(db, byOrg); }
  return byOrg;
};

function crmStamp(ctx: Ctx, orgId: string): string {
  const row = ctx.db.get<{ n: number; u: number | null }>(
    `SELECT COUNT(*) AS n, MAX(updated) AS u FROM crm_records WHERE org_id = ?`, orgId);
  const users = ctx.db.count(`SELECT COUNT(*) FROM memberships WHERE org_id = ?`, orgId);
  const billing = billingSources(ctx.db);
  const invoices = billing.invoices ? ctx.db.count(`SELECT COUNT(*) FROM ${billing.invoices.table} WHERE org_id = ?`, orgId) : 0;
  const meters = meterSource(ctx.db);
  const meterCount = meters ? ctx.db.count(`SELECT COUNT(*) FROM ${meters.table} WHERE org_id = ?`, orgId) : 0;
  return `${row?.n ?? 0}:${row?.u ?? 0}:${users}:${invoices}:${meterCount}`;
}

/** Build (or reuse) the searchable index of everything nameable in the org. */
export function entityIndex(ctx: Ctx, orgId: string): EntityIndex {
  const stamp = crmStamp(ctx, orgId);
  const cache = cacheFor(ctx.db);
  const cached = cache.get(orgId);
  if (cached && cached.stamp === stamp) return cached;

  const entities: EntityRef[] = [];

  if (hasTable(ctx.db, 'crm_records')) {
    const rows = ctx.db.all<{
      id: string; object_type: string; display_name: string; properties: string; owner_id: string | null; updated: number;
    }>(
      `SELECT id, object_type, display_name, properties, owner_id, updated FROM crm_records
       WHERE org_id = ? AND archived = 0 AND merged_into IS NULL
       ORDER BY updated DESC LIMIT ?`, orgId, MAX_ENTITIES);
    for (const row of rows) {
      const props = parseJson<Record<string, unknown>>(row.properties, {});
      const aliases: string[] = [];
      const push = (value: unknown) => { if (typeof value === 'string' && value.trim().length > 1) aliases.push(value.trim()); };
      push(props.domain);
      push(props.email);
      push(props.website);
      push(props.name);
      push(props.full_name);
      push(props.subject);
      if (typeof props.domain === 'string') aliases.push(String(props.domain).replace(/^www\./, '').split('.')[0]);
      entities.push({
        id: row.id,
        type: row.object_type,
        label: row.display_name || row.id,
        aliases,
        sublabel: typeof props.industry === 'string' ? String(props.industry)
          : typeof props.job_title === 'string' ? String(props.job_title)
          : typeof props.deal_stage === 'string' ? String(props.deal_stage) : null,
        ownerId: row.owner_id,
        updated: row.updated,
        source: 'crm',
      });
    }
  }

  for (const person of ctx.db.all<{ id: string; name: string; email: string; title: string | null }>(
    `SELECT u.id, u.name, u.email, u.title FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.org_id = ?`, orgId)) {
    entities.push({
      id: person.id, type: 'user', label: person.name, aliases: [person.email, person.email.split('@')[0]],
      sublabel: person.title, ownerId: person.id, updated: 0, source: 'user',
    });
  }

  const billing = billingSources(ctx.db);
  if (billing.customers?.nameColumn) {
    const { table, nameColumn, emailColumn } = billing.customers;
    for (const row of ctx.db.all<{ id: string; nm: string | null; em: string | null }>(
      `SELECT id, ${nameColumn} AS nm, ${emailColumn ?? 'NULL'} AS em FROM ${table} WHERE org_id = ? LIMIT 2000`, orgId)) {
      if (!row.nm) continue;
      entities.push({
        id: row.id, type: 'customer', label: row.nm, aliases: row.em ? [row.em] : [],
        sublabel: 'Billing account', ownerId: null, updated: 0, source: 'billing',
      });
    }
  }
  if (billing.invoices?.numberColumn) {
    const { table, numberColumn } = billing.invoices;
    for (const row of ctx.db.all<{ id: string; num: string | null }>(
      `SELECT id, ${numberColumn} AS num FROM ${table} WHERE org_id = ? ORDER BY rowid DESC LIMIT 500`, orgId)) {
      entities.push({
        id: row.id, type: 'invoice', label: row.num || row.id, aliases: [row.id],
        sublabel: 'Invoice', ownerId: null, updated: 0, source: 'billing',
      });
    }
  }
  const meters = meterSource(ctx.db);
  if (meters) {
    const { table, nameColumn, eventColumn, unitColumn } = meters;
    for (const row of ctx.db.all<{ id: string; nm: string | null; ev: string | null; un: string | null }>(
      `SELECT id, ${nameColumn} AS nm, ${eventColumn ?? 'NULL'} AS ev, ${unitColumn ?? 'NULL'} AS un
       FROM ${table} WHERE org_id = ? LIMIT 200`, orgId)) {
      if (!row.nm) continue;
      entities.push({
        id: row.id,
        type: 'meter',
        label: row.nm,
        // "telemetry_events" is how the API says it and how people type it.
        aliases: [row.ev, row.ev?.replace(/_/g, ' ')].filter((a): a is string => !!a),
        sublabel: row.un ? `Meter, in ${row.un}` : 'Meter',
        ownerId: null,
        updated: 0,
        source: 'metering',
      });
    }
  }
  if (hasTable(ctx.db, 'catalog_products')) {
    for (const row of ctx.db.all<{ id: string; name: string }>(
      `SELECT id, name FROM catalog_products WHERE org_id = ? LIMIT 500`, orgId)) {
      entities.push({ id: row.id, type: 'product', label: row.name, aliases: [], sublabel: 'Product', ownerId: null, updated: 0, source: 'catalog' });
    }
  }

  const idf = buildIdf(entities);
  const index: EntityIndex = { orgId, entities, idf, stamp };
  cache.set(orgId, index);
  return index;
}

/** Tokens that appear in half the account names carry almost no signal. */
function buildIdf(entities: EntityRef[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entity of entities) {
    const seen = new Set(normalise(entity.label).split(' ').filter(Boolean));
    for (const token of seen) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const total = Math.max(entities.length, 1);
  const idf = new Map<string, number>();
  for (const [token, n] of counts) idf.set(token, Math.log((total + 1) / (n + 0.5)));
  return idf;
}

/** Precomputed match keys for one entity — built once, scored many times. */
export interface EntityKeys {
  entity: EntityRef;
  normalised: string;
  core: string;
  acronym: string;
  tokens: string[];
  aliasKeys: string[];
}

const keyCache = new WeakMap<EntityRef, EntityKeys>();

export function keysOf(entity: EntityRef): EntityKeys {
  const cached = keyCache.get(entity);
  if (cached) return cached;
  const normalised = normalise(entity.label);
  const keys: EntityKeys = {
    entity,
    normalised,
    core: coreName(entity.label),
    acronym: acronymOf(entity.label),
    tokens: normalised.split(' ').filter(Boolean),
    aliasKeys: entity.aliases.map((a) => normalise(a)).filter(Boolean),
  };
  keyCache.set(entity, keys);
  return keys;
}

/** Drop the cached index for a workspace after a bulk write. */
export const invalidateIndex = (db: Db, orgId?: string): void => {
  const cache = indexCache.get(db);
  if (!cache) return;
  if (orgId) cache.delete(orgId); else cache.clear();
};
