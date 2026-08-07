import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// JMdict's normalized tables are installed by the pinned Japanese source import.
// Drizzle owns the production-only tables added around that canonical dataset.

export const productionMetadata = sqliteTable("production_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull()
});

export const japaneseGeneratedRecords = sqliteTable("japanese_generated_records", {
  entryId: text("entry_id").primaryKey(),
  entryJson: text("entry_json").notNull(),
  acceptedAt: text("accepted_at").notNull()
});

export const englishSourcePayloads = sqliteTable("english_source_payloads", {
  source: text("source").notNull(),
  payloadId: text("payload_id").notNull(),
  rawJson: text("raw_json").notNull()
}, (table) => [primaryKey({ columns: [table.source, table.payloadId] })]);

export const englishSourceRecords = sqliteTable("english_source_records", {
  source: text("source").notNull(),
  sourceVersion: text("source_version").notNull(),
  sourceEntryId: text("source_entry_id").notNull(),
  headwordLookup: text("headword_lookup").notNull(),
  license: text("license").notNull(),
  attribution: text("attribution").notNull(),
  payloadId: text("payload_id").notNull(),
  recordJson: text("record_json").notNull()
}, (table) => [
  primaryKey({ columns: [table.source, table.sourceEntryId] }),
  uniqueIndex("english_source_records_headword").on(table.headwordLookup, table.source, table.sourceEntryId)
]);

export const englishEntries = sqliteTable("english_entries", {
  id: text("id").primaryKey(),
  headword: text("headword").notNull(),
  lookupTerm: text("lookup_term").notNull().unique(),
  entryJson: text("entry_json").notNull()
});

export const englishImportedEntries = sqliteTable("english_imported_entries", {
  entryId: text("entry_id").primaryKey()
});

export const englishSenses = sqliteTable("english_senses", {
  id: text("id").primaryKey(),
  entryId: text("entry_id").notNull(),
  position: integer("position").notNull(),
  partOfSpeech: text("part_of_speech").notNull(),
  definition: text("definition").notNull(),
  senseJson: text("sense_json").notNull()
}, (table) => [uniqueIndex("english_senses_entry_position").on(table.entryId, table.position)]);

export const englishExamples = sqliteTable("english_examples", {
  senseId: text("sense_id").primaryKey(),
  entryId: text("entry_id").notNull(),
  exampleJson: text("example_json").notNull()
});

export const modelAttempts = sqliteTable("model_attempts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dictionary: text("dictionary").notNull(),
  attemptJson: text("attempt_json").notNull(),
  createdAt: text("created_at").notNull()
});

export const terminalOutcomes = sqliteTable("terminal_outcomes", {
  dictionary: text("dictionary").notNull(),
  outcomeKey: text("outcome_key").notNull(),
  outcome: text("outcome").notNull()
}, (table) => [primaryKey({ columns: [table.dictionary, table.outcomeKey] })]);
