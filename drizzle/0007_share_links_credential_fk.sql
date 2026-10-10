PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_share_links` (
	`id` text PRIMARY KEY NOT NULL,
	`deck_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`include_notes` integer DEFAULT false NOT NULL,
	`created_by_user_id` text,
	`credential_id` text,
	`created_at` text NOT NULL,
	`last_viewed_at` text,
	`revoked_at` text,
	FOREIGN KEY (`deck_id`) REFERENCES `decks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_share_links`("id", "deck_id", "token_hash", "label", "include_notes", "created_by_user_id", "credential_id", "created_at", "last_viewed_at", "revoked_at") SELECT "id", "deck_id", "token_hash", "label", "include_notes", "created_by_user_id", "credential_id", "created_at", "last_viewed_at", "revoked_at" FROM `share_links`;--> statement-breakpoint
DROP TABLE `share_links`;--> statement-breakpoint
ALTER TABLE `__new_share_links` RENAME TO `share_links`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `share_links_token_hash_unique` ON `share_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `share_links_deck_idx` ON `share_links` (`deck_id`);--> statement-breakpoint
CREATE INDEX `share_links_credential_idx` ON `share_links` (`credential_id`);