import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openLookupDb } from "./db";
import { openEnrichmentRepository } from "./enrichment-repository";
import { openEnglishEnrichmentRepository } from "./english-enrichment-repository";
import type { AttemptRecord } from "./on-demand-dictionary";
import type { EnglishEntry, EnglishExample } from "./english-types";
import type { PublicExample, PublicLookupItem } from "./types";

export function importLegacyOverlays(
  productionPath: string,
  japaneseOverlayPath: string,
  englishOverlayPath: string
): { japanese: boolean; english: boolean } {
  return {
    japanese: importJapaneseOverlay(productionPath, japaneseOverlayPath),
    english: importEnglishOverlay(productionPath, englishOverlayPath)
  };
}

function importJapaneseOverlay(productionPath: string, overlayPath: string): boolean {
  if (!canImport(productionPath, overlayPath, "legacyJapaneseOverlay")) return false;
  const legacy = new Database(overlayPath, { readonly: true });
  const lookup = openLookupDb(productionPath);
  const repository = openEnrichmentRepository(productionPath, lookup);
  try {
    if (hasTable(legacy, "on_demand_entries")) {
      for (const row of legacy.query<{ entry_json: string }, []>("select entry_json from on_demand_entries order by entry_id").all()) {
        repository.saveEntry(JSON.parse(row.entry_json) as PublicLookupItem);
      }
    }
    if (hasTable(legacy, "on_demand_examples")) {
      for (const row of legacy.query<{ sense_id: string; example_json: string }, []>(
        "select sense_id, example_json from on_demand_examples order by sense_id"
      ).all()) repository.saveExample(row.sense_id, JSON.parse(row.example_json) as PublicExample);
    }
    if (hasTable(legacy, "example_enrichments")) {
      for (const row of legacy.query<{ sense_id: string; example_json: string }, []>(`
        select sense_id, example_json from example_enrichments
         where status = 'accepted' and example_json is not null order by sense_id
      `).all()) repository.saveExample(row.sense_id, JSON.parse(row.example_json) as PublicExample);
    }
    if (hasTable(legacy, "on_demand_attempts")) {
      for (const row of legacy.query<{ attempt_json: string }, []>("select attempt_json from on_demand_attempts order by id").all()) {
        repository.recordAttempt(JSON.parse(row.attempt_json) as AttemptRecord);
      }
    }
    if (hasTable(legacy, "on_demand_terminal_outcomes")) {
      for (const row of legacy.query<{ outcome_key: string; outcome: string }, []>(
        "select outcome_key, outcome from on_demand_terminal_outcomes order by outcome_key"
      ).all()) repository.saveTerminalOutcome(row.outcome_key, row.outcome);
    }
    markImported(productionPath, "legacyJapaneseOverlay", overlayPath);
    return true;
  } finally {
    repository.close();
    lookup.close();
    legacy.close();
  }
}

function importEnglishOverlay(productionPath: string, overlayPath: string): boolean {
  if (!canImport(productionPath, overlayPath, "legacyEnglishOverlay")) return false;
  const legacy = new Database(overlayPath, { readonly: true });
  const repository = openEnglishEnrichmentRepository(productionPath);
  try {
    if (hasTable(legacy, "english_entries")) {
      for (const row of legacy.query<{ entry_json: string }, []>("select entry_json from english_entries order by entry_id").all()) {
        repository.saveEntry(JSON.parse(row.entry_json) as EnglishEntry);
      }
    }
    if (hasTable(legacy, "english_examples")) {
      for (const row of legacy.query<{ sense_id: string; example_json: string }, []>(
        "select sense_id, example_json from english_examples order by sense_id"
      ).all()) repository.saveExample(row.sense_id, JSON.parse(row.example_json) as EnglishExample);
    }
    if (hasTable(legacy, "english_attempts")) {
      for (const row of legacy.query<{ attempt_json: string }, []>("select attempt_json from english_attempts order by id").all()) {
        repository.recordAttempt(JSON.parse(row.attempt_json) as AttemptRecord);
      }
    }
    if (hasTable(legacy, "english_terminal_outcomes")) {
      for (const row of legacy.query<{ outcome_key: string; outcome: string }, []>(
        "select outcome_key, outcome from english_terminal_outcomes order by outcome_key"
      ).all()) repository.saveTerminalOutcome(row.outcome_key, row.outcome);
    }
    markImported(productionPath, "legacyEnglishOverlay", overlayPath);
    return true;
  } finally {
    repository.close();
    legacy.close();
  }
}

function canImport(productionPath: string, overlayPath: string, marker: string): boolean {
  if (resolve(productionPath) === resolve(overlayPath) || !existsSync(overlayPath)) return false;
  const db = new Database(productionPath, { readonly: true });
  try {
    return !db.query<{ value: string }, [string]>("select value from production_metadata where key = ?").get(marker);
  } finally {
    db.close();
  }
}

function markImported(productionPath: string, marker: string, overlayPath: string): void {
  const db = new Database(productionPath);
  try {
    db.prepare("insert or replace into production_metadata (key, value) values (?, ?)")
      .run(marker, resolve(overlayPath));
  } finally {
    db.close();
  }
}

function hasTable(db: Database, table: string): boolean {
  return Boolean(db.query<{ name: string }, [string]>(
    "select name from sqlite_master where type = 'table' and name = ?"
  ).get(table));
}
