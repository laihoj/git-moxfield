/**
 * QR codes for the device link (Account › Sign in on another device), computed on the
 * server so the QR encoder never ships to the browser. The result is the outline of the
 * dark modules as one SVG path, which the `QrCode` component draws with React; no SVG
 * markup is ever injected as HTML.
 */
import 'server-only';

import { create } from 'qrcode';

import type { QrCodeData } from './action-types';

/**
 * The QR code of `text` (error correction level M, which survives a little glare or a
 * smudged screen). Each run of dark modules in a row becomes one rectangle
 * (`M{x} {y}h{run}v1h-{run}z`), which keeps the path short.
 */
export function qrCode(text: string): QrCodeData {
  const { modules } = create(text, { errorCorrectionLevel: 'M' });
  const { size, data } = modules;
  const parts: string[] = [];
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (data[y * size + x] !== 1) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && data[y * size + x] === 1) x++;
      const run = x - start;
      parts.push(`M${start} ${y}h${run}v1h-${run}z`);
    }
  }
  return { size, path: parts.join('') };
}
