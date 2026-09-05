import { badRequest } from '../../../shared/errors';
import type {
  AggregateSpec, AssociationCondition, FilterGroup, FilterNode, FilterOperator, PropertyCondition,
  PropertyDef, PropertyRollup, RelativeUnit, SortSpec,
} from './types';
import { FILTER_OPERATORS } from './types';
import { MULTI_SEP, columnFor, resolveDate, shiftByUnit } from './values';

/**
 * The filter compiler. Lists, saved views, reports, workflow enrolment criteria,
 * segments and the AI tools all funnel through this one function, so a filter
 * means exactly the same thing wherever it is written.
 *
 * Two invariants matter more than anything else here:
 *   1. Nothing the caller supplies is ever interpolated into SQL. Property
 *      names are resolved against the schema and rejected if unknown; every
 *      value becomes a bound parameter. `'; DROP TABLE crm_records; --` is
 *      simply a string that matches no rows.
 *   2. Unset is a first-class state. `eq` never matches an unset property and
 *      the negative operators (`neq`, `not_in`, `not_contains`) do — they are
 *      the exact set complement of their positive twin, which is what people
 *      mean by "Country is not Germany" when half the book has no country.
 */

export type PropertyIndex = Map<string, PropertyDef>;

export interface AssociationTarget {
  objectTypes: string[];
  associationTypes: string[];
}

export interface CompileEnv {
  orgId: string;
  objectType: string;
  now: number;
  /** Properties of an object type, or a merged map for a category alias. */
  propertiesOf(objectType: string): PropertyIndex;
  /** Resolve `deal` / `deal_to_company` / `activity` / `any` into concrete edges. */
  resolveAssociation(fromObject: string, association: string): AssociationTarget;
}

export interface CompiledSql {
  sql: string;
  params: unknown[];
}

const MAX_DEPTH = 8;
const MAX_CONDITIONS = 80;

/** Emits a column reference, binding any parameters it needs at the point of use. */
type ColRef = () => string;

interface AggregateCompileOptions {
  /** Error `param` prefix — `filter` for a condition, `rollup` for a property. */
  param: string;
  /** Whether an empty far side reads as 0 rather than as nothing. */
  coalesceZero: boolean;
  /** What the caller's vocabulary calls the aggregated property. */
  propertyField: string;
}

/** Columns that live on `crm_records` itself rather than in the value index. */
interface BuiltinColumn { column: string; type: PropertyDef['type']; label: string }

const BUILTINS: Record<string, BuiltinColumn> = {
  id: { column: 'id', type: 'string', label: 'Record ID' },
  object_type: { column: 'object_type', type: 'string', label: 'Object type' },
  display_name: { column: 'display_name', type: 'string', label: 'Name' },
  owner_id: { column: 'owner_id', type: 'user', label: 'Owner' },
  source: { column: 'source', type: 'string', label: 'Created via' },
  archived: { column: 'archived', type: 'bool', label: 'Archived' },
  created: { column: 'created', type: 'datetime', label: 'Created' },
  created_at: { column: 'created', type: 'datetime', label: 'Created' },
  updated: { column: 'updated', type: 'datetime', label: 'Last modified' },
  updated_at: { column: 'updated', type: 'datetime', label: 'Last modified' },
  created_by: { column: 'created_by', type: 'user', label: 'Created by' },
  updated_by: { column: 'updated_by', type: 'user', label: 'Updated by' },
};

export const isBuiltinProperty = (name: string): boolean => name in BUILTINS;
/** The record fields that can be filtered and sorted without being properties. */
export const BUILTIN_PROPERTY_NAMES = Object.keys(BUILTINS);

const isGroup = (node: FilterNode): node is FilterGroup =>
  typeof (node as FilterGroup).op === 'string' && Array.isArray((node as FilterGroup).filters);
const isAssociation = (node: FilterNode): node is AssociationCondition =>
  typeof (node as AssociationCondition).association === 'string';

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Negative operators compile as `NOT EXISTS(positive)` so unset records match. */
const NEGATIVE: Partial<Record<FilterOperator, FilterOperator>> = {
  neq: 'eq', not_contains: 'contains', not_in: 'in', is_not_set: 'is_set',
};

class Compiler {
  readonly params: unknown[] = [];
  private aliasSeq = 0;
  private conditions = 0;

  constructor(private readonly env: CompileEnv) {}

  private alias(prefix: string): string { return `${prefix}${++this.aliasSeq}`; }

  private bind(value: unknown): string { this.params.push(value); return '?'; }

  /** Bind a value from outside the tree — the anchor id of a standalone aggregate. */
  bindValue(value: unknown): string { return this.bind(value); }

  node(node: FilterNode, alias: string, objectType: string, depth: number): string {
    if (!node || typeof node !== 'object') {
      throw badRequest('filter_invalid', 'A filter must be a condition object or an `{ op, filters }` group.', 'filter');
    }
    if (depth > MAX_DEPTH) throw badRequest('filter_too_deep', `Filter groups may not nest more than ${MAX_DEPTH} levels deep.`, 'filter');
    if (++this.conditions > MAX_CONDITIONS) throw badRequest('filter_too_large', `A filter may contain at most ${MAX_CONDITIONS} conditions.`, 'filter');

    if (isGroup(node)) {
      const op = node.op;
      if (op !== 'and' && op !== 'or' && op !== 'not') {
        throw badRequest('filter_group_invalid', `Filter group operator must be "and", "or" or "not" — received "${String(op)}".`, 'filter.op');
      }
      if (!node.filters.length) return op === 'or' ? '0 = 1' : '1 = 1';
      const parts = node.filters.map((child) => this.node(child, alias, objectType, depth + 1));
      if (op === 'not') return `NOT (${parts.join(' AND ')})`;
      return `(${parts.join(op === 'and' ? ' AND ' : ' OR ')})`;
    }
    if (isAssociation(node)) return this.association(node, alias, objectType, depth);
    return this.property(node, alias, objectType);
  }

  /* ------------------------------ properties ----------------------------- */

  private property(cond: PropertyCondition, alias: string, objectType: string): string {
    if (typeof cond.property !== 'string' || !cond.property) {
      throw badRequest('filter_property_missing', 'Every filter condition needs a `property`.', 'filter.property');
    }
    const operator = this.operator(cond.operator);
    const builtin = BUILTINS[cond.property];
    if (builtin) {
      const col = `${alias}.${builtin.column}`;
      return this.predicate(() => col, pseudoProperty(cond.property, builtin.type, builtin.label, objectType), operator, cond, alias, true);
    }

    const props = this.env.propertiesOf(objectType);
    const prop = props.get(cond.property);
    if (!prop) {
      throw badRequest('property_unknown', `"${cond.property}" is not a property of ${objectType}. ${suggestProperty(cond.property, props, objectType)}`, 'filter.property');
    }

    const negated = NEGATIVE[operator];
    const effective = negated ?? operator;
    const valueAlias = this.alias('v');
    const column = `${valueAlias}.${columnFor(prop.type)}`;

    // Bound before the predicate so parameters follow the SQL text exactly.
    const head = `EXISTS (SELECT 1 FROM crm_record_values ${valueAlias} WHERE ${valueAlias}.record_id = ${alias}.id AND ${valueAlias}.property = ${this.bind(prop.name)} AND `;
    const inner = this.predicate(() => column, prop, effective, cond, alias, false);
    const exists = `${head}${inner})`;
    return negated ? `NOT ${exists}` : exists;
  }

  private operator(op: FilterOperator): FilterOperator {
    if (!FILTER_OPERATORS.includes(op)) {
      throw badRequest('filter_operator_invalid', `"${String(op)}" is not a supported operator. Supported: ${FILTER_OPERATORS.join(', ')}.`, 'filter.operator');
    }
    return op;
  }

  private coerce(prop: PropertyDef, raw: unknown, param: string): string | number {
    switch (prop.type) {
      case 'date': case 'datetime': {
        const ts = resolveDate(raw, this.env.now);
        if (ts === null) throw badRequest('filter_value_invalid', `${prop.label} needs a date value — millis, ISO-8601 or a token like "start_of_quarter".`, param);
        return ts;
      }
      case 'number': case 'currency': {
        const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[, $€£]/g, ''));
        if (!Number.isFinite(n)) throw badRequest('filter_value_invalid', `${prop.label} needs a numeric value, received ${JSON.stringify(raw)}.`, param);
        return n;
      }
      case 'bool': {
        if (typeof raw === 'boolean') return raw ? 1 : 0;
        const s = String(raw).toLowerCase();
        if (['true', '1', 'yes'].includes(s)) return 1;
        if (['false', '0', 'no'].includes(s)) return 0;
        throw badRequest('filter_value_invalid', `${prop.label} needs true or false.`, param);
      }
      default:
        return String(raw);
    }
  }

  private valueList(cond: PropertyCondition | AssociationCondition, prop: PropertyDef, param: string): (string | number)[] {
    const raw = cond.values ?? (Array.isArray(cond.value) ? cond.value : cond.value === undefined ? [] : [cond.value]);
    if (!Array.isArray(raw) || raw.length === 0) {
      throw badRequest('filter_values_missing', `The "${cond.operator}" operator on ${prop.label} needs a non-empty \`values\` array.`, param);
    }
    if (raw.length > 500) throw badRequest('filter_values_too_many', 'At most 500 values may be listed in one condition.', param);
    return raw.map((r) => this.coerce(prop, r, param));
  }

  private requireValue(cond: PropertyCondition | AssociationCondition, prop: PropertyDef, param: string): unknown {
    if (cond.value === undefined || cond.value === null) {
      throw badRequest('filter_value_missing', `The "${cond.operator}" operator on ${prop.label} needs a \`value\`.`, param);
    }
    return cond.value;
  }

  /** One comparison against a column reference. */
  private predicate(
    col: ColRef,
    prop: PropertyDef,
    operator: FilterOperator,
    cond: PropertyCondition | AssociationCondition,
    recordAlias: string,
    nullableColumn: boolean,
  ): string {
    const param = 'filter.value';
    const multi = prop.type === 'multi_enum';
    const comparePropertyName = 'compare_property' in cond ? cond.compare_property : undefined;

    if (comparePropertyName) {
      const sqlOp = ({ eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as Record<string, string>)[operator];
      if (!sqlOp) throw badRequest('filter_operator_invalid', `"${operator}" cannot compare two properties.`, 'filter.operator');
      const left = col();
      return `${left} ${sqlOp} ${this.comparisonSubquery(comparePropertyName, recordAlias, prop)}`;
    }

    switch (operator) {
      case 'is_set':
        return nullableColumn ? `(${col()} IS NOT NULL AND ${col()} <> '')` : `${col()} IS NOT NULL`;
      case 'is_not_set':
        return nullableColumn ? `(${col()} IS NULL OR ${col()} = '')` : `${col()} IS NULL`;
      case 'eq': {
        const value = this.requireValue(cond, prop, param);
        if (multi) return `${col()} LIKE ${this.bind(`%${MULTI_SEP}${escapeLike(String(value))}${MULTI_SEP}%`)} ESCAPE '\\'`;
        return `${col()} = ${this.bind(this.coerce(prop, value, param))}`;
      }
      case 'neq': {
        const value = this.requireValue(cond, prop, param);
        if (multi) return `(${col()} IS NULL OR ${col()} NOT LIKE ${this.bind(`%${MULTI_SEP}${escapeLike(String(value))}${MULTI_SEP}%`)} ESCAPE '\\')`;
        return `(${col()} IS NULL OR ${col()} <> ${this.bind(this.coerce(prop, value, param))})`;
      }
      case 'gt': case 'gte': case 'lt': case 'lte': {
        const sqlOp = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[operator];
        return `${col()} ${sqlOp} ${this.bind(this.coerce(prop, this.requireValue(cond, prop, param), param))}`;
      }
      case 'before':
        return `${col()} < ${this.bind(this.coerce(prop, this.requireValue(cond, prop, param), param))}`;
      case 'after':
        return `${col()} > ${this.bind(this.coerce(prop, this.requireValue(cond, prop, param), param))}`;
      case 'contains': {
        const needle = escapeLike(String(this.requireValue(cond, prop, param)));
        return `${col()} LIKE ${this.bind(`%${needle}%`)} ESCAPE '\\'`;
      }
      case 'not_contains': {
        const needle = escapeLike(String(this.requireValue(cond, prop, param)));
        return `(${col()} IS NULL OR ${col()} NOT LIKE ${this.bind(`%${needle}%`)} ESCAPE '\\')`;
      }
      case 'starts_with':
        return `${col()} LIKE ${this.bind(`${escapeLike(String(this.requireValue(cond, prop, param)))}%`)} ESCAPE '\\'`;
      case 'ends_with':
        return `${col()} LIKE ${this.bind(`%${escapeLike(String(this.requireValue(cond, prop, param)))}`)} ESCAPE '\\'`;
      case 'in': {
        const list = this.valueList(cond, prop, param);
        if (multi) return `(${list.map((val) => `${col()} LIKE ${this.bind(`%${MULTI_SEP}${escapeLike(String(val))}${MULTI_SEP}%`)} ESCAPE '\\'`).join(' OR ')})`;
        return `${col()} IN (${list.map((val) => this.bind(val)).join(', ')})`;
      }
      case 'not_in': {
        const list = this.valueList(cond, prop, param);
        if (multi) return `(${list.map((val) => `(${col()} IS NULL OR ${col()} NOT LIKE ${this.bind(`%${MULTI_SEP}${escapeLike(String(val))}${MULTI_SEP}%`)} ESCAPE '\\')`).join(' AND ')})`;
        return `(${col()} IS NULL OR ${col()} NOT IN (${list.map((val) => this.bind(val)).join(', ')}))`;
      }
      case 'between': {
        const list = this.valueList(cond, prop, param);
        if (list.length !== 2) throw badRequest('filter_values_invalid', `"between" needs exactly two values on ${prop.label}.`, param);
        const [lo, hi] = list[0] <= list[1] ? list : [list[1], list[0]];
        return `(${col()} >= ${this.bind(lo)} AND ${col()} <= ${this.bind(hi)})`;
      }
      case 'within_last': case 'within_next': {
        const count = Number(this.requireValue(cond, prop, param));
        if (!Number.isFinite(count) || count < 0) {
          throw badRequest('filter_value_invalid', `"${operator}" needs a positive number of ${cond.unit ?? 'day'}s.`, param);
        }
        const bound = shiftByUnit(this.env.now, operator === 'within_last' ? -count : count, this.unit(cond.unit));
        const [lo, hi] = operator === 'within_last' ? [bound, this.env.now] : [this.env.now, bound];
        return `(${col()} >= ${this.bind(lo)} AND ${col()} <= ${this.bind(hi)})`;
      }
      default:
        throw badRequest('filter_operator_invalid', `"${operator}" is not supported here.`, 'filter.operator');
    }
  }

  private unit(unit: RelativeUnit | undefined): RelativeUnit {
    const allowed: RelativeUnit[] = ['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'];
    if (unit === undefined) return 'day';
    if (!allowed.includes(unit)) throw badRequest('filter_unit_invalid', `"${String(unit)}" is not a time unit. Use one of: ${allowed.join(', ')}.`, 'filter.unit');
    return unit;
  }

  private comparisonSubquery(propertyName: string, recordAlias: string, against: PropertyDef): string {
    if (BUILTINS[propertyName]) return `${recordAlias}.${BUILTINS[propertyName].column}`;
    const alias = this.alias('cp');
    return `(SELECT ${alias}.${columnFor(against.type)} FROM crm_record_values ${alias} WHERE ${alias}.record_id = ${recordAlias}.id AND ${alias}.property = ${this.bind(propertyName)})`;
  }

  /* ----------------------------- associations ---------------------------- */

  /**
   * The correlated aggregate itself: one scalar subquery over the records on
   * the other end of an association. A filter compares it, a rollup property
   * stores it, and both get it from here — which is why an account list
   * filtered on "open deals over $75k" and the `total_open_deal_value` column
   * beside it can never disagree.
   *
   * `anchor` is the parent record's id as SQL: `r.id` when the aggregate is
   * correlated against a row being scanned, a bound literal when one record is
   * being recomputed on its own.
   */
  aggregate(spec: AggregateSpec, anchor: ColRef, objectType: string, depth: number, opts: AggregateCompileOptions): {
    ref: ColRef; aggProp: PropertyDef | null; aggregate: string;
  } {
    const { param, coalesceZero, propertyField } = opts;
    const target = this.env.resolveAssociation(objectType, spec.association);
    if (!target.objectTypes.length && !target.associationTypes.length) {
      throw badRequest('association_unknown', `"${spec.association}" is neither an object type nor an association type reachable from ${objectType}.`, `${param}.association`);
    }
    const direction = spec.direction ?? 'both';
    if (!['outgoing', 'incoming', 'both'].includes(direction)) {
      throw badRequest('filter_direction_invalid', 'Association direction must be "outgoing", "incoming" or "both".', `${param}.direction`);
    }
    const aggregate = spec.aggregate ?? 'count';
    if (!['count', 'sum', 'avg', 'min', 'max'].includes(aggregate)) {
      throw badRequest('filter_aggregate_invalid', 'Aggregate must be one of: count, sum, avg, min, max.', `${param}.aggregate`);
    }
    const subType = target.objectTypes.length === 1 ? target.objectTypes[0] : spec.association;
    const subProps = this.env.propertiesOf(subType);
    const aggProp = aggregate === 'count' ? null : this.aggregateProperty(spec, subProps, subType, param, propertyField);

    // Rebuilt (and re-bound) on every use so operators that mention the column
    // twice — `between`, `neq` — stay parameter-correct.
    const ref: ColRef = () => {
      const edge = this.alias('a');
      const rec = this.alias('ar');
      // Every fragment is built in the order it appears in the SQL text,
      // because `anchor` may itself bind a parameter: a subquery assembled in
      // one order and bound in another is an aggregate over the wrong record.
      const other = direction === 'outgoing' ? `${edge}.to_id` : direction === 'incoming' ? `${edge}.from_id`
        : `CASE WHEN ${edge}.from_id = ${anchor()} THEN ${edge}.to_id ELSE ${edge}.from_id END`;

      let selectExpr = 'COUNT(*)';
      let valueJoin = '';
      if (aggProp) {
        const av = this.alias('av');
        valueJoin = ` LEFT JOIN crm_record_values ${av} ON ${av}.record_id = ${rec}.id AND ${av}.property = ${this.bind(aggProp.name)}`;
        const column = columnFor(aggProp.type) === 'value_text' ? 'value_number' : columnFor(aggProp.type);
        selectExpr = `${aggregate.toUpperCase()}(${av}.${column})`;
      }

      const clauses: string[] = [`${edge}.org_id = ${this.bind(this.env.orgId)}`];
      clauses.push(direction === 'outgoing' ? `${edge}.from_id = ${anchor()}`
        : direction === 'incoming' ? `${edge}.to_id = ${anchor()}`
        : `(${edge}.from_id = ${anchor()} OR ${edge}.to_id = ${anchor()})`);
      clauses.push(`${rec}.archived = 0`);
      if (target.associationTypes.length) {
        clauses.push(`${edge}.association_type IN (${target.associationTypes.map((t) => this.bind(t)).join(', ')})`);
      }
      if (target.objectTypes.length) {
        clauses.push(`${rec}.object_type IN (${target.objectTypes.map((t) => this.bind(t)).join(', ')})`);
      }
      if (spec.where) clauses.push(this.node(spec.where, rec, subType, depth + 1));

      const body = `SELECT ${coalesceZero ? `COALESCE(${selectExpr}, 0)` : selectExpr} FROM crm_associations ${edge} JOIN crm_records ${rec} ON ${rec}.id = ${other}${valueJoin} WHERE ${clauses.join(' AND ')}`;
      return `(${body})`;
    };
    return { ref, aggProp, aggregate };
  }

  private association(cond: AssociationCondition, alias: string, objectType: string, depth: number): string {
    // `COALESCE(…, 0)` on every aggregate, so "count = 0" and "sum < 100" both
    // match an account with no deals at all rather than dropping it.
    const { ref, aggProp, aggregate } = this.aggregate(cond, () => `${alias}.id`, objectType, depth, {
      param: 'filter', coalesceZero: true, propertyField: 'aggregate_property',
    });
    const operator = this.operator(cond.operator);
    if (operator === 'is_set') return `${ref()} > 0`;
    if (operator === 'is_not_set') return `${ref()} = 0`;
    const numeric = pseudoProperty(cond.association, aggProp && (aggProp.type === 'date' || aggProp.type === 'datetime') ? 'datetime' : 'number', `${cond.association} ${aggregate}`, objectType);
    return this.predicate(ref, numeric, operator, cond, alias, false);
  }

  private aggregateProperty(spec: AggregateSpec, props: PropertyIndex, subType: string, param: string, field: string): PropertyDef {
    if (!spec.aggregate_property) {
      throw badRequest('filter_aggregate_property_missing', `The "${spec.aggregate}" aggregate needs a \`${field}\` — which property of ${subType} to add up.`, `${param}.${field}`);
    }
    const prop = props.get(spec.aggregate_property);
    if (!prop) {
      throw badRequest('property_unknown', `"${spec.aggregate_property}" is not a property of ${subType}. ${suggestProperty(spec.aggregate_property, props, subType)}`, `${param}.${field}`);
    }
    return prop;
  }
}

function pseudoProperty(name: string, type: PropertyDef['type'], label: string, objectType: string): PropertyDef {
  return {
    org_id: '', object_type: objectType, name, id: name, label, description: null, type,
    group: 'System', options: [], reference_type: null, required: false, unique: false,
    read_only: true, system: true, hidden: false, default_value: null, validation: {},
    calculated: null, rollup: null, currency: null, normalize: 'none', position: 0, created: 0, updated: 0,
  };
}

/** "Did you mean …?" — the difference between a dead end and a fixed typo. */
export function suggestProperty(name: string, props: PropertyIndex, objectType: string): string {
  const target = name.toLowerCase();
  const close = [...props.keys()]
    .filter((k) => k.includes(target) || target.includes(k) || levenshtein(k, target) <= 2)
    .slice(0, 4);
  if (close.length) return `Did you mean ${close.map((c) => `"${c}"`).join(', ')}?`;
  return `Call GET /v1/objects/${objectType}/properties to list the available properties.`;
}

function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}

/** Compile a filter tree into a parameterised SQL predicate over alias `r`. */
export function compileFilter(filter: FilterNode | undefined, env: CompileEnv, alias = 'r'): CompiledSql {
  if (!filter) return { sql: '1 = 1', params: [] };
  const compiler = new Compiler(env);
  const sql = compiler.node(filter, alias, env.objectType, 0);
  return { sql, params: compiler.params };
}

/* -------------------------------- rollups --------------------------------- */

/** A rollup definition read as the aggregate the filter engine understands. */
export const rollupSpec = (rollup: PropertyRollup): AggregateSpec => ({
  association: rollup.association,
  direction: rollup.direction,
  where: rollup.filter,
  aggregate: rollup.aggregate,
  aggregate_property: rollup.property,
});

export interface CompiledAggregate extends CompiledSql {
  /** The aggregated property on the far side — null for `count`. */
  aggregateProperty: PropertyDef | null;
}

/**
 * One aggregate as a standalone scalar expression, for storing rather than
 * comparing. `anchor` names the parent: `{ alias }` correlates it against a row
 * the caller is already scanning, `{ recordId }` binds one record so the
 * expression can be selected on its own — including for a record that has not
 * been inserted yet, which is how a brand-new account starts life with zero
 * deals rather than with an empty column.
 *
 * `count` and `sum` come back as 0 when there is nothing on the other end,
 * because a company with no deals genuinely has none and is worth $0. `avg`,
 * `min` and `max` come back NULL: the average of nothing is not zero, and a
 * "most recent close date" of 1 January 1970 is worse than an empty cell.
 */
export function compileAggregate(
  spec: AggregateSpec, env: CompileEnv, anchor: { alias: string } | { recordId: string },
  names: { param: string; propertyField: string } = { param: 'rollup', propertyField: 'property' },
): CompiledAggregate {
  const compiler = new Compiler(env);
  const anchorRef: ColRef = 'alias' in anchor
    ? () => `${anchor.alias}.id`
    : () => compiler.bindValue(anchor.recordId);
  const { ref, aggProp } = compiler.aggregate(spec, anchorRef, env.objectType, 0, {
    param: names.param,
    propertyField: names.propertyField,
    coalesceZero: (spec.aggregate ?? 'count') === 'count' || spec.aggregate === 'sum',
  });
  return { sql: ref(), params: compiler.params, aggregateProperty: aggProp };
}

/**
 * Every property name a filter tree reads on the records it is applied to.
 * A rollup only has to be recomputed when a child write touched one of these,
 * so logging a call against a deal does not re-sum the account's pipeline.
 */
export function filterProperties(node: FilterNode | undefined): string[] {
  const names = new Set<string>();
  const walk = (n: FilterNode | undefined, depth: number): void => {
    if (!n || typeof n !== 'object' || depth > MAX_DEPTH) return;
    if (isGroup(n)) { for (const child of n.filters ?? []) walk(child, depth + 1); return; }
    if (isAssociation(n)) {
      // A nested association walks a further edge; its own aggregate property
      // belongs to that far object type, not to this one.
      if (n.aggregate_property) names.add(n.aggregate_property);
      return;
    }
    if (n.property) names.add(n.property);
    if (n.compare_property) names.add(n.compare_property);
  };
  walk(node, 0);
  return [...names];
}

/* --------------------------------- sorting -------------------------------- */

export interface CompiledSort {
  joins: string;
  orderBy: string;
  params: unknown[];
}

export function compileSort(sorts: SortSpec[] | undefined, env: CompileEnv, alias = 'r'): CompiledSort {
  const joins: string[] = [];
  const order: string[] = [];
  const params: unknown[] = [];
  const props = env.propertiesOf(env.objectType);

  (sorts ?? []).slice(0, 4).forEach((spec, i) => {
    if (!spec || typeof spec.property !== 'string') {
      throw badRequest('sort_invalid', 'Each sort entry needs a `property` and an optional `direction`.', 'sort');
    }
    const direction = spec.direction === 'asc' ? 'ASC' : 'DESC';
    const builtin = BUILTINS[spec.property];
    if (builtin) {
      order.push(`${alias}.${builtin.column} ${direction}`);
      return;
    }
    const prop = props.get(spec.property);
    if (!prop) {
      throw badRequest('property_unknown', `Cannot sort by "${spec.property}" — it is not a property of ${env.objectType}. ${suggestProperty(spec.property, props, env.objectType)}`, 'sort.property');
    }
    const sortAlias = `s${i}`;
    joins.push(`LEFT JOIN crm_record_values ${sortAlias} ON ${sortAlias}.record_id = ${alias}.id AND ${sortAlias}.property = ?`);
    params.push(prop.name);
    const column = columnFor(prop.type);
    // Empty properties always sink to the bottom, whichever way the column sorts.
    order.push(`(${sortAlias}.${column} IS NULL) ASC`);
    order.push(column === 'value_text' ? `${sortAlias}.${column} COLLATE NOCASE ${direction}` : `${sortAlias}.${column} ${direction}`);
  });

  order.push(`${alias}.created DESC`, `${alias}.id DESC`);
  return { joins: joins.join(' '), orderBy: order.join(', '), params };
}
