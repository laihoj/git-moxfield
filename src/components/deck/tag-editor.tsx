'use client';

import { Plus, X } from 'lucide-react';
import { useId, useOptimistic, useRef, useState, useTransition, type SubmitEvent } from 'react';

import { addTagAction, removeTagAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { normalizeTagInput, tagProblem } from '@/lib/tags';

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

  const available = suggestions.filter((tag) => !optimisticTags.includes(tag)).slice(0, 6);

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
    const tag = normalizeTagInput(draft);
    if (tag === '') {
      setAdding(false);
      return;
    }
    const problem = tagProblem(tag);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setDraft('');
    save({ type: 'add', tag });
    input.current?.focus();
  }

  return (
    <div className="flex flex-col gap-2" aria-busy={pending || undefined}>
      <ul aria-label="Tags" className="flex flex-wrap items-center gap-1.5">
        {optimisticTags.length === 0 && !adding && <li className="text-sm text-muted">No tags yet.</li>}
        {optimisticTags.map((tag) => (
          <li
            key={tag}
            className="inline-flex h-7 items-center gap-0.5 rounded-full bg-accent-soft pr-0.5 pl-2.5 text-sm font-medium text-accent"
          >
            {tag}
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              className="relative flex size-6 items-center justify-center rounded-full after:absolute after:-inset-2 after:content-[''] hover:bg-accent/15 md:after:hidden"
              onClick={() => {
                save({ type: 'remove', tag });
              }}
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </li>
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

      {!adding && error !== null && (
        <p role="alert" className="text-sm text-remove">
          {error}
        </p>
      )}
      {adding && (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <label htmlFor={inputId} className="sr-only">
            New tag
          </label>
          <div className="flex gap-2">
            <Input
              ref={input}
              id={inputId}
              value={draft}
              placeholder="tournament, stable, pre-ban…"
              autoComplete="off"
              autoCapitalize="none"
              enterKeyHint="done"
              maxLength={80}
              aria-invalid={error !== null || undefined}
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
          {error !== null && (
            <p role="alert" className="text-sm text-remove">
              {error}
            </p>
          )}
          {available.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted">Used before:</span>
              {available.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="relative inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-border-strong px-2.5 text-xs font-medium text-muted after:absolute after:-inset-y-2 after:inset-x-0 after:content-[''] hover:border-accent hover:text-accent md:after:hidden"
                  onClick={() => {
                    save({ type: 'add', tag });
                  }}
                >
                  <Plus aria-hidden="true" className="size-3" />
                  {tag}
                </button>
              ))}
            </div>
          )}
        </form>
      )}
    </div>
  );
}
