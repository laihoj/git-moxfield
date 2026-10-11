import clsx from 'clsx';
import { Plus, X } from 'lucide-react';
import type { ReactNode } from 'react';

export interface TagChipProps {
  tag: string;
  /** `li` in a list of tags, `span` inside a text field. */
  as?: 'li' | 'span';
  /** `sm` for the compact version rows. */
  size?: 'md' | 'sm';
  /** Adds a remove button; without it the chip is read-only. */
  onRemove?: () => void;
  disabled?: boolean;
  /** After the remove button (e.g. the hidden input a form submits the tag with). */
  children?: ReactNode;
}

/**
 * A version tag as a chip. The editors and the read-only lists (share link viewers) all
 * show a tag with this one look; the remove button is 24px with a larger hit area on
 * touch screens.
 */
export function TagChip({
  tag,
  as: Component = 'li',
  size = 'md',
  onRemove,
  disabled = false,
  children,
}: TagChipProps) {
  return (
    <Component
      className={clsx(
        'rounded-full bg-accent-soft font-medium text-accent',
        size === 'sm' ? 'px-2 text-xs leading-5' : 'inline-flex h-7 items-center text-sm',
        size === 'md' && (onRemove === undefined ? 'px-2.5' : 'gap-0.5 pr-0.5 pl-2.5'),
      )}
    >
      {tag}
      {onRemove !== undefined && (
        <button
          type="button"
          disabled={disabled}
          aria-label={`Remove tag ${tag}`}
          className="relative flex size-6 items-center justify-center rounded-full after:absolute after:-inset-2 after:content-[''] hover:bg-accent/15 md:after:hidden"
          onClick={onRemove}
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      )}
      {children}
    </Component>
  );
}

/** How many suggestions are offered at most. */
const SUGGESTION_LIMIT = 8;

export interface TagSuggestionsProps {
  /** The tags to offer, e.g. those used elsewhere in the deck. */
  tags: readonly string[];
  /** Tags not to offer (the version already has them). */
  exclude: readonly string[];
  onPick: (tag: string) => void;
  disabled?: boolean;
}

/** One-tap suggestions of tags used before; nothing when there are none left to offer. */
export function TagSuggestions({ tags, exclude, onPick, disabled = false }: TagSuggestionsProps) {
  const available = tags.filter((tag) => !exclude.includes(tag)).slice(0, SUGGESTION_LIMIT);
  if (available.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted">Used before:</span>
      {available.map((tag) => (
        <button
          key={tag}
          type="button"
          disabled={disabled}
          className="relative inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-border-strong px-2.5 text-xs font-medium text-muted transition-colors after:absolute after:-inset-y-2 after:inset-x-0 after:content-[''] hover:border-accent hover:text-accent md:after:hidden"
          onClick={() => {
            onPick(tag);
          }}
        >
          <Plus aria-hidden="true" className="size-3" />
          {tag}
        </button>
      ))}
    </div>
  );
}
