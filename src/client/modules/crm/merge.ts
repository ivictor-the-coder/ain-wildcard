/**
 * What a merge will do, worked out before the button is pressed.
 *
 * The server folds one record into another with a single POST and answers with
 * a count of blanks it filled. Two things make that not enough on a screen: the
 * decision moves associations between customers, so the person pressing Merge
 * has to see which values survive and which relationships move *first* — and
 * the server's count includes platform-maintained stamps that the survivor's
 * own state overwrites a moment later, so the sentence afterwards has to be
 * read off the record that came back, not off the count.
 *
 * The rules below mirror `mergeRecords` in the CRM module one for one.
 */
import type { AssociationSummary, CrmRecord, PropertyDef, PropertyValue } from './api';

export type MergeOutcome =
  /** Both hold a value; the survivor's stands and the duplicate's is lost. */
  | 'kept'
  /** The survivor was blank; the duplicate's value fills it. */
  | 'filled'
  /** A count that is added up, or a picklist whose choices are unioned. */
  | 'combined'
  /** A "last touched" stamp: whichever is more recent wins. */
  | 'newest'
  /** Maintained by the platform — recomputed from the survivor, never copied. */
  | 'locked';

export interface MergeRow {
  property: PropertyDef;
  winner: PropertyValue;
  loser: PropertyValue;
  outcome: MergeOutcome;
  /** What the survivor holds once the merge has run. */
  result: PropertyValue;
}

export interface MergeMove {
  edge: AssociationSummary;
  /** `moves` lands on the survivor; `already_linked` is dropped as a duplicate edge. */
  status: 'moves' | 'already_linked' | 'self';
}

export interface MergePlan {
  rows: MergeRow[];
  moves: MergeMove[];
  /** Set when each record has its own primary company and they differ. */
  companyConflict: { winner: AssociationSummary; loser: AssociationSummary } | null;
}

export const isEmptyValue = (value: unknown): boolean =>
  value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);

const same = (a: PropertyValue, b: PropertyValue): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const NEWEST_WINS = new Set(['last_activity_at', 'last_contacted_at']);

/** The company a record belongs to: its primary link, else its first. */
export function primaryCompany(record: Pick<CrmRecord, 'associations' | 'object_type'>): AssociationSummary | null {
  if (record.object_type === 'company') return null;
  const edges = (record.associations ?? []).filter(
    (edge) => edge.object_type === 'company' && edge.association_type !== 'activity_to_record',
  );
  return edges.find((edge) => edge.is_primary) ?? edges[0] ?? null;
}

export function planMerge(winner: CrmRecord, loser: CrmRecord, properties: PropertyDef[]): MergePlan {
  const rows: MergeRow[] = [];
  for (const property of properties) {
    if (property.calculated || property.rollup || property.hidden) continue;
    const loserValue = loser.properties[property.name] ?? null;
    if (isEmptyValue(loserValue)) continue;
    const winnerValue = winner.properties[property.name] ?? null;
    if (same(winnerValue, loserValue)) continue;

    if (property.name === 'activity_count') {
      const total = Number(winnerValue ?? 0) + Number(loserValue ?? 0);
      rows.push({ property, winner: winnerValue, loser: loserValue, outcome: 'combined', result: total });
      continue;
    }
    if (property.type === 'datetime' && NEWEST_WINS.has(property.name)) {
      const newer = Number(loserValue) > Number(winnerValue ?? 0);
      rows.push({ property, winner: winnerValue, loser: loserValue, outcome: newer ? 'newest' : 'kept', result: newer ? loserValue : winnerValue });
      continue;
    }
    if (property.type === 'multi_enum') {
      const mine = Array.isArray(winnerValue) ? winnerValue : [];
      const theirs = Array.isArray(loserValue) ? loserValue : [String(loserValue)];
      const union = [...new Set([...mine, ...theirs])];
      if (union.length === mine.length) continue;
      rows.push({ property, winner: winnerValue, loser: loserValue, outcome: 'combined', result: union });
      continue;
    }
    if (property.read_only) {
      // The server copies these and then re-derives them from the survivor's
      // own state — a closed duplicate's "Resolved" stamp does not survive on
      // a ticket that is still open. Counting it as filled is how the toast
      // came to claim three when one landed.
      rows.push({ property, winner: winnerValue, loser: loserValue, outcome: 'locked', result: winnerValue });
      continue;
    }
    if (isEmptyValue(winnerValue)) {
      rows.push({ property, winner: winnerValue, loser: loserValue, outcome: 'filled', result: loserValue });
      continue;
    }
    rows.push({ property, winner: winnerValue, loser: loserValue, outcome: 'kept', result: winnerValue });
  }

  const mine = new Set((winner.associations ?? []).map((edge) => `${edge.association_type}:${edge.direction}:${edge.record_id}`));
  const moves: MergeMove[] = (loser.associations ?? [])
    .filter((edge) => edge.association_type !== 'activity_to_record')
    .map((edge) => ({
      edge,
      status: edge.record_id === winner.id
        ? 'self'
        : mine.has(`${edge.association_type}:${edge.direction}:${edge.record_id}`) ? 'already_linked' : 'moves',
    }));

  const winnerCompany = primaryCompany(winner);
  const loserCompany = primaryCompany(loser);
  const companyConflict = winnerCompany && loserCompany && winnerCompany.record_id !== loserCompany.record_id
    ? { winner: winnerCompany, loser: loserCompany }
    : null;

  return { rows, moves, companyConflict };
}

/** Property names whose stored value differs between two reads of a record. */
export function changedProperties(before: CrmRecord, after: CrmRecord): string[] {
  const names = new Set([...Object.keys(before.properties), ...Object.keys(after.properties)]);
  return [...names].filter((name) => !same(before.properties[name] ?? null, after.properties[name] ?? null));
}

/**
 * The sentence after the merge, computed from what the survivor actually holds
 * now — never from the server's `properties_filled`, which counts stamps the
 * survivor's own state overwrote on the way through.
 */
export function describeMergeResult(before: CrmRecord, after: CrmRecord, associationsMoved: number): string {
  const changed = changedProperties(before, after).length;
  const properties = changed === 0
    ? 'No property changed'
    : `${changed} ${changed === 1 ? 'property' : 'properties'} changed`;
  const links = associationsMoved === 0
    ? 'no associations moved'
    : `${associationsMoved} ${associationsMoved === 1 ? 'association' : 'associations'} moved across`;
  return `${properties} and ${links}. The old id still resolves here.`;
}

/**
 * The scorer's reasons are written for companies. On a ticket "Name matches
 * once legal suffixes are ignored" is nonsense — the thing that matched was
 * the subject, and the reader should be told which.
 */
export function duplicateReason(reason: string, objectType: string, primaryLabel: string): string {
  const what = primaryLabel.toLowerCase();
  if (objectType === 'company') return reason;
  if (reason === 'Name matches once legal suffixes are ignored') return `Same ${what}`;
  const partial = /^Name is (\d+)% the same$/.exec(reason);
  if (partial) return `${primaryLabel} is ${partial[1]}% the same`;
  return reason;
}
