'use client';

import clsx from 'clsx';
import { X } from 'lucide-react';
import type { Route } from 'next';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { ALERT_TONES } from './alert';
import { TextLink } from './text-link';

export type ToastTone = 'success' | 'info' | 'error';

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Optional link shown in the toast (e.g. "View v48"). */
  action?: { label: string; href: Route };
}

interface Toast extends ToastInput {
  id: number;
}

type ShowToast = (toast: ToastInput) => void;

const ToastContext = createContext<ShowToast | null>(null);

const DISMISS_AFTER_MS = 6000;
const MAX_TOASTS = 3;

/**
 * Returns a function that shows a short-lived confirmation. Toasts live at the root
 * layout, so they survive the re-render that follows a server action (e.g. the commit
 * form disappearing once the deck is up to date).
 */
export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (show === null) throw new Error('useToast must be used inside <Toaster>.');
  return show;
}

/** Provides `useToast` and renders the toast stack (bottom-centered on mobile, bottom-right on desktop). */
export function Toaster({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback<ShowToast>((input) => {
    const id = nextId.current++;
    setToasts((current) => [...current, { ...input, id }].slice(-MAX_TOASTS));
  }, []);

  return (
    <ToastContext value={show}>
      {children}
      <div
        aria-live="polite"
        aria-relevant="additions"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--bottom-nav-offset,0px)+env(safe-area-inset-bottom)+1rem)] z-50 flex flex-col items-center gap-2 px-4 md:inset-x-auto md:right-6 md:bottom-6 md:items-end md:px-0"
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const tone = toast.tone ?? 'success';
  const { Icon, icon } = ALERT_TONES[tone];

  useEffect(() => {
    const timer = window.setTimeout(() => {
      onDismiss(toast.id);
    }, DISMISS_AFTER_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [toast.id, onDismiss]);

  return (
    <div className="toast-enter pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm shadow-pop">
      <Icon aria-hidden="true" className={clsx('mt-0.5 size-4 shrink-0', icon)} />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-fg">{toast.title}</p>
        {toast.description !== undefined && <p className="mt-0.5 text-muted">{toast.description}</p>}
        {toast.action !== undefined && (
          <TextLink
            href={toast.action.href}
            className="mt-1 inline-block"
            onClick={() => {
              onDismiss(toast.id);
            }}
          >
            {toast.action.label}
          </TextLink>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        className="-m-1 rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg"
        onClick={() => {
          onDismiss(toast.id);
        }}
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}
