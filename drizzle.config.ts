/**
 * drizzle-kit configuration (`pnpm db:generate` writes new migrations to `drizzle/`).
 *
 * The `turso` dialect is SQLite over libSQL, the driver the app uses everywhere (ADR 0008).
 * Generating migrations needs no database. Commands that do connect (`drizzle-kit studio`,
 * `drizzle-kit push`) use the app's database: `TURSO_DATABASE_URL` (+ `TURSO_AUTH_TOKEN`)
 * when set, else the local file at `DATABASE_PATH`. Apply migrations with `pnpm db:migrate`,
 * never with `drizzle-kit migrate` or `push`: the script also verifies referential
 * integrity and refuses a throwaway database on Netlify.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { defineConfig } from 'drizzle-kit';

const remoteUrl = process.env.TURSO_DATABASE_URL?.trim();

export default defineConfig({
  dialect: 'turso',
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dbCredentials:
    remoteUrl === undefined || remoteUrl === ''
      ? { url: pathToFileURL(resolve(process.env.DATABASE_PATH ?? 'data/git-moxfield.db')).href }
      : { url: remoteUrl, authToken: process.env.TURSO_AUTH_TOKEN },
  strict: true,
  verbose: true,
});
