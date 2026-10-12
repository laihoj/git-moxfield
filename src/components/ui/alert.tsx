import clsx from 'clsx';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

export type AlertTone = 'info' | 'warn' | 'error' | 'success';

/** How each tone looks: the box, the icon's colour and the icon (the toasts use them too). */
export const ALERT_TONES: Record<AlertTone, { box: string; icon: string; Icon: typeof Info }> = {
  info: { box: 'border-move/25 bg-move-bg', icon: 'text-move', Icon: Info },
  warn: { box: 'border-warn/30 bg-warn-bg', icon: 'text-warn', Icon: TriangleAlert },
  error: { box: 'border-remove/30 bg-remove-bg', icon: 'text-remove', Icon: CircleAlert },
  success: { box: 'border-add/25 bg-add-bg', icon: 'text-add', Icon: CircleCheck },
};

export interface AlertProps {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Buttons or links below the text. */
  actions?: ReactNode;
  /** Content at the top-right corner (e.g. a dismiss button). */
  trailing?: ReactNode;
  /**
   * `alert` interrupts screen readers (errors that just happened); `status` is polite.
   * Leave unset for alerts that are part of the page from the start.
   */
  role?: 'alert' | 'status';
  className?: string;
}

/** Inline banner for information, warnings and errors. Always has an icon and text. */
export function Alert({ tone = 'info', title, children, actions, trailing, role, className }: AlertProps) {
  const { box, icon, Icon } = ALERT_TONES[tone];
  return (
    <div role={role} className={clsx('flex gap-3 rounded-xl border px-4 py-3 text-sm', box, className)}>
      <Icon aria-hidden="true" className={clsx('mt-0.5 size-4 shrink-0', icon)} />
      <div className="min-w-0 flex-1">
        {title !== undefined && <p className="font-semibold text-fg">{title}</p>}
        {children !== undefined && (
          <div
            className={clsx('text-fg/85 [&_a]:font-medium [&_a]:underline', title !== undefined && 'mt-0.5')}
          >
            {children}
          </div>
        )}
        {actions !== undefined && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
      </div>
      {trailing}
    </div>
  );
}
