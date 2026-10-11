/**
 * The plumbing the command-line scripts share (`scripts/cli.ts`, `scripts/database.ts`).
 */
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseConfig, resetConfigForTests } from '@/server/config';
import { scratchDir } from '@tests/support/libsql';

import {
  isEntryPoint,
  parseArgsOrUsage,
  quietLogger,
  sameFile,
  scriptArgs,
  UsageError,
} from '../../../scripts/cli';
import { loadConfigOrReport, openConfiguredDatabaseOrReport } from '../../../scripts/database';

afterEach(() => {
  vi.unstubAllEnvs();
  resetConfigForTests();
});

describe('scriptArgs', () => {
  it('drops the `--` pnpm forwards and reports a request for help', () => {
    expect(scriptArgs(['--', 'invite', '--admin'])).toEqual({ args: ['invite', '--admin'], help: false });
    expect(scriptArgs(['--help'])).toEqual({ args: ['--help'], help: true });
    expect(scriptArgs(['list', '-h'])).toEqual({ args: ['list', '-h'], help: true });
    expect(scriptArgs([])).toEqual({ args: [], help: false });
  });
});

describe('parseArgsOrUsage', () => {
  it('parses the arguments', () => {
    const { values, positionals } = parseArgsOrUsage({
      args: ['who', '--base-url', 'http://localhost:3000'],
      options: { 'base-url': { type: 'string' } },
      allowPositionals: true,
    });
    expect(values['base-url']).toBe('http://localhost:3000');
    expect(positionals).toEqual(['who']);
  });

  it('reports a wrong option as a usage error', () => {
    expect(() => parseArgsOrUsage({ args: ['--nope'], options: {} })).toThrow(UsageError);
    expect(() => parseArgsOrUsage({ args: ['--nope'], options: {} })).toThrow(/--nope/);
  });
});

describe('sameFile and isEntryPoint', () => {
  it('recognize a file through a symlink, and never a missing one', () => {
    const dir = scratchDir('git-moxfield-cli-');
    const file = join(dir, 'a.txt');
    const link = join(dir, 'link.txt');
    writeFileSync(file, 'a');
    writeFileSync(join(dir, 'b.txt'), 'b');
    symlinkSync(file, link);
    expect(sameFile(file, link)).toBe(true);
    expect(sameFile(file, join(dir, 'b.txt'))).toBe(false);
    expect(sameFile(file, join(dir, 'missing.txt'))).toBe(false);
  });

  it('say that a module a test imports is not the entry point', () => {
    expect(isEntryPoint(pathToFileURL(join(scratchDir('git-moxfield-cli-'), 'x.ts')).href)).toBe(false);
  });
});

describe('quietLogger', () => {
  it('drops debug and info', () => {
    const logger = quietLogger('test');
    expect(() => {
      logger.debug('hidden');
      logger.info('hidden');
    }).not.toThrow();
  });
});

describe('loadConfigOrReport', () => {
  it('reports a configuration that is not usable, without throwing', () => {
    vi.stubEnv('TURSO_AUTH_TOKEN', 'token');
    vi.stubEnv('TURSO_DATABASE_URL', '');
    const io = { out: vi.fn(), err: vi.fn() };
    expect(loadConfigOrReport(io)).toBeNull();
    expect(io.err).toHaveBeenCalledTimes(1);
    expect(String(io.err.mock.calls[0]?.[0])).toContain(
      'TURSO_AUTH_TOKEN is set but TURSO_DATABASE_URL is not',
    );
    expect(io.out).not.toHaveBeenCalled();
  });
});

describe('openConfiguredDatabaseOrReport', () => {
  it('opens the configured database', async () => {
    const io = { out: vi.fn(), err: vi.fn() };
    const config = parseConfig({ DATABASE_PATH: join(scratchDir('git-moxfield-cli-'), 'app.db') });
    const database = await openConfiguredDatabaseOrReport(config, io);
    expect(database?.kind).toBe('local');
    database?.close();
    expect(io.err).not.toHaveBeenCalled();
  });

  it('reports a database that cannot be opened, naming it', async () => {
    const io = { out: vi.fn(), err: vi.fn() };
    const config = parseConfig({ TURSO_DATABASE_URL: 'http://127.0.0.1:1' });
    expect(await openConfiguredDatabaseOrReport(config, io)).toBeNull();
    expect(io.err).toHaveBeenCalledTimes(1);
    expect(String(io.err.mock.calls[0]?.[0])).toMatch(/^Could not open the remote database 127\.0\.0\.1:/);
  });
});
