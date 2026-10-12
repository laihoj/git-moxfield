/**
 * PNG app icons for the web app manifest: `/icons/192`, `/icons/512` (rounded) and
 * `/icons/maskable-512` (full bleed, for Android adaptive icons). Generated at build time.
 */
import { ImageResponse } from 'next/og';
import type { NextRequest } from 'next/server';

import { AppIcon } from '@/components/app/app-icon';
import { PNG_ICONS, type PngIconName } from '@/lib/brand';

function isIconName(value: string): value is PngIconName {
  return Object.hasOwn(PNG_ICONS, value);
}

export const dynamicParams = false;

export function generateStaticParams(): { size: PngIconName }[] {
  return (Object.keys(PNG_ICONS) as PngIconName[]).map((size) => ({ size }));
}

export async function GET(
  _request: NextRequest,
  { params }: RouteContext<'/icons/[size]'>,
): Promise<Response> {
  const { size: name } = await params;
  if (!isIconName(name)) return new Response('Not found', { status: 404 });
  const { size, shape } = PNG_ICONS[name];
  return new ImageResponse(<AppIcon size={size} shape={shape} />, {
    width: size,
    height: size,
    headers: { 'cache-control': 'public, max-age=86400' },
  });
}
