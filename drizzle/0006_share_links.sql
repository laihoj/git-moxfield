ALTER TABLE `share_links` ADD `credential_id` text;--> statement-breakpoint
CREATE INDEX `share_links_credential_idx` ON `share_links` (`credential_id`);