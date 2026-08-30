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

export const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};

export const viewportSize = (): Size => ({
  width: typeof window === 'undefined' ? 1024 : window.innerWidth,
  height: typeof window === 'undefined' ? 768 : window.innerHeight,
});
