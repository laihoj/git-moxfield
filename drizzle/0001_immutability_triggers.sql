-- History is append-only. Versions (commits), snapshots and raw payloads can never be
-- modified in place; commits can only disappear together with their deck.
CREATE TRIGGER `commits_immutable_update` BEFORE UPDATE ON `commits`
BEGIN
  SELECT RAISE(ABORT, 'commits are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `commits_immutable_delete` BEFORE DELETE ON `commits`
WHEN EXISTS (SELECT 1 FROM `decks` WHERE `id` = OLD.`deck_id`)
BEGIN
  SELECT RAISE(ABORT, 'commits are immutable; delete the deck to remove its history');
END;
--> statement-breakpoint
CREATE TRIGGER `snapshots_immutable_update` BEFORE UPDATE ON `snapshots`
BEGIN
  SELECT RAISE(ABORT, 'snapshots are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `snapshot_cards_immutable_update` BEFORE UPDATE ON `snapshot_cards`
BEGIN
  SELECT RAISE(ABORT, 'snapshot index rows are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `raw_blobs_immutable_update` BEFORE UPDATE ON `raw_blobs`
BEGIN
  SELECT RAISE(ABORT, 'raw blobs are immutable');
END;
