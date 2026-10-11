'use client';

import { useState, useTransition } from 'react';

/**
 * What a server action answers when it can fail without throwing: it worked, or the
 * message to show. The account, admin, share and untrack actions return this shape.
 */
export type ActionResult = { ok: true } | { ok: false; message: string };

export interface ActionRunner {
  /** An action is running. */
  pending: boolean;
  /** The message of the last action that failed; `null` after one that worked. */
  error: string | null;
  /** Runs `action` in a transition and keeps its failure for display. */
  run: (action: () => Promise<ActionResult>) => void;
}

/** Runs a server action from a button and keeps the pending state and the failure message. */
export function useActionRunner(): ActionRunner {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return {
    pending,
    error,
    run(action) {
      startTransition(async () => {
        const result = await action();
        setError(result.ok ? null : result.message);
      });
    },
  };
}
