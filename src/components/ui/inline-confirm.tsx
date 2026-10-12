'use client';

import clsx from 'clsx';
import { useId, useState, useTransition, type ReactNode } from 'react';

import type { AccountActionResult } from '@/app/action-types';

import { Button, type ButtonVariant } from './button';
import { ErrorText } from './field';

export interface InlineConfirmProps {
  /** The button that starts the confirmation (`Revoke`). */
  trigger: { label: string; icon?: ReactNode; variant?: ButtonVariant; ariaLabel?: string };
  /** What will happen, in a sentence or two. Labels the panel. */
  message: ReactNode;
  /** Choices about what happens (e.g. a checkbox), between the message and the buttons. */
  details?: ReactNode;
  /** Label of the confirming button (`Revoke bookmarklet`). */
  confirmLabel: string;
  /** Runs the action; resolves with whether it worked, and the message to show if it did not. */
  onConfirm: () => Promise<AccountActionResult>;
  /** `danger` for destructive actions (default), `primary` otherwise. */
  tone?: 'danger' | 'primary';
  className?: string;
}

/**
 * A two-step action: a quiet trigger button, then an inline panel that says what will
 * happen, with Confirm and Cancel. Used for revoking, signing devices out and disabling
 * people, where a stray tap must not do anything. Focus moves into the panel and back.
 */
export function InlineConfirm({
  trigger,
  message,
  details,
  confirmLabel,
  onConfirm,
  tone = 'danger',
  className,
}: InlineConfirmProps) {
  const [confirming, setConfirming] = useState(false);
  /** After Cancel, the trigger takes focus back (it remounts in place of the panel). */
  const [returnFocus, setReturnFocus] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const messageId = useId();

  if (!confirming) {
    return (
      <Button
        variant={trigger.variant ?? 'ghost'}
        size="sm"
        icon={trigger.icon}
        aria-label={trigger.ariaLabel}
        className={className}
        autoFocus={returnFocus}
        onClick={() => {
          setConfirming(true);
          setError(null);
        }}
      >
        {trigger.label}
      </Button>
    );
  }

  return (
    <div
      role="group"
      aria-labelledby={messageId}
      className={clsx(
        'flex w-full flex-col gap-3 rounded-lg border p-3 md:p-4',
        tone === 'danger' ? 'border-remove/30 bg-remove-bg' : 'border-accent/30 bg-accent-soft/60',
        className,
      )}
    >
      <div id={messageId} className="text-sm text-pretty text-fg">
        {message}
      </div>
      {details}
      {error !== null && <ErrorText>{error}</ErrorText>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant={tone}
          size="sm"
          loading={pending}
          // The panel replaces the trigger, so focus lands on the confirming button.
          autoFocus
          onClick={() => {
            startTransition(async () => {
              const result = await onConfirm();
              if (result.ok) setConfirming(false);
              setError(result.ok ? null : result.message);
            });
          }}
        >
          {confirmLabel}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={() => {
            setConfirming(false);
            setReturnFocus(true);
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
