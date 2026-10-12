'use client';

import { resumeServerFetchAction } from '@/app/admin-actions';
import { InlineConfirm } from '@/components/ui/inline-confirm';

/**
 * Resume, after Moxfield refused or challenged a request and server fetching was paused for
 * every instance (ADR 0009). Two steps, since resuming too early risks a ban.
 */
export function ResumeServerFetch() {
  return (
    <InlineConfirm
      trigger={{ label: 'Resume', ariaLabel: 'Resume server fetching from Moxfield' }}
      message="Resume server fetching? Moxfield refused a request: if it keeps refusing, server fetching pauses again at the next one. Resume when you know why it happened."
      confirmLabel="Resume server fetching"
      tone="primary"
      onConfirm={() => resumeServerFetchAction()}
    />
  );
}
