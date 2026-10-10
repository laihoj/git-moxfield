/**
 * SQLite schema (Drizzle ORM).
 *
 * The history core is content-addressed and append-only:
 *   - `snapshots` and `raw_blobs` are keyed by SHA-256 of their content.
 *   - `commits` are keyed by SHA-256 of a Git-like commit object.
 * Database triggers (see the custom migration) reject UPDATEs of those tables and
 * DELETEs of commits outside of deleting their deck.
 *
 * Mutable, user-curated data (tags, notes) lives in separate tables that reference
 * commits, the way Git notes annotate commits without changing them.
 *
 * Timestamps are ISO-8601 UTC strings (sortable, human-readable in the DB).
 */
import { sql } from 'drizzle-orm';
import {
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

/**
 * A user's private space: decks and everything under them belong to a workspace. Each
 * user owns exactly one (see `users.workspace_id`). `local` is the workspace of the
 * single-user installations that predate accounts; the first admin adopts it.
 */
export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
});

export const decks = sqliteTable(
  'decks',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** DeckSource id, e.g. `moxfield`. */
    source: text('source').notNull(),
    /** Public id on the source, e.g. Moxfield `publicId`. */
    externalId: text('external_id').notNull(),
    url: text('url').notNull(),
    /** Latest known deck name (cache for listings). */
    name: text('name').notNull(),
    /** Latest known format (cache for listings). */
    format: text('format').notNull().default(''),
    /** Symbolic HEAD: the branch new versions are committed to. */
    headBranchName: text('head_branch_name').notNull().default('main'),
    lastFetchAttemptAt: text('last_fetch_attempt_at'),
    /** JSON `FetchErrorDTO` of the most recent failed fetch, cleared on success. */
    lastFetchErrorJson: text('last_fetch_error_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('decks_workspace_source_external_uq').on(t.workspaceId, t.source, t.externalId)],
);

/**
 * The record of a deck's changes of source deck ("Change Moxfield deck"): the user deleted
 * the deck on Moxfield and made it again, which gave it a new public id, and the deck's
 * history continues with the new one. One row per change, oldest first by `created_at`;
 * the deck row holds the current reference.
 *
 * Commits keep the reference they were made under: a commit's id hashes `deck
 * <source>:<externalId>` as it was at commit time, so versions from before a change hash
 * `previous_external_id` (or an even earlier one). These rows are how that stays
 * verifiable. Removed with the deck.
 */
export const deckRelinks = sqliteTable(
  'deck_relinks',
  {
    id: text('id').primaryKey(),
    deckId: text('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    /** The source deck the deck followed until this change (same source as the deck). */
    previousExternalId: text('previous_external_id').notNull(),
    previousUrl: text('previous_url').notNull(),
    /** The source deck the deck followed from this change on. */
    externalId: text('external_id').notNull(),
    url: text('url').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('deck_relinks_deck_idx').on(t.deckId, t.createdAt)],
);

/** Canonical snapshots, content-addressed. Immutable. */
export const snapshots = sqliteTable('snapshots', {
  hash: text('hash').primaryKey(),
  schemaVersion: integer('schema_version').notNull(),
  /** `stableStringify(snapshot)`; sha256 of this text is `hash`. */
  canonicalJson: text('canonical_json').notNull(),
  createdAt: text('created_at').notNull(),
});

/**
 * Derived index of snapshot contents for card history and search. Rebuildable from
 * `snapshots.canonical_json` at any time.
 *
 * `(card_key, snapshot_hash)` lets card history and search probe one card per version of
 * a deck (rows read ≈ versions + hits) instead of reading every card of every version;
 * Turso bills every row a query reads (ADR 0008). Its `card_key` prefix also serves
 * lookups by card alone.
 */
export const snapshotCards = sqliteTable(
  'snapshot_cards',
  {
    snapshotHash: text('snapshot_hash')
      .notNull()
      .references(() => snapshots.hash, { onDelete: 'cascade' }),
    zone: text('zone').notNull(),
    cardKey: text('card_key').notNull(),
    name: text('name').notNull(),
    quantity: integer('quantity').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.snapshotHash, t.zone, t.cardKey] }),
    index('snapshot_cards_card_key_snapshot_idx').on(t.cardKey, t.snapshotHash),
  ],
);

/** Raw source payloads, gzip-compressed, keyed by sha256 of the uncompressed bytes. Immutable. */
export const rawBlobs = sqliteTable('raw_blobs', {
  hash: text('hash').primaryKey(),
  mediaType: text('media_type').notNull(),
  /** Compression of `data`; currently always `gzip`. */
  encoding: text('encoding').notNull(),
  /** Uncompressed size in bytes. */
  byteLength: integer('byte_length').notNull(),
  data: blob('data', { mode: 'buffer' }).notNull(),
  createdAt: text('created_at').notNull(),
});

/**
 * Lines of history per deck. Today every deck has exactly one `main` branch; future
 * experiments are branches with `kind = 'experiment'` anchored at `base_commit_id`.
 */
export const branches = sqliteTable(
  'branches',
  {
    id: text('id').primaryKey(),
    deckId: text('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['main', 'experiment'] }).notNull(),
    headCommitId: text('head_commit_id').references((): AnySQLiteColumn => commits.id),
    baseCommitId: text('base_commit_id').references((): AnySQLiteColumn => commits.id),
    description: text('description'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('branches_deck_name_uq').on(t.deckId, t.name)],
);

/** Immutable versions. */
export const commits = sqliteTable(
  'commits',
  {
    /** sha256 of the serialized commit object (see `src/core/hash.ts`). */
    id: text('id').primaryKey(),
    deckId: text('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    /** Branch the version was committed on (informational; lineage is `parent_id`). */
    branchId: text('branch_id')
      .notNull()
      .references(() => branches.id),
    /** Per-deck, user-facing version number (`v12`). */
    sequence: integer('sequence').notNull(),
    parentId: text('parent_id').references((): AnySQLiteColumn => commits.id),
    snapshotHash: text('snapshot_hash')
      .notNull()
      .references(() => snapshots.hash),
    rawBlobHash: text('raw_blob_hash').references(() => rawBlobs.hash),
    message: text('message').notNull(),
    createdAt: text('created_at').notNull(),
    /** `server` | `browser-capture` | `manual-paste`. */
    ingestMethod: text('ingest_method').notNull(),
    /** When the committed state was fetched/captured from the source. */
    fetchedAt: text('fetched_at').notNull(),
    sourceVersion: integer('source_version'),
    sourceUpdatedAt: text('source_updated_at'),
    /** JSON `SourceDeckMetadata` at commit time. */
    sourceMetadataJson: text('source_metadata_json').notNull(),
  },
  (t) => [
    uniqueIndex('commits_deck_sequence_uq').on(t.deckId, t.sequence),
    index('commits_parent_idx').on(t.parentId),
    index('commits_snapshot_idx').on(t.snapshotHash),
    index('commits_raw_blob_idx').on(t.rawBlobHash),
  ],
);

/** Every fetch/capture of the live source deck. The latest one is the "working tree". */
export const observations = sqliteTable(
  'observations',
  {
    id: text('id').primaryKey(),
    deckId: text('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    snapshotHash: text('snapshot_hash')
      .notNull()
      .references(() => snapshots.hash),
    rawBlobHash: text('raw_blob_hash')
      .notNull()
      .references(() => rawBlobs.hash),
    ingestMethod: text('ingest_method').notNull(),
    fetchedAt: text('fetched_at').notNull(),
    sourceVersion: integer('source_version'),
    sourceUpdatedAt: text('source_updated_at'),
    sourceMetadataJson: text('source_metadata_json').notNull(),
    /** JSON `IngestWarning[]`. */
    warningsJson: text('warnings_json').notNull().default('[]'),
  },
  (t) => [
    index('observations_deck_fetched_idx').on(t.deckId, t.fetchedAt),
    // Child-key indexes: deleting an unreferenced snapshot or raw blob (deck deletion)
    // must find referencing rows without scanning every observation.
    index('observations_snapshot_idx').on(t.snapshotHash),
    index('observations_raw_blob_idx').on(t.rawBlobHash),
  ],
);

/** Lightweight labels on versions (`tournament`, `stable`, ...). Mutable. */
export const versionTags = sqliteTable(
  'version_tags',
  {
    commitId: text('commit_id')
      .notNull()
      .references(() => commits.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.commitId, t.name] }), index('version_tags_name_idx').on(t.name)],
);

/**
 * Structured, mutable annotations on versions (free-text notes today; tournament
 * results, game records, observations later). `kind` namespaces the JSON payload.
 */
export const commitNotes = sqliteTable(
  'commit_notes',
  {
    id: text('id').primaryKey(),
    commitId: text('commit_id')
      .notNull()
      .references(() => commits.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    dataJson: text('data_json').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('commit_notes_commit_kind_uq').on(t.commitId, t.kind)],
);

/**
 * Card reference data for display (type line, mana cost, image id), per workspace: the
 * facts come from captured or pasted Moxfield JSON, which is untrusted, so one user's
 * capture must never change what another workspace shows. Within a workspace the latest
 * write wins; not versioned.
 */
export const cardCatalog = sqliteTable(
  'card_catalog',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    typeLine: text('type_line').notNull(),
    primaryType: text('primary_type').notNull(),
    manaCost: text('mana_cost').notNull(),
    cmc: real('cmc').notNull(),
    colorIdentityJson: text('color_identity_json').notNull(),
    layout: text('layout').notNull(),
    scryfallId: text('scryfall_id'),
    /** When the facts last changed (an upsert of the same facts writes nothing). */
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);

/**
 * Per-installation settings and secrets as key/value text (e.g. the setup code of an
 * unclaimed installation). Mutable; keys are defined next to their readers.
 */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ---------------------------------------------------------------------------
// Accounts and access (ADR 0006, ADR 0007)
//
// Every secret (bookmarklet keys, session tokens, invite/login/share link tokens) is
// stored only as the SHA-256 hex digest of the full token string. Tokens carry a type
// prefix (gmk_, gms_, gmi_, gml_, gmv_) so a leaked one is recognizable.
// ---------------------------------------------------------------------------

/** A person. Owns exactly one workspace; credentials are separate (see `credentials`). */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .unique()
    .references(() => workspaces.id),
  displayName: text('display_name').notNull(),
  /** `admin` manages users and invites; grants no access to other users' decks. */
  role: text('role', { enum: ['admin', 'member'] }).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastSeenAt: text('last_seen_at'),
  /** Disabled users cannot sign in; their sessions and keys stop working. Data is kept. */
  disabledAt: text('disabled_at'),
});

/**
 * Ways to prove you are a user. Today only `bookmarklet-key` (a secret embedded in the
 * user's bookmarklet). `oauth` (Discord, Google) attaches here later without touching
 * any deck data: `provider` + `provider_account_id` identify the external account.
 */
export const credentials = sqliteTable(
  'credentials',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['bookmarklet-key', 'oauth'] }).notNull(),
    /** SHA-256 hex of the secret, for secret-based kinds. */
    secretHash: text('secret_hash').unique(),
    provider: text('provider'),
    providerAccountId: text('provider_account_id'),
    /** Human label, e.g. "Laptop Chrome". */
    label: text('label').notNull(),
    /**
     * The bookmarklet key the creating browser's session descends from (see
     * `sessions.credential_id`), when there is one: a key made in a browser that another
     * key signed in. Lets the owner find, and revoke with it, keys made through a key
     * that was stolen. `null` for keys made in a browser signed in otherwise.
     */
    createdByCredentialId: text('created_by_credential_id').references(
      (): AnySQLiteColumn => credentials.id,
      { onDelete: 'set null' },
    ),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
    revokedAt: text('revoked_at'),
  },
  (t) => [
    index('credentials_user_idx').on(t.userId),
    uniqueIndex('credentials_provider_account_uq').on(t.provider, t.providerAccountId),
  ],
);

/** Signed-in browsers. The cookie holds the token; only its hash is stored. */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    /** How the session started: which credential or link signed the browser in. */
    createdVia: text('created_via', {
      enum: ['bookmarklet', 'device-link', 'recovery-link', 'invite', 'claim'],
    }).notNull(),
    /**
     * The bookmarklet key the session descends from: the key that signed the browser in
     * (`bookmarklet`), or, for a `device-link` session, the key the session that made the
     * link descends from. Revoking the key ends every session that descends from it.
     */
    credentialId: text('credential_id').references(() => credentials.id, { onDelete: 'set null' }),
    /**
     * A hand-off started by the same-tab bookmarklet's cross-site post: not a session yet
     * (it signs nobody in) until the browser completes the hand-off, which turns it into
     * an ordinary session or ends it (`src/app/api/auth/handoff`).
     */
    pendingHandoff: integer('pending_handoff', { mode: 'boolean' }).notNull().default(false),
    /** Truncated User-Agent, to recognize the device in the session list. */
    userAgent: text('user_agent'),
    createdAt: text('created_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    revokedAt: text('revoked_at'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/**
 * One-time sign-in links for an existing user: `device` (created by the user to sign in
 * another device) and `recovery` (created by an admin for a user who lost access). Used
 * recovery links stay as the record the user sees of an admin signing in as them.
 */
export const loginLinks = sqliteTable(
  'login_links',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: ['device', 'recovery'] }).notNull(),
    /** Who made the link: the user themselves (`device`), an admin, or `null` for the command line. */
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * The bookmarklet key the creating session descends from (`device` links only): the
     * session the link starts descends from it too, so revoking the key reaches it.
     */
    credentialId: text('credential_id').references(() => credentials.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    usedAt: text('used_at'),
    /** Withdrawn before use (by an admin, or because its user or creator signed out or was disabled). */
    revokedAt: text('revoked_at'),
  },
  (t) => [index('login_links_user_idx').on(t.userId)],
);

/** One-time invitations that create a new user. */
export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  role: text('role', { enum: ['admin', 'member'] }).notNull(),
  /** Who the invite is for, as a reminder for the admin ("Mikko"). */
  note: text('note').notNull().default(''),
  /** Null for invites created from the CLI. */
  createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
  usedByUserId: text('used_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  revokedAt: text('revoked_at'),
});

/**
 * Read-only links to one deck's committed history (ADR 0007). Anyone holding the token
 * can view while the link is not revoked, the deck is tracked and its owner is not
 * disabled. Removed with the deck (untracking ends every link at once).
 */
export const shareLinks = sqliteTable(
  'share_links',
  {
    id: text('id').primaryKey(),
    deckId: text('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    label: text('label').notNull().default(''),
    /** Whether viewers see the owner's private version notes. */
    includeNotes: integer('include_notes', { mode: 'boolean' }).notNull().default(false),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * The bookmarklet key the creating session descends from (see `sessions.credential_id`),
     * when there is one. Revoking a stolen key can then find, and revoke with it, the links
     * made in the browsers it signed in. `null` for links made in a browser signed in otherwise.
     */
    credentialId: text('credential_id').references(() => credentials.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull(),
    /** Last view through the link, recorded at most hourly. */
    lastViewedAt: text('last_viewed_at'),
    revokedAt: text('revoked_at'),
  },
  (t) => [index('share_links_deck_idx').on(t.deckId), index('share_links_credential_idx').on(t.credentialId)],
);
