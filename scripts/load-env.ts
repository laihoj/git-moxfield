/**
 * Loads `.env*` files for the command-line scripts (`db:migrate`, `export:git`,
 * `seed:demo`), so they use the same configuration, and in particular the same
 * `DATABASE_PATH`, as the app. Next.js loads these files for the app; plain `tsx`
 * scripts would otherwise see only the shell environment.
 *
 * Files and precedence follow Next.js: `.env.<mode>.local`, `.env.local` (not in the
 * `test` mode), `.env.<mode>`, `.env`, where the mode is `NODE_ENV` (`development` or
 * `test`) and otherwise `production`, as for `next start`. Variables that are already
 * set win over every file, and earlier files win over later ones. Unlike Next.js,
 * `$VARIABLE` references in values are not expanded.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

/** An environment to fill, such as `process.env`. */
export type Env = Record<string, string | undefined>;

export interface LoadEnvFilesOptions {
  /** Directory holding the `.env*` files. Default: the working directory. */
  dir?: string;
  /** Environment to fill. Default: `process.env`. */
  env?: Env;
}

/**
 * Sets the variables of the `.env*` files that are not set yet.
 * @returns the files that were read, highest precedence first.
 * @throws when a file exists but cannot be read.
 */
export function loadEnvFiles(options: LoadEnvFilesOptions = {}): string[] {
  const dir = options.dir ?? process.cwd();
  const env = options.env ?? process.env;
  const mode = env.NODE_ENV === 'test' || env.NODE_ENV === 'development' ? env.NODE_ENV : 'production';
  const files = [`.env.${mode}.local`, ...(mode === 'test' ? [] : ['.env.local']), `.env.${mode}`, '.env'];

  const loaded: string[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(join(dir, file), 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    for (const [key, value] of Object.entries(parseEnv(content))) {
      if (value !== undefined && env[key] === undefined) env[key] = value;
    }
    loaded.push(file);
  }
  return loaded;
}
