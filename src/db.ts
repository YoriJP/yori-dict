import { Database } from 'bun:sqlite'
import { toRomaji } from 'wanakana'
import { conjugate } from './conjugator'
import type { Language, LookupResponse, WordRow, TranslationRow, ExampleRow } from './types'

// Database path
const DB_PATH = process.env.DATABASE_PATH || './dict.sqlite'

// Lazy-loaded database instance
let db: Database | null = null

/**
 * Get database connection (creates if not exists)
 */
export function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
  }
  return db
}

/**
 * Initialize database schema
 */
export function initSchema(): void {
  const db = getDb()

  db.exec(`
    -- Core word data
    CREATE TABLE IF NOT EXISTS words (
      id TEXT PRIMARY KEY,
      word TEXT NOT NULL,
      reading TEXT NOT NULL,
      part_of_speech TEXT NOT NULL,
      common INTEGER DEFAULT 0,
      jlpt INTEGER
    );

    -- Translations per language
    CREATE TABLE IF NOT EXISTS translations (
      word_id TEXT NOT NULL,
      lang TEXT NOT NULL,
      definitions TEXT NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (word_id, lang),
      FOREIGN KEY (word_id) REFERENCES words(id)
    );

    -- Examples per language
    CREATE TABLE IF NOT EXISTS examples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word_id TEXT NOT NULL,
      lang TEXT NOT NULL,
      japanese TEXT NOT NULL,
      translation TEXT NOT NULL,
      source TEXT NOT NULL,
      FOREIGN KEY (word_id) REFERENCES words(id)
    );

    -- Indexes for fast lookups
    CREATE INDEX IF NOT EXISTS idx_words_word ON words(word);
    CREATE INDEX IF NOT EXISTS idx_words_reading ON words(reading);
    CREATE INDEX IF NOT EXISTS idx_words_common ON words(common);
    CREATE INDEX IF NOT EXISTS idx_translations_lang ON translations(lang);
    CREATE INDEX IF NOT EXISTS idx_examples_word_id ON examples(word_id);
    CREATE INDEX IF NOT EXISTS idx_examples_lang ON examples(lang);
  `)
}

/**
 * Lookup a word and return full response
 */
export function lookupWord(word: string, lang: Language): LookupResponse | null {
  const db = getDb()

  // Query word by exact match on word or reading
  const wordQuery = db.query<WordRow, [string]>(`
    SELECT * FROM words 
    WHERE word = ?1 OR reading = ?1
    ORDER BY common DESC, jlpt ASC
    LIMIT 1
  `)

  const wordRow = wordQuery.get(word)

  if (!wordRow) {
    return null
  }

  // Get translation for the requested language
  const translationQuery = db.query<TranslationRow, [string, string]>(`
    SELECT * FROM translations
    WHERE word_id = ? AND lang = ?
  `)

  const translationRow = translationQuery.get(wordRow.id, lang)

  if (!translationRow) {
    // No translation available for this language
    return null
  }

  // Get examples for this word and language
  const examplesQuery = db.query<ExampleRow, [string, string]>(`
    SELECT * FROM examples
    WHERE word_id = ? AND lang = ?
  `)

  const exampleRows = examplesQuery.all(wordRow.id, lang)

  // Parse JSON fields
  const partOfSpeech: string[] = JSON.parse(wordRow.part_of_speech)
  const definitions: string[] = JSON.parse(translationRow.definitions)

  // Generate romaji from reading
  const romaji = toRomaji(wordRow.reading)

  // Generate conjugations if applicable
  const conjugations = conjugate(wordRow.word, wordRow.reading, partOfSpeech)

  // Build response
  const response: LookupResponse = {
    word: wordRow.word,
    reading: wordRow.reading,
    romaji,
    partOfSpeech,
    definitions,
    examples: exampleRows.map((row) => ({
      japanese: row.japanese,
      translation: row.translation,
    })),
  }

  // Only include conjugations if available
  if (conjugations) {
    response.conjugations = conjugations
  }

  return response
}

/**
 * Close database connection
 */
export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
