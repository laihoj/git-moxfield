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

/** Single-user today (`local`); the seam for real multi-user auth later. */
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
    index('snapshot_cards_card_key_idx').on(t.cardKey),
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

/** Card reference data for display. Latest wins; not versioned. */
export const cardCatalog = sqliteTable('card_catalog', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  typeLine: text('type_line').notNull(),
  primaryType: text('primary_type').notNull(),
  manaCost: text('mana_cost').notNull(),
  cmc: real('cmc').notNull(),
  colorIdentityJson: text('color_identity_json').notNull(),
  layout: text('layout').notNull(),
  scryfallId: text('scryfall_id'),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

/**
 * Per-installation settings and secrets as key/value text (e.g. the capture token baked
 * into the same-tab bookmarklet). Mutable; keys are defined next to their readers.
 */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});
