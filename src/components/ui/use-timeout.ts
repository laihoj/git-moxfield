'use client';

import { useEffect, useMemo, useRef } from 'react';

export interface RestartableTimeout {
  /** Runs `callback` after `ms`, replacing a timeout that has not fired yet. */
  start: (callback: () => void, ms: number) => void;
  /** Drops the pending timeout, if any. */
  cancel: () => void;
}

/**
 * One pending timeout that each `start` replaces (a debounce, a delayed show, feedback
 * that fades) and that never outlives the component. The returned object is stable, so
 * it can be used in effects without being a dependency.
 */
export function useRestartableTimeout(): RestartableTimeout {
  const timer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );

  return useMemo(
    () => ({
      start(callback, ms) {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(callback, ms);
      },
      cancel() {
        window.clearTimeout(timer.current);
      },
    }),
    [],
  );
}
