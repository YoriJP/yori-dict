/**
 * Export script - Exports dictionary data for public distribution
 * 
 * Usage: bun run export
 * 
 * Outputs:
 * - data/exports/words.json - All words with readings, POS
 * - data/exports/translations/{lang}.json - Translations per language
 * - data/exports/examples/{lang}.json - Examples per language
 * - data/exports/stats.json - Coverage statistics
 */

import { Database } from 'bun:sqlite'
import { mkdir } from 'fs/promises'
import { existsSync } from 'fs'

const DB_PATH = './dict.sqlite'
const EXPORT_DIR = './data/exports'

interface WordExport {
  id: string
  word: string
  reading: string
  partOfSpeech: string[]
  common: boolean
  jlpt: number | null
}

interface TranslationExport {
  definitions: string[]
  source: string
}

interface ExampleExport {
  japanese: string
  translation: string
  source: string
}

interface Stats {
  exportedAt: string
  totalWords: number
  commonWords: number
  languages: {
    [lang: string]: {
      translations: number
      examples: number
      coverage: string
    }
  }
}

async function main(): Promise<void> {
  console.log('=== Japanese Dictionary Export Script ===\n')

  // Check database exists
  if (!existsSync(DB_PATH)) {
    console.error('Database not found. Run "bun run seed" first.')
    process.exit(1)
  }

  const db = new Database(DB_PATH, { readonly: true })

  // Create export directories
  await mkdir(`${EXPORT_DIR}/translations`, { recursive: true })
  await mkdir(`${EXPORT_DIR}/examples`, { recursive: true })

  // Export words
  console.log('Exporting words...')
  const words = db.query(`
    SELECT id, word, reading, part_of_speech, common, jlpt
    FROM words
    ORDER BY common DESC, id
  `).all() as { id: string; word: string; reading: string; part_of_speech: string; common: number; jlpt: number | null }[]

  const wordsExport: WordExport[] = words.map((w) => ({
    id: w.id,
    word: w.word,
    reading: w.reading,
    partOfSpeech: JSON.parse(w.part_of_speech),
    common: w.common === 1,
    jlpt: w.jlpt,
  }))

  await Bun.write(
    `${EXPORT_DIR}/words.json`,
    JSON.stringify(wordsExport, null, 2)
  )
  console.log(`  Exported ${wordsExport.length} words`)

  // Get unique languages
  const languages = db.query(`
    SELECT DISTINCT lang FROM translations
    UNION
    SELECT DISTINCT lang FROM examples
  `).all() as { lang: string }[]

  const stats: Stats = {
    exportedAt: new Date().toISOString(),
    totalWords: wordsExport.length,
    commonWords: wordsExport.filter((w) => w.common).length,
    languages: {},
  }

  // Export translations per language
  for (const { lang } of languages) {
    console.log(`Exporting translations (${lang})...`)

    const translations = db.query(`
      SELECT word_id, definitions, source
      FROM translations
      WHERE lang = ?
    `).all(lang) as { word_id: string; definitions: string; source: string }[]

    const translationsExport: Record<string, TranslationExport> = {}
    for (const t of translations) {
      translationsExport[t.word_id] = {
        definitions: JSON.parse(t.definitions),
        source: t.source,
      }
    }

    await Bun.write(
      `${EXPORT_DIR}/translations/${lang}.json`,
      JSON.stringify(translationsExport, null, 2)
    )
    console.log(`  Exported ${translations.length} translations`)

    // Export examples per language
    console.log(`Exporting examples (${lang})...`)

    const examples = db.query(`
      SELECT word_id, japanese, translation, source
      FROM examples
      WHERE lang = ?
    `).all(lang) as { word_id: string; japanese: string; translation: string; source: string }[]

    const examplesExport: Record<string, ExampleExport[]> = {}
    for (const e of examples) {
      if (!examplesExport[e.word_id]) {
        examplesExport[e.word_id] = []
      }
      examplesExport[e.word_id].push({
        japanese: e.japanese,
        translation: e.translation,
        source: e.source,
      })
    }

    await Bun.write(
      `${EXPORT_DIR}/examples/${lang}.json`,
      JSON.stringify(examplesExport, null, 2)
    )
    console.log(`  Exported examples for ${Object.keys(examplesExport).length} words`)

    // Update stats
    stats.languages[lang] = {
      translations: translations.length,
      examples: Object.keys(examplesExport).length,
      coverage: ((translations.length / wordsExport.length) * 100).toFixed(2) + '%',
    }
  }

  // Write stats
  await Bun.write(
    `${EXPORT_DIR}/stats.json`,
    JSON.stringify(stats, null, 2)
  )

  db.close()

  console.log('\n=== Export Statistics ===')
  console.log(`Total words: ${stats.totalWords}`)
  console.log(`Common words: ${stats.commonWords}`)
  console.log('\nLanguage coverage:')
  for (const [lang, data] of Object.entries(stats.languages)) {
    console.log(`  ${lang}: ${data.translations} translations (${data.coverage})`)
  }

  console.log(`\nExport complete! Files saved to: ${EXPORT_DIR}`)
}

main().catch((err) => {
  console.error('Export failed:', err)
  process.exit(1)
})
