/**
 * What the two Vitest configs (`vitest.config.ts`, `vitest.remote.config.ts`) resolve
 * alike: the `@/…` aliases of tsconfig, and `server-only` (which throws outside a Next.js
 * build) as an empty module.
 */
import { fileURLToPath } from 'node:url';

import type { ViteUserConfig } from 'vitest/config';

export const sharedResolve: NonNullable<ViteUserConfig['resolve']> = {
  tsconfigPaths: true,
  alias: {
    'server-only': fileURLToPath(new URL('./tests/support/server-only-stub.ts', import.meta.url)),
  },
};
