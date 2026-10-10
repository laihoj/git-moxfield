import { ImageResponse } from 'next/og';

import { AppIcon } from '@/components/app/app-icon';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

/** Home-screen icon for iOS (iOS rounds the corners itself, so the icon is full bleed). */
export default function AppleIcon() {
  return new ImageResponse(<AppIcon size={180} shape="full-bleed" />, size);
}
