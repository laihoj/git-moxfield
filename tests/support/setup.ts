import '@testing-library/jest-dom/vitest';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Tests must never reach a real database: not the developer's `data/git-moxfield.db` (the
// default DATABASE_PATH) and not a Turso database named in the shell's environment. Code
// that opens the app's database without being given one (`getDb()`) gets a throwaway file
// of this worker instead.
process.env.DATABASE_PATH = join(tmpdir(), 'git-moxfield-vitest', `worker-${process.pid}.db`);
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
