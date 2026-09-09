/**
 * The words a filter is read back in, kept apart from the controls that build
 * one so the sentence on the chip can be checked without a browser.
 *
 * The chip above the grid is the only place a person sees what a link or a
 * saved view actually asks for. "number of companies is greater than 0" over a
 * grid of five contacts was a sentence describing a different filter: the half
 * that said *which* company had been dropped on the floor.
 */
import {
  isAssociationCondition, isGroup,
  type AssociationCondition, type CrmSchema, type FilterNode, type FilterOperator, type PropertyCondition,
} from './api';

export const OPERATOR_LABEL: Record<FilterOperator, string> = {
  eq: 'is', neq: 'is not', gt: 'is greater than', gte: 'is at least', lt: 'is less than',
  lte: 'is at most', contains: 'contains', not_contains: 'does not contain',
  starts_with: 'starts with', ends_with: 'ends with', in: 'is any of', not_in: 'is none of',
  is_set: 'is known', is_not_set: 'is unknown', between: 'is between', before: 'is before',
  after: 'is after', within_last: 'is in the last', within_next: 'is in the next',
};

/** How an association condition names the far side: "companies", and one "company". */
export interface AssociationWords { plural: string; singular: string }

/**
 * A sub-filter of the shape "the far record is this one" — what a company's
 * "5 contacts" link compiles to. Read back off the tree so the chip can say
 * "linked to company Pemberton Auto Systems" rather than describing a count.
 */
export function identityWhere(where: FilterNode | undefined): string | null {
  if (!where) return null;
  const node = isGroup(where) && where.filters.length === 1 && where.op !== 'not' ? where.filters[0] : where;
  if (isGroup(node) || isAssociationCondition(node)) return null;
  const condition = node as PropertyCondition;
  if (condition.property !== 'id' || condition.operator !== 'eq') return null;
  return typeof condition.value === 'string' && condition.value ? condition.value : null;
}

/** Every record id an association condition's sub-filter points at, for naming. */
export function referencedRecordIds(node: FilterNode | null | undefined): { association: string; id: string }[] {
  if (!node) return [];
  if (isGroup(node)) return node.filters.flatMap(referencedRecordIds);
  if (!isAssociationCondition(node)) return [];
  const id = identityWhere(node.where);
  return id ? [{ association: node.association, id }] : [];
}

/**
 * The object type on the far side of an association condition, for the list
 * whose filter this is. `association` is either an object type name or an
 * association type name; a wildcard end has no one type to ask.
 */
export function farObjectType(association: string, objectType: string, schema: CrmSchema | undefined): string | null {
  if (!schema) return null;
  if (schema.object_types.some((t) => t.name === association)) return association;
  const link = schema.association_types.find((t) => t.name === association);
  if (!link) return null;
  const far = link.from_object === objectType ? link.to_object : link.from_object;
  return far === '*' ? null : far;
}

/** "At least one" is what the count condition says when it says nothing else. */
const atLeastOne = (node: AssociationCondition): boolean =>
  (!node.aggregate || node.aggregate === 'count')
  && ((node.operator === 'gt' && Number(node.value) === 0) || (node.operator === 'gte' && Number(node.value) === 1));

/**
 * One association condition in English, both halves included.
 *
 *   linked to company Pemberton Auto Systems
 *   number of deals where Status is Open is greater than 0
 *   sum of Amount across deals linked to company Pemberton Auto Systems is at least 75000
 *
 * `describeWhere` renders a nested sub-filter in the caller's vocabulary; the
 * far side's own properties are the caller's to know.
 */
export function describeAssociationCondition(
  node: AssociationCondition,
  words: AssociationWords,
  names: Map<string, string> | undefined,
  describeWhere: (where: FilterNode) => string,
  measured: (property: string) => string,
): string {
  const what = node.aggregate && node.aggregate !== 'count'
    ? `${node.aggregate} of ${measured(node.aggregate_property ?? 'value')} across ${words.plural}`
    : `number of ${words.plural}`;
  const identity = identityWhere(node.where);
  if (identity) {
    const linked = `linked to ${words.singular} ${names?.get(identity) ?? identity}`;
    return atLeastOne(node) ? linked : `${what} ${linked} ${OPERATOR_LABEL[node.operator]} ${String(node.value ?? '')}`;
  }
  const where = node.where ? ` where ${describeWhere(node.where)}` : '';
  return `${what}${where} ${OPERATOR_LABEL[node.operator]} ${String(node.value ?? '')}`;
}
