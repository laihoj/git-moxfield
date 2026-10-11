import { ArrowUpRight } from 'lucide-react';
import type { ComponentPropsWithoutRef } from 'react';

export interface ExternalLinkProps extends Omit<ComponentPropsWithoutRef<'a'>, 'target' | 'rel'> {
  href: string;
  /** The ↗ after the text. Default: shown. */
  arrow?: boolean;
  /** What screen readers are told after the text. Default: `(opens in a new tab)`. */
  newTabLabel?: string;
}

/**
 * A link to another site: opens in a new tab without leaking the opener, shows the ↗ and
 * says so to screen readers. Style it with `className` (a text link, a button).
 */
export function ExternalLink({
  href,
  arrow = true,
  newTabLabel = '(opens in a new tab)',
  children,
  ...props
}: ExternalLinkProps) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
      {arrow && <ArrowUpRight aria-hidden="true" className="size-4 shrink-0" />}
      <span className="sr-only">{newTabLabel}</span>
    </a>
  );
}
