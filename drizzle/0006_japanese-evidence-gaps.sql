CREATE TABLE IF NOT EXISTS `ja_sense_evidence` (
	`sense_id` text NOT NULL,
	`position` integer NOT NULL,
	`evidence_id` text NOT NULL,
	`source_name` text NOT NULL,
	FOREIGN KEY (`sense_id`) REFERENCES `ja_senses`(`id`),
	UNIQUE(`sense_id`,`position`),
	UNIQUE(`sense_id`,`evidence_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ja_explanation_group_gaps` (
	`entry_id` text NOT NULL,
	`lang` text NOT NULL,
	`missing_evidence_id` text NOT NULL,
	`source_version` text NOT NULL,
	`basis` text NOT NULL CHECK (`basis` IN ('legacy-exact-sense-mapping', 'accepted-authored-evidence')),
	PRIMARY KEY(`entry_id`,`lang`,`missing_evidence_id`),
	FOREIGN KEY (`entry_id`) REFERENCES `ja_entries`(`id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ja_sense_evidence_sense_idx` ON `ja_sense_evidence` (`sense_id`,`position`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ja_group_gaps_entry_lang_idx` ON `ja_explanation_group_gaps` (`entry_id`,`lang`,`missing_evidence_id`);
