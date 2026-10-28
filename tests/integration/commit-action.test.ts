/**
 * `commitAction`, the commit form's server action, over the real services on an in-memory
 * database. The action must not be stricter than the service about the commit message:
 * the form allows 2000 characters and the service accepts 2000 code points, so the action
 * has to pass every message the service would accept and leave the exact limit to it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { commitAction } from '@/app/actions';
import type { CommitState } from '@/app/action-types';
import { MAX_COMMIT_MESSAGE_LENGTH } from '@/core/text-limits';
import type { DeckServices } from '@/server/services';
import { createServiceHarness, defined, trackDeck } from '@tests/support/services';

const state = vi.hoisted(() => ({ services: undefined as DeckServices | undefined }));

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/server/auth/current-user', () => ({ requireUser: () => Promise.resolve({ id: 'user-1' }) }));
vi.mock('@/server/access', () => ({ servicesFor: () => state.services }));

let services: DeckServices;
let deckId: string;
let observationId: string;

beforeEach(async () => {
  const harness = await createServiceHarness();
  services = harness.services;
  state.services = services;
  deckId = await trackDeck(harness);
  observationId = defined(defined(await services.getOverview(deckId)).working).id;
});

function commitForm(message: string, description?: string): FormData {
  const form = new FormData();
  form.set('deckId', deckId);
  form.set('message', message);
  if (description !== undefined) form.set('description', description);
  form.set('expectedObservationId', observationId);
  form.set('expectedHeadCommitId', '');
  return form;
}

function commit(message: string): Promise<CommitState> {
  return commitAction({ status: 'idle' }, commitForm(message));
}

describe('commitAction: commit message length', () => {
  it('commits a message of 600 characters', async () => {
    const message = 'm'.repeat(600);
    expect(await commit(message)).toMatchObject({ status: 'committed', sequence: 1, message });
  });

  it('commits a message of the full length the form allows', async () => {
    const message = 'm'.repeat(MAX_COMMIT_MESSAGE_LENGTH);
    expect(await commit(message)).toMatchObject({ status: 'committed', message });
  });

  it('counts characters like the service does: 2000 emoji are 2000 characters, not 4000', async () => {
    const message = '😀'.repeat(MAX_COMMIT_MESSAGE_LENGTH);
    expect(await commit(message)).toMatchObject({ status: 'committed', message });
  });

  it('refuses a message over the limit with the service’s explanation', async () => {
    expect(await commit('m'.repeat(MAX_COMMIT_MESSAGE_LENGTH + 1))).toEqual({
      status: 'error',
      reason: 'invalid-message',
      message: `Commit messages can be at most ${MAX_COMMIT_MESSAGE_LENGTH} characters long.`,
    });
  });

  it('passes the description on, and leaves a form without one alone', async () => {
    expect(
      await commitAction({ status: 'idle' }, commitForm('Subject', ' Why it changed.\n\nDetails. ')),
    ).toMatchObject({
      status: 'committed',
      message: 'Subject',
    });
    const [version] = await services.listVersions(deckId);
    expect(version).toMatchObject({ message: 'Subject', description: 'Why it changed.\n\nDetails.' });
  });

  it('refuses an absurdly long description before it reaches the service', async () => {
    expect(await commitAction({ status: 'idle' }, commitForm('Subject', 'd'.repeat(50_000)))).toEqual({
      status: 'error',
      reason: 'invalid-input',
      message: 'Commit descriptions can be at most 20000 characters long.',
    });
  });

  it('refuses an absurdly long message before it reaches the service, with the same explanation', async () => {
    expect(await commit('m'.repeat(10 * MAX_COMMIT_MESSAGE_LENGTH))).toEqual({
      status: 'error',
      reason: 'invalid-input',
      message: `Commit messages can be at most ${MAX_COMMIT_MESSAGE_LENGTH} characters long.`,
    });
  });
});
