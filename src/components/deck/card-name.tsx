'use client';

import clsx from 'clsx';
import type { Route } from 'next';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { Link } from '@/components/ui/navigation';
import { scryfallImageUrl } from '@/lib/scryfall';

const HOVER_QUERY = '(hover: hover) and (pointer: fine)';
const PREVIEW_WIDTH = 244;
const PREVIEW_HEIGHT = 340;
const PREVIEW_GAP = 12;
const VIEWPORT_MARGIN = 8;
const SHOW_DELAY_MS = 120;

/** `matchMedia` is missing in some embedded browsers and test environments. */
function hoverQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(HOVER_QUERY) : null;
}

function subscribeToHover(callback: () => void): () => void {
  const query = hoverQuery();
  if (query === null) return () => undefined;
  query.addEventListener('change', callback);
  return () => {
    query.removeEventListener('change', callback);
  };
}

/** True on devices with a precise pointer that can hover (desktop). False on the server and on touch. */
function useCanHover(): boolean {
  return useSyncExternalStore(
    subscribeToHover,
    () => hoverQuery()?.matches ?? false,
    () => false,
  );
}

interface PreviewPosition {
  left: number;
  top: number;
}

/** Places the preview beside the anchor (right if it fits, else left), clamped to the viewport. */
function previewPosition(anchor: DOMRect): PreviewPosition {
  const fitsRight = window.innerWidth - anchor.right - PREVIEW_GAP - VIEWPORT_MARGIN >= PREVIEW_WIDTH;
  const left = fitsRight
    ? anchor.right + PREVIEW_GAP
    : Math.max(VIEWPORT_MARGIN, anchor.left - PREVIEW_GAP - PREVIEW_WIDTH);
  const centered = anchor.top + anchor.height / 2 - PREVIEW_HEIGHT / 2;
  const top = Math.min(
    Math.max(VIEWPORT_MARGIN, centered),
    window.innerHeight - PREVIEW_HEIGHT - VIEWPORT_MARGIN,
  );
  return { left, top };
}

export interface CardNameProps {
  name: string;
  /** Scryfall printing id from the card catalog; enables the hover preview. */
  scryfallId?: string;
  /** Makes the name a link (e.g. to the card's history). */
  href?: Route;
  className?: string;
}

/**
 * A card name, optionally linked, with a card image preview on hover on desktop. The
 * image comes from Scryfall's CDN, only for a validated Scryfall UUID. Touch devices
 * never get a preview (hover does not exist there and would hijack the first tap).
 */
export function CardName({ name, scryfallId, href, className }: CardNameProps) {
  const imageUrl = scryfallImageUrl(scryfallId);
  const canHover = useCanHover();
  const [position, setPosition] = useState<PreviewPosition | null>(null);
  const [failed, setFailed] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );

  const label =
    href === undefined ? (
      name
    ) : (
      <Link
        href={href}
        className="rounded-sm hover:text-accent hover:underline hover:decoration-accent/40 hover:underline-offset-2"
      >
        {name}
      </Link>
    );

  if (imageUrl === null || !canHover || failed) {
    return <span className={clsx('break-words', className)}>{label}</span>;
  }

  const show = (): void => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const rect = anchor.current?.getBoundingClientRect();
      if (rect !== undefined) setPosition(previewPosition(rect));
    }, SHOW_DELAY_MS);
  };
  const hide = (): void => {
    window.clearTimeout(timer.current);
    setPosition(null);
  };

  return (
    <span ref={anchor} className={clsx('break-words', className)} onMouseEnter={show} onMouseLeave={hide}>
      {label}
      {position !== null && (
        <span
          aria-hidden="true"
          className="pointer-events-none fixed z-50 block overflow-hidden rounded-[12px] bg-surface-3 shadow-pop"
          style={{ left: position.left, top: position.top, width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }}
        >
          {/* A plain <img>: Next's image optimizer is not needed for a transient preview. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            alt=""
            width={PREVIEW_WIDTH}
            height={PREVIEW_HEIGHT}
            className="size-full object-cover"
            onError={() => {
              setFailed(true);
              setPosition(null);
            }}
          />
        </span>
      )}
    </span>
  );
}
