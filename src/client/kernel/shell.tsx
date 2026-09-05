/**
 * The application shell.
 *
 * Everything outside a routed screen lives here: the sidebar built from the NAV
 * registry, the top bar with breadcrumbs, search, the create menu and the time
 * machine, the command palette, the keyboard model, and the boundary that keeps
 * one broken page from taking the product down with it.
 */
import {
  Suspense, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo,
  useRef, useState, type ReactNode,
} from 'react';
import {
  AlertTriangleIcon, Avatar, Badge, Banner, Button, Card, ChevronRightIcon, ChevronsLeftIcon, ChevronsRightIcon, Divider,
  ErrorBoundary, ErrorState, Icons, IconButton, Kbd,
  Menu, Modal, Popover, Portal, SegmentedControl, Skeleton, SkeletonText, Spinner, Toaster, Tooltip,
  computePosition, formatNumber, rectOf, useFormat, useHotkey, useIsNarrow, useLocalStorage, useMediaQuery, useToast, viewportSize,
  type MenuSection,
} from '../design';
import { Link, matchRoute, useRouter } from './router';
import { useSession, type Density, type Theme } from './session';
import { invalidate, lastRequestId, useQuery, useRateLimit, type ApiClientError, type RateLimited } from './api';
import { COMMANDS, NAV, ROUTES, SETTINGS_PAGES } from '../generated/registry';
import type { NavItem, RouteDef } from './registry-types';
import {
  TIME_JUMPS, activeNavItem, avatarSrc, clockOutcome, crumbsFor, eventSubject, eventTitle, fillParams,
  firstRegistered, groupNav, isPathActive, jumpBindings, navLabelIndex, railState, recordRouteCandidates,
  shortcutSheet, withCurrentLabel,
} from './shell-core';
import { usePlatform, useCreateActions, useGlobalSearch, useSearchSources, useTimeMachine } from './platform';
import { typeaheadTargets, type SearchSource, type TypeaheadTarget } from './search-core';
import { CommandPalette, type PaletteEntry } from './palette';
import { TimeMachine, aftermathOf } from './time-machine';
import { LoginPage } from './login';
import { renderIcon } from './icon';
import './shell.css';

/**
 * The handful of shell affordances a routed screen legitimately needs to reach:
 * a dashboard tile that opens the palette, a walkthrough that opens the time
 * machine. Outside the shell — the style guide, a test — the no-ops apply.
 */
export interface ShellApi {
  openPalette: () => void;
  openSearch: (query?: string) => void;
  openTimeMachine: () => void;
  openShortcuts: () => void;
  /** Drop the client cache so every panel re-reads from the API. */
  refresh: () => void;
  /**
   * Name the current crumb and the tab after the record on screen. A route only
   * knows its object type; the screen knows who it is once the record answers.
   * `null` hands the crumb back to the route's title.
   */
  setCurrent: (label: string | null) => void;
}

const NOOP_SHELL: ShellApi = {
  openPalette: () => {}, openSearch: () => {}, openTimeMachine: () => {},
  openShortcuts: () => {}, refresh: () => {}, setCurrent: () => {},
};

const ShellContext = createContext<ShellApi>(NOOP_SHELL);
export const useShell = (): ShellApi => useContext(ShellContext);

/**
 * The one way a record screen names itself in the shell.
 *
 * Every detail page used to solve this on its own — one patched the crumb's
 * text node through `document.querySelector`, one drew a second breadcrumb
 * inside the page, two wrote "Invoices / Name" with a slash — and a person
 * moving between a deal, a company and an invoice met three different trails.
 * Pass the record's name once it is known; the shell does the rest.
 */
export function useCurrentCrumb(label: string | null | undefined): void {
  const { setCurrent } = useShell();
  useEffect(() => {
    setCurrent(label ?? null);
    return () => setCurrent(null);
  }, [label, setCurrent]);
}

const isTypingTarget = (el: EventTarget | null): boolean => {
  const node = el as HTMLElement | null;
  if (!node?.tagName) return false;
  const tag = node.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || node.isContentEditable;
};

/* ================================= shell ================================== */

export function AppShell() {
  const { route, params, location, navigate } = useRouter();
  const session = useSession();
  const layout = route?.layout ?? 'app';

  const needsAuth = layout !== 'bare';
  // A workspace that cannot be read is not a workspace you are signed out of.
  // Sending an operator to a password form during an outage is the same class
  // of lie as rendering the outage as an empty dashboard.
  const unreachable = needsAuth ? session.unreachable : null;
  const locked = needsAuth && !unreachable && !session.loading && !session.signedIn;

  useEffect(() => {
    if (!locked) return;
    const next = location.path + location.search;
    navigate(`/login?next=${encodeURIComponent(next)}`, { replace: true });
  }, [locked, location.path, location.search, navigate]);

  if (session.loading && !session.me) {
    return (
      <div className="shell-boot">
        <div className="shell-boot__inner">
          <div className="shell-boot__spinner" aria-hidden />
          <span className="shell-boot__label">Opening your workspace…</span>
        </div>
      </div>
    );
  }

  if (layout === 'bare') {
    const Bare = route?.element ?? LoginPage;
    return <><Bare {...params} /><Toaster /></>;
  }

  if (unreachable) {
    return <><Unreachable error={unreachable} onRetry={() => { invalidate(); session.refresh(); }} /><Toaster /></>;
  }

  if (locked) {
    // The redirect above is already in flight; showing sign-in avoids a flash of
    // the shell with nothing in it.
    return <><LoginPage /><Toaster /></>;
  }

  return <SignedInShell />;
}

function SignedInShell() {
  const { route, params, location, navigate } = useRouter();
  const session = useSession();
  const toast = useToast();
  const f = useFormat();

  const [railPref, setRailPref] = useLocalStorage('ain.nav.rail', false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [clockOpen, setClockOpen] = useState(false);
  const [chord, setChord] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  // One boolean drives the width, the labels, the flyouts and every collapsed
  // `aria-label`: a sidebar 56px wide while the app believes it is showing
  // labels is a strip of anonymous glyphs. The drawer is how the labels come
  // back on a narrow window, without a wider one.
  const narrow = useIsNarrow();
  const rail = railState(railPref, narrow, drawer);
  // Under 680px the top bar squeezes the search field to a four-pixel sliver
  // that is still in the tab order. A control you cannot aim at is worse than
  // one button that opens the search screen.
  const compact = useMediaQuery('(max-width: 680px)');

  const toggleRail = useCallback(() => {
    if (narrow) setDrawer((open) => !open);
    else setRailPref(!railPref);
  }, [narrow, railPref, setRailPref]);

  const platform = usePlatform(true);
  const sources = useSearchSources(platform);
  const createActions = useCreateActions(platform, sources);
  const { advance } = useTimeMachine(() => { invalidate(); session.refresh(); });

  const sections = useMemo(() => groupNav(NAV), []);
  const flatNav = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const jumps = useMemo(() => jumpBindings(flatNav), [flatNav]);
  const jumpKeyFor = useMemo(() => new Map(jumps.map((jump) => [jump.item.id, jump.key])), [jumps]);

  const refreshAll = useCallback(() => { invalidate(); session.refresh(); }, [session]);

  /* -------------------------------- keyboard ------------------------------ */

  useHotkey('mod+k', () => setPaletteOpen(true), { allowInInput: true });
  useHotkey(['shift+?', '?'], () => setShortcutsOpen(true));
  useHotkey('/', () => (searchRef.current ? searchRef.current.focus() : navigate('/search')));
  useHotkey('mod+\\', toggleRail, { allowInInput: true });
  useHotkey('mod+shift+t', () => setClockOpen(true), { allowInInput: true });
  useHotkey('mod+shift+l', () => session.setTheme(session.resolvedTheme === 'dark' ? 'light' : 'dark'), { allowInInput: true });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (chord) {
        const match = jumps.find((jump) => jump.key === e.key.toLowerCase());
        setChord(false);
        if (match) { e.preventDefault(); navigate(match.item.to); }
        return;
      }
      if (e.key.toLowerCase() === 'g') { e.preventDefault(); setChord(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chord, jumps, navigate]);

  useEffect(() => {
    if (!chord) return;
    const id = setTimeout(() => setChord(false), 1600);
    return () => clearTimeout(id);
  }, [chord]);

  /* -------------------------------- palette ------------------------------- */

  const paletteEntries = useMemo<PaletteEntry[]>(() => {
    const settingsRoutes = new Set(ROUTES.map((r) => r.path));
    const entries: PaletteEntry[] = [];

    for (const item of flatNav) {
      entries.push({
        id: `nav.${item.id}`,
        title: item.label,
        subtitle: item.to,
        keywords: [item.group, item.id],
        group: 'Go to',
        verb: 'Go to',
        icon: item.icon,
        shortcut: jumpKeyFor.has(item.id) ? `g ${jumpKeyFor.get(item.id)}` : undefined,
        run: () => navigate(item.to),
      });
      for (const child of item.children ?? []) {
        entries.push({
          id: `nav.${item.id}.${child.id}`,
          title: `${item.label} · ${child.label}`,
          subtitle: child.to,
          group: 'Go to',
          verb: 'Go to',
          icon: item.icon,
          run: () => navigate(child.to),
        });
      }
    }
    for (const page of SETTINGS_PAGES) {
      if (!settingsRoutes.has(page.path)) continue;
      entries.push({
        id: `settings.${page.id}`,
        title: page.label,
        subtitle: page.description ?? page.group,
        keywords: ['settings', page.group],
        group: 'Go to',
        verb: 'Go to',
        icon: 'settings',
        run: () => navigate(page.path),
      });
    }
    entries.push({
      id: 'nav.search',
      title: 'Search everything',
      subtitle: '/search',
      group: 'Go to',
      verb: 'Go to',
      icon: 'search',
      shortcut: '/',
      run: () => navigate('/search'),
    });

    for (const action of createActions) {
      entries.push({
        id: action.id,
        title: action.label,
        group: 'Create',
        verb: 'Create',
        icon: action.icon,
        run: () => navigate(action.to),
      });
    }

    for (const command of COMMANDS) {
      entries.push({
        id: `cmd.${command.id}`,
        title: command.title,
        subtitle: command.subtitle,
        keywords: command.keywords,
        group: command.group || 'Run',
        icon: command.icon as PaletteEntry['icon'],
        shortcut: command.shortcut,
        run: () => { void command.run(navigate); },
      });
    }

    const canAdvance = session.me?.clock.kind === 'virtual' && ['owner', 'admin'].includes(session.me?.role ?? '');
    if (canAdvance) {
      for (const preset of TIME_JUMPS) {
        entries.push({
          id: `time.${preset.id}`,
          title: `Advance the clock by ${preset.label.toLowerCase()}`,
          subtitle: preset.description,
          keywords: ['time machine', 'simulate', 'clock', 'renewal'],
          group: 'Run',
          verb: 'Run',
          icon: 'clock',
          run: () => {
            const to = preset.at(session.now());
            advance({ to })
              .then((move) => {
                const outcome = clockOutcome({
                  movedTo: f.date(move.now),
                  label: `Jumped forward ${preset.label.toLowerCase()}`,
                  jobsRun: move.jobsRun,
                  jobsFailed: move.jobsFailed,
                  aftermath: aftermathOf(move),
                });
                const raise = outcome.tone === 'success' ? toast.success : toast.error;
                raise(outcome.title, outcome.description, outcome.pinned ? { duration: 0 } : undefined);
              })
              .catch((error: Error) => toast.error('The clock did not move', error.message, { duration: 0 }));
          },
        });
      }
    }
    entries.push({
      id: 'run.theme',
      title: `Switch to the ${session.resolvedTheme === 'dark' ? 'light' : 'dark'} theme`,
      keywords: ['appearance', 'dark mode', 'light mode'],
      group: 'Run',
      verb: 'Run',
      icon: session.resolvedTheme === 'dark' ? 'sun' : 'moon',
      shortcut: 'mod+shift+l',
      run: () => session.setTheme(session.resolvedTheme === 'dark' ? 'light' : 'dark'),
    });
    entries.push({
      id: 'run.density',
      title: `Use ${session.density === 'compact' ? 'comfortable' : 'compact'} density`,
      keywords: ['rows', 'spacing', 'compact'],
      group: 'Run',
      verb: 'Run',
      icon: 'table',
      run: () => session.setDensity(session.density === 'compact' ? 'comfortable' : 'compact'),
    });
    entries.push({
      id: 'run.rail',
      title: rail ? 'Expand the sidebar' : 'Collapse the sidebar to icons',
      subtitle: narrow ? 'This window is too narrow for a docked sidebar, so it opens over the page' : undefined,
      group: 'Run',
      verb: 'Run',
      icon: rail ? 'chevrons-right' : 'chevrons-left',
      shortcut: 'mod+\\',
      run: toggleRail,
    });
    entries.push({
      id: 'run.shortcuts',
      title: 'Show keyboard shortcuts',
      group: 'Run',
      verb: 'Run',
      icon: 'command',
      shortcut: '?',
      run: () => setShortcutsOpen(true),
    });
    entries.push({
      id: 'run.reload',
      title: 'Refresh every panel on screen',
      subtitle: 'Drops the client cache and re-reads from the API',
      group: 'Run',
      verb: 'Run',
      icon: 'refresh',
      run: () => { refreshAll(); toast.info('Refreshed', 'Every panel re-read its data from the API.'); },
    });
    entries.push({
      id: 'run.signout',
      title: 'Sign out',
      group: 'Run',
      verb: 'Run',
      icon: 'logout',
      run: () => { void session.signOut().then(() => navigate('/login')); },
    });

    return entries;
  }, [flatNav, jumpKeyFor, createActions, navigate, session, rail, narrow, toggleRail, refreshAll, toast, advance, f]);

  /* ------------------------------ breadcrumbs ----------------------------- */

  const navByPath = useMemo(() => navLabelIndex(NAV), []);

  // The record's own name, handed up by the screen. It is remembered with the
  // path it was set for, so a stale name can never label the next screen while
  // that screen is still loading its own.
  const [current, setCurrentState] = useState<{ path: string; label: string } | null>(null);
  const pathRef = useRef(location.path);
  pathRef.current = location.path;
  const setCurrent = useCallback((label: string | null) => {
    setCurrentState(label ? { path: pathRef.current, label } : null);
  }, []);
  const currentLabel = current && current.path === location.path ? current.label : null;

  const crumbs = useMemo(() => withCurrentLabel(crumbsFor(location.path, (prefix, _segment, isLast) => {
    const label = navByPath.get(prefix);
    if (label) return label;
    if (isLast && route?.title) return typeof route.title === 'function' ? route.title(params) : route.title;
    const matched = matchRoute(ROUTES, prefix);
    const title = matched?.route.title;
    return typeof title === 'string' ? title : null;
  }), currentLabel), [location.path, navByPath, route, params, currentLabel]);

  // The tab follows the crumb. The router names it after the route on every
  // navigation; this only runs afterwards, once a screen has said who it is.
  useEffect(() => {
    if (currentLabel) document.title = `${currentLabel} · Ain`;
  }, [currentLabel]);

  /* --------------------- navigation: focus and announce -------------------- */

  const trail = crumbs.map((crumb) => crumb.label).join(' · ');
  const announced = useRef(location.path);

  useEffect(() => {
    if (announced.current === location.path) return;
    announced.current = location.path;
    setDrawer(false);
    // Replacing the whole main region without moving the caret leaves a
    // keyboard or screen-reader user parked on a control that is now describing
    // a screen they cannot see. Move to the new region and say what it is —
    // unless the screen itself put the caret somewhere on purpose.
    setAnnouncement(trail);
    const main = mainRef.current;
    if (!main) return;
    main.scrollTop = 0;
    const focused = document.activeElement;
    if (!focused || focused === document.body || !main.contains(focused)) main.focus({ preventScroll: true });
  }, [location.path, trail]);

  useEffect(() => { if (!narrow) setDrawer(false); }, [narrow]);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);

  const skipToContent = useCallback(() => {
    const main = mainRef.current;
    if (!main) return;
    main.scrollTop = 0;
    main.focus();
  }, []);

  const shellApi = useMemo<ShellApi>(() => ({
    openPalette: () => setPaletteOpen(true),
    openSearch: (query?: string) => navigate(query ? `/search?q=${encodeURIComponent(query)}` : '/search'),
    openTimeMachine: () => setClockOpen(true),
    openShortcuts: () => setShortcutsOpen(true),
    refresh: refreshAll,
    setCurrent,
  }), [navigate, refreshAll, setCurrent]);

  const activeItem = activeNavItem(flatNav, location.path);
  const clock = session.me?.clock;
  const refusing = !!useRateLimit();
  const canAdvance = clock?.kind === 'virtual' && ['owner', 'admin'].includes(session.me?.role ?? '');

  return (
    <ShellContext.Provider value={shellApi}>
    <div className="shell" data-rail={String(rail)} data-narrow={String(narrow)} data-drawer={String(narrow && drawer)}>
      {/* The first tab stop in the document: one key to step over the chrome
          instead of twelve, on every navigation. */}
      <a className="shell-skip" href="#main" onClick={(e) => { e.preventDefault(); skipToContent(); }}>
        Skip to content
      </a>

      <Sidebar
        rail={rail}
        narrow={narrow}
        onToggleRail={toggleRail}
        sections={sections}
        activeItem={activeItem}
        jumpKeyFor={jumpKeyFor}
      />
      {narrow && drawer && (
        <button
          type="button"
          className="shell-scrim"
          aria-label="Close the navigation"
          onClick={() => setDrawer(false)}
        />
      )}

      <div className="shell-body">
        <header className="shell-top">
          <div className="shell-top__crumbs">
            <nav aria-label="Breadcrumb" className="ain-crumbs">
              {crumbs.map((crumb, i) => (
                <span className="ain-crumbs__item" key={`${crumb.label}-${i}`}>
                  {i > 0 && <span className="ain-crumbs__sep" aria-hidden><ChevronRightIcon size={12} /></span>}
                  {crumb.to
                    ? <Link to={crumb.to} className="ain-crumbs__link">{crumb.label}</Link>
                    : <span className="ain-crumbs__current" aria-current="page">{crumb.label}</span>}
                </span>
              ))}
            </nav>
          </div>

          <div className="shell-top__search">
            {!compact && <TopSearch inputRef={searchRef} sources={sources} onPalette={() => setPaletteOpen(true)} />}
          </div>

          <div className="shell-top__actions">
            {compact && (
              <Tooltip content="Search everything" shortcut="/" placement="bottom">
                <IconButton
                  label="Search everything"
                  icon={<Icons.search size={16} />}
                  onClick={() => navigate('/search')}
                />
              </Tooltip>
            )}
            <CreateMenu actions={createActions} mapError={platform.error} onRetry={platform.retry} />
            {clock && (
              <TimeMachine
                open={clockOpen}
                onOpenChange={setClockOpen}
                now={session.now()}
                offsetMs={clock.offset_ms}
                clockKind={clock.kind}
                canAdvance={!!canAdvance}
                stale={refusing}
                onSettled={refreshAll}
              />
            )}
            <Notifications />
            {!compact && <div className="shell-top__divider" aria-hidden />}
            <Appearance />
            {/* A shortcut sheet is chrome for a window with a keyboard attached;
                on a 400px screen it only crowds out the controls that work. */}
            {!compact && (
              <Tooltip content="Keyboard shortcuts" shortcut="?">
                <IconButton label="Keyboard shortcuts" icon={<Icons.command size={16} />} onClick={() => setShortcutsOpen(true)} />
              </Tooltip>
            )}
            <Account />
          </div>
        </header>

        <ConnectionBanner onRetry={refreshAll} />

        <main className="shell-main" id="main" ref={mainRef} tabIndex={-1}>
          <RouteHost route={route} params={params} path={location.path} />
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        entries={paletteEntries}
        sources={sources}
        onOpenSearch={(to) => navigate(to)}
      />

      <Modal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        size="lg"
        title="Keyboard shortcuts"
        description="Every binding the shell listens for. Overlays always close with Esc."
      >
        <div className="keys">
          {shortcutSheet(jumps).map((group) => (
            <div className="keys__group" key={group.title}>
              <div className="keys__title">{group.title}</div>
              {group.rows.map((row) => (
                <div className="keys__row" key={row.label}>
                  <span className="keys__label">{row.label}</span>
                  <span className="keys__combo">
                    {row.keys.map((key) => <Kbd key={key} combo={key} />)}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Modal>

      {chord && (
        <div className="shell-chord" role="status">
          <Kbd>g</Kbd>
          <span>then a letter — {jumps.slice(0, 4).map((jump) => jump.key).join(', ')}…</span>
        </div>
      )}

      {/* What screen you are now on, for anyone who cannot see that it changed. */}
      <div className="u-visually-hidden" role="status" aria-live="polite">{announcement}</div>

      <Toaster />
    </div>
    </ShellContext.Provider>
  );
}

/* ============================ connection banner =========================== */

/**
 * Seconds until the client tries again, ticking, plus the automatic retry when
 * it reaches zero. Shared by the banner and the boot screen so a refused
 * workspace behaves the same whether or not it managed to load once.
 */
function useRetryCountdown(limit: RateLimited | null, onRetry: () => void): number {
  const [, tick] = useState(0);
  const retriedAt = useRef(0);

  useEffect(() => {
    if (!limit) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [limit]);

  useEffect(() => {
    if (!limit) return;
    const id = setTimeout(() => {
      if (retriedAt.current === limit.retryAt) return;
      retriedAt.current = limit.retryAt;
      onRetry();
    }, Math.max(0, limit.retryAt - Date.now()) + 100);
    return () => clearTimeout(id);
  }, [limit, onRetry]);

  return limit ? Math.max(0, Math.ceil((limit.retryAt - Date.now()) / 1000)) : 0;
}

/** The workspace could not be read at all — not signed out, unreachable. */
function Unreachable({ error, onRetry }: { error: ApiClientError; onRetry: () => void }) {
  const limit = useRateLimit();
  const left = useRetryCountdown(limit, onRetry);
  const refused = error.status === 429;

  return (
    <div className="shell-boot">
      <div className="shell-blocked">
        <ErrorState
          title={refused ? 'The API is refusing this workspace’s requests' : 'This workspace could not be reached'}
          message={
            refused
              ? `${error.body.message} Your sign-in is fine — the server is turning requests away, so nothing can be read yet.${limit?.retryAfter !== null && limit ? ` It asked for ${limit.retryAfter} ${limit.retryAfter === 1 ? 'second' : 'seconds'}.` : ''}`
              : `${error.body.message} Nothing is wrong with your sign-in; the API did not answer, so there is nothing honest to show yet.`
          }
          code={`${error.status} ${error.body.code}`}
          requestId={error.body.request_id ?? null}
          action={
            <Button variant="primary" iconLeft={<Icons.refresh size={14} />} onClick={onRetry}>
              {left ? `Try again — retrying in ${left}s` : 'Try again'}
            </Button>
          }
        />
      </div>
    </div>
  );
}

/**
 * A 429 is the server refusing this workspace, not this panel. Nine widgets
 * quietly falling back to their empty states is the worst possible reading of
 * it, so it is stated once, at the top, until a call gets through — with what
 * the server said, what it asked us to wait, and a countdown to the automatic
 * retry.
 */
function ConnectionBanner({ onRetry }: { onRetry: () => void }) {
  const limit = useRateLimit();
  const left = useRetryCountdown(limit, onRetry);
  if (!limit) return null;

  return (
    <div className="shell-connection">
      <Banner
        tone="warning"
        bar
        title="The API is refusing this workspace’s requests"
        actions={
          <Button size="sm" variant="secondary" iconLeft={<Icons.refresh size={13} />} onClick={onRetry}>
            Try again now
          </Button>
        }
      >
        {limit.message}{' '}
        {limit.retryAfter !== null
          ? `The server asked for ${limit.retryAfter} ${limit.retryAfter === 1 ? 'second' : 'seconds'}.`
          : 'The server sent no Retry-After header, so this is backing off on its own.'}{' '}
        Every number on screen is stale until a call gets through —{' '}
        {left ? `retrying in ${left}s` : 'retrying now'}
        {limit.streak > 1 ? `, ${limit.streak} rounds refused so far` : ''}.
        {limit.requestId ? <> <span className="u-mono">{limit.requestId}</span></> : null}
      </Banner>
    </div>
  );
}

/* ================================ sidebar ================================= */

interface SidebarProps {
  rail: boolean;
  /** The window is too narrow to dock a labelled sidebar beside the content. */
  narrow: boolean;
  onToggleRail: () => void;
  sections: { group: string; label: string; items: NavItem[] }[];
  activeItem: NavItem | null;
  jumpKeyFor: Map<string, string>;
}

function Sidebar({ rail, narrow, onToggleRail, sections, activeItem, jumpKeyFor }: SidebarProps) {
  const session = useSession();
  const org = session.me?.org;
  const initial = (org?.name ?? 'Ain').trim().charAt(0).toUpperCase();

  return (
    <aside className="shell-side">
      <div className="shell-brand">
        <Link to="/" className="shell-brand__link" aria-label={`${org?.name ?? 'Ain'} — home`}>
          <span className="shell-mark" aria-hidden>{initial}</span>
          <span className="shell-brand__text">
            <span className="shell-brand__name u-truncate">{org?.name ?? 'Ain'}</span>
            <span className="shell-brand__meta u-truncate">{org?.domain ?? 'workspace'}</span>
          </span>
        </Link>
      </div>

      <nav className="shell-nav" aria-label="Primary">
        {sections.map((section) => (
          <div className="shell-navgroup" key={section.group}>
            {section.label && !rail && <div className="shell-navgroup__label">{section.label}</div>}
            {section.label && rail && <div className="shell-navgroup__rule" aria-hidden />}
            {section.items.map((item) => (
              <NavRow
                key={item.id}
                item={item}
                rail={rail}
                active={activeItem?.id === item.id}
                jumpKey={jumpKeyFor.get(item.id)}
              />
            ))}
          </div>
        ))}
      </nav>

      <div className="shell-sidefoot">
        {!rail && <span className="shell-sidefoot__spacer" />}
        <Tooltip
          content={rail ? (narrow ? 'Show the labels' : 'Expand sidebar') : narrow ? 'Back to icons' : 'Collapse sidebar'}
          shortcut="mod+\\"
          placement="right"
        >
          <IconButton
            size="sm"
            label={rail
              ? (narrow ? 'Open the navigation over the page' : 'Expand sidebar')
              : (narrow ? 'Close the navigation' : 'Collapse sidebar to icons')}
            icon={rail ? <ChevronsRightIcon size={15} /> : <ChevronsLeftIcon size={15} />}
            aria-expanded={narrow ? !rail : undefined}
            onClick={onToggleRail}
          />
        </Tooltip>
      </div>
    </aside>
  );
}

function NavRow({ item, rail, active, jumpKey }: { item: NavItem; rail: boolean; active: boolean; jumpKey?: string }) {
  const { location } = useRouter();
  // In rail mode the label is hidden with CSS, which also takes it out of the
  // accessibility tree — so the link carries its own name.
  const link = (
    <Link
      to={item.to}
      className={`shell-navitem${active ? ' is-active' : ''}`}
      aria-current={active ? 'page' : undefined}
      aria-label={rail ? item.label : undefined}
    >
      <span className="shell-navitem__icon" aria-hidden>{renderIcon(item.icon, 16)}</span>
      <span className="shell-navitem__label u-truncate">{item.label}</span>
      {item.badge ? <span className="shell-navitem__badge">{item.badge()}</span> : null}
      {jumpKey && !item.badge && <span className="shell-navitem__key" aria-hidden>g {jumpKey}</span>}
    </Link>
  );

  if (rail) return <RailFlyout item={item} jumpKey={jumpKey}>{link}</RailFlyout>;

  return (
    <>
      {link}
      {active && item.children?.length ? (
        <div className="shell-subnav">
          {item.children.map((child) => (
            <Link
              key={child.id}
              to={child.to}
              className={`shell-subnav__item u-truncate${isPathActive(location.path, child.to) ? ' is-active' : ''}`}
            >
              {child.label}
            </Link>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * The collapsed rail's flyout.
 *
 * A 56px rail of glyphs is only usable if pointing at one tells you what it is
 * *now*, and if a section's own sub-navigation is still reachable without
 * expanding the whole sidebar. The browser's native `title` does neither: it
 * waits out the OS delay, never appears on keyboard focus, and cannot hold a
 * link. A destination with no children gets a real tooltip; one with children
 * gets its sub-navigation, which stays open long enough to walk into.
 */
function RailFlyout({ item, jumpKey, children }: { item: NavItem; jumpKey?: string; children: ReactNode }) {
  const { location } = useRouter();
  const host = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const id = useId();
  const children_ = item.children ?? [];
  const interactive = children_.length > 0;

  const show = () => { clearTimeout(closeTimer.current); setOpen(true); };
  // A short grace period is what makes the gap between rail and panel crossable.
  const hide = () => { clearTimeout(closeTimer.current); closeTimer.current = setTimeout(() => setOpen(false), 140); };

  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => { setOpen(false); }, [location.path]);

  useLayoutEffect(() => {
    if (!open || !host.current || !panel.current) return;
    const size = { width: panel.current.offsetWidth, height: panel.current.offsetHeight };
    if (!size.width && !size.height) return;
    const result = computePosition(rectOf(host.current), size, viewportSize(), { placement: 'right-start', offset: 10 });
    setPos({ x: result.x, y: result.y });
  }, [open, item.id]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { clearTimeout(closeTimer.current); setOpen(false); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div
      ref={host}
      className="shell-railitem"
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
      aria-describedby={open && !interactive ? id : undefined}
    >
      {children}
      {open && (
        <Portal>
          <div
            ref={panel}
            id={id}
            role={interactive ? 'group' : 'tooltip'}
            aria-label={interactive ? item.label : undefined}
            className={`shell-flyout${interactive ? '' : ' is-tip'}`}
            style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
            onPointerEnter={show}
            onPointerLeave={hide}
          >
            <div className="shell-flyout__head">
              <span className="u-truncate">{item.label}</span>
              {jumpKey && <span className="shell-flyout__key"><Kbd>g</Kbd><Kbd>{jumpKey}</Kbd></span>}
            </div>
            {interactive && (
              <div className="shell-flyout__list">
                {children_.map((child) => (
                  <Link
                    key={child.id}
                    to={child.to}
                    className={`shell-flyout__item u-truncate${isPathActive(location.path, child.to) ? ' is-active' : ''}`}
                  >
                    {child.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </Portal>
      )}
    </div>
  );
}

/* ================================ top bar ================================= */

/**
 * The top bar's search, answering as you type.
 *
 * A dashboard's most-used control should not cost a page transition to find one
 * customer, so this ranks live records under the field, grouped by type: ↑↓
 * moves, ↵ opens the highlighted one. What it will not do is pretend the four
 * rows per source it has room for are the whole answer — the last row is always
 * the full search page, a hit no installed module can open is shown but never
 * takes the highlight, and a source that failed is named rather than read as
 * "nothing matched".
 */
function TopSearch({ inputRef, sources, onPalette }: {
  inputRef: React.RefObject<HTMLInputElement>;
  sources: SearchSource[];
  onPalette: () => void;
}) {
  const { navigate, location } = useRouter();
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const rowId = (id: string) => `${listId}-${id}`;

  const search = useGlobalSearch(value, sources, { perSource: 4, limit: 24, delay: 140 });
  const typed = value.trim();
  const targets = useMemo(() => typeaheadTargets(search.groups, typed), [search.groups, typed]);
  const shown = useMemo(() => search.groups.reduce((n, group) => n + group.hits.length, 0), [search.groups]);
  // Every hit but no way into any of them: say it once, above the list, rather
  // than stamping the same sentence on all ten rows.
  const openable = targets.length - (targets.length && !targets[targets.length - 1].hit ? 1 : 0);
  const indexOf = useMemo(() => new Map(targets.map((target, i) => [target.id, i])), [targets]);

  const panelOpen = open && typed.length > 0 && sources.length > 0;
  const at = targets.length ? Math.min(active, targets.length - 1) : -1;
  const highlighted = at >= 0 ? targets[at] : undefined;

  useEffect(() => { if (location.path !== '/search') setValue(''); }, [location.path]);
  useEffect(() => { setActive(0); }, [typed, shown]);

  // ↓ past the visible rows has to bring the highlight with it.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[data-active="true"]');
    if (!list || !row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop + 24) list.scrollTop = Math.max(0, top - 28);
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 6;
  }, [at, shown]);

  const go = (target: TypeaheadTarget) => { setOpen(false); navigate(target.href); };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!typed) return;
      e.preventDefault();
      setOpen(true);
      if (!targets.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (Math.min(i, targets.length - 1) + step + targets.length) % targets.length);
    } else if (e.key === 'Enter') {
      // Nothing under the highlight — no module installed, nothing typed — and
      // the form's own submit takes the query to the full search page.
      if (!panelOpen || !highlighted) return;
      e.preventDefault();
      go(highlighted);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (panelOpen) setOpen(false);
      else { setValue(''); e.currentTarget.blur(); }
    } else if (e.key === 'Home' && panelOpen && targets.length) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End' && panelOpen && targets.length) {
      e.preventDefault();
      setActive(targets.length - 1);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const note = search.failures.length
    ? {
      tone: 'alert' as const,
      text: `${search.failures.map((failure) => failure.source.label).join(', ')} could not be searched — ${search.failures[0].error.body.message}`,
      meta: search.failures[0].error.body.request_id,
    }
    : typed.length < 2
      ? { tone: 'status' as const, text: 'Records are searched from the second character.', meta: null }
      : search.loading && !shown
        ? { tone: 'status' as const, text: `Searching ${sources.length} ${sources.length === 1 ? 'source' : 'sources'}…`, meta: null }
        : !search.loading && !shown
          ? { tone: 'status' as const, text: `Nothing matches “${typed}” in ${sources.map((source) => source.label.toLowerCase()).join(', ')}.`, meta: null }
          : shown && !openable
            ? { tone: 'status' as const, text: 'These match, but no module on this workspace registers a screen for them yet — ↵ opens the full results page.', meta: null }
            : null;

  return (
    <form
      className="shell-search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        setOpen(false);
        navigate(typed ? `/search?q=${encodeURIComponent(typed)}` : '/search');
      }}
    >
      <Icons.search size={15} />
      <input
        ref={inputRef}
        className="shell-search__input"
        value={value}
        placeholder="Search records, customers, price book…"
        aria-label="Search everything"
        role="combobox"
        aria-expanded={panelOpen}
        aria-controls={panelOpen ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={panelOpen && highlighted ? rowId(highlighted.id) : undefined}
        autoComplete="off"
        onChange={(e) => { setValue(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {search.loading && panelOpen && <Spinner size={14} label="Searching records" />}
      {value ? <Kbd>↵</Kbd> : (
        <>
          <Kbd>/</Kbd>
          <button type="button" onClick={onPalette} aria-label="Open the command palette" style={{ display: 'inline-flex' }}>
            <Kbd combo="mod+k" />
          </button>
        </>
      )}

      {panelOpen && (
        // Keeping the caret in the field is what makes a click on a row fire at
        // all: blurring first would close the panel out from under the pointer.
        <div className="shell-search__panel" onMouseDown={(e) => e.preventDefault()}>
          {note && (
            <div className={`shell-search__note${note.tone === 'alert' ? ' is-alert' : ''}`} role={note.tone === 'alert' ? 'alert' : 'status'}>
              <span>{note.text}</span>
              {note.meta && <span className="u-mono">{note.meta}</span>}
            </div>
          )}

          <div className="shell-search__box" id={listId} role="listbox" aria-label="Search results">
            {/* Only the groups scroll. The row that opens the full page is
                pinned, so the highlight is never parked out of sight. */}
            <div className="shell-search__list" role="presentation" ref={listRef}>
            {search.groups.map((group) => (
              <div className="shell-search__group" key={group.source.id} role="group" aria-label={group.source.label}>
                <div className="shell-search__grouphead" aria-hidden>
                  <span>{group.source.label}</span>
                  <span className="shell-search__groupcount">{group.hits.length}</span>
                </div>
                {group.hits.map((hit) => {
                  const i = hit.href ? indexOf.get(`${hit.type}:${hit.id}`) ?? -1 : -1;
                  return (
                    <div
                      key={`${hit.type}:${hit.id}`}
                      id={i >= 0 ? rowId(`${hit.type}:${hit.id}`) : undefined}
                      role="option"
                      aria-selected={i >= 0 && i === at}
                      aria-disabled={hit.href ? undefined : true}
                      data-active={i >= 0 && i === at}
                      className={`shell-search__row${i >= 0 && i === at ? ' is-active' : ''}${hit.href ? '' : ' is-unopenable'}`}
                      onPointerEnter={() => { if (i >= 0) setActive(i); }}
                      onClick={() => { if (i >= 0) go(targets[i]); }}
                    >
                      <span className="shell-search__icon">{renderIcon(hit.icon, 15)}</span>
                      <span className="shell-search__text">
                        <span className="shell-search__title u-truncate">{hit.title}</span>
                        {hit.subtitle && <span className="shell-search__sub u-truncate">{hit.subtitle}</span>}
                      </span>
                      <span className="shell-search__aside">
                        {hit.href
                          ? <span className="u-mono u-truncate">{hit.id}</span>
                          : openable > 0 && <span className="shell-search__flag">No screen installed</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
            </div>

            {targets.length > 0 && (() => {
              const everything = targets[targets.length - 1];
              const i = targets.length - 1;
              return (
                <div
                  id={rowId(everything.id)}
                  role="option"
                  aria-selected={i === at}
                  className={`shell-search__row shell-search__row--all${i === at ? ' is-active' : ''}`}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => go(everything)}
                >
                  <span className="shell-search__icon"><Icons.search size={15} /></span>
                  <span className="shell-search__text">
                    <span className="shell-search__title u-truncate">
                      {shown ? <>See every match for “{typed}”</> : <>Search everything for “{typed}”</>}
                    </span>
                    <span className="shell-search__sub u-truncate">
                      The full results page, with the type filter and no per-source cap
                    </span>
                  </span>
                  <span className="shell-search__aside"><Kbd>↵</Kbd></span>
                </div>
              );
            })()}
          </div>

          <div className="shell-search__foot">
            <span className="shell-search__hint"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
            <span className="shell-search__hint"><Kbd>↵</Kbd> open</span>
            <span className="shell-search__hint"><Kbd combo="esc" /> close</span>
            <span className="shell-search__count">
              {shown
                ? `${shown} shown from ${sources.length} ${sources.length === 1 ? 'source' : 'sources'}`
                : `${sources.length} ${sources.length === 1 ? 'source' : 'sources'} searched`}
            </span>
          </div>
        </div>
      )}
    </form>
  );
}

function CreateMenu({ actions, mapError, onRetry }: {
  actions: { id: string; label: string; icon: string; to: string }[];
  mapError: ApiClientError | null;
  onRetry: () => void;
}) {
  const { navigate } = useRouter();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  // Create actions are derived from the module list. When that read failed,
  // "nothing to create" is a guess dressed as an answer.
  const unavailable = mapError
    ? [{
      id: 'unreadable',
      label: 'The module list could not be read',
      description: `${mapError.body.message}${mapError.body.request_id ? ` · ${mapError.body.request_id}` : ''}`,
      icon: <AlertTriangleIcon size={15} />,
      onSelect: onRetry,
    }]
    : [{
      id: 'none',
      label: 'Nothing to create yet',
      description: 'Modules register their own create actions as they are installed.',
      disabled: true,
    }];

  const sections: MenuSection[] = [{
    id: 'create',
    label: 'Create',
    items: actions.length
      ? actions.map((action) => ({
        id: action.id,
        label: action.label,
        icon: renderIcon(action.icon, 15),
        onSelect: () => navigate(action.to),
      }))
      : unavailable,
  }];

  return (
    <>
      <Tooltip content="Create" placement="bottom">
        <IconButton
          ref={anchor}
          variant="primary"
          label="Create"
          icon={<Icons.plus size={16} />}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        />
      </Tooltip>
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} sections={sections} ariaLabel="Create" />
    </>
  );
}

interface EventRow {
  id: string;
  type: string;
  object_type: string | null;
  object_id: string | null;
  actor_type: string;
  created: number;
  data?: unknown;
}

function Notifications() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [readAt, setReadAt] = useLocalStorage('ain.notifications.read', 0);
  const { data, error, loading, refetch } = useQuery<{ data: EventRow[] }>('/v1/events', { limit: 25 });
  const f = useFormat();
  const { navigate } = useRouter();
  // Events are stamped on the workspace clock. Marking them read at the
  // machine's own time left every event written after a jump forward unread
  // for as long as the simulation stayed ahead of real time.
  const now = useSession().now;

  const events = data?.data ?? [];
  const unread = events.filter((event) => event.created > readAt).length;
  const registered = useMemo(() => ROUTES.map((route) => route.path), []);

  const hrefFor = (event: EventRow): string | null => {
    if (!event.object_type || !event.object_id) return null;
    const pattern = firstRegistered(registered, recordRouteCandidates(event.object_type));
    return pattern ? fillParams(pattern, event.object_id) : null;
  };

  return (
    <>
      <Tooltip content={unread ? `${unread} new since you last looked` : 'Activity'} placement="bottom">
        <IconButton
          ref={anchor}
          label={unread ? `Activity — ${unread} new` : 'Activity'}
          icon={
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <Icons.bell size={16} />
              {unread > 0 && (
                <span
                  aria-hidden
                  style={{
                    position: 'absolute', insetInlineEnd: -2, top: -2, width: 7, height: 7,
                    borderRadius: 'var(--radius-full)', background: 'var(--red-500)',
                  }}
                />
              )}
            </span>
          }
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        />
      </Tooltip>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-end" ariaLabel="Activity" title="Activity">
        <div className="notif">
          {error && (
            <ErrorState
              className="notif__error"
              title="The event log did not answer"
              message={error.body.message}
              code={error.body.code}
              requestId={error.body.request_id ?? null}
              action={<Button size="sm" variant="primary" iconLeft={<Icons.refresh size={13} />} onClick={refetch}>Try again</Button>}
            />
          )}
          {!error && loading && <div style={{ padding: 'var(--space-4)' }}><SkeletonText lines={4} /></div>}
          {!error && !loading && !events.length && (
            <p className="tm__sub">Nothing has happened in this workspace yet. Every write emits an event, and they land here.</p>
          )}
          <div className="notif__list">
            {events.map((event) => {
              const href = hrefFor(event);
              const subject = eventSubject(event.data);
              const body = (
                <>
                  <span className={`notif__dot${event.created > readAt ? '' : ' is-read'}`} aria-hidden />
                  <span className="notif__text">
                    <span className="notif__title u-truncate">{eventTitle(event.type)}</span>
                    <span className="notif__sub u-truncate">
                      {subject ?? event.object_id ?? event.object_type ?? 'system'}
                      {event.actor_type === 'system' ? ' · automated' : ''}
                    </span>
                  </span>
                  <span className="notif__when">{f.relative(event.created)}</span>
                </>
              );
              return href ? (
                <button key={event.id} type="button" className="notif__item" onClick={() => { setOpen(false); navigate(href); }}>
                  {body}
                </button>
              ) : (
                <div key={event.id} className="notif__item">{body}</div>
              );
            })}
          </div>
          <div className="notif__foot">
            <Button size="sm" variant="secondary" disabled={!unread} onClick={() => setReadAt(now())}>
              Mark all as read
            </Button>
            <span className="tm__sub" style={{ alignSelf: 'center' }}>
              {error ? 'could not be read' : `${formatNumber(events.length)} most recent`}
            </span>
          </div>
        </div>
      </Popover>
    </>
  );
}

function Appearance() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const session = useSession();

  return (
    <>
      <Tooltip content="Appearance" shortcut="mod+shift+l" placement="bottom">
        <IconButton
          ref={anchor}
          label="Appearance"
          icon={session.resolvedTheme === 'dark' ? <Icons.moon size={16} /> : <Icons.sun size={16} />}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        />
      </Tooltip>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-end" ariaLabel="Appearance" title="Appearance">
        <div className="acct">
          <div className="acct__section">
            <span className="acct__label">Theme</span>
            <SegmentedControl<Theme>
              value={session.theme}
              onChange={session.setTheme}
              size="sm"
              aria-label="Theme"
              options={[
                { value: 'light', label: 'Light', icon: <Icons.sun size={13} /> },
                { value: 'dark', label: 'Dark', icon: <Icons.moon size={13} /> },
                { value: 'system', label: 'System', icon: <Icons.cpu size={13} /> },
              ]}
            />
          </div>
          <div className="acct__section">
            <span className="acct__label">Density</span>
            <SegmentedControl<Density>
              value={session.density}
              onChange={session.setDensity}
              size="sm"
              aria-label="Density"
              options={[
                { value: 'comfortable', label: 'Comfortable' },
                { value: 'compact', label: 'Compact' },
              ]}
            />
            <span className="tm__sub">Compact tightens table rows and form controls for long sessions.</span>
          </div>
        </div>
      </Popover>
    </>
  );
}

function Account() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const session = useSession();
  const { navigate } = useRouter();
  const me = session.me;
  const user = me?.user;

  const settingsHref = useMemo(
    () => firstRegistered(ROUTES.map((route) => route.path), ['/settings', '/settings/workspace', '/workspace/settings']),
    [],
  );

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={user ? `Account — ${user.name}` : 'Account'}
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'inline-flex', borderRadius: 'var(--radius-full)' }}
      >
        <Avatar name={user?.name ?? 'Ain'} src={avatarSrc(user?.avatar_url)} seed={user?.id} size={26} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-end" ariaLabel="Account">
        <div className="acct">
          <div className="acct__who">
            <Avatar name={user?.name ?? 'Ain'} src={avatarSrc(user?.avatar_url)} seed={user?.id} size={38} />
            <div style={{ minWidth: 0 }}>
              <div className="acct__name u-truncate">{user?.name ?? 'Signed out'}</div>
              <div className="acct__mail u-truncate">{user?.email ?? '—'}</div>
            </div>
            <Badge tone="brand" size="sm" style={{ marginInlineStart: 'auto' }}>{me?.role ?? 'guest'}</Badge>
          </div>

          <div className="acct__section">
            <span className="acct__label">Workspace</span>
            <button type="button" className="acct__ws" onClick={() => { setOpen(false); navigate('/'); }}>
              <span className="shell-mark" aria-hidden style={{ width: 22, height: 22 }}>
                {(me?.org.name ?? 'A').charAt(0).toUpperCase()}
              </span>
              <span className="acct__wsname u-truncate">{me?.org.name}</span>
              <Icons.check size={14} style={{ color: 'var(--text-brand)' }} />
            </button>
            <span className="tm__sub">
              {me?.org.default_currency.toUpperCase()} · {me?.org.timezone.replace(/_/g, ' ')} · {me?.teammates.length ?? 0} teammates
            </span>
          </div>

          <Divider />

          <div className="acct__section">
            {settingsHref && (
              <Button variant="ghost" block iconLeft={<Icons.settings size={14} />} onClick={() => { setOpen(false); navigate(settingsHref); }}>
                Workspace settings
              </Button>
            )}
            <Button
              variant="ghost"
              block
              iconLeft={<Icons.login size={14} />}
              onClick={() => { setOpen(false); navigate('/login'); }}
            >
              Sign in to another workspace
            </Button>
            <Button
              variant="danger-ghost"
              block
              iconLeft={<Icons.logout size={14} />}
              onClick={() => { setOpen(false); void session.signOut().then(() => navigate('/login')); }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </Popover>
    </>
  );
}

/* ============================== routed screen ============================= */

function RouteHost({ route, params, path }: { route: RouteDef | null; params: Record<string, string>; path: string }) {
  const { navigate } = useRouter();
  if (!route) return <NotFound path={path} />;
  const Element = route.element;
  return (
    <ErrorBoundary
      resetKeys={[path]}
      fallback={(error, reset) => (
        <div style={{ padding: 'var(--space-11) var(--space-8)' }}>
          <ErrorState
            title="This screen stopped rendering"
            message="The rest of the app is still live — the sidebar, the palette and your session are untouched. Try again, or move on and come back."
            code={error.message || error.name}
            requestId={lastRequestId()}
            action={<Button variant="primary" iconLeft={<Icons.refresh size={14} />} onClick={reset}>Try again</Button>}
            secondaryAction={<Button onClick={() => navigate('/')}>Back to the dashboard</Button>}
          />
        </div>
      )}
    >
      <Suspense fallback={<RouteSkeleton />}>
        <Element {...params} />
      </Suspense>
    </ErrorBoundary>
  );
}

function RouteSkeleton() {
  return (
    <div className="shell-routeloading" aria-busy="true" aria-label="Loading screen">
      <Skeleton width={220} height={26} />
      <SkeletonText lines={2} />
      <Skeleton height={180} />
    </div>
  );
}

function NotFound({ path }: { path: string }) {
  const { navigate } = useRouter();
  const suggestions = useMemo(() => {
    const wanted = path.replace(/[^a-z]/gi, '').toLowerCase();
    const scored = NAV
      .map((item) => ({ item, score: overlap(item.to.replace(/[^a-z]/gi, '').toLowerCase(), wanted) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
    return scored.map((row) => row.item);
  }, [path]);

  return (
    <div style={{ padding: 'var(--space-12) var(--space-8)', maxWidth: 720, margin: '0 auto' }}>
      <Card>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
          <div>
            <Badge tone="warning" size="sm">404</Badge>
            <h1 style={{ fontSize: 'var(--text-2xl)', marginTop: 'var(--space-4)' }}>Nothing is registered at this address</h1>
            <p style={{ color: 'var(--text-secondary)', marginTop: 'var(--space-3)' }}>
              <code>{path}</code> does not match any screen in this build. The module that owns it may
              not be installed on this workspace.
            </p>
          </div>
          <div className="notfound__list">
            {suggestions.map((item) => (
              <Link key={item.id} to={item.to} className="notfound__link">
                <span aria-hidden>{renderIcon(item.icon, 15)}</span>
                {item.label}
                <span className="notfound__where">{item.to}</span>
              </Link>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-4)' }}>
            <Button variant="primary" onClick={() => navigate('/')} iconLeft={<Icons.home size={14} />}>
              Back to the dashboard
            </Button>
            <Button
              onClick={() => navigate(`/search?q=${encodeURIComponent(path.split('/').filter(Boolean).join(' '))}`)}
              iconLeft={<Icons.search size={14} />}
            >
              Search for it
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** Longest common prefix length — good enough to rank "did you mean" links. */
function overlap(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}
