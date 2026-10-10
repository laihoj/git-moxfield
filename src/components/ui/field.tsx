import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

/**
 * Form controls. Font size is 16px on small screens so iOS Safari does not zoom into
 * focused fields, and 14px from `md` up.
 */
const CONTROL =
  'block w-full rounded-lg border border-border-strong bg-surface text-base text-fg shadow-card transition-[border-color,box-shadow] placeholder:text-subtle focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-remove aria-invalid:focus:ring-remove/20 md:text-sm';

export interface FieldProps {
  label: ReactNode;
  /** Id of the control, so the label is associated with it. */
  htmlFor: string;
  hint?: ReactNode;
  /** Validation error; also set `aria-invalid` and `aria-describedby` on the control. */
  error?: ReactNode;
  /** Content next to the label (e.g. a "Use suggestion" button). */
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** Ids for a field's hint and error, to wire up `aria-describedby`. */
export function fieldDescriptionIds(id: string): { hint: string; error: string } {
  return { hint: `${id}-hint`, error: `${id}-error` };
}

/** Label, control, hint and error message, stacked with consistent spacing. */
export function Field({ label, htmlFor, hint, error, aside, className, children }: FieldProps) {
  const ids = fieldDescriptionIds(htmlFor);
  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      <div className="flex min-h-5 items-end justify-between gap-3">
        <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
          {label}
        </label>
        {aside}
      </div>
      {children}
      {hint !== undefined && error === undefined && (
        <p id={ids.hint} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p id={ids.error} className="text-sm text-remove" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function Input({ className, ...props }: ComponentPropsWithoutRef<'input'>) {
  // Long values and placeholders end in an ellipsis instead of being cut mid-letter.
  return <input className={clsx(CONTROL, 'h-11 px-3 text-ellipsis md:h-10', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentPropsWithoutRef<'textarea'>) {
  return <textarea className={clsx(CONTROL, 'min-h-24 px-3 py-2.5 leading-relaxed', className)} {...props} />;
}

export function Select({ className, children, ...props }: ComponentPropsWithoutRef<'select'>) {
  return (
    <div className={clsx('relative', className)}>
      <select className={clsx(CONTROL, 'h-11 appearance-none truncate pr-9 pl-3 md:h-10')} {...props}>
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted"
      />
    </div>
  );
}
