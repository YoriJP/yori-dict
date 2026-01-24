/**
 * Seed script - Downloads jmdict-simplified JSON and imports into SQLite
 * 
 * Usage: bun run seed
 * 
 * Downloads from: https://github.com/scriptin/jmdict-simplified/releases
 */

import { Database } from 'bun:sqlite'
import { mkdir } from 'fs/promises'
import { existsSync, unlinkSync } from 'fs'

const DB_PATH = './dict.sqlite'
const DATA_DIR = './data/raw'

// Language mapping
const LANG_MAP: Record<string, string> = {
  eng: 'en',
  ger: 'de',
}

// Part of speech mapping to human-readable names
const POS_MAP: Record<string, string> = {
  'v1': 'ichidan verb',
  'v5u': 'godan verb', 'v5k': 'godan verb', 'v5g': 'godan verb',
  'v5s': 'godan verb', 'v5t': 'godan verb', 'v5n': 'godan verb',
  'v5b': 'godan verb', 'v5m': 'godan verb', 'v5r': 'godan verb',
  'v5aru': 'godan verb', 'v5k-s': 'godan verb', 'v5u-s': 'godan verb', 'v5r-i': 'godan verb',
  'vk': 'kuru verb', 'vs': 'suru verb', 'vs-i': 'suru verb', 'vs-s': 'suru verb',
  'vz': 'ichidan verb', 'vt': 'transitive verb', 'vi': 'intransitive verb',
  'adj-i': 'i-adjective', 'adj-ix': 'i-adjective', 'adj-na': 'na-adjective',
  'adj-no': 'no-adjective', 'adj-pn': 'pre-noun adjectival',
  'adj-t': 'taru adjective', 'adj-f': 'prenominal adjective',
  'n': 'noun', 'n-adv': 'adverbial noun', 'n-suf': 'noun suffix',
  'n-pref': 'noun prefix', 'n-t': 'temporal noun',
  'adv': 'adverb', 'adv-to': 'adverb', 'aux': 'auxiliary',
  'aux-v': 'auxiliary verb', 'aux-adj': 'auxiliary adjective',
  'conj': 'conjunction', 'cop': 'copula', 'ctr': 'counter',
  'exp': 'expression', 'int': 'interjection', 'pn': 'pronoun',
  'pref': 'prefix', 'prt': 'particle', 'suf': 'suffix', 'unc': 'unclassified',
}

interface JMdictEntry {
  id: string
  kanji?: { text: string; common?: boolean }[]
  kana: { text: string; common?: boolean }[]
  sense: {
    partOfSpeech: string[]
    gloss: { lang?: string; text: string }[]
  }[]
}

interface JMdictFile {
  version: string
  words: JMdictEntry[]
}

interface GitHubRelease {
  assets: { name: string; browser_download_url: string }[]
}

/**
 * Get download URL from GitHub releases API
 */
async function getDownloadUrl(pattern: string): Promise<string | null> {
  console.log(`Fetching latest release info...`)
  
  const response = await fetch(
    'https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest',
    { headers: { 'User-Agent': 'japanese-dict-seeder' } }
  )

  if (!response.ok) {
    console.log(`  GitHub API failed: ${response.status}`)
    return null
  }

  const release: GitHubRelease = await response.json()
  const asset = release.assets.find(a => a.name.includes(pattern) && a.name.endsWith('.json.zip'))

  if (!asset) {
    console.log(`  Asset matching "${pattern}" not found`)
    return null
  }

  console.log(`  Found: ${asset.name}`)
  return asset.browser_download_url
}

/**
 * Download and extract JSON from ZIP
 */
async function downloadAndExtract(url: string, cachePath: string): Promise<JMdictFile | null> {
  // Check cache
  if (existsSync(cachePath)) {
    console.log(`Using cached: ${cachePath}`)
    return JSON.parse(await Bun.file(cachePath).text())
  }

  console.log(`Downloading: ${url}`)
  
  const response = await fetch(url, {
    headers: { 'User-Agent': 'japanese-dict-seeder' }
  })

  if (!response.ok) {
    console.log(`  Download failed: ${response.status}`)
    return null
  }

  // Save ZIP temporarily
  await mkdir(DATA_DIR, { recursive: true })
  const zipPath = `${DATA_DIR}/temp.zip`
  const buffer = await response.arrayBuffer()
  await Bun.write(zipPath, buffer)

  // Extract using unzip
  const proc = Bun.spawn(['unzip', '-p', zipPath], { stdout: 'pipe' })
  const text = await new Response(proc.stdout).text()
  await proc.exited

  // Clean up and cache
  unlinkSync(zipPath)
  await Bun.write(cachePath, text)
  console.log(`  Cached to: ${cachePath}`)

  return JSON.parse(text)
}

/**
 * Initialize database
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
 * Import JMdict JSON data
 */
function importData(db: Database, data: JMdictFile, lang: string): number {
  const mappedLang = LANG_MAP[lang] || lang
  console.log(`Importing ${mappedLang}... (${data.words.length} entries)`)

  const insertWord = db.prepare(`
    INSERT OR IGNORE INTO words (id, word, reading, part_of_speech, common)
    VALUES (?, ?, ?, ?, ?)
  `)

  const insertTranslation = db.prepare(`
    INSERT OR REPLACE INTO translations (word_id, lang, definitions, source)
    VALUES (?, ?, ?, ?)
  `)

  let count = 0

  const processBatch = db.transaction((entries: JMdictEntry[]) => {
    for (const entry of entries) {
      const word = entry.kanji?.[0]?.text || entry.kana[0].text
      const reading = entry.kana[0].text
      const isCommon = entry.kanji?.[0]?.common || entry.kana[0]?.common || false

      // Collect POS tags and map to human-readable names
      const posSet = new Set<string>()
      for (const sense of entry.sense) {
        for (const pos of sense.partOfSpeech) {
          posSet.add(POS_MAP[pos] || pos)
        }
      }

      insertWord.run(entry.id, word, reading, JSON.stringify([...posSet]), isCommon ? 1 : 0)

      // Collect definitions
      const definitions: string[] = []
      for (const sense of entry.sense) {
        for (const gloss of sense.gloss) {
          definitions.push(gloss.text)
        }
      }

      if (definitions.length > 0) {
        insertTranslation.run(entry.id, mappedLang, JSON.stringify(definitions), 'jmdict')
        count++
      }
    }
  })

  // Process in batches
  const BATCH_SIZE = 5000
  for (let i = 0; i < data.words.length; i += BATCH_SIZE) {
    processBatch(data.words.slice(i, i + BATCH_SIZE))
    process.stdout.write(`\r  Processed ${Math.min(i + BATCH_SIZE, data.words.length).toLocaleString()}/${data.words.length.toLocaleString()}`)
  }
  console.log('')

  return count
}

/**
 * Main
 */
async function main(): Promise<void> {
  console.log('=== JMdict Seed Script ===\n')

  // Get English dictionary URL
  const engUrl = await getDownloadUrl('jmdict-eng-')
  if (!engUrl) {
    console.log('\nFailed to get download URL. Try: bun run seed:xml')
    process.exit(1)
  }

  // Download English
  const engData = await downloadAndExtract(engUrl, `${DATA_DIR}/jmdict-eng.json`)
  if (!engData) {
    console.log('\nDownload failed. Try: bun run seed:xml')
    process.exit(1)
  }

  // Initialize database
  const db = initDb()

  // Import English
  const engCount = importData(db, engData, 'eng')
  console.log(`  Imported ${engCount.toLocaleString()} English translations`)

  // Try German
  const gerUrl = await getDownloadUrl('jmdict-ger-')
  if (gerUrl) {
    const gerData = await downloadAndExtract(gerUrl, `${DATA_DIR}/jmdict-ger.json`)
    if (gerData) {
      const gerCount = importData(db, gerData, 'ger')
      console.log(`  Imported ${gerCount.toLocaleString()} German translations`)
    }
  }

  // Stats
  const wordCount = db.query('SELECT COUNT(*) as c FROM words').get() as { c: number }
  const langStats = db.query('SELECT lang, COUNT(*) as c FROM translations GROUP BY lang').all() as { lang: string; c: number }[]

  console.log('\n=== Statistics ===')
  console.log(`Total words: ${wordCount.c.toLocaleString()}`)
  for (const s of langStats) {
    console.log(`  ${s.lang}: ${s.c.toLocaleString()} (${((s.c / wordCount.c) * 100).toFixed(1)}%)`)
  }

  db.close()
  console.log(`\nDatabase saved to: ${DB_PATH}`)
}

main().catch(err => {
  console.error('Seed failed:', err.message)
  console.log('\nTry fallback: bun run seed:xml')
  process.exit(1)
})
