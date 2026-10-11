'use client';

import { useEffect, type RefObject } from 'react';

export interface UseDismissOptions {
  /** Listens only while the popover is open. */
  open: boolean;
  onDismiss: () => void;
  /** The popover and its button: pointing or tabbing outside it dismisses. */
  root: RefObject<HTMLElement | null>;
  /** Takes focus back when Escape dismisses the popover. */
  returnFocus: RefObject<HTMLElement | null>;
}

/**
 * Dismissal of a popover (a menu, a disclosure panel) while it is open: a pointer press
 * outside `root`, keyboard focus moving outside it (Tab past the last item) and Escape,
 * which also returns focus to `returnFocus`. Choosing an item is the popover's own business.
 */
export function useDismiss({ open, onDismiss, root, returnFocus }: UseDismissOptions): void {
  useEffect(() => {
    if (!open) return;
    const isOutside = (target: EventTarget | null): boolean =>
      target instanceof Node && root.current?.contains(target) !== true;
    const onPointerDown = (event: PointerEvent): void => {
      if (isOutside(event.target)) onDismiss();
    };
    const onFocusIn = (event: FocusEvent): void => {
      if (isOutside(event.target)) onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      onDismiss();
      returnFocus.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onDismiss, root, returnFocus]);
}
