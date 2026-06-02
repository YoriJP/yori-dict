import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'

export const PROJECT_ROOT_ENV_VAR = 'YORI_PROJECT_ROOT'
export const RELEASE_SCHEMA_VERSION = '1.0.0'
export const RELEASES_DIR = './releases'
export const CURRENT_RELEASE_PATH = join(RELEASES_DIR, 'current.json')
export const DEFAULT_UPDATES_DB_PATH = './updates.sqlite'
export const LEGACY_DB_PATH = process.env.DATABASE_PATH || './dict.sqlite'

export type UpdateSourceType = 'source' | 'ai'
export type UpdateStatus = 'active' | 'superseded' | 'promoted'
export type ReviewStatus = 'not_required' | 'pending' | 'approved' | 'rejected'
export type UpdateBatchStatus = 'running' | 'succeeded' | 'failed'

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

interface TableInfoRow {
  name: string
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

export function resolveProjectPath(relativePath: string): string {
  const projectRoot = process.env[PROJECT_ROOT_ENV_VAR]?.trim()
  return projectRoot ? join(projectRoot, relativePath) : `./${relativePath}`
}

export function getReleasesDir(): string {
  return resolveProjectPath('releases')
}

export function getCurrentReleasePath(): string {
  return join(getReleasesDir(), 'current.json')
}

export function getLegacyDbPath(): string {
  return process.env.DATABASE_PATH || resolveProjectPath('dict.sqlite')
}

export function getUpdatesDbPath(): string {
  return process.env.UPDATES_DATABASE_PATH || resolveProjectPath('updates.sqlite')
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
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'succeeded',
      completed_at TEXT,
      error_message TEXT,
      actor TEXT
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
      review_status TEXT NOT NULL DEFAULT 'not_required',
      reviewed_at TEXT,
      reviewed_by TEXT,
      review_notes TEXT,
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
      review_status TEXT NOT NULL DEFAULT 'not_required',
      reviewed_at TEXT,
      reviewed_by TEXT,
      review_notes TEXT,
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

    CREATE TABLE IF NOT EXISTS admin_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS admin_refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      user_agent TEXT,
      ip TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_admin_refresh_tokens_user
      ON admin_refresh_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_admin_refresh_tokens_hash
      ON admin_refresh_tokens(token_hash);
  `)

  ensureUpdatesSchemaCompatibility(db)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_translation_updates_review_lookup
      ON translation_updates(status, source_type, review_status, created_at);

    CREATE INDEX IF NOT EXISTS idx_example_update_sets_review_lookup
      ON example_update_sets(status, source_type, review_status, created_at);

    CREATE INDEX IF NOT EXISTS idx_update_batches_status
      ON update_batches(status, created_at);

    CREATE INDEX IF NOT EXISTS idx_admin_actions_created_at
      ON admin_actions(created_at);
  `)
}

function hasColumn(db: Database, tableName: string, columnName: string): boolean {
  const rows = db.query<TableInfoRow, []>(`PRAGMA table_info(${tableName})`).all()
  return rows.some((row) => row.name === columnName)
}

function ensureColumn(db: Database, tableName: string, columnName: string, definition: string): void {
  if (!hasColumn(db, tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
  }
}

function ensureUpdatesSchemaCompatibility(db: Database): void {
  ensureColumn(db, 'update_batches', 'status', `TEXT NOT NULL DEFAULT 'succeeded'`)
  ensureColumn(db, 'update_batches', 'completed_at', 'TEXT')
  ensureColumn(db, 'update_batches', 'error_message', 'TEXT')
  ensureColumn(db, 'update_batches', 'actor', 'TEXT')

  ensureColumn(db, 'translation_updates', 'review_status', `TEXT NOT NULL DEFAULT 'not_required'`)
  ensureColumn(db, 'translation_updates', 'reviewed_at', 'TEXT')
  ensureColumn(db, 'translation_updates', 'reviewed_by', 'TEXT')
  ensureColumn(db, 'translation_updates', 'review_notes', 'TEXT')

  ensureColumn(db, 'example_update_sets', 'review_status', `TEXT NOT NULL DEFAULT 'not_required'`)
  ensureColumn(db, 'example_update_sets', 'reviewed_at', 'TEXT')
  ensureColumn(db, 'example_update_sets', 'reviewed_by', 'TEXT')
  ensureColumn(db, 'example_update_sets', 'review_notes', 'TEXT')

  db.exec(`
    UPDATE translation_updates
    SET review_status = CASE
      WHEN source_type = 'ai' THEN 'approved'
      ELSE 'not_required'
    END
    WHERE review_status IS NULL OR review_status = ''
  `)

  db.exec(`
    UPDATE example_update_sets
    SET review_status = CASE
      WHEN source_type = 'ai' THEN 'approved'
      ELSE 'not_required'
    END
    WHERE review_status IS NULL OR review_status = ''
  `)

  db.exec(`
    UPDATE update_batches
    SET status = 'succeeded'
    WHERE status IS NULL OR status = ''
  `)

  db.exec(`
    UPDATE update_batches
    SET completed_at = created_at
    WHERE completed_at IS NULL AND status = 'succeeded'
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
  const resolvedFiles = [...filePaths].map((filePath) => resolve(filePath)).sort()
  const commonBase = resolvedFiles.reduce<string | null>((current, filePath) => {
    const parts = dirname(filePath).split(sep).filter(Boolean)
    if (current === null) return parts.join(sep)

    const currentParts = current.split(sep).filter(Boolean)
    const limit = Math.min(currentParts.length, parts.length)
    let index = 0
    while (index < limit && currentParts[index] === parts[index]) index++
    return currentParts.slice(0, index).join(sep)
  }, null)

  for (const filePath of resolvedFiles) {
    const stablePath = relative(commonBase ? resolve(sep, commonBase) : dirname(filePath), filePath)
      .split(sep)
      .join('/')
    hash.update(stablePath)
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
  return join(getReleasesDir(), version, 'dict.sqlite')
}

export function getReleaseManifestPath(version: string): string {
  return join(getReleasesDir(), version, 'manifest.json')
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
  const currentReleasePath = getCurrentReleasePath()
  ensureParentDir(currentReleasePath)
  writeFileSync(currentReleasePath, JSON.stringify(pointer, null, 2))
}

export function readCurrentReleasePointer(): CurrentReleasePointer | null {
  const currentReleasePath = getCurrentReleasePath()
  if (!existsSync(currentReleasePath)) return null
  return JSON.parse(readFileSync(currentReleasePath, 'utf8')) as CurrentReleasePointer
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

  const legacyDbPath = getLegacyDbPath()
  if (existsSync(legacyDbPath)) {
    return {
      version: 'legacy',
      dbPath: legacyDbPath,
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
