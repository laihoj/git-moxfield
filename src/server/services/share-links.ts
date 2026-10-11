/**
 * The owner's share links (ADR 0007): {@link ShareLinkServices}, bound to the signed-in
 * user's workspace and the session asking.
 *
 * Why a service of its own rather than part of `DeckServices`: a link is made *by a
 * session*. It records the bookmarklet key that session descends from, like the device
 * links and keys a session makes (ADR 0006), so revoking a stolen key can revoke the
 * links made in the browsers it signed in. `DeckServices` are bound to a workspace only
 * (operator scripts use them without any session) and deal with deck history; this
 * service deals with a credential-like secret and knows who is asking.
 *
 * Secrets: the token is generated here and only its SHA-256 hash is stored. Plaintext
 * leaves this service in exactly one place, the `url` of a new link, shown once to its
 * owner. Nothing secret is logged.
 */
import 'server-only';

import { absoluteAppUrl } from '@/core/http-url';

import { sharedDeckPath } from '@/server/auth/paths';
import { requireActiveSession } from '@/server/auth/require-session';
import { generateToken, hashToken } from '@/server/auth/tokens';
import type { SessionUser } from '@/server/auth/types';
import { validateShareLinkLabel } from '@/server/auth/validation';
import type { Db } from '@/server/db/client';
import { createLogger, type Logger } from '@/server/logger';
import {
  createRepositories,
  isRepositoryError,
  type Repositories,
  type ShareLinkRecord,
} from '@/server/repositories';

import type { ShareLinkInput, ShareLinkServices } from './contract';
import { DECK_NOT_TRACKED, ServiceError } from './errors';
import type { CreatedShareLinkDTO, ShareLinkDTO } from './types';

export interface ShareLinkServicesDependencies {
  db: Db;
  /**
   * The signed-in user and session asking, resolved from the request: links are managed
   * in this user's workspace and record what this session descends from.
   */
  user: SessionUser;
  /** Clock for creation and revocation times. Default: system time. */
  now?: () => Date;
  /** Default: `createLogger('share-links')`. */
  logger?: Logger;
}

/** Creates the share link services of one signed-in user's request. */
export function createShareLinkServices(deps: ShareLinkServicesDependencies): ShareLinkServices {
  const now = deps.now ?? (() => new Date());
  return new DefaultShareLinkServices({
    repos: createRepositories(deps.db, { now, workspaceId: deps.user.workspaceId }),
    user: deps.user,
    now,
    logger: deps.logger ?? createLogger('share-links'),
  });
}

interface BoundDependencies {
  /** Repositories bound to `user`'s workspace. */
  repos: Repositories;
  user: SessionUser;
  now: () => Date;
  logger: Logger;
}

class DefaultShareLinkServices implements ShareLinkServices {
  constructor(private readonly deps: BoundDependencies) {}

  async createShareLink(deckId: string, input: ShareLinkInput, appUrl: string): Promise<CreatedShareLinkDTO> {
    const label = validateShareLinkLabel(input.label);
    if (!label.ok) throw new ServiceError('invalid-input', label.message);
    // Checked at runtime too: callers may pass a value straight from a form.
    if (typeof input.includeNotes !== 'boolean') {
      throw new ServiceError('invalid-input', 'Choose whether the link shows your notes.');
    }
    const token = generateToken('share');
    // Built before anything is stored: an unusable app URL must not leave a link behind.
    const url = shareUrl(appUrl, token);
    const { repos, user, logger } = this.deps;
    const record = await repos.transaction(async (tx): Promise<ShareLinkRecord> => {
      const session = await requireActiveSession(tx, user, this.at());
      try {
        return await tx.shareLinks.create({
          deckId,
          tokenHash: hashToken(token),
          label: label.value,
          includeNotes: input.includeNotes,
          createdByUserId: user.id,
          credentialId: session.credentialId,
        });
      } catch (error) {
        if (isRepositoryError(error, 'not-found')) throw new ServiceError('not-found', DECK_NOT_TRACKED);
        throw error;
      }
    });
    logger.info('Share link created', {
      deckId,
      linkId: record.id,
      userId: user.id,
      includeNotes: record.includeNotes,
      madeFromKeyId: record.credentialId,
    });
    return { link: toShareLinkDTO(record), url };
  }

  async listShareLinks(deckId: string): Promise<ShareLinkDTO[]> {
    return (await this.deps.repos.shareLinks.listForDeck(deckId)).map(toShareLinkDTO);
  }

  async revokeShareLink(deckId: string, linkId: string): Promise<boolean> {
    const revoked = await this.deps.repos.shareLinks.revoke(deckId, linkId, this.at());
    if (revoked) {
      this.deps.logger.info('Share link revoked', { deckId, linkId, userId: this.deps.user.id });
    }
    return revoked;
  }

  private at(): string {
    return this.deps.now().toISOString();
  }
}

/** A share link as listed to its owner. */
export function toShareLinkDTO(record: ShareLinkRecord): ShareLinkDTO {
  return {
    id: record.id,
    deckId: record.deckId,
    label: record.label,
    includeNotes: record.includeNotes,
    createdAt: record.createdAt,
    lastViewedAt: record.lastViewedAt,
  };
}

/**
 * The full URL of a share link on git-moxfield at `appUrl`.
 * @throws {TypeError} when `appUrl` is not an absolute http(s) URL.
 */
function shareUrl(appUrl: string, token: string): string {
  return absoluteAppUrl(sharedDeckPath(token), appUrl);
}
