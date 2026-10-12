'use client';

import { Tag } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';

import { ErrorText, fieldControlProps, fieldDescriptionIds } from '@/components/ui/field';
import { parseTagDraft } from '@/core/tags';

import { TagChip, TagSuggestions } from './tag-chip';

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

  function add(raw: string): boolean {
    const draft = parseTagDraft(raw);
    if (draft.kind === 'empty') return true;
    if (draft.kind === 'invalid') {
      setProblem(draft.problem);
      return false;
    }
    setProblem(null);
    if (!value.includes(draft.tag)) onChange([...value, draft.tag]);
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
          <TagChip
            key={tag}
            tag={tag}
            as="span"
            disabled={disabled}
            onRemove={() => {
              remove(tag);
            }}
          >
            <input type="hidden" name={name} value={tag} />
          </TagChip>
        ))}
        <input
          value={draft}
          disabled={disabled}
          placeholder={value.length === 0 ? 'tournament, stable…' : 'Add tag'}
          {...fieldControlProps(id, { invalid: problem !== null })}
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
        <ErrorText id={ids.error}>{problem}</ErrorText>
      ) : (
        <p id={ids.hint} className="sr-only">
          Press Enter to add a tag.
        </p>
      )}
      <TagSuggestions
        tags={suggestions}
        exclude={value}
        disabled={disabled}
        onPick={(tag) => {
          add(tag);
        }}
      />
    </div>
  );
}
