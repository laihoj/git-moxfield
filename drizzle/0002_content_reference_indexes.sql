CREATE INDEX `commits_raw_blob_idx` ON `commits` (`raw_blob_hash`);--> statement-breakpoint
CREATE INDEX `observations_snapshot_idx` ON `observations` (`snapshot_hash`);--> statement-breakpoint
CREATE INDEX `observations_raw_blob_idx` ON `observations` (`raw_blob_hash`);