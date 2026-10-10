import { describe, expect, it } from 'vitest';

import { describeDevice } from './devices';

const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  chromeIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1',
  safariIpad:
    'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  samsungTablet:
    'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0',
  firefoxIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15',
  operaMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/124.0.0.0',
  chromebook:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  headless:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36',
} as const;

describe('describeDevice', () => {
  it.each([
    [UA.chromeMac, 'Chrome on Mac', 'computer'],
    [UA.safariIphone, 'Safari on iPhone', 'phone'],
    [UA.chromeIphone, 'Chrome on iPhone', 'phone'],
    [UA.firefoxIphone, 'Firefox on iPhone', 'phone'],
    [UA.safariIpad, 'Safari on iPad', 'tablet'],
    [UA.chromeAndroid, 'Chrome on Android', 'phone'],
    [UA.samsungTablet, 'Samsung Internet on Android tablet', 'tablet'],
    [UA.edgeWindows, 'Edge on Windows', 'computer'],
    [UA.firefoxLinux, 'Firefox on Linux', 'computer'],
    [UA.operaMac, 'Opera on Mac', 'computer'],
    [UA.chromebook, 'Chrome on ChromeOS', 'computer'],
    [UA.headless, 'Chrome on Mac', 'computer'],
  ])('recognizes %s', (userAgent, label, kind) => {
    expect(describeDevice(userAgent)).toMatchObject({ label, kind });
  });

  it('names only what it recognizes', () => {
    expect(describeDevice('curl/8.7.1')).toEqual({
      label: 'Unknown browser',
      browser: null,
      platform: null,
      kind: 'unknown',
    });
    expect(describeDevice('SomeBot/1.0 (Windows NT 10.0)')).toMatchObject({
      label: 'Browser on Windows',
      kind: 'computer',
    });
    expect(describeDevice('Mozilla/5.0 Firefox/143.0')).toMatchObject({ label: 'Firefox', kind: 'unknown' });
  });

  it('describes a missing User-Agent', () => {
    expect(describeDevice(null).label).toBe('Unknown browser');
    expect(describeDevice(undefined).label).toBe('Unknown browser');
    expect(describeDevice('').label).toBe('Unknown browser');
  });
});
