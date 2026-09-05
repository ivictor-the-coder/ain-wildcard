/**
 * The settings surface.
 *
 * Nine screens over the parts of the platform that had a finished API and no
 * way in: the workspace itself, the team and what its roles actually grant, the
 * API keys, the audit trail, the event stream, the durable job queue, the tax
 * register, the feature catalogue with per-account entitlements, and the time
 * machine — which every other product hides behind a test-clock endpoint and
 * this one puts on a screen.
 *
 * `SETTINGS_NAV` in `./common` is the single list of what exists. The routes,
 * the sidebar entry, the command palette entries and the settings registry are
 * all derived from it, so a page cannot be added without becoming reachable and
 * cannot be reachable without existing.
 */
import type { CommandDef, NavItem, RouteDef, SettingsPage, WidgetDef } from '../../kernel/registry-types';
import { useQuery, type ListEnvelope } from '../../kernel/api';
import { useNavigate } from '../../kernel/router';
import { useSession } from '../../kernel/session';
import { Badge, Button, Card, EmptyState, Icons, Inline, Stack, Stat, useFormat } from '../../design';
import { describeOffset } from '../../kernel/shell-core';
import { SETTINGS_NAV } from './common';
import { WorkspacePage } from './workspace';
import { TeamPage } from './team';
import { ApiKeysPage } from './keys';
import { AuditLogPage } from './audit';
import { EventsPage } from './events';
import { JobsPage } from './jobs';
import { TaxPage } from './tax';
import { FeaturesPage } from './features';
import { TimeMachinePage } from './clock';
import type { JobRow } from './types';



/* ================================= widget ================================= */

/**
 * The two facts about the platform that change what an operator should believe
 * about every other number on the dashboard: whether the clock is where they
 * think it is, and whether any deferred work has broken.
 */
function PlatformWidget() {
  const f = useFormat();
  const session = useSession();
  const navigate = useNavigate();
  const pending = useQuery<ListEnvelope<JobRow>>('/v1/jobs', { status: 'pending', limit: 200 });
  const failed = useQuery<ListEnvelope<JobRow>>('/v1/jobs', { status: 'failed', limit: 200 });

  const offset = session.me?.clock.offset_ms ?? 0;
  const shifted = Math.abs(offset) > 60_000;
  const now = session.now();
  const waiting = pending.data?.total_count ?? pending.data?.data.length ?? 0;
  const broken = failed.data?.data.length ?? 0;
  const upcoming = (pending.data?.data ?? []).map((job) => job.run_at).filter((at) => at > now);
  const next = upcoming.length ? Math.min(...upcoming) : null;

  return (
    <Card
      title="The platform"
      description="The clock, and the work waiting on it"
      actions={<Button size="sm" variant="ghost" onClick={() => navigate('/settings/jobs')}>Open</Button>}
    >
      {pending.error && (
        <EmptyState
          size="sm"
          inline
          illustration={null}
          title="The queue could not be read"
          body={pending.error.body.message}
          action={<Button size="sm" variant="secondary" onClick={pending.refetch}>Try again</Button>}
        />
      )}
      {!pending.error && (
        <Stack gap={5}>
          <Stat
            label="Workspace time"
            value={f.dateTime(now)}
            caption={shifted ? describeOffset(offset) : 'In step with real time'}
          />
          <Inline gap={5} wrap>
            <Stat
              size="sm"
              label="Jobs waiting"
              value={f.number(waiting)}
              caption={next !== null ? `Next ${f.when(next)}` : 'Nothing ahead'}
            />
            <Stat
              size="sm"
              label="Failed"
              value={f.number(broken)}
              caption={broken ? 'Out of attempts' : 'None'}
            />
          </Inline>
          {shifted && (
            <Inline gap={3}>
              <Badge tone="warning" pill dot>Simulated clock</Badge>
              <Button size="sm" variant="ghost" iconLeft={<Icons.clock size={13} />} onClick={() => navigate('/settings/time')}>
                Time machine
              </Button>
            </Inline>
          )}
        </Stack>
      )}
    </Card>
  );
}

/* ============================== registration ============================== */

/**
 * Written out rather than derived from `SETTINGS_NAV`, even though the two must
 * agree: `tests/kernel.test.ts` reads every module's routes by scanning the
 * source for literal `path:` strings, so a registry built by `.map()` registers
 * nine screens the shell can reach and none the test can see — and the check
 * that every nav destination resolves would pass by knowing nothing. The
 * assertion below keeps the two lists honest at boot instead.
 */
export const routes: RouteDef[] = [
  { path: '/settings', element: WorkspacePage, title: 'Workspace' },
  { path: '/settings/team', element: TeamPage, title: 'Team' },
  { path: '/settings/api-keys', element: ApiKeysPage, title: 'API keys' },
  { path: '/settings/events', element: EventsPage, title: 'Events' },
  { path: '/settings/jobs', element: JobsPage, title: 'Jobs' },
  { path: '/settings/audit', element: AuditLogPage, title: 'Audit log' },
  { path: '/settings/time', element: TimeMachinePage, title: 'Time machine' },
  { path: '/settings/tax', element: TaxPage, title: 'Tax' },
  { path: '/settings/features', element: FeaturesPage, title: 'Features' },
];

export const nav: NavItem[] = [
  {
    id: 'settings',
    label: 'Settings',
    to: '/settings',
    group: 'settings',
    order: 10,
    icon: 'settings',
  },
];

/**
 * What the palette gets from this module — and, as importantly, what it does
 * not.
 *
 * The shell already registers one "Go to" entry per settings page off the
 * `settings` registry below, so a second set derived from the same list put the
 * same destination in the palette two and three times over: "Go to API keys",
 * "Settings · API keys" and a Create entry that only navigated. What is left
 * here is the work the rail cannot express — the things that open a dialog or
 * land on a tab — and each one arrives ready to be used rather than beside the
 * control that does it.
 */
export const commands: CommandDef[] = [
  {
    id: 'settings.key.new',
    title: 'Create an API key',
    subtitle: 'Opens the dialog — the secret is shown exactly once',
    group: 'Create',
    keywords: ['api key', 'token', 'credential', 'bearer', 'secret'],
    icon: 'key',
    run: (navigate) => navigate('/settings/api-keys?new=1'),
  },
  {
    id: 'settings.invite',
    title: 'Invite a teammate',
    subtitle: 'Opens the dialog — seat someone at a role you choose',
    group: 'Create',
    keywords: ['invite', 'teammate', 'user', 'seat', 'role'],
    icon: 'users',
    run: (navigate) => navigate('/settings/team?invite=1'),
  },
  {
    id: 'settings.clock',
    title: 'Move the workspace clock',
    subtitle: 'Replay renewals, dunning and credit expiry on demand',
    group: 'Run',
    keywords: ['time machine', 'clock', 'advance', 'simulate', 'test clock'],
    icon: 'clock',
    run: (navigate) => navigate('/settings/time'),
  },
  {
    id: 'settings.jobs.failed',
    title: 'Jobs that failed',
    subtitle: 'Deferred work that ran out of attempts, on its own tab',
    group: 'Run',
    keywords: ['jobs', 'queue', 'failed', 'drain', 'error'],
    icon: 'layers',
    run: (navigate) => navigate('/settings/jobs?status=failed'),
  },
];

export const widgets: WidgetDef[] = [
  {
    id: 'settings.platform',
    title: 'The platform',
    description: 'The workspace clock and the work waiting on it',
    span: 4,
    component: PlatformWidget,
    group: 'workspace',
  },
];

/**
 * The rail, the palette and the settings registry all read the same list, and
 * the element for each page comes off the route table above — so a screen that
 * is listed but not routed is a build error here rather than a blank page in
 * the product.
 */
export const settings: SettingsPage[] = SETTINGS_NAV.map((item, index) => {
  const route = routes.find((candidate) => candidate.path === item.to);
  if (!route) throw new Error(`settings: "${item.id}" is listed at ${item.to} but no route registers it`);
  return {
    id: item.id,
    label: item.label,
    group: item.group,
    order: (index + 1) * 10,
    path: item.to,
    element: route.element,
    description: item.description,
  };
});
