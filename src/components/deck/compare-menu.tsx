'use client';

import clsx from 'clsx';
import { ChevronDown, GitCompareArrows } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';

import { buttonClasses } from '@/components/ui/button';

export interface CompareMenuItem {
  label: string;
  /** Secondary text, e.g. the other version's message. */
  detail?: string;
  href: Route;
}

/**
 * "Compare…" button with a small menu of comparisons (with previous, with the current
 * Moxfield deck, ...). Closes on outside click, Escape and selection; arrow keys move
 * between items.
 */
export function CompareMenu({ items }: { items: readonly CompareMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function moveFocus(direction: 1 | -1): void {
    const entries = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = entries.findIndex((entry) => entry === document.activeElement);
    entries[(index + direction + entries.length) % entries.length]?.focus();
  }

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className={buttonClasses({ variant: 'secondary' })}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <GitCompareArrows aria-hidden="true" className="size-4" />
        Compare
        <ChevronDown
          aria-hidden="true"
          className={clsx('size-4 text-muted transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Compare this version"
          className="absolute right-0 z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-pop sm:left-0 sm:right-auto"
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              moveFocus(1);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              moveFocus(-1);
            }
          }}
        >
          {items.map((item) => (
            <Link
              key={item.label}
              href={item.href}
              role="menuitem"
              className="flex min-h-11 flex-col justify-center rounded-lg px-3 py-2 text-sm text-fg outline-none hover:bg-surface-2 focus-visible:bg-surface-2"
              onClick={() => {
                setOpen(false);
              }}
            >
              <span className="font-medium">{item.label}</span>
              {item.detail !== undefined && (
                <span className="truncate text-xs text-muted">{item.detail}</span>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
