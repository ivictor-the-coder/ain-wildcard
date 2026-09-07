/**
 * Who is in this workspace, and what their role actually lets them do.
 *
 * Everyone who can open settings can read the roster. `GET /v1/users` carries
 * no `roles` gate — the server serves all six teammates to an analyst with a
 * 200 — so withholding it below admin was a screen inventing a refusal the API
 * never made. What is gated is every write on this page: invite, change role
 * and remove all declare `roles: ['admin']`. So the table renders for everyone
 * and the controls that change it appear for the people who can use them.
 *
 * The honest part is the role picker. The platform has five role names but only
 * three rungs that mean anything — `ROLE_RANK` in `src/server/kernel/http.ts`
 * is the one ladder every check reads, and every mutating route in the product
 * declares `roles: ['member']` or `roles: ['admin']`. So a picker that lists
 * five roles as though they were five different sets of powers is a lie, and
 * this one says out loud that analyst and readonly have identical reach, that
 * member cannot see the audit log, and that admin can do everything except seat
 * an owner.
 *
 * The other honest part is removal. `DELETE /v1/users/:id` deletes the seat,
 * ends every session that seat holds *and* revokes every API key it ever
 * minted. That is not a detail to bury: an admin removing a departing engineer
 * is also killing the CI credential that engineer created, and the confirmation
 * says so before it happens rather than the audit log saying so afterwards.
 *
 * And the invitation is a real invitation now. `POST /v1/users` mints a
 * one-time token and answers with it exactly once; `/accept?token=…` is where
 * the person sets a password and lands inside the workspace. So the token is
 * handled the way this module already handles the one other secret it shows —
 * the API key: its own panel, masked until revealed, copied, acknowledged
 * before the dialog will close. A seat sits at `invited` until the link is
 * redeemed, and the roster says so on every row that is in that state, with
 * "Send a fresh link" and "Cancel the invitation" where the ordinary seat
 * actions are.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, useQuery, type ListEnvelope } from '../../kernel/api';
import { useNavigate } from '../../kernel/router';
import { useSession } from '../../kernel/session';
import {
  Avatar, Badge, Banner, Button, Card, Checkbox, CopyField, DataTable, EmptyState, Field, Icons, Inline, Input, Modal,
  RadioGroup, Stack, StatusPill, Tooltip,
  useFormat, useToast,
  type DataTableColumn, type MenuSection, type TableState,
  AlertTriangleIcon,
} from '../../design';
import {
  DialogForm, ListFailure, ROLE_GRANTS, ROLE_ORDER, ROLE_RANK, ReadOnlyForYou, RoleBadge, SettingsShell, useAction,
  useConsumeQuery, useOpenFromQuery,
} from './common';
import type { InvitedMember, Member, Role } from './types';

/**
 * The one sentence that has to be true before anyone presses the button. The
 * platform mints the link but sends no mail, and an admin who does not know
 * that will invite six people and wonder why nobody arrives.
 */
export const INVITE_TRUTH =
  'A seat is created at the role you choose and a one-time invitation link is minted. Ain does not send email, so the '
  + 'link is shown to you once, here, and it is yours to pass on. The seat stays “invited” until they open it and set '
  + 'a password.';

/** Where an invitation is redeemed. Absolute, because it is going into someone else’s inbox. */
export const invitationUrl = (token: string): string =>
  `${typeof window === 'undefined' ? '' : window.location.origin}/accept?token=${encodeURIComponent(token)}`;

const ADMIN_ONLY = new Set<Role>(['owner', 'admin']);

/**
 * The sentence under each option in the picker — five names, three reaches.
 *
 * A greyed-out rung with no explanation is the reader's problem to solve; the
 * rule that closed it (`assertMayGrant`: nobody may hand out more authority
 * than they hold) is written where the option is, not further down the page
 * behind the open dialog.
 */
const roleOptions = (grantable: (role: Role) => boolean, myRole: Role) =>
  ROLE_ORDER.map((role) => ({
    value: role,
    label: (
      <Inline gap={3}>
        <span style={{ fontWeight: 'var(--weight-semibold)' }}>{role}</span>
        <span className="st-sub">{ROLE_GRANTS[role].summary}</span>
      </Inline>
    ),
    hint: grantable(role)
      ? ROLE_GRANTS[role].detail
      : `Closed to you: you hold ${myRole}, and nobody may grant a role above their own. The server refuses this one before it reads anything else.`,
    disabled: !grantable(role),
  }));

export function TeamPage() {
  const session = useSession();
  const f = useFormat();
  const toast = useToast();
  const navigate = useNavigate();
  const action = useAction();
  const members = useQuery<ListEnvelope<Member>>('/v1/users');

  const [inviting, setInviting] = useState(false);
  /** The seat whose one-time link is on screen — from a fresh invitation or a re-send. */
  const [minted, setMinted] = useState<InvitedMember | null>(null);
  const [editing, setEditing] = useState<Member | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [view, setView] = useState<TableState>({ query: '', sort: { columnId: 'role', direction: 'asc' }, filters: {} });
  /**
   * `?member=usr_…` is the address the audit trail writes for a teammate it
   * names. The roster answers with that one seat on top — the search is set to
   * their email, which is unique — once the list it has to look them up in has
   * arrived. A seat the roster no longer holds is answered with a sentence that
   * says so, not with a search for an id that finds nobody.
   */
  const [wanted, setWanted] = useState<string | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  useConsumeQuery('member', setWanted);

  const myRole = (session.me?.role ?? 'readonly') as Role;
  const myId = session.me?.user?.id ?? null;
  const admin = ADMIN_ONLY.has(myRole);
  // Nobody may hand out more authority than they hold; the server enforces this
  // and answers 403, so the picker refuses the same rungs rather than offering
  // a choice it knows will be refused.
  const grantable = (role: Role) => ROLE_GRANTS[role] !== undefined && ROLE_RANK[myRole] >= ROLE_RANK[role];

  // The palette's Invite entry lands here with the dialog already open — or,
  // for a role the server would refuse, with the reason instead of nothing.
  useOpenFromQuery('invite', () => {
    if (admin) { action.clear(); setInviting(true); return; }
    toast.info(
      'Inviting a teammate needs the admin role',
      `Your role on this workspace is ${myRole}, and POST /v1/users is gated at admin — so the dialog is not offered rather than offered and refused.`,
    );
  });

  const rows = members.data?.data ?? [];
  useEffect(() => {
    if (!wanted || !members.data) return;
    const seat = members.data.data.find((row) => row.id === wanted);
    if (seat) setView((current) => ({ ...current, query: seat.email }));
    else setGone(wanted);
    setWanted(null);
  }, [wanted, members.data]);
  const adminCount = rows.filter((row) => ADMIN_ONLY.has(row.role)).length;
  const ownerCount = rows.filter((row) => row.role === 'owner').length;

  const columns = useMemo<DataTableColumn<Member>[]>(() => [
    {
      id: 'name',
      header: 'Teammate',
      pinned: true,
      width: 300,
      // Name, email and role together, so the search the placeholder promises
      // finds all three — the role column itself sorts on rank, not on text.
      accessor: (row) => `${row.name} ${row.email} ${row.role}`,
      cell: (row) => (
        <Inline gap={4}>
          <Avatar name={row.name} seed={row.id} size={28} />
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontWeight: 'var(--weight-medium)' }} className="u-truncate">
              {row.name}
              {row.id === myId ? <span className="st-sub"> · you</span> : null}
            </span>
            <span className="st-sub u-truncate" style={{ display: 'block' }}>{row.email}</span>
          </span>
        </Inline>
      ),
    },
    {
      id: 'status',
      header: 'Seat',
      width: 130,
      filter: 'set',
      accessor: (row) => row.status,
      filterOptionLabel: (value) => (value === 'invited' ? 'Invited' : 'Active'),
      cell: (row) => (
        <StatusPill
          status={row.status}
          title={row.status === 'invited'
            ? (row.invitation
              ? `Invited ${f.relative(row.invitation.created)}. The link expires ${f.date(row.invitation.expires, { withYear: true })}.`
              : 'Invited. The link has expired or was cancelled — send a fresh one.')
            : undefined}
        />
      ),
    },
    { id: 'title', header: 'Job title', accessor: (row) => row.title ?? '', cell: (row) => row.title ?? <span className="st-sub">—</span> },
    {
      id: 'role',
      header: 'Role',
      width: 190,
      filter: 'set',
      /**
       * The ladder, not the alphabet. Sorted on the role's name the owner came
       * last — admin, analyst, member, member, member, owner — which is the one
       * order nobody reading a roster expects. The accessor is the rung's index
       * in `ROLE_ORDER`, so ascending reads owner → admin → member → analyst →
       * readonly, and the filter menu maps the index back to the word.
       */
      accessor: (row) => ROLE_ORDER.indexOf(row.role),
      filterOptionLabel: (value) => ROLE_ORDER[Number(value)] ?? value,
      cell: (row) => (
        <Tooltip content={ROLE_GRANTS[row.role].detail}>
          <span><RoleBadge role={row.role} /></span>
        </Tooltip>
      ),
    },
    {
      id: 'teams',
      header: 'Teams',
      accessor: (row) => row.teams.join(', '),
      cell: (row) => (row.teams.length
        ? <Inline gap={2} wrap>{row.teams.map((team) => <Badge key={team} tone="neutral">{team}</Badge>)}</Inline>
        : <span className="st-sub">—</span>),
    },
    {
      id: 'last_seen',
      header: 'Last seen',
      align: 'right',
      width: 150,
      accessor: (row) => row.last_seen ?? 0,
      cell: (row) => {
        if (row.last_seen) {
          return <Tooltip content={f.dateTime(row.last_seen)}><span>{f.relative(row.last_seen)}</span></Tooltip>;
        }
        // "Never signed in" is what an abandoned seat reads; an invited one has
        // not been given the chance yet, and the useful fact is the deadline.
        if (row.status === 'invited' && row.invitation) {
          return (
            <Tooltip content={`Invitation sent ${f.dateTime(row.invitation.created)}`}>
              <span className="st-sub">{`Link expires ${f.relative(row.invitation.expires)}`}</span>
            </Tooltip>
          );
        }
        return <span className="st-sub">{row.status === 'invited' ? 'Invitation lapsed' : 'Never signed in'}</span>;
      },
    },
  ], [f, myId]);

  /** A fresh token, the old one voided. The link comes back once, so it opens the same panel a new invitation does. */
  const reinvite = async (row: Member) => {
    const seat = await action.run(
      api.post<InvitedMember>(`/v1/users/${row.id}/reinvite`, {}),
      {
        success: `A fresh link for ${row.name}`,
        description: 'The previous link stopped working the moment this one was minted.',
        failure: 'No new link was minted',
      },
      ['/v1/users', '/v1/audit-log'],
    );
    if (seat) setMinted(seat);
  };

  const rowActions = (row: Member): MenuSection[] => [{
    id: 'seat',
    items: [
      ...(row.status === 'invited'
        ? [
          {
            id: 'reinvite',
            label: 'Send a fresh link…',
            icon: <Icons.refresh size={14} />,
            disabled: !admin,
            onSelect: () => { action.clear(); void reinvite(row); },
          },
        ]
        : []),
      {
        id: 'role',
        label: 'Change role…',
        icon: <Icons.shield size={14} />,
        disabled: !admin || !grantable(row.role),
        onSelect: () => { action.clear(); setEditing(row); },
      },
      {
        id: 'remove',
        label: row.status === 'invited' ? 'Cancel the invitation…' : 'Remove from workspace…',
        icon: <Icons.trash size={14} />,
        danger: true,
        disabled: !admin || row.id === myId || !grantable(row.role),
        onSelect: () => { action.clear(); setRemoving(row); },
      },
    ],
  }];

  const invitedCount = rows.filter((row) => row.status === 'invited').length;

  return (
    <SettingsShell
      title="Team"
      subtitle={`${f.plural(rows.length, 'teammate')} in ${session.me?.org.name ?? 'this workspace'}${
        invitedCount ? `, ${invitedCount} still to accept an invitation` : ''}.`}
      actions={admin
        ? (
          <Button variant="primary" iconLeft={<Icons.plus size={15} />} onClick={() => { action.clear(); setInviting(true); }}>
            Invite a teammate
          </Button>
        )
        : undefined}
    >
      <Stack gap={6}>
        {members.error && <ListFailure error={members.error} path="GET /v1/users" onRetry={members.refetch} />}

        {gone && (
          <Banner
            tone="info"
            compact
            title="That teammate is no longer on the roster"
            onDismiss={() => setGone(null)}
            actions={admin
              ? (
                <Button size="sm" variant="secondary" onClick={() => navigate(`/settings/audit?target=${encodeURIComponent(gone)}`)}>
                  What the trail says
                </Button>
              )
              : undefined}
          >
            {'GET /v1/users holds no seat with the id '}
            <span className="st-mono">{gone}</span>
            {'. A removed seat is gone from the roster for good — the audit trail keeps who they were, who removed '
              + 'them and when, under that id.'}
          </Banner>
        )}

        {!admin && (
          <ReadOnlyForYou
            what="the team"
            reads="GET /v1/users"
            writes="Inviting, changing a role and removing a seat are gated at admin"
          />
        )}

        {admin && invitedCount > 0 && (
          <Banner tone="info" compact title={`${f.plural(invitedCount, 'invitation')} still open`}>
            {'Ain mints the link but sends no mail, so an invitation only travels once somebody passes it on. Nobody '
              + 'on an invited seat can sign in, own a record or hold a key until they open theirs and set a password. '
              + '“Send a fresh link” on the row mints a new one and voids the old.'}
          </Banner>
        )}

        {admin && adminCount === 1 && (
          <Banner tone="warning" compact title="One admin holds this workspace">
            {'Only one seat here is admin or above. The platform refuses to demote or remove the last one — there would '
              + 'be nobody left who could undo it — so a second admin is what makes that seat recoverable.'}
          </Banner>
        )}

        <Card padding="none">
          <DataTable
            rows={rows}
            columns={columns}
            getRowId={(row) => row.id}
            caption="Workspace members"
            loading={members.loading}
            searchable
            searchPlaceholder="Search by name, email or role"
            showFilters
            showColumnToggle
            value={view}
            onChange={setView}
            rowActions={admin ? rowActions : undefined}
            onRowClick={admin ? (row) => { if (grantable(row.role)) { action.clear(); setEditing(row); } } : undefined}
            empty={
              <EmptyState
                size="sm"
                inline
                illustration={<Icons.users size={22} />}
                title="Nobody has been invited yet"
                body="A workspace with one seat is a workspace nobody can take over from you."
                action={admin
                  ? <Button size="sm" variant="primary" onClick={() => setInviting(true)}>Invite a teammate</Button>
                  : undefined}
              />
            }
          />
        </Card>

        <Card title="What each role reaches" description="Five names, three rungs — this is what the server actually enforces.">
          <div className="st-rows">
            {ROLE_ORDER.map((role) => (
              <div className="st-row" key={role}>
                <div className="st-row__main">
                  <div className="st-row__title"><RoleBadge role={role} /> {ROLE_GRANTS[role].summary}</div>
                  <div className="st-row__sub">{ROLE_GRANTS[role].detail}</div>
                </div>
                <div className="st-row__aside">
                  <span className="st-sub">{f.plural(rows.filter((row) => row.role === role).length, 'seat')}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </Stack>

      <InviteDialog
        open={inviting && admin}
        grantable={grantable}
        myRole={myRole}
        action={action}
        onClose={() => setInviting(false)}
        onInvited={setMinted}
      />

      <InvitationLinkDialog seat={minted} onClose={() => setMinted(null)} />

      <RoleDialog
        member={admin ? editing : null}
        grantable={grantable}
        myRole={myRole}
        adminCount={adminCount}
        ownerCount={ownerCount}
        myId={myId}
        action={action}
        onClose={() => setEditing(null)}
      />

      <RemoveDialog
        member={admin ? removing : null}
        action={action}
        onClose={() => setRemoving(null)}
      />
    </SettingsShell>
  );
}

/* ================================= invite ================================= */

type Action = ReturnType<typeof useAction>;

function InviteDialog({ open, grantable, myRole, action, onClose, onInvited }: {
  open: boolean;
  grantable: (role: Role) => boolean;
  myRole: Role;
  action: Action;
  onClose: () => void;
  /** Hands the seat back with its one-time token, which is shown once and never again. */
  onInvited: (seat: InvitedMember) => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [role, setRole] = useState<Role>('member');
  const first = useRef<HTMLInputElement>(null);

  const reset = () => { setEmail(''); setName(''); setTitle(''); setRole('member'); action.clear(); };
  const close = () => { reset(); onClose(); };
  const valid = email.trim().length > 0 && name.trim().length > 0;

  const submit = async () => {
    if (!valid || action.busy) return;
    const saved = await action.run(
      api.post<InvitedMember>('/v1/users', {
        email: email.trim().toLowerCase(),
        name: name.trim(),
        role,
        ...(title.trim() ? { title: title.trim() } : {}),
      }),
      {
        success: `${name.trim() || email.trim()} has a seat`,
        description:
          `Seated as ${role} — ${ROLE_GRANTS[role].summary.toLowerCase()}. Their invitation link is on screen now, and `
          + 'this is the only time it is shown.',
        failure: 'The invitation was refused',
        inlineOnly: true,
      },
      ['/v1/users', '/v1/me', '/v1/audit-log'],
    );
    if (saved) { reset(); onClose(); onInvited(saved); }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Invite a teammate"
      description={INVITE_TRUTH}
      size="md"
      initialFocus={first}
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            loading={action.busy}
            disabled={!valid}
            onClick={() => void submit()}
          >
            Invite and show me the link
          </Button>
        </>
      }
    >
      <DialogForm onSubmit={() => void submit()}>
        <Stack gap={5}>
          {action.error && !action.error.body.param && (
            <Banner tone="danger" compact title="The invitation was refused">{action.error.body.message}</Banner>
          )}
          <Banner tone="info" compact title="You will be handed the link, once">
            <code className="st-mono">POST /v1/users</code>
            {' answers with a one-time token; Ain stores only its hash and no route ever reads it back. Send the link '
              + 'to them yourself — it is good for seven days, and '}
            <code className="st-mono">POST /v1/auth/accept</code>
            {' spends it the moment they set a password. Lose it and “Send a fresh link” on their row mints another.'}
          </Banner>
          <Field label="Work email" required error={action.errorFor('email')}>
            <Input
              ref={first}
              type="email"
              value={email}
              placeholder="name@northwind.io"
              invalid={!!action.errorFor('email')}
              onChange={(e) => setEmail(e.target.value)}
              aria-label="Work email"
            />
          </Field>
          <Field label="Full name" required error={action.errorFor('name')}>
            <Input
              value={name}
              placeholder="Priya Raman"
              invalid={!!action.errorFor('name')}
              onChange={(e) => setName(e.target.value)}
              aria-label="Full name"
            />
          </Field>
          <Field label="Job title" optional error={action.errorFor('title')}>
            <Input value={title} placeholder="Account Executive" onChange={(e) => setTitle(e.target.value)} aria-label="Job title" />
          </Field>
          <Field label="Role" required error={action.errorFor('role')}>
            <RadioGroup
              label="Role"
              value={role}
              onChange={setRole}
              options={roleOptions(grantable, myRole)}
            />
          </Field>
        </Stack>
      </DialogForm>
    </Modal>
  );
}

/* ============================ the one-time link =========================== */

/**
 * The invitation link, on screen for the only moment it exists.
 *
 * This is the API-key dialog's pattern, deliberately: the same masked field,
 * the same copy control, the same acknowledgement before Esc or the backdrop
 * will close it. A person who has met one of these on the API keys screen
 * knows exactly what this one is, and that dismissing it by accident is how
 * a secret is lost.
 */
function InvitationLinkDialog({ seat, onClose }: { seat: InvitedMember | null; onClose: () => void }) {
  const f = useFormat();
  const [acknowledged, setAcknowledged] = useState(false);
  const [seeded, setSeeded] = useState<string | null>(null);

  if (seat && seeded !== seat.invitation.id) { setSeeded(seat.invitation.id); setAcknowledged(false); }
  if (!seat) return null;

  const url = invitationUrl(seat.invitation.token);
  return (
    <Modal
      open
      dismissable={acknowledged}
      showClose={acknowledged}
      onClose={onClose}
      title={`${seat.name}’s invitation is ready`}
      description="This is the only time this link exists outside your clipboard."
      icon={<Icons.mail size={18} />}
      iconTone="warning"
      size="md"
      footer={
        <Button variant="primary" disabled={!acknowledged} onClick={onClose}>
          {acknowledged ? 'Done' : 'Copy it first'}
        </Button>
      }
    >
      <Stack gap={5}>
        <div className="st-secret">
          <div>
            <div style={{ fontWeight: 'var(--weight-semibold)' }}>Send this to {seat.email}</div>
            <div className="st-sub">
              {'Ain stores only a hash of the token in it. Nobody — not you, not an owner — can read it back. If it is '
                + 'lost, “Send a fresh link” on their row mints another and voids this one.'}
            </div>
          </div>
          <CopyField
            value={url}
            secret
            // The address is the part an operator checks before sending; the
            // token is the part nobody else may read over their shoulder.
            maskAfter={url.length - seat.invitation.token.length}
            mono
            label="Copy the invitation link"
          />
        </div>

        <div className="st-rows">
          <div className="st-row">
            <div className="st-row__main">
              <div className="st-row__title">What it does</div>
              <div className="st-row__sub">
                {`Opens /accept, where they set a password and land in ${seat.role === 'owner' ? 'the workspace as an owner' : `the workspace as ${seat.role === 'admin' || seat.role === 'analyst' ? 'an' : 'a'} ${seat.role}`}. It works once.`}
              </div>
            </div>
          </div>
          <div className="st-row">
            <div className="st-row__main">
              <div className="st-row__title">Good until</div>
              <div className="st-row__sub">{`${f.dateTime(seat.invitation.expires)} · ${f.relative(seat.invitation.expires)}`}</div>
            </div>
            <div className="st-row__aside"><Badge tone="warning" pill>expires</Badge></div>
          </div>
          <div className="st-row">
            <div className="st-row__main">
              <div className="st-row__title">Until they open it</div>
              <div className="st-row__sub">Their row on the roster reads “Invited”. They own nothing and can sign in to nothing.</div>
            </div>
            <div className="st-row__aside"><StatusPill status="invited" /></div>
          </div>
        </div>

        <Checkbox
          checked={acknowledged}
          onChange={setAcknowledged}
          label="I have copied the link and can get it to them."
        />
      </Stack>
    </Modal>
  );
}

/* ================================ role edit =============================== */

function RoleDialog({ member, grantable, myRole, adminCount, ownerCount, myId, action, onClose }: {
  member: Member | null;
  grantable: (role: Role) => boolean;
  myRole: Role;
  adminCount: number;
  ownerCount: number;
  myId: string | null;
  action: Action;
  onClose: () => void;
}) {
  const [role, setRole] = useState<Role>('member');
  const [seeded, setSeeded] = useState<string | null>(null);
  const [teams, setTeams] = useState('');
  const [typed, setTyped] = useState('');

  // Seeding in render rather than an effect keeps the dialog from painting one
  // frame with the previous member's role selected.
  if (member && seeded !== member.id) {
    setSeeded(member.id);
    setRole(member.role);
    setTeams(member.teams.join(', '));
    setTyped('');
  }

  if (!member) return null;

  const teamList = teams.split(',').map((team) => team.trim()).filter(Boolean);
  const teamsChanged = teamList.join('|') !== member.teams.join('|');
  const roleChanged = role !== member.role;
  const lastAdmin = ADMIN_ONLY.has(member.role) && adminCount === 1 && !ADMIN_ONLY.has(role);
  const demotingSelf = member.id === myId && ROLE_RANK[role] < ROLE_RANK[member.role];
  /**
   * The one change on this surface that cannot be undone by anybody.
   *
   * `assertMayGrant` refuses to seat an owner to anyone below owner, so once
   * the last owner steps down there is no one left in the workspace who may put
   * an owner back — an admin opens this same dialog and finds the rung disabled.
   * The server enforces it deliberately; the dialog has to say it before, not
   * the audit log afterwards.
   */
  const destroysOwnerSeat = member.role === 'owner' && role !== 'owner' && ownerCount === 1;
  const confirmed = !destroysOwnerSeat || typed.trim().toLowerCase() === member.email.toLowerCase();
  const submittable = (roleChanged || teamsChanged) && !lastAdmin && confirmed;

  const submit = async () => {
    if (!submittable || action.busy) return;
    const saved = await action.run(
      api.patch<Member>(`/v1/users/${member.id}`, {
        ...(roleChanged ? { role } : {}),
        ...(teamsChanged ? { teams: teamList } : {}),
      }),
      {
        success: `${member.name} is now ${role}`,
        description: ROLE_GRANTS[role].summary,
        failure: 'The role was not changed',
        inlineOnly: true,
      },
      ['/v1/users', '/v1/me', '/v1/audit-log'],
    );
    if (saved) onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={member.name}
      description={`${member.email} · joined ${new Date(member.created).getUTCFullYear()}`}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant={demotingSelf || destroysOwnerSeat ? 'danger' : 'primary'}
            loading={action.busy}
            disabled={!submittable}
            onClick={() => void submit()}
          >
            {demotingSelf ? 'Lower my own role' : destroysOwnerSeat ? 'Give up the owner seat' : 'Save'}
          </Button>
        </>
      }
    >
      <DialogForm onSubmit={() => void submit()}>
      <Stack gap={5}>
        {action.error && !action.error.body.param && (
          <Banner tone="danger" compact title="The role was not changed">{action.error.body.message}</Banner>
        )}
        {lastAdmin && (
          <Banner tone="warning" compact title="This is the workspace’s last admin">
            {'Lowering this seat would leave nobody who can administer the workspace, and the platform refuses it. '
              + 'Promote another teammate to admin first, then come back.'}
          </Banner>
        )}
        {demotingSelf && !lastAdmin && (
          <Banner tone="warning" compact title="You are lowering your own role">
            {`Your session is resolved against this membership on every request, so from the moment you save you hold `
              + `${role} — including on this screen. `}
            {destroysOwnerSeat
              ? 'An admin can raise you back as far as admin.'
              : 'Another admin would have to raise it again.'}
          </Banner>
        )}

        {destroysOwnerSeat && !lastAdmin && (
          <Banner
            tone="danger"
            compact
            title={member.id === myId ? 'This ends the owner seat for good' : `${member.name} holds the only owner seat`}
          >
            {'Nobody may grant a role above their own, so an admin cannot seat an owner — the rung is disabled in '
              + 'their copy of this dialog. This workspace holds exactly one owner, and once it goes down '
              + 'nobody left in this workspace could restore it. Everything an owner alone can do would be gone '
              + 'until someone with database access puts the row back. Seat a second owner first if that is not what '
              + 'you mean to do.'}
          </Banner>
        )}

        {destroysOwnerSeat && !lastAdmin && (
          <Field
            label={`Type ${member.email} to confirm`}
            required
            hint="The same confirmation removing a seat asks for — this is the more destructive of the two."
          >
            <Input
              value={typed}
              placeholder={member.email}
              onChange={(e) => setTyped(e.target.value)}
              aria-label={`Type ${member.email} to confirm`}
            />
          </Field>
        )}

        <Field label="Role" required error={action.errorFor('role')}>
          <RadioGroup label="Role" value={role} onChange={setRole} options={roleOptions(grantable, myRole)} />
        </Field>

        {roleChanged && (
          <Banner tone="info" compact title={`From ${member.role} to ${role}`}>
            {ROLE_GRANTS[role].detail}
          </Banner>
        )}

        <Field
          label="Teams"
          optional
          hint="Comma separated. Teams route work and scope saved views; they grant no authority of their own."
          error={action.errorFor('teams')}
        >
          <Input value={teams} placeholder="Sales, Customer Success" onChange={(e) => setTeams(e.target.value)} aria-label="Teams" />
        </Field>
      </Stack>
      </DialogForm>
    </Modal>
  );
}

/* ================================= removal ================================ */

function RemoveDialog({ member, action, onClose }: { member: Member | null; action: Action; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [seeded, setSeeded] = useState<string | null>(null);

  if (member && seeded !== member.id) { setSeeded(member.id); setTyped(''); }
  if (!member) return null;

  /**
   * The same route, two very different acts. On an active seat `DELETE` ends
   * sessions and revokes keys; on an invited one there is nothing yet to end —
   * it voids a link nobody has opened. Asking an admin to type an address to
   * cancel an invitation that has done nothing is friction with no risk behind
   * it, so only the destructive half asks.
   */
  const pending = member.status === 'invited';
  const confirmed = pending || typed.trim().toLowerCase() === member.email.toLowerCase();

  const submit = async () => {
    if (!confirmed || action.busy) return;
    // `DELETE` answers 204 with no body, which `api.del` resolves as `null` —
    // indistinguishable from the refusal `run` reports the same way. Mapping it
    // to `true` is what lets the dialog know the seat is actually gone.
    const done = await action.run(
      api.del<void>(`/v1/users/${member.id}`).then(() => true),
      {
        success: pending ? `${member.name}’s invitation was cancelled` : `${member.name} was removed`,
        description: pending
          ? 'Their link stopped working. Inviting the same address again mints a fresh one.'
          : 'Their sessions were ended and every API key they minted was revoked.',
        failure: pending ? 'The invitation was not cancelled' : 'They were not removed',
        inlineOnly: true,
      },
      ['/v1/users', '/v1/api-keys', '/v1/me', '/v1/audit-log'],
    );
    if (done) onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={pending ? `Cancel ${member.name}’s invitation?` : `Remove ${member.name}?`}
      icon={<AlertTriangleIcon size={18} />}
      iconTone={pending ? 'warning' : 'danger'}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{pending ? 'Leave it open' : 'Keep the seat'}</Button>
          <Button variant="danger" loading={action.busy} disabled={!confirmed} onClick={() => void submit()}>
            {pending ? 'Cancel the invitation' : 'Remove and revoke'}
          </Button>
        </>
      }
    >
      <DialogForm onSubmit={() => void submit()}>
        <Stack gap={5}>
          {action.error && (
            <Banner tone="danger" compact title={pending ? 'The invitation was not cancelled' : 'They were not removed'}>
              {action.error.body.message}
            </Banner>
          )}
          {pending ? (
            <Banner tone="warning" compact title="Their link stops working">
              {`${member.name} has not accepted yet, so there are no sessions to end and no API keys to revoke. The seat `
                + 'goes and the link they were sent is void. Inviting '}
              <span className="st-mono">{member.email}</span>
              {' again creates a new seat with a new link.'}
            </Banner>
          ) : (
            <Banner tone="danger" compact title="This ends three things at once">
              {'The membership goes, every session it holds is deleted, and every API key this person ever minted is '
                + 'revoked — including keys other integrations are using right now. Re-inviting the same address later '
                + 'creates a fresh seat; it does not bring the keys back.'}
            </Banner>
          )}
          {!pending && (
            <Field
              label={`Type ${member.email} to confirm`}
              required
              hint="An address is harder to type by accident than a click is to make."
            >
              <Input
                value={typed}
                autoFocus
                placeholder={member.email}
                onChange={(e) => setTyped(e.target.value)}
                aria-label={`Type ${member.email} to confirm removal`}
              />
            </Field>
          )}
        </Stack>
      </DialogForm>
    </Modal>
  );
}
