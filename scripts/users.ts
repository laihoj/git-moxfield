/**
 * Manages accounts from the command line (ADR 0006), acting as the operator:
 *
 *   pnpm users invite [--admin] [--note <text>] [--base-url <url>]
 *       Prints a one-time invite link (valid 7 days). With --admin the new user is an
 *       admin; the first admin adopts the history of a pre-account installation, so this
 *       is the command-line alternative to /claim.
 *   pnpm users list
 *       Lists every user with role, status, deck and key counts.
 *   pnpm users recover <user id | display name> [--base-url <url>]
 *       Prints a one-time recovery link (valid 24 hours) for a user who lost every key
 *       and signed-in device.
 *   pnpm users claim-code
 *       Prints the setup code while the installation has no users.
 *
 * Links are printed with the base URL from --base-url, else `PUBLIC_APP_URL`, else
 * http://localhost:3000. They are secrets: hand them to the person they are for, and do
 * not paste them anywhere public. Reads `DATABASE_PATH` (and the rest of the
 * configuration) from the environment and `.env*` files, like the app.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { createAuthService, SYSTEM_ACTOR, type AuthService } from '@/server/auth/service';
import type { UserDTO } from '@/server/auth/types';
import { getConfig, type AppConfig } from '@/server/config';
import { openDatabase, type Db } from '@/server/db/client';
import { createLogger, type Logger } from '@/server/logger';
import { isServiceError } from '@/server/services/errors';

import { loadEnvFiles } from './load-env';

const DEFAULT_APP_URL = 'http://localhost:3000';

export const USAGE = `Usage: pnpm users <command>

Commands:
  invite [--admin] [--note <text>] [--base-url <url>]   Print a one-time invite link (7 days)
  list                                                  List users
  recover <user id | display name> [--base-url <url>]   Print a one-time recovery link (24 hours)
  claim-code                                            Print the setup code of an unclaimed installation`;

export interface UsersCommandIO {
  out(line: string): void;
  err(line: string): void;
}

export interface UsersCommandDependencies {
  db: Db;
  config: AppConfig;
  io: UsersCommandIO;
  /** Default: system time. */
  now?: () => Date;
}

/** Thrown for wrong usage; the message is shown with the usage text. */
class UsageError extends Error {}

/** Runs one `pnpm users` command. @returns the process exit code. */
export async function runUsersCommand(
  argv: readonly string[],
  deps: UsersCommandDependencies,
): Promise<number> {
  // pnpm forwards a literal `--` when users separate script arguments with it.
  const args = argv.filter((arg) => arg !== '--');
  const { io } = deps;
  if (args.length === 0) {
    io.err(USAGE);
    return 2;
  }
  if (args.includes('--help') || args.includes('-h')) {
    io.out(USAGE);
    return 0;
  }
  const auth = createAuthService({ db: deps.db, config: deps.config, logger: quietLogger(), now: deps.now });
  try {
    const [command = '', ...rest] = args;
    switch (command) {
      case 'invite':
        return await invite(auth, deps, rest);
      case 'list':
        return await list(auth, deps, rest);
      case 'recover':
        return await recover(auth, deps, rest);
      case 'claim-code':
        return await claimCode(auth, deps, rest);
      default:
        throw new UsageError(`Unknown command ${JSON.stringify(command)}.`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    if (isServiceError(error)) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
}

async function invite(auth: AuthService, deps: UsersCommandDependencies, args: string[]): Promise<number> {
  const { values } = parse(args, {
    admin: { type: 'boolean', default: false },
    note: { type: 'string', default: '' },
    'base-url': { type: 'string' },
  });
  const baseUrl = resolveBaseUrl(values['base-url'], deps.config);
  const role = values.admin === true ? 'admin' : 'member';
  const note = typeof values.note === 'string' ? values.note : '';
  const issued = await auth.createInvite(SYSTEM_ACTOR, { role, note });
  deps.io.out(
    `Invite for a new ${role}${issued.invite.note === '' ? '' : ` (${issued.invite.note})`}, valid until ${issued.expiresAt}:`,
  );
  deps.io.out(new URL(issued.path, baseUrl).href);
  return 0;
}

async function list(auth: AuthService, deps: UsersCommandDependencies, args: string[]): Promise<number> {
  parse(args, {});
  const users = await auth.listUsers(SYSTEM_ACTOR);
  if (users.length === 0) {
    deps.io.out(
      'No users yet. Claim git-moxfield at /claim (see `pnpm users claim-code`) or create an admin invite.',
    );
    return 0;
  }
  for (const user of users) deps.io.out(describeUser(user));
  return 0;
}

async function recover(auth: AuthService, deps: UsersCommandDependencies, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { 'base-url': { type: 'string' } }, true);
  const [who, ...extra] = positionals;
  if (who === undefined || who.trim() === '' || extra.length > 0) {
    throw new UsageError('recover needs exactly one user id or display name.');
  }
  const baseUrl = resolveBaseUrl(values['base-url'], deps.config);
  const users = await auth.listUsers(SYSTEM_ACTOR);
  const wanted = who.trim().normalize('NFC').toLowerCase();
  const byId = users.filter((user) => user.id === who.trim());
  const matches = byId.length > 0 ? byId : users.filter((user) => user.displayName.toLowerCase() === wanted);
  const [user, ...others] = matches;
  if (user === undefined) {
    deps.io.err(`No user matches ${JSON.stringify(who)}. Users:`);
    for (const candidate of users) deps.io.err(describeUser(candidate));
    return 1;
  }
  if (others.length > 0) {
    deps.io.err(`Several users are called ${JSON.stringify(who)}. Pass the user id:`);
    for (const candidate of matches) deps.io.err(describeUser(candidate));
    return 1;
  }
  const link = await auth.createRecoveryLink(SYSTEM_ACTOR, user.id);
  deps.io.out(`One-time sign-in link for ${user.displayName}, valid until ${link.expiresAt}:`);
  deps.io.out(new URL(link.path, baseUrl).href);
  return 0;
}

async function claimCode(auth: AuthService, deps: UsersCommandDependencies, args: string[]): Promise<number> {
  parse(args, {});
  const code = await auth.setupCode();
  if (code === null) {
    deps.io.err('git-moxfield is already claimed. Admins invite new users (`pnpm users invite`).');
    return 1;
  }
  deps.io.out(code);
  return 0;
}

type OptionSpec = Record<string, { type: 'boolean' | 'string'; default?: boolean | string }>;

function parse(args: string[], options: OptionSpec, allowPositionals = false) {
  try {
    return parseArgs({ args, options, allowPositionals, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function resolveBaseUrl(option: unknown, config: AppConfig): string {
  const value = typeof option === 'string' ? option : (config.PUBLIC_APP_URL ?? DEFAULT_APP_URL);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`--base-url must be an absolute URL such as ${DEFAULT_APP_URL}.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError('--base-url must be an http or https URL.');
  }
  return url.href;
}

function describeUser(user: UserDTO): string {
  const status = user.disabledAt === null ? 'active' : 'disabled';
  const seen = user.lastSeenAt === null ? 'never seen' : `last seen ${user.lastSeenAt}`;
  return `  ${user.id}  ${user.displayName}  ${user.role}, ${status}, ${user.deckCount} decks, ${user.activeKeyCount} keys, ${seen}`;
}

/** Only warnings and errors: the command's own output is the point. */
function quietLogger(): Logger {
  const logger = createLogger('users');
  return { ...logger, debug: () => undefined, info: () => undefined };
}

async function main(): Promise<number> {
  try {
    loadEnvFiles();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const config = getConfig();
  const db = openDatabase(config.DATABASE_PATH);
  try {
    return await runUsersCommand(process.argv.slice(2), {
      db,
      config,
      io: {
        out: (line) => {
          console.log(line);
        },
        err: (line) => {
          console.error(line);
        },
      },
    });
  } finally {
    db.$client.close();
  }
}

/** Whether Node runs this file as the main module (symlinks resolved, as for `import.meta.url`). */
function isEntryPoint(): boolean {
  const entryPoint = process.argv[1];
  if (entryPoint === undefined) return false;
  try {
    return realpathSync(entryPoint) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Run only as a script (`pnpm users`), not when imported by tests.
if (isEntryPoint()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : error);
      process.exitCode = 1;
    },
  );
}
