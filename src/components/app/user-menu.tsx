'use client';

import clsx from 'clsx';
import { ChevronDown, LogOut, ShieldCheck, UserRound } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState, type ComponentType } from 'react';

import { signOutAction } from '@/app/auth-actions';
import { Avatar } from '@/components/ui/avatar';
import { Spinner } from '@/components/ui/spinner';
import { routes } from '@/lib/routes';

export interface UserMenuProps {
  displayName: string;
  isAdmin: boolean;
}

const ITEM =
  'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-fg transition-colors hover:bg-surface-2 md:min-h-10';

/**
 * The signed-in user's menu in the header: who is signed in, Account, Admin (admins
 * only) and Sign out. A disclosure (a button that shows a panel of links), not an ARIA
 * menu: it closes with Escape, a click outside or choosing an item, and Escape returns
 * focus to the button. Sign out is a form, so it also works before JavaScript loads.
 */
export function UserMenu({ displayName, isAdmin }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const pathname = usePathname();
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    const onFocusIn = (event: FocusEvent): void => {
      // Tabbing past the last item closes the panel.
      if (event.target instanceof Node && root.current?.contains(event.target) !== true) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [open]);

  const close = (): void => {
    setOpen(false);
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Account menu, signed in as ${displayName}`}
        className={clsx(
          'flex h-11 items-center gap-1.5 rounded-full pr-1 pl-1 transition-colors hover:bg-surface-2 sm:pr-2 md:h-10',
          open && 'bg-surface-2',
        )}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        <Avatar name={displayName} />
        <span className="hidden max-w-36 truncate text-sm font-medium text-fg lg:inline">{displayName}</span>
        <ChevronDown
          aria-hidden="true"
          className={clsx('hidden size-4 text-muted transition-transform sm:block', open && 'rotate-180')}
        />
      </button>

      <div
        id={panelId}
        hidden={!open}
        className="absolute top-full right-0 z-50 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface p-1.5 shadow-pop"
      >
        <div className="flex items-center gap-3 px-3 pt-2 pb-3">
          <Avatar name={displayName} size="lg" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-fg">{displayName}</p>
            <p className="text-xs text-muted">{isAdmin ? 'Admin' : 'Signed in'}</p>
          </div>
        </div>
        <div className="border-t border-border pt-1.5">
          <MenuLink
            href={routes.account()}
            icon={UserRound}
            current={pathname === '/account'}
            onSelect={close}
          >
            Account
          </MenuLink>
          {isAdmin && (
            <MenuLink
              href={routes.admin()}
              icon={ShieldCheck}
              current={pathname === '/admin'}
              onSelect={close}
            >
              Admin
            </MenuLink>
          )}
        </div>
        <form
          action={signOutAction}
          className="mt-1.5 border-t border-border pt-1.5"
          onSubmit={() => {
            setSigningOut(true);
          }}
        >
          <button type="submit" className={clsx(ITEM, 'text-left')} disabled={signingOut}>
            {signingOut ? (
              <Spinner className="size-4 text-muted" />
            ) : (
              <LogOut aria-hidden="true" className="size-4 text-muted" />
            )}
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}

function MenuLink({
  href,
  icon: Icon,
  current,
  onSelect,
  children,
}: {
  href: Route;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;
  current: boolean;
  onSelect: () => void;
  children: string;
}) {
  return (
    <Link href={href} aria-current={current ? 'page' : undefined} className={ITEM} onClick={onSelect}>
      <Icon aria-hidden="true" className={clsx('size-4', current ? 'text-accent' : 'text-muted')} />
      {children}
    </Link>
  );
}
