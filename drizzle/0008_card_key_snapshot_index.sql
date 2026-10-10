DROP INDEX `snapshot_cards_card_key_idx`;--> statement-breakpoint
CREATE INDEX `snapshot_cards_card_key_snapshot_idx` ON `snapshot_cards` (`card_key`,`snapshot_hash`);