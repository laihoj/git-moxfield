import clsx from 'clsx';
import type { ReactNode } from 'react';

export interface AuthPanelProps {
  /** A lucide icon element, shown in a tile above the title. */
  icon: ReactNode;
  /** `accent` for invitations and sign-in; `muted` for links that no longer work. */
  tone?: 'accent' | 'muted';
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Small print below the content. */
  footer?: ReactNode;
}

/**
 * The narrow, centered layout of the pages a signed-out visitor sees: sign in, claim,
 * invites and one-time links. One column, the page's only `h1`, the content below.
 */
export function AuthPanel({ icon, tone = 'accent', title, description, children, footer }: AuthPanelProps) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 pt-2 md:pt-10">
      <div className="flex flex-col items-center text-center">
        <span
          className={clsx(
            'mb-4 flex size-12 items-center justify-center rounded-2xl [&>svg]:size-6',
            tone === 'accent' ? 'bg-accent-soft text-accent' : 'bg-surface-3 text-muted',
          )}
        >
          {icon}
        </span>
        <h1 className="text-2xl font-semibold tracking-tight text-balance text-fg">{title}</h1>
        {description !== undefined && (
          <div className="mt-2 max-w-sm text-base text-balance text-muted">{description}</div>
        )}
      </div>
      {children}
      {footer !== undefined && <div className="text-center text-sm text-balance text-muted">{footer}</div>}
    </div>
  );
}
