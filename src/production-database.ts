import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { downloadPinnedDataRelease } from "../scripts/download-data-release";
import { createEnglishSchema } from "./english-schema";
import { createJapaneseSchema } from "./japanese-schema";

const migrationsFolder = resolve(import.meta.dir, "../drizzle");

export function migrateProductionDatabase(path: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const sqlite = new Database(path, { create: true });
  try {
    sqlite.exec("pragma journal_mode = WAL; pragma synchronous = NORMAL; pragma busy_timeout = 5000;");
    migrate(drizzle({ client: sqlite }), { migrationsFolder });
  } finally {
    sqlite.close();
  }
}

export async function ensureJapaneseProductionDatabase(path: string): Promise<boolean> {
  if (hasJapaneseDictionary(path)) return false;
  if (existsSync(path)) {
    throw new Error(`Production database exists without a Japanese dictionary: ${path}`);
  }
  await downloadPinnedDataRelease({ outPath: path });
  // A release published before the `ja_*` rebuild cannot be served. Fail here
  // rather than starting on a database no lookup can read.
  if (!hasJapaneseDictionary(path)) {
    throw new Error(
      `Pinned data release does not use the ja_* canonical schema: ${path}. ` +
        "Publish a rebuilt release, or build locally with bun run build:db."
    );
  }
  return true;
}

/**
 * Grafts a rebuilt English release onto the production database. Imported
 * content is replaced wholesale while accepted generated entries and accepted
 * generated examples on imported meanings are retained with their provenance.
 */
export function importEnglishRelease(path: string, releasePath: string): boolean {
  const production = new Database(path);
  production.exec("pragma journal_mode = WAL; pragma synchronous = NORMAL; pragma busy_timeout = 5000;");
  createEnglishSchema(production);
  const source = new Database(releasePath, { readonly: true });
  const incomingVersion = source.query<{ value: string }, []>(
    "select value from en_metadata where key = 'dictionaryVersion'"
  ).get()?.value;
  source.close();
  if (!incomingVersion) throw new Error(`English release has no dictionaryVersion: ${releasePath}`);
  const currentVersion = production.query<{ value: string }, []>(
    "select value from en_metadata where key = 'dictionaryVersion'"
  ).get()?.value;
  if (currentVersion === incomingVersion) {
    production.close();
    return false;
  }

  try {
    production.prepare("attach database ? as english_release").run(resolve(releasePath));
    try {
      production.transaction(() => {
        production.exec(`
          create temp table retained_en_examples as
            select example.* from en_examples example
            join en_senses sense on sense.id = example.sense_id
            join en_entries entry on entry.id = sense.entry_id
            where example.source = 'generated' and entry.source <> 'generated';
          delete from en_examples where sense_id in (
            select sense.id from en_senses sense join en_entries entry on entry.id = sense.entry_id
            where entry.source <> 'generated'
          );
          delete from en_glosses where sense_id in (
            select sense.id from en_senses sense join en_entries entry on entry.id = sense.entry_id
            where entry.source <> 'generated'
          );
          delete from en_senses where entry_id in (select id from en_entries where source <> 'generated');
          delete from en_pronunciations where entry_id in (select id from en_entries where source <> 'generated');
          delete from en_entry_sources where entry_id in (select id from en_entries where source <> 'generated');
          delete from en_lookup_terms where entry_id in (select id from en_entries where source <> 'generated');
          delete from en_entries where source <> 'generated';
          delete from en_metadata;

          insert into en_metadata select * from english_release.en_metadata;
          insert or ignore into en_generations select * from english_release.en_generations;
          insert or ignore into en_entries select * from english_release.en_entries;
          insert or ignore into en_entry_sources select * from english_release.en_entry_sources;
          insert or ignore into en_pronunciations select * from english_release.en_pronunciations;
          insert or ignore into en_lookup_terms select * from english_release.en_lookup_terms;
          insert or ignore into en_senses select * from english_release.en_senses;
          insert or ignore into en_glosses select * from english_release.en_glosses;
          insert or ignore into en_examples select * from english_release.en_examples;
          insert or ignore into en_examples
            select retained.* from retained_en_examples retained
            join en_senses sense on sense.id = retained.sense_id;
          drop table retained_en_examples;
        `);
      })();
    } finally {
      production.exec("detach database english_release");
    }
    return true;
  } finally {
    production.close();
  }
}

/**
 * Grafts a rebuilt Japanese release onto the production database. Imported
 * content is replaced wholesale while accepted generated entries and accepted
 * generated examples on imported meanings are retained with their provenance.
 */
export function importJapaneseRelease(path: string, releasePath: string): boolean {
  const production = new Database(path);
  production.exec("pragma journal_mode = WAL; pragma synchronous = NORMAL; pragma busy_timeout = 5000;");
  createJapaneseSchema(production);
  const source = new Database(releasePath, { readonly: true });
  const incomingVersion = source.query<{ value: string }, []>(
    "select value from ja_metadata where key = 'dictDate'"
  ).get()?.value;
  source.close();
  if (!incomingVersion) throw new Error(`Japanese release has no dictDate: ${releasePath}`);
  const currentVersion = production.query<{ value: string }, []>(
    "select value from ja_metadata where key = 'dictDate'"
  ).get()?.value;
  if (currentVersion === incomingVersion) {
    production.close();
    return false;
  }

  try {
    production.prepare("attach database ? as japanese_release").run(resolve(releasePath));
    try {
      production.transaction(() => {
        production.exec(`
          create temp table retained_ja_examples as
            select example.* from ja_examples example
            join ja_senses sense on sense.id = example.sense_id
            join ja_entries entry on entry.id = sense.entry_id
            where example.source = 'generated' and entry.source <> 'generated';
          delete from ja_examples where sense_id in (
            select sense.id from ja_senses sense join ja_entries entry on entry.id = sense.entry_id
            where entry.source <> 'generated'
          );
          delete from ja_glosses where sense_id in (
            select sense.id from ja_senses sense join ja_entries entry on entry.id = sense.entry_id
            where entry.source <> 'generated'
          );
          delete from ja_senses where entry_id in (select id from ja_entries where source <> 'generated');
          delete from ja_forms where entry_id in (select id from ja_entries where source <> 'generated');
          delete from ja_lookup_terms where entry_id in (select id from ja_entries where source <> 'generated');
          delete from ja_entries where source <> 'generated';
          delete from ja_metadata;

          insert into ja_metadata select * from japanese_release.ja_metadata;
          insert or ignore into ja_generations select * from japanese_release.ja_generations;
          insert or ignore into ja_entries select * from japanese_release.ja_entries;
          insert or ignore into ja_forms select * from japanese_release.ja_forms;
          insert or ignore into ja_lookup_terms select * from japanese_release.ja_lookup_terms;
          insert or ignore into ja_senses select * from japanese_release.ja_senses;
          insert or ignore into ja_glosses select * from japanese_release.ja_glosses;
          insert or ignore into ja_examples select * from japanese_release.ja_examples;
          insert or ignore into ja_examples
            select retained.* from retained_ja_examples retained
            join ja_senses sense on sense.id = retained.sense_id;
          drop table retained_ja_examples;
        `);
      })();
    } finally {
      production.exec("detach database japanese_release");
    }
    return true;
  } finally {
    production.close();
  }
}

export function hasEnglishDictionary(path: string): boolean {
  if (!existsSync(path)) return false;
  const db = new Database(path, { readonly: true });
  try {
    return Boolean(db.query<{ value: string }, []>(
      "select value from en_metadata where key = 'dictionaryVersion'"
    ).get()?.value);
  } catch {
    return false;
  } finally {
    db.close();
  }
}

function hasJapaneseDictionary(path: string): boolean {
  if (!existsSync(path)) return false;
  const db = new Database(path, { readonly: true });
  try {
    return Boolean(db.query<{ value: string }, []>("select value from ja_metadata where key = 'dictDate'").get()?.value);
  } catch {
    return false;
  } finally {
    db.close();
  }
}
