CREATE TABLE `object_deltas` (
	`oid` text PRIMARY KEY,
	`base_oid` text NOT NULL,
	`size` integer NOT NULL,
	`chunk_count` integer NOT NULL,
	CONSTRAINT `fk_object_deltas_oid_objects_oid_fk` FOREIGN KEY (`oid`) REFERENCES `objects`(`oid`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `objects` (
	`oid` text PRIMARY KEY,
	`type` text NOT NULL,
	`size` integer NOT NULL,
	`chunk_count` integer NOT NULL
);
