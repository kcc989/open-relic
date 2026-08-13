CREATE TABLE `sweep_reachable` (
	`oid` text PRIMARY KEY,
	`pending` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sweep_state` (
	`id` text PRIMARY KEY,
	`phase` text NOT NULL,
	`ref_version` integer NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`reachable_objects` integer DEFAULT 0 NOT NULL,
	`reclaimed_objects` integer DEFAULT 0 NOT NULL,
	`reclaimed_chunks` integer DEFAULT 0 NOT NULL,
	`reclaimed_bytes` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `repository_state` ADD `ref_version` integer DEFAULT 0 NOT NULL;