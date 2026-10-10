/**
 * Journey 4, the manual fallback when neither the server nor a bookmarklet can reach
 * Moxfield: on `/capture?mode=paste` the user names the deck, opens Moxfield's deck data
 * URL, copies the JSON and pastes it (and, optionally, the primer's JSON), confirms
 * tracking the deck and commits it.
 */
import { signIn } from './support/accounts';
import {
  DECK_PAGE_PATH,
  commitVersion,
  createBlueFarmCopy,
  expectNoHorizontalOverflow,
} from './support/decks';
import { expect, test } from './support/fixtures';
import { MOCK_MOXFIELD_URL } from './support/constants';
import { mockMoxfield } from './support/mock';

/** What the user copies from a Moxfield data URL: the raw JSON text. */
async function moxfieldJson(url: string): Promise<string> {
  const response = await fetch(url);
  expect(response.status, url).toBe(200);
  return response.text();
}

test('a deck pasted as JSON is tracked and committed', async ({ page, context }, testInfo) => {
  await signIn(context);
  const deck = await createBlueFarmCopy(testInfo, 'Pasted Farm');
  const deckDataUrl = `${MOCK_MOXFIELD_URL}/v3/decks/all/${deck.publicId}`;
  const deckJson = await moxfieldJson(deckDataUrl);
  const internalId = (JSON.parse(deckJson) as { id: string }).id;
  const primerDataUrl = `${MOCK_MOXFIELD_URL}/v1/decks/${internalId}/primer`;
  const primerJson = await moxfieldJson(primerDataUrl);

  await page.goto('/capture?mode=paste');
  await expect(page.getByRole('heading', { level: 1, name: 'Paste a deck from Moxfield' })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Step 1 and 2: the deck URL leads to the deck's data URL.
  await page.getByLabel('Moxfield deck URL').fill(mockMoxfield.deckPageUrl(deck.publicId));
  await expect(page.getByRole('link', { name: deckDataUrl })).toHaveAttribute('href', deckDataUrl);

  // Step 3: paste the deck JSON. The text is summarized, never rendered.
  const importButton = page.getByRole('button', { name: 'Import deck' });
  await expect(importButton).toBeDisabled();
  await page.getByLabel('Deck JSON').fill(deckJson);
  const removePasted = page.getByRole('button', { name: 'Remove' });
  await expect(removePasted).toHaveCount(1);
  await expect(page.getByText('Pasted Farm', { exact: true })).toBeVisible();

  // Step 4: the primer's data URL needs the deck's internal id, known once the deck is pasted.
  await expect(page.getByRole('link', { name: primerDataUrl })).toHaveAttribute('href', primerDataUrl);
  await page.getByLabel('Primer JSON (optional)').fill(primerJson);
  await expect(removePasted).toHaveCount(2);
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  await importButton.click();
  const confirm = page.getByRole('region', { name: 'Track “Pasted Farm”?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Track this deck' }).click();

  await page.waitForURL((url) => DECK_PAGE_PATH.test(url.pathname));
  await expect(page.getByRole('heading', { level: 1, name: 'Pasted Farm' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Not committed yet' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Moxfield activity' })).toContainText('pasted just now');
  const initial = page.getByRole('region', { name: 'Initial version' });
  await expect(initial).toContainText('100 cards in the deck. All of it becomes v1.');
  // The pasted primer came along.
  await expect(initial.getByRole('list', { name: 'Primer' })).toContainText('37 lines');

  await commitVersion(page, { sequence: 1, message: 'Pasted from Moxfield' });
  await expect(page.getByRole('heading', { level: 2, name: 'Up to date with v1' })).toBeVisible();
  await page.getByRole('link', { name: 'v1: Pasted from Moxfield' }).click();
  await expect(page.getByText('Pasted manually')).toBeVisible();
});
