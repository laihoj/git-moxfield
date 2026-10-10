'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button, type ButtonSize, type ButtonVariant } from './button';

/** How long the "Copied" confirmation stays visible. */
const FEEDBACK_MS = 2000;

/**
 * Copies text to the clipboard. Uses the async Clipboard API where available (secure
 * contexts) and falls back to a temporary textarea + `execCommand('copy')`, which
 * still works on plain-http LAN addresses (e.g. the app opened on a phone).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && 'clipboard' in navigator && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or unsupported: fall through to the legacy path.
  }
  return copyWithTextarea(text);
}

function copyWithTextarea(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.appendChild(textarea);
  // Focus first: iOS Safari only copies the selection of the focused element.
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  let copied = false;
  try {
    // The only clipboard API outside secure contexts; deprecated but universally supported.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  textarea.remove();
  previousFocus?.focus();
  return copied;
}

export interface CopyButtonProps {
  /** Text to copy. */
  text: string;
  /** Button label, e.g. `Copy` or `Copy 98 cards`. */
  label?: string;
  /** What is being copied, announced to screen readers (`Mainboard copied`). */
  subject?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  disabled?: boolean;
  className?: string;
}

type CopyState = 'idle' | 'copied' | 'failed';

/** Button that copies `text` and confirms with "Copied" (visually and via a live region). */
export function CopyButton({
  text,
  label = 'Copy',
  subject,
  variant = 'secondary',
  size = 'md',
  block,
  disabled,
  className,
}: CopyButtonProps) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );

  async function handleClick(): Promise<void> {
    const ok = await copyToClipboard(text);
    setState(ok ? 'copied' : 'failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setState('idle');
    }, FEEDBACK_MS);
  }

  const announcement =
    state === 'copied'
      ? `${subject ?? 'Text'} copied to the clipboard`
      : state === 'failed'
        ? 'Copying failed. Select the text and copy it manually.'
        : '';

  return (
    <>
      <Button
        variant={variant}
        size={size}
        block={block}
        disabled={disabled}
        className={className}
        icon={
          state === 'copied' ? (
            <Check aria-hidden="true" className={variant === 'primary' ? 'size-4' : 'size-4 text-add'} />
          ) : (
            <Copy aria-hidden="true" className="size-4" />
          )
        }
        onClick={() => {
          void handleClick();
        }}
      >
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
