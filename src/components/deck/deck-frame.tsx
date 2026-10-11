import type { ReactNode } from 'react';

/**
 * The frame of every deck page, the owner's and a share link's alike: the deck's header
 * and navigation above the page. One component, so the two cannot drift apart in spacing.
 */
export function DeckFrame({
  header,
  nav,
  children,
}: {
  header: ReactNode;
  nav: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <div className="flex flex-col gap-3 md:gap-4">
        {header}
        {nav}
      </div>
      {children}
    </div>
  );
}
