import { Eye } from 'lucide-react';

/**
 * The notice under the header of every share link page (ADR 0007): whose deck this is,
 * and that it can only be looked at. Full width, so it reads as part of the page frame
 * rather than of the deck.
 */
export function ReadOnlyBanner({ ownerName }: { ownerName: string }) {
  return (
    <div className="border-t border-border bg-surface-2/70">
      <p className="page-gutter mx-auto flex w-full max-w-[1080px] items-center gap-2 py-2 text-sm text-muted">
        <Eye aria-hidden="true" className="size-4 shrink-0 text-accent" />
        {/* The spaces between the flex items are not rendered; they keep the copied text readable. */}
        <span className="min-w-0 truncate">
          Shared by <span className="font-medium text-fg">{ownerName}</span>
        </span>{' '}
        <span aria-hidden="true" className="text-subtle">
          ·
        </span>{' '}
        <span className="shrink-0">read-only</span>
      </p>
    </div>
  );
}
