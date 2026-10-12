CREATE TABLE `moxfield_rate` (
	`id` integer PRIMARY KEY NOT NULL,
	`next_slot_ms` integer DEFAULT 0 NOT NULL,
	`last_grant_ms` integer,
	`backoff_until_ms` integer DEFAULT 0 NOT NULL,
	`backoff_level` integer DEFAULT 0 NOT NULL,
	`slow_until_ms` integer DEFAULT 0 NOT NULL,
	`last_rate_limited_ms` integer,
	`rate_limit_count` integer DEFAULT 0 NOT NULL,
	`paused_at_ms` integer,
	`pause_reason` text,
	CONSTRAINT "moxfield_rate_single_row" CHECK("moxfield_rate"."id" = 1)
);
--> statement-breakpoint
-- The limiter's only row (ADR 0009). Without it no request to Moxfield is ever sent.
INSERT INTO `moxfield_rate` (`id`) VALUES (1);
