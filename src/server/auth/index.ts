/**
 * Accounts and sign-in (ADR 0006). Server-only.
 *
 * - {@link getAuthService}: the process-wide {@link AuthService} (users, keys, sessions,
 *   links, invites, claim). {@link createAuthService} builds one from explicit
 *   dependencies (tests, command-line scripts).
 * - `./current-user`: `getCurrentUser()`, `requireUser()`, `requireAdmin()` for pages,
 *   server actions and route handlers.
 * - `./cookies`: the session cookie, for server actions and route handlers.
 * - `./paths`: the paths of the account pages and safe `next` redirects.
 *
 * Data access for a signed-in user goes through `servicesFor(user)` in `@/server/access`.
 */
import 'server-only';

import { getConfig } from '@/server/config';
import { getDb, type Db } from '@/server/db/client';
import { createLogger } from '@/server/logger';

import { createAuthService, type AuthService } from './service';

export {
  createAuthService,
  DEVICE_LINK_LIFETIME_MS,
  HANDOFF_LIFETIME_MS,
  INVITE_LIFETIME_MS,
  RECOVERY_LINK_LIFETIME_MS,
  SESSION_LIFETIME_MS,
  SETUP_CODE_SETTING,
  SYSTEM_ACTOR,
  type Actor,
  type AuthService,
  type AuthServiceDependencies,
} from './service';
export type * from './types';

const globalForAuth = globalThis as unknown as { __gitMoxfieldSetupCodeAnnounced?: boolean };

/** The service of the database it was built for: {@link getDb} may reopen the database. */
let current: { db: Db; service: AuthService } | undefined;

/**
 * The process-wide auth service over the configured database (opened on first use, see
 * `getDb`).
 *
 * On first use in a process, an unclaimed installation prints its setup code to the
 * server log (ADR 0006: the code is printed on every start). The flag lives on
 * `globalThis`, so dev-server reloads, which re-evaluate this module, do not repeat it.
 *
 * @throws what `getDb` throws when the database cannot be opened.
 */
export async function getAuthService(): Promise<AuthService> {
  const db = await getDb();
  if (current?.db !== db) {
    const logger = createLogger('auth');
    current = { db, service: createAuthService({ db, config: getConfig(), logger }) };
    if (globalForAuth.__gitMoxfieldSetupCodeAnnounced !== true) {
      globalForAuth.__gitMoxfieldSetupCodeAnnounced = true;
      // Awaited: on a serverless platform, work left running after the response may never
      // finish. A failure is logged and never fails the request that happened to come first.
      await current.service.claimStatus().catch((error: unknown) => {
        logger.error('Could not check whether git-moxfield is claimed', { error });
      });
    }
  }
  return current.service;
}
