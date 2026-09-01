/**
 * The filter builder.
 *
 * The engine behind `POST /v1/records/:type/search` takes nested and/or/not
 * groups, nineteen operators, relative date tokens and correlated aggregates
 * over associations — "accounts whose open deals total more than $75,000".
 * None of that is worth anything if the only way to reach it is curl, so this
 * is the whole grammar, expressed as controls.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, Button, Combobox, DatePicker, Icons, IconButton, Input, Inline, MoneyInput, NumberInput,
  Select, Tooltip, humanize, parseMoneyInput, useFormat, type ComboOption,
} from '@/client/design';
import { useQuery } from '@/client/kernel/api';
import { useSession } from '@/client/kernel/session';
import {
  isAssociationCondition, isGroup,
  type AssociationCondition, type CrmSchema, type FilterNode, type FilterOperator, type PropertyDef,
  type PropertyCondition, type RelativeUnit, type WorkspaceUser,
} from './api';

/* ------------------------------ record fields ----------------------------- */

/** Columns every record has, exposed to the builder as pseudo-properties. */
export const RECORD_FIELDS: PropertyDef[] = ([
  ['id', 'Record ID', 'string'],
  ['display_name', 'Name', 'string'],
  ['owner_id', 'Owner', 'user'],
  ['source', 'Created via', 'string'],
  ['archived', 'Archived', 'bool'],
  ['created', 'Created', 'datetime'],
  ['updated', 'Last modified', 'datetime'],
  ['created_by', 'Created by', 'user'],
  ['updated_by', 'Updated by', 'user'],
] as const).map(([name, label, type], index) => ({
  object_type: '', name, id: `field_${name}`, label, description: null,
  type, group: 'Record', options: [], reference_type: null, required: false, unique: false,
  read_only: true, system: true, hidden: false, default_value: null, calculated: null, rollup: null,
  currency: null, position: index,
}));

export const filterableProperties = (properties: PropertyDef[]): PropertyDef[] =>
  [...properties.filter((p) => !p.hidden), ...RECORD_FIELDS];

/* -------------------------------- operators ------------------------------- */

export const OPERATOR_LABEL: Record<FilterOperator, string> = {
  eq: 'is', neq: 'is not', gt: 'is greater than', gte: 'is at least', lt: 'is less than',
  lte: 'is at most', contains: 'contains', not_contains: 'does not contain',
  starts_with: 'starts with', ends_with: 'ends with', in: 'is any of', not_in: 'is none of',
  is_set: 'is known', is_not_set: 'is unknown', between: 'is between', before: 'is before',
  after: 'is after', within_last: 'is in the last', within_next: 'is in the next',
};

const TEXTUAL: FilterOperator[] = ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'ends_with', 'in', 'not_in', 'is_set', 'is_not_set'];
const NUMERIC: FilterOperator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'not_in', 'is_set', 'is_not_set'];
const TEMPORAL: FilterOperator[] = ['eq', 'before', 'after', 'between', 'within_last', 'within_next', 'is_set', 'is_not_set'];
const CATEGORICAL: FilterOperator[] = ['eq', 'neq', 'in', 'not_in', 'is_set', 'is_not_set'];
const BOOLEAN: FilterOperator[] = ['eq', 'neq', 'is_set', 'is_not_set'];

export function operatorsFor(type: PropertyDef['type']): FilterOperator[] {
  switch (type) {
    case 'number': case 'currency': return NUMERIC;
    case 'date': case 'datetime': return TEMPORAL;
    case 'bool': return BOOLEAN;
    case 'enum': case 'multi_enum': case 'user': case 'reference': return CATEGORICAL;
    default: return TEXTUAL;
  }
}

const needsNoValue = (operator: FilterOperator) => operator === 'is_set' || operator === 'is_not_set';
const needsTwoValues = (operator: FilterOperator) => operator === 'between';
const needsManyValues = (operator: FilterOperator) => operator === 'in' || operator === 'not_in';
const needsDuration = (operator: FilterOperator) => operator === 'within_last' || operator === 'within_next';

const UNITS: RelativeUnit[] = ['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'];

/** "in the last N days" is a plain count, with no property of its own. */
const DURATION_MEASURE: PropertyDef = {
  object_type: '', name: '__duration', id: 'field___duration', label: 'How many', description: null,
  type: 'number', group: 'Record', options: [], reference_type: null, required: false, unique: false,
  read_only: true, system: true, hidden: false, default_value: null, calculated: null, rollup: null,
  currency: null, position: 0,
};

/* ------------------------------ node factories ---------------------------- */

export const conditionFor = (property: PropertyDef): PropertyCondition => ({
  property: property.name,
  operator: operatorsFor(property.type)[0],
  value: '',
});

export const emptyAssociation = (association: string): AssociationCondition => ({
  association, aggregate: 'count', operator: 'gt', value: 0,
});

/** A tree with no conditions in it matches everything — send nothing instead. */
export function pruneFilter(node: FilterNode | null | undefined): FilterNode | undefined {
  if (!node) return undefined;
  if (!isGroup(node)) {
    if (isAssociationCondition(node)) return node;
    const condition = node as PropertyCondition;
    if (needsNoValue(condition.operator)) return condition;
    if (needsManyValues(condition.operator) || needsTwoValues(condition.operator)) {
      return (condition.values ?? []).length ? condition : undefined;
    }
    return condition.value === '' || condition.value === null || condition.value === undefined ? undefined : condition;
  }
  const filters = node.filters.map(pruneFilter).filter((child): child is FilterNode => !!child);
  if (!filters.length) return undefined;
  if (node.op !== 'not' && filters.length === 1 && isGroup(filters[0])) return filters[0];
  return { op: node.op, filters };
}

export function countConditions(node: FilterNode | null | undefined): number {
  if (!node) return 0;
  if (!isGroup(node)) return 1;
  return node.filters.reduce((n, child) => n + countConditions(child), 0);
}

/* --------------------------------- values --------------------------------- */

const RELATIVE_TOKENS = [
  'today', 'yesterday', 'tomorrow', 'start_of_week', 'end_of_week', 'start_of_month',
  'end_of_month', 'start_of_quarter', 'end_of_quarter', 'start_of_year', 'end_of_year',
  '-7d', '-30d', '-90d', '+30d',
];

const isRelativeToken = (value: unknown): boolean =>
  typeof value === 'string' && (RELATIVE_TOKENS.includes(value) || /^[+-]\d+(d|w|mo|m|y|h|q)$/i.test(value));

const toNumberOrNull = (raw: unknown): number | null =>
  raw === '' || raw === null || raw === undefined || !Number.isFinite(Number(raw)) ? null : Number(raw);

/**
 * A number or money box whose value reaches the filter *as it is typed*.
 *
 * `NumberInput` and `MoneyInput` report on blur and on Enter, which left the
 * modal's "Show 48 companies" button quoting the count for the filter before
 * the one on screen — wrong by 35 records at the moment somebody commits to it.
 * Every keystroke is published instead, exactly as the text and picklist
 * controls already do. The control keeps its own text — the committed value is
 * fed back only when the condition is replaced from outside — so publishing
 * cannot reformat a half-typed number under the caret.
 */
function NumericValue({ property, value, onChange, label }: {
  property: PropertyDef;
  value: unknown;
  onChange: (next: unknown) => void;
  label: string;
}) {
  const session = useSession();
  const money = property.type === 'currency';
  const currency = property.currency ?? session.currency;

  const [pinned, setPinned] = useState<number | null>(() => toNumberOrNull(value));
  const sent = useRef<number | null>(toNumberOrNull(value));

  useEffect(() => {
    const next = toNumberOrNull(value);
    if (next !== sent.current) { sent.current = next; setPinned(next); }
  }, [value]);

  /** Blur, Enter and the steppers: the control's own commit, taken verbatim. */
  const settle = (next: number | null) => {
    sent.current = next;
    setPinned(next);
    onChange(next === null ? '' : next);
  };

  const live = (raw: string) => {
    const text = raw.trim();
    let next: number | null = null;
    if (text) {
      if (money) next = parseMoneyInput(text, currency)?.amount ?? null;
      else {
        const parsed = Number(text.replace(/[^0-9.\-]/g, ''));
        next = Number.isFinite(parsed) ? parsed : null;
      }
    }
    if (next === sent.current) return;
    sent.current = next;
    onChange(next === null ? '' : next);
  };

  return money ? (
    <MoneyInput
      value={pinned}
      onChange={settle}
      onInput={(e) => live(e.currentTarget.value)}
      currency={currency}
      locale={session.locale}
      aria-label={label}
    />
  ) : (
    <NumberInput
      value={pinned}
      onChange={settle}
      onInput={(e) => live(e.currentTarget.value)}
      aria-label={label}
    />
  );
}

function ValueControl({ property, value, onChange, users, label }: {
  property: PropertyDef;
  value: unknown;
  onChange: (next: unknown) => void;
  users: WorkspaceUser[];
  label: string;
}) {
  const [relative, setRelative] = useState(() => isRelativeToken(value));

  if (property.type === 'currency' || property.type === 'number') {
    return <NumericValue property={property} value={value} onChange={onChange} label={label} />;
  }
  if (property.type === 'bool') {
    return (
      <Select
        value={value === true || value === 'true' ? 'true' : value === false || value === 'false' ? 'false' : ''}
        onChange={(next) => onChange(next === '' ? '' : next === 'true')}
        options={[{ value: '', label: 'Choose…' }, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]}
        aria-label={label}
      />
    );
  }
  if (property.type === 'date' || property.type === 'datetime') {
    return (
      <div className="crm-filter__date">
        {relative ? (
          <Combobox
            value={typeof value === 'string' ? value : ''}
            onChange={(next) => onChange(next)}
            options={RELATIVE_TOKENS.map((token) => ({ value: token, label: humanize(token) }))}
            onCreate={(raw) => onChange(raw.trim())}
            createLabel={(q) => `Use “${q}” as an offset`}
            placeholder="Pick a moment"
            aria-label={`${label} — relative`}
          />
        ) : (
          <DatePicker
            value={typeof value === 'number' ? value : null}
            onChange={(ts) => onChange(ts ?? '')}
            aria-label={label}
          />
        )}
        <Tooltip content={relative ? 'Switch to a fixed date' : 'Switch to a moving date such as “start of quarter”'}>
          <IconButton
            size="sm"
            label={relative ? 'Use a fixed date' : 'Use a relative date'}
            icon={relative ? <Icons.calendar size={14} /> : <Icons.repeat size={14} />}
            onClick={() => { setRelative((v) => !v); onChange(''); }}
          />
        </Tooltip>
      </div>
    );
  }
  if (property.type === 'user') {
    return (
      <Combobox
        value={typeof value === 'string' ? value : ''}
        onChange={(next) => onChange(next)}
        options={users.map((u) => ({ value: u.id, label: u.name, description: u.title ?? u.email }))}
        placeholder="Choose a teammate"
        aria-label={label}
      />
    );
  }
  if ((property.type === 'enum' || property.type === 'multi_enum') && property.options.length) {
    return (
      <Combobox
        value={typeof value === 'string' ? value : ''}
        onChange={(next) => onChange(next)}
        options={property.options.map((o) => ({ value: o.value, label: o.label }))}
        placeholder="Choose a value"
        aria-label={label}
      />
    );
  }
  return (
    <Input
      value={value === null || value === undefined ? '' : String(value)}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Value"
      aria-label={label}
    />
  );
}

function MultiValueControl({ property, values, onChange, users, label }: {
  property: PropertyDef;
  values: unknown[];
  onChange: (next: unknown[]) => void;
  users: WorkspaceUser[];
  label: string;
}) {
  const options = useMemo<ComboOption[]>(() => {
    if (property.type === 'user') return users.map((u) => ({ value: u.id, label: u.name }));
    return property.options.map((o) => ({ value: o.value, label: o.label }));
  }, [property, users]);

  if (options.length) {
    return (
      <Combobox
        multiple
        value={values.map(String)}
        onChange={(next) => onChange(next as unknown as string[])}
        options={options}
        placeholder="Choose values"
        aria-label={label}
      />
    );
  }
  return (
    <Combobox
      multiple
      value={values.map(String)}
      onChange={(next) => onChange(next as unknown as string[])}
      options={values.map((v) => ({ value: String(v), label: String(v) }))}
      onCreate={(raw) => onChange([...values, raw.trim()])}
      createLabel={(q) => `Add “${q}”`}
      placeholder="Type a value and press Enter"
      emptyMessage="Type to add a value"
      aria-label={label}
    />
  );
}

/* ------------------------------ condition row ----------------------------- */

interface Ctx {
  objectType: string;
  properties: PropertyDef[];
  schema: CrmSchema | undefined;
  users: WorkspaceUser[];
}

function propertyOptions(properties: PropertyDef[]): ComboOption[] {
  return properties.map((p) => ({
    value: p.name,
    label: p.label,
    group: p.group || 'Properties',
    description: p.rollup ? 'Rollup' : p.calculated ? 'Calculated' : undefined,
  }));
}

function ConditionRow({ node, onChange, onRemove, ctx }: {
  node: PropertyCondition;
  onChange: (next: PropertyCondition) => void;
  onRemove: () => void;
  ctx: Ctx;
}) {
  const property = ctx.properties.find((p) => p.name === node.property) ?? ctx.properties[0];
  const operators = operatorsFor(property?.type ?? 'string');
  const operator = operators.includes(node.operator) ? node.operator : operators[0];
  const values = node.values ?? (node.value !== undefined && node.value !== '' ? [node.value] : []);

  return (
    <div className="crm-filter__row" role="group" aria-label={`Condition on ${property?.label ?? node.property}`}>
      <div className="crm-filter__field">
        <Combobox
          value={node.property}
          onChange={(next) => {
            const chosen = ctx.properties.find((p) => p.name === next);
            const allowed = operatorsFor(chosen?.type ?? 'string');
            onChange({
              property: String(next),
              operator: allowed.includes(operator) ? operator : allowed[0],
              value: '',
            });
          }}
          options={propertyOptions(ctx.properties)}
          placeholder="Choose a property"
          aria-label="Property"
        />
      </div>
      <div className="crm-filter__op">
        <Select
          value={operator}
          onChange={(next) => {
            const nextOp = next as FilterOperator;
            const carry: PropertyCondition = { property: node.property, operator: nextOp };
            if (needsManyValues(nextOp) || needsTwoValues(nextOp)) carry.values = values;
            else if (!needsNoValue(nextOp)) carry.value = needsDuration(nextOp) ? Number(node.value) || 30 : node.value ?? '';
            if (needsDuration(nextOp)) carry.unit = node.unit ?? 'day';
            onChange(carry);
          }}
          options={operators.map((op) => ({ value: op, label: OPERATOR_LABEL[op] }))}
          aria-label="Operator"
        />
      </div>
      <div className="crm-filter__value">
        {needsNoValue(operator) && <span className="crm-muted crm-filter__novalue">no value needed</span>}
        {needsDuration(operator) && (
          <div className="crm-filter__duration">
            <NumericValue
              property={DURATION_MEASURE}
              value={typeof node.value === 'number' ? node.value : Number(node.value) || ''}
              onChange={(n) => onChange({ ...node, operator, value: Number(n) || 0 })}
              label="How many"
            />
            <Select
              value={node.unit ?? 'day'}
              onChange={(next) => onChange({ ...node, operator, unit: next as RelativeUnit })}
              options={UNITS.map((u) => ({ value: u, label: `${u}s` }))}
              aria-label="Unit"
            />
          </div>
        )}
        {needsManyValues(operator) && property && (
          <MultiValueControl
            property={property}
            values={values}
            onChange={(next) => onChange({ property: node.property, operator, values: next })}
            users={ctx.users}
            label={`${property.label} values`}
          />
        )}
        {needsTwoValues(operator) && property && (
          <div className="crm-filter__between">
            <ValueControl
              property={property}
              value={values[0] ?? ''}
              onChange={(next) => onChange({ property: node.property, operator, values: [next, values[1] ?? ''] })}
              users={ctx.users}
              label={`${property.label} lower bound`}
            />
            <span className="crm-muted">and</span>
            <ValueControl
              property={property}
              value={values[1] ?? ''}
              onChange={(next) => onChange({ property: node.property, operator, values: [values[0] ?? '', next] })}
              users={ctx.users}
              label={`${property.label} upper bound`}
            />
          </div>
        )}
        {!needsNoValue(operator) && !needsDuration(operator) && !needsManyValues(operator) && !needsTwoValues(operator) && property && (
          <ValueControl
            property={property}
            value={node.value ?? ''}
            onChange={(next) => onChange({ property: node.property, operator, value: next })}
            users={ctx.users}
            label={`${property.label} value`}
          />
        )}
      </div>
      <IconButton size="sm" label="Remove this condition" icon={<Icons.x size={14} />} onClick={onRemove} />
    </div>
  );
}

/* ---------------------------- association row ----------------------------- */

const AGGREGATES = [
  { value: 'count', label: 'how many' },
  { value: 'sum', label: 'total of' },
  { value: 'avg', label: 'average of' },
  { value: 'min', label: 'smallest' },
  { value: 'max', label: 'largest' },
];

function AssociationRow({ node, onChange, onRemove, ctx, depth }: {
  node: AssociationCondition;
  onChange: (next: AssociationCondition) => void;
  onRemove: () => void;
  ctx: Ctx;
  depth: number;
}) {
  const [openWhere, setOpenWhere] = useState(!!node.where);
  const targets = useMemo<ComboOption[]>(() => {
    const types = (ctx.schema?.object_types ?? []).map((t) => ({ value: t.name, label: t.plural_label, group: 'Object types' }));
    const links = (ctx.schema?.association_types ?? [])
      .filter((a) => a.from_object === ctx.objectType || a.to_object === ctx.objectType || a.from_object === '*')
      .map((a) => ({ value: a.name, label: `${a.label} / ${a.inverse_label}`, group: 'Association types', description: a.name }));
    return [...types, ...links];
  }, [ctx.schema, ctx.objectType]);

  const targetType = ctx.schema?.object_types.find((t) => t.name === node.association)?.name
    ?? ctx.schema?.association_types.find((a) => a.name === node.association)?.to_object
    ?? null;
  const { properties: targetProperties } = useTargetProperties(targetType);
  const aggregate = node.aggregate ?? 'count';
  const aggregateProperty = targetProperties.find((p) => p.name === node.aggregate_property);
  const measure: PropertyDef = aggregate === 'count'
    ? { ...RECORD_FIELDS[0], name: '__count', label: 'Count', type: 'number' }
    : aggregateProperty ?? { ...RECORD_FIELDS[0], name: '__value', label: 'Value', type: 'number' };
  const operators = operatorsFor(measure.type);
  const operator = operators.includes(node.operator) ? node.operator : 'gt';

  return (
    <div className="crm-filter__assoc" role="group" aria-label="Condition on associated records">
      <div className="crm-filter__row">
        <Badge tone="purple" size="sm" icon={<Icons.link size={11} />}>Associated</Badge>
        <div className="crm-filter__field">
          <Select
            value={aggregate}
            onChange={(next) => onChange({ ...node, aggregate: next as AssociationCondition['aggregate'] })}
            options={AGGREGATES}
            aria-label="Aggregate"
          />
        </div>
        {aggregate !== 'count' && (
          <div className="crm-filter__field">
            <Combobox
              value={node.aggregate_property ?? ''}
              onChange={(next) => onChange({ ...node, aggregate_property: String(next) })}
              options={targetProperties
                .filter((p) => p.type === 'number' || p.type === 'currency' || p.type === 'date' || p.type === 'datetime')
                .map((p) => ({ value: p.name, label: p.label, group: p.group }))}
              placeholder="Which number?"
              aria-label="Property to aggregate"
            />
          </div>
        )}
        <div className="crm-filter__field">
          <Combobox
            value={node.association}
            onChange={(next) => onChange({ ...node, association: String(next), aggregate_property: undefined, where: undefined })}
            options={targets}
            placeholder="Related records"
            aria-label="Association"
          />
        </div>
        <div className="crm-filter__op">
          <Select
            value={operator}
            onChange={(next) => onChange({ ...node, operator: next as FilterOperator })}
            options={operators.map((op) => ({ value: op, label: OPERATOR_LABEL[op] }))}
            aria-label="Operator"
          />
        </div>
        <div className="crm-filter__value">
          {!needsNoValue(operator) && (
            <ValueControl
              property={measure}
              value={node.value ?? ''}
              onChange={(next) => onChange({ ...node, value: next })}
              users={ctx.users}
              label="Threshold"
            />
          )}
        </div>
        <IconButton size="sm" label="Remove this condition" icon={<Icons.x size={14} />} onClick={onRemove} />
      </div>
      <div className="crm-filter__assocfoot">
        <Select
          size="sm"
          value={node.direction ?? 'both'}
          onChange={(next) => onChange({ ...node, direction: next as AssociationCondition['direction'] })}
          options={[
            { value: 'both', label: 'Either direction' },
            { value: 'outgoing', label: 'Records this one points at' },
            { value: 'incoming', label: 'Records pointing at this one' },
          ]}
          aria-label="Association direction"
        />
        <Button
          size="sm"
          variant="ghost"
          iconLeft={<Icons.filter size={13} />}
          onClick={() => {
            const next = !openWhere;
            setOpenWhere(next);
            if (!next) onChange({ ...node, where: undefined });
            else if (!node.where) onChange({ ...node, where: { op: 'and', filters: [] } });
          }}
        >
          {openWhere ? 'Remove the narrowing filter' : 'Only count some of them…'}
        </Button>
      </div>
      {openWhere && targetType && (
        <div className="crm-filter__nested">
          <GroupEditor
            node={node.where && isGroup(node.where) ? node.where : { op: 'and', filters: [] }}
            onChange={(next) => onChange({ ...node, where: next })}
            onRemove={() => { setOpenWhere(false); onChange({ ...node, where: undefined }); }}
            depth={depth + 1}
            ctx={{ ...ctx, objectType: targetType, properties: filterableProperties(targetProperties) }}
            heading={`Only ${targetType}s that match`}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The far side of an association has its own schema. It is fetched lazily,
 * because a filter that never opens an association condition should not pay
 * for every object type in the workspace.
 */
function useTargetProperties(objectType: string | null): { properties: PropertyDef[] } {
  const { data } = useQuery<{ data: PropertyDef[] }>(objectType ? `/v1/objects/${objectType}/properties` : null);
  return { properties: data?.data ?? [] };
}

/* -------------------------------- the group ------------------------------- */

const GROUP_LABEL: Record<'and' | 'or' | 'not', string> = {
  and: 'all', or: 'any', not: 'none',
};

function GroupEditor({ node, onChange, onRemove, depth, ctx, heading }: {
  node: { op: 'and' | 'or' | 'not'; filters: FilterNode[] };
  onChange: (next: { op: 'and' | 'or' | 'not'; filters: FilterNode[] }) => void;
  onRemove?: () => void;
  depth: number;
  ctx: Ctx;
  heading?: string;
}) {
  const replace = (index: number, next: FilterNode) =>
    onChange({ ...node, filters: node.filters.map((child, i) => (i === index ? next : child)) });
  const remove = (index: number) =>
    onChange({ ...node, filters: node.filters.filter((_, i) => i !== index) });

  // Default to the object on the *other* end of a real link — "how many deals",
  // not "how many company_to_company records", which is the same question asked
  // in the schema's vocabulary instead of the operator's.
  const firstAssociation = ctx.schema?.association_types
    .map((a) => (a.from_object === ctx.objectType ? a.to_object : a.to_object === ctx.objectType ? a.from_object : null))
    .find((other): other is string => !!other && other !== ctx.objectType && other !== '*')
    ?? ctx.schema?.object_types.find((t) => t.name !== ctx.objectType)?.name
    ?? 'deal';

  return (
    <div className={`crm-filter__group crm-filter__group--d${Math.min(depth, 3)}`}>
      <div className="crm-filter__grouphead">
        <span className="crm-filter__match">{heading ?? 'Match'}</span>
        <Select
          size="sm"
          value={node.op}
          onChange={(next) => onChange({ ...node, op: next as 'and' | 'or' | 'not' })}
          options={[
            { value: 'and', label: GROUP_LABEL.and },
            { value: 'or', label: GROUP_LABEL.or },
            { value: 'not', label: GROUP_LABEL.not },
          ]}
          aria-label="How the conditions in this group combine"
        />
        <span className="crm-filter__match">of the following</span>
        <span className="u-spacer" />
        {onRemove && (
          <IconButton size="sm" label="Remove this group" icon={<Icons.trash size={14} />} onClick={onRemove} />
        )}
      </div>

      {node.filters.length === 0 && (
        <p className="crm-filter__hint">
          Nothing here yet — every {ctx.objectType} matches until a condition is added.
        </p>
      )}

      <div className="crm-filter__rows">
        {node.filters.map((child, index) => {
          if (isGroup(child)) {
            return (
              <GroupEditor
                key={index}
                node={child}
                onChange={(next) => replace(index, next)}
                onRemove={() => remove(index)}
                depth={depth + 1}
                ctx={ctx}
              />
            );
          }
          if (isAssociationCondition(child)) {
            return (
              <AssociationRow
                key={index}
                node={child}
                onChange={(next) => replace(index, next)}
                onRemove={() => remove(index)}
                ctx={ctx}
                depth={depth}
              />
            );
          }
          return (
            <ConditionRow
              key={index}
              node={child}
              onChange={(next) => replace(index, next)}
              onRemove={() => remove(index)}
              ctx={ctx}
            />
          );
        })}
      </div>

      <Inline gap={3} wrap>
        <Button
          size="sm"
          variant="secondary"
          iconLeft={<Icons.plus size={13} />}
          onClick={() => onChange({ ...node, filters: [...node.filters, conditionFor(ctx.properties[0])] })}
        >
          Condition
        </Button>
        <Button
          size="sm"
          variant="ghost"
          iconLeft={<Icons.link size={13} />}
          onClick={() => onChange({ ...node, filters: [...node.filters, emptyAssociation(firstAssociation)] })}
        >
          Associated records
        </Button>
        {depth < 3 && (
          <Button
            size="sm"
            variant="ghost"
            iconLeft={<Icons.layers size={13} />}
            onClick={() => onChange({ ...node, filters: [...node.filters, { op: node.op === 'and' ? 'or' : 'and', filters: [] }] })}
          >
            Group
          </Button>
        )}
      </Inline>
    </div>
  );
}

/* --------------------------------- surface -------------------------------- */

export interface FilterBuilderProps {
  objectType: string;
  properties: PropertyDef[];
  schema: CrmSchema | undefined;
  users: WorkspaceUser[];
  value: FilterNode | null;
  onChange: (next: FilterNode | null) => void;
}

export function FilterBuilder({ objectType, properties, schema, users, value, onChange }: FilterBuilderProps) {
  const ctx: Ctx = { objectType, properties: filterableProperties(properties), schema, users };
  const root = value && isGroup(value) ? value : { op: 'and' as const, filters: value ? [value] : [] };
  return (
    <div className="crm-filter">
      <GroupEditor
        node={root}
        onChange={(next) => onChange(next.filters.length ? next : null)}
        depth={0}
        ctx={ctx}
      />
    </div>
  );
}

/* ------------------------------- description ------------------------------ */

/** A filter tree written out in English, for the chip strip above the grid. */
export function describeFilterNode(
  node: FilterNode,
  properties: Map<string, PropertyDef>,
  users: Map<string, WorkspaceUser>,
  money: (minor: number, currency?: string) => string,
  date: (ts: number) => string,
  associations?: Map<string, string>,
  depth = 0,
): string {
  if (isGroup(node)) {
    const parts = node.filters.map((child) => describeFilterNode(child, properties, users, money, date, associations, depth + 1));
    if (node.op === 'not') return `not (${parts.join(' and ')})`;
    if (parts.length < 2) return parts.join('');
    const joined = parts.join(node.op === 'and' ? ' and ' : ' or ');
    // The outermost group is the sentence; parenthesising it says nothing.
    return depth === 0 ? joined : `(${joined})`;
  }
  if (isAssociationCondition(node)) {
    const target = associations?.get(node.association) ?? humanize(node.association);
    const what = node.aggregate && node.aggregate !== 'count'
      ? `${node.aggregate} of ${humanize(node.aggregate_property ?? 'value')} across ${target}`
      : `number of ${target}`;
    return `${what} ${OPERATOR_LABEL[node.operator]} ${String(node.value ?? '')}`;
  }
  const condition = node as PropertyCondition;
  const property = properties.get(condition.property);
  const label = property?.label ?? humanize(condition.property);
  const render = (raw: unknown): string => {
    if (raw === null || raw === undefined || raw === '') return '';
    if (property?.type === 'currency' && typeof raw === 'number') return money(raw, property.currency ?? undefined);
    if ((property?.type === 'date' || property?.type === 'datetime') && typeof raw === 'number') return date(raw);
    if (property?.type === 'user') return users.get(String(raw))?.name ?? String(raw);
    if (property?.options.length) return property.options.find((o) => o.value === String(raw))?.label ?? String(raw);
    return typeof raw === 'string' ? humanize(raw) : String(raw);
  };
  if (needsNoValue(condition.operator)) return `${label} ${OPERATOR_LABEL[condition.operator]}`;
  if (needsDuration(condition.operator)) return `${label} ${OPERATOR_LABEL[condition.operator]} ${String(condition.value)} ${condition.unit ?? 'day'}s`;
  if (condition.values?.length) return `${label} ${OPERATOR_LABEL[condition.operator]} ${condition.values.map(render).join(', ')}`;
  return `${label} ${OPERATOR_LABEL[condition.operator]} ${render(condition.value)}`;
}

export function FilterSummary({ filter, properties, users, schema }: {
  filter: FilterNode | null;
  properties: Map<string, PropertyDef>;
  users: Map<string, WorkspaceUser>;
  schema?: CrmSchema;
}) {
  const f = useFormat();
  const associations = useMemo(() => {
    const map = new Map<string, string>();
    for (const type of schema?.object_types ?? []) map.set(type.name, type.plural_label.toLowerCase());
    for (const link of schema?.association_types ?? []) map.set(link.name, `${link.label.toLowerCase()} records`);
    return map;
  }, [schema]);
  if (!filter) return null;
  const text = describeFilterNode(
    filter, properties, users,
    (minor, currency) => f.money(minor, currency ? { currency } : undefined),
    (ts) => f.date(ts, { timeZone: 'UTC' }),
    associations,
  );
  return <span className="crm-filter__summary u-truncate" title={text}>{text}</span>;
}
