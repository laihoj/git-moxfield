import clsx from 'clsx';

import { zoneLabel, type ZoneId } from '@/core/zones';

/** Stable zone colors (docs/ux.md): commanders amber, mainboard violet, sideboard slate, considering teal. */
const ZONE_TONES: Partial<Record<ZoneId, string>> = {
  commanders: 'bg-zone-commanders-bg text-zone-commanders',
  companions: 'bg-zone-commanders-bg text-zone-commanders',
  signatureSpells: 'bg-zone-commanders-bg text-zone-commanders',
  mainboard: 'bg-zone-mainboard-bg text-zone-mainboard',
  sideboard: 'bg-zone-sideboard-bg text-zone-sideboard',
  considering: 'bg-zone-considering-bg text-zone-considering',
};

const OTHER_TONE = 'bg-zone-other-bg text-zone-other';

/** Text color class of a zone (for headings that echo the badge color). */
export function zoneTextClass(zone: ZoneId): string {
  return (ZONE_TONES[zone] ?? OTHER_TONE).split(' ')[1] ?? 'text-zone-other';
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
        ZONE_TONES[zone] ?? OTHER_TONE,
        className,
      )}
    >
      {quantity !== undefined && <span className="tabular">{quantity}</span>}
      {zoneLabel(zone)}
    </span>
  );
}
