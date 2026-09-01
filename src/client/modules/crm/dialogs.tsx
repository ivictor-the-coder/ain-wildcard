/**
 * Every write in the CRM that needs more than one field.
 *
 * They share three habits: the server's validation error is bound to the field
 * it names rather than dropped into a banner, a success raises a toast that
 * says what actually happened, and the write announces itself so the list, the
 * record page and the dashboard all move at once.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Badge, Banner, Button, CheckCircleIcon, Checkbox, Field, Icons, Input, Modal, Select, Switch,
  Textarea, Tooltip, humanize, useToast, type Tone,
} from '@/client/design';
import type { ApiClientError } from '@/client/kernel/api';
import { useSession } from '@/client/kernel/session';
import {
  associate, batchUpdate, createRecord, crmChanged, logActivity, patchRecord, saveView, updateView,
  type CrmRecord, type FilterNode, type ObjectTypeDef, type PropertyDef, type PropertyValue,
  type SortSpec, type ViewDef, type WorkspaceUser,
} from './api';
import { PropertyEditor, RecordPicker, ValueView } from './values';

/* --------------------------- validation plumbing -------------------------- */

/** Which field the server blamed — `properties.email`, or a uniqueness clash. */
export function blamedProperty(error: ApiClientError | null): string | null {
  if (!error) return null;
  const param = error.body.param;
  if (param?.startsWith('properties.')) return param.slice('properties.'.length);
  const detail = error.body.detail as { property?: string } | undefined;
  if (detail?.property) return detail.property;
  if (param === 'owner_id') return 'owner_id';
  return null;
}

export const errorMessage = (error: ApiClientError | null): string | null =>
  error ? `${error.body.message}${error.body.request_id ? ` (${error.body.request_id})` : ''}` : null;

/** Multi-select values are arrays, so identity is not the question being asked. */
const sameValue = (a: PropertyValue, b: PropertyValue): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/* ------------------------------- record form ------------------------------ */

const CORE_LIMIT = 8;

/** Types whose editor needs a whole row rather than half of one. */
const WIDE_TYPES = new Set<PropertyDef['type']>(['text', 'json', 'multi_enum']);

function editableProperties(properties: PropertyDef[]): PropertyDef[] {
  return properties.filter((p) => !p.read_only && !p.hidden && !p.calculated && !p.rollup && p.type !== 'computed');
}

export interface RecordFormDialogProps {
  open: boolean;
  onClose: () => void;
  objectType: ObjectTypeDef;
  properties: PropertyDef[];
  users: WorkspaceUser[];
  /** Ids the new record is linked to the moment it exists. */
  associateTo?: string[];
  onCreated?: (record: CrmRecord) => void;
}

export function RecordFormDialog({ open, onClose, objectType, properties, users, associateTo, onCreated }: RecordFormDialogProps) {
  const toast = useToast();
  const session = useSession();
  const formId = useId();
  const [values, setValues] = useState<Record<string, PropertyValue>>({});
  // Enter can submit in the same tick a number field commits its text, so the
  // payload is read from a ref that is written synchronously rather than from
  // state React has not re-rendered yet.
  const valuesRef = useRef<Record<string, PropertyValue>>({});
  const [ownerId, setOwnerId] = useState<string | null>(session.me?.user?.id ?? null);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);

  const setValue = useCallback((name: string, next: PropertyValue) => {
    valuesRef.current = { ...valuesRef.current, [name]: next };
    setValues(valuesRef.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    valuesRef.current = {};
    setValues({});
    setOwnerId(session.me?.user?.id ?? null);
    setError(null);
    setShowAll(false);
  }, [open, session.me?.user?.id]);

  const editable = useMemo(() => editableProperties(properties), [properties]);
  const core = useMemo(() => {
    const required = editable.filter((p) => p.required);
    const rest = editable.filter((p) => !p.required).slice(0, Math.max(0, CORE_LIMIT - required.length));
    const chosen = [...required, ...rest];
    return editable.filter((p) => chosen.includes(p));
  }, [editable]);
  const shown = showAll ? editable : core;
  const blamed = blamedProperty(error);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(valuesRef.current)) {
        if (value === '' || value === null || value === undefined) continue;
        payload[key] = value;
      }
      const record = await createRecord(objectType.name, payload, ownerId, associateTo);
      crmChanged();
      toast.success(`${objectType.label} created`, `${record.display_name} is in your ${objectType.plural_label.toLowerCase()} now.`);
      onCreated?.(record);
      onClose();
    } catch (e) {
      const err = e as ApiClientError;
      setError(err);
      toast.error(`${objectType.label} not created`, err.body.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={`New ${objectType.label.toLowerCase()}`}
      description={objectType.description ?? undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => { void submit(); }}>
            Create {objectType.label.toLowerCase()}
          </Button>
        </>
      }
      footerBetween={false}
    >
      {error && !blamed && (
        <Banner tone="danger" title="The server refused this record" compact>
          {errorMessage(error)}
        </Banner>
      )}
      {/* A real <form> so Enter from any single-line field creates the record. */}
      <form id={formId} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="crm-form crm-form--split">
          <Field label="Owner" hint="Who this record belongs to. Everything they own shows up in their book.">
            <Select
              value={ownerId ?? ''}
              onChange={(next) => setOwnerId(next || null)}
              options={[{ value: '', label: 'Unassigned' }, ...users.map((u) => ({ value: u.id, label: u.name }))]}
            />
          </Field>
          {shown.map((property) => (
            <Field
              key={property.name}
              // Long-form values get the full width; everything else pairs up, so
              // a thirty-property object is a form rather than a scroll.
              className={WIDE_TYPES.has(property.type) ? 'crm-form__wide' : undefined}
              label={property.label}
              required={property.required}
              hint={property.description ?? undefined}
              error={blamed === property.name ? error?.body.message : undefined}
            >
              <PropertyEditor
                property={property}
                value={values[property.name] ?? null}
                onChange={(next) => setValue(property.name, next)}
                onSubmit={(committed) => { setValue(property.name, committed); void submit(); }}
                users={users}
                invalid={blamed === property.name}
              />
            </Field>
          ))}
        </div>
        <button type="submit" hidden aria-hidden tabIndex={-1}>Create</button>
      </form>
      {editable.length > core.length && (
        <div className="crm-form__more">
          <Switch
            checked={showAll}
            onChange={setShowAll}
            label={showAll ? `Showing all ${editable.length} properties` : `Show all ${editable.length} properties`}
          />
        </div>
      )}
    </Modal>
  );
}

/* -------------------------------- save view ------------------------------- */

export interface SaveViewDialogProps {
  open: boolean;
  onClose: () => void;
  objectType: string;
  /** When set the dialog renames and re-saves that view instead of adding one. */
  existing: ViewDef | null;
  columns: string[];
  filter: FilterNode | null;
  sort: SortSpec[];
  /** Used to name the sort in plain English rather than by database column. */
  properties: PropertyDef[];
  onSaved: (view: ViewDef) => void;
}

export function SaveViewDialog({ open, onClose, objectType, existing, columns, filter, sort, properties, onSaved }: SaveViewDialogProps) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [shared, setShared] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(existing ? existing.name : '');
    setDescription(existing?.description ?? '');
    setShared(existing ? existing.shared : true);
    setError(null);
  }, [open, existing]);

  // The rest of this dialog speaks in labels; the sort badge used to answer in
  // the database's vocabulary — "Sorted by last_activity_at".
  const sortSummary = useMemo(() => {
    const first = sort[0];
    if (!first) return 'Default sort';
    const property = properties.find((p) => p.name === first.property);
    const label = property?.label ?? humanize(first.property);
    const direction = first.direction === 'asc' ? 'ascending' : 'descending';
    const temporal = property?.type === 'date' || property?.type === 'datetime';
    const numeric = property?.type === 'number' || property?.type === 'currency';
    const phrase = temporal
      ? (first.direction === 'asc' ? 'oldest first' : 'newest first')
      : numeric
        ? (first.direction === 'asc' ? 'smallest first' : 'largest first')
        : direction;
    return `Sorted by ${label}, ${phrase}`;
  }, [sort, properties]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const view = existing
        ? await updateView(existing.id, { name, description, columns, filter, sort, shared })
        : await saveView({ object_type: objectType, name, description, columns, filter, sort, shared });
      crmChanged('/v1/views');
      toast.success(existing ? 'View updated' : 'View saved', `“${view.name}” now holds this filter, these columns and this sort.`);
      onSaved(view);
      onClose();
    } catch (e) {
      const err = e as ApiClientError;
      setError(err);
      toast.error('View not saved', err.body.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={existing ? `Update “${existing.name}”` : 'Save this view'}
      description="A view remembers the filter, the columns and the sort — not the rows."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => { void submit(); }}>
            {existing ? 'Save changes' : 'Save view'}
          </Button>
        </>
      }
    >
      <div className="crm-form">
        <Field label="Name" required error={error?.body.param === 'name' ? error.body.message : undefined}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Key accounts in EMEA" autoFocus />
        </Field>
        <Field label="Description" optional>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} minRows={2} placeholder="What this view is for" />
        </Field>
        <Checkbox checked={shared} onChange={setShared} label="Share with the workspace" hint="Everyone sees it in the view bar." />
        {error && !error.body.param && <Banner tone="danger" compact>{errorMessage(error)}</Banner>}
        <div className="crm-viewsummary">
          <Badge tone="neutral" size="sm">{columns.length} columns</Badge>
          <Badge tone={filter ? 'purple' : 'neutral'} size="sm">{filter ? 'Filtered' : 'No filter'}</Badge>
          <Badge tone="neutral" size="sm">{sortSummary}</Badge>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------ bulk actions ------------------------------ */

function BulkOutcome({ done, failed }: { done: number; failed: number }) {
  if (!done && !failed) return null;
  const tone: Tone = failed ? 'warning' : 'success';
  return (
    <Badge tone={tone} size="sm">
      {done} updated{failed ? `, ${failed} refused` : ''}
    </Badge>
  );
}

export function BulkOwnerDialog({ open, onClose, objectType, ids, users, onDone }: {
  open: boolean; onClose: () => void; objectType: string; ids: string[]; users: WorkspaceUser[]; onDone: () => void;
}) {
  const toast = useToast();
  const [ownerId, setOwnerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ done: number; failed: number } | null>(null);

  useEffect(() => { if (open) { setOwnerId(''); setResult(null); } }, [open]);

  const submit = async () => {
    setBusy(true);
    try {
      const outcome = await batchUpdate(objectType, ids.map((id) => ({ id, properties: {}, owner_id: ownerId || null })));
      crmChanged();
      setResult({ done: outcome.updated, failed: outcome.errors });
      const name = users.find((u) => u.id === ownerId)?.name ?? 'nobody';
      if (outcome.errors) toast.warning('Some records kept their owner', `${outcome.updated} moved to ${name}, ${outcome.errors} were refused.`);
      else toast.success('Owner changed', `${outcome.updated} records now belong to ${name}.`);
      onDone();
      if (!outcome.errors) onClose();
    } catch (e) {
      toast.error('Owner not changed', (e as ApiClientError).body.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title="Change owner"
      description={`${ids.length} selected ${ids.length === 1 ? 'record' : 'records'} will move to one teammate.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => { void submit(); }}>Change owner</Button>
        </>
      }
    >
      <div className="crm-form">
        <Field label="New owner">
          <Select
            value={ownerId}
            onChange={setOwnerId}
            options={[{ value: '', label: 'Unassigned' }, ...users.map((u) => ({ value: u.id, label: `${u.name} · ${u.title ?? u.role}` }))]}
          />
        </Field>
        {result && <BulkOutcome done={result.done} failed={result.failed} />}
      </div>
    </Modal>
  );
}

export function BulkPropertyDialog({ open, onClose, objectType, ids, properties, users, onDone }: {
  open: boolean; onClose: () => void; objectType: string; ids: string[];
  properties: PropertyDef[]; users: WorkspaceUser[]; onDone: () => void;
}) {
  const toast = useToast();
  const editable = useMemo(() => editableProperties(properties), [properties]);
  const [name, setName] = useState('');
  const [value, setValue] = useState<PropertyValue>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);

  useEffect(() => { if (open) { setName(editable[0]?.name ?? ''); setValue(null); setError(null); } }, [open, editable]);
  const property = editable.find((p) => p.name === name);

  const submit = async (committed?: PropertyValue) => {
    if (!property || busy) return;
    const next = committed !== undefined ? committed : value;
    setBusy(true);
    setError(null);
    try {
      const outcome = await batchUpdate(objectType, ids.map((id) => ({ id, properties: { [property.name]: next } })));
      crmChanged();
      if (outcome.errors) {
        const first = outcome.results.find((r) => r.status === 'error');
        toast.warning(`${outcome.updated} of ${ids.length} updated`, first?.error?.message ?? 'Some rows were refused.');
      } else {
        toast.success(`${property.label} set on ${outcome.updated} records`, 'Every change is on each record’s timeline.');
        onClose();
      }
      onDone();
    } catch (e) {
      const err = e as ApiClientError;
      setError(err);
      toast.error('Nothing was changed', err.body.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title="Set a property"
      description={`One value written to ${ids.length} ${ids.length === 1 ? 'record' : 'records'}, each with its own history entry.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!property} onClick={() => { void submit(); }}>Update records</Button>
        </>
      }
    >
      <div className="crm-form">
        <Field label="Property">
          <Select
            value={name}
            onChange={(next) => { setName(next); setValue(null); }}
            options={editable.map((p) => ({ value: p.name, label: p.label, group: p.group }))}
          />
        </Field>
        {property && (
          <Field label="New value" error={blamedProperty(error) === property.name ? error?.body.message : undefined}>
            <PropertyEditor
              property={property}
              value={value}
              onChange={setValue}
              onSubmit={(committed) => { setValue(committed); void submit(committed); }}
              users={users}
              invalid={blamedProperty(error) === property.name}
            />
          </Field>
        )}
      </div>
    </Modal>
  );
}

export function BulkLinkDialog({ open, onClose, ids, objectTypeLabel, targetTypes, onDone }: {
  open: boolean; onClose: () => void; ids: string[]; objectTypeLabel: string;
  targetTypes: { name: string; label: string }[]; onDone: () => void;
}) {
  const toast = useToast();
  const [targetType, setTargetType] = useState(targetTypes[0]?.name ?? '');
  const [targetId, setTargetId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) { setTargetType(targetTypes[0]?.name ?? ''); setTargetId(''); } }, [open, targetTypes]);

  const submit = async () => {
    setBusy(true);
    let linked = 0;
    let refused = 0;
    for (const id of ids) {
      try { await associate({ from_id: id, to_id: targetId }); linked++; } catch { refused++; }
    }
    crmChanged();
    setBusy(false);
    if (refused) toast.warning(`${linked} linked, ${refused} refused`, 'A cardinality of one-to-many can hold only a single link.');
    else toast.success(`${linked} ${objectTypeLabel.toLowerCase()} linked`, 'The association shows on both records.');
    onDone();
    if (!refused) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title="Link to a record"
      description={`Associate the ${ids.length} selected ${objectTypeLabel.toLowerCase()} with one record. The association type is inferred from the two object types.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!targetId} onClick={() => { void submit(); }}>Link records</Button>
        </>
      }
    >
      <div className="crm-form">
        <Field label="Link to">
          <Select
            value={targetType}
            onChange={(next) => { setTargetType(next); setTargetId(''); }}
            options={targetTypes.map((t) => ({ value: t.name, label: t.label }))}
          />
        </Field>
        {targetType && (
          <Field label="Which record">
            <RecordPicker objectType={targetType} value={targetId} onChange={setTargetId} label="Record to link to" />
          </Field>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------ log an activity --------------------------- */

const ACTIVITY_META: Record<string, { label: string; icon: ReactNode; verb: string }> = {
  note: { label: 'Note', icon: <Icons.note size={14} />, verb: 'Write a note' },
  call: { label: 'Call', icon: <Icons.phone size={14} />, verb: 'Log a call' },
  meeting: { label: 'Meeting', icon: <Icons.calendar size={14} />, verb: 'Log a meeting' },
  email: { label: 'Email', icon: <Icons.mail size={14} />, verb: 'Log an email' },
  task: { label: 'Task', icon: <CheckCircleIcon size={14} />, verb: 'Create a task' },
};

export const activityMeta = ACTIVITY_META;

export interface LogActivityDialogProps {
  open: boolean;
  onClose: () => void;
  kind: 'note' | 'call' | 'meeting' | 'email' | 'task';
  record: CrmRecord;
  /** Properties of the activity object type — call, meeting, task each differ. */
  properties: PropertyDef[];
  users: WorkspaceUser[];
  onLogged: () => void;
}

const HIDDEN_ACTIVITY_FIELDS = new Set(['subject', 'body', 'occurred_at']);

export function LogActivityDialog({ open, onClose, kind, record, properties, users, onLogged }: LogActivityDialogProps) {
  const toast = useToast();
  const session = useSession();
  const meta = ACTIVITY_META[kind];
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [occurredAt, setOccurredAt] = useState<number>(() => session.now());
  const [extra, setExtra] = useState<Record<string, PropertyValue>>({});
  const extraRef = useRef<Record<string, PropertyValue>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);

  const setExtraValue = useCallback((name: string, next: PropertyValue) => {
    extraRef.current = { ...extraRef.current, [name]: next };
    setExtra(extraRef.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    setSubject('');
    setBody('');
    setOccurredAt(session.now());
    extraRef.current = {};
    setExtra({});
    setError(null);
  }, [open, kind, session]);

  const detailProperties = useMemo(
    () => properties.filter((p) => !HIDDEN_ACTIVITY_FIELDS.has(p.name) && !p.read_only && !p.hidden),
    [properties],
  );

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(extraRef.current)) {
        if (value === '' || value === null || value === undefined) continue;
        payload[key] = value;
      }
      await logActivity(record.object_type, record.id, {
        type: kind,
        subject: subject.trim() || undefined,
        body: body.trim() || undefined,
        occurred_at: occurredAt,
        properties: Object.keys(payload).length ? payload : undefined,
      });
      crmChanged();
      toast.success(`${meta.label} logged`, `It is on ${record.display_name}’s timeline.`);
      onLogged();
      onClose();
    } catch (e) {
      const err = e as ApiClientError;
      setError(err);
      toast.error(`${meta.label} not logged`, err.body.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={meta.verb}
      description={`On ${record.display_name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => { void submit(); }}>{meta.verb}</Button>
        </>
      }
    >
      {error && !blamedProperty(error) && <Banner tone="danger" compact>{errorMessage(error)}</Banner>}
      <div className="crm-form">
        <Field label={kind === 'task' ? 'What needs doing' : 'Subject'} required={kind === 'task'}>
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
            placeholder={kind === 'call' ? 'Discovery call — pilot scope' : kind === 'task' ? 'Send the pilot SOW' : 'Subject'}
            autoFocus
          />
        </Field>
        <Field label={kind === 'email' ? 'Body' : 'Notes'} optional>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} minRows={4} placeholder="What was said, what happens next" />
        </Field>
        <div className="crm-form__grid">
          {detailProperties.map((property) => (
            <Field
              key={property.name}
              label={property.label}
              optional={!property.required}
              error={blamedProperty(error) === property.name ? error?.body.message : undefined}
            >
              <PropertyEditor
                property={property}
                value={extra[property.name] ?? null}
                onChange={(next) => setExtraValue(property.name, next)}
                onSubmit={(committed) => { setExtraValue(property.name, committed); void submit(); }}
                users={users}
                invalid={blamedProperty(error) === property.name}
              />
            </Field>
          ))}
        </div>
        <Field label="When" hint="Backdate it if this happened earlier — the timeline orders on this.">
          <Input
            type="datetime-local"
            value={toLocalInput(occurredAt)}
            onChange={(e) => {
              const parsed = Date.parse(e.target.value);
              if (Number.isFinite(parsed)) setOccurredAt(parsed);
            }}
            aria-label="When this happened"
          />
        </Field>
      </div>
    </Modal>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
function toLocalInput(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ------------------------------ inline property --------------------------- */

export interface InlinePropertyProps {
  record: CrmRecord;
  property: PropertyDef;
  users: WorkspaceUser[];
  userIndex: Map<string, WorkspaceUser>;
  onSaved: () => void;
}

/**
 * A property row that turns into its own editor. Read-only, calculated and
 * rollup properties never do — they say where their value comes from instead,
 * which is the difference between "you may not" and "nothing happened".
 */
export function InlineProperty({ record, property, users, userIndex, onSaved }: InlinePropertyProps) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<PropertyValue>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
  const stored = record.properties[property.name] ?? null;
  const derived = !!property.calculated || !!property.rollup;
  const locked = property.read_only || derived || property.type === 'computed';

  const start = () => {
    if (locked) return;
    setDraft(stored);
    setError(null);
    setEditing(true);
  };

  /**
   * `committed` is the value the editor handed over with the keystroke that
   * submitted. Reading `draft` instead would read one render behind for the
   * number and money fields, which is how a typed value used to vanish on
   * Enter with no PATCH and no word about it.
   */
  const commit = async (committed?: PropertyValue) => {
    const next = committed !== undefined ? committed : draft;
    if (sameValue(next, stored)) {
      setEditing(false);
      toast.info(`${property.label} is unchanged`, 'Nothing was written — the value is what it already was.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await patchRecord(record.object_type, record.id, { properties: { [property.name]: next } });
      crmChanged();
      toast.success(`${property.label} updated`, 'The change is on the timeline with your name on it.');
      setEditing(false);
      onSaved();
    } catch (e) {
      const err = e as ApiClientError;
      setError(err);
      toast.error(`${property.label} not saved`, err.body.message);
    } finally {
      setBusy(false);
    }
  };

  const hint = property.rollup
    ? `Rollup · ${property.rollup.aggregate} of ${property.rollup.property ?? 'records'} across ${property.rollup.association}`
    : property.calculated
      ? `Calculated · ${property.calculated}`
      : property.read_only ? 'Maintained by the platform' : null;

  if (editing) {
    return (
      <div className="crm-prop crm-prop--editing">
        <span className="crm-prop__label" id={`prop-${property.name}`}>{property.label}</span>
        <div className="crm-prop__editor">
          <PropertyEditor
            property={property}
            value={draft}
            onChange={setDraft}
            users={users}
            autoFocus
            invalid={!!error}
            id={`edit-${property.name}`}
            onSubmit={(committed) => { void commit(committed); }}
            onCancel={() => setEditing(false)}
          />
          <div className="crm-prop__actions">
            <Button size="sm" variant="primary" loading={busy} onClick={() => { void commit(); }}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
          </div>
          {error && <p className="crm-prop__error" role="alert">{error.body.message}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className={`crm-prop${locked ? ' is-locked' : ''}`}>
      <span className="crm-prop__label">
        {property.label}
        {hint && (
          <Tooltip content={hint}>
            <span className="crm-prop__badge" tabIndex={0} role="note" aria-label={hint}>
              {property.rollup ? <Icons.funnel size={11} /> : property.calculated ? <Icons.code size={11} /> : <Icons.lock size={11} />}
            </span>
          </Tooltip>
        )}
      </span>
      {locked ? (
        <span className="crm-prop__value">
          <ValueView property={property} value={stored} users={userIndex} />
        </span>
      ) : (
        <button
          type="button"
          className="crm-prop__value crm-prop__value--editable"
          onClick={start}
          aria-label={`Edit ${property.label}`}
        >
          <ValueView property={property} value={stored} users={userIndex} />
          <Icons.edit size={12} className="crm-prop__pencil" />
        </button>
      )}
    </div>
  );
}
