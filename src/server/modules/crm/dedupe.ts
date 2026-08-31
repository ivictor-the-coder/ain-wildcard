import type { Ctx } from '../../kernel/context';
import { badRequest, conflict } from '../../../shared/errors';
import type { Crm } from './store';
import type { CrmRecord, PropertyValue, WriteOptions } from './types';
import { canonicalDigits, canonicalDomain, isEmptyValue } from './values';

/**
 * Duplicate detection and merging. Every CRM accumulates two records for the
 * same account within a month of going live; what separates a real product
 * from a demo is that merging keeps the history, moves the relationships and
 * leaves the old id resolvable so nothing 404s afterwards.
 */

export interface SimilarMatch {
  object: 'similar_record';
  record: CrmRecord;
  score: number;
  reasons: string[];
}

const LEGAL_SUFFIXES = /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|gmbh|corp|corporation|co|plc|s\.a|sa|ag|bv|nv|oy|ab|as|srl|spa|kk|pte|pty|holdings|group|company)\b/g;

const normaliseName = (value: string): string =>
  value.toLowerCase().replace(/[.,''`"()&/-]/g, ' ').replace(LEGAL_SUFFIXES, ' ').replace(/\s+/g, ' ').trim();

const tokens = (value: string): Set<string> => new Set(normaliseName(value).split(' ').filter((t) => t.length > 1));

const digits = (value: unknown): string => canonicalDigits(value).slice(-10);

const emailDomain = (value: unknown): string => {
  const at = String(value ?? '').indexOf('@');
  return at < 0 ? '' : String(value).slice(at + 1).toLowerCase();
};

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

const str = (value: PropertyValue | undefined): string => (isEmptyValue(value) ? '' : String(value));

/**
 * Candidate selection is the part that has to scale: comparing every record
 * against every other is quadratic. Records are blocked first on the signals a
 * duplicate actually shares — an identical domain, email or phone, or a
 * distinctive word from the name — and only that shortlist is scored.
 */
function candidates(ctx: Ctx, crm: Crm, orgId: string, record: CrmRecord): CrmRecord[] {
  const identityProperties = ['domain', 'email', 'phone', 'mobile_phone'];
  // The blocking query and the scorer have to compare the same string. When
  // they do not, the rule that exists to catch "www.andinaenvases.cl" versus
  // "andinaenvases.cl" is dead code for exactly the case it was written for.
  const identityValues = [...new Set([
    ...(canonicalDomain(record.properties.domain) ? [canonicalDomain(record.properties.domain), `www.${canonicalDomain(record.properties.domain)}`] : []),
    ...[str(record.properties.email).trim().toLowerCase()].filter(Boolean),
    ...['phone', 'mobile_phone'].map((name) => str(record.properties[name]).trim()).filter(Boolean),
  ])];
  const words = [...tokens(record.display_name)].sort((a, b) => b.length - a.length).slice(0, 3);

  const clauses: string[] = [];
  const params: unknown[] = [orgId, record.object_type, record.id];
  for (const word of words) {
    clauses.push(`r.search_blob LIKE ? ESCAPE '\\'`);
    params.push(`%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  if (identityValues.length) {
    clauses.push(
      `EXISTS (SELECT 1 FROM crm_record_values v WHERE v.record_id = r.id AND v.property IN (${identityProperties.map(() => '?').join(',')}) AND v.value_text IN (${identityValues.map(() => '?').join(',')}))`,
    );
    params.push(...identityProperties, ...identityValues);
  }
  if (!clauses.length) {
    return crm.search(orgId, record.object_type, { limit: 100, sort: [{ property: 'created', direction: 'desc' }] })
      .records.filter((c) => c.id !== record.id);
  }
  const rows = ctx.db.all<{ id: string }>(
    `SELECT r.id FROM crm_records r
      WHERE r.org_id = ? AND r.object_type = ? AND r.id <> ? AND r.archived = 0 AND r.merged_into IS NULL
        AND (${clauses.join(' OR ')})
      ORDER BY r.created DESC LIMIT 400`,
    ...(params as never[]),
  );
  return crm.getMany(orgId, rows.map((r) => r.id));
}

export function findSimilar(ctx: Ctx, crm: Crm, orgId: string, record: CrmRecord, limit = 5): SimilarMatch[] {
  const pool = candidates(ctx, crm, orgId, record);
  const matches: SimilarMatch[] = [];

  const selfTokens = tokens(record.display_name);
  const selfEmail = str(record.properties.email).toLowerCase();
  const selfDomain = canonicalDomain(record.properties.domain);
  const selfPhone = digits(record.properties.phone) || digits(record.properties.mobile_phone);
  const selfCompany = crm.associationsOf(orgId, record.id, { objectType: 'company', limit: 5 }).map((a) => a.record_id);

  for (const candidate of pool) {
    let score = 0;
    const reasons: string[] = [];

    const candDomain = canonicalDomain(candidate.properties.domain);
    if (selfDomain && candDomain && selfDomain === candDomain) { score += 70; reasons.push(`Same company domain (${candDomain})`); }

    const candEmail = str(candidate.properties.email).toLowerCase();
    if (selfEmail && candEmail && selfEmail === candEmail) { score += 80; reasons.push('Identical email address'); }
    else if (selfEmail && candEmail && emailDomain(selfEmail) && emailDomain(selfEmail) === emailDomain(candEmail)) {
      score += 12; reasons.push(`Both use @${emailDomain(candEmail)}`);
    }

    const candTokens = tokens(candidate.display_name);
    if (normaliseName(record.display_name) && normaliseName(record.display_name) === normaliseName(candidate.display_name)) {
      score += 55; reasons.push('Name matches once legal suffixes are ignored');
    } else {
      const overlap = jaccard(selfTokens, candTokens);
      if (overlap >= 0.5) { score += Math.round(overlap * 40); reasons.push(`Name is ${Math.round(overlap * 100)}% the same`); }
    }

    const candPhone = digits(candidate.properties.phone) || digits(candidate.properties.mobile_phone);
    if (selfPhone && candPhone && selfPhone === candPhone) { score += 30; reasons.push('Same phone number'); }

    if (selfCompany.length) {
      const candCompany = crm.associationsOf(orgId, candidate.id, { objectType: 'company', limit: 5 }).map((a) => a.record_id);
      if (candCompany.some((id) => selfCompany.includes(id))) { score += 15; reasons.push('Associated with the same company'); }
    }

    const city = str(record.properties.city);
    if (city && city === str(candidate.properties.city) && score > 0) { score += 5; reasons.push(`Both in ${city}`); }

    if (score >= 30) matches.push({ object: 'similar_record', record: candidate, score: Math.min(score, 100), reasons });
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}

export interface MergeResult {
  object: 'merge_result';
  winner: CrmRecord;
  merged_id: string;
  properties_filled: string[];
  associations_moved: number;
  activities_moved: number;
}

/** Fold `loserId` into `winnerId`, keeping every trace of what happened. */
export function mergeRecords(
  ctx: Ctx, crm: Crm, orgId: string, objectType: string, winnerId: string, loserId: string, opts: WriteOptions = {},
): MergeResult {
  if (winnerId === loserId) throw badRequest('merge_self', 'A record cannot be merged into itself.', 'from_id');
  const winner = crm.require(orgId, objectType, winnerId);
  const loser = crm.require(orgId, objectType, loserId);
  if (loser.merged_into) throw conflict('record_already_merged', `${loser.display_name} was already merged into ${loser.merged_into}.`);
  if (winner.merged_into) throw conflict('record_already_merged', `${winner.display_name} was itself merged into ${winner.merged_into}. Merge into that record instead.`);

  const index = crm.propertyIndex(orgId, objectType);
  const fill: Record<string, unknown> = {};
  const filled: string[] = [];

  for (const [name, prop] of index) {
    // Derived values are recomputed from the survivor's own associations after
    // the merge, so copying them across would both fail the read-only check and
    // stamp the loser's stale aggregate onto the winner.
    if (prop.calculated || prop.rollup) continue;
    const loserValue = loser.properties[name];
    if (isEmptyValue(loserValue)) continue;
    const winnerValue = winner.properties[name];

    if (name === 'activity_count') {
      fill[name] = Number(winnerValue ?? 0) + Number(loserValue ?? 0);
      filled.push(name);
      continue;
    }
    if (prop.type === 'datetime' && (name === 'last_activity_at' || name === 'last_contacted_at')) {
      if (Number(loserValue) > Number(winnerValue ?? 0)) { fill[name] = loserValue; filled.push(name); }
      continue;
    }
    if (prop.type === 'multi_enum') {
      const merged = [...new Set([...(Array.isArray(winnerValue) ? winnerValue : []), ...(loserValue as string[])])];
      if (merged.length !== (Array.isArray(winnerValue) ? winnerValue.length : 0)) { fill[name] = merged; filled.push(name); }
      continue;
    }
    if (isEmptyValue(winnerValue)) { fill[name] = loserValue; filled.push(name); }
  }

  const now = ctx.now();
  // Unique properties would collide while both records still hold them.
  for (const [name, prop] of index) {
    if (!prop.unique) continue;
    if (isEmptyValue(loser.properties[name])) continue;
    ctx.db.run(`DELETE FROM crm_record_values WHERE record_id = ? AND property = ?`, loser.id, name);
  }
  ctx.db.patch('crm_records', 'id', loser.id, {
    properties: JSON.stringify(Object.fromEntries(Object.entries(loser.properties).filter(([k]) => !index.get(k)?.unique))),
    archived: 1, merged_into: winner.id, updated: now, updated_by: opts.actorId ?? null,
  });

  if (filled.length) {
    crm.update(orgId, objectType, winner.id, fill, { ...opts, source: 'merge', history: true });
  }

  const edges = ctx.db.all<any>(`SELECT * FROM crm_associations WHERE org_id = ? AND (from_id = ? OR to_id = ?)`, orgId, loser.id, loser.id);
  let moved = 0;
  let activitiesMoved = 0;
  const activityTypes = crm.activityTypes(orgId);
  for (const edge of edges) {
    const nextFrom = edge.from_id === loser.id ? winner.id : edge.from_id;
    const nextTo = edge.to_id === loser.id ? winner.id : edge.to_id;
    if (nextFrom === nextTo) { ctx.db.run(`DELETE FROM crm_associations WHERE id = ?`, edge.id); continue; }
    const clash = ctx.db.get<{ id: string }>(
      `SELECT id FROM crm_associations WHERE org_id = ? AND association_type = ? AND from_id = ? AND to_id = ? AND id <> ?`,
      orgId, edge.association_type, nextFrom, nextTo, edge.id);
    if (clash) { ctx.db.run(`DELETE FROM crm_associations WHERE id = ?`, edge.id); continue; }
    ctx.db.run(
      `UPDATE crm_associations SET from_id = ?, to_id = ?, from_type = ?, to_type = ? WHERE id = ?`,
      nextFrom, nextTo, edge.from_id === loser.id ? winner.object_type : edge.from_type,
      edge.to_id === loser.id ? winner.object_type : edge.to_type, edge.id,
    );
    moved++;
    if (activityTypes.includes(edge.from_type) || activityTypes.includes(edge.to_type)) activitiesMoved++;
  }

  // The loser is archived and its edges now point at the winner, so both of
  // them and everything that was on the other end of a moved edge is holding a
  // number computed from a graph that no longer exists.
  crm.recomputeRollups(orgId, [
    winner.id, loser.id,
    ...edges.map((edge) => (edge.from_id === loser.id ? edge.to_id : edge.from_id) as string),
  ], opts);

  // Through the store, so the merge lands in the same totally-ordered audit
  // trail as everything else and pages with the same cursor.
  crm.recordHistory(
    orgId, objectType, winner.id, 'merged_from',
    null, `${loser.display_name} (${loser.id})`, now,
    { ...opts, source: 'merge' },
  );

  ctx.emit(orgId, `${objectType}.merged`, {
    winner_id: winner.id, merged_id: loser.id, display_name: winner.display_name,
    merged_display_name: loser.display_name, properties_filled: filled, associations_moved: moved,
  }, { objectId: winner.id, objectType, actorId: opts.actorId ?? null, actorType: opts.actorType ?? 'user' });

  return {
    object: 'merge_result',
    winner: crm.require(orgId, objectType, winner.id),
    merged_id: loser.id,
    properties_filled: filled,
    associations_moved: moved,
    activities_moved: activitiesMoved,
  };
}
