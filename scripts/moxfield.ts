/**
 * Server fetching from Moxfield, from the command line, acting as the operator (ADR 0009):
 *
 *   pnpm moxfield status
 *       Whether server fetching runs, is backing off after a 429, or is paused after a
 *       refusal (with the reason and since when), and the request spacing in force.
 *   pnpm moxfield resume
 *       Resumes server fetching for every instance after a 403 or a bot-protection
 *       challenge paused it. A 429 backoff keeps running: that is Moxfield's request.
 *
 * Works on the app's database (`TURSO_DATABASE_URL`, else `DATABASE_PATH`), the one every
 * instance of the deployment shares, with the rest of the app's configuration read from
 * the environment and `.env*` files like the app does (see `./database`). It never sends
 * a request to Moxfield and needs no User-Agent.
 */
import type { AppConfig } from '@/server/config';
import type { LibsqlExecutor } from '@/server/repositories';
import { DatabaseMoxfieldLimiter, type MoxfieldLimiterDetails } from '@/server/moxfield-limiter';

import {
  consoleIO,
  isEntryPoint,
  parseArgsOrUsage,
  quietLogger,
  runMain,
  scriptArgs,
  UsageError,
  type CommandIO,
} from './cli';
import { describeConfiguredDatabase, loadConfigOrReport, openConfiguredDatabaseOrReport } from './database';

export const USAGE = `Usage: pnpm moxfield <command>

Commands:
  status   Show whether server fetching from Moxfield runs, backs off or is paused
  resume   Resume server fetching after Moxfield refused a request (403 or a challenge)`;

export interface MoxfieldCommandDependencies {
  db: LibsqlExecutor;
  config: AppConfig;
  io: CommandIO;
}

/** Runs one `pnpm moxfield` command. @returns the process exit code. */
export async function runMoxfieldCommand(
  argv: readonly string[],
  deps: MoxfieldCommandDependencies,
): Promise<number> {
  const { args, help } = scriptArgs(argv);
  const { io } = deps;
  if (args.length === 0) {
    io.err(USAGE);
    return 2;
  }
  if (help) {
    io.out(USAGE);
    return 0;
  }
  const limiter = new DatabaseMoxfieldLimiter({
    db: () => Promise.resolve(deps.db),
    intervalMs: deps.config.MOXFIELD_MIN_REQUEST_INTERVAL_MS,
    logger: quietLogger('moxfield'),
  });
  try {
    const [command = '', ...rest] = args;
    parseArgsOrUsage({ args: rest, options: {} });
    switch (command) {
      case 'status':
        printStatus(await limiter.details(), deps);
        return 0;
      case 'resume': {
        const wasPaused = await limiter.resume();
        io.out(
          wasPaused
            ? 'Server fetching from Moxfield resumed for every instance.'
            : 'Server fetching from Moxfield was not paused; nothing changed.',
        );
        printStatus(await limiter.details(), deps);
        return 0;
      }
      default:
        throw new UsageError(`Unknown command ${JSON.stringify(command)}.`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
}

function printStatus(details: MoxfieldLimiterDetails, deps: MoxfieldCommandDependencies): void {
  const { io, config } = deps;
  const { status } = details;
  io.out(`Database: ${describeConfiguredDatabase(config)}`);
  io.out(`MOXFIELD_SERVER_FETCH: ${config.MOXFIELD_SERVER_FETCH}`);
  io.out(
    `Moxfield-issued User-Agent: ${config.moxfieldUserAgent === undefined ? 'not configured here' : 'configured'}`,
  );
  switch (status.state) {
    case 'available':
      io.out('State: running');
      break;
    case 'rate-limited':
      io.out(`State: backing off after a 429 until ${status.retryAt} (ends on its own)`);
      break;
    case 'paused':
      io.out(`State: PAUSED since ${status.pausedAt}`);
      io.out(`Reason: ${status.reason}`);
      io.out('Resume with: pnpm moxfield resume');
      break;
  }
  io.out(
    details.slowedUntil === null
      ? `Interval: ${details.intervalMs} ms between requests (all instances together)`
      : `Interval: ${details.currentIntervalMs} ms (doubled after a 429) until ${details.slowedUntil}, then ${details.intervalMs} ms`,
  );
  io.out(
    details.lastRateLimitedAt === null
      ? '429 answers: none'
      : `429 answers: ${details.rateLimitCount}, the last at ${details.lastRateLimitedAt}`,
  );
  if (config.moxfieldUserAgentWarning !== null) io.err(`Warning: ${config.moxfieldUserAgentWarning}`);
}

async function main(): Promise<number> {
  const config = loadConfigOrReport(consoleIO);
  if (config === null) return 1;
  const database = await openConfiguredDatabaseOrReport(config, consoleIO);
  if (database === null) return 1;
  try {
    return await runMoxfieldCommand(process.argv.slice(2), { db: database.db, config, io: consoleIO });
  } finally {
    database.close();
  }
}

// Run only as a script (`pnpm moxfield`), not when imported by tests.
if (isEntryPoint(import.meta.url)) runMain('moxfield', main);
