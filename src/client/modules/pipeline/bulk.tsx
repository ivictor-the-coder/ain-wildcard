/**
 * Doing one thing to many deals.
 *
 * A forecast review moves a dozen deals at once — end of quarter, a rep leaves,
 * a stage gets renamed. Doing that one card at a time is the difference between
 * a board you can run a business on and a board you can look at.
 *
 * Both dialogs state the consequence before they write it, and both report the
 * outcome per row: `POST /v1/records/{type}/batch` commits each record on its
 * own, so "12 moved, 2 refused" is a real answer and is rendered as one rather
 * than collapsed into a single failure.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, useMutation } from '@/client/kernel/api';
import { useSession } from '@/client/kernel/session';
import {
  Badge, Banner, Button, DatePicker, Field, Modal, Select, useFormat, useToast,
  type SelectOption,
} from '@/client/design';
import {
  dealAmount, dealStage, dealWeighted, emptyValue, reasonOptions, snapshotMove, snapshotOwner,
  stageRequirements, useDealFormat, useOutcomeSplit,
  type DealRecord, type MoveSnapshot, type OwnerSnapshot, type PipelineStage, type PropertyDef,
  type WorkspaceUser,
} from './api';
import {
  PropertyInput, errorFor, unboundError, useFirstControl, useUndoBulkMove, useUndoBulkReassign,
  type Draft,
} from './dialogs';

interface BatchRow {
  index: number;
  status: 'created' | 'updated' | 'error';
  id?: string;
  display_name?: string;
  error?: { type: string; code: string; message: string; param?: string };
}

interface BatchResult {
  object: 'batch_result';
  updated: number;
  created: number;
  errors: number;
  has_errors: boolean;
  results: BatchRow[];
}

/** What the server refused, in the words it refused with, one line per deal. */
function Refusals({ result, deals }: { result: BatchResult; deals: DealRecord[] }) {
  const failed = result.results.filter((row) => row.status === 'error');
  if (!failed.length) return null;
  return (
    <Banner tone="warning" title={`${failed.length} of ${result.results.length} were refused`}>
      <ul className="pl-refusals">
        {failed.map((row) => (
          <li key={row.index}>
            <strong>{deals[row.index]?.display_name ?? `Row ${row.index + 1}`}</strong>
            {' — '}
            {row.error?.message ?? 'the server refused this row without saying why.'}
          </li>
        ))}
      </ul>
    </Banner>
  );
}

/* ------------------------------ stage in bulk ----------------------------- */

/**
 * Move every selected deal to one stage.
 *
 * A destination that closes the deal is allowed, but it collects the same
 * required outcome fields the single-deal confirmation collects — asked once
 * and written to all of them, because a bulk close with no reason recorded is a
 * forecast nobody can review. The union is taken across the selection, so a
 * field one deal has already filled in is still asked for if another has not.
 */
export function BulkStageDialog({
  open, deals, stage, stages, properties, onClose, onDone,
}: {
  open: boolean;
  deals: DealRecord[];
  stage: PipelineStage | null;
  stages: PipelineStage[];
  properties: PropertyDef[];
  onClose: () => void;
  onDone: (movedIds: string[]) => void;
}) {
  const f = useDealFormat();
  const toast = useToast();
  const session = useSession();
  const [draft, setDraft] = useState<Draft>({});
  const [closeDate, setCloseDate] = useState<number | null>(null);
  const [result, setResult] = useState<BatchResult | null>(null);
  const split = useOutcomeSplit(properties, open && !!stage?.is_closed);
  const outcome = stage?.is_won ? 'won' : 'lost';

  const today = f.calendarToday();
  useEffect(() => {
    if (!open) return;
    setDraft({});
    setResult(null);
    setCloseDate(today);
  }, [open, stage?.name, today]);

  // Deals already sitting in the destination are not a move; excluding them is
  // what keeps the count in the button honest.
  const moving = useMemo(
    () => (stage ? deals.filter((deal) => dealStage(deal) !== stage.name) : []),
    [deals, stage],
  );

  const required = useMemo(() => {
    if (!stage) return [] as PropertyDef[];
    const byName = new Map<string, PropertyDef>();
    for (const deal of moving) {
      for (const property of stageRequirements(deal, stage, properties).required) {
        byName.set(property.name, property);
      }
    }
    return [...byName.values()];
  }, [moving, stage, properties]);

  const totals = useMemo(() => {
    let amount = 0;
    let weighted = 0;
    for (const deal of moving) { amount += dealAmount(deal); weighted += dealWeighted(deal); }
    return { amount, weighted, next: stage ? Math.round((amount * stage.probability) / 100) : 0 };
  }, [moving, stage]);

  const fromStages = useMemo(() => {
    const counts = new Map<string, number>();
    for (const deal of moving) counts.set(dealStage(deal), (counts.get(dealStage(deal)) ?? 0) + 1);
    return [...counts.entries()]
      .map(([name, count]) => ({ label: stages.find((s) => s.name === name)?.label ?? name, count }))
      .sort((a, b) => b.count - a.count);
  }, [moving, stages]);

  const missing = required.filter((property) => emptyValue(draft[property.name]));

  const offerUndo = useUndoBulkMove();
  // Each deal goes back to its *own* stage, not to one shared origin: a bulk
  // move that swept four columns into Negotiation has four ways home.
  const undoSnapshots = useRef<MoveSnapshot[]>([]);

  const move = useMutation<void, BatchResult>(async () => {
    if (!stage) throw new Error('no stage');
    const shared: Draft = { deal_stage: stage.name };
    for (const [key, value] of Object.entries(draft)) if (!emptyValue(value)) shared[key] = value;
    const records = moving.map((deal) => ({
      id: deal.id,
      // A deal that already carries a close stamp keeps the day it closed on;
      // only a fresh close takes the day chosen here.
      properties: stage.is_closed && closeDate !== null && emptyValue(deal.properties.closed_at)
        ? { ...shared, close_date: closeDate }
        : shared,
    }));
    undoSnapshots.current = moving.map((deal, i) => snapshotMove(deal, records[i].properties));
    return api.post<BatchResult>('/v1/records/deal/batch', { operation: 'update', records });
  }, {
    invalidates: ['/v1/records/deal', '/v1/pipelines', '/v1/crm/overview'],
    onSuccess: (batch) => {
      setResult(batch);
      const moved = batch.results.filter((row) => row.status === 'updated');
      if (batch.has_errors) {
        toast.warning(
          `${moved.length} of ${batch.results.length} moved to ${stage?.label}`,
          `${batch.errors} were refused — the reasons are on the dialog.`,
        );
      } else {
        // Only the rows that actually landed are offered back.
        const landed = new Set(moved.map((row) => row.id));
        const undoable = undoSnapshots.current.filter((snapshot) => landed.has(snapshot.id));
        const origins = new Set(undoable.map((snapshot) => snapshot.stage));
        const home = origins.size === 1
          ? stages.find((s) => s.name === [...origins][0])?.label ?? 'their old stage'
          : 'the stage each came from';
        toast.success(
          `${f.plural(moved.length, 'deal')} moved to ${stage?.label}`,
          `${f.money(totals.next)} now forecasts at ${stage?.probability}%.`,
          undoable.length ? { action: offerUndo(undoable, home) } : undefined,
        );
        onDone(moved.map((row) => row.id ?? ''));
        onClose();
      }
    },
    onError: (e) => { if (!e.body.param) toast.error('Nothing was moved', e.body.message); },
  });

  if (!stage) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={`Move ${f.plural(moving.length, 'deal')} to ${stage.label}`}
      description={`Every one of them takes ${stage.label}’s ${stage.probability}% probability${stage.is_closed ? ' and closes' : ''}.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{result ? 'Close' : 'Cancel'}</Button>
          <Button
            variant={stage.is_closed && !stage.is_won ? 'danger' : 'primary'}
            loading={move.loading}
            disabled={moving.length === 0 || missing.length > 0 || !!result}
            onClick={() => { void move.run().catch(() => undefined); }}
          >
            {result ? 'Done' : `Move ${f.plural(moving.length, 'deal')}`}
          </Button>
        </>
      }
    >
      <div className="pl-form">
        {unboundError(move.error, ['deal_stage', 'close_date', ...required.map((p) => p.name)]) && (
          <Banner tone="danger" title="Nothing was moved">{move.error?.body.message}</Banner>
        )}

        {result && <Refusals result={result} deals={moving} />}

        {moving.length === 0 && (
          <Banner tone="info" compact>
            Everything selected is already in {stage.label}. Nothing to move.
          </Banner>
        )}

        {moving.length > 0 && (
          <div className="pl-movesummary">
            <span>
              {fromStages.map((row) => `${row.count} from ${row.label}`).join(' · ')}
            </span>
          </div>
        )}

        {moving.length > 0 && (
          <div className="pl-facts">
            <div className="pl-fact">
              <span className="pl-fact__label">Amount moving</span>
              <span className="pl-fact__value">{f.money(totals.amount)}</span>
              <span className="pl-fact__hint">{f.plural(moving.length, 'deal')}</span>
            </div>
            <div className="pl-fact">
              <span className="pl-fact__label">Weighted today</span>
              <span className="pl-fact__value">{f.money(totals.weighted)}</span>
              <span className="pl-fact__hint">At each deal’s current stage</span>
            </div>
            <div className="pl-fact">
              <span className="pl-fact__label">Weighted after</span>
              <span className="pl-fact__value">{f.money(totals.next)}</span>
              <span className="pl-fact__hint">
                All of them at {stage.probability}%
                {totals.next !== totals.weighted && ` · ${totals.next > totals.weighted ? '+' : '−'}${f.money(Math.abs(totals.next - totals.weighted))}`}
              </span>
            </div>
          </div>
        )}

        {stage.is_closed && moving.length > 0 && (
          <Banner tone={stage.is_won ? 'success' : 'warning'} compact>
            {stage.is_won
              ? `${f.plural(moving.length, 'deal')} will be marked won and leave the open pipeline.`
              : `${f.plural(moving.length, 'deal')} will be marked lost. They stay readable, and stop counting towards the forecast.`}
          </Banner>
        )}

        {required.map((property) => {
          const narrowed = stage.is_closed && property.type === 'enum' && property.group.toLowerCase() === 'outcome'
            ? reasonOptions(property, outcome, split)
            : null;
          return (
            <Field
              key={property.name}
              label={property.label}
              required
              hint={narrowed
                ? `Only the reasons ${outcome === 'won' ? 'a win' : 'a loss'} can carry. Written to every deal in this move.`
                : `${property.description ?? 'Written to every deal in this move.'}`}
              error={errorFor(move.error, property.name)}
            >
              <PropertyInput
                property={property}
                options={narrowed?.options}
                value={draft[property.name]}
                onChange={(value) => setDraft((prev) => ({ ...prev, [property.name]: value }))}
                currency={session.currency}
                invalid={!!errorFor(move.error, property.name)}
              />
            </Field>
          );
        })}

        {stage.is_closed && moving.length > 0 && (
          <Field
            label="Close date"
            hint={closeDate === null
              ? 'Leave it empty and each deal is stamped by the server.'
              : `${f.calendarDate(closeDate)} — written to every deal that is not already closed.`}
            error={errorFor(move.error, 'close_date')}
          >
            <DatePicker value={closeDate} onChange={setCloseDate} aria-label="Close date" />
          </Field>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------ owner in bulk ----------------------------- */

/** Hand a whole set of deals to one teammate — a territory change, or a leaver. */
export function BulkOwnerDialog({
  open, deals, users, onClose, onDone,
}: {
  open: boolean;
  deals: DealRecord[];
  users: WorkspaceUser[];
  onClose: () => void;
  onDone: (ids: string[]) => void;
}) {
  const f = useFormat();
  const toast = useToast();
  const [ownerId, setOwnerId] = useState('');
  const [result, setResult] = useState<BatchResult | null>(null);

  useEffect(() => { if (open) { setOwnerId(''); setResult(null); } }, [open]);

  const amount = useMemo(() => deals.reduce((sum, deal) => sum + dealAmount(deal), 0), [deals]);
  const owner = users.find((user) => user.id === ownerId);

  const firstControl = useFirstControl();
  const offerUndo = useUndoBulkReassign();
  // Taken before the write, the way `snapshotMove` is for a stage change: three
  // deals handed to the wrong rep is otherwise three records to find and fix.
  const undoSnapshots = useRef<OwnerSnapshot[]>([]);
  // Named from the deals themselves rather than from the picker, because a
  // selection can span several reps — "back with Marcus Vandermeer" when they
  // all came from one, "back with the reps they came from" when they did not.
  const cameFrom = useMemo(() => {
    const owners = new Set(deals.map((deal) => deal.owner_id ?? ''));
    if (owners.size !== 1) return 'the reps they came from';
    const only = [...owners][0];
    return only ? users.find((user) => user.id === only)?.name ?? 'their previous owner' : 'nobody';
  }, [deals, users]);

  const assign = useMutation<void, BatchResult>(
    () => {
      undoSnapshots.current = deals.map(snapshotOwner);
      return api.post<BatchResult>('/v1/records/deal/batch', {
        operation: 'update',
        records: deals.map((deal) => ({ id: deal.id, properties: {}, ...(ownerId ? { owner_id: ownerId } : {}) })),
      });
    },
    {
      invalidates: ['/v1/records/deal', '/v1/pipelines', '/v1/crm/overview'],
      onSuccess: (batch) => {
        setResult(batch);
        const moved = batch.results.filter((row) => row.status === 'updated');
        if (batch.has_errors) {
          toast.warning(
            `${moved.length} of ${batch.results.length} reassigned`,
            `${batch.errors} were refused — the reasons are on the dialog.`,
          );
        } else {
          const landed = new Set(moved.map((row) => row.id));
          const undoable = undoSnapshots.current.filter((snapshot) => landed.has(snapshot.id));
          toast.success(
            `${f.plural(moved.length, 'deal')} now owned by ${owner?.name}`,
            `${f.money(amount)} of pipeline changed hands.`,
            undoable.length ? { action: offerUndo(undoable, cameFrom) } : undefined,
          );
          onDone(moved.map((row) => row.id ?? ''));
          onClose();
        }
      },
      onError: (e) => { if (!e.body.param) toast.error('Nothing was reassigned', e.body.message); },
    },
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      initialFocus={firstControl.initialFocus}
      size="sm"
      title={`Reassign ${f.plural(deals.length, 'deal')}`}
      description={`${f.money(amount)} of pipeline moves to whoever you choose.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{result ? 'Close' : 'Cancel'}</Button>
          <Button
            variant="primary"
            loading={assign.loading}
            disabled={!ownerId || !!result}
            onClick={() => { void assign.run().catch(() => undefined); }}
          >
            {result ? 'Done' : 'Reassign'}
          </Button>
        </>
      }
    >
      <div className="pl-form" ref={firstControl.body}>
        {unboundError(assign.error, ['owner_id']) && (
          <Banner tone="danger" title="Nothing was reassigned">{assign.error?.body.message}</Banner>
        )}
        {result && <Refusals result={result} deals={deals} />}
        <Field label="New owner" required error={errorFor(assign.error, 'owner_id')}>
          <Select
            value={ownerId}
            onChange={setOwnerId}
            options={[
              { value: '', label: 'Choose a teammate…' },
              ...users.map<SelectOption>((user) => ({
                value: user.id,
                label: `${user.name}${user.title ? ` · ${user.title}` : ''}`,
              })),
            ]}
            aria-label="New owner"
          />
        </Field>
        <p className="pl-note">
          <Badge size="sm" tone="neutral">{f.plural(deals.length, 'deal')}</Badge>
          {' '}
          Each deal is written on its own, so one refusal never loses the rest.
        </p>
      </div>
    </Modal>
  );
}
