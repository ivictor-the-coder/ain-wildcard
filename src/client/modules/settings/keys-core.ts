/**
 * What an API key's scopes actually reach, computed the way the door computes it.
 *
 * Scopes were cosmetic until this wave. `route.meta.scopes` was their only
 * reader and no route in the platform declared it, so a scope set was nothing
 * but a rung on the role ladder: a key minted `["crm:read"]` — sold to a
 * customer as a reporting credential — carried every read in the workspace,
 * and `["metering:write"]` carried every write the `member` rung reaches. This
 * surface said exactly that, in as many words, and was right to. It is now
 * false: `missingScope` in `src/server/app.ts` refuses any request whose route
 * no held scope covers, so the sentence under every key, and the one the mint
 * dialog shows before the secret exists, has to be the new rule — and it has
 * to be the same rule the door applies, which is why the reach is computed
 * here rather than described.
 *
 * The server asks two questions of every request and this mirrors both:
 *
 * - *How much*, from `keyRole`: `*` authenticates as `admin`, anything naming
 *   a write as `member` — the rung every mutating route is gated at — and
 *   everything else as `readonly`. Nothing but `*` reaches an admin-only
 *   route, and the rung is capped by the current role of whoever minted it.
 * - *Where*, from `missingScope`: a route belongs to its module and to every
 *   tag it is filed under in the API reference, and it sits on that domain's
 *   read side or its write side. A held scope grants an action on a domain
 *   when it names that domain (or every domain) and names that action,
 *   `admin`, or `*` — and `write` implies `read` in the same domain.
 *
 * Two consequences a mint dialog must not hide. A scope the door can match
 * against nothing — `crm:list`, because a route is only ever a read or a
 * write; `:write`, because it names no domain — reaches nothing at all, while
 * still being enough to put the key on the `member` rung. And no domain is
 * assumed to exist anywhere below: `readScope` reports what a scope *would*
 * reach, never that some route is filed under it.
 */
import { formatList } from '../../design/format';
import type { Role } from './types';

/** The verbs a scope can name in the action position. Anything else is a domain. */
const ACTIONS = new Set(['read', 'write', 'admin']);

/** A scope that asks to change something — the server's own `WRITE_SCOPE`. */
const WRITE_SCOPE = /(^|:)(write|admin|\*)$/;

/** The routes every live key may call whatever it was restricted to. */
export const ALWAYS_REACHABLE = 'GET /v1/me';

/** One scope, split and read the way `splitScope` and `scopeGrants` read it. */
export interface HeldScope {
  /** The scope exactly as it was minted. */
  scope: string;
  /** The domain it names, or `'*'` for every domain. */
  domain: string;
  /** The action it names, or `'*'` for every action in that domain. */
  action: string;
  /** Whether it reaches that domain's read side, and its write side. */
  reads: boolean;
  writes: boolean;
  /** What this one scope reaches, on its own, in a sentence. */
  reach: string;
}

/**
 * `crm:write` → the crm domain's writes (and, because write implies read, its
 * reads). A bare token is one of two things, exactly as the server reads it: a
 * verb, which applies in every domain, or a domain named on its own, which
 * means every action in it.
 */
export function readScope(raw: string): HeldScope {
  const scope = raw.trim();
  const lower = scope.toLowerCase();
  if (lower === '*') {
    return {
      scope, domain: '*', action: '*', reads: true, writes: true,
      reach: 'Every route in the workspace — every read, every write, and the admin-only routes with them.',
    };
  }
  const colon = lower.indexOf(':');
  const [domain, action] = colon >= 0
    ? [lower.slice(0, colon), lower.slice(colon + 1)]
    : ACTIONS.has(lower) ? ['*', lower] : [lower, '*'];

  // Everything the door will never match. It is worth its own sentence: the
  // key is still minted, still authenticates, and reaches nothing.
  if (!domain) {
    return {
      scope, domain, action, reads: false, writes: false,
      reach: `This names no domain, so no route matches it — on its own it reaches nothing but ${ALWAYS_REACHABLE}.`,
    };
  }
  if (action !== '*' && !ACTIONS.has(action)) {
    return {
      scope, domain, action, reads: false, writes: false,
      reach: `“${action}” is not an action the platform knows — every route is either a read or a write — so no route matches this and it reaches nothing.`,
    };
  }

  const writes = action === '*' || action === 'write' || action === 'admin';
  const reads = true; // read, write and admin all reach the read side.
  const everywhere = domain === '*';
  return {
    scope,
    domain,
    action,
    reads,
    writes,
    reach: everywhere
      ? action === 'read'
        ? 'Every read in every domain, and no write anywhere.'
        : action === 'write'
          ? 'Every write in every domain, and every read with it — write implies read.'
          : 'Every read and every write in every domain. It does not confer the admin role — only * does that.'
      : action === 'read'
        ? `Reads filed under ${domain}, and nothing else — no write, and no read in another domain.`
        : action === 'write'
          ? `Writes filed under ${domain}, and its reads with them.`
          : action === 'admin'
            ? `Reads and writes filed under ${domain} — the same reach as ${domain}:write, because no route inside a domain is admin-only.`
            : `Reads and writes filed under ${domain} — every action the platform has in it.`,
  };
}

export interface ScopeReading {
  /** The rung the key authenticates at, from `keyRole`. */
  role: Role;
  tone: 'warning' | 'info' | 'neutral' | 'danger';
  /** Every scope held, in the order it was minted, with what each one reaches. */
  held: HeldScope[];
  /** The domains whose reads it reaches, sorted — `null` for every domain. */
  reads: string[] | null;
  /** The same for writes. `[]` is a key that may change nothing. */
  writes: string[] | null;
  /** Scopes no route can match. A key made only of these reaches nothing. */
  dead: string[];
  /** One sentence, for a list cell, a tooltip, the mint banner and the revoke dialog. */
  summary: string;
}

/**
 * The reach of a whole scope set.
 *
 * The sentence is composed here, not in the component, because five surfaces
 * have to agree on it — the Reach column, its tooltip, the mint dialog's
 * banner, the secret dialog and the revoke confirmation — and because a claim
 * about what a credential can do belongs somewhere a test can read it without
 * a browser. The sentences are English and the domains in them are
 * identifiers, so the one part with a locale in it is the joining — and that
 * is the kit's `formatList`, imported rather than rewritten.
 */
export function readScopes(scopes: readonly string[]): ScopeReading {
  // `keyRole` tests the raw array for `'*'` and does not trim, while
  // `missingScope` trims before comparing — so the rung comes off the array
  // exactly as the server reads it, never off the parsed scope.
  const role: Role = scopes.includes('*')
    ? 'admin'
    : scopes.some((s) => WRITE_SCOPE.test(s.trim().toLowerCase())) ? 'member' : 'readonly';
  const everything = scopes.some((s) => s.trim() === '*');

  /**
   * The rung and the door are two separate refusals and both have to be spent
   * before a scope can be said to reach anything.
   *
   * `["metering"]` is the trap: a bare domain grants every action in it at the
   * door, but nothing in the set ends in write, admin or `*`, so `keyRole`
   * authenticates the key as `readonly` and the *role* check refuses every
   * mutating route before `missingScope` is ever asked. A line reading "reads
   * and writes filed under metering" would be the same falsehood this file
   * exists to remove, one layer down.
   */
  const held = scopes.map(readScope).map((scope) => {
    if (everything && scope.domain !== '*') {
      return { ...scope, reach: `${scope.reach} Redundant here: * in this set already reaches everything.` };
    }
    if (role === 'readonly' && scope.writes) {
      const named = scope.domain === '*' ? 'write' : `${scope.domain}:write`;
      return {
        ...scope,
        writes: false,
        reach: `Reads filed under ${scope.domain}. It names that domain's writes too, but no scope in this set ends `
          + `in write, admin or * — so the key authenticates as readonly and every mutating route refuses it before `
          + `the domain is even looked at. Name the action (${named}) to mean the writes.`,
      };
    }
    return scope;
  });

  const sideOf = (side: 'reads' | 'writes'): string[] | null => {
    const domains = new Set<string>();
    for (const scope of held) {
      if (!scope[side]) continue;
      if (scope.domain === '*') return null;
      domains.add(scope.domain);
    }
    return [...domains].sort();
  };
  const reads = sideOf('reads');
  const writes = role === 'readonly' ? [] : sideOf('writes');
  const dead = held.filter((s) => !s.reads && !s.writes).map((s) => s.scope);

  const ADMIN_ONLY = 'the admin-only routes — workspace settings, API keys, the audit trail and the clock';
  const summary = (() => {
    if (role === 'admin') {
      return 'Full access: every route in this workspace, including minting and revoking keys, workspace settings, '
        + 'the audit trail and the clock.';
    }
    if (reads !== null && reads.length === 0) {
      const held = scopes.length === 0
        ? 'This key holds no scopes at all'
        : `No route matches ${scopes.length === 1 ? 'this scope' : 'any of these scopes'}`;
      return `Nothing. ${held}, so every request is refused except ${ALWAYS_REACHABLE} — the one route any live key `
        + 'may call to read what it is.';
    }
    if (writes === null) {
      return `Reads and writes in every domain, and none of ${ADMIN_ONLY}.`;
    }
    if (writes.length === 0) {
      return reads === null
        ? 'Reads in every domain and no write anywhere — every mutating route refuses this key, and so does any read '
          + 'gated at admin, like the audit trail.'
        : `Reads under ${formatList(reads)} and nothing else — every write refuses this key, and so does a read in `
          + 'any other domain.';
    }
    const written = formatList(writes);
    if (reads === null) {
      return `Writes under ${written}, reads in every domain, and none of ${ADMIN_ONLY}.`;
    }
    return reads.length === writes.length
      ? `Reads and writes under ${written}, and nothing outside it — any other route is refused with the scope it `
        + `would have needed. Never ${ADMIN_ONLY}.`
      : `Writes under ${written}, reads under ${formatList(reads)}, and nothing outside them — any other route is `
        + `refused with the scope it would have needed. Never ${ADMIN_ONLY}.`;
  })();

  return {
    role,
    tone: reads !== null && reads.length === 0 ? 'danger' : role === 'admin' ? 'warning' : role === 'member' ? 'info' : 'neutral',
    held,
    reads,
    writes,
    dead,
    summary,
  };
}
