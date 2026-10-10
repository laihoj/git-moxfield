/**
 * Client for the mock Moxfield's control API (`tests/mock-moxfield/server.ts`), used by
 * e2e tests to arrange what "Moxfield" serves: reset to the seeded decks, replace or
 * edit a deck the way a user would on Moxfield, and switch failure modes.
 */
import type { MoxDeckSpec } from '../../support/moxfield-deck-builder';
import type { EditOp, MockMode, MockRequestLogEntry, MockStateSnapshot } from '../../mock-moxfield/state';

import { MOCK_MOXFIELD_URL } from './constants';

export { BLUE_FARM_PUBLIC_ID, BLUE_FARM_VERSION, SECOND_DECK_PUBLIC_ID } from '../../mock-moxfield/scenarios';
export type { EditOp, MockMode, MockRequestLogEntry, MockStateSnapshot, MoxDeckSpec };

export class MockMoxfield {
  constructor(readonly baseUrl: string = MOCK_MOXFIELD_URL) {}

  /** URL of a deck's page on the mock Moxfield site (where the bookmarklet runs). */
  deckPageUrl(publicId: string): string {
    return `${this.baseUrl}/decks/${encodeURIComponent(publicId)}`;
  }

  state(): Promise<MockStateSnapshot> {
    return this.request('GET', '/__control/state');
  }

  /** Back to the seeded decks, mode `ok` and an empty request log. */
  reset(): Promise<MockStateSnapshot> {
    return this.request('POST', '/__control/reset');
  }

  async setMode(mode: MockMode): Promise<void> {
    await this.request('POST', '/__control/mode', { mode });
  }

  async getDeck(publicId: string): Promise<MoxDeckSpec> {
    return (await this.request<{ deck: MoxDeckSpec }>('GET', this.deckPath(publicId))).deck;
  }

  /**
   * Creates or replaces a deck. Without an explicit `version`, a replaced deck's Moxfield
   * version goes up by one.
   */
  async setDeck(spec: MoxDeckSpec): Promise<MoxDeckSpec> {
    return (await this.request<{ deck: MoxDeckSpec }>('PUT', this.deckPath(spec.publicId), spec)).deck;
  }

  async deleteDeck(publicId: string): Promise<void> {
    await this.request('DELETE', this.deckPath(publicId));
  }

  /** Applies edit operations as one Moxfield save (the deck's version goes up by one). */
  async edit(publicId: string, ops: EditOp[]): Promise<MoxDeckSpec> {
    return (await this.request<{ deck: MoxDeckSpec }>('POST', `${this.deckPath(publicId)}/edit`, ops)).deck;
  }

  /** Moxfield-facing requests (API and deck pages) since the last reset, oldest first. */
  async requests(): Promise<MockRequestLogEntry[]> {
    return (await this.state()).requests;
  }

  private deckPath(publicId: string): string {
    return `/__control/decks/${encodeURIComponent(publicId)}`;
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Mock Moxfield ${method} ${path} answered ${response.status}: ${text}`);
    }
    return JSON.parse(text) as T;
  }
}

/** Client for the mock started by `playwright.config.ts`. */
export const mockMoxfield = new MockMoxfield();
