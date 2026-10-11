import { Link2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { CopyButton } from '@/components/ui/copy-button';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { ExpiryTime } from '@/components/ui/relative-time';

export interface OneTimeLinkProps {
  /** The full link, secret token included. */
  url: string;
  expiresAt: string;
  /** What is copied, for the button and its announcement (`Sign-in link`). */
  subject: string;
  /** A sentence above the link: who it is for and what it does. */
  children?: ReactNode;
  /** Extra facts after the expiry (`works once`). */
  meta?: ReactNode;
}

/** A secret URL shown as selectable text, once: a tap selects all of it. */
export function SecretUrl({ url }: { url: string }) {
  return (
    <p className="flex min-w-0 items-start gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2.5">
      <Link2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
      <span className="min-w-0 font-mono text-[0.8125rem] leading-relaxed break-all text-fg select-all">
        {url}
      </span>
    </p>
  );
}

/**
 * A freshly created one-time link (device link, invite, recovery link), shown to the
 * person who made it, once: the URL as selectable text (a tap selects all of it), a copy
 * button and when it expires. The page never shows the link again after it is left.
 */
export function OneTimeLink({ url, expiresAt, subject, children, meta }: OneTimeLinkProps) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {children !== undefined && <div className="text-sm text-pretty text-fg">{children}</div>}
      <SecretUrl url={url} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <CopyButton text={url} label={`Copy ${subject.toLowerCase()}`} subject={subject} variant="primary" />
        <MetaList className="text-xs text-muted">
          <MetaItem>
            <ExpiryTime value={expiresAt} />
          </MetaItem>
          {meta !== undefined && <MetaItem>{meta}</MetaItem>}
        </MetaList>
      </div>
    </div>
  );
}
