/**
 * Seed from XML - Parses raw JMdict XML and imports into SQLite
 * 
 * Usage: bun run seed:xml
 * 
 * Downloads from edrdg.org (original JMdict source) if not cached
 */

import { Database } from 'bun:sqlite'
import { existsSync, unlinkSync } from 'fs'
import { gunzipSync } from 'bun'

const DB_PATH = './dict.sqlite'
const DATA_DIR = './data/raw'

// Language codes in JMdict XML and our mapping
const LANG_MAP: Record<string, string> = {
  'eng': 'en',
  'ger': 'de',
  'chi': 'zh-CN',  // JMdict uses "chi" for Chinese (simplified assumed)
  'kor': 'ko',
}

// Priority markers that indicate common words
const COMMON_MARKERS = ['news1', 'ichi1', 'spec1', 'gai1']

// Part of speech entity code to human-readable mapping
const POS_MAP: Record<string, string> = {
  // Verbs
  'v1': 'ichidan verb',
  'v5u': 'godan verb',
  'v5k': 'godan verb',
  'v5g': 'godan verb',
  'v5s': 'godan verb',
  'v5t': 'godan verb',
  'v5n': 'godan verb',
  'v5b': 'godan verb',
  'v5m': 'godan verb',
  'v5r': 'godan verb',
  'v5aru': 'godan verb',
  'v5k-s': 'godan verb',
  'v5u-s': 'godan verb',
  'v5r-i': 'godan verb',
  'vk': 'kuru verb',
  'vs': 'suru verb',
  'vs-i': 'suru verb',
  'vs-s': 'suru verb',
  'vz': 'ichidan verb',
  'vt': 'transitive verb',
  'vi': 'intransitive verb',
  // Adjectives
  'adj-i': 'i-adjective',
  'adj-ix': 'i-adjective',
  'adj-na': 'na-adjective',
  'adj-no': 'no-adjective',
  'adj-pn': 'pre-noun adjectival',
  'adj-t': 'taru adjective',
  'adj-f': 'prenominal adjective',
  // Nouns
  'n': 'noun',
  'n-adv': 'adverbial noun',
  'n-suf': 'noun suffix',
  'n-pref': 'noun prefix',
  'n-t': 'temporal noun',
  // Others
  'adv': 'adverb',
  'adv-to': 'adverb',
  'aux': 'auxiliary',
  'aux-v': 'auxiliary verb',
  'aux-adj': 'auxiliary adjective',
  'conj': 'conjunction',
  'cop': 'copula',
  'ctr': 'counter',
  'exp': 'expression',
  'int': 'interjection',
  'pn': 'pronoun',
  'pref': 'prefix',
  'prt': 'particle',
  'suf': 'suffix',
  'unc': 'unclassified',
}

interface ParsedEntry {
  id: string
  word: string
  reading: string
  partOfSpeech: string[]
  isCommon: boolean
  glosses: Map<string, string[]>  // lang -> definitions
}

/**
 * Download JMdict if not cached
 */
async function ensureJMdictDownloaded(): Promise<string> {
  const xmlPath = `${DATA_DIR}/JMdict.xml`
  const gzPath = `${DATA_DIR}/JMdict.gz`

  // Check for extracted XML
  if (existsSync(xmlPath)) {
    console.log(`Using cached: ${xmlPath}`)
    return xmlPath
  }

  // Check for gzipped file
  if (!existsSync(gzPath)) {
    console.log('Downloading JMdict from edrdg.org...')
    const response = await fetch('http://ftp.edrdg.org/pub/Nihongo/JMdict.gz')
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`)
    }
    const buffer = await response.arrayBuffer()
    await Bun.write(gzPath, buffer)
    console.log(`Downloaded: ${gzPath}`)
  }

  // Extract gzip
  console.log('Extracting JMdict.gz...')
  const gzData = await Bun.file(gzPath).arrayBuffer()
  const xmlData = gunzipSync(new Uint8Array(gzData))
  await Bun.write(xmlPath, xmlData)
  console.log(`Extracted: ${xmlPath}`)

  return xmlPath
}

/**
 * Simple XML parser for JMdict format
 * Note: This is a simple regex-based parser optimized for JMdict structure
 */
function* parseEntries(xml: string): Generator<ParsedEntry> {
  // Match each <entry>...</entry> block
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
  let match

  while ((match = entryRegex.exec(xml)) !== null) {
    const entryXml = match[1]

    // Extract entry ID
    const idMatch = entryXml.match(/<ent_seq>(\d+)<\/ent_seq>/)
    if (!idMatch) continue
    const id = idMatch[1]

    // Extract kanji elements
    const kanjiMatches = entryXml.matchAll(/<keb>([^<]+)<\/keb>/g)
    const kanji: string[] = []
    for (const m of kanjiMatches) {
      kanji.push(m[1])
    }

    // Extract reading elements
    const readingMatches = entryXml.matchAll(/<reb>([^<]+)<\/reb>/g)
    const readings: string[] = []
    for (const m of readingMatches) {
      readings.push(m[1])
    }

    if (readings.length === 0) continue

    // Check for common markers (ke_pri and re_pri)
    const priMatches = entryXml.matchAll(/<[kr]e_pri>([^<]+)<\/[kr]e_pri>/g)
    let isCommon = false
    for (const m of priMatches) {
      if (COMMON_MARKERS.includes(m[1])) {
        isCommon = true
        break
      }
    }

    // Extract part of speech and map to human-readable names
    const posMatches = entryXml.matchAll(/<pos>&([^;]+);<\/pos>/g)
    const partOfSpeechSet = new Set<string>()
    for (const m of posMatches) {
      const code = m[1]
      const readable = POS_MAP[code] || code.replace(/-/g, ' ')
      partOfSpeechSet.add(readable)
    }
    const partOfSpeech = Array.from(partOfSpeechSet)

    // Extract glosses (translations) by language
    const glosses = new Map<string, string[]>()
    
    // Match sense blocks
    const senseMatches = entryXml.matchAll(/<sense>([\s\S]*?)<\/sense>/g)
    for (const senseMatch of senseMatches) {
      const senseXml = senseMatch[1]
      
      // Match glosses with language attribute
      // Format: <gloss xml:lang="ger">German translation</gloss>
      // Or just <gloss>English translation</gloss> (default is English)
      const glossMatches = senseXml.matchAll(/<gloss(?:\s+xml:lang="([^"]*)")?[^>]*>([^<]+)<\/gloss>/g)
      
      for (const glossMatch of glossMatches) {
        const lang = glossMatch[1] || 'eng'  // Default to English
        const text = glossMatch[2].trim()
        
        if (LANG_MAP[lang]) {
          const mappedLang = LANG_MAP[lang]
          if (!glosses.has(mappedLang)) {
            glosses.set(mappedLang, [])
          }
          glosses.get(mappedLang)!.push(text)
        }
      }
    }

    // Skip entries with no glosses in our target languages
    if (glosses.size === 0) continue

    yield {
      id,
      word: kanji[0] || readings[0],
      reading: readings[0],
      partOfSpeech,
      isCommon,
      glosses,
    }
  }
}

/**
 * Initialize database with schema
 */
function initDb(): Database {
  if (existsSync(DB_PATH)) {
    console.log('Removing existing database...')
    unlinkSync(DB_PATH)
  }

  const db = new Database(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  db.exec(`
    CREATE TABLE words (
      id TEXT PRIMARY KEY,
      word TEXT NOT NULL,
      reading TEXT NOT NULL,
      part_of_speech TEXT NOT NULL,
      common INTEGER DEFAULT 0,
      jlpt INTEGER
    );

    CREATE TABLE translations (
      word_id TEXT NOT NULL,
      lang TEXT NOT NULL,
      definitions TEXT NOT NULL,
      source TEXT NOT NULL,
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

  return db
}

/**
 * Main seed function
 */
async function main(): Promise<void> {
  console.log('=== JMdict XML Seed Script ===\n')

  // Download/extract JMdict
  const xmlPath = await ensureJMdictDownloaded()

  // Read XML file
  console.log('Reading XML file...')
  const xml = await Bun.file(xmlPath).text()
  console.log(`XML size: ${(xml.length / 1024 / 1024).toFixed(1)} MB`)

  // Initialize database
  const db = initDb()

  // Prepare statements
  const insertWord = db.prepare(`
    INSERT OR IGNORE INTO words (id, word, reading, part_of_speech, common)
    VALUES (?, ?, ?, ?, ?)
  `)

  const insertTranslation = db.prepare(`
    INSERT OR REPLACE INTO translations (word_id, lang, definitions, source)
    VALUES (?, ?, ?, ?)
  `)

  // Parse and insert
  console.log('Parsing and importing entries...')
  
  let entryCount = 0
  let translationCounts: Record<string, number> = {}
  let commonCount = 0
  const batchSize = 5000
  let batch: ParsedEntry[] = []

  const processBatch = db.transaction((entries: ParsedEntry[]) => {
    for (const entry of entries) {
      insertWord.run(
        entry.id,
        entry.word,
        entry.reading,
        JSON.stringify(entry.partOfSpeech),
        entry.isCommon ? 1 : 0
      )

      for (const [lang, definitions] of entry.glosses) {
        insertTranslation.run(
          entry.id,
          lang,
          JSON.stringify(definitions),
          'jmdict'
        )
        translationCounts[lang] = (translationCounts[lang] || 0) + 1
      }
    }
  })

  for (const entry of parseEntries(xml)) {
    batch.push(entry)
    entryCount++
    if (entry.isCommon) commonCount++

    if (batch.length >= batchSize) {
      processBatch(batch)
      process.stdout.write(`\r  Processed ${entryCount.toLocaleString()} entries...`)
      batch = []
    }
  }

  // Process remaining
  if (batch.length > 0) {
    processBatch(batch)
  }

  console.log(`\r  Processed ${entryCount.toLocaleString()} entries`)

  // Print statistics
  console.log('\n=== Database Statistics ===')
  console.log(`Total words: ${entryCount.toLocaleString()}`)
  console.log(`Common words: ${commonCount.toLocaleString()}`)
  console.log('\nTranslations by language:')
  for (const [lang, count] of Object.entries(translationCounts).sort((a, b) => b[1] - a[1])) {
    const coverage = ((count / entryCount) * 100).toFixed(1)
    console.log(`  ${lang}: ${count.toLocaleString()} (${coverage}%)`)
  }

  const allLangs = ['en', 'de', 'zh-TW', 'zh-CN', 'ko']
  const missingLangs = allLangs.filter(lang => !translationCounts[lang])
  if (missingLangs.length > 0) {
    console.log('\nMissing languages (need AI enrichment):')
    for (const lang of missingLangs) {
      console.log(`  ${lang}: 0 (0%)`)
    }
  }

  db.close()

  console.log('\n=== Seed Complete ===')
  console.log(`Database saved to: ${DB_PATH}`)
  console.log('\nNext steps:')
  console.log('  1. Run "bun run dev" to start the API server')
  console.log('  2. Add missing translations via "bun run enrich"')
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
