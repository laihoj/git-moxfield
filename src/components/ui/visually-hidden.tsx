import type { ReactNode } from 'react';

/** Text for screen readers only (e.g. the meaning of a `+` glyph). */
export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}
