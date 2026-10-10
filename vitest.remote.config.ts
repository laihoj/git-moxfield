/**
 * Opt-in suite against a real libSQL server (`tests/remote`): the semantics the app relies
 * on that only the remote protocol has (error shapes without extended codes, rejected
 * PRAGMAs, the 5 s write-lock steal, stream expiry, the 5,000,000-byte argument limit).
 *
 *   LIBSQL_TEST_URL=http://127.0.0.1:8080 pnpm test:remote
 *
 * The suite WIPES the database it is pointed at. It refuses a non-local server unless
 * LIBSQL_TEST_ALLOW_WIPE=1 is set as well. Start a throwaway server with the official
 * libsql-server binary (`sqld --db-path <dir> --http-listen-addr 127.0.0.1:8080`) or
 * `turso dev`. LIBSQL_TEST_AUTH_TOKEN is passed on when set.
 */
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      'server-only': fileURLToPath(new URL('./tests/support/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/remote/**/*.test.ts'],
    // One database for the whole suite: test files must not run concurrently.
    fileParallelism: false,
    // Lock steals take 5 s and stream expiry about 10 s.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    restoreMocks: true,
  },
});
