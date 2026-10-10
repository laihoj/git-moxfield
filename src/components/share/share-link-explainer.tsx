import clsx from 'clsx';
import { Check, X } from 'lucide-react';

import { Card } from '@/components/ui/card';

const SHOWN = [
  'Every committed version: its changes, full deck list and primer',
  'History with tags, Compare and card history',
  'Restore text, to copy any version to Moxfield',
  'Your version notes, only on links that include them',
] as const;

const NEVER_SHOWN = [
  'Uncommitted changes on Moxfield',
  'Where the deck is on Moxfield: there is no link to it',
  'Your other decks and the rest of your account',
  'Any way to change something: no commits, tags, notes or refresh',
] as const;

/**
 * What a share link shows and what it never shows (ADR 0007's viewer scope), next to
 * creating one: viewers get the committed history, read-only, under the owner's display
 * name (`ownerName`, as it is when they look: a new name shows on existing links too),
 * and nothing else.
 */
export function ShareLinkExplainer({ ownerName }: { ownerName: string }) {
  const shown = [...SHOWN, `Your name, “${ownerName}”, as who shared the deck`];
  return (
    <Card as="section" aria-labelledby="share-explainer-heading" className="flex flex-col gap-4">
      <h2 id="share-explainer-heading" className="text-base font-semibold tracking-tight text-fg">
        What people with a link see
      </h2>
      <FactList label="Shown" items={shown} shown />
      <div className="flex flex-col gap-2.5 border-t border-border pt-4">
        <h3 className="text-sm font-semibold text-fg">Never shown</h3>
        <FactList label="Never shown" items={NEVER_SHOWN} shown={false} />
      </div>
      <p className="text-xs text-pretty text-muted">
        They don’t need an account. Anyone holding a link can open it, so share it like a key, and revoke it
        when it is no longer needed.
      </p>
    </Card>
  );
}

function FactList({ label, items, shown }: { label: string; items: readonly string[]; shown: boolean }) {
  const Icon = shown ? Check : X;
  return (
    <ul aria-label={label} className="flex flex-col gap-2 text-sm text-fg">
      {items.map((item) => (
        <li key={item} className="flex gap-2.5 text-pretty">
          <Icon
            aria-hidden="true"
            className={clsx('mt-0.5 size-4 shrink-0', shown ? 'text-add' : 'text-subtle')}
          />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  );
}
