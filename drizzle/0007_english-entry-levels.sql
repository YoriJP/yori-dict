CREATE TABLE IF NOT EXISTS `en_entry_levels` (
	`entry_id` text PRIMARY KEY NOT NULL,
	`level` text NOT NULL CHECK (`level` IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
	`source_name` text NOT NULL,
	`source_version` text NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `en_entries`(`id`)
);
