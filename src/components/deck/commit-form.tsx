'use client';

import { GitCommitHorizontal, Sparkles } from 'lucide-react';
import { useActionState, useId, useState } from 'react';

import type { CommitState } from '@/app/action-types';
import { commitAction } from '@/app/actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, fieldDescriptionIds, Input } from '@/components/ui/field';
import { useToast } from '@/components/ui/toaster';
import { MAX_COMMIT_MESSAGE_LENGTH } from '@/core/text-limits';
import { versionLabel } from '@/lib/format';
import { ownerDeckRoutes } from '@/lib/routes';

import { TagInput } from './tag-input';

export interface CommitFormProps {
  deckId: string;
  /** Sequence the new version will get (`head.sequence + 1`, or 1). */
  nextSequence: number;
  /** Suggested message derived from the diff; used when the message is left empty. */
  suggestedMessage: string;
  /** The observation the user is reviewing. */
  expectedObservationId: string;
  /** HEAD the user saw; `null` for the first version. */
  expectedHeadCommitId: string | null;
  /** Tags used elsewhere in the deck, offered as suggestions. */
  existingTags: readonly string[];
}

/** User-facing copy per failure; the server's message is used where it is already specific. */
function failureCopy(state: Extract<CommitState, { status: 'error' }>): { title: string; body?: string } {
  switch (state.reason) {
    case 'stale':
      return {
        title: 'Moxfield changed since you looked.',
        body: 'Review the new changes below and commit again.',
      };
    case 'head-moved':
      return {
        title: 'Another version was committed meanwhile.',
        body: 'The page now shows the latest state. Review the changes and commit again.',
      };
    case 'nothing-to-commit':
      return { title: 'Nothing to commit.', body: state.message };
    case 'no-working-state':
      return { title: 'Nothing fetched from Moxfield yet.', body: state.message };
    case 'invalid-message':
    case 'invalid-input':
      return { title: state.message };
    case 'internal':
      return { title: 'The version was not committed.', body: state.message };
  }
}

/**
 * Commit form: message (empty = the suggestion), optional tags, and the "Commit vN"
 * button. Concurrency is handled by the server (`expectedObservationId`,
 * `expectedHeadCommitId`); every failure reason gets clear copy. Success is confirmed
 * with a toast because the form itself disappears once the deck is up to date.
 */
export function CommitForm({
  deckId,
  nextSequence,
  suggestedMessage,
  expectedObservationId,
  expectedHeadCommitId,
  existingTags,
}: CommitFormProps) {
  const toast = useToast();
  const messageId = useId();
  const ids = fieldDescriptionIds(messageId);
  const [message, setMessage] = useState('');
  const [tags, setTags] = useState<string[]>([]);

  const [state, formAction, pending] = useActionState(
    async (previous: CommitState, formData: FormData): Promise<CommitState> => {
      const typed = formData.get('message');
      if (typeof typed !== 'string' || typed.trim() === '') formData.set('message', suggestedMessage);
      const result = await commitAction(previous, formData);
      if (result.status === 'committed') {
        setMessage('');
        setTags([]);
        toast({
          title: `Committed ${versionLabel(result.sequence)}`,
          description: result.message,
          action: {
            label: `View ${versionLabel(result.sequence)}`,
            href: ownerDeckRoutes(deckId).version(result.sequence),
          },
        });
      }
      return result;
    },
    { status: 'idle' },
  );

  const error = state.status === 'error' ? failureCopy(state) : null;
  const label = `Commit ${versionLabel(nextSequence)}`;
  const canUseSuggestion = suggestedMessage !== '' && message !== suggestedMessage;

  return (
    <Card as="section" aria-labelledby={`${messageId}-heading`}>
      <h2 id={`${messageId}-heading`} className="sr-only">
        {label}
      </h2>
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="deckId" value={deckId} />
        <input type="hidden" name="expectedObservationId" value={expectedObservationId} />
        <input type="hidden" name="expectedHeadCommitId" value={expectedHeadCommitId ?? ''} />

        <Field
          label="Commit message"
          htmlFor={messageId}
          hint={suggestedMessage === '' ? undefined : 'Leave empty to use the suggestion.'}
          aside={
            canUseSuggestion ? (
              <button
                type="button"
                className="relative inline-flex items-center gap-1 text-sm font-medium text-accent after:absolute after:-inset-3 after:content-[''] hover:underline md:after:hidden"
                onClick={() => {
                  setMessage(suggestedMessage);
                }}
              >
                <Sparkles aria-hidden="true" className="size-3.5" />
                Use suggestion
              </button>
            ) : undefined
          }
        >
          <Input
            id={messageId}
            name="message"
            value={message}
            maxLength={MAX_COMMIT_MESSAGE_LENGTH}
            placeholder={suggestedMessage === '' ? 'What changed and why?' : suggestedMessage}
            autoComplete="off"
            enterKeyHint="send"
            aria-describedby={ids.hint}
            disabled={pending}
            onChange={(event) => {
              setMessage(event.target.value);
            }}
          />
        </Field>

        <TagInput
          name="tags"
          label="Tags"
          value={tags}
          onChange={setTags}
          suggestions={existingTags}
          disabled={pending}
        />

        {error !== null && (
          <Alert
            tone={state.status === 'error' && state.reason === 'stale' ? 'warn' : 'error'}
            title={error.title}
            role="alert"
          >
            {error.body}
          </Alert>
        )}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          block
          loading={pending}
          icon={<GitCommitHorizontal aria-hidden="true" className="size-5" />}
        >
          {pending ? 'Committing…' : label}
        </Button>
      </form>
    </Card>
  );
}
