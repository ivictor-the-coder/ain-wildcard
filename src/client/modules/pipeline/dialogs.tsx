/**
 * Every write the deal surface can make.
 *
 * The forms are generated from `/v1/objects/deal/properties`, so a property a
 * workspace admin adds this afternoon gets an input here without a line being
 * written for it — and a validation error comes back bound to the `param` the
 * server named, under the control it belongs to.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, invalidate, useMutation, type ApiClientError, type ListEnvelope } from '@/client/kernel/api';
import { useSession } from '@/client/kernel/session';
import {
  Badge, Banner, Button, Combobox, DatePicker, Field, Input, Modal, MoneyInput, NumberInput,
  Select, Textarea, humanize, useFormat, useToast, type ComboOption, type SelectOption,
} from '@/client/design';
import {
  emptyValue, num, reasonOptions, stageRequirements, str, useDealFormat, useOutcomeSplit,
  type DealRecord, type Pipeline, type PipelineStage, type PropertyDef, type PropertyOption,
  type WorkspaceUser,
} from './api';

/* ------------------------------ value editors ----------------------------- */

export type Draft = Record<string, unknown>;

/** The control a property's declared type asks for. */
export function PropertyInput({
  property, value, onChange, currency, autoFocus, invalid, options,
}: {
  property: PropertyDef;
  value: unknown;
  onChange: (value: unknown) => void;
  currency: string;
  autoFocus?: boolean;
  invalid?: boolean;
  /** Narrows an enum's choices — a closing stage only offers its own outcome's reasons. */
  options?: PropertyOption[];
}) {
  const session = useSession();
  const label = property.label;
  const choices = options ?? property.options;
  switch (property.type) {
    case 'currency':
      return (
        <MoneyInput
          value={typeof value === 'number' ? value : null}
          onChange={(minor) => onChange(minor)}
          currency={property.currency ?? currency}
          locale={session.locale}
          autoFocus={autoFocus}
          invalid={invalid}
          aria-label={label}
        />
      );
    case 'number':
      return (
        <NumberInput
          value={typeof value === 'number' ? value : null}
          onChange={(next) => onChange(next)}
          autoFocus={autoFocus}
          invalid={invalid}
          aria-label={label}
        />
      );
    case 'date':
    case 'datetime':
      return (
        <DatePicker
          value={typeof value === 'number' ? value : null}
          onChange={(ts) => onChange(ts)}
          invalid={invalid}
          aria-label={label}
        />
      );
    case 'enum':
      return (
        <Select
          value={str(value)}
          onChange={(next) => onChange(next || null)}
          invalid={invalid}
          options={[
            { value: '', label: `— no ${label.toLowerCase()} —` },
            ...choices.map<SelectOption>((option) => ({ value: option.value, label: option.label })),
          ]}
          aria-label={label}
        />
      );
    case 'bool':
    case 'boolean':
      return (
        <Select
          value={value === true ? 'true' : value === false ? 'false' : ''}
          onChange={(next) => onChange(next === '' ? null : next === 'true')}
          options={[{ value: '', label: '—' }, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]}
          aria-label={label}
        />
      );
    case 'text':
      return (
        <Textarea
          value={str(value)}
          onChange={(e) => onChange(e.target.value)}
          autosize
          maxRows={8}
          invalid={invalid}
          autoFocus={autoFocus}
          aria-label={label}
        />
      );
    default:
      return (
        <Input
          value={str(value)}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          invalid={invalid}
          aria-label={label}
        />
      );
  }
}

/** Errors the server raised, keyed by the `param` it named. */
export const errorFor = (error: ApiClientError | null, param: string): string | null => {
  if (!error) return null;
  const named = error.body.param;
  if (!named) return null;
  return named === param || named === `properties.${param}` ? error.body.message : null;
};

/** The message that belongs nowhere in particular — shown above the form. */
export const unboundError = (error: ApiClientError | null, params: string[]): string | null => {
  if (!error) return null;
  const named = error.body.param?.replace(/^properties\./, '');
  if (named && params.includes(named)) return null;
  return error.body.message;
};

/* ------------------------------- new deal --------------------------------- */

export interface CompanyOption { id: string; display_name: string }

export function NewDealDialog({
  open, onClose, pipelines, properties, users, defaultPipeline, defaultStage, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  pipelines: Pipeline[];
  properties: PropertyDef[];
  users: WorkspaceUser[];
  defaultPipeline?: string;
  defaultStage?: string;
  onCreated: (deal: DealRecord) => void;
}) {
  const session = useSession();
  const toast = useToast();
  const f = useFormat();
  const [name, setName] = useState('');
  const [pipeline, setPipeline] = useState(defaultPipeline ?? '');
  const [stage, setStage] = useState(defaultStage ?? '');
  const [amount, setAmount] = useState<number | null>(null);
  const [closeDate, setCloseDate] = useState<number | null>(null);
  const [ownerId, setOwnerId] = useState<string>(session.me?.user?.id ?? '');
  const [companyId, setCompanyId] = useState('');
  const [extra, setExtra] = useState<Draft>({});
  const nameRef = useRef<HTMLInputElement>(null);

  const chosen = pipelines.find((p) => p.name === pipeline) ?? pipelines.find((p) => p.is_default) ?? pipelines[0];
  const openStages = useMemo(() => (chosen?.stages ?? []).filter((s) => !s.is_closed), [chosen]);
  const chosenStage = openStages.find((s) => s.name === stage) ?? openStages[0];

  useEffect(() => {
    if (!open) return;
    setName('');
    setAmount(null);
    setCloseDate(null);
    setCompanyId('');
    setExtra({});
    setOwnerId(session.me?.user?.id ?? '');
    setPipeline(defaultPipeline ?? pipelines.find((p) => p.is_default)?.name ?? pipelines[0]?.name ?? '');
    setStage(defaultStage ?? '');
  }, [open, defaultPipeline, defaultStage, pipelines, session.me]);

  // Optional-but-useful fields, taken from the object definition rather than
  // listed here, so a workspace's own deal properties appear on this form.
  const optional = useMemo(
    () => properties.filter((p) =>
      !p.read_only && !p.calculated && !p.required
      && !['pipeline', 'deal_stage', 'close_date', 'name', 'amount'].includes(p.name)
      && p.group.toLowerCase() !== 'outcome'),
    [properties],
  );

  const create = useMutation<void, DealRecord>(async () => {
    const props: Draft = { name: name.trim(), amount, pipeline: chosen?.name, deal_stage: chosenStage?.name };
    if (closeDate !== null) props.close_date = closeDate;
    for (const [key, value] of Object.entries(extra)) if (!emptyValue(value)) props[key] = value;
    return api.post<DealRecord>('/v1/records/deal', {
      properties: props,
      owner_id: ownerId || null,
      ...(companyId ? { associate_to: [companyId] } : {}),
    });
  }, {
    invalidates: ['/v1/records/deal', '/v1/pipelines', '/v1/crm/overview'],
    onSuccess: (deal) => {
      toast.success(
        'Deal created',
        `${deal.display_name} is in ${chosenStage?.label ?? 'the first stage'} at ${f.money(num(deal.properties.amount))}.`,
      );
      onCreated(deal);
      onClose();
    },
    onError: (e) => { if (!e.body.param) toast.error('The deal was not created', e.body.message); },
  });

  const searchCompanies = async (query: string): Promise<ComboOption[]> => {
    const page = await api.get<ListEnvelope<CompanyOption>>('/v1/records/company', { q: query, limit: 8 });
    return page.data.map((row) => ({ value: row.id, label: row.display_name, description: row.id }));
  };

  const params = ['name', 'amount', 'pipeline', 'deal_stage', 'close_date', 'owner_id', ...optional.map((p) => p.name)];
  const banner = unboundError(create.error, params);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="New deal"
      description="An opportunity, in a pipeline, on a stage — the forecast follows from those three."
      initialFocus={nameRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={create.loading}
            disabled={!name.trim() || amount === null || !chosen || !chosenStage}
            onClick={() => { void create.run().catch(() => undefined); }}
          >
            Create deal
          </Button>
        </>
      }
    >
      <form
        className="pl-form"
        onSubmit={(e) => { e.preventDefault(); void create.run().catch(() => undefined); }}
      >
        {banner && <Banner tone="danger" title="The deal was not created">{banner}</Banner>}

        <Field label="Deal name" required error={errorFor(create.error, 'name')}>
          <Input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Rheinwerk Antriebstechnik — OEE programme phase 2"
          />
        </Field>

        <div className="pl-form__row">
          <Field label="Pipeline" required error={errorFor(create.error, 'pipeline')}>
            <Select
              value={chosen?.name ?? ''}
              onChange={(next) => { setPipeline(next); setStage(''); }}
              options={pipelines.map<SelectOption>((p) => ({ value: p.name, label: p.label }))}
            />
          </Field>
          <Field
            label="Stage"
            required
            hint={chosenStage ? `Carries a ${chosenStage.probability}% probability` : undefined}
            error={errorFor(create.error, 'deal_stage')}
          >
            <Select
              value={chosenStage?.name ?? ''}
              onChange={setStage}
              options={openStages.map<SelectOption>((s) => ({ value: s.name, label: `${s.label} · ${s.probability}%` }))}
            />
          </Field>
        </div>

        <div className="pl-form__row">
          <Field label="Amount" required error={errorFor(create.error, 'amount')}>
            <MoneyInput value={amount} onChange={setAmount} currency={session.currency} locale={session.locale} aria-label="Amount" />
          </Field>
          <Field label="Close date" error={errorFor(create.error, 'close_date')}>
            <DatePicker value={closeDate} onChange={setCloseDate} aria-label="Close date" />
          </Field>
        </div>

        <div className="pl-form__row">
          <Field label="Account" hint="The company this deal belongs to." error={errorFor(create.error, 'associate_to')}>
            <Combobox
              value={companyId}
              onChange={(next) => setCompanyId(Array.isArray(next) ? next[0] ?? '' : next)}
              onSearch={searchCompanies}
              placeholder="Search companies…"
              emptyMessage="No company matches that."
              aria-label="Account"
            />
          </Field>
          <Field label="Owner" error={errorFor(create.error, 'owner_id')}>
            <Select
              value={ownerId}
              onChange={setOwnerId}
              options={[
                { value: '', label: 'Unassigned' },
                ...users.map<SelectOption>((user) => ({ value: user.id, label: user.name })),
              ]}
            />
          </Field>
        </div>

        {optional.length > 0 && (
          <details className="pl-details">
            <summary>More deal properties ({optional.length})</summary>
            <div className="pl-form" style={{ marginTop: 'var(--space-5)' }}>
              {optional.map((property) => (
                <Field key={property.name} label={property.label} optional error={errorFor(create.error, property.name)}>
                  <PropertyInput
                    property={property}
                    value={extra[property.name]}
                    onChange={(value) => setExtra((prev) => ({ ...prev, [property.name]: value }))}
                    currency={session.currency}
                    invalid={!!errorFor(create.error, property.name)}
                  />
                </Field>
              ))}
            </div>
          </details>
        )}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}

/* ----------------------------- stage movement ----------------------------- */

/**
 * The confirmation a stage move gets when the destination asks for something.
 *
 * It always states what the move does to the forecast — probability, category
 * and status all follow the stage — and collects whatever `stageRequirements`
 * says is missing, writing it in the same PATCH as the stage itself.
 */
export function StageMoveDialog({
  open, deal, from, to, properties, onClose, onMoved,
}: {
  open: boolean;
  deal: DealRecord | null;
  from: PipelineStage | undefined;
  to: PipelineStage | null;
  properties: PropertyDef[];
  onClose: () => void;
  onMoved: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  const f = useDealFormat();
  const [draft, setDraft] = useState<Draft>({});
  const [closeDate, setCloseDate] = useState<number | null>(null);

  const requirements = useMemo(
    () => (to ? stageRequirements(deal, to, properties) : { required: [], optional: [] }),
    [deal, to, properties],
  );

  // The picklists are only narrowed for a closing move, so the split is only
  // learned when one is on screen.
  const split = useOutcomeSplit(properties, open && !!to?.is_closed);
  const outcome = to?.is_won ? 'won' : 'lost';

  // A deal that is already closed keeps the day it closed on; a fresh close gets
  // the workspace's civil today, written explicitly so the server does not
  // restamp it from a UTC midnight that can fall on the wrong side of a month.
  const alreadyClosed = !emptyValue(deal?.properties.closed_at);
  const stampsClose = !!to?.is_closed && !alreadyClosed;

  // A number, not the formatter object, so the reset runs when the dialog opens
  // rather than on every render that happens to make a new formatter.
  const today = f.calendarToday();
  useEffect(() => {
    if (!open) return;
    setDraft({});
    setCloseDate(today);
  }, [open, deal?.id, to?.name, today]);

  const missing = requirements.required.filter((property) => emptyValue(draft[property.name]));

  const move = useMutation<void, DealRecord>(async () => {
    if (!deal || !to) throw new Error('no deal');
    const props: Draft = { deal_stage: to.name };
    for (const [key, value] of Object.entries(draft)) if (!emptyValue(value)) props[key] = value;
    if (stampsClose && closeDate !== null) props.close_date = closeDate;
    return api.patch<DealRecord>(`/v1/records/deal/${encodeURIComponent(deal.id)}`, { properties: props });
  }, {
    invalidates: ['/v1/records/deal', '/v1/pipelines', '/v1/crm/overview'],
    onSuccess: (updated) => {
      toast.success(
        `Moved to ${to?.label}`,
        `${updated.display_name} now forecasts ${f.money(num(updated.properties.weighted_amount))} at ${num(updated.properties.probability)}%.`,
      );
      onMoved();
      onClose();
    },
    onError: (e) => { if (!e.body.param) toast.error('The stage did not change', e.body.message); },
  });

  if (!to) return null;
  const amount = deal ? num(deal.properties.amount) : 0;
  const params = [...requirements.required, ...requirements.optional].map((p) => p.name);
  const banner = unboundError(move.error, [...params, 'deal_stage', 'close_date']);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={`Move to ${to.label}`}
      description={deal?.display_name}
      icon={<Badge tone={to.is_won ? 'success' : to.is_closed ? 'danger' : 'info'} size="sm">{to.probability}%</Badge>}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant={to.is_closed && !to.is_won ? 'danger' : 'primary'}
            loading={move.loading}
            disabled={missing.length > 0}
            onClick={() => { void move.run().catch(() => undefined); }}
          >
            {to.is_won ? 'Mark won' : to.is_closed ? 'Mark closed' : `Move to ${to.label}`}
          </Button>
        </>
      }
    >
      <div className="pl-form">
        {banner && <Banner tone="danger" title="The stage did not change">{banner}</Banner>}

        <div className="pl-movesummary">
          <span>
            Probability <strong>{from ? `${from.probability}%` : '—'}</strong> → <strong>{to.probability}%</strong>
          </span>
          <span>
            Weighted <strong>{f.money(Math.round((amount * (from?.probability ?? 0)) / 100))}</strong>
            {' → '}
            <strong>{f.money(Math.round((amount * to.probability) / 100))}</strong>
          </span>
          <span>
            Forecast <strong>{humanize(from?.forecast_category ?? '—')}</strong> → <strong>{humanize(to.forecast_category ?? '—')}</strong>
          </span>
        </div>

        {to.description && <p className="pl-note">{to.description}</p>}

        {requirements.required.length > 0 && (
          <Banner tone="warning" title={`${to.label} needs ${requirements.required.length === 1 ? 'one more field' : `${requirements.required.length} more fields`}`}>
            The workspace requires {requirements.required.map((p) => p.label).join(', ')} on a deal in this stage.
            It is written with the stage change, in one save.
          </Banner>
        )}

        {[...requirements.required, ...requirements.optional].map((property) => {
          const narrowed = to.is_closed && property.type === 'enum' && property.group.toLowerCase() === 'outcome'
            ? reasonOptions(property, outcome, split)
            : null;
          return (
            <Field
              key={property.name}
              label={property.label}
              required={requirements.required.some((p) => p.name === property.name)}
              optional={!requirements.required.some((p) => p.name === property.name)}
              hint={narrowed
                ? `Only the reasons ${outcome === 'won' ? 'a win' : 'a loss'} can carry${narrowed.learned ? `, learned from the ${f.plural(split.sampled, 'deal')} this workspace has already closed` : ''}.`
                : property.description ?? undefined}
              error={errorFor(move.error, property.name)}
            >
              <PropertyInput
                property={property}
                options={narrowed?.options}
                value={draft[property.name] ?? deal?.properties[property.name]}
                onChange={(value) => setDraft((prev) => ({ ...prev, [property.name]: value }))}
                currency={session.currency}
                invalid={!!errorFor(move.error, property.name)}
              />
            </Field>
          );
        })}

        {stampsClose && (
          <Field
            label="Close date"
            hint={`${to.is_won ? 'The day this deal books.' : 'The day it was lost.'} ${closeDate === null ? 'Leave it empty and the server stamps today.' : `${f.calendarDate(closeDate)} — ${f.calendarRelative(closeDate)}.`}`}
            error={errorFor(move.error, 'close_date')}
          >
            <DatePicker
              value={closeDate}
              onChange={setCloseDate}
              invalid={!!errorFor(move.error, 'close_date')}
              aria-label="Close date"
            />
          </Field>
        )}

        {to.is_closed && alreadyClosed && (
          <p className="pl-note">
            This deal already closed on {f.calendarDate(typeof deal?.properties.close_date === 'number' ? deal.properties.close_date : null)},
            so that date stands. Edit it from the deal’s properties if it was wrong.
          </p>
        )}
      </div>
    </Modal>
  );
}

/* ---------------------------- pipeline movement --------------------------- */

/**
 * Move a deal onto a different pipeline.
 *
 * A deal opened as new business that turns out to be a renewal is a real thing
 * that happens, and until now the only way to correct it was the API: the stage
 * rail only walks the pipeline the deal is already on, and the edit form leaves
 * both fields alone because changing one without the other is refused. Both are
 * written in one PATCH, with the forecast restamp stated first.
 */
export function PipelineMoveDialog({
  open, deal, pipelines, properties, onClose, onMoved,
}: {
  open: boolean;
  deal: DealRecord | null;
  pipelines: Pipeline[];
  properties: PropertyDef[];
  onClose: () => void;
  onMoved: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  const f = useFormat();
  const [target, setTarget] = useState('');
  const [stage, setStage] = useState('');
  const [draft, setDraft] = useState<Draft>({});

  const current = pipelines.find((p) => p.name === str(deal?.properties.pipeline));
  const others = useMemo(() => pipelines.filter((p) => p.name !== current?.name), [pipelines, current]);
  const chosen = others.find((p) => p.name === target) ?? others[0];
  const openStages = useMemo(() => (chosen?.stages ?? []).filter((s) => !s.is_closed), [chosen]);
  const chosenStage = openStages.find((s) => s.name === stage) ?? openStages[0];

  useEffect(() => {
    if (!open) return;
    setTarget(others[0]?.name ?? '');
    setStage('');
    setDraft({});
  }, [open, deal?.id, others]);

  const requirements = useMemo(
    () => (chosenStage ? stageRequirements(deal, chosenStage, properties) : { required: [], optional: [] }),
    [deal, chosenStage, properties],
  );
  const missing = requirements.required.filter((property) => emptyValue(draft[property.name]));

  const move = useMutation<void, DealRecord>(async () => {
    if (!deal || !chosen || !chosenStage) throw new Error('no destination');
    const props: Draft = { pipeline: chosen.name, deal_stage: chosenStage.name };
    for (const [key, value] of Object.entries(draft)) if (!emptyValue(value)) props[key] = value;
    return api.patch<DealRecord>(`/v1/records/deal/${encodeURIComponent(deal.id)}`, { properties: props });
  }, {
    invalidates: ['/v1/records/deal', '/v1/pipelines', '/v1/crm/overview'],
    onSuccess: (updated) => {
      toast.success(
        `Moved to ${chosen?.label}`,
        `${updated.display_name} is in ${chosenStage?.label} at ${num(updated.properties.probability)}%.`,
      );
      onMoved();
      onClose();
    },
    onError: (e) => { if (!e.body.param) toast.error('The pipeline did not change', e.body.message); },
  });

  const amount = deal ? num(deal.properties.amount) : 0;
  const from = current?.stages.find((s) => s.name === str(deal?.properties.deal_stage));
  const banner = unboundError(move.error, ['pipeline', 'deal_stage', ...requirements.required.map((p) => p.name)]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="Move to another pipeline"
      description={deal?.display_name}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={move.loading}
            disabled={!chosen || !chosenStage || missing.length > 0}
            onClick={() => { void move.run().catch(() => undefined); }}
          >
            {chosen ? `Move to ${chosen.label}` : 'Move'}
          </Button>
        </>
      }
    >
      <div className="pl-form">
        {banner && <Banner tone="danger" title="The pipeline did not change">{banner}</Banner>}

        {others.length === 0 && (
          <Banner tone="info" compact>
            {current?.label ?? 'This pipeline'} is the only deal pipeline this workspace has, so there is nowhere else to move to.
          </Banner>
        )}

        {others.length > 0 && (
          <>
            <div className="pl-form__row">
              <Field label="Pipeline" required>
                <Select
                  value={chosen?.name ?? ''}
                  onChange={(next) => { setTarget(next); setStage(''); }}
                  options={others.map<SelectOption>((p) => ({ value: p.name, label: p.label }))}
                  aria-label="Pipeline"
                />
              </Field>
              <Field
                label="Stage"
                required
                hint={chosenStage ? `Carries a ${chosenStage.probability}% probability` : undefined}
              >
                <Select
                  value={chosenStage?.name ?? ''}
                  onChange={setStage}
                  options={openStages.map<SelectOption>((s) => ({ value: s.name, label: `${s.label} · ${s.probability}%` }))}
                  aria-label="Stage"
                />
              </Field>
            </div>

            <div className="pl-movesummary">
              <span>
                Pipeline <strong>{current?.label ?? '—'}</strong> → <strong>{chosen?.label}</strong>
              </span>
              <span>
                Probability <strong>{from ? `${from.probability}%` : '—'}</strong> → <strong>{chosenStage?.probability ?? 0}%</strong>
              </span>
              <span>
                Weighted <strong>{f.money(Math.round((amount * (from?.probability ?? 0)) / 100))}</strong>
                {' → '}
                <strong>{f.money(Math.round((amount * (chosenStage?.probability ?? 0)) / 100))}</strong>
              </span>
            </div>

            <p className="pl-note">
              The stage history keeps every spell on the old pipeline; this starts a new one at{' '}
              {chosenStage?.label ?? 'the first stage'}.
            </p>

            {requirements.required.map((property) => (
              <Field
                key={property.name}
                label={property.label}
                required
                hint={property.description ?? undefined}
                error={errorFor(move.error, property.name)}
              >
                <PropertyInput
                  property={property}
                  value={draft[property.name] ?? deal?.properties[property.name]}
                  onChange={(value) => setDraft((prev) => ({ ...prev, [property.name]: value }))}
                  currency={session.currency}
                  invalid={!!errorFor(move.error, property.name)}
                />
              </Field>
            ))}
          </>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------- edit deal -------------------------------- */

export function EditDealDialog({
  open, deal, properties, pipelines, users, onClose, onSaved, focusGroup,
}: {
  open: boolean;
  deal: DealRecord | null;
  properties: PropertyDef[];
  pipelines: Pipeline[];
  users: WorkspaceUser[];
  onClose: () => void;
  onSaved: () => void;
  focusGroup?: string | null;
}) {
  const session = useSession();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>({});
  const [ownerId, setOwnerId] = useState<string>('');

  useEffect(() => {
    if (!open || !deal) return;
    setDraft({});
    setOwnerId(deal.owner_id ?? '');
  }, [open, deal]);

  const editable = useMemo(() => {
    const rows = properties.filter((p) => !p.read_only && !p.calculated && p.name !== 'deal_stage' && p.name !== 'pipeline');
    return focusGroup ? rows.filter((p) => p.group === focusGroup) : rows;
  }, [properties, focusGroup]);

  const groups = useMemo(() => {
    const map = new Map<string, PropertyDef[]>();
    for (const property of editable) {
      const list = map.get(property.group) ?? [];
      list.push(property);
      map.set(property.group, list);
    }
    return [...map.entries()];
  }, [editable]);

  const save = useMutation<void, DealRecord>(async () => {
    if (!deal) throw new Error('no deal');
    const body: { properties: Draft; owner_id?: string | null } = { properties: { ...draft } };
    if (ownerId !== (deal.owner_id ?? '')) body.owner_id = ownerId || null;
    return api.patch<DealRecord>(`/v1/records/deal/${encodeURIComponent(deal.id)}`, body);
  }, {
    invalidates: ['/v1/records/deal', '/v1/pipelines', '/v1/crm/overview'],
    onSuccess: (updated) => {
      toast.success('Deal saved', `${updated.display_name} was updated.`);
      onSaved();
      onClose();
    },
    onError: (e) => { if (!e.body.param) toast.error('The deal was not saved', e.body.message); },
  });

  const dirty = Object.keys(draft).length > 0 || ownerId !== (deal?.owner_id ?? '');
  const banner = unboundError(save.error, [...editable.map((p) => p.name), 'owner_id']);
  const pipelineLabel = pipelines.find((p) => p.name === str(deal?.properties.pipeline))?.label;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Edit deal"
      description={deal?.display_name}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.loading} disabled={!dirty} onClick={() => { void save.run().catch(() => undefined); }}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="pl-form">
        {banner && <Banner tone="danger" title="The deal was not saved">{banner}</Banner>}
        <Banner tone="neutral" compact>
          Stage and pipeline are changed from the board or the stage rail, so the forecast restamp is always shown first.
          This deal is in {pipelineLabel ?? 'no pipeline'}.
        </Banner>

        <Field label="Owner" error={errorFor(save.error, 'owner_id')}>
          <Select
            value={ownerId}
            onChange={setOwnerId}
            options={[
              { value: '', label: 'Unassigned' },
              ...users.map<SelectOption>((user) => ({ value: user.id, label: `${user.name}${user.title ? ` · ${user.title}` : ''}` })),
            ]}
          />
        </Field>

        {groups.map(([group, rows]) => (
          <section key={group}>
            <div className="pl-propgroup__title" style={{ marginBottom: 'var(--space-3)' }}>{group}</div>
            <div className="pl-form">
              {rows.map((property, index) => (
                <Field
                  key={property.name}
                  label={property.label}
                  required={property.required}
                  hint={property.description ?? undefined}
                  error={errorFor(save.error, property.name)}
                >
                  <PropertyInput
                    property={property}
                    value={property.name in draft ? draft[property.name] : deal?.properties[property.name]}
                    onChange={(value) => setDraft((prev) => ({ ...prev, [property.name]: value }))}
                    currency={session.currency}
                    autoFocus={index === 0 && group === groups[0][0]}
                    invalid={!!errorFor(save.error, property.name)}
                  />
                </Field>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Modal>
  );
}

/* ------------------------------ log activity ------------------------------ */

const ACTIVITY_KINDS = ['note', 'call', 'meeting', 'email', 'task'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export function LogActivityDialog({
  open, deal, onClose, onLogged,
}: {
  open: boolean;
  deal: DealRecord | null;
  onClose: () => void;
  onLogged: () => void;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<ActivityKind>('note');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const subjectRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) { setKind('note'); setSubject(''); setBody(''); } }, [open]);

  const log = useMutation<void, { id: string }>(async () => {
    if (!deal) throw new Error('no deal');
    return api.post<{ id: string }>(`/v1/records/deal/${encodeURIComponent(deal.id)}/activities`, {
      type: kind,
      subject: subject.trim() || undefined,
      body: body.trim() || undefined,
    });
  }, {
    invalidates: ['/v1/records/deal', '/v1/events'],
    onSuccess: () => {
      toast.success(`${humanize(kind)} logged`, `It is on ${deal?.display_name}'s timeline.`);
      invalidate(`/v1/records/deal/${deal?.id ?? ''}`);
      onLogged();
      onClose();
    },
    onError: (e) => { if (!e.body.param) toast.error('Nothing was logged', e.body.message); },
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="Log activity"
      description={deal?.display_name}
      initialFocus={subjectRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={log.loading}
            disabled={!subject.trim() && !body.trim()}
            onClick={() => { void log.run().catch(() => undefined); }}
          >
            Log {kind}
          </Button>
        </>
      }
    >
      <div className="pl-form">
        {unboundError(log.error, ['type', 'subject', 'body']) && (
          <Banner tone="danger" title="Nothing was logged">{log.error?.body.message}</Banner>
        )}
        <Field label="Kind" error={errorFor(log.error, 'type')}>
          <Select
            value={kind}
            onChange={(next) => setKind(next as ActivityKind)}
            options={ACTIVITY_KINDS.map<SelectOption>((value) => ({ value, label: humanize(value) }))}
          />
        </Field>
        <Field label="Subject" error={errorFor(log.error, 'subject')}>
          <Input ref={subjectRef} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Security review scheduled" />
        </Field>
        <Field label="Detail" error={errorFor(log.error, 'body')}>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} autosize maxRows={10} placeholder="What happened, and what happens next." />
        </Field>
      </div>
    </Modal>
  );
}

/* --------------------------------- helper --------------------------------- */

export function DialogHint({ children }: { children: ReactNode }) {
  return <p className="pl-note">{children}</p>;
}
