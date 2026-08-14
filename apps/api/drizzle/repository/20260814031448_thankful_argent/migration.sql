CREATE TABLE `object_links` (
	`source_oid` text NOT NULL,
	`target_oid` text NOT NULL,
	`target_type` text NOT NULL,
	CONSTRAINT `object_links_pk` PRIMARY KEY(`source_oid`, `target_oid`),
	CONSTRAINT `fk_object_links_source_oid_objects_oid_fk` FOREIGN KEY (`source_oid`) REFERENCES `objects`(`oid`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `repack_candidates` (
	`bucket` text PRIMARY KEY,
	`oid` text NOT NULL,
	CONSTRAINT `fk_repack_candidates_oid_objects_oid_fk` FOREIGN KEY (`oid`) REFERENCES `objects`(`oid`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `repack_state` (
	`id` text PRIMARY KEY,
	`ref_version` integer NOT NULL,
	`cursor` text,
	`completed_at` text
);
--> statement-breakpoint
ALTER TABLE `object_deltas` ADD `compressed_size` integer;--> statement-breakpoint
ALTER TABLE `object_deltas` ADD `compressed_chunk_count` integer;--> statement-breakpoint
ALTER TABLE `objects` ADD `compressed_size` integer;--> statement-breakpoint
ALTER TABLE `objects` ADD `compressed_chunk_count` integer;--> statement-breakpoint
ALTER TABLE `objects` ADD `links_indexed` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `object_links_target_oid_idx` ON `object_links` (`target_oid`);