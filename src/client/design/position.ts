/**
 * Anchored-overlay placement. Pure arithmetic over rectangles so it can be
 * unit-tested: given an anchor, a floating box and a viewport, decide where the
 * box goes, flipping to the opposite side when it would be clipped and sliding
 * along the cross axis to stay on screen.
 */

export type Side = 'top' | 'bottom' | 'left' | 'right';
export type Alignment = 'start' | 'center' | 'end';
export type Placement = Side | `${Side}-${Alignment}`;

export interface Rect { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }

export interface PositionOptions {
  placement?: Placement;
  /** Gap between the anchor and the floating element, in px. */
  offset?: number;
  /** Keep this much clearance from the viewport edge. */
  padding?: number;
  flip?: boolean;
  /** Match the anchor's width — dropdown menus under a full-width input. */
  matchWidth?: boolean;
}

export interface PositionResult {
  x: number;
  y: number;
  placement: Placement;
  /** True when the box had to flip to the opposite side. */
  flipped: boolean;
  maxHeight: number;
  width?: number;
}

const parse = (placement: Placement): [Side, Alignment] => {
  const [side, align] = placement.split('-') as [Side, Alignment | undefined];
  return [side, align ?? 'center'];
};

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

function place(anchor: Rect, size: Size, side: Side, align: Alignment, offset: number): { x: number; y: number } {
  let x = 0;
  let y = 0;
  if (side === 'bottom' || side === 'top') {
    y = side === 'bottom' ? anchor.y + anchor.height + offset : anchor.y - size.height - offset;
    x = align === 'start' ? anchor.x
      : align === 'end' ? anchor.x + anchor.width - size.width
      : anchor.x + anchor.width / 2 - size.width / 2;
  } else {
    x = side === 'right' ? anchor.x + anchor.width + offset : anchor.x - size.width - offset;
    y = align === 'start' ? anchor.y
      : align === 'end' ? anchor.y + anchor.height - size.height
      : anchor.y + anchor.height / 2 - size.height / 2;
  }
  return { x, y };
}

function spaceOn(anchor: Rect, side: Side, viewport: Size, padding: number): number {
  switch (side) {
    case 'top': return anchor.y - padding;
    case 'bottom': return viewport.height - (anchor.y + anchor.height) - padding;
    case 'left': return anchor.x - padding;
    case 'right': return viewport.width - (anchor.x + anchor.width) - padding;
  }
}

export function computePosition(
  anchor: Rect,
  size: Size,
  viewport: Size,
  opts: PositionOptions = {},
): PositionResult {
  const { placement = 'bottom-start', offset = 6, padding = 8, flip = true } = opts;
  const [preferred, align] = parse(placement);
  const width = opts.matchWidth ? Math.max(size.width, anchor.width) : size.width;
  const box = { width, height: size.height };

  let side = preferred;
  let flipped = false;
  if (flip) {
    const room = spaceOn(anchor, preferred, viewport, padding);
    const needed = preferred === 'top' || preferred === 'bottom' ? box.height + offset : box.width + offset;
    if (room < needed) {
      const other = OPPOSITE[preferred];
      if (spaceOn(anchor, other, viewport, padding) > room) { side = other; flipped = true; }
    }
  }

  let { x, y } = place(anchor, box, side, align, offset);

  // Slide along the cross axis instead of letting the box hang off-screen.
  x = Math.min(Math.max(padding, x), Math.max(padding, viewport.width - box.width - padding));
  y = Math.min(Math.max(padding, y), Math.max(padding, viewport.height - box.height - padding));

  const available = spaceOn(anchor, side, viewport, padding) - offset;
  const maxHeight = side === 'top' || side === 'bottom'
    ? Math.max(120, available)
    : Math.max(120, viewport.height - padding * 2);

  return {
    x: Math.round(x),
    y: Math.round(y),
    placement: `${side}-${align}` as Placement,
    flipped,
    maxHeight: Math.round(maxHeight),
    width: opts.matchWidth ? Math.round(width) : undefined,
  };
}

/**
 * The little a floating box has to expose for `repositionFloating` to place it:
 * a `max-height` that can be read back and cleared, and a border-box size that
 * honours it. Modelled as an interface so the placement pass — the part that
 * actually got this wrong — is testable without a DOM.
 */
export interface FloatingElement {
  /** Applied `max-height` in px, or `null` when the box is unclamped. */
  clamp: number | null;
  /** Border-box size *as currently clamped*. */
  readonly size: Size;
}

/**
 * One placement pass, in the only order that works.
 *
 * The clamp written by the previous pass must come off *before* measuring: a
 * 286px box already clamped to 120px measures 120px, which fits under an anchor
 * near the bottom edge, so the "not enough room below" branch never fires and
 * the box stays pinned there — showing a title and nothing else while 800px of
 * screen sits unused above it. Measure natural, choose the side, clamp after.
 *
 * Returns `null` when the box has not been laid out yet (detached, or
 * `display: none`), because a 0×0 box fits anywhere and would place wrongly.
 */
export function repositionFloating(
  el: FloatingElement,
  anchor: Rect,
  viewport: Size,
  opts: PositionOptions = {},
): PositionResult | null {
  const previous = el.clamp;
  el.clamp = null;
  const natural = el.size;
  if (natural.width === 0 && natural.height === 0) {
    el.clamp = previous;
    return null;
  }
  const result = computePosition(anchor, natural, viewport, opts);
  el.clamp = result.maxHeight;
  return result;
}

/** Wraps a real element as a `FloatingElement`, clamp read from inline style. */
export const floatingElement = (el: HTMLElement): FloatingElement => ({
  get clamp(): number | null {
    const value = Number.parseFloat(el.style.maxHeight);
    return Number.isFinite(value) ? value : null;
  },
  set clamp(value: number | null) {
    el.style.maxHeight = value === null ? '' : `${value}px`;
  },
  get size(): Size {
    return { width: el.offsetWidth, height: el.offsetHeight };
  },
});

export const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};

export const viewportSize = (): Size => ({
  width: typeof window === 'undefined' ? 1024 : window.innerWidth,
  height: typeof window === 'undefined' ? 768 : window.innerHeight,
});
