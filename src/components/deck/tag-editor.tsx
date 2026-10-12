'use client';

import { Plus } from 'lucide-react';
import { useId, useOptimistic, useRef, useState, useTransition, type SubmitEvent } from 'react';

import { addTagAction, removeTagAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { ErrorText, fieldControlProps, fieldDescriptionIds, Input } from '@/components/ui/field';
import { MAX_VERSION_TAG_LENGTH, parseTagDraft } from '@/core/tags';

import { TagChip, TagSuggestions } from './tag-chip';

export interface TagEditorProps {
  deckId: string;
  sequence: number;
  tags: readonly string[];
  /** Tags used elsewhere in the deck, offered as suggestions. */
  suggestions: readonly string[];
}

interface TagUpdate {
  type: 'add' | 'remove';
  tag: string;
}

/**
 * Adds and removes tags on an existing version. Changes apply immediately (optimistic)
 * and are saved with server actions; a failed save rolls back and shows the reason.
 */
export function TagEditor({ deckId, sequence, tags, suggestions }: TagEditorProps) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [optimisticTags, applyOptimistic] = useOptimistic(
    tags,
    (current: readonly string[], update: TagUpdate) =>
      update.type === 'add'
        ? current.includes(update.tag)
          ? current
          : [...current, update.tag].sort()
        : current.filter((tag) => tag !== update.tag),
  );

  function save(update: TagUpdate): void {
    setError(null);
    startTransition(async () => {
      applyOptimistic(update);
      const result =
        update.type === 'add'
          ? await addTagAction(deckId, sequence, update.tag)
          : await removeTagAction(deckId, sequence, update.tag);
      if (!result.ok) setError(result.message);
    });
  }

  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    const parsed = parseTagDraft(draft);
    if (parsed.kind === 'empty') {
      setAdding(false);
      return;
    }
    if (parsed.kind === 'invalid') {
      setError(parsed.problem);
      return;
    }
    setDraft('');
    save({ type: 'add', tag: parsed.tag });
    input.current?.focus();
  }

  return (
    <div className="flex flex-col gap-2" aria-busy={pending || undefined}>
      <ul aria-label="Tags" className="flex flex-wrap items-center gap-1.5">
        {optimisticTags.length === 0 && !adding && <li className="text-sm text-muted">No tags yet.</li>}
        {optimisticTags.map((tag) => (
          <TagChip
            key={tag}
            tag={tag}
            onRemove={() => {
              save({ type: 'remove', tag });
            }}
          />
        ))}
        {!adding && (
          <li>
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus aria-hidden="true" className="size-4" />}
              onClick={() => {
                setAdding(true);
                queueMicrotask(() => input.current?.focus());
              }}
            >
              Add tag
            </Button>
          </li>
        )}
      </ul>

      {!adding && error !== null && <ErrorText>{error}</ErrorText>}
      {adding && (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <label htmlFor={inputId} className="sr-only">
            New tag
          </label>
          <div className="flex gap-2">
            <Input
              ref={input}
              {...fieldControlProps(inputId, { invalid: error !== null, hint: false })}
              value={draft}
              placeholder="tournament, stable, pre-ban…"
              autoComplete="off"
              autoCapitalize="none"
              enterKeyHint="done"
              // Room for the capitals and spaces that normalizing removes.
              maxLength={2 * MAX_VERSION_TAG_LENGTH}
              className="min-w-0 flex-1"
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setAdding(false);
                  setDraft('');
                  setError(null);
                }
              }}
            />
            <Button type="submit" size="md" variant="secondary">
              Add
            </Button>
            <Button
              size="md"
              variant="ghost"
              onClick={() => {
                setAdding(false);
                setDraft('');
                setError(null);
              }}
            >
              Done
            </Button>
          </div>
          {error !== null && <ErrorText id={fieldDescriptionIds(inputId).error}>{error}</ErrorText>}
          <TagSuggestions
            tags={suggestions}
            exclude={optimisticTags}
            onPick={(tag) => {
              save({ type: 'add', tag });
            }}
          />
        </form>
      )}
    </div>
  );
}
