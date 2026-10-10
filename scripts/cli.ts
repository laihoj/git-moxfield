/**
 * Plumbing shared by the command-line scripts: running only as the main module (tests
 * import the scripts), and turning the result of `main` into the process exit code.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createLogger } from '@/server/logger';

/**
 * Whether Node runs the module at `moduleUrl` (pass `import.meta.url`) as the main
 * module, symlinks resolved; `false` when a test imports it.
 */
export function isEntryPoint(moduleUrl: string): boolean {
  const entryPoint = process.argv[1];
  if (entryPoint === undefined) return false;
  try {
    return realpathSync(entryPoint) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/**
 * Runs `main` and sets the exit code it returns. An unexpected failure exits with code 1
 * and is logged through the app's logger, which leaves out what a database error's own
 * message would show (the query and its bound parameters, such as token hashes).
 */
export function runMain(scope: string, main: () => Promise<number>): void {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      createLogger(scope).error('The command failed unexpectedly', { error });
      process.exitCode = 1;
    },
  );
}
