'use client';

import { CircleCheck, Link2, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState, useTransition, type SubmitEvent } from 'react';

import type { CreateShareLinkResult } from '@/app/action-types';
import { createShareLinkAction } from '@/app/share-actions';
import { SecretUrl } from '@/components/account/one-time-link';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Field, fieldControlProps, Input } from '@/components/ui/field';
import { MAX_SHARE_LINK_LABEL_LENGTH } from '@/core/text-limits';

export interface CreateShareLinkProps {
  deckId: string;
}

type Created = Extract<CreateShareLinkResult, { status: 'created' }>;

/**
 * Deck › Share › New link: a label (for the owner only) and whether the link shows the
 * owner's version notes. A created link's URL is shown once, with a copy button: it
 * lives only in this component's state and is gone when the page is left.
 */
export function CreateShareLink({ deckId }: CreateShareLinkProps) {
  const id = useId();
  const [label, setLabel] = useState('');
  const [includeNotes, setIncludeNotes] = useState(false);
  const [error, setError] = useState<Extract<CreateShareLinkResult, { status: 'error' }> | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [pending, startTransition] = useTransition();
  const labelError = error?.field === 'label' ? error.message : undefined;

  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createShareLinkAction(deckId, label, includeNotes);
      if (result.status === 'error') {
        setError(result);
        return;
      }
      setCreated(result);
      setLabel('');
      setIncludeNotes(false);
    });
  }

  if (created !== null) {
    return (
      <NewShareLink
        created={created}
        onDone={() => {
          setCreated(null);
        }}
      />
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <Field
        label="Who is it for?"
        htmlFor={`${id}-label`}
        hint="Only you see this name. It tells your links apart, like “For Mikko” or “Playgroup chat”."
        error={labelError}
      >
        <Input
          name="label"
          value={label}
          maxLength={MAX_SHARE_LINK_LABEL_LENGTH}
          placeholder="For Mikko"
          autoComplete="off"
          required
          {...fieldControlProps(`${id}-label`, { invalid: labelError !== undefined })}
          onChange={(event) => {
            setLabel(event.target.value);
            if (error?.field === 'label') setError(null);
          }}
        />
      </Field>

      <div className="flex gap-2.5">
        <input
          id={`${id}-notes`}
          type="checkbox"
          checked={includeNotes}
          aria-describedby={`${id}-notes-hint`}
          className="mt-0.5 size-4 shrink-0 cursor-pointer accent-(--accent)"
          onChange={(event) => {
            setIncludeNotes(event.target.checked);
          }}
        />
        <div className="min-w-0">
          <label htmlFor={`${id}-notes`} className="cursor-pointer text-sm font-medium text-fg">
            Include my version notes
          </label>
          <p id={`${id}-notes-hint`} className="text-xs text-pretty text-muted">
            Notes stay private unless you include them. Tags are always shown.
          </p>
        </div>
      </div>

      {error !== null && error.field === undefined && (
        <Alert tone="error" role="alert">
          {error.message}
        </Alert>
      )}

      <div>
        <Button
          type="submit"
          variant="primary"
          loading={pending}
          icon={<Link2 aria-hidden="true" className="size-4" />}
        >
          Create link
        </Button>
      </div>
    </form>
  );
}

/**
 * A link just created: its URL, once, with a large copy button and a clear warning that
 * it cannot be shown again (only a hash of its token is stored). Focus moves to its
 * heading, so screen readers announce it.
 */
function NewShareLink({ created, onDone }: { created: Created; onDone: () => void }) {
  const { url, link } = created;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3
          ref={heading}
          tabIndex={-1}
          className="flex items-start gap-2 text-base font-semibold text-fg outline-none"
        >
          <CircleCheck aria-hidden="true" className="mt-0.5 size-4.5 shrink-0 text-add" />
          <span className="min-w-0 break-words">Link for “{link.label}” is ready</span>
        </h3>
        <p className="mt-0.5 pl-6.5 text-sm text-pretty text-muted">
          Anyone who opens it sees this deck’s versions, read-only
          {link.includeNotes ? ', with your notes' : ''}.
        </p>
      </div>
      <SecretUrl url={url} />
      <CopyButton text={url} label="Copy link" subject="Share link" variant="primary" size="lg" block />
      <p className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn-bg px-3 py-2.5 text-sm text-pretty text-fg">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warn" />
        <span>
          <span className="font-semibold">Copy it now: it won’t be shown again.</span> git-moxfield keeps only
          a fingerprint of the link. If you lose it, revoke it below and create a new one.
        </span>
      </p>
      <div>
        <Button variant="secondary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
