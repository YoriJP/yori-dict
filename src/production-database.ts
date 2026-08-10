import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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
  if (existsSync(path)) clearReplaceableLegacyStore(path);
  await downloadPinnedDataRelease({ outPath: path });
  // A release published before the `ja_*` rebuild cannot be served. Discard it
  // and fail here rather than starting on a database no lookup can read, and
  // rather than leaving an unusable file that confuses the next start.
  if (!hasJapaneseDictionary(path)) {
    rmSync(path, { force: true });
    throw new Error(
      `The release pinned in data-release.json predates the ja-2 canonical schema, ` +
        `so it has no ja_* tables to serve: ${path}. Publish a Japanese release built ` +
        "by bun run japanese:release and re-pin it, or build locally with bun run build:db."
    );
  }
  return true;
}

/**
 * Grafts a rebuilt English release onto the production database. Imported
 * content is replaced wholesale while accepted generated entries, accepted
 * language groups authored for imported entries, and accepted generated
 * examples on imported senses are retained with their provenance.
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
      // Reserve the writer before retention reads establish a WAL snapshot.
      // Enrichment writes continuously in production; a deferred transaction
      // can otherwise read, lose the race to a writer, and fail to upgrade its
      // stale snapshot while the multi-statement graft appears to have run.
      production.transaction(() => {
        production.exec(`
          -- A headword first accepted as a generated entry, and now supplied by
          -- the release, is promoted to the release's own identity. Without
          -- this it would keep source = 'generated' forever, and every later
          -- graft would skip it because deletion targets imported rows.
          create temp table promoted_en_entries as
            select entry.id as id from en_entries entry
            where entry.source = 'generated'
              and entry.id in (select id from english_release.en_entries);

          -- An accepted language group authored for an entry the release
          -- supplies is the usual shape of enrichment. It is carried across the
          -- graft whole, with its glosses, examples, and generation provenance.
          create temp table retained_en_senses as
            select sense.* from en_senses sense
            join en_entries entry on entry.id = sense.entry_id
            where sense.generation_id is not null
              and (entry.source <> 'generated' or entry.id in (select id from promoted_en_entries));
          create temp table retained_en_glosses as
            select gloss.* from en_glosses gloss
            where gloss.sense_id in (select id from retained_en_senses);
          create temp table retained_en_examples as
            select example.* from en_examples example
            join en_senses sense on sense.id = example.sense_id
            join en_entries entry on entry.id = sense.entry_id
            where (entry.source <> 'generated' or entry.id in (select id from promoted_en_entries))
              and (example.source = 'generated' or sense.generation_id is not null);
          delete from en_examples where sense_id in (
            select sense.id from en_senses sense join en_entries entry on entry.id = sense.entry_id
            where entry.source <> 'generated' or entry.id in (select id from promoted_en_entries)
          );
          delete from en_glosses where sense_id in (
            select sense.id from en_senses sense join en_entries entry on entry.id = sense.entry_id
            where entry.source <> 'generated' or entry.id in (select id from promoted_en_entries)
          );
          delete from en_senses where entry_id in (
            select id from en_entries where source <> 'generated'
            union select id from promoted_en_entries
          );
          delete from en_pronunciations where entry_id in (
            select id from en_entries where source <> 'generated'
            union select id from promoted_en_entries
          );
          delete from en_entry_sources where entry_id in (
            select id from en_entries where source <> 'generated'
            union select id from promoted_en_entries
          );
          delete from en_lookup_terms where entry_id in (
            select id from en_entries where source <> 'generated'
            union select id from promoted_en_entries
          );
          delete from en_entries
           where source <> 'generated' or id in (select id from promoted_en_entries);
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
          -- A retained group only returns to an entry the release still
          -- provides, and never displaces content the release itself explains
          -- in that language.
          insert or ignore into en_senses
            select retained.* from retained_en_senses retained
            join en_entries entry on entry.id = retained.entry_id
            where not exists (
              select 1 from en_senses existing
               where existing.entry_id = retained.entry_id and existing.lang = retained.lang
            );
          insert or ignore into en_glosses
            select retained.* from retained_en_glosses retained
            join en_senses sense on sense.id = retained.sense_id;
          insert or ignore into en_examples
            select retained.* from retained_en_examples retained
            join en_senses sense on sense.id = retained.sense_id;
          drop table promoted_en_entries;
          drop table retained_en_senses;
          drop table retained_en_glosses;
          drop table retained_en_examples;
        `);
      }).immediate();
      const installedVersion = production.query<{ value: string }, []>(
        "select value from en_metadata where key = 'dictionaryVersion'"
      ).get()?.value;
      if (installedVersion !== incomingVersion) {
        throw new Error(
          `English release graft did not install ${incomingVersion}: found ${installedVersion ?? "no version"}`
        );
      }
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
 * content is replaced wholesale while accepted generated entries, accepted
 * language groups authored for imported entries, and accepted generated
 * examples on imported senses are retained with their provenance.
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
      // Match the English graft's write-first transaction. Both dictionaries
      // share the same production file and the same concurrent enrichment
      // writer, so either source refresh can race a deferred WAL snapshot.
      production.transaction(() => {
        production.exec(`
          -- A headword first accepted as a generated entry, and now supplied by
          -- the release, is promoted to the release's own identity. Without
          -- this it would keep source = 'generated' forever, and every later
          -- graft would skip it because deletion targets imported rows.
          -- An authored Japanese entry and an imported one never share an id, so
          -- the written forms decide whether the release now carries the word.
          -- The accepted groups move to the release's entry with it.
          create temp table promoted_ja_entries as
            select id, min(replacement_id) as replacement_id from (
              select local.entry_id as id, rel.entry_id as replacement_id
                from ja_lookup_terms local
                join ja_entries entry on entry.id = local.entry_id
                join japanese_release.ja_lookup_terms rel on rel.term = local.term
               where entry.source = 'generated'
              union
              select entry.id as id, entry.id as replacement_id
                from ja_entries entry
               where entry.source = 'generated'
                 and entry.id in (select id from japanese_release.ja_entries)
            ) group by id;

          -- An accepted language group authored for an entry the release
          -- supplies is the usual shape of enrichment. It is carried across the
          -- graft whole, with its glosses, examples, and generation provenance.
          create temp table retained_ja_senses as
            select sense.* from ja_senses sense
            join ja_entries entry on entry.id = sense.entry_id
            where sense.generation_id is not null
              and (entry.source <> 'generated' or entry.id in (select id from promoted_ja_entries));
          update retained_ja_senses
             set entry_id = (select replacement_id from promoted_ja_entries where id = entry_id)
           where entry_id in (select id from promoted_ja_entries);
          create temp table retained_ja_glosses as
            select gloss.* from ja_glosses gloss
            where gloss.sense_id in (select id from retained_ja_senses);
          create temp table retained_ja_examples as
            select example.* from ja_examples example
            join ja_senses sense on sense.id = example.sense_id
            join ja_entries entry on entry.id = sense.entry_id
            where (entry.source <> 'generated' or entry.id in (select id from promoted_ja_entries))
              and (example.source = 'generated' or sense.generation_id is not null);
          delete from ja_examples where sense_id in (
            select sense.id from ja_senses sense join ja_entries entry on entry.id = sense.entry_id
            where entry.source <> 'generated' or entry.id in (select id from promoted_ja_entries)
          );
          delete from ja_glosses where sense_id in (
            select sense.id from ja_senses sense join ja_entries entry on entry.id = sense.entry_id
            where entry.source <> 'generated' or entry.id in (select id from promoted_ja_entries)
          );
          delete from ja_senses where entry_id in (
            select id from ja_entries where source <> 'generated'
            union select id from promoted_ja_entries
          );
          delete from ja_forms where entry_id in (
            select id from ja_entries where source <> 'generated'
            union select id from promoted_ja_entries
          );
          delete from ja_lookup_terms where entry_id in (
            select id from ja_entries where source <> 'generated'
            union select id from promoted_ja_entries
          );
          delete from ja_entries
           where source <> 'generated' or id in (select id from promoted_ja_entries);
          delete from ja_metadata;

          insert into ja_metadata select * from japanese_release.ja_metadata;
          insert or ignore into ja_generations select * from japanese_release.ja_generations;
          insert or ignore into ja_entries select * from japanese_release.ja_entries;
          insert or ignore into ja_forms select * from japanese_release.ja_forms;
          insert or ignore into ja_lookup_terms select * from japanese_release.ja_lookup_terms;
          insert or ignore into ja_senses select * from japanese_release.ja_senses;
          insert or ignore into ja_glosses select * from japanese_release.ja_glosses;
          insert or ignore into ja_examples select * from japanese_release.ja_examples;
          -- A retained group only returns to an entry the release still
          -- provides, and never displaces content the release itself explains
          -- in that language.
          insert or ignore into ja_senses
            select retained.* from retained_ja_senses retained
            join ja_entries entry on entry.id = retained.entry_id
            where not exists (
              select 1 from ja_senses existing
               where existing.entry_id = retained.entry_id and existing.lang = retained.lang
            );
          insert or ignore into ja_glosses
            select retained.* from retained_ja_glosses retained
            join ja_senses sense on sense.id = retained.sense_id;
          insert or ignore into ja_examples
            select retained.* from retained_ja_examples retained
            join ja_senses sense on sense.id = retained.sense_id;
          drop table promoted_ja_entries;
          drop table retained_ja_senses;
          drop table retained_ja_glosses;
          drop table retained_ja_examples;
        `);
      }).immediate();
      const installedVersion = production.query<{ value: string }, []>(
        "select value from ja_metadata where key = 'dictDate'"
      ).get()?.value;
      if (installedVersion !== incomingVersion) {
        throw new Error(
          `Japanese release graft did not install ${incomingVersion}: found ${installedVersion ?? "no version"}`
        );
      }
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

/**
 * Removes imported German senses from a store that was bootstrapped before the
 * `ger` mapping was dropped.
 *
 * JMdict's German component is compiled by WaDokuJT and is carved out of
 * EDRDG's licence, so Yori Dict has no grant to serve or redistribute it.
 * Dropping the mapping stopped it entering new builds, but a volume that
 * already holds it never re-bootstraps: `ensureJapaneseProductionDatabase`
 * returns early once a Japanese dictionary is present. Without this the rows
 * stay served indefinitely.
 *
 * Only imported senses go. Authored German is Yori's own CC BY-SA content and
 * is exactly what Enrich-on-Lookup is expected to write, so `generated` rows
 * are left alone. Returns the number of senses removed, and is a no-op on a
 * store with no Japanese dictionary or no German left.
 */
export function removeImportedGerman(path: string): number {
  if (!hasJapaneseDictionary(path)) return 0;
  const db = new Database(path);
  try {
    db.exec("pragma busy_timeout = 5000;");
    const imported = `select id from ja_senses
      where lang = 'de'
        and provenance = 'source'
        and source_name = 'jmdict'
        and generation_id is null`;
    const count = db.query<{ count: number }, []>(
      `select count(*) as count from (${imported})`
    ).get()?.count ?? 0;
    if (count === 0) return 0;
    // Subqueries rather than bound ids: the store this exists for holds about
    // 165,000 German senses, far past SQLite's variable limit.
    db.transaction(() => {
      db.exec(`
        delete from ja_examples where sense_id in (${imported});
        delete from ja_glosses where sense_id in (${imported});
        delete from ja_senses where id in (${imported});
      `);
    })();
    return count;
  } finally {
    db.close();
  }
}

/**
 * Clears a volume written before the `ja_*` rebuild so this start can bootstrap
 * from the pinned release.
 *
 * Its dictionary content is reproducible from the pinned sources, so the store
 * is replaced rather than migrated — the spec keeps a migration framework out
 * of scope. Accepted enrichment is the one thing that is not reproducible, so a
 * store holding any is refused instead of destroyed.
 */
export function clearReplaceableLegacyStore(path: string): void {
  const accepted = Object.entries(countLegacyAcceptedContent(path)).filter(([, count]) => count > 0);
  if (accepted.length > 0) {
    throw new Error(
      `${path} predates the ja-2 canonical schema and holds accepted content a replacement ` +
        `would destroy (${accepted.map(([name, count]) => `${count} ${name}`).join(", ")}). ` +
        "Export it from a copy of this database, then remove the file so this start can " +
        "bootstrap from the pinned release."
    );
  }
  for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
}

/**
 * Accepted content in a pre-ja-2 store that a replacement could not rebuild
 * from the pinned sources. It lived in four places, none of which survive the
 * ja-2 migration: authored Japanese entries, generated examples on imported
 * Japanese senses, authored English entries, and generated English examples.
 * A table that never existed contributes nothing.
 */
function countLegacyAcceptedContent(path: string): Record<string, number> {
  const db = new Database(path, { readonly: true });
  const count = (sql: string): number => {
    try {
      return db.query<{ count: number }, []>(sql).get()?.count ?? 0;
    } catch {
      return 0;
    }
  };
  try {
    return {
      "Japanese entries": count("select count(*) as count from japanese_generated_records"),
      "Japanese examples": count("select count(*) as count from examples where source = 'generated'"),
      // Every other English entry was written by enrichment, and the old
      // english_examples table had no writer but the enrichment repository.
      "English entries": count(`
        select count(*) as count from english_entries
         where id not in (select entry_id from english_imported_entries)
      `),
      "English examples": count("select count(*) as count from english_examples")
    };
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
