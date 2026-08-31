/**
 * Entity resolution: deciding which records a sentence is about.
 *
 * Substring search answers "does this string appear"; that is not the question.
 * "How much did Calder and Vance spend?" contains no substring of "Calder &
 * Vance Manufacturing", "MFS renewal" contains none of "Meridian Forge
 * Systems", and "nortgate chemical" contains none of "Northgate Chemical
 * Works". All three resolve here, with a score and a stated reason, by running
 * candidate mentions from the sentence against a ranked ladder of matchers:
 * ids, emails and domains first, then exact names, prefixes, acronyms, token
 * subsets, trigram similarity and finally bounded edit distance.
 */
import {
  COMMON_WORDS, DOMAIN_PATTERN, EMAIL_PATTERN, ID_PATTERN, QUOTED_PATTERN, STOPWORDS,
  acronymOf, coreName, dice, editSimilarity, normalise, ngramSpans, properNounSpans, trigrams,
} from './text';
import { keysOf, type EntityIndex, type EntityRef } from './grounding';

export type MentionKind = 'id' | 'email' | 'domain' | 'quoted' | 'proper' | 'ngram';

export interface Mention {
  text: string;
  kind: MentionKind;
  /** How much a match on this mention should be trusted, 0–1. */
  weight: number;
  at: number;
  /** True when the mention was written in capitals — the only way an acronym reads as one. */
  shouty: boolean;
}

export type MatchRule =
  | 'id' | 'alias_exact' | 'name_exact' | 'core_exact' | 'prefix' | 'acronym'
  | 'token_subset' | 'trigram' | 'edit_distance';

export interface ResolvedEntity {
  entity: EntityRef;
  score: number;
  rule: MatchRule;
  mention: string;
  explain: string;
}

/**
 * Words that describe the *shape* of a question, never the subject of one.
 * `COMMON_WORDS` carries the long tail; these are the ones a CRM question leans
 * on hardest, kept here so this file reads on its own.
 */
const VOCABULARY = new Set([
  'revenue', 'spend', 'spent', 'spending', 'invoice', 'invoices', 'invoiced', 'bill', 'billed', 'billing',
  'deal', 'deals', 'pipeline', 'quota', 'forecast', 'quarter', 'quarters', 'month', 'months', 'year',
  'years', 'week', 'weeks', 'day', 'days', 'today', 'yesterday', 'customer', 'customers', 'account',
  'accounts', 'company', 'companies', 'contact', 'contacts', 'ticket', 'tickets', 'subscription',
  'subscriptions', 'payment', 'payments', 'total', 'sum', 'average', 'count', 'number', 'top', 'last',
  'past', 'previous', 'this', 'next', 'open', 'closed', 'won', 'lost', 'new', 'old', 'churn', 'mrr',
  'arr', 'usage', 'credit', 'credits', 'renewal', 'renewals', 'email', 'emails', 'meeting', 'meetings',
  'call', 'calls', 'note', 'notes', 'task', 'tasks', 'owner', 'rep', 'reps', 'team', 'stage', 'status',
  'summary', 'draft', 'write', 'send', 'why', 'how', 'what', 'when', 'who', 'where', 'much', 'many',
  'q1', 'q2', 'q3', 'q4', 'ytd', 'mtd', 'qtd',
]);

const MIN_SCORE = 0.46;

/** Pull every plausible entity mention out of a sentence, best kinds first. */
export function extractMentions(text: string): Mention[] {
  const out: Mention[] = [];
  const seen = new Set<string>();
  const add = (raw: string, kind: MentionKind, weight: number, at: number) => {
    const value = raw.trim();
    if (value.length < 2) return;
    const key = `${kind}:${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    const letters = value.replace(/[^A-Za-z]/g, '');
    out.push({ text: value, kind, weight, at, shouty: letters.length >= 2 && letters === letters.toUpperCase() });
  };

  for (const m of text.matchAll(ID_PATTERN)) add(m[0], 'id', 1, m.index ?? 0);
  for (const m of text.matchAll(EMAIL_PATTERN)) add(m[0], 'email', 1, m.index ?? 0);
  for (const m of text.matchAll(DOMAIN_PATTERN)) add(m[0], 'domain', 0.98, m.index ?? 0);
  for (const m of text.matchAll(QUOTED_PATTERN)) add(m[1], 'quoted', 1, m.index ?? 0);

  for (const span of properNounSpans(text)) {
    const cleaned = span.replace(/\b(?:Q[1-4]|YTD|MTD|QTD)\b/g, '').trim();
    const tokens = normalise(cleaned).split(' ').filter(Boolean);
    if (!tokens.length) continue;
    if (tokens.every((t) => VOCABULARY.has(t) || STOPWORDS.has(t) || COMMON_WORDS.has(t))) continue;
    add(cleaned, 'proper', 0.96, text.indexOf(span));
  }

  for (const span of ngramSpans(text, 4)) {
    const tokens = span.split(' ');
    // "line 4", "the rate this quarter", "note that" — a span made only of the
    // words questions are built from is never the name of a record.
    if (tokens.every((t) => VOCABULARY.has(t) || STOPWORDS.has(t) || COMMON_WORDS.has(t) || t.length < 3)) continue;
    if (tokens.length === 1 && (span.length < 4 || VOCABULARY.has(span) || COMMON_WORDS.has(span))) continue;
    // Longer n-grams are better evidence; a bare word is the weakest mention.
    const weight = 0.6 + Math.min(tokens.length, 4) * 0.06;
    add(span, 'ngram', weight, text.toLowerCase().indexOf(span));
  }

  return out.sort((a, b) => b.weight - a.weight || b.text.length - a.text.length).slice(0, 60);
}

interface Scored { score: number; rule: MatchRule; detail: string }

/**
 * A meeting called "QBR — Kestrel Aerospace" mentions Kestrel; it is not
 * Kestrel. Business objects outrank the activities that reference them.
 */
const TYPE_PRIOR: Record<string, number> = {
  company: 1, customer: 1, contact: 0.98, deal: 0.95, user: 0.95, ticket: 0.93,
  invoice: 0.92, subscription: 0.92, product: 0.9,
  note: 0.76, call: 0.76, meeting: 0.76, email: 0.76, task: 0.78,
};
const typePrior = (type: string): number => TYPE_PRIOR[type] ?? 0.88;

function scoreMention(mention: Mention, entity: EntityRef, idf: Map<string, number>): Scored | null {
  const keys = keysOf(entity);
  const raw = mention.text;
  const value = normalise(raw);
  const looseValue = raw.trim().toLowerCase();
  if (!value) return null;

  if (mention.kind === 'id') {
    if (looseValue === entity.id.toLowerCase()) return { score: 1, rule: 'id', detail: `id ${entity.id}` };
    return null;
  }

  if (mention.kind === 'email' || mention.kind === 'domain') {
    for (const alias of entity.aliases) {
      const a = alias.toLowerCase();
      if (!a) continue;
      if (a === looseValue) return { score: 0.99, rule: 'alias_exact', detail: `${mention.kind} ${alias}` };
      if (mention.kind === 'email' && a === looseValue.split('@')[1]) {
        return { score: 0.9, rule: 'alias_exact', detail: `email domain ${a}` };
      }
      if (mention.kind === 'domain' && a.replace(/^www\./, '') === looseValue.replace(/^www\./, '')) {
        return { score: 0.97, rule: 'alias_exact', detail: `domain ${alias}` };
      }
    }
    return null;
  }

  // The name is checked before the aliases: a record whose alias list repeats
  // its own name must not score below a record that only has the name, or which
  // of two same-named records an answer is about turns on how they were seeded.
  if (value === keys.normalised) return { score: 1, rule: 'name_exact', detail: `exact name` };

  for (const alias of keys.aliasKeys) {
    if (alias && alias === value) return { score: 0.95, rule: 'alias_exact', detail: `alias "${alias}"` };
  }

  if (value === keys.core && keys.core) return { score: 0.94, rule: 'core_exact', detail: `name without suffixes` };

  const tokens = value.split(' ').filter(Boolean);
  const informative = tokens.filter((t) => !STOPWORDS.has(t));
  if (!informative.length) return null;
  // Mentions made only of words that half the book of business shares are noise.
  const meanIdf = informative.reduce((a, t) => a + (idf.get(t) ?? 2.5), 0) / informative.length;
  const idfFactor = Math.min(1, 0.45 + meanIdf / 4);

  if (mention.shouty && keys.acronym && keys.acronym.length >= 2 && value.replace(/\s/g, '') === keys.acronym) {
    return { score: 0.86, rule: 'acronym', detail: `acronym of "${entity.label}"` };
  }
  if (mention.shouty && informative.length > 1) {
    const initials = informative.map((t) => t[0]).join('');
    if (keys.acronym && initials === keys.acronym) {
      return { score: 0.8, rule: 'acronym', detail: `initials match "${entity.label}"` };
    }
  }

  if (keys.normalised.startsWith(value) || keys.core.startsWith(value)) {
    const charCoverage = value.length / Math.max(keys.normalised.length, 1);
    // Leading a name with a distinctive word ("Kestrel …") is strong evidence
    // even when the rest of the legal name is long.
    const distinctive = Math.min(meanIdf / 3, 1);
    if (value.length >= 4 || tokens.length > 1) {
      const score = (0.6 + 0.2 * charCoverage + 0.18 * distinctive) * idfFactor;
      return { score, rule: 'prefix', detail: `"${raw}" starts "${entity.label}"` };
    }
  }
  if (value.length >= 6 && value.startsWith(keys.core) && keys.core.length >= 4) {
    return { score: 0.7 * idfFactor, rule: 'prefix', detail: `"${entity.label}" starts "${raw}"` };
  }

  const entityTokens = new Set(keys.tokens);
  const contained = informative.filter((t) => entityTokens.has(t)).length;
  if (contained === informative.length) {
    const coverage = contained / Math.max(keys.tokens.length, 1);
    const weighted = informative.reduce((a, t) => a + (idf.get(t) ?? 2.5), 0) / (informative.length * 3.5);
    const score = (0.6 + 0.24 * coverage + 0.16 * Math.min(weighted, 1)) * idfFactor;
    return { score, rule: 'token_subset', detail: `every word of "${raw}" appears in "${entity.label}"` };
  }

  const similarity = dice(trigrams(value), trigrams(keys.core || keys.normalised));
  if (similarity >= 0.42) {
    return { score: (0.34 + 0.62 * similarity) * idfFactor, rule: 'trigram', detail: `${Math.round(similarity * 100)}% trigram overlap with "${entity.label}"` };
  }

  if (value.length >= 5 && Math.abs(value.length - keys.core.length) <= 4) {
    const edit = editSimilarity(value, keys.core || keys.normalised);
    if (edit >= 0.72) {
      return { score: (0.3 + 0.6 * edit) * idfFactor, rule: 'edit_distance', detail: `${Math.round(edit * 100)}% character match with "${entity.label}" (typo tolerant)` };
    }
  }

  return null;
}

export interface ResolveOptions {
  /** Types to favour, e.g. ['company','customer'] for a spend question. */
  prefer?: string[];
  /** Hard filter — only these types may be returned. */
  only?: string[];
  limit?: number;
  minScore?: number;
  /** Collapse records that share a type and a display name to the best one. */
  dedupe?: boolean;
}

/**
 * Rank the records a message is about. Returns at most `limit` results, each
 * with the rule and the mention that produced it so the trace can defend it.
 */
export function resolveEntities(message: string, index: EntityIndex, opts: ResolveOptions = {}): ResolvedEntity[] {
  const mentions = extractMentions(message);
  if (!mentions.length) return [];
  const prefer = new Set(opts.prefer ?? []);
  const only = opts.only?.length ? new Set(opts.only) : null;
  const minScore = opts.minScore ?? MIN_SCORE;
  const best = new Map<string, ResolvedEntity>();

  for (const entity of index.entities) {
    if (only && !only.has(entity.type)) continue;
    let winner: ResolvedEntity | null = null;
    for (const mention of mentions) {
      const scored = scoreMention(mention, entity, index.idf);
      if (!scored) continue;
      const typeBoost = (prefer.has(entity.type) ? 1.06 : 1) * typePrior(entity.type);
      const score = Math.min(1, scored.score * mention.weight * typeBoost);
      if (!winner || score > winner.score) {
        winner = {
          entity,
          score: Number(score.toFixed(4)),
          rule: scored.rule,
          mention: mention.text,
          explain: `${entity.label} — ${scored.detail} (mention "${mention.text}", ${scored.rule})`,
        };
      }
    }
    if (winner && winner.score >= minScore) best.set(entity.id, winner);
  }

  // A CRM company and a billing customer can carry the same name and the same
  // score. Which one the answer is about must come from the caller's stated
  // preference order and then from a fixed rule — never from the order rows
  // happen to sit in the index, which changes as other modules seed.
  const preferRank = new Map((opts.prefer ?? []).map((type, index) => [type, index] as const));
  const rankOf = (candidate: ResolvedEntity): number => preferRank.get(candidate.entity.type) ?? preferRank.size;
  const ranked = [...best.values()].sort((a, b) =>
    b.score - a.score
    || rankOf(a) - rankOf(b)
    || typePrior(b.entity.type) - typePrior(a.entity.type)
    || a.entity.label.localeCompare(b.entity.label)
    || a.entity.id.localeCompare(b.entity.id));

  // A confident top hit suppresses the long tail of weak partial matches.
  const top = ranked[0];
  const cutoff = top && top.score >= 0.9 ? Math.max(minScore, top.score - 0.28) : minScore;
  let out = ranked.filter((r) => r.score >= cutoff);
  if (opts.dedupe) {
    const byName = new Map<string, ResolvedEntity>();
    for (const r of out) {
      const key = `${r.entity.type}:${normalise(r.entity.label)}`;
      if (!byName.has(key)) byName.set(key, r);
    }
    out = [...byName.values()];
  }
  return out.slice(0, opts.limit ?? 8);
}

/** Object types named in the question — "open deals", "tickets", "invoices". */
/**
 * Object types `crm_records` actually holds. Everything else a question can name
 * — invoices, subscriptions, meters, entitlements, credits — lives in the ledger
 * of the module that owns it, and searching the CRM for one returns zero rows
 * every time.
 */
export const CRM_OBJECT_TYPES = new Set(['company', 'contact', 'deal', 'ticket', 'task', 'activity']);

export const isLedgerType = (type: string): boolean => !CRM_OBJECT_TYPES.has(type);

export function mentionedTypes(message: string): string[] {
  const text = normalise(message);
  const map: [RegExp, string][] = [
    [/\b(compan(?:y|ies)|accounts?|logos?)\b/, 'company'],
    [/\b(contacts?|people|persons?|leads?|champions?|buyers?)\b/, 'contact'],
    [/\b(deals?|opportunit(?:y|ies)|pipeline)\b/, 'deal'],
    [/\b(tickets?|cases?|issues?|escalations?)\b/, 'ticket'],
    [/\b(tasks?|to ?dos?)\b/, 'task'],
    [/\b(meetings?|calls?|emails?|notes?|activit(?:y|ies)|touch(?:es|points?)?)\b/, 'activity'],
    [/\b(invoices?|bills?|billing)\b/, 'invoice'],
    [/\b(subscriptions?|subscribed|subscribes?|plans?)\b/, 'subscription'],
    [/\b(products?|skus?|prices?|price\s+list|catalogue?)\b/, 'product'],
    [/\b(customers?|subscribers?)\b/, 'customer'],
    // The revenue half of the platform has nouns too, and a question that uses
    // one is a question about the module that owns it — not about a CRM object
    // type nothing writes, and not about bookings.
    [/\b(meters?|metering)\b/, 'meter'],
    [/\b(usage|consumption|consumed|ingested|telemetry\s+events?|events?\s+(?:used|ingested|sent))\b/, 'usage'],
    [/\b(entitlements?|allowances?|quotas?|seats?|feature\s+limits?|seat\s+limits?)\b/, 'entitlement'],
    [/\b(credits?|credit\s+grants?|credit\s+balance)\b/, 'credit'],
  ];
  const out: string[] = [];
  for (const [re, type] of map) if (re.test(text)) out.push(type);
  return [...new Set(out)];
}

/** Whether naive `LIKE %needle%` would have found this entity — used in tests. */
export const substringWouldMatch = (message: string, entity: EntityRef): boolean => {
  const haystack = normalise(message);
  const needle = normalise(entity.label);
  return !!needle && haystack.includes(needle);
};

export const acronymFor = acronymOf;
export const coreFor = coreName;
