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
import { defineConfig } from 'drizzle-kit';

// Relative, not '@/…': drizzle-kit loads this file without the app's path aliases.
import { databaseLocationFromEnv } from './src/server/db/database-location';

const { url, authToken } = databaseLocationFromEnv(process.env);

export default defineConfig({
  dialect: 'turso',
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dbCredentials: authToken === undefined ? { url } : { url, authToken },
  strict: true,
  verbose: true,
});
