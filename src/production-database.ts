import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { downloadPinnedDataRelease } from "../scripts/download-data-release";
import type { EnglishEntry } from "./english-types";

const migrationsFolder = resolve(import.meta.dir, "../drizzle");

export function migrateProductionDatabase(path: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const sqlite = new Database(path, { create: true });
  try {
    sqlite.exec("pragma journal_mode = WAL; pragma synchronous = NORMAL; pragma busy_timeout = 5000;");
    migrate(drizzle({ client: sqlite }), { migrationsFolder });
    const trackingBackfilled = sqlite.query<{ value: string }, []>(
      "select value from production_metadata where key = 'englishImportTrackingBackfilled'"
    ).get();
    if (!trackingBackfilled) {
      sqlite.transaction(() => sqlite.exec(`
        insert or ignore into english_imported_entries (entry_id)
        select entry.id
          from english_entries entry
         where not exists (
           select 1 from json_each(entry.entry_json, '$.senses') sense
            where json_type(sense.value, '$.generation') is not null
         );
        insert into production_metadata (key, value) values ('englishImportTrackingBackfilled', '1');
      `))();
    }
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
  return true;
}

export function importEnglishRelease(path: string, releasePath: string): boolean {
  const db = new Database(path);
  db.exec("pragma journal_mode = WAL; pragma synchronous = NORMAL; pragma busy_timeout = 5000;");
  try {
    const imported = db.query<{ value: string }, []>(
      "select value from production_metadata where key = 'englishDictionaryVersion'"
    ).get();
    const source = new Database(releasePath, { readonly: true });
    const version = source.query<{ value: string }, []>(
      "select value from metadata where key = 'dictionaryVersion'"
    ).get()?.value;
    source.close();
    if (!version) throw new Error(`English release has no dictionaryVersion: ${releasePath}`);
    if (imported?.value === version) {
      db.prepare("attach database ? as english_release").run(resolve(releasePath));
      try {
        db.exec(`
          insert or ignore into english_imported_entries
          select production.id from english_entries production
          join english_release.entries released on released.id = production.id
        `);
      } finally {
        db.exec("detach database english_release");
      }
      return false;
    }

    db.prepare("attach database ? as english_release").run(resolve(releasePath));
    try {
      const generatedCollisions = db.query<{ lookup_term: string; entry_json: string }, []>(`
        select current.lookup_term, current.entry_json
          from english_entries current
          join english_release.entries incoming on incoming.lookup_term = current.lookup_term
         where exists (
           select 1 from json_each(current.entry_json, '$.senses') sense
            where json_type(sense.value, '$.generation') is not null
         )
      `).all();
      db.transaction(() => {
        db.exec(`
          create temp table retained_english_examples as
            select * from english_examples;
          delete from english_examples
           where entry_id in (select entry_id from english_imported_entries)
              or entry_id in (
                select e.id from english_entries e
                join english_release.entries incoming on incoming.lookup_term = e.lookup_term
              );
          delete from english_senses
           where entry_id in (select entry_id from english_imported_entries)
              or entry_id in (
                select e.id from english_entries e
                join english_release.entries incoming on incoming.lookup_term = e.lookup_term
              );
          delete from english_entries
           where id in (select entry_id from english_imported_entries)
              or lookup_term in (select lookup_term from english_release.entries);
          delete from english_imported_entries;
          delete from english_source_payloads;
          delete from english_source_records;
          insert into english_source_payloads select * from english_release.source_payloads;
          insert into english_source_records select * from english_release.source_records;
          insert into english_entries select * from english_release.entries;
          insert into english_senses select * from english_release.senses;
          insert into english_imported_entries select id from english_release.entries;
        `);
        for (const collision of generatedCollisions) {
          mergeGeneratedEnglishSenses(db, collision.lookup_term, collision.entry_json);
        }
        db.exec(`
          insert or ignore into english_examples
            select retained.sense_id, sense.entry_id, retained.example_json
              from retained_english_examples retained
            join english_senses sense on sense.id = retained.sense_id;
          drop table retained_english_examples;
        `);
        db.prepare(`
          insert into production_metadata (key, value) values ('englishDictionaryVersion', ?)
          on conflict(key) do update set value = excluded.value
        `).run(version);
      })();
    } finally {
      db.exec("detach database english_release");
    }
    return true;
  } finally {
    db.close();
  }
}

function mergeGeneratedEnglishSenses(db: Database, lookupTerm: string, previousJson: string): void {
  const row = db.query<{ entry_json: string }, [string]>(
    "select entry_json from english_entries where lookup_term = ?"
  ).get(lookupTerm);
  if (!row) return;
  const incoming = JSON.parse(row.entry_json) as EnglishEntry;
  const previous = JSON.parse(previousJson) as EnglishEntry;
  const generated = previous.senses.filter((sense) => sense.generation);
  if (generated.length === 0) return;

  const known = new Set(incoming.senses.map((sense) => sense.id));
  const retained = generated
    .filter((sense) => !known.has(sense.id))
    .map((sense, index) => ({ ...sense, position: incoming.senses.length + index + 1 }));
  if (retained.length === 0) return;

  const merged: EnglishEntry = { ...incoming, senses: [...incoming.senses, ...retained] };
  db.prepare("update english_entries set entry_json = ? where id = ?")
    .run(JSON.stringify(merged), incoming.id);
  const insertSense = db.prepare(`
    insert into english_senses (id, entry_id, position, part_of_speech, definition, sense_json)
    values (?, ?, ?, ?, ?, ?)
  `);
  for (const sense of retained) {
    insertSense.run(
      sense.id,
      incoming.id,
      sense.position,
      sense.partOfSpeech,
      sense.definition,
      JSON.stringify(sense)
    );
  }
}

export function importJapaneseRelease(path: string, releasePath: string): boolean {
  const production = new Database(path);
  production.exec("pragma journal_mode = WAL; pragma synchronous = NORMAL; pragma busy_timeout = 5000;");
  const source = new Database(releasePath, { readonly: true });
  const incomingVersion = source.query<{ value: string }, []>(
    "select value from metadata where key = 'dictDate'"
  ).get()?.value;
  source.close();
  if (!incomingVersion) throw new Error(`Japanese release has no dictDate: ${releasePath}`);
  const currentVersion = production.query<{ value: string }, []>(
    "select value from metadata where key = 'dictDate'"
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
          create temp table retained_japanese_examples as
            select example.* from examples example
            join senses sense on sense.id = example.sense_id
            join entries entry on entry.id = sense.entry_id
            where example.source = 'generated' and entry.source != 'generated';
          delete from examples where sense_id in (
            select sense.id from senses sense join entries entry on entry.id = sense.entry_id
            where entry.source != 'generated'
          );
          delete from glosses where sense_id in (
            select sense.id from senses sense join entries entry on entry.id = sense.entry_id
            where entry.source != 'generated'
          );
          delete from senses where entry_id in (select id from entries where source != 'generated');
          delete from forms where entry_id in (select id from entries where source != 'generated');
          delete from lookup_terms where entry_id in (select id from entries where source != 'generated');
          delete from entries where source != 'generated';
          delete from metadata;

          insert into metadata select * from japanese_release.metadata;
          insert into entries select * from japanese_release.entries;
          insert into forms select * from japanese_release.forms;
          insert into senses select * from japanese_release.senses;
          insert into glosses select * from japanese_release.glosses;
          insert into examples select * from japanese_release.examples;
          insert into lookup_terms select * from japanese_release.lookup_terms;
          insert or ignore into examples
            select retained.* from retained_japanese_examples retained
            join senses sense on sense.id = retained.sense_id;
          drop table retained_japanese_examples;
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
      "select value from production_metadata where key = 'englishDictionaryVersion'"
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
    return Boolean(db.query<{ value: string }, []>("select value from metadata where key = 'dictDate'").get()?.value);
  } catch {
    return false;
  } finally {
    db.close();
  }
}
