import { describe, expect, it } from 'vitest';

import { FREE_TEXT_NOTE_KIND, MAX_NOTE_LENGTH } from '@/server/services';
import {
  blueFarmSpec,
  commitReviewed,
  committed,
  createServiceHarness,
  defined,
  moveCard,
  publishAndRefresh,
  trackDeck,
  type ServiceHarness,
} from '@tests/support/services';

async function twoVersions(harness: ServiceHarness): Promise<string> {
  const deckId = await trackDeck(harness);
  committed(await commitReviewed(harness, deckId, 'Initial version', ['Tournament', ' tournament ']));
  await publishAndRefresh(
    harness,
    deckId,
    moveCard(blueFarmSpec({ version: 2 }), 'Dress Down', 'mainboard', 'considering'),
  );
  committed(await commitReviewed(harness, deckId, 'Cut Dress Down'));
  return deckId;
}

describe('deck services: tags', () => {
  it('adds, lists, filters and removes normalized tags', async () => {
    const harness = await createServiceHarness();
    const { services } = harness;
    const deckId = await twoVersions(harness);

    expect((await services.listVersions(deckId)).map((version) => version.tags)).toEqual([
      [],
      ['tournament'],
    ]);
    expect(await services.addTag(deckId, 1, '  Stable ')).toEqual({
      ok: true,
      tags: ['stable', 'tournament'],
    });
    expect(await services.addTag(deckId, 1, 'stable')).toEqual({ ok: true, tags: ['stable', 'tournament'] });
    expect(await services.addTag(deckId, 2, 'Tournament')).toEqual({ ok: true, tags: ['tournament'] });

    expect(await services.listTags(deckId)).toEqual([
      { name: 'stable', count: 1 },
      { name: 'tournament', count: 2 },
    ]);
    expect(
      (await services.listVersions(deckId, { tag: 'STABLE' })).map((version) => version.sequence),
    ).toEqual([1]);

    expect(await services.removeTag(deckId, 1, 'Tournament')).toEqual({ ok: true, tags: ['stable'] });
    expect(await services.removeTag(deckId, 1, 'never-added')).toEqual({ ok: true, tags: ['stable'] });
    expect(await services.listTags(deckId)).toEqual([
      { name: 'stable', count: 1 },
      { name: 'tournament', count: 1 },
    ]);
  });

  it('explains invalid tags and unknown versions', async () => {
    const harness = await createServiceHarness();
    const { services } = harness;
    const deckId = await twoVersions(harness);

    expect(await services.addTag(deckId, 1, '#!?')).toEqual({
      ok: false,
      message: expect.any(String) as unknown,
    });
    expect(await services.addTag(deckId, 1, '   ')).toEqual({ ok: false, message: 'Enter a tag.' });
    expect(await services.addTag(deckId, 1, 'x'.repeat(41))).toMatchObject({ ok: false });
    expect(await services.addTag(deckId, 9, 'stable')).toEqual({
      ok: false,
      message: 'Version v9 does not exist.',
    });
    expect(await services.removeTag(deckId, 9, 'stable')).toEqual({
      ok: false,
      message: 'Version v9 does not exist.',
    });
    expect(await services.listTags('missing')).toEqual([]);
  });
});

describe('deck services: notes', () => {
  it('sets, replaces and clears the free-text note of a version', async () => {
    const harness = await createServiceHarness();
    const { services, clock } = harness;
    const deckId = await twoVersions(harness);

    const created = defined(
      await services.setNote(deckId, 1, '  Local cEDH night: 3-1-1, top 4.\r\nLost to Najeela.  '),
    );
    expect(created).toMatchObject({
      kind: FREE_TEXT_NOTE_KIND,
      data: { text: 'Local cEDH night: 3-1-1, top 4.\nLost to Najeela.' },
      createdAt: clock.iso(),
      updatedAt: clock.iso(),
    });
    expect(defined(await services.getVersion(deckId, 1)).notes).toEqual([created]);

    clock.advance(60);
    const updated = defined(await services.setNote(deckId, 1, 'Top 4.'));
    expect(updated).toMatchObject({ id: created.id, createdAt: created.createdAt, updatedAt: clock.iso() });
    expect(updated.data).toEqual({ text: 'Top 4.' });

    expect(await services.setNote(deckId, 1, '  \n ')).toBeNull();
    expect(defined(await services.getVersion(deckId, 1)).notes).toEqual([]);
    expect(defined(await services.getVersion(deckId, 2)).notes).toEqual([]);
  });

  it('rejects notes on unknown versions and overlong notes', async () => {
    const harness = await createServiceHarness();
    const deckId = await twoVersions(harness);
    await expect(harness.services.setNote(deckId, 7, 'hello')).rejects.toMatchObject({
      name: 'ServiceError',
      code: 'not-found',
    });
    await expect(harness.services.setNote(deckId, 1, 'x'.repeat(MAX_NOTE_LENGTH + 1))).rejects.toMatchObject({
      code: 'invalid-input',
    });
  });
});
