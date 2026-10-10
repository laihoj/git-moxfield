import clsx from 'clsx';

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
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        className="size-4"
      >
        <circle cx="7" cy="6" r="2.25" />
        <circle cx="7" cy="18" r="2.25" />
        <circle cx="17" cy="8" r="2.25" />
        <path d="M7 8.25v7.5" />
        <path d="M17 10.25c0 3.5-3 4.75-8.5 5.75" />
      </svg>
    </span>
  );
}
