/**
 * Installation facts for the Connect Moxfield and capture pages: whether server fetching
 * works, and which Moxfield origins and API the bookmarklets and capture page talk to.
 * Holds no secrets and depends on no user, so pages that render before sign-in (the
 * bookmarklet's capture page) can use it.
 */
import 'server-only';

import { MOXFIELD_SOURCE_ID } from '@/integrations/moxfield/constants';
import type { AppConfig } from '@/server/config';
import type { DeckSourceRegistry } from '@/server/sources';

import type { SetupInfoDTO } from './contract';

export function setupInfo(config: AppConfig, sources: DeckSourceRegistry): SetupInfoDTO {
  return {
    serverFetch: sources.require(MOXFIELD_SOURCE_ID).serverFetchStatus(),
    userAgentConfigured: config.MOXFIELD_USER_AGENT !== undefined,
    captureAllowedOrigins: [...config.captureAllowedOrigins],
    moxfieldSiteOrigin: config.moxfieldSiteOrigin,
    moxfieldApiBaseUrl: config.MOXFIELD_API_BASE_URL,
  };
}
