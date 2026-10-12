'use client';

import { useEffect, type RefObject } from 'react';

interface UseDismissOptions {
  open: boolean;
  onDismiss: () => void;
  /** The popover and its button. */
  root: RefObject<HTMLElement | null>;
  returnFocus: RefObject<HTMLElement | null>;
}

/**
 * Dismissal of an open popover (a menu): a pointer press or keyboard focus (Tab past the
 * last item) outside `root`, and Escape, which also returns focus to `returnFocus`.
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
