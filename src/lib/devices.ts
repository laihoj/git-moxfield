/**
 * Recognizing a browser from its User-Agent, for the account pages: the default name of
 * a new bookmarklet ("Chrome on Mac") and the device list ("Safari on iPhone").
 *
 * User-Agents are untrusted and only ever shown as text. Detection is deliberately
 * coarse: browser family and platform are enough to tell one's own devices apart, and
 * anything unrecognized falls back to a neutral label instead of guessing.
 */

/** Rough form factor, for choosing an icon. */
export type DeviceKind = 'phone' | 'tablet' | 'computer' | 'unknown';

export interface DeviceDescription {
  /** `Chrome on Mac`, `Safari on iPhone`, `Firefox`, `Unknown browser`. */
  label: string;
  /** `Chrome`, or `null` when the browser is not recognized. */
  browser: string | null;
  /** `Mac`, `iPhone`, or `null` when the platform is not recognized. */
  platform: string | null;
  kind: DeviceKind;
}

/**
 * Browser families in the order they must be tested: many browsers include the tokens
 * of the ones they are built on (Edge and Opera say `Chrome/`, Chrome says `Safari/`).
 */
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera|OPT)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bVivaldi\//, 'Vivaldi'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|CriOS|HeadlessChrome|Chromium)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

interface Platform {
  pattern: RegExp;
  name: string;
  kind: DeviceKind;
}

/** Platforms, most specific first (iPhone and Android before the desktop systems they mention). */
const PLATFORMS: readonly Platform[] = [
  { pattern: /\biPhone\b|\biPod\b/, name: 'iPhone', kind: 'phone' },
  { pattern: /\biPad\b/, name: 'iPad', kind: 'tablet' },
  { pattern: /\bAndroid\b.*\bMobile\b/, name: 'Android', kind: 'phone' },
  { pattern: /\bAndroid\b/, name: 'Android tablet', kind: 'tablet' },
  { pattern: /\bCrOS\b/, name: 'ChromeOS', kind: 'computer' },
  { pattern: /\bMacintosh\b|\bMac OS X\b/, name: 'Mac', kind: 'computer' },
  { pattern: /\bWindows\b/, name: 'Windows', kind: 'computer' },
  { pattern: /\bLinux\b|\bX11\b/, name: 'Linux', kind: 'computer' },
];

/** Describes the browser and platform of a User-Agent header (`null` when there was none). */
export function describeDevice(userAgent: string | null | undefined): DeviceDescription {
  const ua = userAgent ?? '';
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const platform = PLATFORMS.find(({ pattern }) => pattern.test(ua)) ?? null;
  let label: string;
  if (browser !== null && platform !== null) label = `${browser} on ${platform.name}`;
  else if (browser !== null) label = browser;
  else if (platform !== null) label = `Browser on ${platform.name}`;
  else label = 'Unknown browser';
  return { label, browser, platform: platform?.name ?? null, kind: platform?.kind ?? 'unknown' };
}
