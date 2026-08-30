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
