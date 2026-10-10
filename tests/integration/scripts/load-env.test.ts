import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadEnvFiles, type Env } from '../../../scripts/load-env';

describe('loadEnvFiles (scripts read the same .env files as the app)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'git-moxfield-env-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(file: string, content: string): void {
    writeFileSync(join(dir, file), content);
  }

  it('reads .env.local like `next start` does', () => {
    write('.env.local', 'DATABASE_PATH=data/my-real.db\n');
    const env: Env = {};
    expect(loadEnvFiles({ dir, env })).toEqual(['.env.local']);
    expect(env.DATABASE_PATH).toBe('data/my-real.db');
  });

  it('gives earlier files precedence, in the order of `next start`', () => {
    write('.env', 'A=env\nB=env\nC=env\nD=env\n');
    write('.env.production', 'A=production\nB=production\nC=production\n');
    write('.env.local', 'A=local\nB=local\n');
    write('.env.production.local', 'A=production-local\n');
    const env: Env = {};
    expect(loadEnvFiles({ dir, env })).toEqual([
      '.env.production.local',
      '.env.local',
      '.env.production',
      '.env',
    ]);
    expect(env).toEqual({ A: 'production-local', B: 'local', C: 'production', D: 'env' });
  });

  it('never overrides variables that are already set, even to an empty value', () => {
    write('.env.local', 'DATABASE_PATH=data/my-real.db\nMOXFIELD_SITE_ORIGIN=http://localhost:4010\n');
    const env: Env = { DATABASE_PATH: 'data/other.db', MOXFIELD_SITE_ORIGIN: '' };
    loadEnvFiles({ dir, env });
    expect(env).toEqual({ DATABASE_PATH: 'data/other.db', MOXFIELD_SITE_ORIGIN: '' });
  });

  it('uses the files of the NODE_ENV mode, and skips .env.local for tests', () => {
    write('.env.local', 'A=local\n');
    write('.env.development', 'A=development\n');
    write('.env.test', 'A=test\n');
    const development: Env = { NODE_ENV: 'development' };
    expect(loadEnvFiles({ dir, env: development })).toEqual(['.env.local', '.env.development']);
    expect(development.A).toBe('local');
    const test: Env = { NODE_ENV: 'test' };
    expect(loadEnvFiles({ dir, env: test })).toEqual(['.env.test']);
    expect(test.A).toBe('test');
  });

  it('loads nothing when there are no .env files', () => {
    const env: Env = {};
    expect(loadEnvFiles({ dir, env })).toEqual([]);
    expect(env).toEqual({});
  });
});
