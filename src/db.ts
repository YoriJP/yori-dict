import { Database } from 'bun:sqlite'
import { toRomaji } from 'wanakana'
import { conjugate } from './conjugator'
import type { Language, LookupResponse, WordRow, TranslationRow } from './types'
import { requireActiveReleaseConfig } from './storage'
import { getActiveExampleUpdate, getActiveTranslationUpdate, openUpdatesDb } from './update-store'

interface ExampleLookupRow {
  japanese: string
  translation: string
}

let releaseDb: Database | null = null
let updatesDb: Database | null = null

/**
 * Get release database connection.
 */
export function getReleaseDb(): Database {
  if (!releaseDb) {
    const config = requireActiveReleaseConfig()
    releaseDb = new Database(config.dbPath, { readonly: true })
    releaseDb.exec('PRAGMA foreign_keys = ON')
  }
  return releaseDb
}

/**
 * Get updates database connection.
 */
export function getUpdatesDb(): Database {
  if (!updatesDb) {
    updatesDb = openUpdatesDb()
  }
  return updatesDb
}

/**
 * Initialize database schema
 */
export function initSchema(): void {
  getReleaseDb()
  getUpdatesDb()
}

/**
 * Lookup a word and return full response
 */
export function lookupWord(word: string, lang: Language): LookupResponse | null {
  const db = getReleaseDb()
  const updates = getUpdatesDb()

  // Query word by exact match on word or reading
  // Order by: common words first, then by lowest JLPT level (most beginner-friendly)
  // jlpt is JSON array like '[5]' or '[5,4]' - extract first element for sorting
  // JLPT levels: N5=5 (easiest) to N1=1 (hardest), so lower number = harder
  // We want easiest first, so sort DESC on the extracted level
  const wordQuery = db.query<WordRow, [string]>(`
    SELECT * FROM words
    WHERE word = ?1 OR reading = ?1
    ORDER BY
      common DESC,
      CASE
        WHEN jlpt IS NULL THEN 0
        ELSE CAST(json_extract(jlpt, '$[0]') AS INTEGER)
      END DESC
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

  const translationOverride = getActiveTranslationUpdate(updates, wordRow.id, lang)
  const translationRow = translationQuery.get(wordRow.id, lang)
  const effectiveDefinitions = translationOverride
    ? translationOverride.definitions
    : (translationRow ? JSON.parse(translationRow.definitions) as string[] : null)

  if (!effectiveDefinitions || effectiveDefinitions.length === 0) {
    return null
  }

  const exampleOverride = getActiveExampleUpdate(updates, wordRow.id, lang)
  let exampleRows: ExampleLookupRow[]

  if (exampleOverride) {
    exampleRows = exampleOverride.examples.map((row) => ({
      japanese: row.japanese,
      translation: row.translation,
    }))
  } else {
    const examplesQuery = db.query<ExampleLookupRow, [string, string]>(`
      SELECT DISTINCT japanese, translation
      FROM examples
      WHERE word_id = ? AND lang = ?
      ORDER BY japanese, translation
    `)

    exampleRows = examplesQuery.all(wordRow.id, lang)
  }

  // Parse JSON fields
  const partOfSpeech: string[] = JSON.parse(wordRow.part_of_speech)
  const definitions = effectiveDefinitions

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

  // Only include optional fields if present
  if (wordRow.frequency !== null) {
    response.frequency = wordRow.frequency
  }
  if (conjugations) {
    response.conjugations = conjugations
  }

  return response
}

/**
 * Close database connection
 */
export function closeDb(): void {
  if (releaseDb) {
    releaseDb.close()
    releaseDb = null
  }
  if (updatesDb) {
    updatesDb.close()
    updatesDb = null
  }
}
