/**
 * Build SQLite from JSON - Builds dict.sqlite from per-language JSON files
 *
 * Usage: bun run build:db
 *
 * Reads:
 * - data/{lang}.json - Per-language dictionary files
 *
 * Outputs:
 * - dict.sqlite
 */

import { Database } from 'bun:sqlite'
import { existsSync, unlinkSync, readdirSync } from 'fs'
import type { DictFile, DictEntry } from './import/base'

const DATA_DIR = './data'
const DB_PATH = process.env.DATABASE_PATH || './dict.sqlite'

// ============================================================================
// Database Schema
// ============================================================================

function initDb(): Database {
  // Remove existing database
  if (existsSync(DB_PATH)) {
    console.log(`Removing existing database: ${DB_PATH}`)
    unlinkSync(DB_PATH)
  }

  const db = new Database(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  db.exec(`
    -- Core word data (shared across languages)
    CREATE TABLE words (
      id TEXT PRIMARY KEY,
      word TEXT NOT NULL,
      reading TEXT NOT NULL,
      part_of_speech TEXT NOT NULL,
      common INTEGER DEFAULT 0,
      jlpt TEXT
    );

    -- Translations per language
    CREATE TABLE translations (
      word_id TEXT NOT NULL,
      lang TEXT NOT NULL,
      definitions TEXT NOT NULL,
      sources TEXT NOT NULL,
      PRIMARY KEY (word_id, lang),
      FOREIGN KEY (word_id) REFERENCES words(id)
    );

    -- Examples per language
    CREATE TABLE examples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word_id TEXT NOT NULL,
      lang TEXT NOT NULL,
      japanese TEXT NOT NULL,
      translation TEXT NOT NULL,
      source TEXT NOT NULL,
      FOREIGN KEY (word_id) REFERENCES words(id)
    );

    -- Indexes for fast lookups
    CREATE INDEX idx_words_word ON words(word);
    CREATE INDEX idx_words_reading ON words(reading);
    CREATE INDEX idx_words_common ON words(common);
    CREATE INDEX idx_translations_lang ON translations(lang);
    CREATE INDEX idx_examples_word_id ON examples(word_id);
    CREATE INDEX idx_examples_lang ON examples(lang);
  `)

  return db
}

// ============================================================================
// Data Types
// ============================================================================

interface WordData {
  word: string
  reading: string
  partOfSpeech: string[]
  common: boolean
  jlpt: number[]
}

interface TranslationData {
  wordId: string
  lang: string
  definitions: string[]
  sources: string[]
}

interface ExampleData {
  wordId: string
  lang: string
  japanese: string
  translation: string
  source: string
}

// ============================================================================
// Pass 1: Collect Data from JSON Files
// ============================================================================

function collectData(
  dict: DictFile,
  wordsMap: Map<string, WordData>,
  translations: TranslationData[],
  examples: ExampleData[]
): void {
  const lang = dict.lang
  console.log(`Collecting ${lang}... (${Object.keys(dict.entries).length.toLocaleString()} entries)`)

  let count = 0
  for (const [key, entry] of Object.entries(dict.entries)) {
    // Update words map (merge data from all languages)
    const existing = wordsMap.get(key)
    if (existing) {
      // Merge POS
      for (const pos of entry.partOfSpeech) {
        if (!existing.partOfSpeech.includes(pos)) {
          existing.partOfSpeech.push(pos)
        }
      }
      // Merge common flag
      existing.common = existing.common || entry.common
      // Merge JLPT levels
      for (const level of entry.jlpt) {
        if (!existing.jlpt.includes(level)) {
          existing.jlpt.push(level)
        }
      }
    } else {
      wordsMap.set(key, {
        word: entry.word,
        reading: entry.reading,
        partOfSpeech: [...entry.partOfSpeech],
        common: entry.common,
        jlpt: [...entry.jlpt],
      })
    }

    // Collect translation
    if (entry.definitions.length > 0) {
      const defs = entry.definitions.map((d) => d.text)
      const sources = [...new Set(entry.definitions.flatMap((d) => d.sources))]

      translations.push({
        wordId: key,
        lang,
        definitions: defs,
        sources,
      })
    }

    // Collect examples
    for (const example of entry.examples) {
      examples.push({
        wordId: key,
        lang,
        japanese: example.ja,
        translation: example.text,
        source: example.source,
      })
    }

    count++
    if (count % 50000 === 0) {
      process.stdout.write(`\r  Collected ${count.toLocaleString()}...`)
    }
  }
  console.log(`\r  Collected ${count.toLocaleString()} entries`)
}

// ============================================================================
// Pass 2: Insert Words
// ============================================================================

function insertWords(db: Database, wordsMap: Map<string, WordData>): number {
  console.log(`\nInserting ${wordsMap.size.toLocaleString()} words...`)

  const insertWord = db.prepare(`
    INSERT INTO words (id, word, reading, part_of_speech, common, jlpt)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  const BATCH_SIZE = 5000
  const entries = Array.from(wordsMap.entries())

  const processBatch = db.transaction((batch: [string, WordData][]) => {
    for (const [key, data] of batch) {
      insertWord.run(
        key,
        data.word,
        data.reading,
        JSON.stringify(data.partOfSpeech),
        data.common ? 1 : 0,
        data.jlpt.length > 0 ? JSON.stringify(data.jlpt.sort((a, b) => b - a)) : null
      )
    }
  })

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    processBatch(entries.slice(i, i + BATCH_SIZE))
    process.stdout.write(
      `\r  Processed ${Math.min(i + BATCH_SIZE, entries.length).toLocaleString()}/${entries.length.toLocaleString()}`
    )
  }
  console.log('')

  return wordsMap.size
}

// ============================================================================
// Pass 3: Insert Translations and Examples
// ============================================================================

function insertTranslations(db: Database, translations: TranslationData[]): number {
  console.log(`\nInserting ${translations.length.toLocaleString()} translations...`)

  const insertTranslation = db.prepare(`
    INSERT OR REPLACE INTO translations (word_id, lang, definitions, sources)
    VALUES (?, ?, ?, ?)
  `)

  const BATCH_SIZE = 5000

  const processBatch = db.transaction((batch: TranslationData[]) => {
    for (const t of batch) {
      insertTranslation.run(t.wordId, t.lang, JSON.stringify(t.definitions), JSON.stringify(t.sources))
    }
  })

  for (let i = 0; i < translations.length; i += BATCH_SIZE) {
    processBatch(translations.slice(i, i + BATCH_SIZE))
    process.stdout.write(
      `\r  Processed ${Math.min(i + BATCH_SIZE, translations.length).toLocaleString()}/${translations.length.toLocaleString()}`
    )
  }
  console.log('')

  return translations.length
}

function insertExamples(db: Database, examples: ExampleData[]): number {
  if (examples.length === 0) return 0

  console.log(`\nInserting ${examples.length.toLocaleString()} examples...`)

  const insertExample = db.prepare(`
    INSERT INTO examples (word_id, lang, japanese, translation, source)
    VALUES (?, ?, ?, ?, ?)
  `)

  const BATCH_SIZE = 5000

  const processBatch = db.transaction((batch: ExampleData[]) => {
    for (const e of batch) {
      insertExample.run(e.wordId, e.lang, e.japanese, e.translation, e.source)
    }
  })

  for (let i = 0; i < examples.length; i += BATCH_SIZE) {
    processBatch(examples.slice(i, i + BATCH_SIZE))
    process.stdout.write(
      `\r  Processed ${Math.min(i + BATCH_SIZE, examples.length).toLocaleString()}/${examples.length.toLocaleString()}`
    )
  }
  console.log('')

  return examples.length
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('=== Build SQLite from JSON ===\n')

  // Find all language files
  const langFiles = readdirSync(DATA_DIR).filter(
    (f) => f.endsWith('.json') && !f.includes('/')
  )

  if (langFiles.length === 0) {
    console.error('No language files found in data/')
    console.error('Run "bun run import:jmdict --lang en" first.')
    process.exit(1)
  }

  const languages = langFiles.map((f) => f.replace('.json', ''))
  console.log(`Found languages: ${languages.join(', ')}`)

  // Initialize database
  const db = initDb()

  // Shared data structures
  const wordsMap = new Map<string, WordData>()
  const allTranslations: TranslationData[] = []
  const allExamples: ExampleData[] = []

  // Pass 1: Load all JSON files and collect data
  console.log('\n--- Pass 1: Collecting data from JSON files ---\n')
  for (const lang of languages) {
    const filePath = `${DATA_DIR}/${lang}.json`
    console.log(`Loading ${filePath}...`)

    const dict: DictFile = await Bun.file(filePath).json()
    console.log(`  Version: ${dict.version}, Updated: ${dict.updatedAt}`)

    collectData(dict, wordsMap, allTranslations, allExamples)
  }

  // Pass 2: Insert words first (required for foreign key constraints)
  console.log('\n--- Pass 2: Inserting words ---')
  const wordCount = insertWords(db, wordsMap)

  // Pass 3: Insert translations and examples
  console.log('\n--- Pass 3: Inserting translations and examples ---')
  insertTranslations(db, allTranslations)
  insertExamples(db, allExamples)

  // Print statistics
  console.log('\n=== Build Complete ===')
  console.log(`\nDatabase: ${DB_PATH}`)
  console.log(`Total words: ${wordCount.toLocaleString()}`)

  // Count translations per language
  const langCounts = new Map<string, { translations: number; examples: number }>()
  for (const t of allTranslations) {
    const existing = langCounts.get(t.lang) || { translations: 0, examples: 0 }
    existing.translations++
    langCounts.set(t.lang, existing)
  }
  for (const e of allExamples) {
    const existing = langCounts.get(e.lang) || { translations: 0, examples: 0 }
    existing.examples++
    langCounts.set(e.lang, existing)
  }

  console.log('\nPer language:')
  for (const [lang, counts] of langCounts) {
    const coverage = ((counts.translations / wordCount) * 100).toFixed(1)
    console.log(`  ${lang}: ${counts.translations.toLocaleString()} translations (${coverage}%)`)
    if (counts.examples > 0) {
      console.log(`      ${counts.examples.toLocaleString()} examples`)
    }
  }

  // File size
  db.close()
  const dbSize = (await Bun.file(DB_PATH).arrayBuffer()).byteLength
  console.log(`\nDatabase size: ${(dbSize / 1024 / 1024).toFixed(2)} MB`)
}

main().catch((err) => {
  console.error('Build failed:', err)
  process.exit(1)
})
