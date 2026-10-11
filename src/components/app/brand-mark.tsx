import clsx from 'clsx';

import { BrandGlyph } from './brand-glyph';

/**
 * The git-moxfield mark: a branch glyph (two commits and a fork) on the accent violet.
 * Shared by the header and mirrored by `app/icon.svg` and the generated PNG icons.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg',
        className,
      )}
    >
      <BrandGlyph className="size-4" />
    </span>
  );
}
