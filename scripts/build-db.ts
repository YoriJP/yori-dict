/**
 * Build SQLite from JSON - Builds dict.sqlite from core.json + per-language JSON files
 *
 * Usage: bun run build:db
 *
 * Reads:
 * - data/core.json        - Language-agnostic: word, reading, POS, common, jlpt, frequency
 * - data/lang/*.json      - Per-language: definitions + examples
 *
 * Outputs:
 * - dict.sqlite
 */

import { Database } from 'bun:sqlite'
import { existsSync, unlinkSync, readdirSync } from 'fs'
import {
  loadCore,
  loadLang,
  loadDict,
  type CoreFile,
  type LangFile,
  type DictFile,
} from './import/base'

const DATA_DIR = './data'
const LANG_DIR = './data/lang'
const CORE_PATH = `${DATA_DIR}/core.json`
const DB_PATH = process.env.DATABASE_PATH || './dict.sqlite'
const LFS_POINTER_HEADER = 'version https://git-lfs.github.com/spec/v1'

// ============================================================================
// Database Schema
// ============================================================================

function initDb(): Database {
  // Remove existing database and WAL sidecar files
  for (const suffix of ['', '-wal', '-shm']) {
    const path = DB_PATH + suffix
    if (existsSync(path)) {
      if (suffix === '') console.log(`Removing existing database: ${DB_PATH}`)
      unlinkSync(path)
    }
  }

  const db = new Database(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  db.exec(`CREATE TABLE words (
    id TEXT PRIMARY KEY,
    word TEXT NOT NULL,
    reading TEXT NOT NULL,
    part_of_speech TEXT NOT NULL,
    common INTEGER DEFAULT 0,
    jlpt TEXT,
    frequency INTEGER
  )`)
  db.exec(`CREATE TABLE translations (
    word_id TEXT NOT NULL,
    lang TEXT NOT NULL,
    definitions TEXT NOT NULL,
    sources TEXT NOT NULL,
    PRIMARY KEY (word_id, lang),
    FOREIGN KEY (word_id) REFERENCES words(id)
  )`)
  db.exec(`CREATE TABLE examples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word_id TEXT NOT NULL,
    lang TEXT NOT NULL,
    japanese TEXT NOT NULL,
    translation TEXT NOT NULL,
    source TEXT NOT NULL,
    FOREIGN KEY (word_id) REFERENCES words(id)
  )`)
  db.exec('CREATE INDEX idx_words_word ON words(word)')
  db.exec('CREATE INDEX idx_words_reading ON words(reading)')
  db.exec('CREATE INDEX idx_words_common ON words(common)')
  db.exec('CREATE INDEX idx_translations_lang ON translations(lang)')
  db.exec('CREATE INDEX idx_examples_word_id ON examples(word_id)')
  db.exec('CREATE INDEX idx_examples_lang ON examples(lang)')

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
  frequency: number | null
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
// Pass 1: Collect Words from core.json
// ============================================================================

function collectCoreData(core: CoreFile, wordsMap: Map<string, WordData>): void {
  console.log(`Collecting core... (${Object.keys(core.entries).length.toLocaleString()} entries)`)

  let count = 0
  for (const [key, entry] of Object.entries(core.entries)) {
    // Build jlpt array from single jlpt value
    const jlptArr: number[] = entry.jlpt !== null ? [entry.jlpt] : []

    wordsMap.set(key, {
      word: entry.word,
      reading: entry.reading,
      partOfSpeech: entry.partOfSpeech,
      common: entry.common,
      jlpt: jlptArr,
      frequency: entry.frequency,
    })

    count++
    if (count % 100000 === 0) {
      process.stdout.write(`\r  Collected ${count.toLocaleString()}...`)
    }
  }
  console.log(`\r  Collected ${count.toLocaleString()} core entries`)
}

// ============================================================================
// Pass 2: Collect Translations + Examples from lang/*.json
// ============================================================================

function collectLangData(
  lang: LangFile,
  wordsMap: Map<string, WordData>,
  translations: TranslationData[],
  examples: ExampleData[]
): void {
  const langCode = lang.lang
  console.log(`Collecting ${langCode}... (${Object.keys(lang.entries).length.toLocaleString()} entries)`)

  let count = 0
  for (const [key, entry] of Object.entries(lang.entries)) {
    // Skip if word not in core (orphaned lang entry)
    if (!wordsMap.has(key)) continue

    // Collect translation
    if (entry.definitions.length > 0) {
      // Collect all sources from _defSources (union)
      const sourcesSet = new Set<string>()
      for (const sources of Object.values(entry._defSources)) {
        for (const s of sources) sourcesSet.add(s)
      }

      translations.push({
        wordId: key,
        lang: langCode,
        definitions: entry.definitions,
        sources: Array.from(sourcesSet),
      })
    }

    // Collect examples
    const seenExamples = new Set<string>()
    for (const example of entry.examples) {
      const exKey = `${example.ja}\u0000${example.text}\u0000${example.source}`
      if (seenExamples.has(exKey)) continue
      seenExamples.add(exKey)
      examples.push({
        wordId: key,
        lang: langCode,
        japanese: example.ja,
        translation: example.text,
        source: example.source || 'unknown',
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
// Legacy Mode: Collect from data/{lang}.json (v1 schema)
// ============================================================================

function collectLegacyDictData(
  dict: DictFile,
  wordsMap: Map<string, WordData>,
  translations: TranslationData[],
  examples: ExampleData[]
): void {
  const lang = dict.lang
  console.log(`Collecting legacy ${lang}... (${Object.keys(dict.entries).length.toLocaleString()} entries)`)

  let count = 0
  for (const [key, entry] of Object.entries(dict.entries)) {
    const existing = wordsMap.get(key)
    if (existing) {
      for (const posEntry of entry.partOfSpeech) {
        if (!existing.partOfSpeech.includes(posEntry.value)) {
          existing.partOfSpeech.push(posEntry.value)
        }
      }
      existing.common = existing.common || entry.common || entry.commonSources.length > 0
      for (const jlptEntry of entry.jlpt) {
        if (!existing.jlpt.includes(jlptEntry.level)) {
          existing.jlpt.push(jlptEntry.level)
        }
      }
      if (entry.frequency?.rank !== undefined) {
        if (existing.frequency === null || entry.frequency.rank < existing.frequency) {
          existing.frequency = entry.frequency.rank
        }
      }
    } else {
      wordsMap.set(key, {
        word: entry.word,
        reading: entry.reading,
        partOfSpeech: entry.partOfSpeech.map((p) => p.value),
        common: entry.common || entry.commonSources.length > 0,
        jlpt: entry.jlpt.map((j) => j.level),
        frequency: entry.frequency?.rank ?? null,
      })
    }

    if (entry.definitions.length > 0) {
      const defs: string[] = []
      const seenDefs = new Set<string>()
      const sourcesSet = new Set<string>()
      for (const def of entry.definitions) {
        if (!seenDefs.has(def.text)) {
          seenDefs.add(def.text)
          defs.push(def.text)
        }
        for (const source of def.sources) sourcesSet.add(source)
      }

      translations.push({
        wordId: key,
        lang,
        definitions: defs,
        sources: Array.from(sourcesSet),
      })
    }

    const seenExamples = new Set<string>()
    for (const example of entry.examples) {
      const sources = example.sources.length > 0 ? example.sources : ['unknown']
      for (const source of sources) {
        const exKey = `${example.ja}\u0000${example.text}\u0000${source}`
        if (seenExamples.has(exKey)) continue
        seenExamples.add(exKey)
        examples.push({
          wordId: key,
          lang,
          japanese: example.ja,
          translation: example.text,
          source,
        })
      }
    }

    count++
    if (count % 50000 === 0) {
      process.stdout.write(`\r  Collected ${count.toLocaleString()}...`)
    }
  }
  console.log(`\r  Collected ${count.toLocaleString()} entries`)
}

// ============================================================================
// Pass 3: Insert Words
// ============================================================================

function insertWords(db: Database, wordsMap: Map<string, WordData>): number {
  console.log(`\nInserting ${wordsMap.size.toLocaleString()} words...`)

  const insertWord = db.prepare(`
    INSERT INTO words (id, word, reading, part_of_speech, common, jlpt, frequency)
    VALUES (?, ?, ?, ?, ?, ?, ?)
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
        data.jlpt.length > 0 ? JSON.stringify(data.jlpt.sort((a, b) => b - a)) : null,
        data.frequency
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
// Pass 4: Insert Translations and Examples
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

async function assertMaterializedJson(filePath: string): Promise<void> {
  const header = await Bun.file(filePath).slice(0, LFS_POINTER_HEADER.length + 8).text()
  if (header.startsWith(LFS_POINTER_HEADER)) {
    throw new Error(
      `File "${filePath}" is a Git LFS pointer, not JSON. Run: bun run data:pull`
    )
  }
}

async function main(): Promise<void> {
  console.log('=== Build SQLite from JSON ===\n')

  const newLangFiles = existsSync(LANG_DIR)
    ? readdirSync(LANG_DIR).filter((f) => f.endsWith('.json') && !f.includes('/'))
    : []

  const legacyLangFiles = existsSync(DATA_DIR)
    ? readdirSync(DATA_DIR).filter((f) => {
      if (!f.endsWith('.json')) return false
      if (f.includes('/')) return false
      if (f === 'core.json') return false
      return true
    })
    : []

  const useNewSchema = existsSync(CORE_PATH) && newLangFiles.length > 0
  const useLegacySchema = !useNewSchema && legacyLangFiles.length > 0

  if (!useNewSchema && !useLegacySchema) {
    console.error('No dictionary JSON files found.')
    console.error('Expected either:')
    console.error('  - new schema: data/core.json + data/lang/*.json')
    console.error('  - legacy schema: data/{lang}.json')
    console.error('Run "bun run import:base" first.')
    process.exit(1)
  }

  const languages = useNewSchema
    ? newLangFiles.map((f) => f.replace('.json', ''))
    : legacyLangFiles.map((f) => f.replace('.json', ''))
  console.log(`Found languages: ${languages.join(', ')}`)

  // Initialize database
  const db = initDb()

  // Shared data structures
  const wordsMap = new Map<string, WordData>()
  const allTranslations: TranslationData[] = []
  const allExamples: ExampleData[] = []

  if (useNewSchema) {
    // Pass 1: Load core.json
    console.log('\n--- Pass 1: Loading core.json ---\n')
    await assertMaterializedJson(CORE_PATH)
    const core = await loadCore(CORE_PATH)
    console.log(`  Version: ${core.version}, Updated: ${core.updatedAt}`)
    collectCoreData(core, wordsMap)

    // Pass 2: Load lang files and collect translations + examples
    console.log('\n--- Pass 2: Collecting data from lang files ---\n')
    for (const lang of languages) {
      const filePath = `${LANG_DIR}/${lang}.json`
      console.log(`Loading ${filePath}...`)
      await assertMaterializedJson(filePath)

      const langFile = await loadLang(filePath, lang)
      console.log(`  Version: ${langFile.version}, Updated: ${langFile.updatedAt}`)

      collectLangData(langFile, wordsMap, allTranslations, allExamples)
    }
  } else {
    // Legacy fallback for data/{lang}.json
    console.log('\n--- Legacy Mode: Collecting from data/{lang}.json ---\n')
    for (const lang of languages) {
      const filePath = `${DATA_DIR}/${lang}.json`
      console.log(`Loading ${filePath}...`)
      await assertMaterializedJson(filePath)

      const dict = await loadDict(filePath, lang)
      console.log(`  Version: ${dict.version}, Updated: ${dict.updatedAt}`)

      collectLegacyDictData(dict, wordsMap, allTranslations, allExamples)
    }
  }

  // Pass 3: Insert words
  console.log('\n--- Pass 3: Inserting words ---')
  const wordCount = insertWords(db, wordsMap)

  // Pass 4: Insert translations and examples
  console.log('\n--- Pass 4: Inserting translations and examples ---')
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
