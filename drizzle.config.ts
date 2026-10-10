import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { defineConfig } from 'drizzle-kit';

const databasePath = resolve(process.env.DATABASE_PATH ?? 'data/git-moxfield.db');
mkdirSync(dirname(databasePath), { recursive: true });

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: databasePath },
  strict: true,
  verbose: true,
});
