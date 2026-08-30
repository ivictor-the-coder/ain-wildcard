import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  currencySymbol, formatCompact, formatDate, formatDelta, formatFileSize, formatMoney,
  formatNumber, formatOrdinal, formatPercent, formatRelative, humanize, initials, plural,
  pluralize, titleCase, truncateMiddle, createFormatter, formatDateRange,
} from '../src/client/design/format';
import { hashString, toneOf, toneForStatus, vizColor, AVATAR_TONE_COUNT } from '../src/client/design/color';
import {
  arcPath, areaPath, bandScale, extentOf, funnelLayout, heatScale, linePath, linearScale,
  niceTicks, percentChange, pieLayout, pointScale, smoothPath, sparklinePoints, stackSeries,
  stackedMax, trendSlope, waterfallLayout,
} from '../src/client/design/chart-core';
import {
  activeFilterCount, compareValues, dateExtent, decodeFilters, decodeTableState, describeFilter,
  encodeFilters, encodeTableState, extendSelection, filterRows, fold, isFilterEmpty, matchesFilter,
  rangeBetween, searchRows, selectionState, sortRows, splitSelection, sumColumn, toggleId,
  toggleSort, uniqueValues, valueCounts, type FilterMap,
} from '../src/client/design/table-core';
import { contrastGrade, contrastRatio, parseColor, relativeLuminance } from '../src/client/design/color';
import { readFileSync } from 'node:fs';
import { computePosition } from '../src/client/design/position';
import {
  addDays, addMonths, monthMatrix, nextRange, RANGE_PRESETS, startOfMonthUtc, weekdayLabels,
} from '../src/client/design/calendar-core';
import { computeWindow, matchesHotkey } from '../src/client/design/hooks';
import { ICON_NAMES, Icons, iconByName } from '../src/client/design/icons';
import { rankCommands } from '../src/client/design/overlays-core';

const DAY = 86_400_000;

/* ------------------------------- formatting ------------------------------ */

describe('format', () => {
  it('formats money from integer minor units', () => {
    assert.equal(formatMoney({ amount: 124800, currency: 'usd' }), '$1,248.00');
    assert.equal(formatMoney(-2500, { currency: 'usd' }), '-$25.00');
    assert.equal(formatMoney({ amount: 124800, currency: 'usd' }, { trimZeroFraction: true }), '$1,248');
  });

  it('respects zero-decimal currencies', () => {
    assert.equal(formatMoney({ amount: 1248, currency: 'jpy' }), '¥1,248');
  });

  it('never renders NaN', () => {
    assert.equal(formatNumber(Number.NaN), '—');
    assert.equal(formatMoney(Number.NaN, { currency: 'usd' }), '—');
    assert.equal(formatPercent(Number.POSITIVE_INFINITY), '—');
    assert.equal(formatFileSize(Number.NaN), '—');
  });

  it('formats compact numbers and percentages', () => {
    assert.equal(formatCompact(1240), '1.2K');
    assert.equal(formatCompact(3_400_000), '3.4M');
    assert.equal(formatPercent(0.184), '18%');
    assert.equal(formatPercent(0.184, { decimals: 1 }), '18.4%');
    assert.equal(formatPercent(42, { fraction: false }), '42%');
    assert.equal(formatDelta(0.124, { decimals: 1 }), '+12.4%');
    assert.equal(formatDelta(0.124, { decimals: 1, signDisplay: 'never' }), '12.4%');
    assert.equal(formatDelta(-0.03), '-3.0%');
  });

  it('formats file sizes on binary steps', () => {
    assert.equal(formatFileSize(900), '900 B');
    assert.equal(formatFileSize(1024), '1 KB');
    assert.equal(formatFileSize(1024 * 1024 * 5.5), '5.5 MB');
  });

  it('pluralises the words a billing product actually uses', () => {
    assert.equal(pluralize('invoice', 1), 'invoice');
    assert.equal(pluralize('invoice', 2), 'invoices');
    assert.equal(pluralize('company', 3), 'companies');
    assert.equal(pluralize('address', 2), 'addresses');
    assert.equal(plural(3, 'invoice'), '3 invoices');
    assert.equal(plural(1, 'company'), '1 company');
  });

  it('derives initials and human labels', () => {
    assert.equal(initials('Priya Raghavan'), 'PR');
    assert.equal(initials('Northwind'), 'NO');
    assert.equal(initials(''), '?');
    assert.equal(humanize('past_due'), 'Past due');
    assert.equal(titleCase('fleet_enterprise'), 'Fleet Enterprise');
    assert.equal(truncateMiddle('sub_9fQ2xLm41ZpR4tVwY', 12), 'sub_9…4tVwY');
    assert.equal(formatOrdinal(3), '3rd');
  });

  it('formats dates in the workspace timezone, not the browser one', () => {
    const ts = Date.UTC(2026, 4, 14, 23, 30);
    assert.equal(formatDate(ts, { timeZone: 'UTC' }), 'May 14, 2026');
    assert.equal(formatDate(null), '—');
    assert.equal(formatRelative(ts - 3 * DAY, ts), '3 days ago');
    assert.match(formatDateRange(Date.UTC(2026, 0, 1), Date.UTC(2026, 2, 31), { timeZone: 'UTC' }), /Jan 1 – Mar 31, 2026/);
  });

  it('exposes a bound formatter', () => {
    const fmt = createFormatter({ locale: 'en-US', currency: 'eur', timeZone: 'UTC' }, () => Date.UTC(2026, 4, 14));
    assert.equal(fmt.money(250000), '€2,500.00');
    assert.equal(fmt.percent(0.5), '50%');
    assert.equal(fmt.plural(2, 'invoice'), '2 invoices');
    assert.equal(fmt.symbol(), '€');
    assert.equal(currencySymbol('usd'), '$');
  });
});

/* --------------------------------- colour -------------------------------- */

describe('colour', () => {
  it('hashes deterministically', () => {
    assert.equal(hashString('Priya Raghavan'), hashString('Priya Raghavan'));
    assert.notEqual(hashString('Priya Raghavan'), hashString('Marcus Oyelaran'));
  });

  it('keeps a person the same colour regardless of case or padding', () => {
    assert.equal(toneOf('  Priya Raghavan '), toneOf('priya raghavan'));
  });

  it('stays inside the token range', () => {
    for (const name of ['a', 'Halden Metalworks', 'u_dana', '', 'zzzz']) {
      const tone = toneOf(name);
      assert.ok(tone >= 1 && tone <= AVATAR_TONE_COUNT, `${name} -> ${tone}`);
    }
    assert.equal(vizColor(0), 'var(--viz-1)');
    assert.equal(vizColor(8), 'var(--viz-1)');
  });

  it('maps domain statuses onto semantic tones', () => {
    assert.equal(toneForStatus('paid'), 'success');
    assert.equal(toneForStatus('past_due'), 'warning');
    assert.equal(toneForStatus('Past Due'), 'warning');
    assert.equal(toneForStatus('uncollectible'), 'danger');
    assert.equal(toneForStatus('draft'), 'neutral');
    assert.equal(toneForStatus('something_unknown'), 'neutral');
  });
});

/* --------------------------------- charts -------------------------------- */

describe('chart geometry', () => {
  it('picks human axis ticks that cover the domain', () => {
    const ticks = niceTicks(0, 9432, 5);
    assert.ok(ticks[0] <= 0);
    assert.ok(ticks[ticks.length - 1] >= 9432);
    for (const t of ticks) assert.equal(Number.isFinite(t), true);
    const step = ticks[1] - ticks[0];
    for (let i = 1; i < ticks.length; i++) {
      assert.ok(Math.abs(ticks[i] - ticks[i - 1] - step) < 1e-6, 'ticks are evenly spaced');
    }
  });

  it('handles a flat series without collapsing the axis', () => {
    const ticks = niceTicks(5, 5, 4);
    assert.ok(ticks.length >= 2);
    assert.ok(ticks[ticks.length - 1] > ticks[0]);
  });

  it('scales linearly and inverts', () => {
    const y = linearScale([0, 100], [200, 0]);
    assert.equal(y(0), 200);
    assert.equal(y(100), 0);
    assert.equal(y(50), 100);
    assert.equal(Math.round(y.invert(100)), 50);
  });

  it('lays out bands and points', () => {
    const band = bandScale(4, [0, 400], 0.2);
    assert.equal(band.step, 100);
    assert.equal(band.bandwidth, 80);
    assert.equal(band.center(0), 50);
    assert.equal(band.indexAt(250), 2);
    assert.equal(band.indexAt(-40), 0);
    assert.equal(band.indexAt(9999), 3);
    const x = pointScale(3, [0, 100]);
    assert.deepEqual([x(0), x(1), x(2)], [0, 50, 100]);
  });

  it('computes extents including zero', () => {
    assert.deepEqual(extentOf([4, 9, 2]), { min: 0, max: 9 });
    assert.deepEqual(extentOf([]), { min: 0, max: 1 });
    const negative = extentOf([-4, -9]);
    assert.equal(negative.min, -9);
    assert.equal(negative.max, 0);
  });

  it('stacks series index by index', () => {
    const stacks = stackSeries([[1, 2], [3, 4]]);
    assert.deepEqual(stacks[0], [{ y0: 0, y1: 1 }, { y0: 0, y1: 2 }]);
    assert.deepEqual(stacks[1], [{ y0: 1, y1: 4 }, { y0: 2, y1: 6 }]);
    assert.equal(stackedMax([[1, 2], [3, 4]]), 6);
  });

  it('draws smooth curves that never overshoot the data', () => {
    const points = [{ x: 0, y: 10 }, { x: 10, y: 10 }, { x: 20, y: 0 }, { x: 30, y: 0 }];
    const d = smoothPath(points);
    const ys = [...d.matchAll(/[MC ,]-?[\d.]+ (-?[\d.]+)/g)].map((m) => Number(m[1]));
    for (const y of ys) assert.ok(y >= -0.01 && y <= 10.01, `control point ${y} stays in range`);
    assert.equal(linePath([]), '');
    assert.ok(areaPath(points, 20).endsWith('Z'));
  });

  it('closes a full-circle donut with two arcs', () => {
    const [slice] = pieLayout([10]);
    assert.ok(slice.fraction > 0.99);
    const d = arcPath(50, 50, 50, 30, slice.start, slice.end + 0.02);
    assert.ok(d.split('M').length > 2, 'a full circle is split into two arc commands');
    const slices = pieLayout([3, 1]);
    assert.ok(Math.abs(slices[0].fraction - 0.75) < 1e-9);
  });

  it('lays out an MRR waterfall from a running balance', () => {
    const bars = waterfallLayout([
      { label: 'Opening', value: 1000, kind: 'total' },
      { label: 'New', value: 300 },
      { label: 'Churn', value: -120 },
      { label: 'Closing', value: 1180, kind: 'total' },
    ]);
    assert.equal(bars[1].start, 1000);
    assert.equal(bars[1].end, 1300);
    assert.equal(bars[2].start, 1300);
    assert.equal(bars[2].end, 1180);
    assert.equal(bars[3].cumulative, 1180);
  });

  it('computes funnel step conversion and drop-off', () => {
    const stages = funnelLayout([
      { label: 'Issued', value: 1000 },
      { label: 'Viewed', value: 800 },
      { label: 'Paid', value: 600 },
    ]);
    assert.equal(stages[0].stepRate, 1);
    assert.equal(stages[1].stepRate, 0.8);
    assert.equal(stages[1].dropped, 200);
    assert.equal(stages[2].fraction, 0.6);
  });

  it('normalises heat values and clamps outliers', () => {
    const scale = heatScale([0, 1, 2, 3, 4, 100]);
    assert.equal(scale(0), 0);
    assert.ok(scale(100) <= 1);
    assert.ok(scale(2) > 0 && scale(2) < 1);
  });

  it('measures trend and period change', () => {
    assert.ok(trendSlope([1, 2, 3, 4]) > 0);
    assert.ok(trendSlope([4, 3, 2, 1]) < 0);
    assert.equal(trendSlope([2]), 0);
    assert.equal(percentChange(110, 100), 0.1);
    assert.equal(percentChange(1, 0), null);
    const pts = sparklinePoints([1, 5, 3], 100, 20);
    assert.equal(pts.length, 3);
    assert.ok(pts[1].y < pts[0].y, 'a larger value sits higher on screen');
  });
});

/* ---------------------------------- table -------------------------------- */

interface Row { id: string; company: string; amount: number; status: string; owner: string | null }
const rows: Row[] = [
  { id: 'a', company: 'Halden Metalworks', amount: 2400, status: 'paid', owner: 'Dana' },
  { id: 'b', company: 'Kestrel Logistics', amount: 900, status: 'open', owner: null },
  { id: 'c', company: 'Orbit Foods', amount: 15000, status: 'past_due', owner: 'Priya' },
  { id: 'd', company: 'Atlas Cold Chain', amount: 900, status: 'paid', owner: 'Dana' },
];
const access = (row: Row, columnId: string) => (row as unknown as Record<string, string | number | null>)[columnId];

describe('table model', () => {
  it('sorts blanks last in both directions', () => {
    const asc = sortRows(rows, { columnId: 'owner', direction: 'asc' }, access);
    const desc = sortRows(rows, { columnId: 'owner', direction: 'desc' }, access);
    assert.equal(asc[asc.length - 1].id, 'b');
    assert.equal(desc[desc.length - 1].id, 'b');
  });

  it('sorts stably on ties', () => {
    const sorted = sortRows(rows, { columnId: 'amount', direction: 'asc' }, access);
    assert.deepEqual(sorted.map((r) => r.id), ['b', 'd', 'a', 'c']);
  });

  it('compares numbers numerically and strings naturally', () => {
    assert.ok(compareValues(9, 10) < 0);
    assert.ok(compareValues('INV-9', 'INV-10') < 0);
    assert.equal(compareValues(null, undefined), 0);
    assert.ok(compareValues(new Date(1), new Date(2)) < 0);
  });

  it('cycles sort direction and back to none', () => {
    let sort = toggleSort(null, 'amount');
    assert.deepEqual(sort, { columnId: 'amount', direction: 'asc' });
    sort = toggleSort(sort, 'amount');
    assert.deepEqual(sort, { columnId: 'amount', direction: 'desc' });
    assert.equal(toggleSort(sort, 'amount'), null);
    assert.deepEqual(toggleSort(sort, 'company'), { columnId: 'company', direction: 'asc' });
  });

  it('filters by text, set and range', () => {
    assert.equal(filterRows(rows, { company: { kind: 'text', value: 'kestrel' } }, access).length, 1);
    assert.equal(filterRows(rows, { status: { kind: 'set', values: ['paid'] } }, access).length, 2);
    assert.equal(filterRows(rows, { amount: { kind: 'number', min: 1000 } }, access).length, 2);
    assert.equal(filterRows(rows, { amount: { kind: 'number', min: 1000, max: 5000 } }, access).length, 1);
    assert.equal(filterRows(rows, {}, access).length, rows.length);
    assert.equal(matchesFilter('anything', { kind: 'text', value: '' }), true);
  });

  it('searches across the searchable columns only', () => {
    assert.equal(searchRows(rows, 'dana', ['owner'], access).length, 2);
    assert.equal(searchRows(rows, 'dana', ['company'], access).length, 0);
    assert.equal(searchRows(rows, '   ', ['company'], access).length, rows.length);
  });

  it('reports selection state and extends a shift-range', () => {
    const ids = rows.map((r) => r.id);
    assert.equal(selectionState([], ids), 'none');
    assert.equal(selectionState(['a'], ids), 'some');
    assert.equal(selectionState(ids, ids), 'all');
    assert.deepEqual(rangeBetween(ids, 'b', 'd'), ['b', 'c', 'd']);
    assert.deepEqual(rangeBetween(ids, 'd', 'b'), ['b', 'c', 'd']);
    assert.deepEqual(toggleId(['a'], 'a'), []);
    assert.deepEqual(toggleId(['a'], 'b'), ['a', 'b']);
  });

  it('totals a column and lists its distinct values', () => {
    assert.equal(sumColumn(rows, 'amount', access), 19200);
    assert.deepEqual(uniqueValues(rows, 'owner', access), ['Dana', 'Priya']);
  });
});

/* -------------------------------- overlays ------------------------------- */

describe('overlay positioning', () => {
  const anchor = { x: 100, y: 500, width: 120, height: 32 };
  const viewport = { width: 1000, height: 600 };

  it('flips above the anchor when there is no room below', () => {
    const result = computePosition(anchor, { width: 200, height: 240 }, viewport, { placement: 'bottom-start' });
    assert.equal(result.flipped, true);
    assert.ok(result.placement.startsWith('top'));
    assert.ok(result.y + 240 <= anchor.y);
  });

  it('stays below when there is room', () => {
    const result = computePosition({ ...anchor, y: 40 }, { width: 200, height: 120 }, viewport, { placement: 'bottom-start' });
    assert.equal(result.flipped, false);
    assert.equal(result.y, 78);
    assert.equal(result.x, 100);
  });

  it('slides along the cross axis instead of leaving the viewport', () => {
    const result = computePosition({ x: 940, y: 40, width: 40, height: 32 }, { width: 240, height: 100 }, viewport, { placement: 'bottom-start' });
    assert.ok(result.x + 240 <= viewport.width);
    assert.ok(result.x >= 8);
  });

  it('matches the anchor width when asked', () => {
    const result = computePosition(anchor, { width: 40, height: 60 }, viewport, { matchWidth: true, placement: 'bottom-start' });
    assert.equal(result.width, 120);
  });

  it('ranks command matches by where the query hits', () => {
    const entries = [
      { id: '1', title: 'Create invoice', group: 'Create', onSelect: () => {} },
      { id: '2', title: 'Void an invoice', group: 'Act', onSelect: () => {} },
      { id: '3', title: 'Settings', group: 'Go', keywords: ['invoice defaults'], onSelect: () => {} },
      { id: '4', title: 'Contacts', group: 'Go', onSelect: () => {} },
    ];
    const results = rankCommands(entries, 'invoice');
    assert.equal(results.length, 3);
    assert.equal(results[0].id, '1');
    assert.equal(rankCommands(entries, '').length, 4);
  });
});

/* -------------------------------- calendar ------------------------------- */

describe('calendar', () => {
  it('always returns six weeks so the grid never jumps', () => {
    for (const month of [Date.UTC(2026, 1, 1), Date.UTC(2026, 4, 1), Date.UTC(2024, 1, 1)]) {
      assert.equal(monthMatrix(month).length, 42);
    }
  });

  it('starts the grid on the configured weekday', () => {
    const sunday = monthMatrix(Date.UTC(2026, 4, 1), 0);
    assert.equal(new Date(sunday[0].ts).getUTCDay(), 0);
    const monday = monthMatrix(Date.UTC(2026, 4, 1), 1);
    assert.equal(new Date(monday[0].ts).getUTCDay(), 1);
  });

  it('clamps month arithmetic to the shorter month', () => {
    assert.equal(new Date(addMonths(Date.UTC(2026, 0, 31), 1)).getUTCDate(), 28);
    assert.equal(startOfMonthUtc(Date.UTC(2026, 4, 17)), Date.UTC(2026, 4, 1));
    assert.equal(addDays(Date.UTC(2026, 4, 1), 3), Date.UTC(2026, 4, 4));
  });

  it('accepts a backwards range by swapping the ends', () => {
    const start = { start: Date.UTC(2026, 4, 20), end: null };
    const next = nextRange(start, Date.UTC(2026, 4, 4));
    assert.equal(next.start, Date.UTC(2026, 4, 4));
    assert.equal(next.end, Date.UTC(2026, 4, 20));
  });

  it('offers presets that all resolve to a complete range', () => {
    const now = Date.UTC(2026, 4, 14, 12);
    for (const preset of RANGE_PRESETS) {
      const range = preset.range(now);
      assert.ok(range.start !== null && range.end !== null, preset.id);
      assert.ok(range.start! <= range.end!, `${preset.id} is not inverted`);
    }
    assert.equal(weekdayLabels('en-US', 0).length, 7);
  });
});

/* --------------------------------- hooks --------------------------------- */

describe('virtualisation window', () => {
  it('renders only what fits, plus overscan', () => {
    const { startIndex, endIndex } = computeWindow(0, 600, 1000, 40, 5);
    assert.equal(startIndex, 0);
    assert.ok(endIndex > 15 && endIndex < 40);
  });

  it('moves the window with the scroll position', () => {
    const { startIndex, endIndex } = computeWindow(4000, 600, 1000, 40, 5);
    assert.equal(startIndex, 95);
    assert.ok(endIndex <= 1000);
  });

  it('never runs past the end of the list', () => {
    const { endIndex } = computeWindow(39_600, 600, 1000, 40, 5);
    assert.equal(endIndex, 1000);
  });

  it('matches hotkeys with modifiers', () => {
    const event = (init: Partial<KeyboardEvent>) => ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent;
    assert.equal(matchesHotkey(event({ key: 'Escape' }), 'esc'), true);
    assert.equal(matchesHotkey(event({ key: '/' }), '/'), true);
    assert.equal(matchesHotkey(event({ key: 'k', metaKey: true, ctrlKey: true }), 'mod+k'), true);
    assert.equal(matchesHotkey(event({ key: 'k' }), 'mod+k'), false);
    assert.equal(matchesHotkey(event({ key: 'n', metaKey: true, ctrlKey: true }), 'mod+k'), false);
  });
});

/* --------------------------------- icons --------------------------------- */

describe('icons', () => {
  it('ships the full set the product navigation needs', () => {
    assert.ok(ICON_NAMES.length >= 90, `only ${ICON_NAMES.length} icons`);
    for (const required of [
      'dashboard', 'contacts', 'companies', 'deals', 'inbox', 'tickets', 'campaigns', 'workflows',
      'agents', 'sparkles', 'invoice', 'credit-card', 'receipt', 'coins', 'gauge', 'search', 'filter',
      'plus', 'check', 'x', 'calendar', 'clock', 'mail', 'phone', 'link', 'external', 'trash', 'edit',
      'copy', 'download', 'upload', 'settings', 'user', 'users', 'bell', 'lock', 'key', 'code', 'book',
      'play', 'pause', 'refresh', 'info', 'help', 'star', 'tag', 'building', 'globe', 'zap',
      'git-branch', 'layers', 'list', 'grid', 'columns', 'eye', 'eye-off', 'send', 'paperclip',
      'smile', 'more', 'menu', 'sun', 'moon', 'logout',
    ]) {
      assert.ok(ICON_NAMES.includes(required as (typeof ICON_NAMES)[number]), `missing icon: ${required}`);
    }
  });

  it('has a component for every name, and a fallback for unknown ones', () => {
    for (const name of ICON_NAMES) assert.equal(typeof Icons[name], 'function');
    assert.equal(iconByName('definitely-not-an-icon'), Icons.more);
    assert.equal(iconByName('invoice'), Icons.invoice);
  });
});

/* ------------------- filter stack: folding, dates, sharing ---------------- */

interface Invoice {
  id: string; number: string; owner: string; status: string; issuedAt: number; amount: number;
}
const DAY_MS = 86_400_000;
const JUL_1 = Date.UTC(2026, 6, 1);
const invoices: Invoice[] = [
  { id: 'i1', number: 'INV-02481', owner: 'Nina Kovač', status: 'open', issuedAt: JUL_1, amount: 120_00 },
  { id: 'i2', number: 'INV-02482', owner: 'Nina Kovač', status: 'past_due', issuedAt: JUL_1 + 10 * DAY_MS, amount: 340_00 },
  { id: 'i3', number: 'INV-02483', owner: 'Sofia Lindqvist', status: 'paid', issuedAt: JUL_1 + 40 * DAY_MS, amount: 90_00 },
  { id: 'i4', number: 'INV-02484', owner: 'Tom Bergeron', status: 'open', issuedAt: JUL_1 - 30 * DAY_MS, amount: 15_00 },
];
const invoiceAccess = (row: Invoice, columnId: string) =>
  (row as unknown as Record<string, string | number>)[columnId];

describe('diacritic folding', () => {
  it('folds accents and case so a US keyboard finds Nina Kovač', () => {
    assert.equal(fold('Nina Kovač'), 'nina kovac');
    assert.equal(fold('ÀÉÎÕÜ'), 'aeiou');
    const accented = searchRows(invoices, 'Kovač', ['owner'], invoiceAccess);
    for (const typed of ['Kovac', 'kovac', 'KOVAC', '  kovac  ']) {
      assert.equal(
        searchRows(invoices, typed, ['owner'], invoiceAccess).length,
        accented.length,
        `"${typed}" should find as many rows as "Kovač"`,
      );
    }
    assert.equal(accented.length, 2);
  });

  it('folds inside the text filter too, so search and filter agree', () => {
    assert.equal(matchesFilter('Nina Kovač', { kind: 'text', value: 'kovac' }), true);
    assert.equal(matchesFilter('Nina Kovač', { kind: 'text', value: 'kovac', op: 'not_contains' }), false);
    assert.equal(matchesFilter('Sofia Lindqvist', { kind: 'text', value: 'sofia', op: 'starts_with' }), true);
    assert.equal(matchesFilter('Sofia Lindqvist', { kind: 'text', value: 'sofia lindqvist', op: 'is' }), true);
  });
});

describe('typed filter kinds', () => {
  it('filters a date column by is / after / before / between', () => {
    const on = filterRows(invoices, { issuedAt: { kind: 'date', op: 'is', from: JUL_1, to: JUL_1 } }, invoiceAccess);
    assert.deepEqual(on.map((r) => r.id), ['i1']);

    const after = filterRows(invoices, { issuedAt: { kind: 'date', op: 'after', from: JUL_1 + DAY_MS } }, invoiceAccess);
    assert.deepEqual(after.map((r) => r.id), ['i2', 'i3']);

    const before = filterRows(invoices, { issuedAt: { kind: 'date', op: 'before', to: JUL_1 - DAY_MS } }, invoiceAccess);
    assert.deepEqual(before.map((r) => r.id), ['i4']);

    const between = filterRows(
      invoices,
      { issuedAt: { kind: 'date', op: 'between', from: JUL_1, to: JUL_1 + 10 * DAY_MS } },
      invoiceAccess,
    );
    assert.deepEqual(between.map((r) => r.id), ['i1', 'i2']);
  });

  it('treats the end of a between range as inclusive of the whole day', () => {
    const noon = JUL_1 + 10 * DAY_MS + 13 * 3_600_000;
    assert.equal(matchesFilter(noon, { kind: 'date', from: JUL_1, to: JUL_1 + 10 * DAY_MS }), true);
  });

  it('holds two statuses at once, and can invert the set', () => {
    const anyOf = filterRows(invoices, { status: { kind: 'set', values: ['open', 'past_due'] } }, invoiceAccess);
    assert.deepEqual(anyOf.map((r) => r.id), ['i1', 'i2', 'i4']);
    const noneOf = filterRows(invoices, { status: { kind: 'set', values: ['open'], op: 'none_of' } }, invoiceAccess);
    assert.deepEqual(noneOf.map((r) => r.id), ['i2', 'i3']);
  });

  it('knows which filters are empty and how many are active', () => {
    assert.equal(isFilterEmpty(undefined), true);
    assert.equal(isFilterEmpty({ kind: 'text', value: '   ' }), true);
    assert.equal(isFilterEmpty({ kind: 'set', values: [] }), true);
    assert.equal(isFilterEmpty({ kind: 'number' }), true);
    assert.equal(isFilterEmpty({ kind: 'date' }), true);
    assert.equal(isFilterEmpty({ kind: 'date', from: JUL_1 }), false);
    assert.equal(activeFilterCount({
      status: { kind: 'set', values: ['open'] },
      owner: { kind: 'text', value: '' },
      issuedAt: { kind: 'date', from: JUL_1 },
    }), 2);
  });

  it('describes a chip the way an operator reads it, humanising enum values', () => {
    const iso = (ts: number) => new Date(ts).toISOString().slice(0, 10);
    assert.equal(
      describeFilter({ kind: 'set', values: ['open', 'past_due'] }, { optionLabel: humanize }),
      'is Open, Past due',
    );
    assert.equal(
      describeFilter({ kind: 'set', values: ['a', 'b', 'c', 'd'] }),
      'is a, b +2',
    );
    assert.equal(describeFilter({ kind: 'date', op: 'after', from: JUL_1 + DAY_MS }, { formatDate: iso }), 'is after 2026-07-01');
    assert.equal(describeFilter({ kind: 'date', op: 'before', to: JUL_1 - DAY_MS }, { formatDate: iso }), 'is before 2026-07-01');
    assert.equal(describeFilter({ kind: 'date', from: JUL_1, to: JUL_1 }, { formatDate: iso }), 'is 2026-07-01');
    assert.equal(describeFilter({ kind: 'number', min: 10, max: 20 }), 'is 10 – 20');
    assert.equal(describeFilter({ kind: 'number', min: 10 }), 'is at least 10');
    assert.equal(describeFilter({ kind: 'text', value: 'halden', op: 'not_contains' }), 'does not contain “halden”');
  });

  it('counts distinct values and finds a date column’s span', () => {
    assert.deepEqual(valueCounts(invoices, 'status', invoiceAccess), [
      { value: 'open', count: 2 }, { value: 'paid', count: 1 }, { value: 'past_due', count: 1 },
    ]);
    assert.deepEqual(dateExtent(invoices, 'issuedAt', invoiceAccess), { min: JUL_1 - 30 * DAY_MS, max: JUL_1 + 40 * DAY_MS });
    assert.equal(dateExtent([], 'issuedAt', invoiceAccess), null);
  });
});

describe('shareable table state', () => {
  const stack: FilterMap = {
    status: { kind: 'set', values: ['open', 'past_due'], op: 'any_of' },
    issuedAt: { kind: 'date', op: 'between', from: JUL_1, to: JUL_1 + 10 * DAY_MS },
    amount: { kind: 'number', op: 'gte', min: 5000 },
    company: { kind: 'text', value: 'Halden; Metal~works', op: 'contains' },
  };

  it('round-trips a filter stack through a URL-safe string', () => {
    const encoded = encodeFilters(stack);
    assert.ok(encoded.includes('status~set~any_of~open,past_due'), encoded);
    assert.deepEqual(decodeFilters(encoded), stack);
  });

  it('survives separators inside a value', () => {
    const decoded = decodeFilters(encodeFilters({ company: { kind: 'text', value: 'a;b~c,d\\e', op: 'is' } }));
    assert.deepEqual(decoded, { company: { kind: 'text', value: 'a;b~c,d\\e', op: 'is' } });
  });

  it('round-trips the whole view — query, sort and filters', () => {
    const state = { query: 'kovac', sort: { columnId: 'issuedAt', direction: 'desc' as const }, filters: stack };
    const params = encodeTableState(state);
    assert.equal(params.q, 'kovac');
    assert.equal(params.sort, 'issuedAt:desc');
    assert.deepEqual(decodeTableState(params), state);
  });

  it('leaves the parameters out entirely when there is nothing to share', () => {
    const params = encodeTableState({ query: '  ', sort: null, filters: { status: { kind: 'set', values: [] } } });
    assert.deepEqual(params, { q: undefined, sort: undefined, filter: undefined });
    assert.deepEqual(decodeTableState({}), { query: '', sort: null, filters: {} });
  });

  it('ignores junk in a hand-edited URL instead of throwing', () => {
    assert.deepEqual(decodeFilters('~~~;status~set~;;bogus'), {});
    assert.deepEqual(decodeFilters('amount~number~gte~notanumber,'), {});
  });
});

describe('selection safety', () => {
  const visible = ['i1', 'i2'];

  it('splits a selection into what the filter shows and what it hides', () => {
    const split = splitSelection(['i1', 'i2', 'i3', 'i4'], visible);
    assert.deepEqual(split.visible, ['i1', 'i2']);
    assert.deepEqual(split.hidden, ['i3', 'i4']);
  });

  it('reports nothing hidden when the filter shows every selected row', () => {
    assert.deepEqual(splitSelection(['i1'], visible), { visible: ['i1'], hidden: [] });
    assert.deepEqual(splitSelection([], visible), { visible: [], hidden: [] });
  });

  it('extends a selection from an anchor, in either direction', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    assert.deepEqual(extendSelection([], ids, 'b', 'd'), ['b', 'c', 'd']);
    assert.deepEqual(extendSelection([], ids, 'd', 'b'), ['b', 'c', 'd']);
    assert.deepEqual(extendSelection(['a'], ids, 'c', 'c'), ['a', 'c']);
    // No anchor yet — Shift+Arrow behaves like a plain select on the first press.
    assert.deepEqual(extendSelection(['a'], ids, null, 'c'), ['a', 'c']);
    assert.deepEqual(extendSelection(['a'], ids, null, 'a'), ['a']);
  });
});

/* --------------------------------- colour -------------------------------- */

describe('contrast', () => {
  it('parses the colour forms a browser hands back', () => {
    assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255 });
    assert.deepEqual(parseColor('#232a37'), { r: 35, g: 42, b: 55 });
    assert.deepEqual(parseColor('rgb(35, 42, 55)'), { r: 35, g: 42, b: 55 });
    assert.deepEqual(parseColor('rgba(35 42 55 / 0.5)'), { r: 35, g: 42, b: 55 });
    assert.equal(parseColor('color-mix(in srgb, red, blue)'), null);
  });

  it('computes WCAG ratios and grades', () => {
    assert.equal(relativeLuminance({ r: 255, g: 255, b: 255 }), 1);
    assert.equal(contrastRatio('#000000', '#ffffff'), 21);
    assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
    assert.equal(contrastGrade(21), 'AAA');
    assert.equal(contrastGrade(4.6), 'AA');
    assert.equal(contrastGrade(3.2), 'AA Large');
    assert.equal(contrastGrade(2), 'Fail');
    assert.equal(contrastRatio('nonsense', '#fff'), null);
  });
});

/* ------------------------------ design tokens ----------------------------- */

/**
 * The style guide promises every text token clears 4.5:1 on every resting
 * surface in both themes. This is that promise, asserted against the stylesheet
 * itself so it cannot quietly drift.
 */
describe('token contrast', () => {
  const CSS = readFileSync(new URL('../src/client/design/tokens.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const declarationsIn = (selector: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const blocks = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g');
    let match: RegExpExecArray | null;
    while ((match = blocks.exec(CSS)) !== null) {
      for (const declaration of match[1].split(';')) {
        const colon = declaration.indexOf(':');
        if (colon < 0) continue;
        const name = declaration.slice(0, colon).trim();
        if (name.startsWith('--')) out[name] = declaration.slice(colon + 1).trim();
      }
    }
    return out;
  };

  const light = declarationsIn(':root');
  const dark: Record<string, string> = { ...light, ...declarationsIn("[data-theme='dark']") };

  const resolve = (vars: Record<string, string>, value: string, depth = 0): string | null => {
    if (depth > 12) return null;
    const trimmed = value.trim();
    const reference = /^var\((--[\w-]+)\)$/.exec(trimmed);
    if (reference) {
      const next = vars[reference[1]];
      return next === undefined ? null : resolve(vars, next, depth + 1);
    }
    return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
  };

  /** Backgrounds text is allowed to rest on, in both themes. */
  const SURFACES = ['--bg-surface', '--bg-app', '--bg-subtle', '--bg-sunken', '--bg-surface-raised', '--bg-nav'];
  /** Type-scale tokens share the `--text-` prefix but are not colours. */
  const SCALE = /^--text-(2xs|xs|sm|md|base|lg|xl|2xl|3xl|4xl|5xl)$/;
  /** Pairs with `--bg-inverse`, so it is measured against that instead. */
  const INVERSE = new Set(['--text-inverse', '--text-tooltip', '--text-inverse-warning']);

  for (const [themeName, vars] of [['light', light], ['dark', dark]] as const) {
    it(`keeps every ${themeName} text token above 4.5:1 on every resting surface`, () => {
      const surfaces = SURFACES.map((token) => {
        const colour = resolve(vars, `var(${token})`);
        assert.ok(colour, `${token} does not resolve to a hex colour in the ${themeName} theme`);
        return { token, colour: colour as string };
      });

      const textTokens = Object.keys(vars).filter((k) => k.startsWith('--text-') && !SCALE.test(k) && !INVERSE.has(k));
      assert.ok(textTokens.length >= 12, `only found ${textTokens.length} text colour tokens`);

      for (const token of textTokens) {
        const colour = resolve(vars, vars[token]);
        assert.ok(colour, `${token} does not resolve to a hex colour in the ${themeName} theme`);
        for (const surface of surfaces) {
          const ratio = contrastRatio(colour as string, surface.colour);
          assert.ok(ratio !== null, `could not measure ${token} on ${surface.token}`);
          assert.ok(
            (ratio as number) >= 4.5,
            `${themeName} ${token} (${colour as string}) is ${(ratio as number).toFixed(2)}:1 on ${surface.token} — needs 4.5:1`,
          );
        }
      }
    });
  }

  it('keeps the inverse pair (bulk bar, tooltips) legible in both themes', () => {
    for (const [themeName, vars] of [['light', light], ['dark', dark]] as const) {
      const inverseBg = resolve(vars, 'var(--bg-inverse)');
      const tooltipBg = resolve(vars, 'var(--bg-tooltip)');
      assert.ok(inverseBg && tooltipBg, `inverse surfaces do not resolve in ${themeName}`);
      for (const [token, background] of [
        ['--text-inverse', inverseBg as string],
        ['--text-inverse-warning', inverseBg as string],
        ['--text-tooltip', tooltipBg as string],
      ] as const) {
        const colour = resolve(vars, vars[token]);
        assert.ok(colour, `${token} does not resolve in ${themeName}`);
        const ratio = contrastRatio(colour as string, background) as number;
        assert.ok(ratio >= 4.5, `${themeName} ${token} is ${ratio.toFixed(2)}:1 on its inverse surface`);
      }
    }
  });

  it('keeps the accent readable under its own contrast colour', () => {
    for (const [themeName, vars] of [['light', light], ['dark', dark]] as const) {
      const accent = resolve(vars, 'var(--accent)');
      const onAccent = resolve(vars, vars['--accent-contrast']);
      assert.ok(accent && onAccent, `accent pair does not resolve in ${themeName}`);
      const ratio = contrastRatio(onAccent as string, accent as string) as number;
      assert.ok(ratio >= 4.5, `${themeName} --accent-contrast on --accent is ${ratio.toFixed(2)}:1`);
    }
  });

  it('mirrors for RTL: no physical inline properties left in the stylesheets', () => {
    const files = [
      'base.css', 'tokens.css', 'layout.css', 'controls.css', 'fields.css', 'data.css', 'table.css',
      'overlays.css', 'feedback.css', 'nav.css', 'charts.css', 'toast.css', 'styleguide.css',
    ];
    const physical = /(?:^|[\s;{])(margin-left|margin-right|padding-left|padding-right|border-left|border-right|border-top-left-radius|border-top-right-radius|border-bottom-left-radius|border-bottom-right-radius)\s*:|text-align\s*:\s*(?:left|right)|(?:^|[\s;{])(?:left|right)\s*:/;
    for (const file of files) {
      const source = readFileSync(new URL(`../src/client/design/${file}`, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      for (const line of source.split('\n')) {
        assert.ok(!physical.test(line), `${file} uses a physical inline property, which cannot mirror for RTL:\n  ${line.trim()}`);
      }
    }
  });
});
