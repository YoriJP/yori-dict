CREATE TABLE `english_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`headword` text NOT NULL,
	`lookup_term` text NOT NULL,
	`entry_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `english_entries_lookup_term_unique` ON `english_entries` (`lookup_term`);--> statement-breakpoint
CREATE TABLE `english_examples` (
	`sense_id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`example_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `english_senses` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`position` integer NOT NULL,
	`part_of_speech` text NOT NULL,
	`definition` text NOT NULL,
	`sense_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `english_senses_entry_position` ON `english_senses` (`entry_id`,`position`);--> statement-breakpoint
CREATE TABLE `english_source_payloads` (
	`source` text NOT NULL,
	`payload_id` text NOT NULL,
	`raw_json` text NOT NULL,
	PRIMARY KEY(`source`, `payload_id`)
);
--> statement-breakpoint
CREATE TABLE `english_source_records` (
	`source` text NOT NULL,
	`source_version` text NOT NULL,
	`source_entry_id` text NOT NULL,
	`headword_lookup` text NOT NULL,
	`license` text NOT NULL,
	`attribution` text NOT NULL,
	`payload_id` text NOT NULL,
	`record_json` text NOT NULL,
	PRIMARY KEY(`source`, `source_entry_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `english_source_records_headword` ON `english_source_records` (`headword_lookup`,`source`,`source_entry_id`);--> statement-breakpoint
CREATE TABLE `model_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dictionary` text NOT NULL,
	`attempt_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `production_metadata` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `terminal_outcomes` (
	`dictionary` text NOT NULL,
	`outcome_key` text NOT NULL,
	`outcome` text NOT NULL,
	PRIMARY KEY(`dictionary`, `outcome_key`)
);
