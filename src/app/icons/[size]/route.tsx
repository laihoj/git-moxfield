/**
 * PNG app icons for the web app manifest: `/icons/192`, `/icons/512` (rounded) and
 * `/icons/maskable-512` (full bleed, for Android adaptive icons). Generated at build time.
 */
import { ImageResponse } from 'next/og';
import type { NextRequest } from 'next/server';

import { AppIcon } from '@/components/app/app-icon';

const ICONS = {
  '192': { size: 192, shape: 'rounded' },
  '512': { size: 512, shape: 'rounded' },
  'maskable-512': { size: 512, shape: 'full-bleed' },
} as const;

type IconName = keyof typeof ICONS;

function isIconName(value: string): value is IconName {
  return Object.hasOwn(ICONS, value);
}

export const dynamicParams = false;

export function generateStaticParams(): { size: IconName }[] {
  return (Object.keys(ICONS) as IconName[]).map((size) => ({ size }));
}

export async function GET(
  _request: NextRequest,
  { params }: RouteContext<'/icons/[size]'>,
): Promise<Response> {
  const { size: name } = await params;
  if (!isIconName(name)) return new Response('Not found', { status: 404 });
  const { size, shape } = ICONS[name];
  return new ImageResponse(<AppIcon size={size} shape={shape} />, {
    width: size,
    height: size,
    headers: { 'cache-control': 'public, max-age=86400' },
  });
}
