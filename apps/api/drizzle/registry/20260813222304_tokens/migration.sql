CREATE TABLE `tokens` (
	`id` text PRIMARY KEY,
	`namespace_slug` text NOT NULL,
	`repository_name` text NOT NULL,
	`secret_hash` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`expires_at_unix` integer NOT NULL,
	`revoked_at` text,
	CONSTRAINT `tokens_repository_fk` FOREIGN KEY (`namespace_slug`,`repository_name`) REFERENCES `repositories`(`namespace_slug`,`name`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_secret_hash_unique` ON `tokens` (`secret_hash`);