/**
 * Client for the e2e app's reset hook (`POST /api/e2e/reset`, enabled by
 * `GIT_MOXFIELD_E2E=true` in `playwright.config.ts`).
 */
import { APP_URL } from './constants';

/**
 * Resets the app's in-process state that tests cannot reach otherwise: server fetching
 * resumes if an earlier test made Moxfield block it (the pause lasts an hour). The
 * database is not reset; journeys work on decks of their own (`./decks.ts`).
 */
export async function resetApp(): Promise<void> {
  const response = await fetch(`${APP_URL}/api/e2e/reset`, { method: 'POST' });
  await response.body?.cancel();
  if (response.status !== 204) {
    throw new Error(
      `POST ${APP_URL}/api/e2e/reset answered ${response.status}. Is the app running with GIT_MOXFIELD_E2E=true ` +
        '(an app on that port started outside Playwright may lack it)?',
    );
  }
}
