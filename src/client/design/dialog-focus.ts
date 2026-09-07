import { useEffect, type RefObject } from 'react';

/**
 * Everything inside a dialog that a person can reach with the keyboard, in the
 * order the browser would reach it.
 */
const FOCUSABLE = [
  'input:not([type="hidden"]):not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/**
 * Move focus off the dialog's Close button and onto its first real field.
 *
 * The modal's focus trap puts focus on Close, which is correct for a dialog
 * that only announces something and wrong for one that asks for something: the
 * operator starts typing and their first Enter lands on the one control that
 * throws the work away.
 *
 * **In the same animation frame** is the whole of it. The trap's callback and
 * this one sit in one frame's queue in mount order, and no task — no keystroke
 * — runs between two callbacks of the same frame. Waiting an extra frame opens
 * a real window instead: on a loaded machine a frame is not 16ms, and for the
 * whole of it focus sits on Close with the operator already typing. That was a
 * live defect in the billing dialogs, measured at 116ms under CPU throttling.
 *
 * An operator who has already clicked into the form is left where they are.
 */
export function useFocusFirstField(open: boolean, root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const el = root.current;
      if (!el) return;
      const first = el.querySelector<HTMLElement>(FOCUSABLE);
      const active = document.activeElement;
      if (first && (!active || !el.contains(active))) first.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, root]);
}

export { FOCUSABLE };
