/**
 * The shell's decisions, with no DOM attached.
 *
 * Navigation grouping, breadcrumb derivation, palette ranking, the `g`-key
 * jump table, the time-machine presets and route availability all live here so
 * they can be reasoned about and tested without mounting React.
 */
import type { NavGroup, NavItem } from './registry-types';
import { addInterval, DAY, WEEK } from '../../shared/time';

/* ============================== navigation ================================ */

export const NAV_GROUP_ORDER: NavGroup[] = [
  'workspace', 'crm', 'engage', 'revenue', 'automation', 'insights', 'settings',
];

/** An empty label means the group runs straight on without a heading. */
export const NAV_GROUP_LABEL: Record<NavGroup, string> = {
  workspace: '',
  crm: 'Customers',
  engage: 'Engage',
  revenue: 'Revenue',
  automation: 'Automation',
  insights: 'Insights',
  settings: 'Settings',
};

export interface NavSection {
  group: NavGroup;
  label: string;
  items: NavItem[];
}

/** Registry order is arbitrary — modules load alphabetically — so sort here. */
export function groupNav(items: NavItem[]): NavSection[] {
  const byGroup = new Map<NavGroup, NavItem[]>();
  for (const item of items) {
    const arr = byGroup.get(item.group);
    if (arr) arr.push(item);
    else byGroup.set(item.group, [item]);
  }
  const sections: NavSection[] = [];
  for (const group of NAV_GROUP_ORDER) {
    const groupItems = byGroup.get(group);
    if (!groupItems?.length) continue;
    sections.push({
      group,
      label: NAV_GROUP_LABEL[group],
      items: [...groupItems].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label)),
    });
  }
  return sections;
}

export const normalizePath = (path: string): string => {
  const clean = path.split('?')[0].split('#')[0].replace(/\/+$/, '');
  return clean || '/';
};

/** A destination is active when the current path is it, or sits underneath it. */
export function isPathActive(current: string, to: string): boolean {
  const here = normalizePath(current);
  const there = normalizePath(to);
  if (there === '/') return here === '/';
  return here === there || here.startsWith(there + '/');
}

/**
 * One boolean for the collapsed sidebar.
 *
 * Below the breakpoint a labelled sidebar leaves no usable content column, so
 * the rail there is the layout rather than a preference and the stored choice
 * is ignored until the window is wide again. Deriving it here — rather than
 * letting a media query narrow the sidebar on its own — is what keeps the
 * width, the labels, the flyouts and the collapsed `aria-label` from
 * disagreeing about whether the sidebar is a rail.
 */
export const railState = (preference: boolean, narrow: boolean, drawerOpen: boolean): boolean =>
  (narrow ? !drawerOpen : preference);

/** The deepest nav destination that contains the current path. */
export function activeNavItem(items: NavItem[], path: string): NavItem | null {
  let best: NavItem | null = null;
  for (const item of items) {
    if (!isPathActive(path, item.to)) continue;
    if (!best || normalizePath(item.to).length > normalizePath(best.to).length) best = item;
  }
  return best;
}

/* ============================== breadcrumbs =============================== */

const ID_LIKE = /^[a-z][a-z0-9]{1,14}_[A-Za-z0-9]{4,}$/;

/** `invoice-drafts` → "Invoice drafts". Object ids are left exactly as they are. */
export function humanizeSegment(segment: string): string {
  const decoded = decodeURIComponent(segment);
  if (ID_LIKE.test(decoded)) return decoded;
  const spaced = decoded.replace(/[-_]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  if (!spaced) return decoded;
  return spaced[0].toUpperCase() + spaced.slice(1).toLowerCase();
}

export interface CrumbSpec {
  label: string;
  /** Absent on the last crumb — you are already there. */
  to?: string;
}

/**
 * One crumb per path segment, labelled by whatever the app already knows about
 * that address: a nav destination, a registered route title, and only then a
 * humanised segment. `resolve` is the app's lookup; keeping it a parameter is
 * what makes this testable.
 */
export function crumbsFor(
  path: string,
  resolve: (prefix: string, segment: string, isLast: boolean) => string | null,
  home = 'Home',
): CrumbSpec[] {
  const segments = normalizePath(path).split('/').filter(Boolean);
  const crumbs: CrumbSpec[] = [{ label: home, to: '/' }];
  let prefix = '';
  segments.forEach((segment, i) => {
    prefix += '/' + segment;
    const isLast = i === segments.length - 1;
    crumbs.push({ label: resolve(prefix, segment, isLast) ?? humanizeSegment(segment), to: prefix });
  });
  delete crumbs[crumbs.length - 1].to;
  return crumbs;
}

/* ============================ palette ranking ============================= */

export interface Rankable {
  id: string;
  title: string;
  subtitle?: string;
  keywords?: string[];
}

/**
 * Subsequence scoring, so "nsub" finds "New subscription" and "cmpn" finds
 * "Companies". Word-boundary hits and unbroken runs score highest, gaps cost,
 * and a shorter title wins a tie — which is what makes typing two letters land
 * on the thing you meant rather than the longest label that contains them.
 * Returns -1 when the query is not a subsequence of the text at all.
 */
export function fuzzyScore(text: string, query: string): number {
  if (!query) return 0;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  if (haystack === needle) return 1000;

  let cursor = 0;
  let score = 0;
  let run = 0;
  for (let qi = 0; qi < needle.length; qi++) {
    const at = haystack.indexOf(needle[qi], cursor);
    if (at < 0) return -1;
    const boundary = at === 0 || /[\s\-_/.:·,()]/.test(haystack[at - 1]);
    score += 10;
    if (boundary) score += 14;
    if (at === cursor && qi > 0) { run += 1; score += 6 + run * 3; } else run = 0;
    score -= Math.min(at - cursor, 10) * 0.8;
    cursor = at + 1;
  }
  if (haystack.startsWith(needle)) score += 45;
  return score - haystack.length * 0.12;
}

/** Best score across title, subtitle and keywords, with the weaker fields discounted. */
export function scoreEntry(entry: Rankable, query: string): number {
  let best = fuzzyScore(entry.title, query);
  const subtitle = entry.subtitle ? fuzzyScore(entry.subtitle, query) : -1;
  if (subtitle >= 0) best = Math.max(best, subtitle * 0.6);
  for (const keyword of entry.keywords ?? []) {
    const score = fuzzyScore(keyword, query);
    if (score >= 0) best = Math.max(best, score * 0.75);
  }
  return best;
}

/**
 * Rank for the palette. With no query the recently-run commands float to the
 * top in the order they were last used; with a query, recency only breaks ties
 * between equally good matches.
 */
export function rankEntries<T extends Rankable>(entries: T[], query: string, recents: string[] = []): T[] {
  const recency = (id: string) => {
    const at = recents.indexOf(id);
    return at < 0 ? 0 : recents.length - at;
  };
  if (!query.trim()) {
    return [...entries].sort((a, b) => recency(b.id) - recency(a.id));
  }
  const q = query.trim();
  return entries
    .map((entry, index) => ({ entry, index, score: scoreEntry(entry, q) }))
    .filter((row) => row.score >= 0)
    .sort((a, b) => (b.score - a.score) || (recency(b.entry.id) - recency(a.entry.id)) || (a.index - b.index))
    .map((row) => row.entry);
}

export const RECENT_COMMAND_LIMIT = 6;

/** Most recent first, no duplicates, bounded. */
export function pushRecent(recents: string[], id: string, limit = RECENT_COMMAND_LIMIT): string[] {
  return [id, ...recents.filter((existing) => existing !== id)].slice(0, limit);
}

/* ============================== keyboard map ============================== */

/** `g` starts a jump, `?` opens the sheet — neither can also be a destination key. */
export const RESERVED_JUMP_KEYS = new Set(['g']);

export interface JumpBinding {
  key: string;
  item: NavItem;
}

/**
 * Assign each nav destination a letter for `g` then <letter>. First free letter
 * of the label, then of the id, so the map stays stable as modules are added
 * ahead of or behind one another.
 */
export function jumpBindings(items: NavItem[]): JumpBinding[] {
  const taken = new Set(RESERVED_JUMP_KEYS);
  const bindings: JumpBinding[] = [];
  for (const item of items) {
    const candidates = `${item.label}${item.id}`.toLowerCase().replace(/[^a-z]/g, '');
    const key = [...candidates].find((c) => !taken.has(c));
    if (!key) continue;
    taken.add(key);
    bindings.push({ key, item });
  }
  return bindings;
}

export interface ShortcutRow {
  keys: string[];
  label: string;
}
export interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

export function shortcutSheet(jumps: JumpBinding[]): ShortcutGroup[] {
  return [
    {
      title: 'Anywhere',
      rows: [
        { keys: ['mod+k'], label: 'Command palette — go to, create or run anything' },
        { keys: ['/'], label: 'Search records, customers and the price book' },
        { keys: ['?'], label: 'This shortcut sheet' },
        { keys: ['esc'], label: 'Close the palette, a menu, a drawer or a dialog' },
      ],
    },
    {
      title: 'Workspace',
      rows: [
        { keys: ['mod+\\'], label: 'Collapse the sidebar to an icon rail' },
        { keys: ['mod+shift+t'], label: 'Open the time machine' },
        { keys: ['mod+shift+l'], label: 'Switch between the light and dark theme' },
      ],
    },
    {
      title: 'Go to',
      rows: jumps.map((jump) => ({ keys: ['g', jump.key], label: jump.item.label })),
    },
  ];
}

/* ============================== time machine ============================== */

export interface TimeJump {
  id: string;
  label: string;
  /** What the platform will actually replay, in the operator's language. */
  description: string;
  at(now: number): number;
}

export const TIME_JUMPS: TimeJump[] = [
  {
    id: 'day',
    label: 'A day',
    description: 'Tonight’s renewals and any retry that comes due tomorrow',
    at: (now) => now + DAY,
  },
  {
    id: 'week',
    label: 'A week',
    description: 'Seven days of renewals, dunning retries and scheduled agent runs',
    at: (now) => now + WEEK,
  },
  {
    id: 'cycle',
    label: 'A billing cycle',
    description: 'A full month: renewals, usage settlement and credit expiry',
    at: (now) => addInterval(now, { unit: 'month', count: 1 }),
  },
  {
    id: 'quarter',
    label: 'A quarter',
    description: 'Three months — long enough for a dunning sequence to run out',
    at: (now) => addInterval(now, { unit: 'month', count: 3 }),
  },
];

/**
 * What a clock move actually did, in the operator's language.
 *
 * `POST /v1/time/advance` answering 200 only says the jobs ran. Two things can
 * be true at once — the jobs ran *and* the workspace can no longer be read —
 * and a product that toasts the first while hiding the second is the reason an
 * operator ends up staring at an empty dashboard wondering what they broke.
 */
export interface ClockAftermath {
  status: number;
  message: string;
  requestId: string | null;
}

export interface ClockOutcome {
  tone: 'success' | 'danger';
  title: string;
  description: string;
  /** Pinned when the operator has to do something about it. */
  pinned: boolean;
}

export function clockOutcome(input: {
  /** The new workspace date, already formatted for the workspace locale. */
  movedTo: string;
  /** What the operator asked for — "Jumped forward a week". */
  label: string;
  jobsRun: number;
  jobsFailed: number;
  aftermath: ClockAftermath | null;
}): ClockOutcome {
  const { movedTo, label, jobsRun, jobsFailed, aftermath } = input;
  const ran = `${jobsRun} scheduled ${jobsRun === 1 ? 'job' : 'jobs'} ran${jobsFailed ? `, ${jobsFailed} failed` : ''}`;
  const quote = (message: string) =>
    `${message}${aftermath?.requestId ? ` · ${aftermath.requestId}` : ''}`;

  if (!aftermath) {
    return {
      tone: 'success',
      title: `Workspace time is now ${movedTo}`,
      description: jobsRun ? `${label} — ${ran}.` : `${label} — nothing was due in that window.`,
      pinned: false,
    };
  }
  if (aftermath.status === 401) {
    return {
      tone: 'danger',
      title: `The clock moved to ${movedTo} — and signed you out`,
      description: quote(
        `${ran}, but the session you issued the jump from had expired by the new clock, so every call since has been refused. Sign in again to see what happened.`,
      ),
      pinned: true,
    };
  }
  if (aftermath.status === 429) {
    return {
      tone: 'danger',
      title: `The clock moved to ${movedTo} — the workspace is now rate limited`,
      description: quote(
        `${ran}. ${aftermath.message} Nothing on screen is current until it clears; the banner in the top bar is counting it down.`,
      ),
      pinned: true,
    };
  }
  return {
    tone: 'danger',
    title: `The clock moved to ${movedTo}, but the workspace could not be read back`,
    description: quote(`${ran}. ${aftermath.message}`),
    pinned: true,
  };
}

/** Plain English for the clock offset, used by the "simulated time" chip. */
export function describeOffset(offsetMs: number): string {
  const abs = Math.abs(offsetMs);
  if (abs < 60_000) return 'in step with real time';
  // Rounding the remainder on its own is what produced "180 days 24 hours":
  // round to whole hours first, then split, so the hours can never reach 24.
  const totalHours = Math.round(abs / 3_600_000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const parts: string[] = [];
  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  const span = parts.join(' ') || 'less than an hour';
  return `${span} ${offsetMs > 0 ? 'ahead of' : 'behind'} real time`;
}

/* ============================ route availability ========================== */

/**
 * The set of `METHOD /path` strings the running server actually serves, read
 * from `/v1/system/map`. The shell offers a search source or a create action
 * only when the module behind it is installed, which is why nothing here ever
 * fires a request at a route that would 404.
 */
export interface SystemMapShape {
  modules?: { routes?: string[] }[];
}

export function routeSetFrom(map: SystemMapShape | undefined): Set<string> {
  const set = new Set<string>();
  for (const module of map?.modules ?? []) {
    for (const route of module.routes ?? []) set.add(route.trim());
  }
  return set;
}

export const serves = (routes: Set<string>, method: string, path: string): boolean =>
  routes.has(`${method.toUpperCase()} ${path}`);

/**
 * The first candidate address that some module has actually registered a screen
 * for. Search results and palette records link through this, so a record opens
 * its real page when the module that owns it is installed and degrades to a
 * plain row when it is not.
 */
export function firstRegistered(patterns: string[], candidates: string[]): string | null {
  const registered = new Set(patterns.map(normalizePath));
  for (const candidate of candidates) {
    if (registered.has(normalizePath(candidate))) return candidate;
  }
  return null;
}

/** `company` → `companies`. Object type names are always lower-case singulars. */
export function pluralType(objectType: string): string {
  if (/[^aeiou]y$/.test(objectType)) return objectType.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/.test(objectType)) return objectType + 'es';
  return objectType + 's';
}

/** Candidate detail addresses for a CRM record, most conventional first. */
export const recordRouteCandidates = (objectType: string): string[] => {
  const plural = pluralType(objectType);
  return [
    `/${plural}/:id`,
    `/crm/${plural}/:id`,
    `/records/${objectType}/:id`,
    `/${objectType}/:id`,
  ];
};

export function fillParams(pattern: string, id: string): string {
  return pattern.replace(/:[A-Za-z_]+/g, encodeURIComponent(id));
}

/* ================================ events ================================== */

/** Domain acronyms that must not come back as "Ai" or "Api". */
const ACRONYMS = new Set(['ai', 'api', 'crm', 'sms', 'url', 'id', 'vat', 'mrr', 'arr', 'sla', 'csv', 'pdf']);

/** `credit_grant.expired` → "Credit grant expired". */
export function eventTitle(type: string): string {
  const words = type.replace(/[._-]+/g, ' ').trim().split(/\s+/)
    .map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word))
    .join(' ');
  return words ? words[0].toUpperCase() + words.slice(1) : type;
}

const SUBJECT_KEYS = ['name', 'display_name', 'title', 'number', 'email', 'summary', 'label'];

/** The most human thing in an event payload — a name if there is one anywhere. */
export function eventSubject(data: unknown, depth = 0): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  for (const key of SUBJECT_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() && value.length <= 80) return value.trim();
  }
  if (depth >= 2) return null;
  for (const value of Object.values(record)) {
    const nested = eventSubject(value, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/* ============================== setup checks ============================== */

export interface SetupStep {
  id: string;
  label: string;
  /** What being done means, and what to do when it is not. */
  detail: string;
  done: boolean;
  to?: string;
}

/** Ordered so the unfinished work rises to the top without reshuffling on hover. */
export function orderSetup(steps: SetupStep[]): SetupStep[] {
  return [...steps].sort((a, b) => Number(a.done) - Number(b.done));
}

export const setupProgress = (steps: SetupStep[]): number =>
  steps.length ? steps.filter((s) => s.done).length / steps.length : 0;

/* ================================ avatars ================================= */

/**
 * A profile image is only ever an image. The platform also stores non-URL
 * markers such as `color:#5B4BE1` to mean "no photo, use this tone" — handing
 * one of those to an `<img src>` is what paints a broken-image icon in the top
 * bar, so anything that is not a real image address is dropped and the avatar
 * falls back to initials.
 */
export function avatarSrc(avatarUrl: string | null | undefined): string | undefined {
  if (!avatarUrl) return undefined;
  return /^(https?:\/\/|data:image\/|\/)/.test(avatarUrl) ? avatarUrl : undefined;
}

/* ============================== greetings ================================= */

/** Workspace-local hour, so the greeting matches the operator's own morning. */
export function greetingFor(now: number, timeZone: string): string {
  let hour = new Date(now).getHours();
  try {
    hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone }).format(now));
  } catch { /* an unknown zone falls back to the runtime's own */ }
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
