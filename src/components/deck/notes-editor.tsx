'use client';

import { Check } from 'lucide-react';
import { useActionState, useId, useState } from 'react';

import type { NoteState } from '@/app/action-types';
import { setNoteAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { RelativeTime } from '@/components/ui/relative-time';
import { MAX_NOTE_LENGTH } from '@/core/text-limits';

export interface NotesEditorProps {
  deckId: string;
  sequence: number;
  /** Current note text ('' when there is none). */
  text: string;
  /** When the note was last saved, if it exists. */
  updatedAt: string | null;
}

/**
 * Free-text notes on a version (tournament results, why a card was cut, ...). Notes
 * are mutable annotations; the version itself never changes. Saving an empty note
 * removes it.
 */
export function NotesEditor({ deckId, sequence, text, updatedAt }: NotesEditorProps) {
  const id = useId();
  const [draft, setDraft] = useState(text);
  const [saved, setSaved] = useState(text);
  const [state, formAction, pending] = useActionState(
    async (previous: NoteState, formData: FormData): Promise<NoteState> => {
      const result = await setNoteAction(previous, formData);
      if (result.status === 'saved') {
        setSaved(result.text);
        setDraft(result.text);
      }
      return result;
    },
    { status: 'idle' },
  );

  const dirty = draft !== saved;
  const savedAt = state.status === 'saved' ? state.savedAt : updatedAt;

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="deckId" value={deckId} />
      <input type="hidden" name="sequence" value={sequence} />
      <label htmlFor={id} className="sr-only">
        Notes
      </label>
      <textarea
        id={id}
        name="text"
        value={draft}
        rows={4}
        maxLength={MAX_NOTE_LENGTH}
        placeholder="Tournament results, matchups, why cards were cut…"
        className="block min-h-28 w-full resize-y rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-base leading-relaxed text-fg shadow-card placeholder:text-subtle focus:border-accent focus:ring-3 focus:ring-accent/20 focus:outline-none md:text-sm"
        onChange={(event) => {
          setDraft(event.target.value);
        }}
      />
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted" role="status">
          {state.status === 'error' ? (
            <span className="text-sm text-remove">{state.message}</span>
          ) : dirty ? (
            'Unsaved changes'
          ) : savedAt !== null && saved !== '' ? (
            <span className="inline-flex items-center gap-1">
              <Check aria-hidden="true" className="size-3.5 text-add" />
              Saved <RelativeTime value={savedAt} />
            </span>
          ) : null}
        </p>
        <Button
          type="submit"
          size="sm"
          variant={dirty ? 'primary' : 'secondary'}
          disabled={!dirty}
          loading={pending}
        >
          Save notes
        </Button>
      </div>
    </form>
  );
}
