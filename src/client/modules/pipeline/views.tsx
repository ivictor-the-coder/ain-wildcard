/**
 * Saved views for the deal board.
 *
 * The board's controls already live in the URL, which makes a filtered board
 * linkable but not nameable: a VP running the same three filters every Monday
 * had to rebuild them every Monday, and could not hand a teammate "Priya's
 * commit deals closing this quarter" as a thing with a name.
 *
 * A view here is a real `/v1/views` row — the same saved-view store the record
 * screens read, holding the same filter tree the record search compiles — so a
 * view saved on this board is a view the rest of the platform understands, and
 * one saved elsewhere shows up in this menu. When a view carries a condition
 * these controls cannot express, the menu says so rather than applying half of
 * it and pretending that is the view.
 */
import { useMemo, useRef, useState } from 'react';
import { api, useMutation, type ApiClientError } from '@/client/kernel/api';
import { useSession } from '@/client/kernel/session';
import {
  Badge, Banner, Button, ConfirmDialog, Field, Icons, Input, MenuButton, Modal, RadioGroup,
  Textarea, useToast, type MenuItemDef, type MenuSection,
} from '@/client/design';
import {
  describeBoardState, sameBoardState, stateToView, useDealViews, viewToState,
  type BoardState, type DealView,
} from './api';

/** A view name long enough to push the whole toolbar onto another row. */
const shortName = (name: string): string => (name.length > 34 ? `${name.slice(0, 33)}…` : name);

/** Errors the server raised, bound to the `param` it named. */
const errorFor = (error: ApiClientError | null, param: string): string | null =>
  error && error.body.param === param ? error.body.message : null;

export interface ViewBarProps {
  /** The board as it stands right now. */
  state: BoardState;
  /** The view the URL says is applied, or ''. */
  activeId: string;
  /** Put a whole view on the board — or clear back to the unfiltered default. */
  onApply: (view: DealView | null) => void;
  pipelineLabel: (name: string) => string;
  ownerName: (id: string) => string;
  forecastLabel: (value: string) => string;
}

interface Draft {
  /** The view being edited, or null when saving the board as a new one. */
  view: DealView | null;
  name: string;
  description: string;
  shared: boolean;
  /** Rename only — leave the stored filter exactly as it is. */
  keepFilter: boolean;
}

export function ViewBar({
  state, activeId, onApply, pipelineLabel, ownerName, forecastLabel,
}: ViewBarProps) {
  const toast = useToast();
  const session = useSession();
  const views = useDealViews();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<DealView | null>(null);
  const nameField = useRef<HTMLInputElement>(null);

  const rows = views.data?.data ?? [];
  const active = rows.find((row) => row.id === activeId) ?? null;
  const decoded = useMemo(() => (active ? viewToState(active) : null), [active]);
  // A view is "modified" only when it is legible in the first place: a filter
  // these controls cannot read is not a filter they can be said to differ from.
  const modified = !!decoded && decoded.readable && !sameBoardState(decoded.state, state);

  const describe = useMemo(
    () => (row: DealView) => {
      const read = viewToState(row);
      const what = read.readable
        ? describeBoardState(read.state, { pipelineLabel, ownerName, forecastLabel })
        : 'Built from conditions this board cannot show';
      return row.shared ? what : `Only you · ${what}`;
    },
    [pipelineLabel, ownerName, forecastLabel],
  );

  const save = useMutation<Draft, DealView>(
    async (input) => {
      const shape = input.keepFilter ? {} : stateToView(state);
      const body = {
        name: input.name.trim(),
        description: input.description.trim(),
        shared: input.shared,
        ...shape,
      };
      return input.view
        ? api.patch<DealView>(`/v1/views/${encodeURIComponent(input.view.id)}`, body)
        : api.post<DealView>('/v1/views', { object_type: 'deal', ...body });
    },
    {
      invalidates: ['/v1/views', '/v1/object-types'],
      onSuccess: (saved, input) => {
        setDraft(null);
        onApply(saved);
        toast.success(
          input.view ? 'View updated' : 'View saved',
          input.view
            ? `“${saved.name}” now holds ${input.keepFilter ? 'the same filters under a new name' : 'this board'}.`
            : `“${saved.name}” is ${saved.shared ? 'on this menu for everyone in the workspace' : 'on this menu, for you'}.`,
        );
      },
      onError: (e) => { if (!e.body.param) toast.error('The view was not saved', e.body.message); },
    },
  );

  const remove = useMutation<DealView, void>(
    (view) => api.del<void>(`/v1/views/${encodeURIComponent(view.id)}`),
    {
      invalidates: ['/v1/views', '/v1/object-types'],
      onSuccess: (_result, view) => {
        setDeleting(null);
        if (view.id === activeId) onApply(null);
        toast.success('View deleted', `“${view.name}” is off the menu. The deals it showed are untouched.`);
      },
      onError: (e) => toast.error('The view was not deleted', e.body.message),
    },
  );

  const startNew = () => setDraft({
    view: null,
    name: '',
    description: '',
    shared: true,
    keepFilter: false,
  });

  const startEdit = (view: DealView, keepFilter: boolean) => setDraft({
    view,
    name: view.name,
    description: view.description ?? '',
    shared: view.shared,
    keepFilter,
  });

  const viewItems: MenuItemDef[] = rows.map((row) => ({
    id: row.id,
    label: row.name,
    description: describe(row),
    // A checkbox row draws a tick in the icon slot, so who can see the view is
    // said in the description rather than drawn as an icon nothing would show.
    checked: row.id === activeId,
    onSelect: () => onApply(row),
  }));

  const manage: MenuItemDef[] = [
    { id: 'save', label: 'Save this board as a view…', icon: <Icons.plus size={14} />, onSelect: startNew },
  ];
  if (active) {
    manage.push({
      id: 'update',
      label: `Update “${active.name}” to match this board`,
      description: modified ? describeBoardState(state, { pipelineLabel, ownerName, forecastLabel }) : 'Nothing on the board has moved',
      disabled: !modified,
      icon: <Icons.refresh size={14} />,
      onSelect: () => { void save.run({ ...toDraft(active), keepFilter: false }).catch(() => undefined); },
    });
    manage.push({
      id: 'rename',
      label: `Rename or reshare “${active.name}”…`,
      icon: <Icons.edit size={14} />,
      onSelect: () => startEdit(active, true),
    });
    manage.push({
      id: 'delete',
      label: `Delete “${active.name}”`,
      description: active.system ? 'This one ships with the workspace' : undefined,
      disabled: active.system,
      danger: true,
      icon: <Icons.trash size={14} />,
      onSelect: () => setDeleting(active),
    });
  }

  const sections: MenuSection[] = [
    ...(activeId ? [{
      id: 'none',
      items: [{
        id: 'clear',
        label: 'No view',
        description: 'The board’s own filters, unnamed',
        icon: <Icons.x size={14} />,
        onSelect: () => onApply(null),
      }],
    }] : []),
    ...(viewItems.length ? [{ id: 'views', label: 'Saved views', items: viewItems }] : []),
    { id: 'manage', label: 'This board', items: manage },
  ];

  return (
    <>
      <MenuButton
        size="sm"
        variant={activeId ? 'secondary' : 'ghost'}
        icon={<Icons.bookmark size={13} />}
        label="Saved views"
        placement="bottom-start"
        sections={sections}
      >
        {active ? shortName(active.name) : 'Views'}
      </MenuButton>
      {modified && <Badge size="sm" tone="warning">modified</Badge>}
      {views.error && (
        <Button size="sm" variant="ghost" iconLeft={<Icons.refresh size={13} />} onClick={views.refetch}>
          Views did not load — retry
        </Button>
      )}

      {/* `initialFocus` is not decoration: the trap otherwise lands on the
          header's close button — the first focusable node in the dialog — and
          the first Space of the name you type activates it, throwing away the
          dialog and everything typed into it. */}
      <Modal
        open={!!draft}
        onClose={() => setDraft(null)}
        size="sm"
        initialFocus={nameField}
        title={draft?.view ? `Edit “${draft.view.name}”` : 'Save this board as a view'}
        description={
          draft?.keepFilter
            ? 'The filters stay exactly as they were saved; only the name, the description and who can see it change.'
            : 'A view remembers the pipeline, owner, forecast category, close-date window, sort and the closed-stages switch. The search box is not part of it.'
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={save.loading}
              disabled={!draft?.name.trim()}
              iconLeft={<Icons.check size={14} />}
              onClick={() => { if (draft) void save.run(draft).catch(() => undefined); }}
            >
              {draft?.view ? 'Save changes' : 'Save the view'}
            </Button>
          </>
        }
      >
        {draft && (
          <form
            className="pl-form"
            onSubmit={(e) => { e.preventDefault(); if (draft.name.trim()) void save.run(draft).catch(() => undefined); }}
          >
            {save.error && !save.error.body.param && (
              <Banner tone="danger" title="The view was not saved">{save.error.body.message}</Banner>
            )}
            <Field label="Name" required error={errorFor(save.error, 'name')} hint="What a teammate will see in the menu.">
              <Input
                ref={nameField}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                maxLength={80}
                placeholder="Commit deals closing this quarter"
                aria-label="View name"
              />
            </Field>
            <Field label="Description" optional error={errorFor(save.error, 'description')} hint="Why a teammate would open it.">
              <Textarea
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                minRows={2}
                maxRows={4}
                maxLength={400}
                placeholder="The deals I take to the Monday forecast call."
                aria-label="View description"
              />
            </Field>
            <Field label="Who can use it">
              <RadioGroup<'everyone' | 'me'>
                label="Who can use it"
                name="view-shared"
                value={draft.shared ? 'everyone' : 'me'}
                onChange={(next) => setDraft({ ...draft, shared: next === 'everyone' })}
                options={[
                  { value: 'everyone', label: 'Everyone in this workspace', hint: 'It appears on their deal screens too.' },
                  { value: 'me', label: `Only ${session.me?.user?.name ?? 'me'}`, hint: 'Nobody else sees it in the menu.' },
                ]}
              />
            </Field>
            {!draft.keepFilter && (
              <Banner tone="neutral" compact>
                Saving: {describeBoardState(state, { pipelineLabel, ownerName, forecastLabel })}.
              </Banner>
            )}
          </form>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onCancel={() => setDeleting(null)}
        onConfirm={() => { if (deleting) void remove.run(deleting).catch(() => undefined); }}
        loading={remove.loading}
        title={`Delete the view “${deleting?.name ?? ''}”?`}
        body={
          deleting?.shared
            ? 'It disappears from everyone’s deal screens. No deal is changed — a view is only a saved set of filters.'
            : 'No deal is changed — a view is only a saved set of filters.'
        }
        confirmLabel="Delete the view"
      />
    </>
  );
}

const toDraft = (view: DealView): Draft => ({
  view,
  name: view.name,
  description: view.description ?? '',
  shared: view.shared,
  keepFilter: false,
});
