/**
 * Wadoku Importer - Enriches German dictionary with Wadoku definitions
 *
 * Data source: https://github.com/WaDoku/WaDokuJT-Data
 * License: CC-BY-SA 3.0
 *
 * Usage:
 *   bun run import:wadoku
 *   bun run import:wadoku --mode diff    # Preview changes
 */

import { mkdir } from 'fs/promises'
import { existsSync, unlinkSync } from 'fs'
import {
  type DictEntry,
  type DictFile,
  type Definition,
  makeKey,
  loadDict,
  saveDict,
  mergeDefinitions,
} from './base'

// ============================================================================
// Configuration
// ============================================================================

const DATA_DIR = './data'
const CACHE_DIR = './data/cache'

// Wadoku data URL
const WADOKU_URL = 'https://raw.githubusercontent.com/WaDoku/WaDokuJT-Data/master/WaDokuTest.tab'

type ImportMode = 'merge' | 'diff'

// ============================================================================
// Types
// ============================================================================

interface WadokuEntry {
  id: string
  japanese: string
  reading: string
  definitions: string[]
  partOfSpeech: string
}

// ============================================================================
// Download Functions
// ============================================================================

async function downloadWadoku(): Promise<string> {
  const cachePath = `${CACHE_DIR}/wadoku.tab`

  // Check cache
  if (existsSync(cachePath)) {
    console.log(`  Using cached: ${cachePath}`)
    return Bun.file(cachePath).text()
  }

  // Download
  console.log(`  Downloading: ${WADOKU_URL}`)

  const response = await fetch(WADOKU_URL, {
    headers: { 'User-Agent': 'yori-dict-importer' },
  })

  if (!response.ok) {
    throw new Error(`Failed to download Wadoku: ${response.status}`)
  }

  const text = await response.text()

  // Cache for future use
  await mkdir(CACHE_DIR, { recursive: true })
  await Bun.write(cachePath, text)
  console.log(`  Cached to: ${cachePath}`)

  return text
}

// ============================================================================
// Parsing Functions
// ============================================================================

/**
 * Extract German translations from Wadoku markup
 * Format: <TrE: translation> or <TrE: <HW f: translation>>
 */
function extractTranslations(markup: string): string[] {
  const flattenMarkup = (text: string): string => {
    let cleaned = text
    let prev = ''

    while (prev !== cleaned) {
      prev = cleaned
      // Unwrap tags that carry payloads, e.g. <HW f: ...>, <Def.: ...>.
      cleaned = cleaned.replace(/<[^>]*:\s*([^<>]*)>/g, '$1')
      // Remove marker tags with no payload, e.g. <Prior_1>, <JLPT2>.
      cleaned = cleaned.replace(/<[^>]+>/g, ' ')
    }

    return cleaned.replace(/\s+/g, ' ').trim()
  }

  const translations: string[] = []
  // Non-balanced regex is intentional: Wadoku has malformed rows where
  // balanced scanning can over-consume into the next segments.
  const trePattern = /<TrE:\s*((?:[^<>]|<[^>]*>)*)>/g
  let match

  while ((match = trePattern.exec(markup)) !== null) {
    const text = flattenMarkup(match[1])

    // Skip results that still contain markup fragments, are empty, or too short
    if (text.length >= 2 && !text.includes('<')) {
      translations.push(text)
    }
  }

  // Deduplicate
  return [...new Set(translations)]
}

/**
 * Clean Japanese text - remove variant markers like [1], [2], etc.
 * and split on semicolons for variants
 */
function parseJapanese(text: string): { word: string; variants: string[] } {
  // Remove number markers like [1], [2]
  let cleaned = text.replace(/\s*\[\d+\]/g, '')

  // Remove parenthetical kanji alternatives like (嗚呼; 嗟; 噫; 鳴呼)
  cleaned = cleaned.replace(/\s*\([^)]+\)/g, '')

  // Split on semicolons for variants
  const parts = cleaned.split(/[;；]/).map((s) => s.trim()).filter(Boolean)

  return {
    word: parts[0] || '',
    variants: parts.slice(1),
  }
}

/**
 * Clean reading - remove markers and separators
 */
function parseReading(text: string): string {
  let cleaned = text.replace(/\s*\[\d+\]/g, '')
  cleaned = cleaned.replace(/\[WaSep\]/g, '')
  cleaned = cleaned.replace(/\[Gr\]/g, '')
  cleaned = cleaned.replace(/\[NN\]/g, '')
  cleaned = cleaned.replace(/\[Dev\]/g, '')
  cleaned = cleaned.replace(/\[suru\]/g, '')
  cleaned = cleaned.replace(/\[KanaSep\]/g, '')
  cleaned = cleaned.trim()
  return cleaned
}

/**
 * Map Wadoku POS codes to our format
 */
function mapPartOfSpeech(wadokuPos: string): string[] {
  const posMap: Record<string, string> = {
    '名': 'noun',
    '動': 'verb',
    '形': 'adjective',
    '副': 'adverb',
    '感': 'interjection',
    '連体': 'adnominal',
    'サ変他': 'suru verb',
    'サ変自': 'suru verb',
    '接頭': 'prefix',
    '接尾': 'suffix',
    '助': 'particle',
    '連': 'conjunction',
    '代': 'pronoun',
  }

  return posMap[wadokuPos] ? [posMap[wadokuPos]] : []
}

/**
 * Parse Wadoku tab-delimited file
 */
function parseWadokuFile(text: string): WadokuEntry[] {
  const entries: WadokuEntry[] = []
  const lines = text.split('\n')

  for (const line of lines) {
    if (!line.trim()) continue

    const fields = line.split('\t')
    if (fields.length < 5) continue

    const id = fields[0]
    const japaneseRaw = fields[1]
    const readingRaw = fields[2]
    const definitionMarkup = fields[3]
    const posRaw = fields[4]

    // Skip header or invalid lines
    if (id === '*Japanisch' || !japaneseRaw) continue

    // Parse Japanese text
    const { word } = parseJapanese(japaneseRaw)
    if (!word) continue

    // Parse reading
    const reading = parseReading(readingRaw)
    if (!reading) continue

    // Extract German translations
    const definitions = extractTranslations(definitionMarkup)
    if (definitions.length === 0) continue

    // Map POS
    const partOfSpeech = mapPartOfSpeech(posRaw).join(', ') || posRaw

    entries.push({
      id,
      japanese: word,
      reading,
      definitions,
      partOfSpeech,
    })
  }

  return entries
}

// ============================================================================
// Import Logic
// ============================================================================

interface ImportStats {
  wadokuEntries: number
  matched: number
  newDefinitions: number
  entriesUpdated: number
}

function importWadoku(
  dict: DictFile,
  wadokuEntries: WadokuEntry[],
  mode: ImportMode
): ImportStats {
  const stats: ImportStats = {
    wadokuEntries: wadokuEntries.length,
    matched: 0,
    newDefinitions: 0,
    entriesUpdated: 0,
  }

  // Build lookup map for dictionary entries
  const wordMap = new Map<string, string[]>()

  for (const [key, entry] of Object.entries(dict.entries)) {
    // Index by word
    const wordKeys = wordMap.get(entry.word) || []
    wordKeys.push(key)
    wordMap.set(entry.word, wordKeys)

    // Also index by reading if different
    if (entry.reading !== entry.word) {
      const readingKeys = wordMap.get(entry.reading) || []
      readingKeys.push(key)
      wordMap.set(entry.reading, readingKeys)
    }
  }

  // Process Wadoku entries
  for (const wadoku of wadokuEntries) {
    // Try to find matching dictionary entry
    const key = makeKey(wadoku.japanese, wadoku.reading)
    let entry = dict.entries[key]

    // If no exact match, try to find by word only
    if (!entry) {
      const candidates = wordMap.get(wadoku.japanese) || wordMap.get(wadoku.reading)
      if (candidates && candidates.length === 1) {
        entry = dict.entries[candidates[0]]
      }
    }

    if (!entry) continue

    stats.matched++

    // Check for new definitions
    const existingTexts = new Set(entry.definitions.map((d) => d.text.toLowerCase()))
    const newDefs: Definition[] = []

    for (const defText of wadoku.definitions) {
      if (!existingTexts.has(defText.toLowerCase())) {
        newDefs.push({
          text: defText,
          sources: ['wadoku'],
        })
        stats.newDefinitions++
      }
    }

    if (newDefs.length > 0) {
      stats.entriesUpdated++

      if (mode !== 'diff') {
        // Merge definitions
        entry.definitions = mergeDefinitions(entry.definitions, newDefs)
      }
    }
  }

  return stats
}

// ============================================================================
// Main Import Function
// ============================================================================

async function runImport(mode: ImportMode): Promise<void> {
  console.log('=== Wadoku German Importer ===')
  console.log(`Mode: ${mode}`)

  // Check if German dictionary exists
  const dictPath = `${DATA_DIR}/de.json`
  if (!existsSync(dictPath)) {
    console.error('\nGerman dictionary not found.')
    console.error('Run "bun run import:jmdict --lang de" first.')
    process.exit(1)
  }

  // Download Wadoku data
  console.log('\nDownloading Wadoku data...')
  const wadokuText = await downloadWadoku()

  // Parse Wadoku entries
  console.log('\nParsing Wadoku entries...')
  const wadokuEntries = parseWadokuFile(wadokuText)
  console.log(`  Parsed ${wadokuEntries.length.toLocaleString()} entries`)

  // Load German dictionary
  console.log('\nLoading German dictionary...')
  const dict = await loadDict(dictPath, 'de')
  console.log(`  Entries: ${Object.keys(dict.entries).length.toLocaleString()}`)

  // Import Wadoku definitions
  console.log('\nImporting Wadoku definitions...')
  const stats = importWadoku(dict, wadokuEntries, mode)

  // Print stats
  console.log('\nResults:')
  console.log(`  Wadoku entries: ${stats.wadokuEntries.toLocaleString()}`)
  console.log(`  Matched to dict: ${stats.matched.toLocaleString()}`)
  console.log(`  New definitions: ${stats.newDefinitions.toLocaleString()}`)
  console.log(`  Entries updated: ${stats.entriesUpdated.toLocaleString()}`)

  if (mode !== 'diff' && stats.entriesUpdated > 0) {
    await saveDict(dictPath, dict)
    console.log(`\nSaved to: ${dictPath}`)
  } else if (mode === 'diff') {
    console.log('\n(Diff mode - no changes made)')
  }
}

// ============================================================================
// CLI
// ============================================================================

function printHelp(): void {
  console.log(`
Wadoku German Importer

Enriches German dictionary with additional definitions from Wadoku.
Data source: https://github.com/WaDoku/WaDokuJT-Data

Usage:
  bun run import:wadoku [options]

Options:
  --mode    Import mode (default: merge)
            merge - Add new definitions to entries
            diff  - Preview changes, no modifications

Examples:
  bun run import:wadoku
  bun run import:wadoku --mode diff
`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  let mode: ImportMode = 'merge'

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--mode' && next) {
      if (next === 'merge' || next === 'diff') {
        mode = next
      } else {
        console.error(`Invalid mode: ${next}`)
        console.error('Supported modes: merge, diff')
        process.exit(1)
      }
      i++
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      return
    }
  }

  await runImport(mode)

  console.log('\n=== Import Complete ===')
}

main().catch((err) => {
  console.error('Import failed:', err)
  process.exit(1)
})
