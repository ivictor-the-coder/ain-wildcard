/**
 * One property, read and written.
 *
 * A CRM property is not a string: it is a typed slot with a currency, an
 * option list, a formula or an aggregate behind it. Everything on a record
 * page and in a list cell goes through here so that money is money in every
 * one of them — a $80,000 deal is never 8000000 on screen — and so that the
 * editor an operator gets is the one the type deserves.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Avatar, Badge, Combobox, DatePicker, Icons, Input, MoneyInput, NumberInput, Select,
  Switch, Textarea, Tooltip, humanize, pluralize, useFormat, type ComboOption, type Tone,
} from '@/client/design';
import { api, useQuery } from '@/client/kernel/api';
import { useSession } from '@/client/kernel/session';
import type { CrmRecord, PropertyDef, PropertyValue, WorkspaceUser } from './api';

/* --------------------------------- colour --------------------------------- */

/** Option colours are stored as palette names; the badge speaks in tones. */
const OPTION_TONE: Record<string, Tone> = {
  violet: 'purple', indigo: 'purple', purple: 'purple',
  blue: 'info', sky: 'info', cyan: 'teal', teal: 'teal',
  green: 'success', emerald: 'success', lime: 'success',
  amber: 'warning', orange: 'warning', yellow: 'warning',
  red: 'danger', rose: 'danger',
  pink: 'pink', magenta: 'pink',
  gray: 'neutral', grey: 'neutral', slate: 'neutral', brand: 'brand',
};

export const optionTone = (color: string | undefined): Tone =>
  (color ? OPTION_TONE[color.toLowerCase()] : undefined) ?? 'neutral';

export const optionOf = (property: PropertyDef, value: unknown) =>
  property.options.find((o) => o.value === String(value));

export const optionLabel = (property: PropertyDef, value: unknown): string =>
  optionOf(property, value)?.label ?? humanize(String(value));

/**
 * A year is a label, not a quantity. Grouped, `founded_year` reads "1,989" —
 * a number the eye has to stop and decode — sitting directly under a headcount
 * that genuinely is one.
 */
export const isYearProperty = (property: PropertyDef | undefined): boolean =>
  !!property && property.type === 'number' && /(^|_)year$/.test(property.name);

/* -------------------------------- accessors ------------------------------- */

/** The sortable, searchable primitive behind a cell. */
export function cellValue(property: PropertyDef | undefined, value: PropertyValue): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  if (!property) return value;
  if (property.type === 'enum') return optionLabel(property, value);
  return value;
}

/**
 * What a CSV cell holds. Money stays a decimal and instants stay ISO-8601 so
 * the file re-imports, but a picklist carries the label the grid showed —
 * exporting `latam` under a column headed "Sales region" hands the reader a
 * mapping the UI already knows and makes them rebuild it.
 */
export function exportValue(
  property: PropertyDef | undefined,
  value: PropertyValue,
  users?: Map<string, WorkspaceUser>,
): string {
  if (value === null || value === undefined) return '';
  if (property?.type === 'enum' && !Array.isArray(value)) return optionLabel(property, value);
  if (property?.type === 'multi_enum') {
    const many = Array.isArray(value) ? value : [String(value)];
    return many.map((v) => optionLabel(property, v)).join('; ');
  }
  if (property?.type === 'user' && typeof value === 'string') return users?.get(value)?.name ?? value;
  if (property?.type === 'bool') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.join('; ');
  if (typeof value === 'object') return JSON.stringify(value);
  if (property?.type === 'currency') return String(Number(value) / 100);
  if (property && (property.type === 'date' || property.type === 'datetime') && typeof value === 'number') {
    return new Date(value).toISOString();
  }
  return String(value);
}

/* ------------------------------- rendering -------------------------------- */

export function UserChip({ user, id, size = 20 }: { user: WorkspaceUser | undefined; id: string | null; size?: number }) {
  if (!id) return <span className="crm-muted">Unassigned</span>;
  return (
    <span className="crm-userchip">
      <Avatar name={user?.name ?? id} seed={id} size={size} />
      <span className="u-truncate">{user?.name ?? id}</span>
    </span>
  );
}

/** A `reference` property points at another record; show its name, not its id. */
function ReferenceLabel({ objectType, id }: { objectType: string; id: string }) {
  const { data, error } = useQuery<CrmRecord>(`/v1/records/${objectType}/${id}`);
  if (error) return <span className="u-mono crm-muted">{id}</span>;
  return <a className="crm-link" href={`/records/${objectType}/${id}`}>{data?.display_name ?? id}</a>;
}

export interface ValueViewProps {
  property: PropertyDef | undefined;
  value: PropertyValue;
  users?: Map<string, WorkspaceUser>;
  /** Cell rendering trims long text; a record panel shows the whole thing. */
  compact?: boolean;
}

export function ValueView({ property, value, users, compact }: ValueViewProps) {
  const f = useFormat();
  const session = useSession();
  if (value === null || value === undefined || value === '') return <span className="crm-muted">—</span>;
  const type = property?.type ?? 'string';

  switch (type) {
    case 'currency': {
      const currency = property?.currency ?? session.currency;
      return <span className="crm-num">{f.money(Number(value), { currency })}</span>;
    }
    case 'number':
      return (
        <span className="crm-num">
          {isYearProperty(property) ? String(Math.trunc(Number(value))) : f.number(Number(value))}
        </span>
      );
    case 'date':
      return <span>{f.date(Number(value), { timeZone: 'UTC' })}</span>;
    case 'datetime':
      return <Tooltip content={f.dateTime(Number(value))}><span>{compact ? f.relative(Number(value)) : f.dateTime(Number(value))}</span></Tooltip>;
    case 'bool':
      return value
        ? <Badge tone="success" size="sm" icon={<Icons.check size={11} />}>Yes</Badge>
        : <Badge tone="neutral" size="sm">No</Badge>;
    case 'enum': {
      const option = property ? optionOf(property, value) : undefined;
      return <Badge tone={optionTone(option?.color)} size="sm" dot>{option?.label ?? humanize(String(value))}</Badge>;
    }
    case 'multi_enum': {
      const values = Array.isArray(value) ? value : [String(value)];
      return (
        <span className="crm-chips">
          {values.map((v) => {
            const option = property ? optionOf(property, v) : undefined;
            return <Badge key={v} tone={optionTone(option?.color)} size="sm">{option?.label ?? humanize(v)}</Badge>;
          })}
        </span>
      );
    }
    case 'user':
      return <UserChip id={String(value)} user={users?.get(String(value))} />;
    case 'reference':
      return property?.reference_type
        ? <ReferenceLabel objectType={property.reference_type} id={String(value)} />
        : <span className="u-mono">{String(value)}</span>;
    case 'email':
      return <a className="crm-link" href={`mailto:${String(value)}`}>{String(value)}</a>;
    case 'phone':
      return <a className="crm-link" href={`tel:${String(value).replace(/[^+\d]/g, '')}`}>{String(value)}</a>;
    case 'url':
      return (
        <a className="crm-link" href={String(value)} target="_blank" rel="noreferrer">
          {String(value).replace(/^https?:\/\/(www\.)?/, '')}
        </a>
      );
    case 'json':
      return <code className="crm-code">{JSON.stringify(value)}</code>;
    case 'text':
      return <span className={compact ? 'u-truncate' : 'crm-longtext'}>{String(value)}</span>;
    default:
      return <span className={compact ? 'u-truncate' : undefined}>{String(value)}</span>;
  }
}

/* -------------------------------- editing --------------------------------- */

export interface EditorProps {
  property: PropertyDef;
  value: PropertyValue;
  onChange: (next: PropertyValue) => void;
  users: WorkspaceUser[];
  invalid?: boolean;
  autoFocus?: boolean;
  /**
   * Carries the value the editor is committing. Enter inside a number or money
   * field runs that field's own commit first — which only *queues* the caller's
   * `onChange` — so a submit handler that reads its own state reads the value
   * from before the keystroke. Handing the value along closes that window.
   */
  onSubmit?: (committed: PropertyValue) => void;
  onCancel?: () => void;
  id?: string;
}

const userOptions = (users: WorkspaceUser[]): ComboOption[] =>
  users.map((u) => ({ value: u.id, label: u.name, description: u.title ?? u.email }));

/** The control a property type earns. Nothing here writes; the caller commits. */
export function PropertyEditor({ property, value, onChange, users, invalid, autoFocus, onSubmit, onCancel, id }: EditorProps) {
  const session = useSession();
  // The last value that went through `onChange`, remembered synchronously so
  // Enter submits what was typed rather than what React has re-rendered so far.
  const latest = useRef<PropertyValue>(value);
  useEffect(() => { latest.current = value; }, [value]);
  const emit = useCallback((next: PropertyValue) => { latest.current = next; onChange(next); }, [onChange]);

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && property.type !== 'text') { e.preventDefault(); onSubmit?.(latest.current); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel?.(); }
  };
  const options = useMemo<ComboOption[]>(
    () => property.options.map((o) => ({ value: o.value, label: o.label, description: o.description })),
    [property.options],
  );

  switch (property.type) {
    case 'currency':
      return (
        <MoneyInput
          id={id}
          value={value === null || value === undefined || value === '' ? null : Number(value)}
          onChange={(minor) => emit(minor)}
          currency={property.currency ?? session.currency}
          locale={session.locale}
          autoFocus={autoFocus}
          invalid={invalid}
          onKeyDown={keys}
          aria-label={property.label}
        />
      );
    case 'number':
      return (
        <NumberInput
          id={id}
          value={value === null || value === undefined || value === '' ? null : Number(value)}
          onChange={(n) => emit(n)}
          autoFocus={autoFocus}
          invalid={invalid}
          onKeyDown={keys}
          aria-label={property.label}
        />
      );
    case 'date':
    case 'datetime':
      return (
        <DatePicker
          id={id}
          value={value === null || value === undefined || value === '' ? null : Number(value)}
          onChange={(ts) => { emit(ts); }}
          invalid={invalid}
          aria-label={property.label}
        />
      );
    case 'bool':
      return (
        <Switch
          checked={value === true || value === 'true' || value === 1}
          onChange={(next) => emit(next)}
          label={property.label}
        />
      );
    case 'enum':
      return (
        <Combobox
          id={id}
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(next) => emit(next || null)}
          options={options}
          placeholder={`Choose ${property.label.toLowerCase()}`}
          invalid={invalid}
          aria-label={property.label}
        />
      );
    case 'multi_enum':
      return (
        <Combobox
          id={id}
          multiple
          value={Array.isArray(value) ? value : value ? [String(value)] : []}
          onChange={(next) => emit(next as string[])}
          options={options}
          placeholder={`Choose ${property.label.toLowerCase()}`}
          invalid={invalid}
          aria-label={property.label}
        />
      );
    case 'user':
      return (
        <Combobox
          id={id}
          value={value ? String(value) : ''}
          onChange={(next) => emit(next || null)}
          options={userOptions(users)}
          placeholder="Choose a teammate"
          invalid={invalid}
          aria-label={property.label}
        />
      );
    case 'reference':
      return (
        <RecordPicker
          id={id}
          objectType={property.reference_type ?? 'company'}
          value={value ? String(value) : ''}
          onChange={(next) => emit(next || null)}
          label={property.label}
          invalid={invalid}
        />
      );
    case 'text':
      return (
        <Textarea
          id={id}
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(e) => emit(e.target.value)}
          autosize
          minRows={3}
          autoFocus={autoFocus}
          invalid={invalid}
          onKeyDown={keys}
          aria-label={property.label}
        />
      );
    case 'json':
      return (
        <Textarea
          id={id}
          value={typeof value === 'string' ? value : JSON.stringify(value ?? null)}
          onChange={(e) => emit(e.target.value)}
          autosize
          className="u-mono"
          invalid={invalid}
          aria-label={property.label}
        />
      );
    default:
      return (
        <Input
          id={id}
          type={property.type === 'email' ? 'email' : property.type === 'url' ? 'url' : property.type === 'phone' ? 'tel' : 'text'}
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(e) => emit(e.target.value)}
          autoFocus={autoFocus}
          invalid={invalid}
          onKeyDown={keys}
          aria-label={property.label}
        />
      );
  }
}

/* ------------------------------ record picker ----------------------------- */

export interface RecordPickerProps {
  objectType: string;
  value: string;
  onChange: (id: string) => void;
  label: string;
  invalid?: boolean;
  id?: string;
  /** Ids already linked — offered but marked, so nobody links twice. */
  exclude?: string[];
}

/**
 * Search-as-you-type over one object type. It asks the same list endpoint the
 * grid uses, so anything findable in a list is findable here.
 */
export function RecordPicker({ objectType, value, onChange, label, invalid, id, exclude }: RecordPickerProps) {
  const [seed, setSeed] = useState<ComboOption[]>([]);
  const { data } = useQuery<{ data: CrmRecord[] }>(`/v1/records/${objectType}`, { limit: 8 });
  const initial = useMemo<ComboOption[]>(
    () => (data?.data ?? []).map((r) => ({ value: r.id, label: r.display_name, description: r.id })),
    [data],
  );
  const excluded = useMemo(() => new Set(exclude ?? []), [exclude]);

  return (
    <Combobox
      id={id}
      value={value}
      onChange={(next) => onChange(next)}
      options={seed.length ? seed : initial}
      onSearch={async (query) => {
        // Through the kernel client, so a 401 or a 429 becomes the same visible
        // failure as everywhere else instead of an empty list that looks like
        // "no such record".
        const body = await api.get<{ data: CrmRecord[] }>(`/v1/records/${objectType}`, {
          limit: 12,
          ...(query ? { q: query } : {}),
        });
        const found = body.data.map((r) => ({
          value: r.id,
          label: r.display_name,
          description: excluded.has(r.id) ? 'Already linked' : r.id,
          disabled: excluded.has(r.id),
        }));
        setSeed(found);
        return found;
      }}
      placeholder={`Search ${pluralize(humanize(objectType).toLowerCase(), 2)}…`}
      emptyMessage={`No ${humanize(objectType).toLowerCase()} matches that`}
      invalid={invalid}
      aria-label={label}
    />
  );
}
