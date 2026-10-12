import clsx from 'clsx';
import { Monitor, Smartphone } from 'lucide-react';
import type { ReactNode } from 'react';

import { BookmarkletLink } from '@/components/capture/bookmarklet-link';
import { CopyButton } from '@/components/ui/copy-button';
import { isLoopbackHostname } from '@/lib/hosts';
import { InlineCode } from '@/components/ui/inline-code';

export interface BookmarkletInstallProps {
  /** The popup bookmarklet (`javascript:` URL with the user's key). */
  popup: string;
  /** The same-tab bookmarklet (`javascript:` URL with the user's key). */
  sameTab: string;
  /** Moxfield's host, e.g. `moxfield.com`. */
  siteHost: string;
  /** git-moxfield's public base URL the bookmarklets send decks to. */
  appUrl: string;
}

/** Whether `appUrl` only works on the computer that runs git-moxfield. */
function isLoopback(appUrl: string): boolean {
  try {
    return isLoopbackHostname(new URL(appUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * How to install a newly created pair of bookmarklets: drag the popup one to the
 * bookmarks bar on a computer, or copy the same-tab one into a bookmark on a phone. The
 * links get their `javascript:` hrefs after mount (`BookmarkletLink`).
 */
export function BookmarkletInstall({ popup, sameTab, siteHost, appUrl }: BookmarkletInstallProps) {
  return (
    <div className="flex flex-col gap-4">
      <InstructionBlock
        icon={<Monitor aria-hidden="true" className="size-4" />}
        title="Computer (Chrome, Firefox, Safari, Edge)"
        className="max-md:order-2"
      >
        <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-fg marker:text-subtle">
          <li>
            Show the bookmarks bar (<Kbd>Ctrl</Kbd>/<Kbd>⌘</Kbd> + <Kbd>Shift</Kbd> + <Kbd>B</Kbd>).
          </li>
          <li>Drag this button onto the bar:</li>
        </ol>
        <div className="flex flex-wrap items-start gap-3 pl-5">
          <BookmarkletLink code={popup} label="Send to git-moxfield" />
          <CopyButton text={popup} label="Copy bookmarklet code" subject="Bookmarklet code" size="sm" />
        </div>
        <ol start={3} className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-fg marker:text-subtle">
          <li>
            Open one of your decks on {siteHost} and click the bookmark. A git-moxfield window opens with the
            deck.
          </li>
        </ol>
      </InstructionBlock>

      <InstructionBlock
        icon={<Smartphone aria-hidden="true" className="size-4" />}
        title="Phone and tablet (Safari on iOS, Chrome on Android, in-app browsers)"
        className="max-md:order-1"
      >
        <p className="text-sm text-muted">
          Phones block popups, so this variant sends the deck in the same tab and opens it in{' '}
          <span className="whitespace-nowrap">git-moxfield</span>.
        </p>
        <div className="flex flex-wrap items-start gap-3">
          <CopyButton
            text={sameTab}
            label="Copy same-tab bookmarklet"
            subject="Same-tab bookmarklet code"
            variant="primary"
          />
          <BookmarkletLink code={sameTab} label="Send to git-moxfield (same tab)" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h4 className="mb-1.5 text-sm font-semibold text-fg">iPhone and iPad</h4>
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-fg marker:text-subtle">
              <li>Copy the same-tab bookmarklet above.</li>
              <li>
                Bookmark any page (Share › Add Bookmark) and name it{' '}
                <span className="whitespace-nowrap">“Send to git-moxfield”</span>.
              </li>
              <li>Open Bookmarks › Edit, select it and replace its address with the copied code.</li>
              <li>On a deck page, open Bookmarks and tap it.</li>
            </ol>
          </div>
          <div>
            <h4 className="mb-1.5 text-sm font-semibold text-fg">Android (Chrome)</h4>
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-fg marker:text-subtle">
              <li>Copy the same-tab bookmarklet above.</li>
              <li>Bookmark any page (⋮ › ☆), then edit it: name it “gm”, paste the code as its URL.</li>
              <li>
                On a deck page, type <Kbd>gm</Kbd> in the address bar and pick the bookmark from the
                suggestions.
              </li>
            </ol>
          </div>
        </div>
      </InstructionBlock>

      <p className="text-xs text-pretty text-muted max-md:order-3">
        These bookmarklets send decks to <InlineCode className="break-all">{appUrl}</InlineCode>.
        {isLoopback(appUrl) && (
          <>
            {' '}
            That address only works on this computer. To use git-moxfield from your phone, start it with{' '}
            <InlineCode className="whitespace-nowrap">pnpm start:lan</InlineCode> and set{' '}
            <InlineCode>PUBLIC_APP_URL</InlineCode> to an address your phone can reach (for example your
            computer’s LAN address), then make the phone’s bookmarklet there.
          </>
        )}
      </p>
    </div>
  );
}

function InstructionBlock({
  icon,
  title,
  className,
  children,
}: {
  icon: ReactNode;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={clsx('flex flex-col gap-3 rounded-lg border border-border bg-surface-2/50 p-4', className)}
    >
      <h3 className="flex items-start gap-2 text-sm font-semibold text-fg">
        <span className="flex h-5 shrink-0 items-center text-muted">{icon}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border-strong bg-surface px-1.5 py-0.5 font-sans text-xs font-medium text-fg shadow-card">
      {children}
    </kbd>
  );
}
