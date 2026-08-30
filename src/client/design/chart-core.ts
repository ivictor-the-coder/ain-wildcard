/**
 * Pure geometry for the chart kit. No React, no DOM — so it is unit-testable
 * and the SVG components stay thin.
 */

export interface Extent { min: number; max: number }

export function extentOf(values: number[], includeZero = true): Extent {
  if (!values.length) return { min: 0, max: 1 };
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (includeZero) { min = Math.min(min, 0); max = Math.max(max, 0); }
  if (min === max) { max = min + (Math.abs(min) || 1); }
  return { min, max };
}

/**
 * Axis ticks on human numbers (1, 2, 2.5, 5 × 10ⁿ), covering the domain and
 * landing on round values so a reader can do arithmetic in their head.
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) { min = Math.min(0, min); max = max || 1; }
  if (min > max) [min, max] = [max, min];
  const span = max - min || 1;
  const rough = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const step = (normalised >= 5 ? 10 : normalised >= 2.5 ? 5 : normalised >= 1.5 ? 2.5 : normalised >= 1.2 ? 2 : 1) * magnitude;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // Accumulate by index rather than by adding `step` repeatedly: no float drift.
  const steps = Math.round((end - start) / step);
  for (let i = 0; i <= steps && ticks.length < 40; i++) {
    const value = start + i * step;
    ticks.push(Math.abs(value) < step / 1e6 ? 0 : Number(value.toPrecision(12)));
  }
  return ticks;
}

export interface LinearScale {
  (value: number): number;
  domain: [number, number];
  range: [number, number];
  invert(pixel: number): number;
}

export function linearScale(domain: [number, number], range: [number, number]): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const fn = ((value: number) => r0 + ((value - d0) / span) * (r1 - r0)) as LinearScale;
  fn.domain = domain;
  fn.range = range;
  fn.invert = (pixel: number) => d0 + ((pixel - r0) / ((r1 - r0) || 1)) * span;
  return fn;
}

export interface BandScale {
  (index: number): number;
  bandwidth: number;
  step: number;
  /** Nearest band index for a pixel position — used for hover tracking. */
  indexAt(pixel: number): number;
  center(index: number): number;
}

export function bandScale(count: number, range: [number, number], padding = 0.2): BandScale {
  const [r0, r1] = range;
  const width = r1 - r0;
  const step = count > 0 ? width / count : width;
  const bandwidth = Math.max(1, step * (1 - padding));
  const offset = (step - bandwidth) / 2;
  const fn = ((index: number) => r0 + index * step + offset) as BandScale;
  fn.bandwidth = bandwidth;
  fn.step = step;
  fn.center = (index: number) => r0 + index * step + step / 2;
  fn.indexAt = (pixel: number) => Math.max(0, Math.min(count - 1, Math.floor((pixel - r0) / (step || 1))));
  return fn;
}

/** Evenly spaced points across a range, the way a line chart lays out x. */
export function pointScale(count: number, range: [number, number]): (index: number) => number {
  const [r0, r1] = range;
  if (count <= 1) return () => (r0 + r1) / 2;
  const step = (r1 - r0) / (count - 1);
  return (index: number) => r0 + index * step;
}

export interface Point { x: number; y: number }

export function linePath(points: Point[]): string {
  if (!points.length) return '';
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.y)}`).join(' ');
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Monotone cubic interpolation: smooth, but it never overshoots a data point,
 * so a curve through non-negative revenue never dips below zero.
 */
export function smoothPath(points: Point[]): string {
  const n = points.length;
  if (n < 3) return linePath(points);
  const dx: number[] = [];
  const dy: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1].x - points[i].x);
    dy.push(points[i + 1].y - points[i].y);
    slope.push(dy[i] / (dx[i] || 1));
  }
  const tangents: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) tangents.push(0);
    else {
      const common = dx[i - 1] + dx[i];
      tangents.push((3 * common) / ((common + dx[i]) / slope[i - 1] + (common + dx[i - 1]) / slope[i]));
    }
  }
  tangents.push(slope[n - 2]);

  let d = `M${round(points[0].x)} ${round(points[0].y)}`;
  for (let i = 0; i < n - 1; i++) {
    const x1 = points[i].x + dx[i] / 3;
    const y1 = points[i].y + (tangents[i] * dx[i]) / 3;
    const x2 = points[i + 1].x - dx[i] / 3;
    const y2 = points[i + 1].y - (tangents[i + 1] * dx[i]) / 3;
    d += ` C${round(x1)} ${round(y1)},${round(x2)} ${round(y2)},${round(points[i + 1].x)} ${round(points[i + 1].y)}`;
  }
  return d;
}

export function areaPath(points: Point[], baselineY: number, smooth = false): string {
  if (!points.length) return '';
  const top = smooth ? smoothPath(points) : linePath(points);
  const last = points[points.length - 1];
  const first = points[0];
  return `${top} L${round(last.x)} ${round(baselineY)} L${round(first.x)} ${round(baselineY)} Z`;
}

/** Stacks series values index-by-index, returning [y0, y1] bands per series. */
export function stackSeries(series: number[][]): { y0: number; y1: number }[][] {
  const length = series.reduce((max, s) => Math.max(max, s.length), 0);
  const totals = new Array(length).fill(0);
  return series.map((values) =>
    Array.from({ length }, (_, i) => {
      const v = values[i] ?? 0;
      const y0 = totals[i];
      totals[i] = y0 + v;
      return { y0, y1: totals[i] };
    }),
  );
}

export const stackedMax = (series: number[][]): number => {
  const length = series.reduce((max, s) => Math.max(max, s.length), 0);
  let out = 0;
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const s of series) sum += s[i] ?? 0;
    if (sum > out) out = sum;
  }
  return out;
};

/* -------------------------------- arcs ----------------------------------- */

export const polarPoint = (cx: number, cy: number, r: number, angle: number): Point => ({
  x: cx + r * Math.cos(angle - Math.PI / 2),
  y: cy + r * Math.sin(angle - Math.PI / 2),
});

/** A donut segment as a closed path between an outer and an inner radius. */
export function arcPath(cx: number, cy: number, outer: number, inner: number, start: number, end: number): string {
  const sweep = end - start;
  if (sweep <= 0) return '';
  // A full circle cannot be drawn with one arc command; split it in two.
  if (sweep >= Math.PI * 2 - 1e-6) {
    const mid = start + Math.PI;
    return `${arcPath(cx, cy, outer, inner, start, mid)} ${arcPath(cx, cy, outer, inner, mid, start + Math.PI * 2 - 1e-6)}`;
  }
  const large = sweep > Math.PI ? 1 : 0;
  const o1 = polarPoint(cx, cy, outer, start);
  const o2 = polarPoint(cx, cy, outer, end);
  const i2 = polarPoint(cx, cy, inner, end);
  const i1 = polarPoint(cx, cy, inner, start);
  return [
    `M${round(o1.x)} ${round(o1.y)}`,
    `A${outer} ${outer} 0 ${large} 1 ${round(o2.x)} ${round(o2.y)}`,
    `L${round(i2.x)} ${round(i2.y)}`,
    `A${inner} ${inner} 0 ${large} 0 ${round(i1.x)} ${round(i1.y)}`,
    'Z',
  ].join(' ');
}

export interface Slice { value: number; start: number; end: number; fraction: number }

export function pieLayout(values: number[], gap = 0.012): Slice[] {
  const total = values.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0) return values.map(() => ({ value: 0, start: 0, end: 0, fraction: 0 }));
  let cursor = 0;
  return values.map((raw) => {
    const value = Math.max(0, raw);
    const fraction = value / total;
    const start = cursor;
    const end = cursor + fraction * Math.PI * 2;
    cursor = end;
    return { value, start, end: Math.max(start, end - (fraction > 0 ? gap : 0)), fraction };
  });
}

/* ------------------------------- waterfall -------------------------------- */

export interface WaterfallInput {
  label: string;
  value: number;
  /** `total` bars are drawn from the baseline rather than from the running sum. */
  kind?: 'delta' | 'total';
}

export interface WaterfallBar extends WaterfallInput {
  start: number;
  end: number;
  cumulative: number;
  kind: 'delta' | 'total';
}

/** MRR movement: opening balance, signed movements, closing balance. */
export function waterfallLayout(items: WaterfallInput[]): WaterfallBar[] {
  let running = 0;
  return items.map((item) => {
    if (item.kind === 'total') {
      running = item.value;
      return { ...item, kind: 'total' as const, start: 0, end: item.value, cumulative: item.value };
    }
    const start = running;
    running += item.value;
    return { ...item, kind: 'delta' as const, start, end: running, cumulative: running };
  });
}

/* --------------------------------- funnel --------------------------------- */

export interface FunnelInput { label: string; value: number }
export interface FunnelStage extends FunnelInput {
  fraction: number;
  /** Conversion from the previous stage — the number operators actually act on. */
  stepRate: number;
  dropped: number;
}

export function funnelLayout(stages: FunnelInput[]): FunnelStage[] {
  const top = stages[0]?.value ?? 0;
  return stages.map((stage, i) => {
    const previous = i === 0 ? stage.value : stages[i - 1].value;
    return {
      ...stage,
      fraction: top > 0 ? stage.value / top : 0,
      stepRate: previous > 0 ? stage.value / previous : 0,
      dropped: Math.max(0, previous - stage.value),
    };
  });
}

/* -------------------------------- heatmap --------------------------------- */

/** Maps a value onto 0–1 for opacity ramps; `p95` keeps outliers from flattening. */
export function heatScale(values: number[]): (value: number) => number {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return () => 0;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 1;
  const min = sorted[0];
  const span = p95 - min || 1;
  return (value: number) => Math.max(0, Math.min(1, (value - min) / span));
}

/* -------------------------------- sparkline ------------------------------- */

export function sparklinePoints(values: number[], width: number, height: number, pad = 1): Point[] {
  if (!values.length) return [];
  const { min, max } = extentOf(values, false);
  const x = pointScale(values.length, [pad, width - pad]);
  const y = linearScale([min, max], [height - pad, pad]);
  return values.map((v, i) => ({ x: x(i), y: y(v) }));
}

/** Least-squares slope of a series — powers the "trending up" affordance. */
export function trendSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (values[i] - meanY);
    den += (i - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** Period-over-period change as a fraction; `null` when the base is zero. */
export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}
