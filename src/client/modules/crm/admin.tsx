/**
 * The data model.
 *
 * Ain's object model is editable at runtime — a workspace can add an object,
 * give it a calculated property or a rollup over its associations, and define
 * how it links to everything else. That has always been six API calls. This is
 * the screen that makes it a Tuesday afternoon instead of an integration
 * project.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Badge, Banner, Button, Card, ConfirmDialog, DataTable, EmptyState, Field, Grid, Icons, IconButton,
  Inline, Input, Modal, Page, SegmentedControl, Select, Skeleton, Switch, Textarea, Tooltip,
  humanize, iconByName, useFormat, useToast, type DataTableColumn, type MenuSection,
} from '@/client/design';
import { useRouter } from '@/client/kernel/router';
import type { ApiClientError } from '@/client/kernel/api';
import {
  createAssociationType, createObjectType, createProperty, crmChanged, deleteProperty,
  updateProperty, useAssociationTypes, useObjectTypes, useProperties, useSchema,
  type AssociationTypeDef, type FilterNode, type ObjectTypeDef, type PropertyDef, type PropertyOption,
  type PropertyRollup, type PropertyType,
} from './api';
import { FilterBuilder, pruneFilter } from './filter-builder';
import { blamedProperty, errorMessage } from './dialogs';
import { listHref } from './list';
import { optionTone } from './values';

const PROPERTY_TYPES: { value: PropertyType; label: string; hint: string }[] = [
  { value: 'string', label: 'Single-line text', hint: 'A name, a code, a short label' },
  { value: 'text', label: 'Multi-line text', hint: 'Notes and descriptions' },
  { value: 'number', label: 'Number', hint: 'Counts and quantities' },
  { value: 'currency', label: 'Currency', hint: 'Stored in integer minor units' },
  { value: 'date', label: 'Date', hint: 'A day, with no time of day' },
  { value: 'datetime', label: 'Date and time', hint: 'An instant' },
  { value: 'bool', label: 'Yes / no', hint: 'A checkbox' },
  { value: 'enum', label: 'Single select', hint: 'One of a coloured option list' },
  { value: 'multi_enum', label: 'Multiple select', hint: 'Any number of the option list' },
  { value: 'url', label: 'URL', hint: 'A link' },
  { value: 'email', label: 'Email', hint: 'Validated, and normalised for dedupe' },
  { value: 'phone', label: 'Phone', hint: 'Digits are normalised for dedupe' },
  { value: 'user', label: 'Teammate', hint: 'Picks a user in this workspace' },
  { value: 'reference', label: 'Record reference', hint: 'Points at one record of another object' },
  { value: 'computed', label: 'Formula result', hint: 'Whatever the expression returns' },
  { value: 'json', label: 'JSON', hint: 'Structured payloads from integrations' },
];

/** A rollup stores an aggregate, so its type has to be one an aggregate returns. */
const ROLLUP_TYPES: PropertyType[] = ['number', 'currency', 'date', 'datetime'];

const OPTION_COLORS = ['blue', 'violet', 'teal', 'green', 'amber', 'orange', 'red', 'pink', 'indigo', 'gray'];

const slug = (input: string): string =>
  input.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

/* ------------------------------- the surface ------------------------------ */

export function DataModelPage() {
  const { location, setQuery, navigate } = useRouter();
  const objects = useObjectTypes();
  const schema = useSchema();
  const associations = useAssociationTypes();
  const f = useFormat();

  const list = useMemo(() => objects.data?.data ?? [], [objects.data]);
  const selectedName = location.query.type || list.find((t) => t.category === 'record')?.name || '';
  const selected = list.find((t) => t.name === selectedName);

  const [creatingObject, setCreatingObject] = useState(false);
  const [creatingAssociation, setCreatingAssociation] = useState(false);

  return (
    <Page
      title="Data model"
      eyebrow="Customers"
      width="wide"
      subtitle="Every object, property and association in this workspace — editable, and live the moment it is saved."
      actions={
        <Inline gap={3}>
          <Button variant="ghost" iconLeft={<Icons.link size={14} />} onClick={() => setCreatingAssociation(true)}>
            New association type
          </Button>
          <Button variant="primary" iconLeft={<Icons.plus size={14} />} onClick={() => setCreatingObject(true)}>
            New custom object
          </Button>
        </Inline>
      }
    >
      {objects.error && (
        <Banner
          tone="danger"
          title="The object list could not be read"
          actions={<Button size="sm" onClick={objects.refetch}>Try again</Button>}
        >
          {objects.error.body.message}
        </Banner>
      )}

      {objects.loading && <Grid minColumnWidth={220}><Skeleton height={104} /><Skeleton height={104} /><Skeleton height={104} /><Skeleton height={104} /></Grid>}

      {!objects.loading && list.length > 0 && (
        <Grid minColumnWidth={220}>
          {list.map((type) => {
            const Icon = iconByName(type.icon === 'life-buoy' ? 'tickets' : type.icon === 'sticky-note' ? 'note' : type.icon);
            return (
              <Card
                key={type.name}
                padding="tight"
                className={`crm-objcard${type.name === selectedName ? ' is-active' : ''}`}
              >
                <button
                  type="button"
                  className="crm-objcard__pick"
                  aria-pressed={type.name === selectedName}
                  onClick={() => setQuery({ type: type.name })}
                >
                  <span className="crm-objcard__icon"><Icon size={16} /></span>
                  <span className="crm-objcard__name u-truncate">{type.plural_label}</span>
                  {!type.system && <Badge tone="purple" size="sm">Custom</Badge>}
                </button>
                <div className="crm-objcard__stats">
                  <span>{f.number(type.record_count ?? 0)} records</span>
                  <span aria-hidden>·</span>
                  <span>{f.number(type.property_count ?? 0)} properties</span>
                </div>
                <div className="crm-objcard__foot">
                  <Badge tone={type.category === 'activity' ? 'neutral' : 'info'} size="sm">{humanize(type.category)}</Badge>
                  <span className="u-spacer" />
                  {type.category === 'record' && (
                    <Button size="sm" variant="ghost" onClick={() => navigate(listHref(type.name))}>Open list</Button>
                  )}
                </div>
              </Card>
            );
          })}
        </Grid>
      )}

      {selected && <PropertyAdmin objectType={selected} schema={schema.data} />}

      <AssociationAdmin
        types={associations.data?.data ?? []}
        loading={associations.loading}
        error={associations.error}
        onRetry={associations.refetch}
        onCreate={() => setCreatingAssociation(true)}
      />

      <ObjectDialog open={creatingObject} onClose={() => setCreatingObject(false)} onCreated={(type) => setQuery({ type: type.name })} />
      <AssociationDialog
        open={creatingAssociation}
        onClose={() => setCreatingAssociation(false)}
        objectTypes={list}
      />
    </Page>
  );
}

/* ----------------------------- property admin ----------------------------- */

function sourceOf(property: PropertyDef): 'stored' | 'calculated' | 'rollup' {
  if (property.rollup) return 'rollup';
  if (property.calculated) return 'calculated';
  return 'stored';
}

function PropertyAdmin({ objectType, schema }: { objectType: ObjectTypeDef; schema: ReturnType<typeof useSchema>['data'] }) {
  const toast = useToast();
  const props = useProperties(objectType.name);
  const [editing, setEditing] = useState<PropertyDef | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<PropertyDef | null>(null);

  const rows = props.data?.data ?? [];

  const columns: DataTableColumn<PropertyDef>[] = [
    {
      id: 'label',
      header: 'Property',
      pinned: true,
      width: 260,
      accessor: (row) => row.label,
      cell: (row) => (
        <span className="crm-cell__link">
          <span className="crm-cell__name u-truncate">{row.label}</span>
          <span className="crm-cell__sub u-mono u-truncate">{row.name}</span>
        </span>
      ),
    },
    { id: 'type', header: 'Type', accessor: (row) => row.type, cell: (row) => <Badge tone="neutral" size="sm">{PROPERTY_TYPES.find((t) => t.value === row.type)?.label ?? humanize(row.type)}</Badge>, filter: 'set' },
    { id: 'group', header: 'Group', accessor: (row) => row.group, filter: 'set' },
    {
      id: 'source',
      header: 'Source',
      accessor: (row) => sourceOf(row),
      filter: 'set',
      cell: (row) => {
        const source = sourceOf(row);
        if (source === 'rollup' && row.rollup) {
          return (
            <Tooltip content={`${row.rollup.aggregate} of ${row.rollup.property ?? 'records'} across ${row.rollup.association}${row.rollup.filter ? ', filtered' : ''}`}>
              <Badge tone="purple" size="sm" icon={<Icons.funnel size={11} />}>Rollup</Badge>
            </Tooltip>
          );
        }
        if (source === 'calculated' && row.calculated) {
          return (
            <Tooltip content={row.calculated}>
              <Badge tone="info" size="sm" icon={<Icons.code size={11} />}>Formula</Badge>
            </Tooltip>
          );
        }
        return <Badge tone="neutral" size="sm">Stored</Badge>;
      },
    },
    {
      id: 'options',
      header: 'Options',
      accessor: (row) => row.options.length,
      cell: (row) => (row.options.length
        ? (
          <span className="crm-chips">
            {row.options.slice(0, 3).map((o) => <Badge key={o.value} tone={optionTone(o.color)} size="sm">{o.label}</Badge>)}
            {row.options.length > 3 && <span className="crm-muted">+{row.options.length - 3}</span>}
          </span>
        )
        : <span className="crm-muted">—</span>),
    },
    {
      id: 'flags',
      header: 'Rules',
      accessor: (row) => `${row.required ? 'required ' : ''}${row.unique ? 'unique ' : ''}${row.system ? 'system' : ''}`,
      cell: (row) => (
        <span className="crm-chips">
          {row.required && <Badge tone="warning" size="sm">Required</Badge>}
          {row.unique && <Badge tone="info" size="sm">Unique</Badge>}
          {row.system && <Badge tone="neutral" size="sm">System</Badge>}
        </span>
      ),
    },
  ];

  return (
    <>
      <Card
        title={`${objectType.label} properties`}
        description={`${rows.length} properties. Formulas and rollups are recomputed across every existing record the moment they are saved.`}
        actions={
          <Inline gap={3}>
            <Button size="sm" variant="ghost" iconLeft={<Icons.table size={13} />} onClick={() => setCreating(true)}>
              Add a property
            </Button>
          </Inline>
        }
        padding="none"
      >
        <DataTable<PropertyDef>
          rows={rows}
          columns={columns}
          getRowId={(row) => row.name}
          loading={props.loading}
          error={props.error ? { message: props.error.body.message, requestId: props.error.body.request_id ?? null } : null}
          onRetry={props.refetch}
          searchPlaceholder="Search properties…"
          maxHeight={420}
          plain
          empty={
            <EmptyState
              title="No properties yet"
              body={`${objectType.label} has no fields. Add the first one and it appears in every list, filter and form for this object.`}
              action={<Button variant="primary" onClick={() => setCreating(true)}>Add a property</Button>}
            />
          }
          rowActions={(row) => ([{
            id: 'prop',
            items: [
              { id: 'edit', label: 'Edit this property', icon: <Icons.edit size={14} />, onSelect: () => setEditing(row) },
              {
                id: 'delete',
                label: row.system ? 'System properties cannot be deleted' : 'Delete this property',
                icon: <Icons.trash size={14} />,
                danger: !row.system,
                disabled: row.system,
                onSelect: () => setConfirmDelete(row),
              },
            ],
          }] satisfies MenuSection[])}
        />
      </Card>

      <PropertyDialog
        open={creating || !!editing}
        onClose={() => { setCreating(false); setEditing(null); }}
        objectType={objectType}
        schema={schema}
        existing={editing}
        properties={rows}
      />

      <ConfirmDialog
        open={!!confirmDelete}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          const property = confirmDelete;
          setConfirmDelete(null);
          if (!property) return;
          try {
            await deleteProperty(objectType.name, property.name);
            crmChanged();
            toast.success('Property deleted', `${property.label} and every value stored against it are gone.`);
          } catch (e) {
            toast.error('Property not deleted', (e as ApiClientError).body.message);
          }
        }}
        title={`Delete “${confirmDelete?.label ?? ''}”?`}
        body="Every value stored against this property on every record goes with it. Formulas that read it will refuse to save until they are rewritten."
        confirmLabel="Delete property"
        confirmPhrase={confirmDelete?.name}
      />
    </>
  );
}

/* ---------------------------- property dialog ----------------------------- */

function PropertyDialog({ open, onClose, objectType, schema, existing, properties }: {
  open: boolean;
  onClose: () => void;
  objectType: ObjectTypeDef;
  schema: ReturnType<typeof useSchema>['data'];
  existing: PropertyDef | null;
  properties: PropertyDef[];
}) {
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<PropertyType>('string');
  const [group, setGroup] = useState('');
  const [description, setDescription] = useState('');
  const [source, setSource] = useState<'stored' | 'calculated' | 'rollup'>('stored');
  const [formula, setFormula] = useState('');
  const [rollup, setRollup] = useState<PropertyRollup>({ association: 'deal', aggregate: 'count' });
  const [rollupFilter, setRollupFilter] = useState<FilterNode | null>(null);
  const [options, setOptions] = useState<PropertyOption[]>([]);
  const [required, setRequired] = useState(false);
  const [unique, setUnique] = useState(false);
  const [referenceType, setReferenceType] = useState('company');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);

  const targetProps = useProperties(source === 'rollup' ? rollup.association : null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (existing) {
      setLabel(existing.label);
      setName(existing.name);
      setType(existing.type);
      setGroup(existing.group);
      setDescription(existing.description ?? '');
      setSource(sourceOf(existing));
      setFormula(existing.calculated ?? '');
      setRollup(existing.rollup ?? { association: 'deal', aggregate: 'count' });
      setRollupFilter(existing.rollup?.filter ?? null);
      setOptions(existing.options);
      setRequired(existing.required);
      setUnique(existing.unique);
      setReferenceType(existing.reference_type ?? 'company');
    } else {
      setLabel(''); setName(''); setType('string'); setGroup(properties[0]?.group ?? 'Details');
      setDescription(''); setSource('stored'); setFormula('');
      setRollup({ association: 'deal', aggregate: 'count' }); setRollupFilter(null);
      setOptions([]); setRequired(false); setUnique(false); setReferenceType('company');
    }
  }, [open, existing, properties]);

  const groups = useMemo(() => [...new Set(properties.map((p) => p.group))], [properties]);
  const blamed = blamedProperty(error) ?? error?.body.param ?? null;
  const isEnum = type === 'enum' || type === 'multi_enum';

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const rollupPayload: PropertyRollup | undefined = source === 'rollup'
        ? { ...rollup, ...(pruneFilter(rollupFilter) ? { filter: pruneFilter(rollupFilter) } : {}) }
        : undefined;
      if (existing) {
        // A system property refuses a change to how it is computed, so only a
        // change an operator actually made is sent — and clearing a formula is
        // an empty string, which is what the API reads as "stop computing it".
        const formulaPatch = existing.system
          ? {}
          : source === 'calculated'
            ? (formula !== (existing.calculated ?? '') ? { calculated: formula } : {})
            : (existing.calculated ? { calculated: '' } : {});
        const rollupPatch = existing.system
          ? {}
          : source === 'rollup'
            ? { rollup: rollupPayload }
            : (existing.rollup ? { rollup: null } : {});
        await updateProperty(objectType.name, existing.name, {
          label,
          description: description || undefined,
          group,
          ...(isEnum ? { options } : {}),
          required,
          unique,
          ...formulaPatch,
          ...rollupPatch,
        });
        crmChanged();
        toast.success('Property updated', `${label} is live on every ${objectType.label.toLowerCase()}.`);
      } else {
        const created = await createProperty(objectType.name, {
          name: name || slug(label),
          label,
          type,
          group: group || 'Details',
          ...(description ? { description } : {}),
          ...(isEnum ? { options } : {}),
          ...(type === 'reference' ? { reference_type: referenceType } : {}),
          ...(required ? { required } : {}),
          ...(unique ? { unique } : {}),
          ...(source === 'calculated' ? { calculated: formula } : {}),
          ...(rollupPayload ? { rollup: rollupPayload } : {}),
        });
        crmChanged();
        const backfilled = created.records_recalculated;
        toast.success(
          'Property created',
          backfilled
            ? `${label} was computed across ${backfilled} existing ${objectType.plural_label.toLowerCase()}.`
            : `${label} is on every ${objectType.label.toLowerCase()} form, list and filter now.`,
        );
      }
      onClose();
    } catch (e) {
      const err = e as ApiClientError;
      setError(err);
      toast.error(existing ? 'Property not updated' : 'Property not created', err.body.message);
    } finally {
      setBusy(false);
    }
  };

  const associationChoices = [
    ...(schema?.object_types ?? []).map((t) => ({ value: t.name, label: t.plural_label, group: 'Object types' })),
    ...(schema?.association_types ?? [])
      .filter((a) => a.from_object === objectType.name || a.to_object === objectType.name || a.from_object === '*')
      .map((a) => ({ value: a.name, label: `${a.label} / ${a.inverse_label}`, group: 'Association types' })),
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={existing ? `Edit “${existing.label}”` : `New property on ${objectType.label}`}
      description={existing ? 'The name and the type are fixed once records carry values.' : 'It becomes a form field, a list column, a filter and a sort key the moment it is saved.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!label.trim()} onClick={() => { void submit(); }}>
            {existing ? 'Save property' : 'Create property'}
          </Button>
        </>
      }
    >
      {error && !blamed && <Banner tone="danger" compact>{errorMessage(error)}</Banner>}
      <div className="crm-form">
        <div className="crm-form__grid">
          <Field label="Label" required error={blamed === 'label' ? error?.body.message : undefined}>
            <Input
              value={label}
              onChange={(e) => { setLabel(e.target.value); if (!existing) setName(slug(e.target.value)); }}
              placeholder="Renewal risk"
              autoFocus
            />
          </Field>
          <Field label="Internal name" hint="What the API and formulas call it." error={blamed === 'name' ? error?.body.message : undefined}>
            <Input value={name} onChange={(e) => setName(slug(e.target.value))} disabled={!!existing} mono placeholder="renewal_risk" />
          </Field>
        </div>

        <div className="crm-form__grid">
          <Field label="Type" hint={source === 'rollup' ? 'Limited to the types an aggregate can hold' : undefined}>
            <Select
              value={type}
              onChange={(next) => setType(next as PropertyType)}
              options={(source === 'rollup' ? PROPERTY_TYPES.filter((t) => ROLLUP_TYPES.includes(t.value)) : PROPERTY_TYPES)
                .map((t) => ({ value: t.value, label: t.label }))}
              disabled={!!existing}
            />
          </Field>
          <Field label="Group" hint="Sections on the record page, in this order.">
            <Input
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              list="crm-groups"
              placeholder="Customer"
            />
            <datalist id="crm-groups">
              {groups.map((g) => <option key={g} value={g} />)}
            </datalist>
          </Field>
        </div>

        <Field label="Description" optional hint="Shown under the label wherever the property is edited.">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} minRows={2} />
        </Field>

        <Field
          label="Where the value comes from"
          hint={source === 'rollup'
            ? 'A rollup produces a number, so its type is one the aggregate can hold.'
            : source === 'calculated' ? 'A formula is evaluated on every write, in dependency order.' : undefined}
        >
          <SegmentedControl
            value={source}
            onChange={(next) => {
              setSource(next);
              // The type has to be able to hold what the source produces, and
              // an operator who picked "Rollup" has not also opted into
              // discovering that "single-line text" cannot hold a sum.
              if (next === 'rollup' && !ROLLUP_TYPES.includes(type)) setType('number');
              if (next === 'calculated' && type === 'string') setType('computed');
            }}
            options={[
              { value: 'stored', label: 'Typed in' },
              { value: 'calculated', label: 'Formula' },
              { value: 'rollup', label: 'Rollup' },
            ]}
            aria-label="Property source"
          />
        </Field>

        {source === 'calculated' && (
          <Field
            label="Formula"
            hint={`Evaluated on every write, in dependency order. Functions: ${(schema?.expression_functions ?? []).join(', ')}`}
            error={blamed === 'calculated' ? error?.body.message : undefined}
          >
            <Textarea
              value={formula}
              onChange={(e) => setFormula(e.target.value)}
              minRows={3}
              className="u-mono"
              placeholder={'if(employee_count >= 2000, "Enterprise", "Mid-market")'}
            />
          </Field>
        )}

        {source === 'rollup' && (
          <div className="crm-rollup">
            <div className="crm-form__grid">
              <Field label="Aggregate">
                <Select
                  value={rollup.aggregate}
                  onChange={(next) => setRollup((prev) => ({ ...prev, aggregate: next as PropertyRollup['aggregate'] }))}
                  options={[
                    { value: 'count', label: 'How many' },
                    { value: 'sum', label: 'Total of' },
                    { value: 'avg', label: 'Average of' },
                    { value: 'min', label: 'Smallest' },
                    { value: 'max', label: 'Largest' },
                  ]}
                />
              </Field>
              <Field label="Across">
                <Select
                  value={rollup.association}
                  onChange={(next) => setRollup((prev) => ({ ...prev, association: next, property: undefined }))}
                  options={associationChoices}
                />
              </Field>
            </div>
            {rollup.aggregate !== 'count' && (
              <Field label="Property to aggregate" required error={blamed === 'rollup.property' ? error?.body.message : undefined}>
                <Select
                  value={rollup.property ?? ''}
                  onChange={(next) => {
                    setRollup((prev) => ({ ...prev, property: next }));
                    // Summing money produces money: carry the far side's type
                    // across so the column formats as currency, not as 8000000.
                    const far = (targetProps.data?.data ?? []).find((p) => p.name === next);
                    if (far && ROLLUP_TYPES.includes(far.type)) setType(far.type);
                  }}
                  options={[
                    { value: '', label: 'Choose a number' },
                    ...(targetProps.data?.data ?? [])
                      .filter((p) => p.type === 'number' || p.type === 'currency' || p.type === 'date' || p.type === 'datetime')
                      .map((p) => ({ value: p.name, label: p.label, group: p.group })),
                  ]}
                />
              </Field>
            )}
            <Field label="Only count some of them" optional hint="The same filter engine the list view uses — “open deals”, “tickets that are not closed”.">
              <FilterBuilder
                objectType={rollup.association}
                properties={targetProps.data?.data ?? []}
                schema={schema}
                users={[]}
                value={rollupFilter}
                onChange={setRollupFilter}
              />
            </Field>
          </div>
        )}

        {type === 'reference' && (
          <Field label="Points at">
            <Select
              value={referenceType}
              onChange={setReferenceType}
              options={(schema?.object_types ?? []).map((t) => ({ value: t.name, label: t.label }))}
            />
          </Field>
        )}

        {isEnum && (
          <Field label="Options" hint="Each one carries a colour, and the badge everywhere in the product uses it.">
            <div className="crm-options">
              {options.map((option, index) => (
                <div className="crm-options__row" key={index}>
                  <Input
                    value={option.label}
                    onChange={(e) => setOptions((prev) => prev.map((o, i) => (i === index ? { ...o, label: e.target.value, value: o.value || slug(e.target.value) } : o)))}
                    placeholder="Label"
                    aria-label={`Option ${index + 1} label`}
                  />
                  <Input
                    value={option.value}
                    onChange={(e) => setOptions((prev) => prev.map((o, i) => (i === index ? { ...o, value: slug(e.target.value) } : o)))}
                    placeholder="value"
                    mono
                    aria-label={`Option ${index + 1} value`}
                  />
                  <Select
                    value={option.color ?? 'gray'}
                    onChange={(next) => setOptions((prev) => prev.map((o, i) => (i === index ? { ...o, color: next } : o)))}
                    options={OPTION_COLORS.map((c) => ({ value: c, label: humanize(c) }))}
                    size="sm"
                    aria-label={`Option ${index + 1} colour`}
                  />
                  <Badge tone={optionTone(option.color)} size="sm">{option.label || 'Preview'}</Badge>
                  <IconButton
                    size="sm"
                    label={`Remove option ${index + 1}`}
                    icon={<Icons.x size={13} />}
                    onClick={() => setOptions((prev) => prev.filter((_, i) => i !== index))}
                  />
                </div>
              ))}
              <Button
                size="sm"
                variant="secondary"
                iconLeft={<Icons.plus size={13} />}
                onClick={() => setOptions((prev) => [...prev, { value: '', label: '', color: OPTION_COLORS[prev.length % OPTION_COLORS.length] }])}
              >
                Add an option
              </Button>
            </div>
          </Field>
        )}

        {source === 'stored' && (
          <Inline gap={6} wrap>
            <Switch checked={required} onChange={setRequired} label="Required" hint="Refused on create without a value" />
            <Switch checked={unique} onChange={setUnique} label="Unique" hint="Also becomes a dedupe and import key" />
          </Inline>
        )}
      </div>
    </Modal>
  );
}

/* --------------------------- association admin ---------------------------- */

function AssociationAdmin({ types, loading, error, onRetry, onCreate }: {
  types: AssociationTypeDef[];
  loading: boolean;
  error: ApiClientError | null;
  onRetry: () => void;
  onCreate: () => void;
}) {
  const columns: DataTableColumn<AssociationTypeDef>[] = [
    { id: 'name', header: 'Name', pinned: true, width: 220, accessor: (row) => row.name, cell: (row) => <span className="u-mono">{row.name}</span> },
    { id: 'from_object', header: 'From', accessor: (row) => row.from_object, filter: 'set', cell: (row) => <Badge tone="neutral" size="sm">{row.from_object === '*' ? 'any object' : humanize(row.from_object)}</Badge> },
    { id: 'label', header: 'Reads as', accessor: (row) => row.label },
    { id: 'to_object', header: 'To', accessor: (row) => row.to_object, filter: 'set', cell: (row) => <Badge tone="neutral" size="sm">{row.to_object === '*' ? 'any object' : humanize(row.to_object)}</Badge> },
    { id: 'inverse_label', header: 'Reads back as', accessor: (row) => row.inverse_label },
    { id: 'cardinality', header: 'Cardinality', accessor: (row) => row.cardinality, filter: 'set', cell: (row) => <Badge tone={row.cardinality === 'many_to_many' ? 'info' : 'warning'} size="sm">{humanize(row.cardinality)}</Badge> },
  ];

  return (
    <Card
      title="Association types"
      description="How objects link to each other, and what the link reads as from both ends."
      actions={<Button size="sm" variant="ghost" iconLeft={<Icons.plus size={13} />} onClick={onCreate}>New association type</Button>}
      padding="none"
    >
      <DataTable<AssociationTypeDef>
        rows={types}
        columns={columns}
        getRowId={(row) => row.name}
        loading={loading}
        error={error ? { message: error.body.message, requestId: error.body.request_id ?? null } : null}
        onRetry={onRetry}
        maxHeight={360}
        plain
        searchPlaceholder="Search association types…"
        empty={<EmptyState title="No association types" body="Objects cannot be linked until one exists." action={<Button variant="primary" onClick={onCreate}>Define one</Button>} />}
      />
    </Card>
  );
}

function AssociationDialog({ open, onClose, objectTypes }: {
  open: boolean; onClose: () => void; objectTypes: ObjectTypeDef[];
}) {
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [inverseLabel, setInverseLabel] = useState('');
  const [fromObject, setFromObject] = useState('');
  const [toObject, setToObject] = useState('');
  const [cardinality, setCardinality] = useState('many_to_many');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);

  useEffect(() => {
    if (!open) return;
    const first = objectTypes.find((t) => t.category === 'record')?.name ?? '';
    setLabel(''); setInverseLabel(''); setFromObject(first); setToObject(first);
    setCardinality('many_to_many'); setName(''); setError(null);
  }, [open, objectTypes]);

  useEffect(() => {
    if (!name && fromObject && toObject) setName(`${fromObject}_to_${toObject}`);
  }, [fromObject, toObject, name]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await createAssociationType({
        name: name || `${fromObject}_to_${toObject}`,
        from_object: fromObject,
        to_object: toObject,
        label,
        inverse_label: inverseLabel,
        cardinality,
      });
      crmChanged();
      toast.success('Association type defined', `A ${humanize(fromObject).toLowerCase()} can now be linked to a ${humanize(toObject).toLowerCase()} as “${label}”.`);
      onClose();
    } catch (e) {
      const err = e as ApiClientError;
      setError(err);
      toast.error('Association type not created', err.body.message);
    } finally {
      setBusy(false);
    }
  };

  const options = objectTypes.map((t) => ({ value: t.name, label: t.label }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="New association type"
      description="Both labels matter: one is what the link reads as from the left-hand record, the other from the right."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!label.trim() || !inverseLabel.trim()} onClick={() => { void submit(); }}>
            Define association
          </Button>
        </>
      }
    >
      {error && <Banner tone="danger" compact>{errorMessage(error)}</Banner>}
      <div className="crm-form">
        <div className="crm-form__grid">
          <Field label="From" required><Select value={fromObject} onChange={(next) => { setFromObject(next); setName(''); }} options={options} /></Field>
          <Field label="To" required><Select value={toObject} onChange={(next) => { setToObject(next); setName(''); }} options={options} /></Field>
        </div>
        <div className="crm-form__grid">
          <Field label="Reads as, from the left" required hint="“Works at”" error={error?.body.param === 'label' ? error.body.message : undefined}>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Installed at" autoFocus />
          </Field>
          <Field label="Reads as, from the right" required hint="“Employs”" error={error?.body.param === 'inverse_label' ? error.body.message : undefined}>
            <Input value={inverseLabel} onChange={(e) => setInverseLabel(e.target.value)} placeholder="Installations" />
          </Field>
        </div>
        <div className="crm-form__grid">
          <Field label="Cardinality" hint="A one-to-many link holds a single edge and replaces it on the next write.">
            <Select
              value={cardinality}
              onChange={setCardinality}
              options={[
                { value: 'many_to_many', label: 'Many to many' },
                { value: 'many_to_one', label: 'Many to one' },
                { value: 'one_to_many', label: 'One to many' },
                { value: 'one_to_one', label: 'One to one' },
              ]}
            />
          </Field>
          <Field label="Internal name" error={error?.body.param === 'name' ? error.body.message : undefined}>
            <Input value={name} onChange={(e) => setName(slug(e.target.value))} mono />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------ object dialog ----------------------------- */

const OBJECT_ICONS = ['building', 'cpu', 'layers', 'briefcase', 'server', 'database', 'globe', 'tag', 'target', 'gauge', 'folder', 'grid'];

function ObjectDialog({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated: (type: ObjectTypeDef) => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [pluralLabel, setPluralLabel] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('layers');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);

  useEffect(() => {
    if (!open) return;
    setLabel(''); setPluralLabel(''); setName(''); setDescription(''); setIcon('layers'); setError(null);
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await createObjectType({
        name: name || slug(label),
        label,
        plural_label: pluralLabel || `${label}s`,
        ...(description ? { description } : {}),
        icon,
      });
      crmChanged();
      toast.success(
        `${created.plural_label} created`,
        'It has a list, a record page, filters, views and an API — add properties to it next.',
      );
      onCreated(created);
      onClose();
    } catch (e) {
      const err = e as ApiClientError;
      setError(err);
      toast.error('Object not created', err.body.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="New custom object"
      description="A first-class object: records, properties, associations, timelines, views, filters and API routes — the same machinery contacts and deals run on."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!label.trim()} onClick={() => { void submit(); }}>
            Create object
          </Button>
        </>
      }
    >
      {error && !error.body.param && <Banner tone="danger" compact>{errorMessage(error)}</Banner>}
      <div className="crm-form">
        <div className="crm-form__grid">
          <Field label="Singular name" required error={error?.body.param === 'label' ? error.body.message : undefined}>
            <Input
              value={label}
              onChange={(e) => { setLabel(e.target.value); setName(slug(e.target.value)); if (!pluralLabel) setPluralLabel(''); }}
              placeholder="Installation"
              autoFocus
            />
          </Field>
          <Field label="Plural name" required error={error?.body.param === 'plural_label' ? error.body.message : undefined}>
            <Input value={pluralLabel} onChange={(e) => setPluralLabel(e.target.value)} placeholder="Installations" />
          </Field>
        </div>
        <Field label="Internal name" hint="Lower case, letters, digits and underscores. This is the API path." error={error?.body.param === 'name' ? error.body.message : undefined}>
          <Input value={name} onChange={(e) => setName(slug(e.target.value))} mono placeholder="installation" />
        </Field>
        <Field label="Description" optional>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} minRows={2} placeholder="A telemetry rollout at one customer site." />
        </Field>
        <Field label="Icon">
          <div className="crm-iconpick" role="radiogroup" aria-label="Object icon">
            {OBJECT_ICONS.map((choice) => {
              const Icon = iconByName(choice);
              return (
                <button
                  key={choice}
                  type="button"
                  role="radio"
                  aria-checked={icon === choice}
                  aria-label={choice}
                  className={`crm-iconpick__btn${icon === choice ? ' is-active' : ''}`}
                  onClick={() => setIcon(choice)}
                >
                  <Icon size={16} />
                </button>
              );
            })}
          </div>
        </Field>
      </div>
    </Modal>
  );
}
