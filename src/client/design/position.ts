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
  maxWidth: number;
  width?: number;
}

const parse = (placement: Placement): [Side, Alignment] => {
  const [side, align] = placement.split('-') as [Side, Alignment | undefined];
  return [side, align ?? 'center'];
};

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/**
 * A floating box never shrinks below this, even where there is less room: a
 * 30px-tall menu is not a menu. It is the one case where a side-placed box can
 * still cross its anchor, and only on a viewport too short to hold both.
 */
const MIN_HEIGHT = 120;

/**
 * The same floor on the other axis. `.ain-menu` sets `min-width: 200px`, so a
 * max-width under that cannot make the box any narrower — it would only clip
 * the labels.
 */
const MIN_WIDTH = 200;

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

  // The height the box will actually render at is its content clipped by the
  // room on the side we just chose — so that is the height to place and clamp
  // with. Using the natural height instead is what slid a 508px date editor
  // over the chip that opened it: on a 460px window `viewport.height - 508 -
  // padding` is negative, the clamp collapsed to `padding`, and the box landed
  // at y=8 covering its own anchor and the whole filter bar.
  const available = spaceOn(anchor, side, viewport, padding) - offset;
  const vertical = side === 'top' || side === 'bottom';
  const maxHeight = vertical
    ? Math.max(MIN_HEIGHT, available)
    : Math.max(MIN_HEIGHT, viewport.height - padding * 2);
  // Width gets the identical treatment, because a side-placed box is clipped by
  // the room beside its anchor exactly the way a top/bottom one is clipped by
  // the room above or below it. Clamping x against an unclamped `box.width` is
  // the height bug one axis over: `viewport.width - box.width - padding` goes
  // negative for a box wider than the screen, the clamp collapses to `padding`,
  // and a submenu lands on top of the menu that opened it.
  const maxWidth = vertical
    ? Math.max(MIN_WIDTH, viewport.width - padding * 2)
    : Math.max(MIN_WIDTH, available);
  const height = Math.min(box.height, maxHeight);
  const rendered = Math.min(box.width, maxWidth);

  let { x, y } = place(anchor, { width: rendered, height }, side, align, offset);

  // Slide along the cross axis instead of letting the box hang off-screen.
  x = Math.min(Math.max(padding, x), Math.max(padding, viewport.width - rendered - padding));
  y = Math.min(Math.max(padding, y), Math.max(padding, viewport.height - height - padding));

  return {
    x: Math.round(x),
    y: Math.round(y),
    placement: `${side}-${align}` as Placement,
    flipped,
    maxHeight: Math.round(maxHeight),
    maxWidth: Math.round(maxWidth),
    width: opts.matchWidth ? Math.round(rendered) : undefined,
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

/**
 * Wraps a real element as a `FloatingElement`, clamp read from inline style.
 *
 * Taking the clamp off to measure has a side effect the arithmetic cannot see:
 * for the instant the box is unclamped, everything inside it fits its own
 * content, and a box that does not overflow cannot hold a scroll offset — the
 * browser resets it to 0 and does not put it back when the clamp returns. That
 * is what threw a combobox list back to the top the moment the highlight was
 * scrolled onto the sixth owner, and it happened on every pass, because a
 * re-render repositions. So park the offsets before unclamping and hand them
 * back once the box can hold them again.
 */
export const floatingElement = (el: HTMLElement): FloatingElement => {
  let parked: [HTMLElement, number][] = [];
  return {
    get clamp(): number | null {
      const value = Number.parseFloat(el.style.maxHeight);
      return Number.isFinite(value) ? value : null;
    },
    set clamp(value: number | null) {
      if (value === null) {
        parked = [el, ...el.querySelectorAll<HTMLElement>('*')]
          .filter((node) => node.scrollTop > 0)
          .map((node) => [node, node.scrollTop] as [HTMLElement, number]);
      }
      el.style.maxHeight = value === null ? '' : `${value}px`;
      if (value !== null) for (const [node, top] of parked) node.scrollTop = top;
    },
    get size(): Size {
      return { width: el.offsetWidth, height: el.offsetHeight };
    },
  };
};

export const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};

export const viewportSize = (): Size => ({
  width: typeof window === 'undefined' ? 1024 : window.innerWidth,
  height: typeof window === 'undefined' ? 768 : window.innerHeight,
});
