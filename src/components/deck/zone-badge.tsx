import clsx from 'clsx';

import type { ReactNode } from 'react';

import { Overline } from '@/components/ui/card';
import { isCommandZone, zoneLabel, type ZoneId } from '@/core/zones';

/** Stable zone colors (docs/ux.md): commanders amber, mainboard violet, sideboard slate, considering teal. */
const COMMAND_ZONE_TONE = 'bg-zone-commanders-bg text-zone-commanders';

const ZONE_TONES: Partial<Record<ZoneId, string>> = {
  mainboard: 'bg-zone-mainboard-bg text-zone-mainboard',
  sideboard: 'bg-zone-sideboard-bg text-zone-sideboard',
  considering: 'bg-zone-considering-bg text-zone-considering',
};

const OTHER_TONE = 'bg-zone-other-bg text-zone-other';

function zoneTone(zone: ZoneId): string {
  return isCommandZone(zone) ? COMMAND_ZONE_TONE : (ZONE_TONES[zone] ?? OTHER_TONE);
}

/** Text color class of a zone (for headings that echo the badge color). */
export function zoneTextClass(zone: ZoneId): string {
  return zoneTone(zone).split(' ')[1] ?? 'text-zone-other';
}

export interface ZoneBadgeProps {
  zone: ZoneId;
  /** Quantity shown before the label (`3 Mainboard`). */
  quantity?: number;
  className?: string;
}

/** Zone name in its stable zone color. The label always carries the meaning. */
export function ZoneBadge({ zone, quantity, className }: ZoneBadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium whitespace-nowrap',
        zoneTone(zone),
        className,
      )}
    >
      {quantity !== undefined && <span className="tabular">{quantity}</span>}
      {zoneLabel(zone)}
    </span>
  );
}

/** A group heading with its count (`MAINBOARD 62`), in the zone's color when it is a zone's. */
export function ZoneOverline({
  zone,
  count,
  id,
  children,
}: {
  zone?: ZoneId;
  count: number;
  id?: string;
  children: ReactNode;
}) {
  return (
    <Overline id={id} className={clsx('mb-1', zone !== undefined && zoneTextClass(zone))}>
      {children}
      <span className="ml-1.5 font-medium text-subtle normal-case tabular">{count}</span>
    </Overline>
  );
}
