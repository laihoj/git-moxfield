CREATE TABLE `deck_relinks` (
	`id` text PRIMARY KEY NOT NULL,
	`deck_id` text NOT NULL,
	`previous_external_id` text NOT NULL,
	`previous_url` text NOT NULL,
	`external_id` text NOT NULL,
	`url` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`deck_id`) REFERENCES `decks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deck_relinks_deck_idx` ON `deck_relinks` (`deck_id`,`created_at`);