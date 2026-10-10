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
import { getDb } from '@/server/db/client';
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
export {
  MAX_DISPLAY_NAME_LENGTH,
  MAX_INVITE_NOTE_LENGTH,
  MAX_KEY_LABEL_LENGTH,
  MAX_SHARE_LINK_LABEL_LENGTH,
} from './validation';

const globalForAuth = globalThis as unknown as { __gitMoxfieldSetupCodeAnnounced?: boolean };

let service: AuthService | undefined;

/**
 * The process-wide auth service over the configured database.
 *
 * On first use in a process, an unclaimed installation prints its setup code to the
 * server log (ADR 0006: the code is printed on every start). The flag lives on
 * `globalThis`, so dev-server reloads, which re-evaluate this module, do not repeat it.
 */
export function getAuthService(): AuthService {
  if (service === undefined) {
    const logger = createLogger('auth');
    service = createAuthService({ db: getDb(), config: getConfig(), logger });
    if (globalForAuth.__gitMoxfieldSetupCodeAnnounced !== true) {
      globalForAuth.__gitMoxfieldSetupCodeAnnounced = true;
      service.claimStatus().catch((error: unknown) => {
        logger.error('Could not check whether git-moxfield is claimed', { error });
      });
    }
  }
  return service;
}
