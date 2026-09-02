/**
 * The deal's links to the rest of the CRM, as controls rather than as a display.
 *
 * A record page that lists an account and a buying committee but cannot change
 * either is a report, not a record. These two cards own the writes:
 * `POST /v1/associations` to link, `DELETE /v1/associations/:id` to unlink.
 *
 * `deal_to_company` is a single-slot label, so pointing a deal at a different
 * account is one POST — the server replaces the old edge and hands back what it
 * removed in `replaced`, which is what the toast quotes. The committee is
 * many-to-many, so each contact is added and removed on its own.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, invalidate, useMutation, type ListEnvelope } from '@/client/kernel/api';
import { useRouter } from '@/client/kernel/router';
import {
  Avatar, Banner, Button, Card, ChevronRightIcon, Combobox, ConfirmDialog, EmptyState, Field,
  Icons, MenuButton, Modal, useToast,
  type ComboOption, type MenuSection,
} from '@/client/design';
import { accountOf, recordHref, type DealRecord, type RecordAssociation } from './api';
import { useFirstControl } from './dialogs';

interface RecordOption { id: string; display_name: string; properties: Record<string, unknown> }

interface LinkResult extends RecordAssociation {
  object: 'association';
  /** Edges the server dropped to make room, when the label holds a single slot. */
  replaced?: RecordAssociation[];
}

/** The one-line description under a search result, so two "Acme"s are telling apart. */
function describe(row: RecordOption, objectType: string): string | undefined {
  const props = row.properties;
  const pick = (key: string): string | undefined => {
    const value = props[key];
    return typeof value === 'string' && value ? value : undefined;
  };
  if (objectType === 'company') return pick('domain') ?? pick('industry') ?? pick('city');
  return pick('email') ?? pick('job_title') ?? pick('phone');
}

/* ------------------------------- link dialog ------------------------------ */

/**
 * Search one object type and link what is chosen to this deal.
 *
 * Deliberately single-select even for the committee, which takes several
 * people. A multi-select Combobox holds its list open after each pick — right
 * for multi-pick, wrong inside a dialog, because the open list sits on top of
 * the button that commits the choice and a mouse can never reach it. So the
 * field takes one record, and `repeat` keeps the dialog open afterwards with
 * the field cleared and the new link already excluded from the next search.
 * Adding four people is four picks either way; this way all four are reachable.
 */
export function LinkRecordDialog({
  open, deal, objectType, associationType, title, description, label, repeat, exclude,
  nearRecord, nearLabel, onClose, onLinked,
}: {
  open: boolean;
  deal: DealRecord;
  objectType: 'company' | 'contact';
  associationType: string;
  title: string;
  description: string;
  label: string;
  /** Stay open after a link lands, for a card that takes more than one record. */
  repeat?: boolean;
  /** Record ids already linked, hidden from the results so nothing is offered twice. */
  exclude: string[];
  /** A record whose own links come first — the deal's account, for the committee. */
  nearRecord?: string;
  /** What that record is called, for the heading over its half of the list. */
  nearLabel?: string;
  onClose: () => void;
  onLinked: () => void;
}) {
  const toast = useToast();
  const firstControl = useFirstControl();
  const [chosen, setChosen] = useState('');
  const [added, setAdded] = useState<string[]>([]);

  useEffect(() => { if (open) { setChosen(''); setAdded([]); } }, [open]);

  const toOption = useCallback((row: RecordOption, group?: string): ComboOption => ({
    value: row.id,
    label: row.display_name,
    description: describe(row, objectType) ?? row.id,
    ...(group ? { group } : {}),
  }), [objectType]);

  /**
   * The people on this deal's own account first, then the rest of the workspace.
   *
   * Typing one letter used to return whoever the workspace search ranked first
   * — six contacts from three other companies, and not one from the account the
   * deal belongs to — on the very screen whose job is naming the people who have
   * to say yes. One ArrowDown and Enter linked a stranger. The account's own
   * contacts are fetched with `associated_to` and put under a heading of their
   * own; everyone else stays reachable underneath.
   */
  const search = useCallback(async (query: string): Promise<ComboOption[]> => {
    const params = { q: query, limit: 20 };
    const [near, everyone] = await Promise.all([
      nearRecord
        ? api.get<ListEnvelope<RecordOption>>(`/v1/records/${objectType}`, { ...params, associated_to: nearRecord })
        : Promise.resolve(null),
      api.get<ListEnvelope<RecordOption>>(`/v1/records/${objectType}`, params),
    ]);
    const usable = (rows: RecordOption[]) => rows.filter((row) => !exclude.includes(row.id));
    const onAccount = usable(near?.data ?? []).slice(0, 8);
    const seen = new Set(onAccount.map((row) => row.id));
    const rest = usable(everyone.data).filter((row) => !seen.has(row.id)).slice(0, onAccount.length ? 6 : 8);
    if (!onAccount.length) return rest.map((row) => toOption(row));
    return [
      ...onAccount.map((row) => toOption(row, `On ${nearLabel ?? 'this account'}`)),
      ...rest.map((row) => toOption(row, 'Elsewhere in this workspace')),
    ];
  }, [objectType, exclude, nearRecord, nearLabel, toOption]);

  const link = useMutation<void, LinkResult>(
    () => api.post<LinkResult>('/v1/associations', {
      from_id: deal.id,
      to_id: chosen,
      association_type: associationType,
    }),
    {
      invalidates: ['/v1/records/deal', '/v1/associations', '/v1/crm/overview'],
      onSuccess: (result) => {
        invalidate(`/v1/records/deal/${deal.id}`);
        const replaced = result.replaced ?? [];
        toast.success(
          `${label} linked`,
          replaced.length
            ? `${deal.display_name} now belongs to ${result.display_name}, replacing ${replaced[0].display_name}.`
            : `${result.display_name} is now on ${deal.display_name}.`,
        );
        onLinked();
        if (repeat) { setAdded((prev) => [...prev, result.display_name]); setChosen(''); }
        else onClose();
      },
      onError: (e) => toast.error('Nothing was linked', e.body.message),
    },
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      initialFocus={firstControl.initialFocus}
      size="md"
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{added.length ? 'Done' : 'Cancel'}</Button>
          <Button
            variant="primary"
            loading={link.loading}
            disabled={!chosen}
            onClick={() => { void link.run().catch(() => undefined); }}
          >
            Link {objectType}
          </Button>
        </>
      }
    >
      <div className="pl-form" ref={firstControl.body}>
        {link.error && <Banner tone="danger" title="Nothing was linked">{link.error.body.message}</Banner>}
        {added.length > 0 && (
          <Banner tone="success" compact>
            Added {added.join(', ')}. Pick another, or press Done.
          </Banner>
        )}
        <Field
          label={label}
          hint={repeat
            ? `${nearLabel ? `${nearLabel}’s own contacts come first; everyone else is underneath` : 'Type to search this workspace’s contacts'}. The dialog stays open so you can add several.`
            : 'Type to search this workspace’s companies. A deal belongs to exactly one account, so this replaces the current link.'}
        >
          <Combobox
            value={chosen}
            onChange={(next) => setChosen(Array.isArray(next) ? next[0] ?? '' : next)}
            onSearch={search}
            placeholder={objectType === 'company' ? 'Search companies…' : 'Search contacts…'}
            emptyMessage={`No ${objectType} matches that — or every match is already linked.`}
            aria-label={label}
          />
        </Field>
      </div>
    </Modal>
  );
}

/* ------------------------------ account card ------------------------------ */

/** Who the deal belongs to, and the controls that change it. */
export function AccountCard({ deal, account, onChanged }: {
  deal: DealRecord;
  account: RecordAssociation | undefined;
  onChanged: () => void;
}) {
  const { navigate } = useRouter();
  const toast = useToast();
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  const unlink = useMutation<void, void>(
    () => api.del(`/v1/associations/${encodeURIComponent(account?.id ?? '')}`),
    {
      invalidates: ['/v1/records/deal', '/v1/associations', '/v1/crm/overview'],
      onSuccess: () => {
        invalidate(`/v1/records/deal/${deal.id}`);
        toast.success('Account unlinked', `${deal.display_name} no longer points at ${account?.display_name}.`);
        setUnlinking(false);
        onChanged();
      },
      onError: (e) => { setUnlinking(false); toast.error('The link was not removed', e.body.message); },
    },
  );

  const menu: MenuSection[] = [{
    id: 'account',
    items: [
      {
        id: 'open',
        label: 'Open the company',
        icon: <Icons.external size={14} />,
        onSelect: () => account && navigate(recordHref('company', account.record_id)),
      },
      { id: 'change', label: 'Change account', icon: <Icons.edit size={14} />, onSelect: () => setLinking(true) },
      {
        id: 'unlink',
        label: 'Unlink this account',
        icon: <Icons.trash size={14} />,
        danger: true,
        onSelect: () => setUnlinking(true),
      },
    ],
  }];

  return (
    <Card
      title="Account"
      description="Who this deal belongs to"
      actions={account
        ? <MenuButton sections={menu} label={`Account actions for ${account.display_name}`} size="sm" icon={<Icons.more size={14} />} />
        : <Button size="sm" variant="secondary" iconLeft={<Icons.link size={13} />} onClick={() => setLinking(true)}>Link</Button>}
    >
      {account ? (
        <button
          type="button"
          className="pl-assoc"
          data-association={account.id}
          onClick={() => navigate(recordHref('company', account.record_id))}
        >
          <Avatar name={account.display_name} seed={account.record_id} size={28} square />
          <span className="pl-assoc__text">
            <span className="pl-assoc__title u-truncate">{account.display_name}</span>
            <span className="pl-assoc__sub">{account.label}</span>
          </span>
          <ChevronRightIcon size={14} />
        </button>
      ) : (
        <EmptyState
          size="sm"
          inline
          illustration={null}
          title="No account linked"
          body="Associate a company so the invoice, the tickets and this deal all agree on who the customer is."
          action={
            <Button size="sm" variant="primary" iconLeft={<Icons.link size={13} />} onClick={() => setLinking(true)}>
              Link a company
            </Button>
          }
        />
      )}

      <LinkRecordDialog
        open={linking}
        deal={deal}
        objectType="company"
        associationType="deal_to_company"
        title={account ? 'Change the account' : 'Link an account'}
        description={account
          ? `${deal.display_name} belongs to ${account.display_name} today. Choosing another company moves it.`
          : `Point ${deal.display_name} at the company it belongs to.`}
        label="Company"
        exclude={account ? [account.record_id] : []}
        onClose={() => setLinking(false)}
        onLinked={onChanged}
      />

      <ConfirmDialog
        open={unlinking}
        onCancel={() => setUnlinking(false)}
        onConfirm={() => unlink.run().catch(() => undefined)}
        loading={unlink.loading}
        title="Unlink this account?"
        body={`${deal.display_name} stops pointing at ${account?.display_name}. The company itself is untouched, and you can link it again at any time.`}
        confirmLabel="Unlink account"
      />
    </Card>
  );
}

/* ----------------------------- committee card ----------------------------- */

/** The people who have to say yes, add and remove. */
export function CommitteeCard({ deal, contacts, onChanged }: {
  deal: DealRecord;
  contacts: RecordAssociation[];
  onChanged: () => void;
}) {
  const { navigate } = useRouter();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<RecordAssociation | null>(null);
  // The committee is drawn from the account the deal belongs to far more often
  // than from the rest of the workspace, so the account leads the picker.
  const account = accountOf(deal);

  const remove = useMutation<RecordAssociation, void>(
    (association) => api.del(`/v1/associations/${encodeURIComponent(association.id)}`),
    {
      invalidates: ['/v1/records/deal', '/v1/associations', '/v1/crm/overview'],
      onSuccess: (_result, association) => {
        invalidate(`/v1/records/deal/${deal.id}`);
        toast.success('Removed from the committee', `${association.display_name} is off ${deal.display_name}.`);
        setRemoving(null);
        onChanged();
      },
      onError: (e) => { setRemoving(null); toast.error('The contact was not removed', e.body.message); },
    },
  );

  return (
    <Card
      title="Buying committee"
      description={contacts.length === 1 ? '1 contact on this deal' : `${contacts.length} contacts on this deal`}
      actions={
        <Button size="sm" variant="secondary" iconLeft={<Icons.plus size={13} />} onClick={() => setAdding(true)}>
          Add
        </Button>
      }
    >
      {contacts.length === 0 && (
        <EmptyState
          size="sm"
          inline
          illustration={null}
          title="Nobody named yet"
          body="Add the people who have to say yes, so their calls and emails land on this deal’s timeline."
          action={
            <Button size="sm" variant="primary" iconLeft={<Icons.plus size={13} />} onClick={() => setAdding(true)}>
              Add a contact
            </Button>
          }
        />
      )}

      {contacts.map((contact) => (
        <div className="pl-assocrow" key={contact.id} data-association={contact.id}>
          <button
            type="button"
            className="pl-assoc"
            onClick={() => navigate(recordHref('contact', contact.record_id))}
          >
            <Avatar name={contact.display_name} seed={contact.record_id} size={26} />
            <span className="pl-assoc__text">
              <span className="pl-assoc__title u-truncate">{contact.display_name}</span>
              <span className="pl-assoc__sub">{contact.label}</span>
            </span>
            <ChevronRightIcon size={14} />
          </button>
          <Button
            size="sm"
            variant="ghost"
            className="pl-assocrow__remove"
            aria-label={`Remove ${contact.display_name} from the buying committee`}
            iconLeft={<Icons.x size={13} />}
            onClick={() => setRemoving(contact)}
          />
        </div>
      ))}

      <LinkRecordDialog
        open={adding}
        deal={deal}
        objectType="contact"
        associationType="deal_to_contact"
        repeat
        title="Add to the buying committee"
        description={`The people who have to say yes to ${deal.display_name}.`}
        label="Contacts"
        exclude={contacts.map((contact) => contact.record_id)}
        nearRecord={account?.record_id}
        nearLabel={account?.display_name}
        onClose={() => setAdding(false)}
        onLinked={onChanged}
      />

      <ConfirmDialog
        open={!!removing}
        tone="brand"
        onCancel={() => setRemoving(null)}
        onConfirm={() => { if (removing) void remove.run(removing).catch(() => undefined); }}
        loading={remove.loading}
        title="Remove from the committee?"
        body={`${removing?.display_name} comes off ${deal.display_name}. The contact record is untouched.`}
        confirmLabel="Remove"
      />
    </Card>
  );
}
