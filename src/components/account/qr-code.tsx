import clsx from 'clsx';

import type { QrCodeData } from '@/app/action-types';

/** Light modules around the code, as the QR specification asks, so scanners find its edges. */
const QUIET_ZONE = 4;

export interface QrCodeProps {
  code: QrCodeData;
  /** Accessible description, e.g. `QR code of the sign-in link`. */
  label: string;
  className?: string;
}

/**
 * Draws a QR code computed on the server (`src/app/qr-code.ts`) as an SVG path. Always
 * dark on white, also in dark mode: phone cameras read that most reliably.
 */
export function QrCode({ code, label, className }: QrCodeProps) {
  const extent = code.size + 2 * QUIET_ZONE;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`${-QUIET_ZONE} ${-QUIET_ZONE} ${extent} ${extent}`}
      shapeRendering="crispEdges"
      className={clsx('block rounded-lg ring-1 ring-border', className)}
    >
      <rect x={-QUIET_ZONE} y={-QUIET_ZONE} width={extent} height={extent} fill="#ffffff" />
      <path d={code.path} fill="#000000" />
    </svg>
  );
}
