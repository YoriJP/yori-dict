import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { dirname } from 'path'
import { validateCanonicalSnapshot } from '../../src/domain/validate'
import type {
  CanonicalSnapshot,
  Entry,
  Example,
  Form,
  Gloss,
  KanjiCharacter,
  LookupAlias,
  Reading,
  Sense,
  SourceRef,
} from '../../src/domain/types'

interface CliOptions {
  snapshot: string
  out: string
  overwrite: boolean
}

const DEFAULT_SNAPSHOT = 'data/snapshots/yori-dict.snapshot.json'
const DEFAULT_OUT = 'data/releases/canonical/yori-dict.sqlite'

function printHelp(): void {
  console.log(`
Canonical release builder

Builds a normalized SQLite release DB from a Yori canonical snapshot.

Usage:
  bun run release:build:canonical [options]

Options:
  --snapshot <path>  Canonical snapshot JSON (default: ${DEFAULT_SNAPSHOT})
  --out <path>       SQLite release output path (default: ${DEFAULT_OUT})
  --overwrite        Replace existing output DB.
  --help, -h         Show this help.
`)
}

export function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = {
    snapshot: DEFAULT_SNAPSHOT,
    out: DEFAULT_OUT,
    overwrite: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg === '--snapshot' && next) {
      opts.snapshot = next
      i++
    } else if (arg === '--out' && next) {
      opts.out = next
      i++
    } else if (arg === '--overwrite') {
      opts.overwrite = true
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`)
    }
  }

  return opts
}

function createSchema(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT NOT NULL UNIQUE,
      language TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      primary_form TEXT NOT NULL,
      primary_reading TEXT NOT NULL,
      ranking_json TEXT NOT NULL
    );

    CREATE TABLE forms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT NOT NULL UNIQUE,
      entry_public_id TEXT NOT NULL,
      text TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      script TEXT NOT NULL,
      is_primary INTEGER NOT NULL,
      tags_json TEXT NOT NULL,
      FOREIGN KEY (entry_public_id) REFERENCES entries(public_id) ON DELETE CASCADE
    );

    CREATE TABLE readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT NOT NULL UNIQUE,
      entry_public_id TEXT NOT NULL,
      text TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      system TEXT NOT NULL,
      is_primary INTEGER NOT NULL,
      applies_to_form_ids_json TEXT NOT NULL,
      pitch_accent_json TEXT,
      tags_json TEXT NOT NULL,
      FOREIGN KEY (entry_public_id) REFERENCES entries(public_id) ON DELETE CASCADE
    );

    CREATE TABLE senses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT NOT NULL UNIQUE,
      entry_public_id TEXT NOT NULL,
      sense_order INTEGER NOT NULL,
      part_of_speech_json TEXT NOT NULL,
      applies_to_form_ids_json TEXT NOT NULL,
      applies_to_reading_ids_json TEXT NOT NULL,
      domain_json TEXT NOT NULL,
      register_json TEXT NOT NULL,
      misc_json TEXT NOT NULL,
      FOREIGN KEY (entry_public_id) REFERENCES entries(public_id) ON DELETE CASCADE
    );

    CREATE TABLE glosses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT NOT NULL UNIQUE,
      sense_public_id TEXT NOT NULL,
      lang TEXT NOT NULL,
      text TEXT NOT NULL,
      source_type TEXT NOT NULL,
      review_status TEXT NOT NULL,
      FOREIGN KEY (sense_public_id) REFERENCES senses(public_id) ON DELETE CASCADE
    );

    CREATE TABLE examples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT NOT NULL UNIQUE,
      sense_public_id TEXT,
      entry_public_id TEXT NOT NULL,
      lang TEXT NOT NULL,
      japanese TEXT NOT NULL,
      translation TEXT NOT NULL,
      FOREIGN KEY (sense_public_id) REFERENCES senses(public_id) ON DELETE CASCADE,
      FOREIGN KEY (entry_public_id) REFERENCES entries(public_id) ON DELETE CASCADE
    );

    CREATE TABLE lookup_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT NOT NULL UNIQUE,
      surface TEXT NOT NULL,
      normalized_surface TEXT NOT NULL,
      reading TEXT,
      normalized_reading TEXT,
      entry_public_id TEXT NOT NULL,
      form_public_id TEXT,
      reading_public_id TEXT,
      alias_type TEXT NOT NULL,
      score REAL NOT NULL,
      FOREIGN KEY (entry_public_id) REFERENCES entries(public_id) ON DELETE CASCADE,
      FOREIGN KEY (form_public_id) REFERENCES forms(public_id) ON DELETE SET NULL,
      FOREIGN KEY (reading_public_id) REFERENCES readings(public_id) ON DELETE SET NULL
    );

    CREATE TABLE kanji_characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT NOT NULL UNIQUE,
      literal TEXT NOT NULL UNIQUE,
      stats_json TEXT NOT NULL
    );

    CREATE TABLE kanji_meanings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kanji_public_id TEXT NOT NULL,
      lang TEXT NOT NULL,
      text TEXT NOT NULL,
      FOREIGN KEY (kanji_public_id) REFERENCES kanji_characters(public_id) ON DELETE CASCADE
    );

    CREATE TABLE kanji_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kanji_public_id TEXT NOT NULL,
      reading_type TEXT NOT NULL,
      text TEXT NOT NULL,
      FOREIGN KEY (kanji_public_id) REFERENCES kanji_characters(public_id) ON DELETE CASCADE
    );

    CREATE TABLE source_refs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_type TEXT NOT NULL,
      owner_public_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT,
      license TEXT,
      imported_at TEXT NOT NULL,
      model TEXT,
      prompt_version TEXT,
      input_refs_json TEXT,
      review_status TEXT
    );

    CREATE INDEX idx_entries_primary_form ON entries(primary_form);
    CREATE INDEX idx_entries_primary_reading ON entries(primary_reading);
    CREATE INDEX idx_forms_entry ON forms(entry_public_id);
    CREATE INDEX idx_forms_normalized_text ON forms(normalized_text);
    CREATE INDEX idx_readings_entry ON readings(entry_public_id);
    CREATE INDEX idx_readings_normalized_text ON readings(normalized_text);
    CREATE INDEX idx_senses_entry ON senses(entry_public_id);
    CREATE INDEX idx_glosses_sense_lang ON glosses(sense_public_id, lang);
    CREATE INDEX idx_examples_entry_lang ON examples(entry_public_id, lang);
    CREATE INDEX idx_lookup_aliases_surface ON lookup_aliases(normalized_surface);
    CREATE INDEX idx_lookup_aliases_reading ON lookup_aliases(normalized_reading);
    CREATE INDEX idx_lookup_aliases_entry ON lookup_aliases(entry_public_id);
    CREATE INDEX idx_kanji_characters_literal ON kanji_characters(literal);
    CREATE INDEX idx_kanji_meanings_lookup ON kanji_meanings(kanji_public_id, lang);
    CREATE INDEX idx_kanji_readings_lookup ON kanji_readings(kanji_public_id, reading_type);
    CREATE INDEX idx_source_refs_owner ON source_refs(owner_type, owner_public_id);
  `)
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

function insertSourceRefs(
  db: Database,
  ownerType: string,
  ownerPublicId: string,
  sourceRefs: SourceRef[]
): void {
  const insert = db.query(`
    INSERT INTO source_refs (
      owner_type, owner_public_id, source_kind, source_id, license, imported_at,
      model, prompt_version, input_refs_json, review_status
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
  `)

  for (const sourceRef of sourceRefs) {
    insert.run(
      ownerType,
      ownerPublicId,
      sourceRef.kind,
      sourceRef.sourceId ?? null,
      sourceRef.license ?? null,
      sourceRef.importedAt,
      sourceRef.model ?? null,
      sourceRef.promptVersion ?? null,
      sourceRef.inputRefs ? json(sourceRef.inputRefs) : null,
      sourceRef.reviewStatus ?? null
    )
  }
}

function insertEntry(db: Database, entry: Entry): void {
  db.query(`
    INSERT INTO entries (
      public_id, language, entry_type, primary_form, primary_reading, ranking_json
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  `).run(
    entry.id,
    entry.language,
    entry.entryType,
    entry.primaryForm,
    entry.primaryReading,
    json(entry.ranking)
  )
  insertSourceRefs(db, 'entry', entry.id, entry.sourceRefs)
}

function insertForm(db: Database, entry: Entry, form: Form): void {
  db.query(`
    INSERT INTO forms (
      public_id, entry_public_id, text, normalized_text, script, is_primary, tags_json
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
  `).run(
    form.id,
    entry.id,
    form.text,
    form.normalizedText,
    form.script,
    form.isPrimary ? 1 : 0,
    json(form.tags)
  )
  insertSourceRefs(db, 'form', form.id, form.sourceRefs)
}

function insertReading(db: Database, entry: Entry, reading: Reading): void {
  db.query(`
    INSERT INTO readings (
      public_id, entry_public_id, text, normalized_text, system, is_primary,
      applies_to_form_ids_json, pitch_accent_json, tags_json
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
  `).run(
    reading.id,
    entry.id,
    reading.text,
    reading.normalizedText,
    reading.system,
    reading.isPrimary ? 1 : 0,
    json(reading.appliesToFormIds),
    reading.pitchAccent ? json(reading.pitchAccent) : null,
    json(reading.tags)
  )
  insertSourceRefs(db, 'reading', reading.id, reading.sourceRefs)
}

function insertSense(db: Database, entry: Entry, sense: Sense): void {
  db.query(`
    INSERT INTO senses (
      public_id, entry_public_id, sense_order, part_of_speech_json,
      applies_to_form_ids_json, applies_to_reading_ids_json, domain_json,
      register_json, misc_json
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
  `).run(
    sense.id,
    entry.id,
    sense.order,
    json(sense.partOfSpeech),
    json(sense.appliesToFormIds),
    json(sense.appliesToReadingIds),
    json(sense.domain),
    json(sense.register),
    json(sense.misc)
  )
  insertSourceRefs(db, 'sense', sense.id, sense.sourceRefs)
}

function insertGloss(db: Database, gloss: Gloss): void {
  db.query(`
    INSERT INTO glosses (
      public_id, sense_public_id, lang, text, source_type, review_status
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  `).run(
    gloss.id,
    gloss.senseId,
    gloss.lang,
    gloss.text,
    gloss.sourceType,
    gloss.reviewStatus
  )
  insertSourceRefs(db, 'gloss', gloss.id, gloss.sourceRefs)
}

function insertExample(db: Database, entry: Entry, example: Example): void {
  db.query(`
    INSERT INTO examples (
      public_id, sense_public_id, entry_public_id, lang, japanese, translation
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  `).run(
    example.id,
    example.senseId ?? null,
    entry.id,
    example.lang,
    example.japanese,
    example.translation
  )
  insertSourceRefs(db, 'example', example.id, example.sourceRefs)
}

function insertLookupAlias(db: Database, alias: LookupAlias): void {
  db.query(`
    INSERT INTO lookup_aliases (
      public_id, surface, normalized_surface, reading, normalized_reading,
      entry_public_id, form_public_id, reading_public_id, alias_type, score
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
  `).run(
    alias.id,
    alias.surface,
    alias.normalizedSurface,
    alias.reading ?? null,
    alias.normalizedReading ?? null,
    alias.entryId,
    alias.formId ?? null,
    alias.readingId ?? null,
    alias.aliasType,
    alias.score
  )
}

function insertKanjiCharacter(db: Database, kanji: KanjiCharacter): void {
  db.query(`
    INSERT INTO kanji_characters (public_id, literal, stats_json)
    VALUES (?1, ?2, ?3)
  `).run(kanji.id, kanji.literal, json(kanji.stats))
  insertSourceRefs(db, 'kanji', kanji.id, kanji.sourceRefs)

  const insertMeaning = db.query(`
    INSERT INTO kanji_meanings (kanji_public_id, lang, text)
    VALUES (?1, ?2, ?3)
  `)
  for (const meaning of kanji.meanings) {
    insertMeaning.run(kanji.id, meaning.lang, meaning.text)
    insertSourceRefs(db, 'kanji_meaning', `${kanji.id}:${meaning.lang}:${meaning.text}`, meaning.sourceRefs)
  }

  const insertReading = db.query(`
    INSERT INTO kanji_readings (kanji_public_id, reading_type, text)
    VALUES (?1, ?2, ?3)
  `)
  for (const reading of kanji.readings) {
    insertReading.run(kanji.id, reading.type, reading.text)
    insertSourceRefs(db, 'kanji_reading', `${kanji.id}:${reading.type}:${reading.text}`, reading.sourceRefs)
  }
}

function insertSnapshot(db: Database, snapshot: CanonicalSnapshot): void {
  const transaction = db.transaction(() => {
    db.query('INSERT INTO metadata (key, value) VALUES (?1, ?2)').run('schemaVersion', snapshot.schemaVersion)
    db.query('INSERT INTO metadata (key, value) VALUES (?1, ?2)').run('generatedAt', snapshot.generatedAt)

    for (const entry of snapshot.entries) {
      insertEntry(db, entry)
      for (const form of entry.forms) insertForm(db, entry, form)
      for (const reading of entry.readings) insertReading(db, entry, reading)
      for (const sense of entry.senses) {
        insertSense(db, entry, sense)
        for (const gloss of sense.glosses) insertGloss(db, gloss)
        for (const example of sense.examples) insertExample(db, entry, example)
      }
    }

    for (const alias of snapshot.lookupAliases) {
      insertLookupAlias(db, alias)
    }

    for (const kanji of snapshot.kanjiCharacters ?? []) {
      insertKanjiCharacter(db, kanji)
    }
  })

  transaction()
}

function assertForeignKeys(db: Database): void {
  const violations = db.query<{ table: string; rowid: number; parent: string; fkid: number }, []>('PRAGMA foreign_key_check').all()
  if (violations.length > 0) {
    throw new Error(`Foreign key validation failed with ${violations.length} violation(s)`)
  }
}

async function loadSnapshot(path: string): Promise<CanonicalSnapshot> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`Snapshot not found: ${path}`)
  return file.json() as Promise<CanonicalSnapshot>
}

export async function buildCanonicalRelease(opts: CliOptions): Promise<void> {
  if (existsSync(opts.out)) {
    if (!opts.overwrite) {
      throw new Error(`Output DB already exists: ${opts.out}. Use --overwrite to replace it.`)
    }
    rmSync(opts.out, { force: true })
    rmSync(`${opts.out}-shm`, { force: true })
    rmSync(`${opts.out}-wal`, { force: true })
  }

  const snapshot = await loadSnapshot(opts.snapshot)
  const validation = validateCanonicalSnapshot(snapshot)
  if (!validation.valid) {
    throw new Error(`Snapshot validation failed with ${validation.errors.length} error(s)`)
  }

  mkdirSync(dirname(opts.out), { recursive: true })
  const db = new Database(opts.out)
  try {
    createSchema(db)
    insertSnapshot(db, snapshot)
    assertForeignKeys(db)
    db.exec('PRAGMA optimize')
  } finally {
    db.close()
  }

  console.log('\n=== Canonical Release Build ===')
  console.log(`Snapshot: ${opts.snapshot}`)
  console.log(`Output DB: ${opts.out}`)
  console.log(`Entries: ${snapshot.entries.length.toLocaleString()}`)
  console.log(`Lookup aliases: ${snapshot.lookupAliases.length.toLocaleString()}`)
  console.log(`Kanji characters: ${(snapshot.kanjiCharacters ?? []).length.toLocaleString()}`)
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  await buildCanonicalRelease(opts)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
