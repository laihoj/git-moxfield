// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { gzipPayload } from '@tests/support/capture-codec';

import '@/components/test-utils';
import { decodeCapturePayload } from '@/integrations/moxfield/capture-codec';
import { CAPTURE_GZIP_TAG, MAX_ENCODED_CAPTURE_CHARS } from '@/integrations/moxfield/capture-codec-protocol';
import { ERROR, PAYLOAD, READY } from '@/integrations/moxfield/capture-protocol';

import { CAPTURE_TOO_LARGE_COMPRESSED_MESSAGE } from './capture-payload';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

const SITE = 'https://moxfield.com';
const NONCE = '0123456789abcdef0123456789abcdef';
const KEY = `gmk_${'k'.repeat(43)}`;
const ENVELOPE = JSON.stringify({ kind: 'git-moxfield/capture', version: 2, source: 'moxfield', deck: {} });

/** The Moxfield tab that opened the capture page: a real window, so it can be a message source. */
let moxfieldTab: Window;
/** What the capture page posts back to the Moxfield tab. */
let postToMoxfield: Mock<(message: unknown, targetOrigin: unknown) => void>;
let fetchMock: ReturnType<typeof vi.fn>;

async function renderCaptureClient(signedIn: boolean) {
  // The capture page caches the hand-over (nonce and opener) per page load, i.e. per module.
  vi.resetModules();
  const { CaptureClient } = await import('./capture-client');
  return render(
    <CaptureClient
      allowedOrigins={[SITE]}
      apiBaseUrl="https://api2.moxfield.com"
      siteOrigin={SITE}
      initialMode="auto"
      formError={null}
      signedIn={signedIn}
    />,
  );
}

function sendFromMoxfield(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin: SITE, source: moxfieldTab }));
}

function untrackedResponse(): Response {
  return new Response(JSON.stringify({ status: 'untracked', name: 'Blue Farm', externalId: 'abc' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  if (frame.contentWindow === null) throw new Error('No frame window');
  moxfieldTab = frame.contentWindow;
  postToMoxfield = vi.fn();
  const record = (message: unknown, targetOrigin: unknown): void => {
    postToMoxfield(message, targetOrigin);
  };
  vi.spyOn(moxfieldTab, 'postMessage').mockImplementation(record as Window['postMessage']);
  Object.defineProperty(window, 'opener', { value: moxfieldTab, configurable: true });
  window.history.replaceState(null, '', `/capture#n=${NONCE}`);
  fetchMock = vi.fn().mockImplementation(() => Promise.resolve(untrackedResponse()));
  vi.stubGlobal('fetch', fetchMock);
  // jsdom's Blob has no stream(), which compressing needs; browsers' (and Node's) has.
  vi.stubGlobal('Blob', NodeBlob);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'opener', { value: null, configurable: true });
  document.body.innerHTML = '';
});

interface PostedBody {
  payload: unknown;
  method: string;
  track: boolean;
  key?: string;
}

function postedBodies(): PostedBody[] {
  return fetchMock.mock.calls.map((call) => {
    const body = (call[1] as RequestInit | undefined)?.body;
    if (typeof body !== 'string') throw new Error('No JSON body was sent');
    return JSON.parse(body) as PostedBody;
  });
}

/** The capture's JSON text in a posted payload, decoded as the server decodes it. */
async function decodedPayload(body: PostedBody | undefined): Promise<string> {
  if (typeof body?.payload !== 'string') throw new Error('No payload string was sent');
  return decodeCapturePayload(body.payload);
}

function errorsToMoxfield(): { message: string; origin: unknown }[] {
  return postToMoxfield.mock.calls
    .filter(([message]) => (message as { t: string }).t === ERROR)
    .map(([message, origin]) => ({ message: (message as { message: string }).message, origin }));
}

describe('CaptureClient bookmarklet hand-over', () => {
  it('announces itself to the Moxfield tab and forwards the bookmarklet key with the deck', async () => {
    const user = userEvent.setup();
    await renderCaptureClient(false);
    expect(postToMoxfield).toHaveBeenCalledWith({ t: READY, n: NONCE }, SITE);
    // The nonce does not stay in the address bar.
    expect(window.location.hash).toBe('');

    sendFromMoxfield({ t: PAYLOAD, n: NONCE, json: ENVELOPE, key: KEY });
    expect(await screen.findByRole('heading', { name: 'Track “Blue Farm”?' })).toBeInTheDocument();
    const [first] = postedBodies();
    expect(first).toEqual({
      payload: expect.stringMatching(/^gm-gzip-base64url:/) as unknown,
      method: 'browser-capture',
      track: false,
      key: KEY,
    });
    // A plain payload (a bookmarklet made before compression) is compressed on the way.
    expect(await decodedPayload(first)).toBe(ENVELOPE);

    // Tracking sends the same payload again, with the same key.
    await user.click(screen.getByRole('button', { name: 'Track this deck' }));
    expect(postedBodies()[1]).toEqual({ ...first, track: true });
  });

  it('forwards a payload the bookmarklet compressed as it is', async () => {
    await renderCaptureClient(false);
    const payload = gzipPayload(ENVELOPE);
    sendFromMoxfield({ t: PAYLOAD, n: NONCE, json: payload, key: KEY });
    expect(await screen.findByRole('heading', { name: 'Track “Blue Farm”?' })).toBeInTheDocument();
    expect(postedBodies()).toEqual([{ payload, method: 'browser-capture', track: false, key: KEY }]);
  });

  it('refuses a payload over the size limits without sending it, and tells both windows', async () => {
    await renderCaptureClient(true);
    sendFromMoxfield({
      t: PAYLOAD,
      n: NONCE,
      json: CAPTURE_GZIP_TAG + 'A'.repeat(MAX_ENCODED_CAPTURE_CHARS),
      key: KEY,
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The deck could not be imported');
    expect(alert).toHaveTextContent(CAPTURE_TOO_LARGE_COMPRESSED_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorsToMoxfield()).toEqual([{ message: CAPTURE_TOO_LARGE_COMPRESSED_MESSAGE, origin: SITE }]);
    // A signed-in browser can paste the deck instead.
    expect(screen.getByRole('button', { name: 'Paste the deck instead' })).toBeInTheDocument();
  });

  it('passes the server’s answer to a payload it refused on to the Moxfield tab', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'The deck data is too large (limit 8.0 MB uncompressed).' }), {
        status: 413,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await renderCaptureClient(false);
    sendFromMoxfield({ t: PAYLOAD, n: NONCE, json: ENVELOPE, key: KEY });

    expect(await screen.findByRole('alert')).toHaveTextContent('limit 8.0 MB uncompressed');
    await vi.waitFor(() => {
      expect(errorsToMoxfield()).toEqual([
        { message: 'The deck data is too large (limit 8.0 MB uncompressed).', origin: SITE },
      ]);
    });
  });

  it('ignores messages from other windows, origins or nonces', async () => {
    await renderCaptureClient(true);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { t: PAYLOAD, n: NONCE, json: ENVELOPE, key: KEY },
        origin: SITE,
        source: window,
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { t: PAYLOAD, n: NONCE, json: ENVELOPE, key: KEY },
        origin: 'https://evil.example',
        source: moxfieldTab,
      }),
    );
    sendFromMoxfield({ t: PAYLOAD, n: 'ffffffffffffffffffffffffffffffff', json: ENVELOPE, key: KEY });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recognizes a bookmarklet made before accounts (no key) and tells both windows', async () => {
    await renderCaptureClient(false);
    sendFromMoxfield({ t: PAYLOAD, n: NONCE, json: ENVELOPE });

    expect(await screen.findByRole('alert')).toHaveTextContent('This bookmarklet is out of date');
    expect(screen.getByRole('link', { name: 'Make a new bookmarklet' })).toHaveAttribute('href', '/setup');
    expect(fetchMock).not.toHaveBeenCalled();
    const errors = errorsToMoxfield();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.origin).toBe(SITE);
    expect(errors[0]?.message).toContain('out of date');
  });

  it('explains a revoked bookmarklet and offers a new one', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'This bookmarklet is no longer valid.', code: 'invalid-key' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await renderCaptureClient(false);
    sendFromMoxfield({ t: PAYLOAD, n: NONCE, json: ENVELOPE, key: KEY });

    expect(await screen.findByText('This bookmarklet no longer works')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Make a new bookmarklet' })).toHaveAttribute('href', '/setup');
    // Pasting needs a signed-in browser: not offered to a signed-out one.
    expect(screen.queryByRole('button', { name: 'Paste the deck instead' })).not.toBeInTheDocument();
  });
});

describe('CaptureClient without a hand-over', () => {
  it('asks a signed-out visitor to sign in before pasting', async () => {
    window.history.replaceState(null, '', '/capture');
    Object.defineProperty(window, 'opener', { value: null, configurable: true });
    await renderCaptureClient(false);
    expect(await screen.findByText('Sign in to paste a deck')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/signin?next=%2Fcapture%3Fmode%3Dpaste',
    );
  });

  it('offers the paste form to a signed-in visitor', async () => {
    window.history.replaceState(null, '', '/capture');
    Object.defineProperty(window, 'opener', { value: null, configurable: true });
    await renderCaptureClient(true);
    expect(await screen.findByRole('heading', { name: 'Paste a deck from Moxfield' })).toBeInTheDocument();
  });
});
