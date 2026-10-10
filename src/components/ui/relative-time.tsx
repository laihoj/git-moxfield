'use client';

import { useSyncExternalStore } from 'react';

import {
  formatClockTime,
  formatDateTime,
  formatFullDateTime,
  formatRelativeTime,
  type RelativeTimeStyle,
} from '@/lib/format';

/**
 * A shared clock for every time component on the page: one interval, ticking while at
 * least one component is mounted. The value is the last tick, so `getSnapshot` is
 * stable between ticks as `useSyncExternalStore` requires.
 */
const TICK_MS = 30_000;
const listeners = new Set<() => void>();
let now = 0;
let interval: number | undefined;

function tick(): void {
  now = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (interval === undefined) {
    interval = window.setInterval(tick, TICK_MS);
    // The clock may be stale if no component was mounted for a while.
    if (isStale()) queueMicrotask(tick);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.clearInterval(interval);
      interval = undefined;
    }
  };
}

/** Whether the last tick is more than a second off (either way: the system clock can be set back). */
function isStale(): boolean {
  return Math.abs(Date.now() - now) > 1000;
}

function getSnapshot(): number {
  if (interval === undefined && isStale()) now = Date.now();
  return now;
}

/** `null` marks the server render and hydration, which have no shared clock. */
function getServerSnapshot(): null {
  return null;
}

/**
 * The clock of a one-off render: the server's on the server, the browser's while
 * hydrating. Rendering with it is deliberate: the server renders the same relative text
 * the browser will (git-moxfield is local-first, so both usually share clock and time
 * zone), which avoids a layout shift when the page hydrates.
 */
function renderClock(): number {
  return Date.now();
}

interface Clock {
  now: number;
  /**
   * False on the server and while hydrating. Time elements are keyed on it: hydration
   * keeps the server's text (React does not patch text under `suppressHydrationWarning`),
   * and the remount right after hydration replaces it with the browser's text, so a
   * server/browser difference (time zone, a minute boundary) never sticks.
   */
  live: boolean;
}

function useClock(): Clock {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return current === null ? { now: renderClock(), live: false } : { now: current, live: true };
}

function clockKey(clock: Clock): string {
  return clock.live ? 'live' : 'rendered';
}

export interface RelativeTimeProps {
  /** ISO 8601 timestamp. */
  value: string;
  style?: RelativeTimeStyle;
  /** The time may lie in the future (`in 25 min`), e.g. when a pause ends. */
  future?: boolean;
  className?: string;
}

/**
 * `<time>` showing a relative time ("23 min ago") that stays fresh. The server renders
 * the same relative text (see `renderClock`), so nothing shifts on hydration. The
 * tooltip shows the full local date and time.
 */
export function RelativeTime({ value, style = 'long', future = false, className }: RelativeTimeProps) {
  const clock = useClock();
  return (
    <time
      key={clockKey(clock)}
      dateTime={value}
      title={formatFullDateTime(value)}
      className={className}
      suppressHydrationWarning
    >
      {formatRelativeTime(value, clock.now, style, { future })}
    </time>
  );
}

/** `<time>` with an absolute local date and time (`Oct 9, 2026, 2:03 PM`). */
export function AbsoluteTime({ value, className }: { value: string; className?: string }) {
  const clock = useClock();
  return (
    <time
      key={clockKey(clock)}
      dateTime={value}
      title={formatFullDateTime(value)}
      className={className}
      suppressHydrationWarning
    >
      {formatDateTime(value)}
    </time>
  );
}

/**
 * `<time>` with a clock time near now: `9:47 PM` today, `Oct 10, 9:47 AM` on another
 * day. For moments like "paused until 9:47 PM".
 */
export function ClockTime({ value, className }: { value: string; className?: string }) {
  const clock = useClock();
  return (
    <time
      key={clockKey(clock)}
      dateTime={value}
      title={formatFullDateTime(value)}
      className={className}
      suppressHydrationWarning
    >
      {formatClockTime(value, clock.now)}
    </time>
  );
}
