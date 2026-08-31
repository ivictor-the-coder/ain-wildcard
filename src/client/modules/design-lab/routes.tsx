/**
 * The living style guide at /design.
 *
 * Everything on this page is rendered by the real design system — no mock CSS,
 * no screenshots. The sample dataset below is generated deterministically in
 * the browser so that every figure, chart and total on the page is computed
 * from data that actually exists rather than typed in by hand.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NavItem, RouteDef } from '../../kernel/registry-types';
import { useSession } from '../../kernel/session';
import { useRouter } from '../../kernel/router';
import {
  Accordion, Avatar, AvatarGroup, Badge, Banner, BarChart, Breadcrumbs, Button, ButtonGroup,
  AlertTriangleIcon, ArrowLeftIcon, ArrowRightIcon, CheckCircleIcon, ChevronDownIcon, CreditCardIcon, FilterXIcon, XCircleIcon,
  Calendar, Card, Checkbox, CodeInput, Combobox, CommandList, ConfirmDialog, CopyField, DataTable,
  DatePicker, DateRangePicker, Delta, DescriptionList, Divider, DonutChart, Drawer, EmptyState,
  ErrorBoundary, ErrorState, Field, FunnelChart, Grid, Heatmap, Icons, IconButton, ICON_NAMES, Inline, Input,
  Kbd, KeyValue, LineChart, Menu, MenuButton, Meter, MetricTile, Modal, MoneyInput, NumberInput,
  Pagination, Panel, Pill, PillGroup, Popover, ProgressBar, Radio, RadioGroup, ScrollArea,
  RANGE_PRESETS, SearchInput, Section, SegmentedControl, Select, Skeleton, SkeletonText, Slider, Sparkline,
  Spinner, Split, Stack, Stat, StatusBadge, StatusDot, Steps, Switch, TabPanel, Tabs, Tag,
  TagInput, Textarea, Timeline, ToastProvider, Toolbar, Tooltip, WaterfallChart,
  AreaChart, Collapsible, DismissibleBanner, contrastGrade, contrastRatio, cx, decodeTableState, describeFilter,
  encodeTableState, formatMoney, formatNumber, formatPercent, humanize,
  toneForStatus, useCopyToClipboard, useFormat, useRovingIndex, useToast, vizColor,
  type ChartSeries, type CommandEntry, type DataTableColumn, type DateRange, type MenuSection,
  type TableState,
} from '../../design';
import * as DesignSystem from '../../design';
import { DAY, monthKey, startOfMonth } from '../../../shared/time';
import '../../design/styleguide.css';

/* ========================================================================== *
 * Sample dataset — deterministic, so the page renders identically every load.
 * ========================================================================== */

/** mulberry32: tiny, fast, and stable across engines. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMPANIES = [
  'Halden Metalworks', 'Kestrel Logistics', 'Orbit Foods', 'Vantive Systems', 'Brightpath Rail',
  'Norrland Paper', 'Cedarline Motors', 'Atlas Cold Chain', 'Peregrine Mining', 'Sundial Energy',
  'Ferrum Castings', 'Blue Harbour Ports', 'Corvus Robotics', 'Anvil Tooling', 'Marlow Textiles',
  'Delta Grain', 'Ridgeway Cement', 'Lantern Pharma', 'Quarry & Sons', 'Tessellate Glass',
  'Nordhavn Shipping', 'Pike Valley Dairy', 'Ironwood Timber', 'Saltmarsh Chemical', 'Verdant Agri',
  'Copperfield Wire', 'Highfield Plastics', 'Aurora Packaging', 'Bastion Steel', 'Lumen Optics',
];
const OWNERS = [
  { id: 'u_dana', name: 'Dana Whitlock' }, { id: 'u_marcus', name: 'Marcus Oyelaran' },
  { id: 'u_priya', name: 'Priya Raghavan' }, { id: 'u_sofia', name: 'Sofia Lindqvist' },
  { id: 'u_tom', name: 'Tom Bergeron' }, { id: 'u_nina', name: 'Nina Kovač' },
];
const PLANS = ['Telemetry Core', 'Telemetry Pro', 'Fleet Enterprise'];
/** Rate card, in minor units. The invoice summary below re-derives its lines
 *  from these exact numbers, so the total always reconciles with the row. */
const PLAN_FLOOR: Record<string, number> = { 'Telemetry Core': 24000, 'Telemetry Pro': 78000, 'Fleet Enterprise': 240000 };
const RATE_PER_SEAT = 1900;
const RATE_PER_UNIT = 27;
const TAX_RATE_BPS = 825;
const STATUSES = ['paid', 'open', 'past_due', 'draft', 'uncollectible'] as const;

interface Invoice {
  id: string;
  number: string;
  company: string;
  owner: { id: string; name: string };
  plan: string;
  status: (typeof STATUSES)[number];
  amount: number;
  seats: number;
  usageUnits: number;
  issuedAt: number;
  dueAt: number;
}

function buildInvoices(now: number, count = 1240): Invoice[] {
  const random = rng(20240517);
  const rows: Invoice[] = [];
  for (let i = 0; i < count; i++) {
    const company = COMPANIES[Math.floor(random() * COMPANIES.length)];
    const plan = PLANS[Math.floor(random() * PLANS.length)];
    const seats = 4 + Math.floor(random() * 140);
    const usageUnits = Math.floor(random() * 9_400) + 120;
    const amount = PLAN_FLOOR[plan] + seats * RATE_PER_SEAT + usageUnits * RATE_PER_UNIT;
    const roll = random();
    const status: Invoice['status'] = roll > 0.24 ? 'paid' : roll > 0.13 ? 'open' : roll > 0.07 ? 'past_due' : roll > 0.03 ? 'draft' : 'uncollectible';
    const issuedAt = now - Math.floor(random() * 360) * DAY;
    rows.push({
      id: `in_${(1000 + i).toString(36)}`,
      number: `INV-${(2481 + i).toString().padStart(5, '0')}`,
      company,
      owner: OWNERS[Math.floor(random() * OWNERS.length)],
      plan,
      status,
      amount,
      seats,
      usageUnits,
      issuedAt,
      dueAt: issuedAt + 30 * DAY,
    });
  }
  return rows.sort((a, b) => b.issuedAt - a.issuedAt);
}

interface InvoiceLine { label: string; detail: string; amount: number }

interface Derived {
  invoices: Invoice[];
  months: string[];
  monthLabels: string[];
  billedByPlan: ChartSeries[];
  monthlyTotals: number[];
  collectedSeries: number[];
  openSeries: number[];
  totalBilled: number;
  collected: number;
  openAr: number;
  pastDue: number;
  collectionRate: number;
  /** Period-over-period changes, computed from the last two complete months. */
  deltas: { billed: number | null; collected: number | null; open: number | null; usage: number | null };
  currentMonth: { billed: number; collected: number; open: number; usage: number };
  planTotals: { id: string; label: string; value: number }[];
  movement: { label: string; value: number; kind?: 'delta' | 'total' }[];
  funnel: { label: string; value: number }[];
  heat: { rows: string[]; columns: string[]; values: number[][] };
  usageByMonth: number[];
  topAccounts: { company: string; billed: number; invoices: number; usage: number; owner: string; plan: string }[];
  /** One real invoice, expanded into the lines the summary card prints. */
  featured: { invoice: Invoice; lines: InvoiceLine[]; subtotal: number; tax: number; total: number; includedUnits: number };
}

function derive(invoices: Invoice[], now: number): Derived {
  const monthStart = startOfMonth(now);
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(monthStart);
    months.push(monthKey(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)));
  }
  const monthLabels = months.map((m) => new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(Date.parse(`${m}-01T00:00:00Z`)));
  const index = new Map(months.map((m, i) => [m, i]));

  const byPlan = new Map(PLANS.map((p) => [p, new Array(months.length).fill(0)]));
  const collectedSeries = new Array(months.length).fill(0);
  const openSeries = new Array(months.length).fill(0);
  const usageByMonth = new Array(months.length).fill(0);

  let totalBilled = 0;
  let collected = 0;
  let openAr = 0;
  let pastDue = 0;
  const planTotals = new Map(PLANS.map((p) => [p, 0]));
  const accounts = new Map<string, { billed: number; invoices: number; usage: number; owners: Map<string, number>; plans: Map<string, number> }>();
  const accountMonthly = new Map<string, number[]>();
  const heatValues = Array.from({ length: 7 }, () => new Array(months.length).fill(0));

  for (const invoice of invoices) {
    if (invoice.status === 'draft') continue;
    totalBilled += invoice.amount;
    planTotals.set(invoice.plan, (planTotals.get(invoice.plan) ?? 0) + invoice.amount);
    if (invoice.status === 'paid') collected += invoice.amount;
    if (invoice.status === 'open') openAr += invoice.amount;
    if (invoice.status === 'past_due') { openAr += invoice.amount; pastDue += invoice.amount; }

    const account = accounts.get(invoice.company) ?? { billed: 0, invoices: 0, usage: 0, owners: new Map(), plans: new Map() };
    account.billed += invoice.amount;
    account.invoices += 1;
    account.usage += invoice.usageUnits;
    account.owners.set(invoice.owner.name, (account.owners.get(invoice.owner.name) ?? 0) + 1);
    account.plans.set(invoice.plan, (account.plans.get(invoice.plan) ?? 0) + invoice.amount);
    accounts.set(invoice.company, account);

    const key = monthKey(invoice.issuedAt);
    const i = index.get(key);
    if (i === undefined) continue;
    byPlan.get(invoice.plan)![i] += invoice.amount;
    usageByMonth[i] += invoice.usageUnits;
    if (invoice.status === 'paid') collectedSeries[i] += invoice.amount;
    else openSeries[i] += invoice.amount;
    heatValues[new Date(invoice.issuedAt).getUTCDay()][i] += 1;

    const series = accountMonthly.get(invoice.company) ?? new Array(months.length).fill(0);
    series[i] += invoice.amount;
    accountMonthly.set(invoice.company, series);
  }

  const billedByPlan: ChartSeries[] = PLANS.map((plan, i) => ({
    id: plan, label: plan, values: byPlan.get(plan)!, color: vizColor(i),
  }));
  const monthlyTotals = months.map((_, i) => PLANS.reduce((sum, p) => sum + byPlan.get(p)![i], 0));

  // Movement between the two most recent complete months, account by account —
  // the same decomposition a finance team reconciles MRR with.
  const current = months.length - 2;
  const previous = months.length - 3;
  let newBusiness = 0;
  let expansion = 0;
  let contraction = 0;
  let churn = 0;
  for (const series of accountMonthly.values()) {
    const before = series[previous] ?? 0;
    const after = series[current] ?? 0;
    if (before === 0 && after > 0) newBusiness += after;
    else if (before > 0 && after === 0) churn -= before;
    else if (after > before) expansion += after - before;
    else if (after < before) contraction -= before - after;
  }
  const opening = monthlyTotals[previous] ?? 0;
  const closing = monthlyTotals[current] ?? 0;
  const movement: Derived['movement'] = [
    { label: monthLabels[previous] ?? 'Opening', value: opening, kind: 'total' },
    { label: 'New', value: newBusiness },
    { label: 'Expansion', value: expansion },
    { label: 'Contraction', value: contraction },
    { label: 'Churn', value: churn },
    { label: monthLabels[current] ?? 'Closing', value: closing, kind: 'total' },
  ];

  const funnel = [
    { label: 'Invoices issued', value: invoices.length },
    { label: 'Finalised', value: invoices.filter((i) => i.status !== 'draft').length },
    { label: 'Collectible', value: invoices.filter((i) => i.status !== 'draft' && i.status !== 'uncollectible').length },
    { label: 'Paid', value: invoices.filter((i) => i.status === 'paid').length },
  ];

  const topAccounts = [...accounts.entries()]
    .map(([company, v]) => ({
      company,
      billed: v.billed,
      invoices: v.invoices,
      usage: v.usage,
      owner: [...v.owners.entries()].sort((a, b) => b[1] - a[1])[0][0],
      plan: [...v.plans.entries()].sort((a, b) => b[1] - a[1])[0][0],
    }))
    .sort((a, b) => b.billed - a.billed)
    .slice(0, 6);

  // The most valuable overdue invoice — the one a collections team opens first.
  const featuredInvoice = invoices
    .filter((i) => i.status === 'past_due')
    .sort((a, b) => b.amount - a.amount)[0] ?? invoices[0];
  const lines: InvoiceLine[] = [
    { label: `${featuredInvoice.plan} platform fee`, detail: 'Monthly', amount: PLAN_FLOOR[featuredInvoice.plan] },
    { label: 'Seat licences', detail: `${formatNumber(featuredInvoice.seats)} × ${formatMoney(RATE_PER_SEAT, { currency: 'usd' })}`, amount: featuredInvoice.seats * RATE_PER_SEAT },
    { label: 'Metered telemetry', detail: `${formatNumber(featuredInvoice.usageUnits)} units × ${formatMoney(RATE_PER_UNIT, { currency: 'usd' })}`, amount: featuredInvoice.usageUnits * RATE_PER_UNIT },
  ];
  const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
  const tax = Math.round((subtotal * TAX_RATE_BPS) / 10_000);

  const pct = (a: number, b: number) => (b ? (a - b) / b : null);

  return {
    invoices, months, monthLabels, billedByPlan, monthlyTotals, collectedSeries, openSeries,
    totalBilled, collected, openAr, pastDue,
    collectionRate: totalBilled ? collected / totalBilled : 0,
    deltas: {
      billed: pct(monthlyTotals[current] ?? 0, monthlyTotals[previous] ?? 0),
      collected: pct(collectedSeries[current] ?? 0, collectedSeries[previous] ?? 0),
      open: pct(openSeries[current] ?? 0, openSeries[previous] ?? 0),
      usage: pct(usageByMonth[current] ?? 0, usageByMonth[previous] ?? 0),
    },
    currentMonth: {
      billed: monthlyTotals[current] ?? 0,
      collected: collectedSeries[current] ?? 0,
      open: openSeries[current] ?? 0,
      usage: usageByMonth[current] ?? 0,
    },
    planTotals: PLANS.map((p) => ({ id: p, label: p, value: planTotals.get(p) ?? 0 })).sort((a, b) => b.value - a.value),
    movement, funnel,
    heat: { rows: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], columns: monthLabels, values: heatValues },
    usageByMonth,
    topAccounts,
    featured: { invoice: featuredInvoice, lines, subtotal, tax, total: subtotal + tax, includedUnits: 60_000 },
  };
}

/* ========================================================================== *
 * Documentation chrome
 * ========================================================================== */

const CHART_TYPES = ['Line', 'Area', 'Bar', 'Sparkline', 'Donut', 'Funnel', 'Waterfall', 'Heatmap'];

const SECTIONS: { id: string; label: string; group: string }[] = [
  { id: 'foundations', label: 'Foundations', group: 'Design language' },
  { id: 'typography', label: 'Typography', group: 'Design language' },
  { id: 'space', label: 'Space & elevation', group: 'Design language' },
  { id: 'icons', label: 'Icons', group: 'Design language' },
  { id: 'buttons', label: 'Buttons', group: 'Components' },
  { id: 'toggles', label: 'Selection controls', group: 'Components' },
  { id: 'fields', label: 'Fields', group: 'Components' },
  { id: 'pickers', label: 'Pickers', group: 'Components' },
  { id: 'display', label: 'Data display', group: 'Components' },
  { id: 'table', label: 'Data table', group: 'Components' },
  { id: 'charts', label: 'Charts', group: 'Components' },
  { id: 'overlays', label: 'Overlays', group: 'Components' },
  { id: 'feedback', label: 'Feedback', group: 'Components' },
  { id: 'navigation', label: 'Navigation', group: 'Components' },
  { id: 'layout', label: 'Layout', group: 'Components' },
];

function useThemeControls() {
  let session: ReturnType<typeof useSession> | null = null;
  try { session = useSession(); } catch { session = null; }
  const fallbackTheme = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  return {
    theme: session?.resolvedTheme ?? fallbackTheme,
    setTheme: (t: 'light' | 'dark') => {
      session?.setTheme(t);
      if (!session && typeof document !== 'undefined') document.documentElement.setAttribute('data-theme', t);
    },
    density: session?.density ?? 'comfortable',
    setDensity: (d: 'comfortable' | 'compact') => {
      session?.setDensity(d);
      if (!session && typeof document !== 'undefined') document.documentElement.setAttribute('data-density', d);
    },
  };
}

/* ========================================================================== *
 * Documentation chrome. A style guide that only shows pictures makes an
 * engineer read the source to learn a prop exists, so every section carries its
 * import line, every demo carries the code that produced it, and every
 * component carries a props table.
 * ========================================================================== */

function CodeBlock({ code, label = 'Usage' }: { code: string; label?: string }) {
  const [copied, copy] = useCopyToClipboard();
  return (
    <figure className="sg__codewrap">
      <figcaption className="sg__codehead">
        <span className="sg__codelabel">{label}</span>
        <button type="button" className="sg__copy" onClick={() => void copy(code)}>
          {copied ? <CheckCircleIcon size={13} /> : <Icons.copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      <pre className="sg__code"><code>{code}</code></pre>
    </figure>
  );
}

/** Kept mounted when closed so the markup is searchable and linkable. */
function Disclosure({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useMemo(() => `sg-disc-${Math.random().toString(36).slice(2, 8)}`, []);
  return (
    <div className={cx('sg__disc', open && 'is-open')}>
      <button type="button" className="sg__disctrigger" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <ChevronDownIcon size={14} className="sg__discchev" />
        {title}
        {count !== undefined && <span className="sg__disccount">{count}</span>}
      </button>
      <div className="sg__discpanel" id={id} hidden={!open}>{children}</div>
    </div>
  );
}

interface PropRow { name: string; type: string; def?: string; required?: boolean; note: string }
interface ApiSpec { name: string; summary: string; rows: PropRow[] }

function PropsTable({ specs }: { specs: ApiSpec[] }) {
  return (
    <div className="sg__api">
      {specs.map((spec) => (
        <Disclosure key={spec.name} title={`${spec.name} props`} count={spec.rows.length}>
          <p className="sg__apisummary">{spec.summary}</p>
          <div className="sg__apiscroll">
            <table className="sg__apitable">
              <thead>
                <tr><th scope="col">Prop</th><th scope="col">Type</th><th scope="col">Default</th><th scope="col">What it does</th></tr>
              </thead>
              <tbody>
                {spec.rows.map((row) => (
                  <tr key={row.name}>
                    <th scope="row">
                      <code className="sg__mono">{row.name}</code>
                      {row.required && <span className="sg__req" title="Required">required</span>}
                    </th>
                    <td><code className="sg__mono sg__monotype">{row.type}</code></td>
                    <td>{row.def ? <code className="sg__mono">{row.def}</code> : <span className="sg__dash">—</span>}</td>
                    <td>{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Disclosure>
      ))}
    </div>
  );
}

function Demo({ title, note, children, stage = 'default', code }: {
  title: string; note?: string; children: React.ReactNode; stage?: 'default' | 'tight' | 'flush' | 'sunken'; code?: string;
}) {
  return (
    <div className="sg__demo">
      <div className="sg__demohead">
        <span className="sg__demotitle">{title}</span>
        {note && <span className="sg__demonote">{note}</span>}
      </div>
      <div className={cx('sg__stage', stage !== 'default' && `sg__stage--${stage}`)}>{children}</div>
      {code && <CodeBlock code={code} />}
    </div>
  );
}

function Doc({ id, title, description, imports, api, children }: {
  id: string; title: string; description: string; imports?: string; api?: ApiSpec[]; children: React.ReactNode;
}) {
  return (
    <section id={id} className="sg__section" aria-labelledby={`${id}-title`}>
      <div className="sg__sectionhead">
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <h2 className="sg__sectiontitle" id={`${id}-title`}>{title}</h2>
          <p className="sg__sectiondesc">{description}</p>
        </div>
      </div>
      {imports && <CodeBlock label="Import" code={`import { ${imports} } from '@/client/design';`} />}
      <ErrorBoundary
        title={`The ${title.toLowerCase()} demos stopped rendering`}
        message="Every other section on this page is still live — this one alone is isolated. Reset it to mount the demos again."
        retryLabel="Reset this section"
      >
        {children}
      </ErrorBoundary>
      {api && api.length > 0 && <PropsTable specs={api} />}
    </section>
  );
}

/* -------------------------------------------------------------------------- *
 * The public API of every component on this page, written by hand against the
 * exported interfaces so it says what the props are *for*, not just their type.
 * -------------------------------------------------------------------------- */

const API: Record<string, ApiSpec[]> = {
  buttons: [
    {
      name: 'Button',
      summary: 'The one button. Everything else here is a preset of it; there is no second implementation.',
      rows: [
        { name: 'variant', type: "'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost' | 'link'", def: "'secondary'", note: 'One primary per view. danger is reserved for actions that destroy or bill.' },
        { name: 'size', type: "'sm' | 'md' | 'lg'", def: "'md'", note: 'sm in toolbars and table rows, md everywhere else, lg only in empty states.' },
        { name: 'loading', type: 'boolean', note: 'Swaps the left icon for a spinner, keeps the width, and sets aria-busy.' },
        { name: 'iconLeft / iconRight', type: 'ReactNode', note: 'A 14–16px icon. Never both plus a long label.' },
        { name: 'fullWidth', type: 'boolean', note: 'Only inside dialogs, side panels and empty states.' },
        { name: 'onClick', type: '(e: MouseEvent) => void', note: 'Standard button semantics — Enter and Space are free.' },
      ],
    },
    {
      name: 'IconButton',
      summary: 'An icon-only control. `label` is mandatory because it becomes the accessible name.',
      rows: [
        { name: 'icon', type: 'ReactNode', required: true, note: 'The glyph, sized 14–18px.' },
        { name: 'label', type: 'string', required: true, note: 'Accessible name and the tooltip text.' },
        { name: 'variant', type: "'ghost' | 'secondary' | 'danger'", def: "'ghost'", note: 'Ghost in dense rows, secondary when it stands alone.' },
        { name: 'size', type: "'sm' | 'md' | 'lg'", def: "'md'", note: 'Hit area stays at least 26px square at sm.' },
      ],
    },
    {
      name: 'SegmentedControl',
      summary: 'Two to four mutually exclusive options with one always chosen. Arrow keys move and select.',
      rows: [
        { name: 'value', type: 'T extends string', required: true, note: 'Controlled — there is no internal state to drift.' },
        { name: 'onChange', type: '(value: T) => void', required: true, note: 'Fires on click and on arrow-key movement.' },
        { name: 'options', type: '{ value, label, title?, disabled? }[]', required: true, note: 'title becomes the tooltip when the label is an icon.' },
        { name: 'aria-label', type: 'string', required: true, note: 'Names the radio group for screen readers.' },
      ],
    },
  ],
  fields: [
    {
      name: 'Field',
      summary: 'Label, hint, error and required/optional marker, wired to the control with the right ids.',
      rows: [
        { name: 'label', type: 'ReactNode', required: true, note: 'Rendered as a real <label> bound to the child by id.' },
        { name: 'hint', type: 'ReactNode', note: 'Persistent help. Replaced by error when the field is invalid.' },
        { name: 'error', type: 'string | null', note: 'Sets aria-invalid and aria-describedby on the control below.' },
        { name: 'required / optional', type: 'boolean', note: 'Marks the field; pick one convention per form and stay with it.' },
        { name: 'children', type: '(props) => ReactNode | ReactNode', required: true, note: 'Render-prop form receives id, aria-describedby and invalid.' },
      ],
    },
    {
      name: 'MoneyInput',
      summary: 'Edits integer minor units. There is no float in this component at any point.',
      rows: [
        { name: 'value', type: 'number | null', required: true, note: 'Minor units — 124800 is $1,248.00.' },
        { name: 'onChange', type: '(minor: number | null) => void', required: true, note: 'Emits minor units; null when the field is cleared.' },
        { name: 'currency', type: 'Currency', def: 'workspace currency', note: 'Drives the symbol, the decimal places and zero-decimal currencies.' },
        { name: 'allowNegative', type: 'boolean', note: 'For credits and refunds.' },
      ],
    },
    {
      name: 'Combobox',
      summary: 'Type-ahead select. Single or multiple, local options or an async source, with create-on-the-fly.',
      rows: [
        { name: 'value', type: 'string | string[]', required: true, note: 'An array when multiple is set.' },
        { name: 'options', type: 'ComboOption[]', note: 'Local list. Omit when using onSearch.' },
        { name: 'onSearch', type: '(q: string) => Promise<ComboOption[]>', note: 'Debounced 200ms; the spinner shows while it is in flight.' },
        { name: 'multiple', type: 'boolean', note: 'Renders removable tags and keeps the menu open after each pick.' },
        { name: 'onCreate', type: '(label: string) => void', note: 'Adds a "Create …" row when nothing matches.' },
      ],
    },
  ],
  pickers: [
    {
      name: 'DateRangePicker',
      summary: 'Two months, named presets and a keyboard grid. All arithmetic is UTC, matching shared/time.',
      rows: [
        { name: 'value', type: '{ start: number | null; end: number | null }', required: true, note: 'Epoch milliseconds at UTC midnight.' },
        { name: 'onChange', type: '(range: DateRange) => void', required: true, note: 'Fires once, when the second endpoint is picked.' },
        { name: 'presets', type: 'RangePreset[]', def: 'RANGE_PRESETS', note: 'Today, last 7/30/90, MTD, last month, QTD, YTD. Pass [] to hide.' },
        { name: 'min / max', type: 'number', note: 'Days outside the bounds are disabled, not hidden.' },
      ],
    },
  ],
  table: [
    {
      name: 'DataTable',
      summary: 'The grid every list view is built from: virtualised, filterable, selectable and serialisable to a URL.',
      rows: [
        { name: 'rows / columns / getRowId', type: 'T[] / DataTableColumn<T>[] / (row) => string', required: true, note: 'Ids must be stable — selection and the virtual window both key off them.' },
        { name: 'value', type: 'TableState', note: 'Controlled { query, sort, filters }. Pair with encodeTableState to put the view in the URL.' },
        { name: 'onChange', type: '(state: TableState) => void', note: 'Fires on every search keystroke, sort click and filter edit.' },
        { name: 'selected / onSelectionChange', type: 'string[] / (ids) => void', note: 'Controlled selection. Survives filtering — see bulkActions.' },
        { name: 'bulkActions', type: '(ids: string[]) => ReactNode', note: 'Receives only the selected rows the active filter still shows, unless the operator opts into the hidden ones.' },
        { name: 'virtualiseAfter', type: 'number', def: '120', note: 'Above this row count only the visible window is in the DOM.' },
        { name: 'error / onRetry', type: '{ message, code, requestId } / () => void', note: 'Renders the error state with the request id support will ask for.' },
        { name: 'stickyFooter', type: 'boolean', def: 'true', note: 'Totals recompute over the filtered set, not the raw rows.' },
      ],
    },
    {
      name: 'DataTableColumn',
      summary: 'One column. `accessor` is the value the model sorts, filters and searches; `cell` is what the user sees.',
      rows: [
        { name: 'accessor', type: '(row: T) => CellValue', note: 'Keep it primitive. Blanks always sort to the bottom.' },
        { name: 'cell', type: '(row: T) => ReactNode', note: 'Free-form rendering; falls back to the accessor value.' },
        { name: 'filter', type: "'text' | 'set' | 'number' | 'date'", note: 'Adds the column to the + Filter menu with operators typed to the kind.' },
        { name: 'filterOptionLabel', type: '(value: string) => string', def: 'humanize for enums', note: 'Makes the filter list read the way the cells read.' },
        { name: 'total', type: '(rows: T[], sum: number) => ReactNode', note: 'Sticky footer cell. sum is over the filtered rows.' },
        { name: 'pinned', type: 'boolean', note: 'Sticks the column to the inline start under horizontal scroll.' },
      ],
    },
  ],
  overlays: [
    {
      name: 'Modal',
      summary: 'Focus trapped, Escape peels exactly one layer, body scroll locked, focus restored to the trigger.',
      rows: [
        { name: 'open / onClose', type: 'boolean / () => void', required: true, note: 'Fully controlled; the component owns no open state.' },
        { name: 'size', type: "'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'full'", def: "'md'", note: 'md fits a form; full is for editors.' },
        { name: 'dismissable', type: 'boolean', def: 'true', note: 'false blocks Escape and backdrop clicks — irreversible steps only.' },
        { name: 'footerBetween', type: 'boolean', note: 'Pushes the first footer node to the inline start, for a destructive action.' },
        { name: 'initialFocus', type: 'RefObject<HTMLElement>', note: 'Overrides the default (first focusable inside the dialog).' },
      ],
    },
    {
      name: 'Menu / MenuButton',
      summary: 'Arrow keys walk the rows, typed letters jump, Enter fires, Escape peels one layer. The highlighted row is the focused element, so what a screen reader announces and what the highlight shows can never drift apart.',
      rows: [
        { name: 'sections', type: 'MenuSection[]', required: true, note: 'Grouped rows; a row carrying items of its own opens a submenu.' },
        { name: 'anchor', type: 'RefObject<HTMLElement>', required: true, note: 'The trigger. Focus returns to it on Escape, Tab or a selection.' },
        { name: 'ariaLabel', type: 'string', required: true, note: 'Names the role="menu" container.' },
        { name: 'item.onSelect', type: '() => void', note: 'Fires on click or Enter, then the whole stack closes.' },
        { name: 'item.searchText', type: 'string', note: 'What typeahead matches when the label is a node. Folded, so "kovac" finds "Kovač".' },
        { name: 'item.disabled', type: 'boolean', note: 'Skipped by the arrows and by typeahead, not just dimmed.' },
      ],
    },
    {
      name: 'useToast()',
      summary: 'Imperative feedback for things that already happened. Never for validation — that belongs on the field.',
      rows: [
        { name: 'toast.success', type: '(title, body?, opts?) => string', note: 'Returns the id so you can dismiss it early.' },
        { name: 'toast.error', type: '(title, body?, opts?) => string', note: 'Sticky by default; errors should not vanish before they are read.' },
        { name: 'opts.action', type: '{ label, onClick }', note: 'One action, usually Undo.' },
        { name: 'opts.duration', type: 'number', def: '5200', note: 'Milliseconds. 0 keeps it until dismissed.' },
      ],
    },
  ],
  feedback: [
    {
      name: 'ErrorState',
      summary: 'What a failed request looks like. The request id is printed verbatim so it can be quoted to support.',
      rows: [
        { name: 'message', type: 'ReactNode', note: 'Say what did not happen and whether anything changed.' },
        { name: 'code', type: 'string | null', note: 'The API type · code pair, shown in monospace.' },
        { name: 'requestId', type: 'string | null', note: 'Rendered with a copy affordance.' },
        { name: 'action', type: 'ReactNode', note: 'Usually a Try again button wired to the same query.' },
      ],
    },
    {
      name: 'EmptyState',
      summary: 'Says what will fill the space and how to make that happen. Never "No data available".',
      rows: [
        { name: 'title', type: 'ReactNode', required: true, note: 'A sentence about this list, not a generic label.' },
        { name: 'body', type: 'ReactNode', note: 'The concrete next step, with real names and dates where you have them.' },
        { name: 'illustration', type: 'ReactNode | null', note: 'null removes the art entirely — right inside a table.' },
        { name: 'action / secondaryAction', type: 'ReactNode', note: 'Primary creates; secondary imports or explains.' },
      ],
    },
  ],
  navigation: [
    {
      name: 'Tabs',
      summary: 'Arrow keys move and select, per WAI-ARIA. `role="navigation"` when the tabs are links, not panels.',
      rows: [
        { name: 'tabs', type: 'TabDef<T>[]', required: true, note: 'count renders the pill; href makes it a link tab.' },
        { name: 'value / onChange', type: 'T / (id: T) => void', required: true, note: 'Controlled.' },
        { name: 'variant', type: "'underline' | 'pill'", def: "'underline'", note: 'Underline for page-level, pill for filtering a list.' },
        { name: 'aria-label', type: 'string', required: true, note: 'Names the tab list.' },
      ],
    },
    {
      name: 'Pagination',
      summary: 'Windowed page numbers with … for the gaps, plus "1–25 of 312" when you pass the totals.',
      rows: [
        { name: 'page / pageCount', type: 'number', required: true, note: '1-based.' },
        { name: 'onChange', type: '(page: number) => void', required: true, note: 'Also fired by the previous/next buttons.' },
        { name: 'total / pageSize', type: 'number', note: 'Both are needed for the range readout.' },
      ],
    },
  ],
  charts: [
    {
      name: 'LineChart / AreaChart / BarChart',
      summary: 'Same contract across the kit: series in, SVG out, with a visually-hidden data table for screen readers.',
      rows: [
        { name: 'series', type: 'ChartSeries[]', required: true, note: '{ id, label, values, color? }. Colour defaults to the --viz ramp in order.' },
        { name: 'labels', type: 'string[]', required: true, note: 'One per point; also the row headers of the hidden table.' },
        { name: 'formatValue', type: '(v: number) => string', note: 'Axis, tooltip and the accessible table all use it, so they can never disagree.' },
        { name: 'stacked', type: 'boolean', note: 'Area and bar only. Totals are computed, not assumed.' },
        { name: 'description', type: 'string', note: 'Becomes the chart’s aria-describedby summary.' },
      ],
    },
  ],
  layout: [
    {
      name: 'Page',
      summary: 'The frame every route uses: eyebrow, title, badge, subtitle, breadcrumbs, actions and a tab strip.',
      rows: [
        { name: 'title', type: 'ReactNode', required: true, note: 'The object or the list, never the verb.' },
        { name: 'actions', type: 'ReactNode', note: 'Right-aligned; at most one primary button.' },
        { name: 'tabs', type: 'ReactNode', note: 'Rendered flush under the header so it scrolls as one unit.' },
        { name: 'width', type: "'narrow' | 'default' | 'wide'", def: "'default'", note: 'narrow for forms, wide for grids.' },
        { name: 'flush', type: 'boolean', note: 'Removes body padding for full-bleed surfaces such as an inbox.' },
      ],
    },
    {
      name: 'Card',
      summary: 'A titled surface. `interactive` renders a real button so the whole card is keyboard-reachable.',
      rows: [
        { name: 'title / description / actions', type: 'ReactNode', note: 'Together they make the card header.' },
        { name: 'variant', type: "'default' | 'flat' | 'raised' | 'ghost' | 'sunken'", def: "'default'", note: 'raised only when the card floats above the page.' },
        { name: 'padding', type: "'default' | 'tight' | 'none'", def: "'default'", note: 'none when the card holds a table.' },
        { name: 'interactive / selected', type: 'boolean', note: 'Adds hover, focus ring and a selected border.' },
      ],
    },
  ],
};

/* ========================================================================== *
 * Sections
 * ========================================================================== */

const SURFACE_TOKENS = [
  ['--bg-app', 'App background'], ['--bg-surface', 'Surface'], ['--bg-surface-raised', 'Raised surface'],
  ['--bg-sunken', 'Sunken'], ['--bg-hover', 'Hover'], ['--bg-active', 'Active'],
  ['--bg-selected', 'Selected'], ['--bg-inverse', 'Inverse'],
];
const TEXT_TOKENS = [
  ['--text-primary', 'Primary'], ['--text-secondary', 'Secondary'], ['--text-tertiary', 'Tertiary'],
  ['--text-placeholder', 'Placeholder'], ['--text-brand', 'Brand'], ['--text-link', 'Link'],
  ['--text-success', 'Success'], ['--text-warning', 'Warning'], ['--text-danger', 'Danger'],
  ['--text-info', 'Info'], ['--text-teal', 'Teal'], ['--text-purple', 'Purple'], ['--text-pink', 'Pink'],
];

/** The resting surfaces text is allowed to sit on. Contrast is asserted against
 *  every one of them, in both themes, by tests/design.test.ts. */
const CONTRAST_SURFACES: [string, string][] = [
  ['--bg-surface', 'Card'], ['--bg-app', 'Page'], ['--bg-subtle', 'Subtle'],
  ['--bg-sunken', 'Sunken'], ['--bg-surface-raised', 'Raised'], ['--bg-nav', 'Nav'],
];

interface ContrastRow { token: string; name: string; color: string; worst: { ratio: number; surface: string } }

/**
 * Measures the guarantee instead of asserting it. Probe nodes are painted with
 * the real tokens and read back through getComputedStyle, so what you see below
 * is the browser's own resolved colour — not a number typed into this file.
 */
function ContrastAudit({ theme }: { theme: string }) {
  const probes = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<ContrastRow[]>([]);

  useEffect(() => {
    const root = probes.current;
    if (!root) return;
    const read = (selector: string, prop: 'color' | 'backgroundColor'): string => {
      const el = root.querySelector<HTMLElement>(selector);
      return el ? getComputedStyle(el)[prop] : '';
    };
    const surfaces = CONTRAST_SURFACES.map(([token, label]) => ({ label, color: read(`[data-bg="${token}"]`, 'backgroundColor') }));
    setRows(TEXT_TOKENS.map(([token, name]) => {
      const color = read(`[data-fg="${token}"]`, 'color');
      let worst = { ratio: Number.POSITIVE_INFINITY, surface: '' };
      for (const surface of surfaces) {
        const ratio = contrastRatio(color, surface.color);
        if (ratio !== null && ratio < worst.ratio) worst = { ratio, surface: surface.label };
      }
      return { token, name, color, worst };
    }));
  }, [theme]);

  const floor = rows.length ? Math.min(...rows.map((r) => r.worst.ratio)) : 0;

  return (
    <>
      <div className="sg__probes" ref={probes} aria-hidden>
        {TEXT_TOKENS.map(([token]) => <span key={token} data-fg={token} style={{ color: `var(${token})` }} />)}
        {CONTRAST_SURFACES.map(([token]) => <span key={token} data-bg={token} style={{ background: `var(${token})` }} />)}
      </div>
      <div className="sg__contrast">
        <table className="sg__apitable">
          <caption className="u-visually-hidden">Measured contrast for every text token against every resting surface</caption>
          <thead>
            <tr>
              <th scope="col">Token</th><th scope="col">Resolved</th>
              <th scope="col">Worst surface</th><th scope="col">Ratio</th><th scope="col">WCAG</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.token}>
                <th scope="row">
                  <span className="sg__contrastswatch" style={{ background: row.color }} />
                  <code className="sg__mono">{row.token}</code>
                </th>
                <td><code className="sg__mono sg__monotype">{row.color}</code></td>
                <td>{row.worst.surface}</td>
                <td className="sg__num">{row.worst.ratio.toFixed(2)}:1</td>
                <td>
                  <Badge tone={row.worst.ratio >= 4.5 ? 'success' : 'danger'} size="sm">
                    {contrastGrade(row.worst.ratio)}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="sg__demonote">
        {rows.length > 0
          ? `Measured live in the ${theme} theme: ${rows.length} text tokens × ${CONTRAST_SURFACES.length} surfaces, lowest ratio ${floor.toFixed(2)}:1.`
          : 'Measuring…'}
      </p>
    </>
  );
}
const TYPE_SCALE = [
  ['--text-5xl', '40px', 'Northwind Robotics'], ['--text-4xl', '32px', 'Revenue this quarter'],
  ['--text-3xl', '26px', 'MRR movement'], ['--text-2xl', '21px', 'Subscriptions'],
  ['--text-xl', '18px', 'Invoice INV-02481'], ['--text-lg', '16px', 'Payment collected'],
  ['--text-base', '14px', 'The trial converts on 14 May and bills 62 seats.'],
  ['--text-md', '13.5px', 'The trial converts on 14 May and bills 62 seats.'],
  ['--text-sm', '12.5px', 'Usage is metered hourly and rated at the end of the period.'],
  ['--text-xs', '11.5px', 'Last synced 4 minutes ago'],
  ['--text-2xs', '10.5px', 'ACCOUNT OWNER'],
];
const SPACE_SCALE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const RADII = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'];
const SHADOWS = ['xs', 'sm', 'md', 'lg', 'xl', 'popover'];

function Foundations({ theme }: { theme: string }) {
  return (
    <Doc
      id="foundations"
      title="Colour"
      description="One palette, two themes. Components never reference a hue directly — they reference a role, so switching themes is a token swap and nothing else."
      imports="cx, vizColor, contrastRatio, contrastGrade"
    >
      <Demo title="Surfaces" note="Backgrounds, in stacking order from the page outwards.">
        <div className="sg__swatches">
          {SURFACE_TOKENS.map(([token, name]) => (
            <div className="sg__swatch" key={token}>
              <div className="sg__chip" style={{ background: `var(${token})` }} />
              <div><div className="sg__swatchname">{name}</div><div className="sg__swatchtoken">{token}</div></div>
            </div>
          ))}
        </div>
      </Demo>
      <Demo
        title="Text"
        note="Every text token clears 4.5:1 on every resting surface, in both themes — measured below, not asserted."
      >
        <div className="sg__swatches">
          {TEXT_TOKENS.map(([token, name]) => (
            <div className="sg__swatch" key={token}>
              <div className="sg__chip" style={{ background: 'var(--bg-surface)', display: 'grid', placeItems: 'center', color: `var(${token})`, fontWeight: 600 }}>Aa</div>
              <div><div className="sg__swatchname">{name}</div><div className="sg__swatchtoken">{token}</div></div>
            </div>
          ))}
        </div>
        <ContrastAudit theme={theme} />
      </Demo>
      <Demo title="Data visualisation ramp" note="Ordered so the first three series stay distinguishable for the most common colour-vision deficiencies.">
        <div className="sg__swatches">
          {Array.from({ length: 8 }, (_, i) => (
            <div className="sg__swatch" key={i}>
              <div className="sg__chip" style={{ background: vizColor(i) }} />
              <div><div className="sg__swatchname">Series {i + 1}</div><div className="sg__swatchtoken">--viz-{i + 1}</div></div>
            </div>
          ))}
        </div>
      </Demo>
      <Demo title="Semantic tones" note="The same nine tones drive badges, banners, status dots and timeline markers.">
        <Inline gap={4} wrap>
          {(['neutral', 'brand', 'success', 'warning', 'danger', 'info', 'purple', 'teal', 'pink'] as const).map((tone) => (
            <Badge key={tone} tone={tone} dot>{tone}</Badge>
          ))}
        </Inline>
        <Inline gap={4} wrap>
          {(['neutral', 'brand', 'success', 'warning', 'danger'] as const).map((tone) => (
            <Badge key={tone} tone={tone} solid>{tone}</Badge>
          ))}
        </Inline>
      </Demo>
    </Doc>
  );
}

function Typography() {
  return (
    <Doc
      id="typography"
      title="Typography"
      description="A tight scale built for density. Interface text sits between 11.5 and 14px; anything larger is a heading, not emphasis."
      imports="cx"
    >
      <Demo title="Scale">
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {TYPE_SCALE.map(([token, size, sample]) => (
            <div className="sg__typerow" key={token}>
              <span className="sg__typetoken">{token}</span>
              <span className="sg__typesize">{size}</span>
              <span
                className="sg__typesample"
                style={{ fontSize: `var(${token})`, fontWeight: Number(size.replace('px', '')) >= 18 ? 'var(--weight-bold)' : 'var(--weight-normal)', letterSpacing: Number(size.replace('px', '')) >= 18 ? 'var(--tracking-tight)' : 'var(--tracking-snug)' }}
              >
                {sample}
              </span>
            </div>
          ))}
        </div>
      </Demo>
      <Demo title="Weights & numerals" note="Tabular numerals everywhere so columns of money line up.">
        <Inline gap={8} wrap>
          {(['normal', 'medium', 'semibold', 'bold'] as const).map((w) => (
            <span key={w} style={{ fontWeight: `var(--weight-${w})`, fontSize: 'var(--text-lg)' }}>{w} 1,204.50</span>
          ))}
        </Inline>
        <Inline gap={8} wrap>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>sub_9fQ2xLm41 · ain_demo_key_••••</span>
        </Inline>
      </Demo>
    </Doc>
  );
}

function SpaceAndElevation() {
  return (
    <Doc
      id="space"
      title="Space, radius, elevation & motion"
      description="A 4px grid with two half-steps for optical alignment inside controls. Elevation is reserved for things that float above the page — never for decoration."
      imports="Stack, Inline, Divider"
    >
      <div className="sg__grid2">
        <div className="sg__col">
          <Demo title="Spacing scale">
            <div className="sg__scale">
              {SPACE_SCALE.map((n) => (
                <div className="sg__scalerow" key={n}>
                  <span className="sg__swatchtoken">--space-{n}</span>
                  <span className="sg__typesize" style={{ textAlign: 'right' }}>
                    {[0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64][n]}px
                  </span>
                  <span className="sg__bar" style={{ width: `var(--space-${n})` }} />
                </div>
              ))}
            </div>
          </Demo>
          <Demo title="Motion" note="Durations are short on purpose — an interface should feel answered, not animated.">
            <DescriptionList
              items={[
                { term: 'instant · 80ms', value: 'Press feedback, hover tints' },
                { term: 'fast · 130ms', value: 'Tooltips, menus, focus rings' },
                { term: 'normal · 200ms', value: 'Modals, drawers, toasts' },
                { term: 'slow · 320ms', value: 'Progress bars, chart transitions' },
              ]}
            />
          </Demo>
        </div>
        <div className="sg__col">
          <Demo title="Radii">
            <div className="sg__boxes">
              {RADII.map((r) => (
                <div className="sg__box" key={r} style={{ borderRadius: `var(--radius-${r})` }}>{r}</div>
              ))}
            </div>
          </Demo>
          <Demo title="Elevation" stage="sunken">
            <div className="sg__boxes">
              {SHADOWS.map((sh) => (
                <div className="sg__shadowbox" key={sh} style={{ boxShadow: `var(--shadow-${sh})` }}>{sh}</div>
              ))}
            </div>
          </Demo>
        </div>
      </div>
    </Doc>
  );
}

/** The gallery is one tab stop: arrows move within it, exactly like a toolbar,
 *  so reaching the next section never costs 138 Tab presses. */
function IconGrid({ names, columns, onPick }: { names: readonly string[]; columns: number; onPick: (name: string) => void }) {
  const roving = useRovingIndex(names.length);
  const gridRef = useRef<HTMLDivElement>(null);
  const focusCell = (index: number) => {
    requestAnimationFrame(() => gridRef.current?.querySelector<HTMLButtonElement>(`[data-cell="${index}"]`)?.focus());
  };
  const move = (delta: number) => { roving.move(delta); focusCell((roving.index + delta + names.length) % names.length); };

  return (
    <div
      className="sg__icons"
      role="grid"
      aria-label="Icon set"
      ref={gridRef}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); move(columns); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-columns); }
        else if (e.key === 'Home') { e.preventDefault(); roving.first(); focusCell(0); }
        else if (e.key === 'End') { e.preventDefault(); roving.last(); focusCell(names.length - 1); }
      }}
    >
      {names.map((name, index) => {
        const Icon = Icons[name as keyof typeof Icons];
        return (
          <button
            type="button"
            role="gridcell"
            data-cell={index}
            tabIndex={index === roving.index ? 0 : -1}
            className="sg__icon"
            key={name}
            onFocus={() => roving.setIndex(index)}
            onClick={() => onPick(name)}
          >
            <Icon size={20} />
            <span className="sg__iconname">{name}</span>
          </button>
        );
      })}
    </div>
  );
}

function IconsSection() {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const names = ICON_NAMES.filter((n) => n.includes(query.toLowerCase()));
  return (
    <Doc
      id="icons"
      title="Icons"
      description={`${ICON_NAMES.length} glyphs drawn on a 24px grid and stroked at 1.75, so they stay crisp at the 16px the product uses everywhere. No icon font, no runtime dependency.`}
      imports="Icons, ICON_NAMES, iconByName"
    >
      <Demo
        title="The set"
        note="One tab stop: arrow keys move through the grid, Enter copies the name."
        code={"import { Icons } from '@/client/design';\n\n<Icons.invoice size={16} />\n<Icons['alert-triangle'] size={20} className=\"u-danger\" />"}
      >
        <Inline gap={4}>
          <SearchInput value={query} onChange={setQuery} placeholder="Filter icons…" aria-label="Filter icons" />
          <span className="sg__demonote">{names.length} shown</span>
        </Inline>
        <IconGrid
          names={names}
          columns={8}
          onPick={(name) => {
            void navigator.clipboard?.writeText(name);
            toast.success('Copied', `Icons['${name}']`);
          }}
        />
      </Demo>
      <Demo title="Sizes" note="16px in tables and buttons, 20px in headers, 24px only for empty states.">
        <Inline gap={7}>
          {[14, 16, 20, 24, 32].map((size) => (
            <Inline gap={3} key={size}>
              <Icons.sparkles size={size} />
              <span className="sg__swatchtoken">{size}px</span>
            </Inline>
          ))}
        </Inline>
      </Demo>
    </Doc>
  );
}

function ButtonsSection() {
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'board' | 'table' | 'calendar'>('table');
  return (
    <Doc
      id="buttons"
      title="Buttons"
      description="One primary action per view. Secondary is the workhorse; ghost is for toolbars; danger is reserved for actions that destroy data."
      imports="Button, IconButton, ButtonGroup, SegmentedControl, Kbd"
      api={API.buttons}
    >
      <Demo title="Variants and sizes"
        code={"<Button variant=\"primary\" size=\"md\" iconLeft={<Icons.plus size={14} />}>\n  New invoice\n</Button>\n\n<Button variant=\"danger\" loading={voiding} onClick={voidInvoice}>Void</Button>\n<IconButton label=\"Refresh\" icon={<Icons.refresh size={16} />} />\n<ButtonGroup><Button>Day</Button><Button>Week</Button></ButtonGroup>"}
      >
        <div className="sg__matrix" style={{ gridTemplateColumns: 'max-content repeat(3, max-content)' }}>
          <span />
          {(['sm', 'md', 'lg'] as const).map((s) => <span className="sg__matrixhead" key={s}>{s}</span>)}
          {(['primary', 'secondary', 'ghost', 'danger', 'danger-ghost', 'link'] as const).map((variant) => (
            <Fragment key={variant}>
              <span className="sg__matrixhead">{variant}</span>
              {(['sm', 'md', 'lg'] as const).map((size) => (
                <Button key={`${variant}-${size}`} variant={variant} size={size}>Create invoice</Button>
              ))}
            </Fragment>
          ))}
        </div>
      </Demo>
      <Demo title="States">
        <Inline gap={4} wrap>
          <Button variant="primary" iconLeft={<Icons.plus size={15} />}>New subscription</Button>
          <Button variant="secondary" iconRight={<ChevronDownIcon size={14} />}>Actions</Button>
          <Button variant="secondary" loading={loading} onClick={() => { setLoading(true); setTimeout(() => setLoading(false), 1800); }}>
            {loading ? 'Charging card' : 'Collect payment'}
          </Button>
          <Button variant="primary" disabled>Disabled</Button>
          <Button variant="danger" iconLeft={<Icons.trash size={14} />}>Void invoice</Button>
          <Button variant="link" iconRight={<Icons.external size={13} />} href="#table">Jump to the table</Button>
        </Inline>
        <Divider />
        <Inline gap={4} wrap>
          <span className="sg__label">Icon buttons</span>
          {(['ghost', 'secondary', 'primary', 'danger'] as const).map((v) => (
            <IconButton key={v} variant={v} label={`${v} action`} icon={<Icons.refresh size={16} />} />
          ))}
          <IconButton label="Pinned" icon={<Icons.pin size={16} />} active />
          <IconButton label="Disabled" icon={<Icons.lock size={16} />} disabled />
        </Inline>
        <Inline gap={6} wrap>
          <ButtonGroup>
            <Button variant="secondary" size="sm" iconLeft={<ArrowLeftIcon size={13} />}>Previous</Button>
            <Button variant="secondary" size="sm">Today</Button>
            <Button variant="secondary" size="sm" iconRight={<ArrowRightIcon size={13} />}>Next</Button>
          </ButtonGroup>
          <SegmentedControl
            aria-label="View"
            value={view}
            onChange={setView}
            options={[
              { value: 'board', label: 'Board', icon: <Icons.layers size={14} /> },
              { value: 'table', label: 'Table', icon: <Icons.table size={14} /> },
              { value: 'calendar', label: 'Calendar', icon: <Icons.calendar size={14} /> },
            ]}
          />
          <Inline gap={3}>
            <span className="sg__label">Shortcut</span>
            <Kbd combo="mod+k" />
            <Kbd combo="shift+n" />
            <Kbd>?</Kbd>
          </Inline>
        </Inline>
      </Demo>
      <Demo title="Full-width" note="Only inside narrow containers: dialogs, side panels, empty states.">
        <div style={{ maxWidth: 320 }}>
          <Stack gap={4}>
            <Button variant="primary" block iconLeft={<CreditCardIcon size={15} />}>Pay {formatMoney(1248000, { currency: 'usd' })}</Button>
            <Button variant="ghost" block>Not now</Button>
          </Stack>
        </div>
      </Demo>
    </Doc>
  );
}

function TogglesSection() {
  const [checks, setChecks] = useState({ usage: true, seats: false, tax: true });
  const [plan, setPlan] = useState('pro');
  const [dunning, setDunning] = useState(true);
  const [retries, setRetries] = useState(4);
  const [filters, setFilters] = useState<string[]>(['past_due']);
  const allChecked = Object.values(checks).every(Boolean);
  const someChecked = Object.values(checks).some(Boolean) && !allChecked;

  return (
    <Doc
      id="toggles"
      title="Selection controls"
      description="Checkboxes commit on submit; switches commit immediately. Never mix the two in one form."
      imports="Checkbox, Radio, RadioGroup, Switch, Slider, Pill, PillGroup"
    >
      <div className="sg__grid2">
        <Demo title="Checkbox"
        code={"<Checkbox\n  checked={all}\n  indeterminate={some && !all}\n  onChange={toggleAll}\n  label=\"Select every invoice on this page\"\n/>"}
      >
          <Checkbox
            checked={allChecked}
            indeterminate={someChecked}
            label="Include everything on the invoice"
            onChange={(v) => setChecks({ usage: v, seats: v, tax: v })}
          />
          <div style={{ paddingLeft: 'var(--space-8)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <Checkbox checked={checks.usage} label="Metered usage" hint="Rated at the close of the period" onChange={(v) => setChecks((c) => ({ ...c, usage: v }))} />
            <Checkbox checked={checks.seats} label="Seat licences" onChange={(v) => setChecks((c) => ({ ...c, seats: v }))} />
            <Checkbox checked={checks.tax} label="Tax" onChange={(v) => setChecks((c) => ({ ...c, tax: v }))} />
            <Checkbox checked={false} disabled label="Credits (none available)" />
          </div>
        </Demo>
        <Demo title="Radio">
          <RadioGroup
            label="Proration behaviour"
            value={plan}
            onChange={setPlan}
            options={[
              { value: 'core', label: 'Create prorations', hint: 'Default. Adds a credit and a charge line.' },
              { value: 'pro', label: 'Always invoice', hint: 'Bills the difference immediately.' },
              { value: 'none', label: 'No proration', hint: 'The change takes effect at renewal.' },
            ]}
          />
        </Demo>
        <Demo title="Switch">
          <Switch checked={dunning} onChange={setDunning} label="Automatic dunning" hint="Retry failed payments on the schedule below." />
          <Switch checked={!dunning} onChange={(v) => setDunning(!v)} size="sm" label="Notify the account owner" />
          <Switch checked disabled onChange={() => undefined} label="Enforced by workspace policy" hint="Only an owner can change this." />
        </Demo>
        <Demo title="Slider & pills">
          <Slider
            aria-label="Retry attempts"
            value={retries}
            onChange={setRetries}
            min={1}
            max={8}
            ticks={['1 retry', '8 retries']}
            format={(v) => `${v} ${v === 1 ? 'retry' : 'retries'}`}
          />
          <Divider />
          <PillGroup label="Invoice status filter">
            {STATUSES.map((status) => (
              <Pill
                key={status}
                active={filters.includes(status)}
                onClick={() => setFilters((f) => (f.includes(status) ? f.filter((s) => s !== status) : [...f, status]))}
              >
                {status.replace('_', ' ')}
              </Pill>
            ))}
          </PillGroup>
        </Demo>
      </div>
    </Doc>
  );
}

function FieldsSection() {
  const [name, setName] = useState('Northwind Robotics');
  const [email, setEmail] = useState('ap@');
  const [amount, setAmount] = useState<number | null>(1248000);
  const [seats, setSeats] = useState<number | null>(62);
  const [notes, setNotes] = useState('Ships with the Q3 telemetry bundle. AP contact prefers a single consolidated invoice per quarter.');
  const [currency, setCurrency] = useState('usd');
  const [owner, setOwner] = useState('u_priya');
  const [tags, setTags] = useState(['enterprise', 'net-30']);
  const [multi, setMulti] = useState<string[]>(['Telemetry Pro']);
  const [code, setCode] = useState('4821');
  const [search, setSearch] = useState('');
  const [descriptor, setDescriptor] = useState('NORTHWIND TELEMETRY');

  return (
    <Doc
      id="fields"
      title="Fields"
      description="Every control is wrapped by Field, which owns the label, the hint, the error and the aria wiring. Errors quote the offending parameter the API returned."
      imports="Field, Input, NumberInput, MoneyInput, Textarea, Select, Combobox, TagInput, SearchInput, CopyField, CodeInput"
      api={API.fields}
    >
      <Demo title="Anatomy"
        code={"<Field\n  label=\"Billing email\"\n  hint=\"Invoices and dunning notices go here.\"\n  error={error?.param === 'email' ? error.message : null}\n  required\n>\n  {(props) => <Input {...props} value={email} onChange={(e) => setEmail(e.target.value)} />}\n</Field>"}
      >
        <div className="sg__formgrid">
          <Field label="Legal name" hint="As it should appear on the invoice." required>
            <Input value={name} onChange={(e) => setName(e.target.value)} clearable onClear={() => setName('')} />
          </Field>
          <Field label="Billing email" error="Enter a complete email address." required>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} invalid iconLeft={<Icons.mail size={15} />} />
          </Field>
          <Field label="Purchase order" optional hint="Printed in the invoice header.">
            <Input placeholder="PO-000000" mono />
          </Field>
          <Field label="Statement descriptor" counter={{ value: descriptor.length, max: 22 }} hint="What the payer sees on their card statement.">
            <Input value={descriptor} onChange={(e) => setDescriptor(e.target.value)} maxLength={30} />
          </Field>
        </div>
      </Demo>

      <Demo title="Inputs">
        <div className="sg__formgrid">
          <Field label="With affixes">
            <Input prefix="https://" suffix=".ain.app" boxedAffix defaultValue="northwind" />
          </Field>
          <Field label="Amount" hint="Integer minor units under the hood — never a float.">
            <MoneyInput value={amount} onChange={setAmount} currency={currency} aria-label="Amount" />
          </Field>
          <Field label="Seats">
            <NumberInput value={seats} onChange={setSeats} min={1} max={500} suffix={<span style={{ fontSize: 'var(--text-xs)' }}>seats</span>} />
          </Field>
          <Field label="Currency">
            <Select
              value={currency}
              onChange={setCurrency}
              aria-label="Currency"
              options={[
                { value: 'usd', label: 'USD — US Dollar', group: 'Common' },
                { value: 'eur', label: 'EUR — Euro', group: 'Common' },
                { value: 'gbp', label: 'GBP — Pound Sterling', group: 'Common' },
                { value: 'jpy', label: 'JPY — Japanese Yen (zero-decimal)', group: 'Other' },
                { value: 'sek', label: 'SEK — Swedish Krona', group: 'Other' },
              ]}
            />
          </Field>
          <Field label="Read only">
            <Input value="acct_1P9xQ2LmZ" readOnly mono />
          </Field>
          <Field label="Disabled">
            <Input value="Managed by the parent account" disabled />
          </Field>
        </div>
      </Demo>

      <Demo title="Composite controls">
        <div className="sg__formgrid">
          <Field label="Account owner" hint="Type to search the workspace.">
            <Combobox
              aria-label="Account owner"
              value={owner}
              onChange={setOwner}
              options={OWNERS.map((o) => ({ value: o.id, label: o.name, description: 'Northwind Robotics' }))}
            />
          </Field>
          <Field label="Products" hint="Multi-select with chips; Backspace removes the last one.">
            <Combobox
              aria-label="Products"
              multiple
              value={multi}
              onChange={setMulti}
              options={PLANS.map((p) => ({ value: p, label: p, description: p === 'Fleet Enterprise' ? 'Annual, invoice-billed' : 'Monthly, card-billed' }))}
            />
          </Field>
          <Field label="Tags" hint="Enter or comma to commit.">
            <TagInput value={tags} onChange={setTags} aria-label="Tags" />
          </Field>
          <Field label="Search">
            <SearchInput value={search} onChange={setSearch} placeholder="Search invoices…" shortcut="/" aria-label="Search invoices" />
          </Field>
        </div>
        <Field label="Internal note" hint="Grows with the content up to fourteen rows.">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="sg__formgrid">
          <Field label="API key" hint="Revealed only on request; copying never puts it in the DOM twice.">
            <CopyField value="ain_demo_key_not_a_real_credential" secret />
          </Field>
          <Field label="Verification code">
            <CodeInput value={code} onChange={setCode} length={6} aria-label="Verification code" />
          </Field>
        </div>
      </Demo>
    </Doc>
  );
}

function PickersSection() {
  const fmt = useFormat();
  const [now] = useState(() => fmt.now());
  const [date, setDate] = useState<number | null>(now);
  const [month, setMonth] = useState(() => Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1));
  const [range, setRange] = useState<DateRange>(() => RANGE_PRESETS.find((p) => p.id === 'last30')!.range(now));

  return (
    <Doc
      id="pickers"
      title="Date pickers"
      description="Real calendars: arrow keys move a day, Page Up and Page Down move a month, and every date is computed in UTC so a workspace in another timezone never sees the day shift."
      imports="Calendar, DatePicker, DateRangePicker, RANGE_PRESETS, type DateRange"
      api={API.pickers}
    >
      <div className="sg__grid2">
        <Demo title="Inline calendar">
          <Calendar
            value={date}
            month={month}
            onMonthChange={setMonth}
            onSelect={setDate}
            today={now}
            locale={fmt.locale}
          />
        </Demo>
        <div className="sg__col">
          <Demo title="Date field">
            <Field label="Invoice date" hint="Defaults to the workspace clock, not the browser's.">
              <DatePicker value={date} onChange={setDate} aria-label="Invoice date" />
            </Field>
          </Demo>
          <Demo title="Range with presets"
        code={"const [range, setRange] = useState<DateRange>({ start: null, end: null });\n\n<DateRangePicker value={range} onChange={setRange} presets={RANGE_PRESETS} />"}
      >
            <Field label="Reporting period">
              <DateRangePicker value={range} onChange={setRange} aria-label="Reporting period" />
            </Field>
            <p className="sg__demonote">
              {range.start && range.end
                ? `${fmt.dateRange(range.start, range.end, { timeZone: 'UTC' })} · ${Math.round((range.end - range.start) / DAY) + 1} days`
                : 'No period selected'}
            </p>
          </Demo>
        </div>
      </div>
    </Doc>
  );
}

function DisplaySection({ data }: { data: Derived }) {
  const fmt = useFormat();
  const top = data.topAccounts[0];
  const accountMenu = useAccountMenu(data.topAccounts);
  const currentLabel = data.monthLabels[data.monthLabels.length - 2] ?? '';
  const priorLabel = data.monthLabels[data.monthLabels.length - 3] ?? '';
  const { invoice, lines, subtotal, tax, total, includedUnits } = data.featured;
  return (
    <Doc
      id="display"
      title="Data display"
      description="The vocabulary a business screen is written in: a status, a person, a number, and the change in that number since last period."
      imports="Badge, StatusBadge, StatusDot, Tag, Avatar, AvatarGroup, Stat, MetricTile, Delta, DescriptionList, KeyValue, Timeline, ProgressBar, Meter"
    >
      <Demo title="Badges & status">
        <Inline gap={4} wrap>
          {STATUSES.map((status) => <StatusBadge key={status} status={status} />)}
        </Inline>
        <Inline gap={6} wrap>
          <StatusDot tone="success" label="Webhook endpoint healthy" pulse />
          <StatusDot tone="warning" label="3 retries pending" />
          <StatusDot tone="danger" label="Sync failed" />
          <StatusDot tone="neutral" label="Never run" />
        </Inline>
        <Inline gap={4} wrap>
          <Badge size="sm" tone="brand">sm</Badge>
          <Badge tone="brand">md</Badge>
          <Badge size="lg" tone="brand">lg</Badge>
          <Badge pill tone="teal" icon={<Icons.sparkles size={11} />}>AI drafted</Badge>
          <Tag colorSeed="enterprise">enterprise</Tag>
          <Tag colorSeed="net-30" onRemove={() => undefined}>net-30</Tag>
        </Inline>
      </Demo>

      <Demo title="People">
        <Inline gap={7} wrap>
          {[20, 24, 28, 36, 48].map((size) => (
            <Avatar key={size} name="Priya Raghavan" size={size} />
          ))}
          <Avatar name="Marcus Oyelaran" size={36} presence="online" />
          <Avatar name="Northwind Robotics" size={36} square />
          <AvatarGroup size={28} people={OWNERS.map((o) => ({ id: o.id, name: o.name }))} max={4} />
        </Inline>
        <p className="sg__demonote">Colour is a pure function of the id, so the same person is the same colour on every screen and after every reload.</p>
      </Demo>

      <Demo title="Metrics" note={`Deltas compare ${priorLabel} with ${currentLabel} — both computed from the sample rows.`}
        code={"<Stat\n  label=\"Open receivable\"\n  value={fmt.money(openAr)}\n  delta={change}\n  deltaInverted            // rising receivable is bad news, so the tone flips\n  sparkline={openSeries}\n  caption=\"vs. last month\"\n/>"}
      >
        <Grid minColumnWidth={230} gap={5}>
          <MetricTile
            label={`Billed in ${currentLabel}`}
            value={fmt.moneyCompact(data.currentMonth.billed)}
            delta={data.deltas.billed}
            caption={`${fmt.moneyCompact(data.totalBilled)} in the last 12 months`}
            sparkline={data.monthlyTotals}
          />
          <MetricTile
            label={`Collected in ${currentLabel}`}
            value={fmt.moneyCompact(data.currentMonth.collected)}
            delta={data.deltas.collected}
            caption={`${formatPercent(data.collectionRate)} collection rate overall`}
            sparkline={data.collectedSeries}
          />
          <MetricTile
            label="Open receivable"
            value={fmt.moneyCompact(data.openAr)}
            delta={data.deltas.open}
            deltaInverted
            caption={`${fmt.moneyCompact(data.pastDue)} of it past due`}
            sparkline={data.openSeries}
          />
          <MetricTile
            label={`Metered units in ${currentLabel}`}
            value={fmt.compact(data.currentMonth.usage)}
            delta={data.deltas.usage}
            caption="Telemetry events ingested"
            sparkline={data.usageByMonth}
          />
        </Grid>
      </Demo>

      <Demo title="Records">
        <div className="sg__grid2">
          <Card title="Account" description={top.company} actions={<MenuButton label="Account actions" sections={accountMenu} />}>
            <DescriptionList
              items={[
                { term: 'Owner', value: <Inline gap={3}><Avatar name={top.owner} size={20} /> {top.owner}</Inline> },
                { term: 'Primary plan', value: <Badge tone="brand">{top.plan}</Badge> },
                { term: 'Invoices', value: formatNumber(top.invoices) },
                { term: 'Lifetime billed', value: fmt.money(top.billed) },
                { term: 'Metered units', value: formatNumber(top.usage) },
                { term: 'Average invoice', value: fmt.money(Math.round(top.billed / top.invoices)) },
              ]}
            />
          </Card>
          <Card title="Invoice summary" description={`${invoice.number} · ${invoice.company} · due ${fmt.date(invoice.dueAt)}`}>
            {lines.map((line) => (
              <KeyValue key={line.label} label={`${line.label} (${line.detail})`} value={fmt.money(line.amount)} />
            ))}
            <KeyValue label="Subtotal" value={fmt.money(subtotal)} strong />
            <KeyValue label="Tax (8.25%)" value={fmt.money(tax)} />
            <KeyValue label="Total due" value={fmt.money(total)} total strong />
            <div style={{ marginTop: 'var(--space-6)' }}>
              <Meter
                label="Included telemetry units"
                value={invoice.usageUnits}
                limit={includedUnits}
                format={(v) => formatNumber(v)}
              />
            </div>
          </Card>
        </div>
      </Demo>

      <Demo title="Progress & activity">
        <div className="sg__grid2">
          <Stack gap={6}>
            <ProgressBar value={data.collectionRate} label="Collection rate" />
            <ProgressBar value={0.42} tone="warning" label="Dunning recovery" valueLabel="42% of $84,120" />
            <ProgressBar value={0.94} tone="success" label="Webhook delivery" size="lg" />
            <ProgressBar value={0} indeterminate label="Recalculating revenue" valueLabel="Working" />
            <Inline gap={6}>
              <Delta value={0.184} />
              <Delta value={-0.052} />
              <Delta value={0} />
              <Delta value={-0.031} inverted />
              <Delta value={null} />
            </Inline>
          </Stack>
          <Timeline
            entries={[
              { id: '1', title: 'Payment attempted', description: `${fmt.money(total)} on the card ending 4242`, time: '2 hours ago', tone: 'success', icon: <CheckCircleIcon size={13} /> },
              { id: '2', title: 'Payment retried', description: 'Attempt 2 of 4 · card declined (insufficient_funds)', time: 'Yesterday', tone: 'warning', icon: <Icons.refresh size={13} /> },
              { id: '3', title: 'Dunning email sent', description: 'Template “Payment failed — first notice”', time: '3 days ago', tone: 'neutral', icon: <Icons.mail size={13} /> },
              {
                id: '4',
                title: 'Breeze agent drafted a reply',
                description: 'Suggested a 14-day extension based on the account’s payment history.',
                time: '4 days ago',
                tone: 'brand',
                icon: <Icons.sparkles size={13} />,
                children: (
                  <Card variant="sunken" padding="tight">
                    <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 'var(--leading-relaxed)' }}>
                      “Northwind has paid 23 of 24 invoices on time. Recommend approving the extension and suppressing dunning until 30 June.”
                    </p>
                  </Card>
                ),
              },
            ]}
          />
        </div>
      </Demo>
    </Doc>
  );
}

/**
 * The account menu the docs use in three places. Every row does something and
 * the two checkboxes really toggle: a menu of inert rows cannot show that Enter
 * fires the item the highlight is on, which is the whole point of the keyboard
 * story. Merge targets are the next real accounts in the workspace.
 */
function useAccountMenu(accounts: Derived['topAccounts']): MenuSection[] {
  const toast = useToast();
  const [autoCharge, setAutoCharge] = useState(true);
  const [dunning, setDunning] = useState(true);
  const account = accounts[0];
  return [
    {
      id: 'edit',
      items: [
        {
          id: 'rename',
          label: 'Rename account',
          icon: <Icons.edit size={14} />,
          shortcut: 'mod+e',
          onSelect: () => toast.info('Rename account', `The header of ${account.company} becomes an editable field.`),
        },
        {
          id: 'owner',
          label: 'Change owner',
          icon: <Icons.user size={14} />,
          onSelect: () => toast.info('Change owner', `${account.company} is owned by ${account.owner} today.`),
        },
        {
          id: 'merge',
          label: 'Merge into…',
          icon: <Icons.layers size={14} />,
          items: accounts.slice(1, 4).map((target) => ({
            id: `merge-${target.company}`,
            label: target.company,
            onSelect: () => toast.warning(
              'Merge queued',
              `${formatNumber(account.invoices)} invoices move from ${account.company} to ${target.company}.`,
            ),
          })),
        },
      ],
    },
    {
      id: 'billing',
      label: 'Billing',
      items: [
        {
          id: 'auto',
          label: 'Auto-charge on renewal',
          checked: autoCharge,
          onSelect: () => {
            setAutoCharge((v) => !v);
            toast.success(
              autoCharge ? 'Auto-charge turned off' : 'Auto-charge turned on',
              `${account.company} renews on ${account.plan}.`,
            );
          },
        },
        {
          id: 'dunning',
          label: 'Automatic dunning',
          checked: dunning,
          onSelect: () => {
            setDunning((v) => !v);
            toast.success(
              dunning ? 'Dunning paused' : 'Dunning resumed',
              dunning ? 'Failed payments stop retrying until this is switched back on.' : 'Failed payments retry on the workspace dunning schedule.',
            );
          },
        },
        {
          id: 'export',
          label: 'Export statement',
          icon: <Icons.download size={14} />,
          shortcut: 'mod+shift+e',
          onSelect: () => toast.info('Statement queued', `${formatNumber(account.invoices)} invoices for ${account.company}, as CSV.`),
        },
      ],
    },
    {
      id: 'danger',
      items: [{
        id: 'delete',
        label: 'Delete account',
        icon: <Icons.trash size={14} />,
        danger: true,
        onSelect: () => toast.error('Cannot delete', `${account.company} still has ${formatNumber(account.invoices)} invoices attached.`),
      }],
    },
  ];
}

const DEFAULT_INVOICE_SORT = { columnId: 'issuedAt', direction: 'desc' as const };

/**
 * The table's query, sort and filter stack live in the URL, so a filtered grid
 * is a link. `sort=none` is written explicitly because "no sort" and "the
 * default sort" are different states.
 */
function useUrlTableState(): [TableState, (next: TableState) => void] {
  let router: ReturnType<typeof useRouter> | null = null;
  try { router = useRouter(); } catch { router = null; }
  const [fallback, setFallback] = useState<TableState>(() => ({ query: '', sort: DEFAULT_INVOICE_SORT, filters: {} }));
  const q = router?.location.query;

  const state = useMemo<TableState>(() => {
    if (!router) return fallback;
    const decoded = decodeTableState({ q: q?.q, sort: q?.sort, filter: q?.filter });
    return { ...decoded, sort: q?.sort === 'none' ? null : decoded.sort ?? DEFAULT_INVOICE_SORT };
  }, [router, q?.q, q?.sort, q?.filter, fallback]);

  const set = useCallback((next: TableState) => {
    if (!router) { setFallback(next); return; }
    const encoded = encodeTableState(next);
    router.setQuery({ q: encoded.q ?? null, sort: encoded.sort ?? 'none', filter: encoded.filter ?? null }, { replace: true });
  }, [router]);

  return [state, set];
}

function TableSection({ data }: { data: Derived }) {
  const fmt = useFormat();
  // Two rows start selected so the bulk-action bar is visible in the guide.
  const [selected, setSelected] = useState<string[]>(() => data.invoices.slice(0, 2).map((r) => r.id));
  const toast = useToast();
  const [tableState, setTableState] = useUrlTableState();
  const [copiedLink, copyLink] = useCopyToClipboard();

  const columns = useMemo<DataTableColumn<Invoice>[]>(() => [
    {
      id: 'number',
      header: 'Invoice',
      width: 176,
      pinned: true,
      accessor: (r) => r.number,
      total: () => <span style={{ color: 'var(--text-tertiary)', fontWeight: 'var(--weight-medium)' }}>Totals</span>,
      cell: (r) => (
        <Inline gap={4}>
          <Avatar name={r.company} seed={r.company} size={22} square />
          <Stack gap={0}>
            <span style={{ fontWeight: 'var(--weight-medium)' }}>{r.number}</span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>{r.company}</span>
          </Stack>
        </Inline>
      ),
    },
    { id: 'company', header: 'Account', width: 190, filter: 'set', defaultHidden: true, accessor: (r) => r.company },
    {
      id: 'status', header: 'Status', width: 118, filter: 'set', filterOptionLabel: humanize,
      accessor: (r) => r.status, cell: (r) => <StatusBadge status={r.status} />,
    },
    { id: 'plan', header: 'Plan', width: 148, filter: 'set', accessor: (r) => r.plan },
    {
      id: 'owner', header: 'Owner', width: 168, filter: 'set',
      accessor: (r) => r.owner.name,
      cell: (r) => <Inline gap={3}><Avatar name={r.owner.name} seed={r.owner.id} size={20} />{r.owner.name}</Inline>,
    },
    { id: 'seats', header: 'Seats', width: 84, align: 'right', filter: 'number', accessor: (r) => r.seats, total: (_rows, sum) => formatNumber(sum) },
    { id: 'usageUnits', header: 'Units', width: 100, align: 'right', filter: 'number', accessor: (r) => r.usageUnits, cell: (r) => formatNumber(r.usageUnits), total: (_rows, sum) => formatNumber(sum) },
    {
      id: 'amount', header: 'Amount', width: 124, align: 'right', filter: 'number',
      accessor: (r) => r.amount,
      cell: (r) => fmt.money(r.amount),
      total: (_rows, sum) => fmt.money(sum),
    },
    { id: 'issuedAt', header: 'Issued', width: 112, filter: 'date', accessor: (r) => r.issuedAt, cell: (r) => fmt.date(r.issuedAt) },
    { id: 'dueAt', header: 'Due', width: 112, filter: 'date', defaultHidden: true, accessor: (r) => r.dueAt, cell: (r) => fmt.date(r.dueAt) },
  ], [fmt]);

  const shareable = typeof window !== 'undefined' ? window.location.href : '/design';
  const filterSummary = Object.entries(tableState.filters)
    .filter(([, f]) => f)
    .map(([id, f]) => `${columns.find((c) => c.id === id)?.header ?? id} ${describeFilter(f!, { optionLabel: humanize, formatDate: (ts) => fmt.date(ts, { timeZone: 'UTC' }) })}`)
    .join(' · ');

  return (
    <Doc
      id="table"
      title="Data table"
      description={`${formatNumber(data.invoices.length)} rows rendered from one windowed list: sticky header, pinned first column, a typed filter stack, sticky totals, selection with a bulk bar, and full keyboard navigation. Arrow keys move, Space selects, Shift+Arrow extends, ⌘A selects the page, Escape clears.`}
      imports="DataTable, encodeTableState, decodeTableState, type DataTableColumn, type TableState"
      api={API.table}
    >
      <Demo
        title="The full grid"
        note="Add a filter, then look at the address bar — the view is a link."
        stage="flush"
        code={"const [state, setState] = useUrlTableState();   // decodeTableState(location.query)\n\n<DataTable\n  rows={invoices}\n  columns={columns}\n  getRowId={(r) => r.id}\n  value={state}\n  onChange={setState}          // encodeTableState(next) -> ?q=&sort=&filter=\n  selectable\n  selected={selected}\n  onSelectionChange={setSelected}\n  bulkActions={(ids) => <Button onClick={() => voidInvoices(ids)}>Void</Button>}\n/>\n\n// columns declare their own filter kind and how a raw value reads:\n{ id: 'status', header: 'Status', filter: 'set', filterOptionLabel: humanize }\n{ id: 'issuedAt', header: 'Issued', filter: 'date' }"}
      >
        <DataTable
          rows={data.invoices}
          columns={columns}
          getRowId={(r) => r.id}
          caption="Invoices for Northwind Robotics"
          selectable
          selected={selected}
          onSelectionChange={setSelected}
          maxHeight={520}
          plain
          value={tableState}
          onChange={setTableState}
          searchPlaceholder="Search invoice, account or owner…"
          onRowClick={(row) => toast.info(row.number, `${row.company} · ${fmt.money(row.amount)}`)}
          rowTone={(row) => (row.status === 'past_due' ? 'danger' : 'default')}
          footer={(
            <Inline gap={4}>
              {filterSummary && <span className="sg__demonote u-truncate" style={{ maxWidth: 420 }}>{filterSummary}</span>}
              <Button
                size="sm"
                variant="ghost"
                iconLeft={copiedLink ? <CheckCircleIcon size={13} /> : <Icons.link size={13} />}
                onClick={() => { void copyLink(shareable); toast.success('Link copied', 'The filters, sort and search are in the URL.'); }}
              >
                {copiedLink ? 'Copied' : 'Copy link to this view'}
              </Button>
            </Inline>
          )}
          bulkActions={(ids) => (
            <>
              <Button size="sm" variant="ghost" iconLeft={<Icons.send size={14} />} onClick={() => toast.success(`Reminder queued for ${ids.length} invoices`)}>Send reminder</Button>
              <Button size="sm" variant="ghost" iconLeft={<Icons.download size={14} />}>Export</Button>
              <Button size="sm" variant="ghost" iconLeft={<Icons.trash size={14} />} onClick={() => toast.error(`Voiding ${ids.length} invoices`, 'Only rows the current filter shows are included.')}>Void</Button>
            </>
          )}
          rowActions={(row) => [
            { id: 'open', items: [
              { id: 'view', label: 'Open invoice', icon: <Icons.external size={14} />, shortcut: 'mod+o', onSelect: () => toast.info(row.number, `${row.company} · ${fmt.money(row.amount)} · ${humanize(row.status)}`) },
              { id: 'pdf', label: 'Download PDF', icon: <Icons.download size={14} />, onSelect: () => toast.success('PDF ready', `${row.number} for ${row.company}.`) },
              { id: 'copy', label: 'Copy invoice number', icon: <Icons.link size={14} />, onSelect: () => { void copyLink(row.number); toast.success('Copied', `${row.number} is on the clipboard.`); } },
            ] },
            { id: 'act', label: 'Collection', items: [
              { id: 'remind', label: 'Send reminder', icon: <Icons.mail size={14} />, onSelect: () => toast.success(`Reminder sent for ${row.number}`, `${row.company} · due ${fmt.date(row.dueAt)}`) },
              { id: 'charge', label: 'Charge saved card', icon: <CreditCardIcon size={14} />, disabled: row.status === 'paid', onSelect: () => toast.success('Charge started', `${fmt.money(row.amount)} on the card ${row.company} has on file.`) },
            ] },
            { id: 'danger', items: [{ id: 'void', label: 'Void invoice', icon: <Icons.trash size={14} />, danger: true, disabled: row.status === 'paid', onSelect: () => toast.error(`${row.number} voided`, 'It stays on the account as a voided document and stops accruing dunning steps.') }] },
          ]}
          toolbar={<span className="sg__label">Invoices</span>}
        />
      </Demo>

      <div className="sg__grid2">
        <Demo title="Loading" stage="flush">
          <DataTable
            rows={[]}
            columns={columns.slice(0, 4)}
            getRowId={(r) => r.id}
            loading
            plain
            searchable={false}
            showColumnToggle={false}
            showDensityToggle={false}
            showFilters={false}
            maxHeight={260}
          />
        </Demo>
        <Demo title="Empty" stage="flush">
          <DataTable
            rows={[]}
            columns={columns.slice(0, 4)}
            getRowId={(r) => r.id}
            plain
            searchable={false}
            showColumnToggle={false}
            showDensityToggle={false}
            showFilters={false}
            maxHeight={260}
            empty={
              <EmptyState
                size="sm"
                title="No invoices yet"
                body="The first invoice is created when Northwind’s trial converts on 14 May."
                action={<Button size="sm" variant="primary" iconLeft={<Icons.plus size={14} />}>Create an invoice</Button>}
                secondaryAction={<Button size="sm" variant="ghost">Import from CSV</Button>}
              />
            }
          />
        </Demo>
      </div>
      <Demo title="Error" note="Retry plus the request id support will ask for." stage="flush">
        <DataTable
          rows={[]}
          columns={columns.slice(0, 4)}
          getRowId={(r) => r.id}
          plain
          searchable={false}
          showColumnToggle={false}
          showDensityToggle={false}
          showFilters={false}
          maxHeight={280}
          error={{ message: 'The invoices service did not respond in time. Nothing was changed.', code: 'api_error · gateway_timeout', requestId: 'req_8Fx2Lm41Qp' }}
          onRetry={() => undefined}
        />
      </Demo>
    </Doc>
  );
}

function ChartsSection({ data }: { data: Derived }) {
  const fmt = useFormat();
  const moneyAxis = (v: number) => fmt.moneyCompact(v);
  const totalSeries = data.monthLabels.map((_, i) => data.billedByPlan.reduce((s, p) => s + p.values[i], 0));

  return (
    <Doc
      id="charts"
      title="Charts"
      description="Hand-rolled SVG — no chart library. Each one carries role=&quot;img&quot;, a written description, and a visually-hidden table of the same numbers, so the data is never trapped in the picture."
      imports="LineChart, AreaChart, BarChart, DonutChart, FunnelChart, WaterfallChart, Heatmap, Sparkline, type ChartSeries"
      api={API.charts}
    >
      <div className="sg__grid2">
        <Card title="Billed by plan" description="Trailing twelve months, stacked">
          <AreaChart
            title="Billed revenue by plan, trailing twelve months"
            description={`Total billed ${fmt.money(data.totalBilled)} across ${PLANS.length} plans.`}
            series={data.billedByPlan}
            categories={data.monthLabels}
            valueFormat={moneyAxis}
            height={250}
          />
        </Card>
        <Card title="Collected vs. outstanding" description="Cash in the door against open receivable">
          <BarChart
            title="Collected versus outstanding by month"
            description="Two series compared month over month."
            stacked
            series={[
              { id: 'collected', label: 'Collected', values: data.collectedSeries, color: 'var(--viz-6)' },
              { id: 'open', label: 'Outstanding', values: data.openSeries, color: 'var(--viz-3)' },
            ]}
            categories={data.monthLabels}
            valueFormat={moneyAxis}
            height={250}
          />
        </Card>
      </div>

      <Card title="MRR movement" description="Opening balance, signed movements, closing balance — the shape a finance team asks for first">
        <WaterfallChart
          title="Monthly recurring revenue movement"
          description="Opening and closing balances with new, expansion, contraction and churn between them."
          items={data.movement}
          valueFormat={moneyAxis}
          height={280}
        />
      </Card>

      <div className="sg__grid2">
        <Card title="Revenue mix" description="Share of billed revenue by plan">
          <DonutChart
            title="Billed revenue by plan"
            description="Share of total billed revenue across the three plans."
            data={data.planTotals}
            valueFormat={moneyAxis}
            centerValue={fmt.moneyCompact(data.totalBilled)}
            centerLabel="Billed"
          />
        </Card>
        <Card title="Invoice lifecycle" description="Where invoices stop moving">
          <FunnelChart
            title="Invoice lifecycle funnel"
            description="Counts at each stage from issued through paid on time."
            stages={data.funnel}
          />
        </Card>
      </div>

      <div className="sg__grid2">
        <Card title="Telemetry ingested" description="Metered units per month, with the current period dashed">
          <LineChart
            title="Metered telemetry units per month"
            description="A single series of monthly ingestion volume."
            series={[{ id: 'units', label: 'Units', values: data.usageByMonth }]}
            categories={data.monthLabels}
            valueFormat={(v) => fmt.compact(v)}
            fill
            partialLast
            height={230}
          />
        </Card>
        <Card title="Billed total" description="All plans combined, grouped bars">
          <BarChart
            title="Total billed per month"
            description="Combined billed revenue across all plans, by month."
            series={[{ id: 'total', label: 'Billed', values: totalSeries }]}
            categories={data.monthLabels}
            valueFormat={moneyAxis}
            reference={{ value: totalSeries.reduce((a, b) => a + b, 0) / (totalSeries.length || 1), label: 'Average' }}
            height={230}
          />
        </Card>
      </div>

      <div className="sg__grid2">
        <Card title="Invoice volume" description="Issue day against month — where the billing run lands">
          <Heatmap
            title="Invoices issued by weekday and month"
            description="Counts of invoices issued, by weekday across the last twelve months."
            rows={data.heat.rows}
            columns={data.heat.columns}
            values={data.heat.values}
          />
        </Card>
        <Card title="Top accounts" description="Billed revenue, horizontal bars">
          <BarChart
            title="Top accounts by billed revenue"
            description="The six accounts with the highest lifetime billed revenue."
            horizontal
            series={[{ id: 'billed', label: 'Billed', values: data.topAccounts.map((a) => a.billed) }]}
            categories={data.topAccounts.map((a) => a.company)}
            valueFormat={moneyAxis}
            height={230}
            legend={false}
          />
        </Card>
      </div>

      <Demo title="Sparklines" note="For table cells and metric tiles; they colour themselves by trend."
        code={"<Sparkline values={monthlyTotals} autoTone width={92} height={28} />"}
      >
        <Inline gap={9} wrap>
          {data.topAccounts.slice(0, 4).map((account, i) => (
            <Inline gap={4} key={account.company}>
              <Stack gap={0}>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{account.company}</span>
                <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)' }}>{fmt.moneyCompact(account.billed)}</span>
              </Stack>
              <Sparkline values={data.billedByPlan[i % 3].values} autoTone label={`${account.company} trend`} />
            </Inline>
          ))}
        </Inline>
      </Demo>
    </Doc>
  );
}

function OverlaysSection({ data }: { data: Derived }) {
  const fmt = useFormat();
  const { invoice, total } = data.featured;
  const topAccount = data.topAccounts[0];
  const pastDueCount = data.invoices.filter((i) => i.status === 'past_due').length;
  const accountMenu = useAccountMenu(data.topAccounts);
  const toast = useToast();
  const [modal, setModal] = useState<null | 'sm' | 'md' | 'lg'>(null);
  const [drawer, setDrawer] = useState<null | 'right' | 'bottom'>(null);
  const [confirm, setConfirm] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [popover, setPopover] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const popAnchor = useRef<HTMLButtonElement>(null);
  const menuAnchor = useRef<HTMLButtonElement>(null);

  const commands: CommandEntry[] = [
    { id: 'c1', title: 'Create invoice', subtitle: 'Draft a one-off invoice', group: 'Create', icon: <Icons.invoice size={14} />, shortcut: 'mod+i', onSelect: () => toast.info('Create invoice') },
    { id: 'c2', title: 'New subscription', subtitle: 'Start a plan on an account', group: 'Create', icon: <Icons.repeat size={14} />, onSelect: () => toast.info('New subscription') },
    { id: 'c3', title: topAccount.company, subtitle: `Company · ${formatNumber(topAccount.invoices)} invoices · ${fmt.moneyCompact(topAccount.billed)} billed`, group: 'Jump to', icon: <Icons.building size={14} />, onSelect: () => toast.info(topAccount.company) },
    { id: 'c4', title: topAccount.owner, subtitle: `Teammate · owns ${topAccount.company}`, group: 'Jump to', icon: <Icons.user size={14} />, onSelect: () => toast.info(topAccount.owner) },
    { id: 'c5', title: 'Run dunning now', subtitle: `${formatNumber(pastDueCount)} invoices in the retry queue`, group: 'Automation', icon: <Icons.zap size={14} />, onSelect: () => toast.warning('Dunning queued') },
    { id: 'c6', title: 'Toggle dark mode', group: 'Workspace', icon: <Icons.moon size={14} />, shortcut: 'mod+shift+l', onSelect: () => toast.info('Theme toggled') },
  ];

  return (
    <Doc
      id="overlays"
      title="Overlays"
      description="Focus is trapped, Escape peels exactly one layer, background scroll is locked, and a menu opened inside a modal always paints above it."
      imports="Modal, ConfirmDialog, Drawer, Popover, Menu, MenuButton, Tooltip, CommandList, useToast"
      api={API.overlays}
    >
      <Demo title="Dialogs and panels"
        code={"const dialog = useDisclosure();\n\n<Button onClick={dialog.open}>Edit invoice</Button>\n<Modal\n  open={dialog.isOpen}\n  onClose={dialog.close}\n  title=\"Edit INV-02481\"\n  size=\"md\"\n  footer={<><Button variant=\"ghost\" onClick={dialog.close}>Cancel</Button><Button variant=\"primary\">Save</Button></>}\n>\n  …\n</Modal>"}
      >
        <Inline gap={4} wrap>
          <Button variant="secondary" onClick={() => setModal('sm')}>Small modal</Button>
          <Button variant="secondary" onClick={() => setModal('md')}>Medium modal</Button>
          <Button variant="secondary" onClick={() => setModal('lg')}>Large modal</Button>
          <Button variant="secondary" onClick={() => setDrawer('right')}>Right drawer</Button>
          <Button variant="secondary" onClick={() => setDrawer('bottom')}>Bottom sheet</Button>
          <Button variant="danger" onClick={() => setConfirm(true)}>Destructive confirm</Button>
        </Inline>
        <Inline gap={4} wrap>
          <Button ref={popAnchor} variant="secondary" iconLeft={<Icons.filter size={14} />} onClick={() => setPopover((v) => !v)}>Popover</Button>
          <Tooltip content="Usage is rated when the period closes, not as it arrives." shortcut="mod+u">
            <Button variant="ghost" iconLeft={<Icons.help size={14} />}>Hover or focus me</Button>
          </Tooltip>
        </Inline>
        <Inline gap={4} wrap>
          <Button variant="secondary" onClick={() => toast.success('Invoice sent', `${invoice.number} was emailed to ap@${invoice.company.toLowerCase().replace(/[^a-z]/g, '')}.io`)}>Success toast</Button>
          <Button variant="secondary" onClick={() => toast.error('Card declined', 'insufficient_funds · retry scheduled for tomorrow 09:00')}>Danger toast</Button>
          <Button variant="secondary" onClick={() => toast.show({ title: 'Export ready', description: `${formatNumber(data.invoices.length)} invoices as CSV`, tone: 'info', action: { label: 'Download', onClick: () => undefined } })}>Toast with action</Button>
          <Button
            variant="secondary"
            onClick={() => void toast.promise(new Promise((r) => setTimeout(r, 1600)), {
              loading: 'Recalculating revenue…',
              success: 'Revenue recalculated',
              error: 'Recalculation failed',
            })}
          >
            Promise toast
          </Button>
        </Inline>
      </Demo>

      <Demo
        title="Menus"
        note="The highlighted row is the focused element. Every row here really fires — the toast says which one."
        code={"<Menu\n  open={open}\n  onClose={() => setOpen(false)}\n  anchor={trigger}\n  ariaLabel=\"Account actions\"\n  sections={[\n    { id: 'edit', items: [{ id: 'rename', label: 'Rename account', shortcut: 'mod+e', onSelect: rename }] },\n    { id: 'billing', label: 'Billing', items: [{ id: 'auto', label: 'Auto-charge on renewal', checked, onSelect: toggle }] },\n  ]}\n/>\n\n// or trigger and menu in one, for the row-actions case:\n<MenuButton label=\"Row actions\" sections={sections} />"}
      >
        <Inline gap={4} wrap>
          <Button ref={menuAnchor} variant="secondary" iconRight={<ChevronDownIcon size={14} />} onClick={() => setMenuOpen((v) => !v)}>Menu with sections</Button>
          <MenuButton label="Row actions" sections={accountMenu} />
        </Inline>
        <Inline gap={6} wrap>
          <span className="sg__label">Keyboard</span>
          <span className="sg__demonote"><Kbd>↑</Kbd> <Kbd>↓</Kbd> move</span>
          <span className="sg__demonote">type to jump — “del”, “auto”</span>
          <span className="sg__demonote"><Kbd>↵</Kbd> fire the row</span>
          <span className="sg__demonote"><Kbd>→</Kbd> submenu, <Kbd>←</Kbd> back</span>
          <span className="sg__demonote"><Kbd combo="esc" /> peel one layer</span>
        </Inline>
      </Demo>

      <Demo title="Command palette" note="The primitive behind ⌘K. Type to filter, arrows to move, Enter to run." stage="flush">
        <div style={{ height: 396 }}>
          <CommandList entries={commands} autoFocus={false} />
        </div>
      </Demo>

      <Modal
        open={modal !== null}
        onClose={() => setModal(null)}
        size={modal ?? 'md'}
        title="Change the billing period"
        description="Northwind Robotics is on a monthly cycle anchored to the 14th."
        footer={
          <>
            <Button variant="ghost" onClick={() => setModal(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => { setModal(null); toast.success('Billing period updated'); }}>Save changes</Button>
          </>
        }
      >
        <Stack gap={6}>
          <Field label="Interval">
            <Select
              value="month"
              onChange={() => undefined}
              aria-label="Interval"
              options={[{ value: 'month', label: 'Monthly' }, { value: 'quarter', label: 'Quarterly' }, { value: 'year', label: 'Annual' }]}
            />
          </Field>
          <Field label="Proration">
            <RadioGroup
              label="Proration"
              value="create"
              onChange={() => undefined}
              options={[
                { value: 'create', label: 'Create prorations', hint: 'A credit and a charge line are added to the next invoice.' },
                { value: 'none', label: 'None', hint: 'The change takes effect at the next renewal.' },
              ]}
            />
          </Field>
          <Banner tone="info" title="This changes 3 open subscriptions">
            Renewal dates move to the 1st. Nothing is charged until the next cycle.
          </Banner>
        </Stack>
      </Modal>

      <Drawer
        open={drawer !== null}
        onClose={() => setDrawer(null)}
        side={drawer ?? 'right'}
        title={invoice.number}
        description={`${invoice.company} · due ${fmt.date(invoice.dueAt)}`}
        footer={<><Button variant="ghost" onClick={() => setDrawer(null)}>Close</Button><Button variant="primary">Collect payment</Button></>}
      >
        <Stack gap={7}>
          <Inline gap={4}>
            <StatusBadge status="past_due" />
            <Badge tone="neutral">Net 30</Badge>
            <Badge tone="teal" icon={<Icons.sparkles size={11} />}>AI drafted reminder</Badge>
          </Inline>
          <DescriptionList
            items={[
              { term: 'Amount due', value: fmt.money(total) },
              { term: 'Issued', value: fmt.date(invoice.issuedAt) },
              { term: 'Due', value: fmt.date(invoice.dueAt) },
              { term: 'Owner', value: invoice.owner.name },
            ]}
          />
          <Divider label="Activity" />
          <Timeline
            entries={[
              { id: 'a', title: 'Retry scheduled', time: 'Tomorrow 09:00', tone: 'warning', icon: <Icons.clock size={13} /> },
              { id: 'b', title: 'Payment failed', description: 'insufficient_funds', time: '2 days ago', tone: 'danger', icon: <XCircleIcon size={13} /> },
              { id: 'c', title: 'Invoice sent', time: fmt.date(invoice.issuedAt), tone: 'neutral', icon: <Icons.send size={13} /> },
            ]}
          />
        </Stack>
      </Drawer>

      <ConfirmDialog
        open={confirm}
        onCancel={() => setConfirm(false)}
        loading={confirming}
        confirmPhrase="VOID"
        title={`Void invoice ${invoice.number}?`}
        body="Voiding cancels the amount owed and cannot be undone. The customer is notified."
        confirmLabel="Void invoice"
        onConfirm={() => {
          setConfirming(true);
          setTimeout(() => { setConfirming(false); setConfirm(false); toast.success('Invoice voided'); }, 900);
        }}
      />

      <Popover open={popover} onClose={() => setPopover(false)} anchor={popAnchor} title="Filter invoices" placement="bottom-start">
        <Stack gap={5} style={{ minWidth: 240 }}>
          <Checkbox checked label="Past due only" onChange={() => undefined} />
          <Checkbox checked={false} label="Has open dispute" onChange={() => undefined} />
          <Field label="Minimum amount">
            <MoneyInput value={50000} onChange={() => undefined} aria-label="Minimum amount" />
          </Field>
          <Inline gap={3} justify="end">
            <Button size="sm" variant="ghost" onClick={() => setPopover(false)}>Reset</Button>
            <Button size="sm" variant="primary" onClick={() => setPopover(false)}>Apply</Button>
          </Inline>
        </Stack>
      </Popover>

      <Menu open={menuOpen} onClose={() => setMenuOpen(false)} anchor={menuAnchor} sections={accountMenu} ariaLabel="Account actions" />
    </Doc>
  );
}

function FeedbackSection({ data }: { data: Derived }) {
  const fmt = useFormat();
  const { invoice, total } = data.featured;
  const topAccount = data.topAccounts[0];
  const pastDueCount = data.invoices.filter((i) => i.status === 'past_due').length;
  const pastDueAccounts = new Set(data.invoices.filter((i) => i.status === 'past_due').map((i) => i.company)).size;
  const periodEnd = new Date(fmt.now());
  const closes = Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() + 1, 0);

  return (
    <Doc
      id="feedback"
      title="Feedback"
      description="Loading, empty and error states are designed first — they are what a user sees on their first day and on the worst day."
      imports="Banner, DismissibleBanner, EmptyState, ErrorBoundary, ErrorState, Skeleton, SkeletonText, Spinner"
      api={API.feedback}
    >
      <Demo title="Banners"
        code={"<Banner tone=\"warning\" title=\"Two payment methods expire this month\" actions={<Button size=\"sm\">Review</Button>}>\n  Halden Metalworks and Orbit Foods both bill on the 1st.\n</Banner>"}
      >
        <Banner tone="info" title="Usage is metered hourly">
          Charges for the current period are estimates until it closes on {fmt.date(closes)}.
        </Banner>
        <Banner tone="success" title="Payment collected" actions={<Button size="sm" variant="secondary">View receipt</Button>}>
          {fmt.money(total)} settled by ACH from {invoice.company}.
        </Banner>
        <Banner tone="warning" title={`${formatNumber(pastDueAccounts)} accounts have an invoice past due`}>
          Dunning retries them automatically; accounts that exhaust the schedule move to uncollectible.
        </Banner>
        <DismissibleBanner tone="danger" title="Webhook endpoint failing">
          Every delivery attempt to https://hooks.northwind.io/ain has failed since this morning. Deliveries pause after 24 hours.
        </DismissibleBanner>
        <Banner tone="neutral" compact>Read-only: you are viewing a historical version of this invoice.</Banner>
      </Demo>
      <div className="sg__grid2">
        <Demo title="Loading">
          <Inline gap={7}>
            {[14, 16, 20, 28].map((s) => <Spinner key={s} size={s} />)}
          </Inline>
          <Divider />
          <Inline gap={5} align="start">
            <Skeleton variant="circle" width={36} height={36} />
            <div style={{ flex: 1 }}><SkeletonText lines={3} /></div>
          </Inline>
          <Inline gap={5}>
            <Skeleton width={120} height={28} variant="block" />
            <Skeleton width={80} height={28} variant="block" />
          </Inline>
        </Demo>
        <Demo title="Error">
          <ErrorState
            title="We could not load subscriptions"
            message="The billing service returned a gateway timeout. Nothing was charged and nothing changed."
            code="api_error · gateway_timeout"
            requestId="req_8Fx2Lm41Qp"
            action={<Button variant="primary" iconLeft={<Icons.refresh size={14} />}>Try again</Button>}
            secondaryAction={<Button variant="ghost">Contact support</Button>}
          />
        </Demo>
      </div>
      <Demo title="Empty">
        <EmptyState
          title="No invoices yet"
          body="The first invoice is created automatically when Northwind Robotics’ trial converts on 14 May. You can also raise one now."
          action={<Button variant="primary" iconLeft={<Icons.plus size={15} />}>Create an invoice</Button>}
          secondaryAction={<Button variant="ghost" iconLeft={<Icons.book size={14} />}>Read the billing guide</Button>}
        />
      </Demo>
    </Doc>
  );
}

function NavigationSection() {
  const [tab, setTab] = useState<'overview' | 'invoices' | 'usage' | 'settings'>('overview');
  const [pill, setPill] = useState<'all' | 'mine' | 'unassigned'>('all');
  const [page, setPage] = useState(4);

  return (
    <Doc
      id="navigation"
      title="Navigation"
      description="Tabs switch a view without changing the page; steps move forward through one. Arrow keys work in both."
      imports="Tabs, TabPanel, Breadcrumbs, Pagination, Steps, Accordion, Collapsible, AnchorNav"
      api={API.navigation}
    >
      <div className="sg__grid2">
        <Demo title="Tabs — underline"
        code={"<Tabs\n  aria-label=\"Invoice sections\"\n  tabs={[{ id: 'lines', label: 'Lines', count: 6 }, { id: 'events', label: 'Events' }]}\n  value={tab}\n  onChange={setTab}\n/>\n<TabPanel id=\"lines\" active={tab === 'lines'}>…</TabPanel>"}
      >
          <Tabs
            aria-label="Account sections"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'overview', label: 'Overview' },
              { id: 'invoices', label: 'Invoices', count: 42 },
              { id: 'usage', label: 'Usage', count: 3 },
              { id: 'settings', label: 'Settings', disabled: true },
            ]}
          />
          <TabPanel id={tab} active>
            <p style={{ fontSize: 'var(--text-md)', color: 'var(--text-secondary)', paddingTop: 'var(--space-5)' }}>
              Showing the <strong>{tab}</strong> panel.
            </p>
          </TabPanel>
        </Demo>
        <Demo title="Tabs — pill">
          <Tabs
            variant="pill"
            aria-label="Assignment filter"
            value={pill}
            onChange={setPill}
            tabs={[
              { id: 'all', label: 'All', count: 1240 },
              { id: 'mine', label: 'Assigned to me', count: 38 },
              { id: 'unassigned', label: 'Unassigned', count: 7 },
            ]}
          />
        </Demo>
      </div>

      <Demo title="Breadcrumbs & pagination">
        <Breadcrumbs
          items={[
            { label: 'Workspace', onClick: () => undefined },
            { label: 'Revenue', onClick: () => undefined },
            { label: 'Invoices', onClick: () => undefined },
            { label: 'Halden Metalworks', onClick: () => undefined },
            { label: 'INV-02481' },
          ]}
        />
        <Divider />
        <Pagination page={page} pageCount={50} onChange={setPage} total={1240} pageSize={25} />
      </Demo>

      <div className="sg__grid2">
        <Demo title="Steps">
          <Steps
            current={2}
            steps={[
              { id: '1', label: 'Account' },
              { id: '2', label: 'Plan' },
              { id: '3', label: 'Payment' },
              { id: '4', label: 'Review' },
            ]}
          />
          <Divider />
          <Steps
            orientation="vertical"
            current={1}
            steps={[
              { id: 'a', label: 'Connect your ledger', description: 'Xero connected 4 days ago' },
              { id: 'b', label: 'Map revenue accounts', description: '3 of 7 mapped' },
              { id: 'c', label: 'Enable automatic posting', description: 'Waiting on the mapping above' },
            ]}
          />
        </Demo>
        <Demo title="Accordion">
          <Accordion
            defaultOpen={['proration']}
            items={[
              {
                id: 'proration',
                title: 'How is proration calculated?',
                description: 'Exact rational arithmetic, rounded once',
                content: 'Ain multiplies the plan amount by the exact remaining fraction of the period using BigInt rationals, then rounds to minor units a single time at the boundary. Two mid-cycle changes in the same period never drift by a cent.',
              },
              { id: 'dunning', title: 'What happens when a payment fails?', content: 'The invoice moves to past due and a dunning schedule is enqueued as a job. Each retry is a row with a run_at, so advancing the workspace clock replays the whole sequence exactly.' },
              { id: 'credits', title: 'Do prepaid credits expire?', content: 'Only if the grant says so. Expiry is a scheduled job on the grant, and expired credits post a ledger entry rather than vanishing.' },
            ]}
          />
          <Collapsible title="Show the raw webhook payload">
            <pre style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
{`{ "type": "invoice.payment_failed",
  "data": { "invoice": "in_1P9xQ2", "attempt": 2 } }`}
            </pre>
          </Collapsible>
        </Demo>
      </div>
      <ResilienceDemo />
    </Doc>
  );
}

/**
 * A component that throws the way the real bug did: a timestamp no `Date` can
 * hold, handed straight to a formatter. It is here so the boundary around it can
 * be seen working, not described.
 */
function BrokenCell({ broken }: { broken: boolean }) {
  const fmt = useFormat();
  if (broken) {
    // Exactly what `?filter=issuedAt~date~between~-1e17,1e17` used to reach.
    return <span>{new Intl.DateTimeFormat(fmt.locale, { timeZone: 'UTC' }).format(1e17)}</span>;
  }
  return (
    <Stack gap={2}>
      <KeyValue label="Renews" value={fmt.date(fmt.now() + 21 * DAY)} />
      <KeyValue label="Next invoice" value="Estimated from usage to date" />
      <KeyValue label="Committed" value={fmt.money(4_800_00)} strong />
    </Stack>
  );
}

function ResilienceDemo() {
  const [broken, setBroken] = useState(false);
  return (
    <Demo
      title="Error boundary"
      note="Break the panel, then recover it. The page around it never reloads."
      code={"<ErrorBoundary\n  title=\"This section stopped rendering\"\n  message=\"The rest of the page is still live.\"\n  resetKeys={[recordId]}          // navigating away clears it on its own\n  onReset={() => setState(EMPTY_TABLE_STATE)}\n>\n  <RiskyThing />\n</ErrorBoundary>\n\n// Page and DataTable already wrap their children in one, so a module never\n// has to remember: a throw costs a panel, not the whole app."}
    >
      <Inline gap={4} wrap>
        <Button
          size="sm"
          variant={broken ? 'secondary' : 'danger'}
          iconLeft={<AlertTriangleIcon size={14} />}
          onClick={() => setBroken((v) => !v)}
        >
          {broken ? 'Repair the panel' : 'Make the panel throw'}
        </Button>
        <span className="sg__demonote">
          {broken
            ? 'The panel below threw a RangeError while rendering. Everything else on this page still works — scroll it, open a menu, switch the theme.'
            : 'The panel below formats a date. Break it and it is handed an instant no calendar can represent.'}
        </span>
      </Inline>
      <Card title="Subscription" description="Fleet Enterprise, billed yearly">
        <ErrorBoundary
          title="This panel stopped rendering"
          message="It was handed a value it could not draw. Nothing else on the page was affected — repair it above, or reset the panel here."
          retryLabel="Reset the panel"
          resetKeys={[broken]}
        >
          <BrokenCell broken={broken} />
        </ErrorBoundary>
      </Card>
    </Demo>
  );
}

function LayoutSection() {
  return (
    <Doc
      id="layout"
      title="Layout"
      description="Page owns the header, the actions and the width; everything below it is Cards, Sections and a 12-column Grid."
      imports="Page, Section, Card, Panel, Split, Stack, Inline, Grid, Divider, ScrollArea, Toolbar"
      api={API.layout}
    >
      <Demo title="Cards"
        code={"<Card title=\"Plan\" description=\"Fleet Enterprise, billed yearly\" actions={<Button size=\"sm\" variant=\"ghost\">Change</Button>}>\n  <DescriptionList items={items} />\n</Card>"}
      >
        <div className="sg__grid3">
          <Card title="Default" description="Border and a hairline shadow">Body content sits on the surface colour.</Card>
          <Card variant="raised" title="Raised">For things that float: previews, drag targets.</Card>
          <Card variant="sunken" title="Sunken">For nested content inside a card.</Card>
          <Card variant="ghost" title="Ghost">Dashed — a placeholder or a drop zone.</Card>
          <Card interactive selected title="Selected" description="Interactive and chosen">Renders as a button with a pressed state.</Card>
          <Card title="With a footer" footer={<><Icons.clock size={13} /> Updated 4 minutes ago</>}>Footers carry metadata, never actions.</Card>
        </div>
      </Demo>
      <Demo title="Split, panel and toolbar" stage="sunken">
        <Toolbar aria-label="List controls">
          <Button size="sm" variant="secondary" iconLeft={<Icons.plus size={14} />}>New</Button>
          <Button size="sm" variant="ghost" iconLeft={<Icons.filter size={14} />}>Filter</Button>
          <span className="u-spacer" />
          <SegmentedControl
            size="sm"
            aria-label="Density"
            value="comfortable"
            onChange={() => undefined}
            options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]}
          />
        </Toolbar>
        <Split
          asideWidth={260}
          aside={
            <Panel title="Filters" actions={<IconButton size="sm" label="Reset filters" icon={<FilterXIcon size={14} />} />}>
              <div style={{ padding: 'var(--space-5)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                <Checkbox checked label="Past due" onChange={() => undefined} />
                <Checkbox checked={false} label="Has credit" onChange={() => undefined} />
                <Checkbox checked={false} label="Auto-charge off" onChange={() => undefined} />
              </div>
            </Panel>
          }
        >
          <Card title="Main column">
            <Grid columns={12} gap={4}>
              {[6, 6, 4, 4, 4, 12].map((span, i) => (
                <div key={i} className="sg__gridcell" style={{ gridColumn: `span ${span} / span ${span}` }}>span {span}</div>
              ))}
            </Grid>
            <div style={{ marginTop: 'var(--space-6)' }}>
              <Divider label="Scroll area" />
              <ScrollArea maxHeight={120} fade style={{ marginTop: 'var(--space-4)' }}>
                <Stack gap={3}>
                  {COMPANIES.slice(0, 12).map((c) => (
                    <Inline key={c} gap={4}><Avatar name={c} size={20} square />{c}</Inline>
                  ))}
                </Stack>
              </ScrollArea>
            </div>
          </Card>
        </Split>
      </Demo>
    </Doc>
  );
}

/* ========================================================================== *
 * The page
 * ========================================================================== */

function useActiveSection(ids: string[]): string {
  const [active, setActive] = useState(ids[0] ?? '');
  const key = ids.join(',');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-80px 0px -70% 0px' },
    );
    for (const id of key.split(',')) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [key]);
  return active;
}

function DesignSystemPage() {
  const fmt = useFormat();
  const [now] = useState(() => fmt.now());
  const invoices = useMemo(() => buildInvoices(now), [now]);
  const data = useMemo(() => derive(invoices, now), [invoices, now]);
  const { theme, setTheme, density, setDensity } = useThemeControls();
  const active = useActiveSection(SECTIONS.map((s) => s.id));
  const [dir, setDir] = useState<'ltr' | 'rtl'>('ltr');

  // Mirroring the document, not just this panel, is the only honest test: the
  // portals — menus, popovers, toasts, the drawer — hang off <body>.
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute('dir');
    root.setAttribute('dir', dir);
    return () => { if (previous) root.setAttribute('dir', previous); else root.removeAttribute('dir'); };
  }, [dir]);

  const groups = useMemo(() => {
    const map = new Map<string, typeof SECTIONS>();
    for (const section of SECTIONS) {
      const arr = map.get(section.group) ?? [];
      arr.push(section);
      map.set(section.group, arr);
    }
    return [...map.entries()];
  }, []);

  // Counted from the barrel itself, so the number can never drift from reality.
  const componentCount = Object.entries(DesignSystem)
    .filter(([name, value]) => /^[A-Z]/.test(name) && !name.endsWith('Icon') && name !== 'Icons' && typeof value === 'function')
    .length;

  return (
    <ToastProvider>
      <div className="sg">
        <a className="sg__skip" href="#main">Skip to the components</a>

        <aside className="sg__side">
          <div className="sg__brand">
            <span className="sg__mark"><Icons.sparkles size={17} /></span>
            <span className="sg__brandtext">
              <span className="sg__brandname">Ain Design</span>
              <span className="sg__brandsub">v1.0</span>
            </span>
          </div>
          <nav className="sg__nav" aria-label="Style guide sections">
            {groups.map(([group, items]) => (
              <div key={group}>
                <div className="sg__navgroup">{group}</div>
                {items.map((section) => (
                  <a
                    key={section.id}
                    href={`#${section.id}`}
                    className={cx('sg__navlink', active === section.id && 'is-active')}
                    aria-current={active === section.id ? 'true' : undefined}
                  >
                    {section.label}
                  </a>
                ))}
              </div>
            ))}
          </nav>
          <div className="sg__sidefoot">
            Built with Node 22, React 18 and TypeScript. No component library, no icon font, no charting dependency.
          </div>
        </aside>

        <main className="sg__main" id="main" tabIndex={-1}>
          <header className="sg__topbar">
            <span className="sg__crumb">Ain · Design system</span>
            <span className="u-spacer" />
            <SegmentedControl
              size="sm"
              aria-label="Writing direction"
              value={dir}
              onChange={(d) => setDir(d)}
              options={[
                { value: 'ltr', label: 'LTR', title: 'Left to right' },
                { value: 'rtl', label: 'RTL', title: 'Right to left — every component mirrors through logical properties' },
              ]}
            />
            <SegmentedControl
              size="sm"
              aria-label="Row density"
              value={density}
              onChange={(d) => setDensity(d)}
              options={[
                { value: 'comfortable', label: 'Comfortable' },
                { value: 'compact', label: 'Compact' },
              ]}
            />
            <SegmentedControl
              size="sm"
              aria-label="Colour theme"
              value={theme}
              onChange={(t) => setTheme(t)}
              options={[
                { value: 'light', label: <Icons.sun size={14} />, title: 'Light theme' },
                { value: 'dark', label: <Icons.moon size={14} />, title: 'Dark theme' },
              ]}
            />
          </header>

          <div className="sg__content">
            <section className="sg__hero">
              <Badge tone="brand" pill icon={<Icons.layers size={11} />}>Design system</Badge>
              <h1 className="sg__herotitle">The parts every Ain screen is built from</h1>
              <p className="sg__herobody">
                One palette, two themes, and a component for every job a revenue or customer screen has to do —
                from a money input that never touches a float to a table that stays fluid at a thousand rows.
                Everything below is the real system: the same imports the product uses, rendered live.
              </p>
              <div className="sg__herostats">
                <div className="sg__herostat">
                  <span className="sg__herostatv">{componentCount}</span>
                  <span className="sg__herostatl">Components</span>
                </div>
                <div className="sg__herostat">
                  <span className="sg__herostatv">{ICON_NAMES.length}</span>
                  <span className="sg__herostatl">Icons</span>
                </div>
                <div className="sg__herostat">
                  <span className="sg__herostatv">{CHART_TYPES.length}</span>
                  <span className="sg__herostatl">Chart types</span>
                </div>
                <div className="sg__herostat">
                  <span className="sg__herostatv">0</span>
                  <span className="sg__herostatl">UI dependencies</span>
                </div>
              </div>
              <Banner tone="neutral" compact>
                Sample data: {formatNumber(data.invoices.length)} invoices generated in the browser from a fixed seed.
                Every total, chart and percentage on this page is computed from those rows — nothing is typed in.
              </Banner>
            </section>

            <Foundations theme={theme} />
            <Typography />
            <SpaceAndElevation />
            <IconsSection />
            <ButtonsSection />
            <TogglesSection />
            <FieldsSection />
            <PickersSection />
            <DisplaySection data={data} />
            <TableSection data={data} />
            <ChartsSection data={data} />
            <OverlaysSection data={data} />
            <FeedbackSection data={data} />
            <NavigationSection />
            <LayoutSection />
          </div>
        </main>
      </div>
    </ToastProvider>
  );
}

export const routes: RouteDef[] = [
  { path: '/design', element: DesignSystemPage, title: 'Design system', layout: 'bare' },
];

export const nav: NavItem[] = [
  { id: 'design-system', label: 'Design system', to: '/design', group: 'settings', order: 90, icon: Icons.sparkles },
];
