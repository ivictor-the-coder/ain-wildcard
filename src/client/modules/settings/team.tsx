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
 */
import { useMemo, useRef, useState } from 'react';
import { api, useQuery, type ListEnvelope } from '../../kernel/api';
import { useSession } from '../../kernel/session';
import {
  Avatar, Badge, Banner, Button, Card, DataTable, EmptyState, Field, Icons, Inline, Input, Modal,
  RadioGroup, Stack, Tooltip,
  useFormat,
  type DataTableColumn, type MenuSection,
  AlertTriangleIcon,
} from '../../design';
import {
  ListFailure, ROLE_GRANTS, ROLE_ORDER, ROLE_RANK, ReadOnlyForYou, RoleBadge, SettingsShell, useAction,
  useOpenFromQuery,
} from './common';
import type { Member, Role } from './types';

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
  const action = useAction();
  const members = useQuery<ListEnvelope<Member>>('/v1/users');

  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);

  const myRole = (session.me?.role ?? 'readonly') as Role;
  const myId = session.me?.user?.id ?? null;
  const admin = ADMIN_ONLY.has(myRole);
  // Nobody may hand out more authority than they hold; the server enforces this
  // and answers 403, so the picker refuses the same rungs rather than offering
  // a choice it knows will be refused.
  const grantable = (role: Role) => ROLE_GRANTS[role] !== undefined && ROLE_RANK[myRole] >= ROLE_RANK[role];

  // The palette's Invite entry lands here with the dialog already open.
  useOpenFromQuery('invite', () => { if (admin) { action.clear(); setInviting(true); } });

  const rows = members.data?.data ?? [];
  const adminCount = rows.filter((row) => ADMIN_ONLY.has(row.role)).length;
  const ownerCount = rows.filter((row) => row.role === 'owner').length;

  const columns = useMemo<DataTableColumn<Member>[]>(() => [
    {
      id: 'name',
      header: 'Teammate',
      pinned: true,
      width: 300,
      accessor: (row) => row.name,
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
    { id: 'title', header: 'Job title', accessor: (row) => row.title ?? '', cell: (row) => row.title ?? <span className="st-sub">—</span> },
    {
      id: 'role',
      header: 'Role',
      width: 190,
      filter: 'set',
      accessor: (row) => row.role,
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
      cell: (row) => (row.last_seen
        ? <Tooltip content={f.dateTime(row.last_seen)}><span>{f.relative(row.last_seen)}</span></Tooltip>
        : <span className="st-sub">Never signed in</span>),
    },
  ], [f, myId]);

  const rowActions = (row: Member): MenuSection[] => [{
    id: 'seat',
    items: [
      {
        id: 'role',
        label: 'Change role…',
        icon: <Icons.shield size={14} />,
        disabled: !admin || !grantable(row.role),
        onSelect: () => { action.clear(); setEditing(row); },
      },
      {
        id: 'remove',
        label: 'Remove from workspace…',
        icon: <Icons.trash size={14} />,
        danger: true,
        disabled: !admin || row.id === myId || !grantable(row.role),
        onSelect: () => { action.clear(); setRemoving(row); },
      },
    ],
  }];

  return (
    <SettingsShell
      title="Team"
      subtitle={`${f.plural(rows.length, 'teammate')} in ${session.me?.org.name ?? 'this workspace'}.`}
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

        {!admin && (
          <ReadOnlyForYou
            what="the team"
            reads="GET /v1/users"
            writes="Inviting, changing a role and removing a seat are gated at admin"
          />
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
            initialSort={{ columnId: 'role', direction: 'asc' }}
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
      />

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

function InviteDialog({ open, grantable, myRole, action, onClose }: {
  open: boolean;
  grantable: (role: Role) => boolean;
  myRole: Role;
  action: Action;
  onClose: () => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [role, setRole] = useState<Role>('member');
  const first = useRef<HTMLInputElement>(null);

  const reset = () => { setEmail(''); setName(''); setTitle(''); setRole('member'); action.clear(); };
  const close = () => { reset(); onClose(); };

  const submit = async () => {
    const saved = await action.run(
      api.post<Member>('/v1/users', {
        email: email.trim().toLowerCase(),
        name: name.trim(),
        role,
        ...(title.trim() ? { title: title.trim() } : {}),
      }),
      {
        success: `${name.trim() || email.trim()} is on the team`,
        description: `Seated as ${role} — ${ROLE_GRANTS[role].summary.toLowerCase()}.`,
        failure: 'The invitation was refused',
        inlineOnly: true,
      },
      ['/v1/users', '/v1/me'],
    );
    if (saved) close();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Invite a teammate"
      description="They join this workspace immediately at the role you choose."
      size="md"
      initialFocus={first}
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            loading={action.busy}
            disabled={!email.trim() || !name.trim()}
            onClick={() => void submit()}
          >
            Add to workspace
          </Button>
        </>
      }
    >
      <Stack gap={5}>
        {action.error && !action.error.body.param && (
          <Banner tone="danger" compact title="The invitation was refused">{action.error.body.message}</Banner>
        )}
        <Field label="Work email" required error={action.errorFor('email')}>
          <Input
            ref={first}
            type="email"
            value={email}
            placeholder="name@northwind.io"
            invalid={!!action.errorFor('email')}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && email.trim() && name.trim()) void submit(); }}
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

  const submit = async () => {
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
            disabled={(!roleChanged && !teamsChanged) || lastAdmin || !confirmed}
            onClick={() => void submit()}
          >
            {demotingSelf ? 'Lower my own role' : destroysOwnerSeat ? 'Give up the owner seat' : 'Save'}
          </Button>
        </>
      }
    >
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
              onKeyDown={(e) => { if (e.key === 'Enter' && confirmed && (roleChanged || teamsChanged)) void submit(); }}
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
    </Modal>
  );
}

/* ================================= removal ================================ */

function RemoveDialog({ member, action, onClose }: { member: Member | null; action: Action; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [seeded, setSeeded] = useState<string | null>(null);

  if (member && seeded !== member.id) { setSeeded(member.id); setTyped(''); }
  if (!member) return null;

  const confirmed = typed.trim().toLowerCase() === member.email.toLowerCase();

  const submit = async () => {
    // `DELETE` answers 204 with no body, which `api.del` resolves as `null` —
    // indistinguishable from the refusal `run` reports the same way. Mapping it
    // to `true` is what lets the dialog know the seat is actually gone.
    const done = await action.run(
      api.del<void>(`/v1/users/${member.id}`).then(() => true),
      {
        success: `${member.name} was removed`,
        description: 'Their sessions were ended and every API key they minted was revoked.',
        failure: 'They were not removed',
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
      title={`Remove ${member.name}?`}
      icon={<AlertTriangleIcon size={18} />}
      iconTone="danger"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Keep the seat</Button>
          <Button variant="danger" loading={action.busy} disabled={!confirmed} onClick={() => void submit()}>
            Remove and revoke
          </Button>
        </>
      }
    >
      <Stack gap={5}>
        {action.error && (
          <Banner tone="danger" compact title="They were not removed">{action.error.body.message}</Banner>
        )}
        <Banner tone="danger" compact title="This ends three things at once">
          {'The membership goes, every session it holds is deleted, and every API key this person ever minted is '
            + 'revoked — including keys other integrations are using right now. Re-inviting the same address later '
            + 'creates a fresh seat; it does not bring the keys back.'}
        </Banner>
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
            onKeyDown={(e) => { if (e.key === 'Enter' && confirmed) void submit(); }}
            aria-label={`Type ${member.email} to confirm removal`}
          />
        </Field>
      </Stack>
    </Modal>
  );
}
