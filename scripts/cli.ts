/**
 * Plumbing shared by the command-line scripts: where their output goes, how they read
 * their arguments, running only as the main module (tests import the scripts), and
 * turning the result of `main` into the process exit code.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';

import type { Logger } from '@/core/logger';
import { createLogger } from '@/server/logger';

/** Where a command writes: tests collect the lines, the scripts print them. */
export interface CommandIO {
  out(line: string): void;
  err(line: string): void;
}

/** The terminal: results on stdout, problems on stderr. */
export const consoleIO: CommandIO = {
  out: (line) => {
    console.log(line);
  },
  err: (line) => {
    console.error(line);
  },
};

/** Thrown for wrong usage; the message is shown with the usage text and the exit code is 2. */
export class UsageError extends Error {}

/**
 * The arguments of a script without the literal `--` pnpm forwards when users separate
 * script arguments with it, and whether they ask for help (`--help`, `-h`).
 */
export function scriptArgs(argv: readonly string[]): { args: string[]; help: boolean } {
  const args = argv.filter((arg) => arg !== '--');
  return { args, help: args.includes('--help') || args.includes('-h') };
}

/** `parseArgs` that reports a wrong option as a {@link UsageError}. */
export function parseArgsOrUsage<T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

/** Whether two paths are the same file, symlinks resolved; `false` when either cannot be resolved. */
export function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Whether Node runs the module at `moduleUrl` (pass `import.meta.url`) as the main
 * module, symlinks resolved; `false` when a test imports it.
 */
export function isEntryPoint(moduleUrl: string): boolean {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && sameFile(entryPoint, fileURLToPath(moduleUrl));
}

/**
 * A logger for a command whose own output is the point: only warnings and errors (the
 * services log an info line for every capture and commit).
 */
export function quietLogger(scope: string): Logger {
  const logger = createLogger(scope);
  return { ...logger, debug: () => undefined, info: () => undefined };
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
