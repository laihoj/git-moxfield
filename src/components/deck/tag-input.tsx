'use client';

import { Plus, Tag, X } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';

import { fieldDescriptionIds } from '@/components/ui/field';
import { normalizeTagInput, tagProblem } from '@/core/tags';

export interface TagInputProps {
  /** Form field name; one hidden input per tag is submitted under this name. */
  name: string;
  label: string;
  value: string[];
  onChange: (tags: string[]) => void;
  /** Existing tags offered as one-tap suggestions. */
  suggestions?: readonly string[];
  disabled?: boolean;
}

/**
 * Chip input for version tags: type and press Enter (or comma) to add, Backspace on
 * an empty input removes the last chip, suggestions add with one tap. Tags are
 * normalized as the server will store them.
 */
export function TagInput({
  name,
  label,
  value,
  onChange,
  suggestions = [],
  disabled = false,
}: TagInputProps) {
  const id = useId();
  const ids = fieldDescriptionIds(id);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const available = suggestions.filter((tag) => !value.includes(tag)).slice(0, 8);

  function add(raw: string): boolean {
    const tag = normalizeTagInput(raw);
    if (tag === '') return true;
    const issue = tagProblem(tag);
    if (issue !== null) {
      setProblem(issue);
      return false;
    }
    setProblem(null);
    if (!value.includes(tag)) onChange([...value, tag]);
    return true;
  }

  function remove(tag: string): void {
    onChange(value.filter((existing) => existing !== tag));
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      if (add(draft)) setDraft('');
    } else if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      remove(value[value.length - 1] ?? '');
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label} <span className="font-normal text-subtle">(optional)</span>
      </label>
      <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-2 py-1.5 shadow-card transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/20 md:min-h-10">
        <Tag aria-hidden="true" className="ml-1 size-4 shrink-0 text-subtle" />
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex h-7 items-center gap-0.5 rounded-full bg-accent-soft pr-0.5 pl-2.5 text-sm font-medium text-accent"
          >
            {tag}
            <button
              type="button"
              disabled={disabled}
              aria-label={`Remove tag ${tag}`}
              className="flex size-6 items-center justify-center rounded-full hover:bg-accent/15"
              onClick={() => {
                remove(tag);
              }}
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
            <input type="hidden" name={name} value={tag} />
          </span>
        ))}
        <input
          id={id}
          value={draft}
          disabled={disabled}
          placeholder={value.length === 0 ? 'tournament, stable…' : 'Add tag'}
          aria-invalid={problem !== null || undefined}
          aria-describedby={problem !== null ? ids.error : ids.hint}
          enterKeyHint="done"
          autoCapitalize="none"
          autoComplete="off"
          className="h-8 min-w-24 flex-1 bg-transparent px-1 text-base text-fg placeholder:text-subtle focus:outline-none md:text-sm"
          onChange={(event) => {
            setDraft(event.target.value);
            if (problem !== null) setProblem(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (add(draft)) setDraft('');
          }}
        />
      </div>
      {problem !== null ? (
        <p id={ids.error} role="alert" className="text-sm text-remove">
          {problem}
        </p>
      ) : (
        <p id={ids.hint} className="sr-only">
          Press Enter to add a tag.
        </p>
      )}
      {available.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted">Recent:</span>
          {available.map((tag) => (
            <button
              key={tag}
              type="button"
              disabled={disabled}
              className="relative inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-border-strong px-2.5 text-xs font-medium text-muted transition-colors after:absolute after:-inset-y-2 after:inset-x-0 after:content-[''] hover:border-accent hover:text-accent md:after:hidden"
              onClick={() => {
                add(tag);
              }}
            >
              <Plus aria-hidden="true" className="size-3" />
              {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
