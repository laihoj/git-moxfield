'use client';

import { useEffect, useMemo, useRef } from 'react';

/**
 * One pending timeout that each `start` replaces (a debounce, a delayed show, fading
 * feedback) and that never outlives the component. The returned object is stable.
 */
export function useRestartableTimeout() {
  const timer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );

  return useMemo(
    () => ({
      start(callback: () => void, ms: number): void {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(callback, ms);
      },
      cancel(): void {
        window.clearTimeout(timer.current);
      },
    }),
    [],
  );
}
