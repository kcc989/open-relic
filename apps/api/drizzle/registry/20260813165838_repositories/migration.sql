CREATE TABLE `repositories` (
	`namespace_slug` text NOT NULL,
	`name` text NOT NULL,
	`durable_object_id` text NOT NULL,
	`description` text,
	`default_branch` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `repositories_pk` PRIMARY KEY(`namespace_slug`, `name`),
	CONSTRAINT `fk_repositories_namespace_slug_namespaces_slug_fk` FOREIGN KEY (`namespace_slug`) REFERENCES `namespaces`(`slug`) ON DELETE CASCADE
);
