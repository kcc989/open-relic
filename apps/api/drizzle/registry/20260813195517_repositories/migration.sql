CREATE TABLE `repositories` (
	`namespace_slug` text NOT NULL,
	`name` text NOT NULL,
	`id` text NOT NULL,
	`durable_object_id` text NOT NULL,
	`description` text,
	`default_branch` text NOT NULL,
	`read_only` integer DEFAULT false NOT NULL,
	`source` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_push_at` text,
	CONSTRAINT `repositories_pk` PRIMARY KEY(`namespace_slug`, `name`),
	CONSTRAINT `fk_repositories_namespace_slug_namespaces_slug_fk` FOREIGN KEY (`namespace_slug`) REFERENCES `namespaces`(`slug`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_id_unique` ON `repositories` (`id`);