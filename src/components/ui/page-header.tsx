import type { ReactNode } from 'react';

/** The title of a page and, under it, a sentence about what it is for. */
export function PageHeader({ title, description }: { title: ReactNode; description?: ReactNode }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
      {description !== undefined && <p className="mt-1 text-sm text-pretty text-muted">{description}</p>}
    </div>
  );
}
