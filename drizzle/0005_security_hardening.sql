PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_card_catalog` (
	`workspace_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`type_line` text NOT NULL,
	`primary_type` text NOT NULL,
	`mana_cost` text NOT NULL,
	`cmc` real NOT NULL,
	`color_identity_json` text NOT NULL,
	`layout` text NOT NULL,
	`scryfall_id` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`workspace_id`, `key`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- The catalog becomes per workspace. Each existing row is copied to every workspace with
-- a deck whose versions or observations contain the card, so no workspace loses facts it
-- shows; rows no deck refers to are dropped (they are rebuilt on the next capture).
INSERT INTO `__new_card_catalog`("workspace_id", "key", "name", "type_line", "primary_type", "mana_cost", "cmc", "color_identity_json", "layout", "scryfall_id", "updated_at")
SELECT DISTINCT d."workspace_id", c."key", c."name", c."type_line", c."primary_type", c."mana_cost", c."cmc", c."color_identity_json", c."layout", c."scryfall_id", c."updated_at"
FROM `card_catalog` AS c
JOIN `snapshot_cards` AS sc ON sc."card_key" = c."key"
JOIN (
	SELECT "snapshot_hash", "deck_id" FROM `commits`
	UNION
	SELECT "snapshot_hash", "deck_id" FROM `observations`
) AS used ON used."snapshot_hash" = sc."snapshot_hash"
JOIN `decks` AS d ON d."id" = used."deck_id";--> statement-breakpoint
DROP TABLE `card_catalog`;--> statement-breakpoint
ALTER TABLE `__new_card_catalog` RENAME TO `card_catalog`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `credentials` ADD `created_by_credential_id` text REFERENCES credentials(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `login_links` ADD `credential_id` text REFERENCES credentials(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `login_links` ADD `revoked_at` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `pending_handoff` integer DEFAULT false NOT NULL;
