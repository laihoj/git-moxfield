# ADR 0005: Technology stack

- Status: accepted; the database driver is superseded by
  [ADR 0008](0008-hosting-netlify-and-turso.md) (libSQL everywhere, Turso in production)
- Date: 2026-10-09

## Decision

| Concern     | Choice                                                                       | Why                                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language    | TypeScript 6.0 (pinned)                                                      | Strong typing end to end. TS 7 (native) has no JS API yet and breaks typescript-eslint.                                                                                       |
| Framework   | Next.js 16 (App Router), React 19                                            | One process for UI and server code. Server components read the service layer directly. Server actions for mutations, route handlers for the capture endpoint. Mature tooling. |
| Database    | SQLite via better-sqlite3 13                                                 | Zero-ops, one file, synchronous and fast. N-API prebuilds, so no compiler is needed.                                                                                          |
| ORM         | Drizzle 0.45                                                                 | Typed schema, SQL-like queries, plain SQL migrations committed to the repo (custom trigger migration).                                                                        |
| Validation  | zod 4                                                                        | Lenient parsing of untrusted Moxfield payloads; config validation.                                                                                                            |
| Styling     | Tailwind CSS 4                                                               | Small, consistent design system without a component framework dependency.                                                                                                     |
| Markdown    | react-markdown + remark-gfm                                                  | Renders primer markdown to React elements without raw HTML.                                                                                                                   |
| Text diff   | jsdiff (`diff`)                                                              | Proven line diff for primers.                                                                                                                                                 |
| Tests       | Vitest 5 (+ fast-check, Testing Library), Playwright                         | Fast unit and integration tests with an in-memory SQLite. Property tests for the diff engine. Real-browser e2e against a mock Moxfield.                                       |
| Lint/format | ESLint 10 flat config (next + typescript-eslint strictTypeChecked), Prettier | Strict, type-aware linting. Layering is enforced with `no-restricted-imports`.                                                                                                |

## Rejected

- **Separate SPA + API server** (Vite + Hono): a clean split, but two processes and a
  duplicated HTTP contract for a single-user tool.
- **Prisma**: a heavier runtime, and a weaker fit for SQLite triggers and raw SQL migrations.
- **node:sqlite**: a release candidate in Node 25, and Drizzle support is only in the 1.0 RC.
- **Redis, queues, microservices, Docker-only setup**: nothing in the problem needs them.

## Runtime

Node 24 LTS is recommended (`.nvmrc`). Node ≥ 22.12 is supported. Node 25 works
but is end-of-life.
