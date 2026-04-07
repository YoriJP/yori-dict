import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'

export const RELEASE_SCHEMA_VERSION = '1.0.0'
export const RELEASES_DIR = './releases'
export const CURRENT_RELEASE_PATH = join(RELEASES_DIR, 'current.json')
export const DEFAULT_UPDATES_DB_PATH = './updates.sqlite'
export const LEGACY_DB_PATH = process.env.DATABASE_PATH || './dict.sqlite'

export type UpdateSourceType = 'source' | 'ai'
export type UpdateStatus = 'active' | 'superseded' | 'promoted'

export interface ReleaseManifest {
  version: string
  builtAt: string
  schemaVersion: string
  baseSourceFingerprint: string
  releaseDbPath: string
  promotedFromUpdateSequence: number | null
}

export interface CurrentReleasePointer {
  version: string
  dbPath: string
  manifestPath: string
  activatedAt: string
}

export interface ActiveReleaseConfig {
  version: string
  dbPath: string
  manifestPath: string | null
  mode: 'managed' | 'env' | 'legacy'
}

export interface ReleaseWordRecord {
  id: string
  word: string
  reading: string
  partOfSpeech: string[]
  common: boolean
  jlpt: number[]
  frequency: number | null
}

export interface ReleaseTranslationRecord {
  wordId: string
  lang: string
  definitions: string[]
  sources: string[]
}

export interface ReleaseExampleRecord {
  wordId: string
  lang: string
  japanese: string
  translation: string
  source: string
}

export interface ReleaseSnapshot {
  words: Map<string, ReleaseWordRecord>
  translations: Map<string, ReleaseTranslationRecord>
  examples: Map<string, ReleaseExampleRecord[]>
}

export function makeTranslationKey(wordId: string, lang: string): string {
  return `${wordId}\u0000${lang}`
}

export function createEmptySnapshot(): ReleaseSnapshot {
  return {
    words: new Map(),
    translations: new Map(),
    examples: new Map(),
  }
}

export function getUpdatesDbPath(): string {
  return process.env.UPDATES_DATABASE_PATH || DEFAULT_UPDATES_DB_PATH
}

export function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
}

export function removeSqliteWithSidecars(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const target = path + suffix
    if (existsSync(target)) unlinkSync(target)
  }
}

export function createReleaseSchema(db: Database): void {
  db.exec(`
    CREATE TABLE words (
      id TEXT PRIMARY KEY,
      word TEXT NOT NULL,
      reading TEXT NOT NULL,
      part_of_speech TEXT NOT NULL,
      common INTEGER DEFAULT 0,
      jlpt TEXT,
      frequency INTEGER
    );

    CREATE TABLE translations (
      word_id TEXT NOT NULL,
      lang TEXT NOT NULL,
      definitions TEXT NOT NULL,
      sources TEXT NOT NULL,
      PRIMARY KEY (word_id, lang),
      FOREIGN KEY (word_id) REFERENCES words(id)
    );

    CREATE TABLE examples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word_id TEXT NOT NULL,
      lang TEXT NOT NULL,
      japanese TEXT NOT NULL,
      translation TEXT NOT NULL,
      source TEXT NOT NULL,
      FOREIGN KEY (word_id) REFERENCES words(id)
    );

    CREATE INDEX idx_words_word ON words(word);
    CREATE INDEX idx_words_reading ON words(reading);
    CREATE INDEX idx_words_common ON words(common);
    CREATE INDEX idx_translations_lang ON translations(lang);
    CREATE INDEX idx_examples_word_id ON examples(word_id);
    CREATE INDEX idx_examples_lang ON examples(lang);
  `)
}

export function createUpdatesSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS update_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      input_manifest_json TEXT NOT NULL,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS translation_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word_id TEXT NOT NULL,
      lang TEXT NOT NULL,
      definitions_json TEXT NOT NULL,
      sources_json TEXT NOT NULL,
      source_type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      batch_id INTEGER NOT NULL,
      supersedes_update_id INTEGER,
      FOREIGN KEY (batch_id) REFERENCES update_batches(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_translation_updates_active_unique
      ON translation_updates(word_id, lang)
      WHERE status = 'active';

    CREATE INDEX IF NOT EXISTS idx_translation_updates_lookup
      ON translation_updates(word_id, lang, status, source_type, created_at);

    CREATE TABLE IF NOT EXISTS example_update_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word_id TEXT NOT NULL,
      lang TEXT NOT NULL,
      source_type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      batch_id INTEGER NOT NULL,
      supersedes_set_id INTEGER,
      FOREIGN KEY (batch_id) REFERENCES update_batches(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_example_update_sets_active_unique
      ON example_update_sets(word_id, lang)
      WHERE status = 'active';

    CREATE INDEX IF NOT EXISTS idx_example_update_sets_lookup
      ON example_update_sets(word_id, lang, status, source_type, created_at);

    CREATE TABLE IF NOT EXISTS example_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      set_id INTEGER NOT NULL,
      word_id TEXT NOT NULL,
      lang TEXT NOT NULL,
      japanese TEXT NOT NULL,
      translation TEXT NOT NULL,
      source TEXT NOT NULL,
      source_type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      batch_id INTEGER NOT NULL,
      FOREIGN KEY (set_id) REFERENCES example_update_sets(id),
      FOREIGN KEY (batch_id) REFERENCES update_batches(id)
    );

    CREATE INDEX IF NOT EXISTS idx_example_updates_lookup
      ON example_updates(word_id, lang, status, set_id);
  `)
}

export function initUpdatesDatabase(path = getUpdatesDbPath()): Database {
  ensureParentDir(path)
  const db = new Database(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  createUpdatesSchema(db)
  return db
}

export function computeFingerprintForFiles(filePaths: string[]): string {
  const hash = createHash('sha256')
  for (const filePath of [...filePaths].sort()) {
    hash.update(resolve(filePath))
    hash.update(readFileSync(filePath))
  }
  return hash.digest('hex')
}

export function buildReleaseVersion(now = new Date(), fingerprint?: string): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const timestamp = [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
  ].join('') + '-' + [
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join('')

  return fingerprint ? `${timestamp}-${fingerprint.slice(0, 8)}` : timestamp
}

export function getReleaseDbPath(version: string): string {
  return join(RELEASES_DIR, version, 'dict.sqlite')
}

export function getReleaseManifestPath(version: string): string {
  return join(RELEASES_DIR, version, 'manifest.json')
}

export function writeReleaseManifest(version: string, manifest: ReleaseManifest): string {
  const path = getReleaseManifestPath(version)
  ensureParentDir(path)
  writeFileSync(path, JSON.stringify(manifest, null, 2))
  return path
}

export function readReleaseManifest(path: string): ReleaseManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as ReleaseManifest
}

export function writeCurrentReleasePointer(pointer: CurrentReleasePointer): void {
  ensureParentDir(CURRENT_RELEASE_PATH)
  writeFileSync(CURRENT_RELEASE_PATH, JSON.stringify(pointer, null, 2))
}

export function readCurrentReleasePointer(): CurrentReleasePointer | null {
  if (!existsSync(CURRENT_RELEASE_PATH)) return null
  return JSON.parse(readFileSync(CURRENT_RELEASE_PATH, 'utf8')) as CurrentReleasePointer
}

export function resolveActiveReleaseConfig(): ActiveReleaseConfig | null {
  const explicitPath = process.env.RELEASE_DB_PATH
  if (explicitPath) {
    return {
      version: process.env.RELEASE_VERSION || 'env',
      dbPath: explicitPath,
      manifestPath: process.env.RELEASE_MANIFEST_PATH || null,
      mode: 'env',
    }
  }

  const pointer = readCurrentReleasePointer()
  if (pointer && existsSync(pointer.dbPath)) {
    return {
      version: pointer.version,
      dbPath: pointer.dbPath,
      manifestPath: pointer.manifestPath,
      mode: 'managed',
    }
  }

  if (existsSync(LEGACY_DB_PATH)) {
    return {
      version: 'legacy',
      dbPath: LEGACY_DB_PATH,
      manifestPath: null,
      mode: 'legacy',
    }
  }

  return null
}

export function requireActiveReleaseConfig(): ActiveReleaseConfig {
  const config = resolveActiveReleaseConfig()
  if (!config) {
    throw new Error(
      'No active release database found. Run "bun run build:db" or set RELEASE_DB_PATH.'
    )
  }
  return config
}

