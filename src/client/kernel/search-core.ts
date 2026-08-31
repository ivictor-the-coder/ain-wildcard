/**
 * What "search everything" means, expressed as data.
 *
 * Every source names the API route it needs. The shell reads the routes the
 * running server actually serves from `/v1/system/map` and keeps only the
 * sources whose module is installed, so the palette and the search page grow as
 * modules land and never fire a request that would 404.
 */
import { firstRegistered, fillParams, recordRouteCandidates, scoreEntry } from './shell-core';

export interface SearchHit {
  id: string;
  /** Source id — `company`, `customer`, `invoice`… — used by the type filter. */
  type: string;
  typeLabel: string;
  title: string;
  subtitle?: string;
  /** Null when no module has registered a screen for this kind of object yet. */
  href: string | null;
  icon: string;
}

export interface SearchSource {
  id: string;
  /** Plural, for the type filter and the result group heading. */
  label: string;
  singular: string;
  icon: string;
  /** `METHOD /path` that must be served for this source to exist. */
  requires: string;
  path: string;
  /** The route's own free-text parameter — `q` on records, `query` elsewhere. */
  queryKey: string;
  /** Where a hit opens, if some module registered a screen for it. */
  detailPattern: string | null;
  /** Extra parameters the route needs. */
  params?: Record<string, string>;
  map: (row: Record<string, unknown>) => { id: string; title: string; subtitle?: string };
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * `closed_won` → "Closed won". Stage names, lifecycle stages and statuses are
 * stored as snake case and would otherwise show raw in a result row. Anything
 * that is not plain snake case — a domain, an email, a title, an id — is left
 * exactly as it is.
 */
export function prettyValue(value: string): string {
  if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(value)) return value;
  const spaced = value.replace(/_/g, ' ');
  return spaced[0].toUpperCase() + spaced.slice(1);
}

const pick = (row: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = str(row[key]);
    if (value) return value;
  }
  return undefined;
};

export interface CrmObjectType {
  name: string;
  label: string;
  plural_label: string;
  icon: string;
  category: string;
  primary_property: string;
  secondary_property: string | null;
}

export interface BuildSourcesInput {
  /** Object types from `/v1/crm/schema`. */
  objectTypes: CrmObjectType[];
  /** `METHOD /path` strings the server serves. */
  routes: Set<string>;
  /** Route patterns some client module has registered a screen for. */
  registered: string[];
}

export function buildSources({ objectTypes, routes, registered }: BuildSourcesInput): SearchSource[] {
  const sources: SearchSource[] = [];

  if (routes.has('GET /v1/records/:type')) {
    for (const type of objectTypes) {
      if (type.category !== 'record') continue;
      sources.push({
        id: type.name,
        label: type.plural_label,
        singular: type.label,
        icon: type.icon,
        requires: 'GET /v1/records/:type',
        path: `/v1/records/${type.name}`,
        queryKey: 'q',
        detailPattern: firstRegistered(registered, recordRouteCandidates(type.name)),
        map: (row) => {
          const properties = (row.properties ?? {}) as Record<string, unknown>;
          return {
            id: String(row.id ?? ''),
            title: str(row.display_name) ?? str(properties[type.primary_property]) ?? String(row.id ?? ''),
            subtitle: type.secondary_property ? str(properties[type.secondary_property]) : undefined,
          };
        },
      });
    }
  }

  if (routes.has('GET /v1/customers')) {
    sources.push({
      id: 'customer',
      label: 'Billing customers',
      singular: 'Customer',
      icon: 'wallet',
      requires: 'GET /v1/customers',
      path: '/v1/customers',
      queryKey: 'query',
      detailPattern: firstRegistered(registered, ['/customers/:id', '/billing/customers/:id']),
      map: (row) => ({
        id: String(row.id ?? ''),
        title: pick(row, ['name', 'email']) ?? String(row.id ?? ''),
        subtitle: pick(row, ['email', 'description']),
      }),
    });
  }

  if (routes.has('GET /v1/invoices')) {
    sources.push({
      id: 'invoice',
      label: 'Invoices',
      singular: 'Invoice',
      icon: 'invoice',
      requires: 'GET /v1/invoices',
      path: '/v1/invoices',
      queryKey: 'query',
      detailPattern: firstRegistered(registered, ['/invoices/:id', '/billing/invoices/:id']),
      map: (row) => ({
        id: String(row.id ?? ''),
        title: pick(row, ['number', 'id']) ?? String(row.id ?? ''),
        subtitle: [pick(row, ['customer_name', 'customer_email']), pick(row, ['status'])].filter(Boolean).join(' · ') || undefined,
      }),
    });
  }

  if (routes.has('GET /v1/products')) {
    sources.push({
      id: 'product',
      label: 'Price book',
      singular: 'Product',
      icon: 'tag',
      requires: 'GET /v1/products',
      path: '/v1/products',
      queryKey: 'query',
      detailPattern: firstRegistered(registered, ['/products/:id', '/catalog/products/:id']),
      map: (row) => ({
        id: String(row.id ?? ''),
        title: pick(row, ['name']) ?? String(row.id ?? ''),
        subtitle: pick(row, ['tagline', 'description']),
      }),
    });
  }

  return sources;
}

/**
 * Map rows to hits and drop anything that does not actually match the query.
 * A route that quietly ignores an unsupported search parameter would otherwise
 * return its first page for every keystroke, which reads as a wrong answer.
 */
export function hitsFrom(source: SearchSource, rows: Record<string, unknown>[], query: string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const row of rows) {
    const mapped = source.map(row);
    if (!mapped.id || !mapped.title) continue;
    const entry = { id: mapped.id, title: mapped.title, subtitle: mapped.subtitle };
    if (query.trim() && scoreEntry(entry, query) < 0) continue;
    hits.push({
      id: mapped.id,
      type: source.id,
      typeLabel: source.singular,
      title: mapped.title,
      subtitle: mapped.subtitle ? prettyValue(mapped.subtitle) : undefined,
      href: source.detailPattern ? fillParams(source.detailPattern, mapped.id) : null,
      icon: source.icon,
    });
  }
  return hits;
}

/** Interleave sources so one big table cannot crowd out every other kind. */
export function mergeHits(groups: SearchHit[][], limit: number): SearchHit[] {
  const merged: SearchHit[] = [];
  for (let round = 0; merged.length < limit; round++) {
    let added = false;
    for (const group of groups) {
      if (round >= group.length) continue;
      merged.push(group[round]);
      added = true;
      if (merged.length >= limit) break;
    }
    if (!added) break;
  }
  return merged;
}

/* ================================ typeahead =============================== */

/** One row the top-bar typeahead can put under the highlight. */
export interface TypeaheadTarget {
  /** Stable per row: the DOM id the combobox points `aria-activedescendant` at. */
  id: string;
  /** Where ↵ goes. */
  href: string;
  /** The record this row shows, or null for the row that opens the full page. */
  hit: SearchHit | null;
}

/**
 * The rows ↑↓ may land on, in the order they are painted.
 *
 * A hit whose object type has no screen on this workspace is still shown — it
 * is a real match — but it is not something ↵ could open, so it never takes the
 * highlight. The last row is always the full search page: a typeahead that can
 * only reach the four hits per source it had room for would otherwise be a
 * narrower search than the one it replaced.
 */
export function typeaheadTargets(
  groups: readonly { source: SearchSource; hits: SearchHit[] }[],
  query: string,
): TypeaheadTarget[] {
  const targets: TypeaheadTarget[] = [];
  for (const group of groups) {
    for (const hit of group.hits) {
      if (!hit.href) continue;
      targets.push({ id: `${hit.type}:${hit.id}`, href: hit.href, hit });
    }
  }
  const trimmed = query.trim();
  if (trimmed) targets.push({ id: 'everything', href: `/search?q=${encodeURIComponent(trimmed)}`, hit: null });
  return targets;
}
