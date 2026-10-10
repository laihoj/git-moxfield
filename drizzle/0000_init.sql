CREATE TABLE `branches` (
	`id` text PRIMARY KEY NOT NULL,
	`deck_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`head_commit_id` text,
	`base_commit_id` text,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`deck_id`) REFERENCES `decks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`head_commit_id`) REFERENCES `commits`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`base_commit_id`) REFERENCES `commits`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `branches_deck_name_uq` ON `branches` (`deck_id`,`name`);--> statement-breakpoint
CREATE TABLE `card_catalog` (
	`key` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type_line` text NOT NULL,
	`primary_type` text NOT NULL,
	`mana_cost` text NOT NULL,
	`cmc` real NOT NULL,
	`color_identity_json` text NOT NULL,
	`layout` text NOT NULL,
	`scryfall_id` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `commit_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`commit_id` text NOT NULL,
	`kind` text NOT NULL,
	`data_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`commit_id`) REFERENCES `commits`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `commit_notes_commit_kind_uq` ON `commit_notes` (`commit_id`,`kind`);--> statement-breakpoint
CREATE TABLE `commits` (
	`id` text PRIMARY KEY NOT NULL,
	`deck_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`parent_id` text,
	`snapshot_hash` text NOT NULL,
	`raw_blob_hash` text,
	`message` text NOT NULL,
	`created_at` text NOT NULL,
	`ingest_method` text NOT NULL,
	`fetched_at` text NOT NULL,
	`source_version` integer,
	`source_updated_at` text,
	`source_metadata_json` text NOT NULL,
	FOREIGN KEY (`deck_id`) REFERENCES `decks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `commits`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`snapshot_hash`) REFERENCES `snapshots`(`hash`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`raw_blob_hash`) REFERENCES `raw_blobs`(`hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `commits_deck_sequence_uq` ON `commits` (`deck_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `commits_parent_idx` ON `commits` (`parent_id`);--> statement-breakpoint
CREATE INDEX `commits_snapshot_idx` ON `commits` (`snapshot_hash`);--> statement-breakpoint
CREATE TABLE `decks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`url` text NOT NULL,
	`name` text NOT NULL,
	`format` text DEFAULT '' NOT NULL,
	`head_branch_name` text DEFAULT 'main' NOT NULL,
	`last_fetch_attempt_at` text,
	`last_fetch_error_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `decks_workspace_source_external_uq` ON `decks` (`workspace_id`,`source`,`external_id`);--> statement-breakpoint
CREATE TABLE `observations` (
	`id` text PRIMARY KEY NOT NULL,
	`deck_id` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`raw_blob_hash` text NOT NULL,
	`ingest_method` text NOT NULL,
	`fetched_at` text NOT NULL,
	`source_version` integer,
	`source_updated_at` text,
	`source_metadata_json` text NOT NULL,
	`warnings_json` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`deck_id`) REFERENCES `decks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`snapshot_hash`) REFERENCES `snapshots`(`hash`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`raw_blob_hash`) REFERENCES `raw_blobs`(`hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `observations_deck_fetched_idx` ON `observations` (`deck_id`,`fetched_at`);--> statement-breakpoint
CREATE TABLE `raw_blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`media_type` text NOT NULL,
	`encoding` text NOT NULL,
	`byte_length` integer NOT NULL,
	`data` blob NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `snapshot_cards` (
	`snapshot_hash` text NOT NULL,
	`zone` text NOT NULL,
	`card_key` text NOT NULL,
	`name` text NOT NULL,
	`quantity` integer NOT NULL,
	PRIMARY KEY(`snapshot_hash`, `zone`, `card_key`),
	FOREIGN KEY (`snapshot_hash`) REFERENCES `snapshots`(`hash`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `snapshot_cards_card_key_idx` ON `snapshot_cards` (`card_key`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`hash` text PRIMARY KEY NOT NULL,
	`schema_version` integer NOT NULL,
	`canonical_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `version_tags` (
	`commit_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`commit_id`, `name`),
	FOREIGN KEY (`commit_id`) REFERENCES `commits`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `version_tags_name_idx` ON `version_tags` (`name`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
