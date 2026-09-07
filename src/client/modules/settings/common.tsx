/**
 * What every settings screen shares.
 *
 * The surface is a single frame — a page header and a sub-navigation that never
 * moves — wrapped around nine screens that each own one part of the platform's
 * plumbing. The pieces below are the ones all of them need: the frame itself,
 * the mutation helper that turns one API call into a toast plus an inline
 * refusal pinned to the field the server named, the failure and empty states,
 * and the two vocabularies this surface has to speak honestly about — what a
 * role actually grants, and what an API key's scopes actually reach.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { invalidate, type ApiClientError } from '../../kernel/api';
import { Link, useLocation, useSearchParam } from '../../kernel/router';
import { useSession } from '../../kernel/session';
import {
  Badge, Banner, Button, EmptyState, Icons, Loading, Page, SectionError,
  useCopyToClipboard, useToast,
  type Tone,
} from '../../design';
import type { Role } from './types';
import { targetLabel, targetRoute } from './targets';
import { actorLabel } from './audit-core';
import './settings.css';

/* ============================== the sub-nav =============================== */

export interface SettingsNavItem {
  id: string;
  label: string;
  to: string;
  description: string;
  icon: keyof typeof Icons;
  group: 'Workspace' | 'Platform' | 'Billing';
  /**
   * The server answers 403 to this screen's *read* below admin, so there is
   * nothing to render for anyone else. Only two screens are like this, and the
   * rail locks exactly those two — a lock on a screen the API would have served
   * is how the team roster went missing for every analyst in the workspace.
   */
  readNeedsAdmin?: boolean;
  /** The reads are served to everyone; the writes behind it are gated at admin. */
  writeNeedsAdmin?: boolean;
}

/**
 * The order the screens are listed in, and the only place a settings address is
 * written down. `routes`, the nav registry, the command palette and the frame's
 * own rail are all derived from this list, so a page cannot exist without being
 * reachable and cannot be reachable without existing.
 */
export const SETTINGS_NAV: SettingsNavItem[] = [
  {
    id: 'workspace', label: 'Workspace', to: '/settings', group: 'Workspace', icon: 'building',
    description: 'Name, domain, brand colour, currency, timezone and locale',
  },
  {
    id: 'team', label: 'Team', to: '/settings/team', group: 'Workspace', icon: 'users',
    description: 'Who is in this workspace and what their role lets them do', writeNeedsAdmin: true,
  },
  {
    id: 'api-keys', label: 'API keys', to: '/settings/api-keys', group: 'Workspace', icon: 'key',
    description: 'Credentials for the API, and what each of them reaches',
    readNeedsAdmin: true, writeNeedsAdmin: true,
  },
  {
    id: 'events', label: 'Events', to: '/settings/events', group: 'Platform', icon: 'zap',
    description: 'The one stream webhooks, workflows, timelines and the audit trail read',
  },
  {
    id: 'jobs', label: 'Jobs', to: '/settings/jobs', group: 'Platform', icon: 'layers',
    description: 'The durable queue — nothing in this platform sleeps on a timer',
  },
  {
    id: 'audit', label: 'Audit log', to: '/settings/audit', group: 'Platform', icon: 'shield',
    description: 'Who changed what, with the before and after and the request id', readNeedsAdmin: true,
  },
  {
    id: 'time', label: 'Time machine', to: '/settings/time', group: 'Platform', icon: 'clock',
    description: 'Move the workspace clock and watch a year of billing run', writeNeedsAdmin: true,
  },
  {
    id: 'tax', label: 'Tax', to: '/settings/tax', group: 'Billing', icon: 'percent',
    description: 'Where this workspace collects, and the registrations customers gave it',
  },
  {
    id: 'features', label: 'Features', to: '/settings/features', group: 'Billing', icon: 'sliders',
    description: 'The feature catalogue, and what each account is entitled to and why',
  },
];

const NAV_GROUPS: SettingsNavItem['group'][] = ['Workspace', 'Platform', 'Billing'];

function SettingsRail() {
  const { path } = useLocation();
  const { me } = useSession();
  // The rail still links to every screen — a locked one explains itself far
  // better than a missing one — but the padlock means one thing only: the
  // server refuses the read, so there is nothing behind it. A screen whose
  // *writes* are gated is not locked; it opens, shows what it holds, and says
  // which controls are closed.
  const admin = me?.role === 'owner' || me?.role === 'admin';
  return (
    <nav className="st-rail" aria-label="Settings sections">
      {NAV_GROUPS.map((group) => (
        <div key={group} className="st-rail__group">
          <div className="st-rail__grouplabel">{group}</div>
          {SETTINGS_NAV.filter((item) => item.group === group).map((item) => {
            const Icon = Icons[item.icon];
            // `/settings` is the workspace screen, so a prefix match would light
            // it up on every one of its siblings.
            const active = item.to === '/settings' ? path === '/settings' : path === item.to || path.startsWith(`${item.to}/`);
            const locked = !!item.readNeedsAdmin && !admin;
            // Not locked, but not fully yours either: the screen opens and
            // shows everything, and the controls that change it are gone.
            const readOnly = !locked && !!item.writeNeedsAdmin && !admin;
            return (
              <Link
                key={item.id}
                to={item.to}
                className={`st-rail__item${active ? ' is-active' : ''}${locked ? ' is-locked' : ''}`}
                aria-current={active ? 'page' : undefined}
                title={locked
                  ? `Reading ${item.label} needs the admin role`
                  : readOnly ? `${item.label} opens for every role; changing it needs the admin role` : undefined}
              >
                <Icon size={15} />
                <span className="u-truncate">{item.label}</span>
                {locked && <Icons.lock size={12} aria-hidden />}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export interface SettingsShellProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

/** The frame: one page header, the rail on the left, the screen on the right. */
export function SettingsShell({ title, subtitle, actions, children }: SettingsShellProps) {
  return (
    <Page title={title} eyebrow="Settings" subtitle={subtitle} actions={actions} width="wide">
      <div className="st-frame">
        <SettingsRail />
        <div className="st-body">{children}</div>
      </div>
    </Page>
  );
}

/**
 * A dialog body that Enter submits.
 *
 * The contract says Enter submits; the dialogs here put their primary button in
 * the Modal's footer, outside anything a browser would treat as a form, so
 * Enter in the second field of the invitation did nothing and the operator had
 * to Tab to the button. This wraps the fields in a real `<form>` and submits it
 * from any single-line input — not from a textarea (Enter is a newline there),
 * not from a tag input (Enter adds the tag), not from a native select or a
 * button (each has its own Enter). The caller decides whether the form is
 * valid; an invalid form does nothing on Enter, the way the disabled button
 * does nothing on click.
 */
export function DialogForm({ onSubmit, children, className }: {
  onSubmit: () => void;
  children: ReactNode;
  className?: string;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); onSubmit(); };
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement | null;
    if (!target || target.tagName !== 'INPUT') return;
    const input = target as HTMLInputElement;
    if (input.type === 'button' || input.type === 'submit' || input.type === 'reset') return;
    if (input.closest('.ain-taginput') || input.getAttribute('role') === 'combobox') return;
    event.preventDefault();
    onSubmit();
  };
  return <form className={className} noValidate onSubmit={submit} onKeyDown={onKeyDown}>{children}</form>;
}

/* ================================= roles ================================== */

/**
 * What a role actually grants, read off the server rather than guessed at.
 *
 * `ROLE_RANK` in `src/server/kernel/http.ts` is the one ladder every check in
 * the platform reads, and every mutating route declares `roles: ['member']` or
 * `roles: ['admin']`. So there are exactly three rungs that mean anything —
 * admin and above, member and above, and below member — and a role picker that
 * implies five distinct sets of powers is lying. These sentences say what each
 * one can and cannot do, in the words of the routes that enforce it.
 */
export const ROLE_ORDER: Role[] = ['owner', 'admin', 'member', 'analyst', 'readonly'];

export const ROLE_RANK: Record<Role, number> = { owner: 90, admin: 80, member: 60, analyst: 40, readonly: 20 };

export const ROLE_GRANTS: Record<Role, { summary: string; detail: string; tone: Tone }> = {
  owner: {
    summary: 'Everything, and cannot be outranked',
    detail:
      'Every route in the platform, including the ones only an admin may call: workspace settings, team and roles, '
      + 'API keys, the audit log and the time machine. Only an owner may seat another owner.',
    tone: 'brand',
  },
  admin: {
    summary: 'Everything except seating an owner',
    detail:
      'Workspace settings, the team, API keys, the audit log, the tax register, the feature catalogue and the time '
      + 'machine — plus everything a member can do. An admin cannot grant the owner role, and cannot take a role away '
      + 'from someone above them.',
    tone: 'info',
  },
  member: {
    summary: 'Can change customer and revenue data, not the workspace',
    detail:
      'Creates and edits records, customers, subscriptions, invoices, credits and entitlement overrides — every '
      + 'mutating route in the product is gated here. Cannot read the audit log, mint or revoke API keys, change '
      + 'workspace settings, edit the team or move the clock.',
    tone: 'success',
  },
  analyst: {
    summary: 'Read-only, everywhere',
    detail:
      'Sees every screen and every report, and can change nothing: every write in the platform is gated at member or '
      + 'above, so an analyst is a reader with no exceptions.',
    tone: 'neutral',
  },
  readonly: {
    summary: 'Read-only, everywhere',
    detail:
      'Identical reach to analyst — the platform enforces no write anywhere below member. The two rungs differ only '
      + 'in what you call the person holding them.',
    tone: 'neutral',
  },
};

export function RoleBadge({ role }: { role: Role }) {
  return <Badge tone={ROLE_GRANTS[role]?.tone ?? 'neutral'} pill>{role}</Badge>;
}

/**
 * What a key's scopes actually reach, from `keyRole` in `src/server/app.ts`.
 *
 * No route in the platform declares `meta.scopes`, so a scope string is not
 * enforced per domain — it is read as a ladder: `*` authenticates as admin,
 * anything naming a write authenticates as member everywhere, and everything
 * else is read-only. Showing `crm:write` as though it confined a key to CRM
 * would be the most dangerous sentence on this surface.
 */
const WRITE_SCOPE = /(^|:)(write|admin|\*)$/;

export function scopeReach(scopes: readonly string[]): { role: Role; summary: string; tone: Tone } {
  if (scopes.includes('*')) {
    return {
      role: 'admin',
      tone: 'warning',
      summary: 'Full access — this key can do anything an admin can, including minting and revoking other keys.',
    };
  }
  if (scopes.some((scope) => WRITE_SCOPE.test(scope.trim().toLowerCase()))) {
    return {
      role: 'member',
      tone: 'info',
      summary:
        'Read and write. No route enforces scopes by domain yet, so a key naming any write reaches every write in the '
        + 'platform — but never the admin-only routes: settings, keys, the audit log and the clock stay closed to it.',
    };
  }
  return {
    role: 'readonly',
    tone: 'neutral',
    summary: 'Read-only. Every mutating route in the platform refuses this key.',
  };
}

/* =============================== mutations =============================== */

export interface ActionOutcome {
  tone: 'success' | 'info';
  title: string;
  description?: string;
}

export interface ActionCopy<T = unknown> {
  success: string;
  description?: string;
  failure: string;
  /** Skip the failure toast when a form is already showing it against a field. */
  inlineOnly?: boolean;
  /**
   * Say what happened from the answer rather than from the request.
   *
   * A patch is an intention; the response is the record. `PATCH /v1/org` drops
   * an empty optional and answers 200 with the row untouched, so a toast built
   * from the patch reports a change the workspace never made. When this is
   * given, the response decides both the words and the tone.
   */
  outcome?: (result: T) => ActionOutcome;
}

export interface ActionState {
  run: <T>(work: Promise<T>, copy: ActionCopy<T>, invalidates?: string[]) => Promise<T | null>;
  error: ApiClientError | null;
  clear: () => void;
  busy: boolean;
  /** The message the server pinned to this field, when it named one. */
  errorFor: (param: string) => string | undefined;
}

/** One call, one toast, one invalidation — and the refusal kept for the form. */
export function useAction(): ActionState {
  const toast = useToast();
  const [error, setError] = useState<ApiClientError | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async <T,>(
    work: Promise<T>,
    copy: ActionCopy<T>,
    invalidates: string[] = [],
  ): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      const result = await work;
      if (invalidates.length) invalidate(...invalidates);
      const outcome = copy.outcome?.(result);
      if (!outcome) toast.success(copy.success, copy.description);
      else if (outcome.tone === 'info') toast.info(outcome.title, outcome.description);
      else toast.success(outcome.title, outcome.description);
      return result;
    } catch (e) {
      const err = e as ApiClientError;
      setError(err);
      if (!copy.inlineOnly) {
        toast.error(copy.failure, err?.body?.message ?? 'The server refused the request.', { duration: 0 });
      }
      return null;
    } finally {
      setBusy(false);
    }
  }, [toast]);

  return useMemo(() => ({
    run,
    error,
    busy,
    clear: () => setError(null),
    errorFor: (param: string) => (error?.body?.param === param ? error.body.message : undefined),
  }), [run, error, busy]);
}

/**
 * A one-shot instruction in the address bar, obeyed once and then wiped.
 *
 * The palette's "Create an API key" used to navigate to the list and stop
 * there, which made the most specific-looking result the least useful one. It
 * now lands with `?new=1`, the screen opens its own dialog, and the parameter
 * is dropped so a reload or a back button does not open it again.
 */
export function useOpenFromQuery(key: string, open: () => void): void {
  const [flag, setFlag] = useSearchParam(key);
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    if (!flag) return;
    setFlag(undefined);
    latest.current();
  }, [flag, setFlag]);
}

/**
 * The same one-shot instruction, carrying a value: `?member=usr_…` on the team
 * screen, `?key=ak_…` on API keys, `?rate=txr_…` on tax. The audit trail and the
 * event stream write these addresses for every id they show, so the screen
 * that owns the object has to answer with *that* object on top — and then drop
 * the parameter, so the address bar goes back to naming the screen.
 */
export function useConsumeQuery(key: string, consume: (value: string) => void): void {
  const [value, setValue] = useSearchParam(key);
  const latest = useRef(consume);
  latest.current = consume;
  useEffect(() => {
    if (!value) return;
    setValue(undefined);
    latest.current(value);
  }, [value, setValue]);
}

export const idem = (): string => (
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `idem_${Date.now()}_${Math.random()}`
);

/* ============================ states and shells ========================== */

/**
 * A list's failure, rendered above the grid rather than inside it. `DataTable`
 * puts its error in a `<td colSpan>` inside a horizontally scrolling body, so a
 * sentence longer than the summed column widths is only reachable by scrolling
 * sideways.
 */
export function ListFailure({ error, path, onRetry }: { error: ApiClientError; path: string; onRetry: () => void }) {
  return <div className="st-listfail"><SectionError error={error} path={path} onRetry={onRetry} /></div>;
}

export { Loading };

/**
 * The screen an operator without the role sees — and only where the *read* is
 * genuinely refused.
 *
 * The route named here has to be the one that would have filled the screen, not
 * a write that happens to live on it. Withholding a list the API serves, behind
 * a sentence saying the server would refuse it, is worse than no screen at all:
 * it teaches the operator something false about their own workspace. So this
 * takes the read route, and every caller passes one that really answers 403.
 */
export function NeedsAdmin({ what, route }: { what: string; route: string }) {
  const { me } = useSession();
  return (
    <EmptyState
      illustration={<Icons.lock size={26} />}
      title={`${what} needs the admin role`}
      body={
        `Your role on this workspace is ${me?.role ?? 'unknown'}, and ${route} is gated at admin — the server answers `
        + '403 to that read, so nothing is shown rather than an empty table that looks like nothing exists. Ask an '
        + 'owner or admin to make the change, or to raise your role on the Team screen.'
      }
    />
  );
}

/**
 * The other half of the same honesty: the read came back, the writes are gated.
 * Everything is on screen and none of the controls that would change it are.
 */
export function ReadOnlyForYou({ what, reads, writes }: {
  what: string;
  /** The read that fills the screen, which carries no role gate. */
  reads: string;
  /** The writes that do, as a clause: "Inviting … and removing a seat are gated at admin". */
  writes: string;
}) {
  const { me } = useSession();
  return (
    <Banner tone="info" compact title={`You can read ${what}, not change it`}>
      {`${reads} carries no role gate, so this is the whole picture. ${writes} — and your role on this workspace is `
        + `${me?.role ?? 'unknown'}, so those controls are not offered rather than offered and refused.`}
    </Banner>
  );
}

/* ================================ payloads =============================== */

/**
 * A JSON payload, exactly as the API sent it, with a copy control.
 *
 * Events and jobs are the substrate everything else is built on; summarising
 * their payload into a few chosen fields is how an integrator ends up guessing
 * at the shape they are supposed to consume. So it is printed whole.
 */
export function JsonBlock({ value, label, maxHeight = 340 }: { value: unknown; label: string; maxHeight?: number }) {
  const text = useMemo(() => {
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }, [value]);
  const [copied, copy] = useCopyToClipboard();
  return (
    <div className="st-json">
      <div className="st-json__bar">
        <span className="st-json__label">{label}</span>
        <Button
          size="sm"
          variant="ghost"
          iconLeft={copied ? <Icons.check size={13} /> : <Icons.copy size={13} />}
          onClick={() => void copy(text)}
        >
          {copied ? 'Copied' : 'Copy JSON'}
        </Button>
      </div>
      <pre className="st-json__code" style={{ maxHeight }} tabIndex={0}>{text}</pre>
    </div>
  );
}

/**
 * Actor ids are opaque (`usr_seed01`, `null` for the system). Every screen that
 * shows one resolves it against the teammates the session already carries, so
 * the audit trail and the event stream name people rather than row ids — and
 * an entry with no actor says so rather than crediting "the platform" with a
 * change the record cannot attribute (see `actorLabel`).
 */
export function useActorName(): (id: string | null, kind?: string) => string {
  const { me } = useSession();
  const byId = useMemo(() => {
    const map = new Map<string, string>();
    for (const mate of me?.teammates ?? []) map.set(mate.id, mate.name);
    return map;
  }, [me?.teammates]);
  return useCallback((id: string | null, kind?: string) => actorLabel(id, kind, (key) => byId.get(key)), [byId]);
}

/**
 * The screen an object id opens, and what to call it there.
 *
 * Teammates and the workspace are named off the session. Anything else is
 * named by the caller when it holds a list that knows (the audit screen reads
 * the API keys it is allowed to), and shown by id otherwise — the id still
 * opens the record, which is what matters.
 */
export function useTargetLink(names?: ReadonlyMap<string, string>): (type: string | null, id: string | null) => {
  to: string | null;
  label: string;
  name: string | null;
} {
  const { me } = useSession();
  const teammates = useMemo(() => new Map((me?.teammates ?? []).map((mate) => [mate.id, mate.name])), [me?.teammates]);
  const orgId = me?.org.id ?? null;
  const orgName = me?.org.name ?? null;
  return useCallback((type, id) => ({
    to: targetRoute(type, id),
    label: targetLabel(type),
    name: id === null
      ? null
      : (type === 'user' ? teammates.get(id) : null)
        ?? ((type === 'org' || type === 'organization') && id === orgId ? orgName : null)
        ?? names?.get(id)
        ?? null,
  }), [teammates, orgId, orgName, names]);
}

/**
 * An object on the trail or the stream: its type, its name when one is known,
 * and its id — as a link to the record whenever the platform has a screen for
 * it. `compact` puts the id under the label for a table cell; the default
 * reads inline for a drawer. `notes` says what else the caller knows about an
 * id — "removed", for a teammate no roster will find — beside the label.
 */
export function TargetLink({ type, id, names, notes, compact }: {
  type: string | null;
  id: string | null;
  names?: ReadonlyMap<string, string>;
  notes?: ReadonlyMap<string, string>;
  compact?: boolean;
}) {
  const resolve = useTargetLink(names);
  if (!id) return <span className="st-sub">The workspace itself</span>;
  const target = resolve(type, id);
  const note = notes?.get(id) ?? null;
  const label = note ? `${target.label} · ${note}` : target.label;
  const headline = target.name ?? id;
  const inner = target.to
    ? <Link to={target.to} className={`st-link${target.name ? '' : ' st-mono'}`} title={`Open ${target.label.toLowerCase()} ${id}`}>{headline}</Link>
    : <span className={target.name ? undefined : 'st-mono'}>{headline}</span>;
  if (compact) {
    return (
      <span className="st-target">
        <span className="u-truncate">{inner}</span>
        <span className="st-sub u-truncate" title={target.name ? id : undefined}>
          {label}{target.name ? <> · <span className="st-target__id">{id}</span></> : null}
        </span>
      </span>
    );
  }
  return (
    <span>
      {label}
      {' · '}
      {inner}
      {target.name ? <> <span className="st-target__id">{id}</span></> : null}
    </span>
  );
}

/* ================================= exports ================================ */

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

/** RFC 4180: quote anything holding a comma, a quote or a newline. */
const csvCell = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const lines = [columns.map((column) => csvCell(column.header)).join(',')];
  for (const row of rows) lines.push(columns.map((column) => csvCell(column.value(row))).join(','));
  // The same file shape every other export in the product hands over: a BOM so
  // Excel reads the € and £ signs, and CRLF so it reads the rows on Windows.
  return `﻿${lines.join('\r\n')}\r\n`;
}

export const fileStamp = (at: number, timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
};

/**
 * Hand the operator a file. The object URL is revoked on the next frame rather
 * than synchronously — revoking it in the same tick races the download and
 * lands an empty file in WebKit.
 */
export function downloadFile(filename: string, contents: string, mime = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([contents], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
