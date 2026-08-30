/**
 * A hand-rolled SVG chart kit. Every mark is computed by `chart-core.ts`, the
 * palette comes from the `--viz-*` tokens, and every chart ships with a
 * visually-hidden data table so the numbers are never trapped in a picture.
 */
import {
  Fragment, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';
import {
  arcPath, areaPath, bandScale, extentOf, funnelLayout, heatScale, linePath, linearScale,
  niceTicks, pieLayout, pointScale, smoothPath, sparklinePoints, stackSeries, stackedMax,
  trendSlope, waterfallLayout, type FunnelInput, type Point, type WaterfallInput,
} from './chart-core';
import { vizColor } from './color';
import { formatCompact, formatNumber, formatPercent } from './format';
import { cx } from './layout';
import { useResizeObserver } from './hooks';
import './charts.css';

export interface ChartSeries {
  id: string;
  label: string;
  values: number[];
  /** Any CSS colour; defaults to the next `--viz-*` token. */
  color?: string;
  dashed?: boolean;
}

export interface ChartBaseProps {
  series: ChartSeries[];
  categories: string[];
  height?: number;
  /** The accessible name of the chart — required, and it should be specific. */
  title: string;
  /** One sentence a screen-reader user hears instead of seeing the shape. */
  description?: string;
  valueFormat?: (value: number) => string;
  legend?: boolean;
  className?: string;
  /** Show every Nth category label; defaults to a fit-based stride. */
  xTickStride?: number;
  yTickCount?: number;
}

const defaultFormat = (v: number) => formatCompact(v);

function useChartWidth(fallback = 720) {
  const ref = useRef<HTMLDivElement>(null);
  const { width } = useResizeObserver(ref);
  return [ref, Math.max(240, width || fallback)] as const;
}

const colorAt = (series: ChartSeries[], i: number) => series[i]?.color ?? vizColor(i);

/* ------------------------------ shared parts ------------------------------ */

export interface LegendItem { id: string; label: string; color: string; value?: string }

export function ChartLegend({
  items, hidden, onToggle, className,
}: { items: LegendItem[]; hidden?: Set<string>; onToggle?: (id: string) => void; className?: string }) {
  return (
    <div className={cx('ain-legend', className)} role={onToggle ? 'group' : undefined} aria-label={onToggle ? 'Toggle series' : undefined}>
      {items.map((item) => {
        const off = hidden?.has(item.id);
        const content = (
          <>
            <span className="ain-legend__swatch" style={{ background: item.color }} aria-hidden />
            <span>{item.label}</span>
            {item.value && <span className="ain-legend__value">{item.value}</span>}
          </>
        );
        return onToggle ? (
          <button
            key={item.id}
            type="button"
            className={cx('ain-legend__item', 'is-clickable', off && 'is-off')}
            aria-pressed={!off}
            onClick={() => onToggle(item.id)}
          >
            {content}
          </button>
        ) : (
          <span key={item.id} className={cx('ain-legend__item', off && 'is-off')}>{content}</span>
        );
      })}
    </div>
  );
}

/** The chart's numbers, for assistive tech and for anyone who prefers a table. */
function ChartDataTable({ id, title, categories, series, format }: {
  id: string; title: string; categories: string[]; series: ChartSeries[]; format: (v: number) => string;
}) {
  return (
    <table className="u-visually-hidden" id={id}>
      <caption>{title}</caption>
      <thead>
        <tr>
          <th scope="col">Period</th>
          {series.map((s) => <th scope="col" key={s.id}>{s.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {categories.map((category, i) => (
          <tr key={category + i}>
            <th scope="row">{category}</th>
            {series.map((s) => <td key={s.id}>{format(s.values[i] ?? 0)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface TipState { index: number; x: number; y: number }

function ChartTooltip({ state, categories, rows, total, width }: {
  state: TipState; categories: string[]; rows: { label: string; value: string; color: string }[]; total?: string; width: number;
}) {
  const clampedX = Math.max(78, Math.min(width - 78, state.x));
  return (
    <div className="ain-charttip" style={{ left: clampedX, top: state.y }} role="presentation">
      <div className="ain-charttip__title">{categories[state.index]}</div>
      {rows.map((row) => (
        <div className="ain-charttip__row" key={row.label}>
          <span className="ain-charttip__swatch" style={{ background: row.color }} />
          <span className="ain-charttip__name">{row.label}</span>
          <span className="ain-charttip__val">{row.value}</span>
        </div>
      ))}
      {total && (
        <div className="ain-charttip__row ain-charttip__total">
          <span className="ain-charttip__name">Total</span>
          <span className="ain-charttip__val">{total}</span>
        </div>
      )}
    </div>
  );
}

function xLabelStride(count: number, width: number): number {
  const perLabel = 64;
  return Math.max(1, Math.ceil(count / Math.max(1, Math.floor(width / perLabel))));
}

interface AxesProps {
  ticks: number[];
  y: (v: number) => number;
  left: number;
  right: number;
  format: (v: number) => string;
  categories: string[];
  xAt: (i: number) => number;
  bottom: number;
  stride: number;
}

function Axes({ ticks, y, left, right, format, categories, xAt, bottom, stride }: AxesProps) {
  return (
    <>
      <g className="ain-chart__grid" aria-hidden>
        {ticks.map((t) => (
          <line key={t} x1={left} x2={right} y1={y(t)} y2={y(t)} className={t === 0 ? 'is-zero' : undefined} />
        ))}
      </g>
      <g className="ain-chart__axis" aria-hidden>
        {ticks.map((t) => (
          <text key={t} x={left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle">{format(t)}</text>
        ))}
        {categories.map((c, i) => (i % stride === 0 ? (
          <text key={c + i} x={xAt(i)} y={bottom + 16} textAnchor="middle">{c}</text>
        ) : null))}
      </g>
    </>
  );
}

/* ------------------------------- LineChart -------------------------------- */

export interface LineChartProps extends ChartBaseProps {
  smooth?: boolean;
  showDots?: boolean;
  /** Fill under the line — a single-series area without stacking. */
  fill?: boolean;
  /** Draw the last segment dashed: the current, incomplete period. */
  partialLast?: boolean;
}

export function LineChart({
  series, categories, height = 240, title, description, valueFormat = defaultFormat,
  legend = true, smooth = true, showDots, fill, partialLast, className, xTickStride, yTickCount = 5,
}: LineChartProps) {
  const [ref, width] = useChartWidth();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [tip, setTip] = useState<TipState | null>(null);
  const tableId = useId();

  const visible = series.filter((s) => !hidden.has(s.id));
  const margin = { top: 10, right: 12, bottom: 26, left: 48 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const all = visible.flatMap((s) => s.values);
  const { min, max } = extentOf(all.length ? all : [0, 1]);
  const ticks = niceTicks(min, max, yTickCount);
  const y = linearScale([ticks[0], ticks[ticks.length - 1]], [margin.top + plotH, margin.top]);
  const x = pointScale(categories.length, [margin.left, margin.left + plotW]);
  const stride = xTickStride ?? xLabelStride(categories.length, plotW);

  const onMove = (e: ReactPointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left + margin.left;
    const step = categories.length > 1 ? plotW / (categories.length - 1) : plotW;
    const index = Math.max(0, Math.min(categories.length - 1, Math.round((px - margin.left) / (step || 1))));
    setTip({ index, x: x(index), y: Math.max(margin.top, y(Math.max(...visible.map((s) => s.values[index] ?? 0)))) });
  };

  return (
    <div className={cx('ain-chart', className)}>
      {legend && (
        <ChartLegend
          items={series.map((s, i) => ({ id: s.id, label: s.label, color: colorAt(series, i) }))}
          hidden={hidden}
          onToggle={(id) => setHidden((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else if (next.size < series.length - 1) next.add(id);
            return next;
          })}
        />
      )}
      <div className="ain-chart__plot" ref={ref}>
        <svg
          className="ain-chart__svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
          role="img" aria-label={title} aria-describedby={tableId}
        >
          {description && <desc>{description}</desc>}
          <Axes ticks={ticks} y={y} left={margin.left} right={margin.left + plotW} format={valueFormat}
                categories={categories} xAt={x} bottom={margin.top + plotH} stride={stride} />
          {visible.map((s) => {
            const i = series.indexOf(s);
            const color = colorAt(series, i);
            const points: Point[] = s.values.map((v, idx) => ({ x: x(idx), y: y(v) }));
            const solid = partialLast ? points.slice(0, -1) : points;
            return (
              <g key={s.id}>
                {fill && (
                  <path
                    className="ain-chart__area ain-anim-fade"
                    d={areaPath(points, margin.top + plotH, smooth)}
                    fill={color}
                    opacity={0.12}
                  />
                )}
                <path
                  className={cx('ain-chart__line', 'ain-anim-draw', s.dashed && 'ain-chart__line--dashed')}
                  d={smooth ? smoothPath(solid) : linePath(solid)}
                  stroke={color}
                  pathLength={1}
                />
                {partialLast && points.length > 1 && (
                  <path
                    className="ain-chart__line ain-chart__line--dashed"
                    d={linePath(points.slice(-2))}
                    stroke={color}
                  />
                )}
                {(showDots || points.length <= 12) && points.map((p, idx) => (
                  <circle key={idx} className="ain-chart__dot" cx={p.x} cy={p.y} r={3} fill={color} />
                ))}
                {tip && points[tip.index] && (
                  <circle className="ain-chart__dot" cx={points[tip.index].x} cy={points[tip.index].y} r={4.5} fill={color} />
                )}
              </g>
            );
          })}
          {tip && <line className="ain-chart__hoverline" x1={x(tip.index)} x2={x(tip.index)} y1={margin.top} y2={margin.top + plotH} />}
          <rect
            x={margin.left} y={margin.top} width={plotW} height={plotH} fill="transparent"
            onPointerMove={onMove} onPointerLeave={() => setTip(null)}
          />
        </svg>
        {tip && (
          <ChartTooltip
            state={tip}
            width={width}
            categories={categories}
            rows={visible.map((s) => ({
              label: s.label,
              value: valueFormat(s.values[tip.index] ?? 0),
              color: colorAt(series, series.indexOf(s)),
            }))}
          />
        )}
      </div>
      <ChartDataTable id={tableId} title={title} categories={categories} series={series} format={valueFormat} />
    </div>
  );
}

/* ------------------------------- AreaChart -------------------------------- */

export interface AreaChartProps extends ChartBaseProps { stacked?: boolean; smooth?: boolean }

export function AreaChart({
  series, categories, height = 240, title, description, valueFormat = defaultFormat,
  legend = true, stacked = true, smooth = true, className, xTickStride, yTickCount = 5,
}: AreaChartProps) {
  const [ref, width] = useChartWidth();
  const [tip, setTip] = useState<TipState | null>(null);
  const tableId = useId();

  const margin = { top: 10, right: 12, bottom: 26, left: 48 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const stacks = useMemo(() => stackSeries(series.map((s) => s.values)), [series]);
  const maxValue = stacked ? stackedMax(series.map((s) => s.values)) : Math.max(...series.flatMap((s) => s.values), 0);
  const ticks = niceTicks(0, maxValue, yTickCount);
  const y = linearScale([ticks[0], ticks[ticks.length - 1]], [margin.top + plotH, margin.top]);
  const x = pointScale(categories.length, [margin.left, margin.left + plotW]);
  const stride = xTickStride ?? xLabelStride(categories.length, plotW);

  return (
    <div className={cx('ain-chart', className)}>
      {legend && <ChartLegend items={series.map((s, i) => ({ id: s.id, label: s.label, color: colorAt(series, i) }))} />}
      <div className="ain-chart__plot" ref={ref}>
        <svg className="ain-chart__svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
             role="img" aria-label={title} aria-describedby={tableId}>
          {description && <desc>{description}</desc>}
          <Axes ticks={ticks} y={y} left={margin.left} right={margin.left + plotW} format={valueFormat}
                categories={categories} xAt={x} bottom={margin.top + plotH} stride={stride} />
          {series.map((s, i) => {
            const color = colorAt(series, i);
            const top: Point[] = categories.map((_, idx) => ({
              x: x(idx), y: y(stacked ? stacks[i][idx].y1 : s.values[idx] ?? 0),
            }));
            const bottomPts: Point[] = categories.map((_, idx) => ({
              x: x(idx), y: y(stacked ? stacks[i][idx].y0 : 0),
            })).reverse();
            const d = stacked
              ? `${smooth ? smoothPath(top) : linePath(top)} L${bottomPts[0].x} ${bottomPts[0].y} ${linePath(bottomPts).slice(1)} Z`
              : areaPath(top, margin.top + plotH, smooth);
            return (
              <g key={s.id}>
                <path className="ain-chart__area ain-anim-fade" d={d} fill={color} opacity={stacked ? 0.85 : 0.2}
                      style={{ animationDelay: `${i * 70}ms` }} />
                {!stacked && <path className="ain-chart__line ain-anim-draw" d={smooth ? smoothPath(top) : linePath(top)} stroke={color} pathLength={1} />}
              </g>
            );
          })}
          {tip && <line className="ain-chart__hoverline" x1={x(tip.index)} x2={x(tip.index)} y1={margin.top} y2={margin.top + plotH} />}
          <rect
            x={margin.left} y={margin.top} width={plotW} height={plotH} fill="transparent"
            onPointerMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const step = categories.length > 1 ? plotW / (categories.length - 1) : plotW;
              const index = Math.max(0, Math.min(categories.length - 1, Math.round((e.clientX - rect.left) / (step || 1))));
              setTip({ index, x: x(index), y: y(stacked ? stacks[series.length - 1][index].y1 : Math.max(...series.map((s) => s.values[index] ?? 0))) });
            }}
            onPointerLeave={() => setTip(null)}
          />
        </svg>
        {tip && (
          <ChartTooltip
            state={tip}
            width={width}
            categories={categories}
            rows={series.map((s, i) => ({ label: s.label, value: valueFormat(s.values[tip.index] ?? 0), color: colorAt(series, i) }))}
            total={stacked ? valueFormat(series.reduce((sum, s) => sum + (s.values[tip.index] ?? 0), 0)) : undefined}
          />
        )}
      </div>
      <ChartDataTable id={tableId} title={title} categories={categories} series={series} format={valueFormat} />
    </div>
  );
}

/* -------------------------------- BarChart -------------------------------- */

export interface BarChartProps extends ChartBaseProps {
  stacked?: boolean;
  horizontal?: boolean;
  /** Draw a dashed reference line, e.g. a quota or a target. */
  reference?: { value: number; label: string };
}

export function BarChart({
  series, categories, height = 240, title, description, valueFormat = defaultFormat,
  legend = true, stacked = false, horizontal = false, reference, className, xTickStride, yTickCount = 5,
}: BarChartProps) {
  const [ref, width] = useChartWidth();
  const [tip, setTip] = useState<TipState | null>(null);
  const tableId = useId();

  const margin = horizontal
    ? { top: 8, right: 44, bottom: 24, left: 108 }
    : { top: 10, right: 12, bottom: 26, left: 48 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const stacks = useMemo(() => stackSeries(series.map((s) => s.values)), [series]);
  const maxValue = stacked ? stackedMax(series.map((s) => s.values)) : Math.max(...series.flatMap((s) => s.values), 0);
  const minValue = Math.min(0, ...series.flatMap((s) => s.values));
  const ticks = niceTicks(minValue, Math.max(maxValue, reference?.value ?? 0), yTickCount);
  const domain: [number, number] = [ticks[0], ticks[ticks.length - 1]];

  if (horizontal) {
    const value = linearScale(domain, [margin.left, margin.left + plotW]);
    const band = bandScale(categories.length, [margin.top, margin.top + plotH], 0.3);
    const inner = stacked ? band.bandwidth : band.bandwidth / series.length;
    return (
      <div className={cx('ain-chart', className)}>
        {legend && series.length > 1 && <ChartLegend items={series.map((s, i) => ({ id: s.id, label: s.label, color: colorAt(series, i) }))} />}
        <div className="ain-chart__plot" ref={ref}>
          <svg className="ain-chart__svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
               role="img" aria-label={title} aria-describedby={tableId}>
            {description && <desc>{description}</desc>}
            <g className="ain-chart__grid" aria-hidden>
              {ticks.map((t) => <line key={t} x1={value(t)} x2={value(t)} y1={margin.top} y2={margin.top + plotH} className={t === 0 ? 'is-zero' : undefined} />)}
            </g>
            <g className="ain-chart__axis" aria-hidden>
              {ticks.map((t) => <text key={t} x={value(t)} y={margin.top + plotH + 15} textAnchor="middle">{valueFormat(t)}</text>)}
              {categories.map((c, i) => <text key={c + i} x={margin.left - 10} y={band.center(i)} textAnchor="end" dominantBaseline="middle">{c}</text>)}
            </g>
            {series.map((s, si) => s.values.map((v, i) => {
              const x0 = stacked ? value(stacks[si][i].y0) : value(Math.min(0, v));
              const x1 = stacked ? value(stacks[si][i].y1) : value(Math.max(0, v));
              const yPos = band(i) + (stacked ? 0 : si * inner);
              return (
                <rect
                  key={`${s.id}-${i}`}
                  className="ain-chart__bar ain-anim-growx"
                  x={Math.min(x0, x1)} y={yPos} width={Math.max(1, Math.abs(x1 - x0))} height={Math.max(2, inner - (stacked ? 0 : 1))}
                  rx={2} fill={colorAt(series, si)}
                  style={{ animationDelay: `${i * 26}ms` }}
                >
                  <title>{`${categories[i]} · ${s.label}: ${valueFormat(v)}`}</title>
                </rect>
              );
            }))}
          </svg>
        </div>
        <ChartDataTable id={tableId} title={title} categories={categories} series={series} format={valueFormat} />
      </div>
    );
  }

  const y = linearScale(domain, [margin.top + plotH, margin.top]);
  const band = bandScale(categories.length, [margin.left, margin.left + plotW], 0.28);
  const inner = stacked ? band.bandwidth : band.bandwidth / series.length;
  const stride = xTickStride ?? xLabelStride(categories.length, plotW);

  return (
    <div className={cx('ain-chart', className)}>
      {legend && series.length > 1 && <ChartLegend items={series.map((s, i) => ({ id: s.id, label: s.label, color: colorAt(series, i) }))} />}
      <div className="ain-chart__plot" ref={ref}>
        <svg className="ain-chart__svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
             role="img" aria-label={title} aria-describedby={tableId}>
          {description && <desc>{description}</desc>}
          <Axes ticks={ticks} y={y} left={margin.left} right={margin.left + plotW} format={valueFormat}
                categories={categories} xAt={band.center} bottom={margin.top + plotH} stride={stride} />
          {tip && <rect className="ain-chart__hoverband" x={band(tip.index) - band.step * 0.1} y={margin.top} width={band.bandwidth + band.step * 0.2} height={plotH} rx={3} />}
          {series.map((s, si) => s.values.map((v, i) => {
            const yTop = stacked ? y(stacks[si][i].y1) : y(Math.max(0, v));
            const yBottom = stacked ? y(stacks[si][i].y0) : y(Math.min(0, v));
            return (
              <rect
                key={`${s.id}-${i}`}
                className="ain-chart__bar ain-anim-grow"
                x={band(i) + (stacked ? 0 : si * inner)} y={Math.min(yTop, yBottom)}
                width={Math.max(1, inner - (stacked ? 0 : 1.5))} height={Math.max(1, Math.abs(yBottom - yTop))}
                rx={2} fill={colorAt(series, si)}
                style={{ animationDelay: `${i * 22}ms` }}
              />
            );
          }))}
          {reference && (
            <g aria-hidden>
              <line x1={margin.left} x2={margin.left + plotW} y1={y(reference.value)} y2={y(reference.value)}
                    stroke="var(--text-tertiary)" strokeWidth={1} strokeDasharray="4 4" />
              <text className="ain-chart__axislabel" x={margin.left + plotW} y={y(reference.value) - 5} textAnchor="end">{reference.label}</text>
            </g>
          )}
          <rect
            x={margin.left} y={margin.top} width={plotW} height={plotH} fill="transparent"
            onPointerMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const index = band.indexAt(e.clientX - rect.left + margin.left);
              setTip({ index, x: band.center(index), y: margin.top + 8 });
            }}
            onPointerLeave={() => setTip(null)}
          />
        </svg>
        {tip && (
          <ChartTooltip
            state={tip}
            width={width}
            categories={categories}
            rows={series.map((s, i) => ({ label: s.label, value: valueFormat(s.values[tip.index] ?? 0), color: colorAt(series, i) }))}
            total={stacked && series.length > 1 ? valueFormat(series.reduce((sum, s) => sum + (s.values[tip.index] ?? 0), 0)) : undefined}
          />
        )}
      </div>
      <ChartDataTable id={tableId} title={title} categories={categories} series={series} format={valueFormat} />
    </div>
  );
}

/* ------------------------------- Sparkline -------------------------------- */

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  /** Colour by direction: green when rising, red when falling. */
  autoTone?: boolean;
  area?: boolean;
  showLast?: boolean;
  label?: string;
  className?: string;
}

export function Sparkline({
  values, width = 88, height = 26, color, autoTone, area = true, showLast = true, label, className,
}: SparklineProps) {
  const points = useMemo(() => sparklinePoints(values, width, height, 2.5), [values, width, height]);
  if (points.length < 2) return <svg width={width} height={height} aria-hidden className={className} />;
  const slope = trendSlope(values);
  const stroke = color ?? (autoTone ? (slope >= 0 ? 'var(--green-500)' : 'var(--red-500)') : 'var(--viz-1)');
  const last = points[points.length - 1];
  return (
    <svg
      className={cx('ain-spark', className)} width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}
    >
      {area && <path className="ain-spark__area" d={areaPath(points, height, false)} fill={stroke} />}
      <path className="ain-spark__line ain-anim-draw" d={linePath(points)} stroke={stroke} pathLength={1} />
      {showLast && <circle className="ain-spark__last" cx={last.x} cy={last.y} r={2.4} fill={stroke} />}
    </svg>
  );
}

/* ------------------------------- DonutChart ------------------------------- */

export interface DonutSlice { id: string; label: string; value: number; color?: string }

export interface DonutChartProps {
  data: DonutSlice[];
  size?: number;
  thickness?: number;
  title: string;
  description?: string;
  centerValue?: ReactNode;
  centerLabel?: ReactNode;
  valueFormat?: (value: number) => string;
  legend?: boolean;
  className?: string;
}

export function DonutChart({
  data, size = 168, thickness = 22, title, description, centerValue, centerLabel,
  valueFormat = defaultFormat, legend = true, className,
}: DonutChartProps) {
  const [active, setActive] = useState<string | null>(null);
  const tableId = useId();
  const slices = useMemo(() => pieLayout(data.map((d) => d.value)), [data]);
  const total = data.reduce((a, b) => a + Math.max(0, b.value), 0);
  const r = size / 2;

  return (
    <div className={cx('ain-chart', className)}>
      <div className="ain-donut">
        <div style={{ position: 'relative', width: size, height: size, flex: '0 0 auto' }}>
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={title} aria-describedby={tableId}>
            {description && <desc>{description}</desc>}
            {total === 0 && <circle cx={r} cy={r} r={r - thickness / 2} fill="none" stroke="var(--bg-track)" strokeWidth={thickness} />}
            {slices.map((slice, i) => (
              <path
                key={data[i].id}
                className={cx('ain-donut__slice', 'ain-anim-fade', active && active !== data[i].id && 'is-dim')}
                style={{ animationDelay: `${i * 60}ms` }}
                d={arcPath(r, r, r, r - thickness, slice.start, slice.end)}
                fill={data[i].color ?? vizColor(i)}
                onPointerEnter={() => setActive(data[i].id)}
                onPointerLeave={() => setActive(null)}
              >
                <title>{`${data[i].label}: ${valueFormat(data[i].value)} (${formatPercent(slice.fraction)})`}</title>
              </path>
            ))}
          </svg>
          <div className="ain-donut__center">
            <div className="ain-donut__value">{centerValue ?? valueFormat(total)}</div>
            {centerLabel && <div className="ain-donut__label">{centerLabel}</div>}
          </div>
        </div>
        {legend && (
          <ChartLegend
            className="u-col"
            items={data.map((d, i) => ({
              id: d.id, label: d.label, color: d.color ?? vizColor(i),
              value: `${valueFormat(d.value)} · ${formatPercent(total ? d.value / total : 0)}`,
            }))}
          />
        )}
      </div>
      <table className="u-visually-hidden" id={tableId}>
        <caption>{title}</caption>
        <thead><tr><th scope="col">Segment</th><th scope="col">Value</th><th scope="col">Share</th></tr></thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.id}>
              <th scope="row">{d.label}</th>
              <td>{valueFormat(d.value)}</td>
              <td>{formatPercent(total ? d.value / total : 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------- FunnelChart ------------------------------ */

export interface FunnelChartProps {
  stages: FunnelInput[];
  title: string;
  description?: string;
  valueFormat?: (value: number) => string;
  className?: string;
}

export function FunnelChart({ stages, title, description, valueFormat = (v) => formatNumber(v), className }: FunnelChartProps) {
  const laid = useMemo(() => funnelLayout(stages), [stages]);
  const tableId = useId();
  return (
    <div className={cx('ain-chart', className)}>
      <div className="ain-funnel" role="img" aria-label={title} aria-describedby={tableId}>
        {description && <span className="u-visually-hidden">{description}</span>}
        {laid.map((stage, i) => (
          <div key={stage.label}>
            <div className="ain-funnel__row">
              <div className="ain-funnel__label u-truncate" title={stage.label}>{stage.label}</div>
              <div className="ain-funnel__track">
                <div
                  className="ain-funnel__fill"
                  style={{ width: `${Math.max(stage.fraction * 100, stage.value > 0 ? 2 : 0)}%`, background: vizColor(i), animationDelay: `${i * 80}ms` }}
                />
              </div>
              <div className="ain-funnel__figures">
                <span className="ain-funnel__count">{valueFormat(stage.value)}</span>
                <span className="ain-funnel__rate">{i === 0 ? '100%' : formatPercent(stage.stepRate)}</span>
              </div>
            </div>
            {i < laid.length - 1 && laid[i + 1].dropped > 0 && (
              <div className="ain-funnel__drop">−{formatNumber(laid[i + 1].dropped)} dropped</div>
            )}
          </div>
        ))}
      </div>
      <table className="u-visually-hidden" id={tableId}>
        <caption>{title}</caption>
        <thead><tr><th scope="col">Stage</th><th scope="col">Count</th><th scope="col">Step conversion</th></tr></thead>
        <tbody>
          {laid.map((s, i) => (
            <tr key={s.label}><th scope="row">{s.label}</th><td>{valueFormat(s.value)}</td><td>{i === 0 ? '100%' : formatPercent(s.stepRate)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------- WaterfallChart ----------------------------- */

export interface WaterfallChartProps {
  items: WaterfallInput[];
  height?: number;
  title: string;
  description?: string;
  valueFormat?: (value: number) => string;
  className?: string;
}

/** Built for MRR movement: opening, new, expansion, contraction, churn, closing. */
export function WaterfallChart({
  items, height = 260, title, description, valueFormat = defaultFormat, className,
}: WaterfallChartProps) {
  const [ref, width] = useChartWidth();
  const tableId = useId();
  const bars = useMemo(() => waterfallLayout(items), [items]);

  const margin = { top: 22, right: 12, bottom: 40, left: 56 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const values = bars.flatMap((b) => [b.start, b.end]);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(...values), 5);
  const y = linearScale([ticks[0], ticks[ticks.length - 1]], [margin.top + plotH, margin.top]);
  const band = bandScale(bars.length, [margin.left, margin.left + plotW], 0.34);

  return (
    <div className={cx('ain-chart', className)}>
      <div className="ain-chart__plot" ref={ref}>
        <svg className="ain-chart__svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
             role="img" aria-label={title} aria-describedby={tableId}>
          {description && <desc>{description}</desc>}
          <g className="ain-chart__grid" aria-hidden>
            {ticks.map((t) => <line key={t} x1={margin.left} x2={margin.left + plotW} y1={y(t)} y2={y(t)} className={t === 0 ? 'is-zero' : undefined} />)}
          </g>
          <g className="ain-chart__axis" aria-hidden>
            {ticks.map((t) => <text key={t} x={margin.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle">{valueFormat(t)}</text>)}
            {bars.map((b, i) => <text key={b.label + i} x={band.center(i)} y={margin.top + plotH + 16} textAnchor="middle">{b.label}</text>)}
          </g>
          {bars.map((b, i) => {
            const top = Math.min(y(b.start), y(b.end));
            const barHeight = Math.max(2, Math.abs(y(b.end) - y(b.start)));
            const fill = b.kind === 'total' ? 'var(--viz-1)' : b.value >= 0 ? 'var(--green-500)' : 'var(--red-500)';
            return (
              <g key={b.label + i}>
                {i > 0 && b.kind === 'delta' && (
                  <line
                    x1={band(i - 1)} x2={band(i) + band.bandwidth} y1={y(b.start)} y2={y(b.start)}
                    stroke="var(--border-strong)" strokeWidth={1} strokeDasharray="3 3" aria-hidden
                  />
                )}
                <rect
                  className="ain-chart__bar ain-anim-grow" x={band(i)} y={top} width={band.bandwidth} height={barHeight}
                  rx={2} fill={fill} style={{ animationDelay: `${i * 60}ms`, transformOrigin: `center ${b.value >= 0 ? top + barHeight : top}px` }}
                >
                  <title>{`${b.label}: ${valueFormat(b.value)}`}</title>
                </rect>
                <text
                  className="ain-chart__axis" x={band.center(i)} y={top - 6} textAnchor="middle"
                  fill="var(--text-secondary)" fontSize="10.5" fontVariant="tabular-nums"
                >
                  {b.kind === 'delta' && b.value > 0 ? '+' : ''}{valueFormat(b.value)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <table className="u-visually-hidden" id={tableId}>
        <caption>{title}</caption>
        <thead><tr><th scope="col">Movement</th><th scope="col">Amount</th><th scope="col">Running total</th></tr></thead>
        <tbody>
          {bars.map((b, i) => <tr key={b.label + i}><th scope="row">{b.label}</th><td>{valueFormat(b.value)}</td><td>{valueFormat(b.cumulative)}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------------- Heatmap -------------------------------- */

export interface HeatmapProps {
  /** Row-major matrix: `values[row][column]`. */
  values: number[][];
  rows: string[];
  columns: string[];
  title: string;
  description?: string;
  color?: string;
  valueFormat?: (value: number) => string;
  className?: string;
}

export function Heatmap({
  values, rows, columns, title, description, color = 'var(--viz-1)', valueFormat = (v) => formatNumber(v), className,
}: HeatmapProps) {
  const scale = useMemo(() => heatScale(values.flat()), [values]);
  const tableId = useId();
  return (
    <div className={cx('ain-chart', 'ain-heat', className)}>
      <div
        className="ain-heat__grid"
        role="img"
        aria-label={title}
        aria-describedby={tableId}
        style={{ gridTemplateColumns: `auto repeat(${columns.length}, minmax(0, 1fr))` }}
      >
        {description && <span className="u-visually-hidden">{description}</span>}
        <span />
        {columns.map((c) => <span key={c} className="ain-heat__collabel" style={{ textAlign: 'center' }}>{c}</span>)}
        {rows.map((row, r) => (
          <Fragment key={row}>
            <span className="ain-heat__rowlabel" style={{ paddingInlineEnd: 'var(--space-3)', alignSelf: 'center' }}>{row}</span>
            {columns.map((col, c) => {
              const value = values[r]?.[c] ?? 0;
              const intensity = scale(value);
              return (
                <div
                  key={`${row}-${col}`}
                  className="ain-heat__cell"
                  tabIndex={0}
                  role="presentation"
                  title={`${row} · ${col}: ${valueFormat(value)}`}
                  style={{ background: intensity <= 0 ? 'var(--bg-sunken)' : `color-mix(in srgb, ${color} ${Math.round(12 + intensity * 88)}%, var(--bg-sunken))` }}
                />
              );
            })}
          </Fragment>
        ))}
      </div>
      <div className="ain-heat__scale">
        <span>Less</span>
        {[0.08, 0.3, 0.55, 0.78, 1].map((step) => (
          <span key={step} className="ain-heat__swatch" style={{ background: `color-mix(in srgb, ${color} ${Math.round(step * 100)}%, var(--bg-sunken))` }} />
        ))}
        <span>More</span>
      </div>
      <table className="u-visually-hidden" id={tableId}>
        <caption>{title}</caption>
        <thead><tr><th scope="col">Row</th>{columns.map((c) => <th scope="col" key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={row}><th scope="row">{row}</th>{columns.map((c, i) => <td key={c}>{valueFormat(values[r]?.[i] ?? 0)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
