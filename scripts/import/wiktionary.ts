/**
 * Wiktionary Importer - Enriches dictionary with Wiktionary definitions
 *
 * Data source: https://kaikki.org/dictionary/Japanese/
 * License: CC-BY-SA 3.0 (Wiktionary) / MIT (wiktextract)
 *
 * Usage:
 *   bun run import:wiktionary
 *   bun run import:wiktionary --mode diff    # Preview changes
 *   bun run import:wiktionary --limit 1000   # Limit definitions per entry
 */

import { mkdir } from 'fs/promises'
import { existsSync, createReadStream } from 'fs'
import { createInterface } from 'readline'
import {
  type DictEntry,
  type DictFile,
  type Definition,
  makeKey,
  loadDict,
  saveDict,
  mergeDefinitions,
  downloadWithProgress,
} from './base'

// ============================================================================
// Configuration
// ============================================================================

const DATA_DIR = './data'
const CACHE_DIR = './data/cache'

// Wiktionary data URL (Japanese JSONL from kaikki.org)
const WIKTIONARY_URL = 'https://kaikki.org/dictionary/Japanese/kaikki.org-dictionary-Japanese.jsonl'

type ImportMode = 'merge' | 'diff' | 'refresh'

// POS types to include (skip romanizations, soft redirects, etc.)
const INCLUDED_POS = new Set([
  'noun',
  'verb',
  'adj',  // adjective
  'adv',  // adverb
  'intj', // interjection
  'pron', // pronoun
  'conj', // conjunction
  'particle',
  'counter',
  'prefix',
  'suffix',
  'affix',
  'phrase',
  'proverb',
  'num',  // numeral
])

// ============================================================================
// Types
// ============================================================================

interface WiktEntry {
  word: string
  pos: string
  lang: string
  lang_code: string
  forms?: { form: string; tags?: string[]; ruby?: [string, string][] }[]
  senses?: {
    glosses?: string[]
    raw_glosses?: string[]
    tags?: string[]
  }[]
  sounds?: { other?: string; ipa?: string }[]
}

interface ParsedWiktEntry {
  word: string
  reading: string
  definitions: string[]
  pos: string
}

// ============================================================================
// Download Functions
// ============================================================================

async function downloadWiktionary(): Promise<string> {
  const cachePath = `${CACHE_DIR}/wiktionary-japanese.jsonl`

  await mkdir(CACHE_DIR, { recursive: true })
  await downloadWithProgress(WIKTIONARY_URL, cachePath)

  return cachePath
}

// ============================================================================
// Parsing Functions
// ============================================================================

/**
 * Extract reading from Wiktionary entry
 */
function extractReading(entry: WiktEntry): string | null {
  // Try to get reading from forms
  if (entry.forms) {
    for (const form of entry.forms) {
      // Look for hiragana reading in ruby annotations
      if (form.ruby && form.ruby.length > 0) {
        const reading = form.ruby.map(([_, r]) => r).join('')
        if (reading && /[\u3040-\u309F]/.test(reading)) {
          return reading
        }
      }

      // Look for romanization tag
      if (form.tags?.includes('romanization')) {
        continue // Skip romanizations
      }

      // Check if form is hiragana
      if (form.form && /^[\u3040-\u309F]+$/.test(form.form)) {
        return form.form
      }
    }
  }

  // Try sounds for katakana reading
  if (entry.sounds) {
    for (const sound of entry.sounds) {
      if (sound.other && /^[\u30A0-\u30FF]+$/.test(sound.other)) {
        // Convert katakana to hiragana
        return katakanaToHiragana(sound.other)
      }
    }
  }

  // If word is already hiragana, use it as reading
  if (/^[\u3040-\u309F]+$/.test(entry.word)) {
    return entry.word
  }

  // If word is katakana, convert to hiragana
  if (/^[\u30A0-\u30FF]+$/.test(entry.word)) {
    return katakanaToHiragana(entry.word)
  }

  return null
}

/**
 * Convert katakana to hiragana
 */
function katakanaToHiragana(text: string): string {
  return text.replace(/[\u30A1-\u30F6]/g, (char) => {
    return String.fromCharCode(char.charCodeAt(0) - 0x60)
  })
}

/**
 * Extract definitions from Wiktionary senses
 */
function extractDefinitions(entry: WiktEntry): string[] {
  const definitions: string[] = []

  if (!entry.senses) return definitions

  for (const sense of entry.senses) {
    // Skip alt-of, form-of, romanization senses
    if (sense.tags) {
      const skipTags = ['alt-of', 'form-of', 'romanization', 'Rōmaji']
      if (sense.tags.some((t) => skipTags.includes(t))) {
        continue
      }
    }

    // Get glosses
    const glosses = sense.glosses || sense.raw_glosses || []
    for (const gloss of glosses) {
      // Clean up gloss
      let cleaned = gloss
        .replace(/\s*\([^)]*\)\s*/g, ' ') // Remove parentheticals
        .replace(/\s*\[[^\]]*\]\s*/g, ' ') // Remove brackets
        .replace(/\s+/g, ' ') // Normalize whitespace
        .trim()

      // Skip if too short or looks like a reference
      if (cleaned.length < 3) continue
      if (cleaned.startsWith('synonym of')) continue
      if (cleaned.startsWith('alternative')) continue
      if (cleaned.startsWith('Rōmaji')) continue

      // Capitalize first letter
      cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1)

      if (!definitions.includes(cleaned)) {
        definitions.push(cleaned)
      }
    }
  }

  return definitions
}

/**
 * Map Wiktionary POS to our POS format
 */
function mapPos(wiktPos: string): string {
  const posMap: Record<string, string> = {
    noun: 'noun',
    verb: 'verb',
    adj: 'adjective',
    adv: 'adverb',
    intj: 'interjection',
    pron: 'pronoun',
    conj: 'conjunction',
    particle: 'particle',
    counter: 'counter',
    prefix: 'prefix',
    suffix: 'suffix',
    affix: 'affix',
    phrase: 'expression',
    proverb: 'expression',
    num: 'numeral',
  }
  return posMap[wiktPos] || wiktPos
}

/**
 * Parse a single Wiktionary entry
 */
function parseWiktEntry(entry: WiktEntry): ParsedWiktEntry | null {
  // Skip non-Japanese entries
  if (entry.lang_code !== 'ja') return null

  // Skip certain POS types
  if (!INCLUDED_POS.has(entry.pos)) return null

  // Extract reading
  const reading = extractReading(entry)
  if (!reading) return null

  // Extract definitions
  const definitions = extractDefinitions(entry)
  if (definitions.length === 0) return null

  return {
    word: entry.word,
    reading,
    definitions,
    pos: mapPos(entry.pos),
  }
}

// ============================================================================
// Stream Processing
// ============================================================================

async function* streamWiktionary(filePath: string): AsyncGenerator<WiktEntry> {
  const fileStream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as WiktEntry
      yield entry
    } catch {
      // Skip malformed lines
    }
  }
}

// ============================================================================
// Import Logic
// ============================================================================

interface ImportStats {
  wiktEntriesProcessed: number
  wiktEntriesParsed: number
  matched: number
  newDefinitions: number
  entriesUpdated: number
}

async function importWiktionary(
  dict: DictFile,
  filePath: string,
  mode: ImportMode,
  maxDefsPerEntry: number
): Promise<ImportStats> {
  const stats: ImportStats = {
    wiktEntriesProcessed: 0,
    wiktEntriesParsed: 0,
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

  console.log(`  Dictionary has ${wordMap.size.toLocaleString()} unique words/readings`)

  // Track which entries have been updated
  const updatedEntries = new Set<string>()

  // Process Wiktionary entries
  console.log('  Processing Wiktionary entries...')
  const updateInterval = 10000

  for await (const wiktEntry of streamWiktionary(filePath)) {
    stats.wiktEntriesProcessed++

    if (stats.wiktEntriesProcessed % updateInterval === 0) {
      process.stdout.write(
        `\r  Processed ${stats.wiktEntriesProcessed.toLocaleString()}... ` +
          `(${stats.matched.toLocaleString()} matched, ${stats.newDefinitions.toLocaleString()} new defs)`
      )
    }

    // Parse entry
    const parsed = parseWiktEntry(wiktEntry)
    if (!parsed) continue

    stats.wiktEntriesParsed++

    // Try to find matching dictionary entry
    const key = makeKey(parsed.word, parsed.reading)
    let entry = dict.entries[key]

    // If no exact match, try by word only
    if (!entry) {
      const candidates = wordMap.get(parsed.word)
      if (candidates && candidates.length === 1) {
        entry = dict.entries[candidates[0]]
      }
    }

    if (!entry) continue

    stats.matched++
    const entryKey = makeKey(entry.word, entry.reading)

    // Check current definition count
    const currentDefs = entry.definitions.length
    if (currentDefs >= maxDefsPerEntry) continue

    // Check for new definitions
    const existingTexts = new Set(entry.definitions.map((d) => d.text.toLowerCase()))
    const newDefs: Definition[] = []

    for (const defText of parsed.definitions) {
      if (currentDefs + newDefs.length >= maxDefsPerEntry) break
      if (!existingTexts.has(defText.toLowerCase())) {
        newDefs.push({
          text: defText,
          sources: ['wiktionary'],
        })
        stats.newDefinitions++
      }
    }

    if (newDefs.length > 0) {
      updatedEntries.add(entryKey)

      if (mode !== 'diff') {
        entry.definitions = mergeDefinitions(entry.definitions, newDefs)
      }
    }
  }

  console.log('') // Clear progress line

  stats.entriesUpdated = updatedEntries.size
  return stats
}

// ============================================================================
// Main Import Function
// ============================================================================

async function runImport(
  mode: ImportMode,
  maxDefsPerEntry: number
): Promise<void> {
  console.log('=== [Enrichment] Wiktionary Importer ===')
  console.log(`Mode: ${mode}`)
  console.log(`Max definitions per entry: ${maxDefsPerEntry}`)

  // Check if English dictionary exists
  const dictPath = `${DATA_DIR}/en.json`
  if (!existsSync(dictPath)) {
    console.error(`\nEnglish dictionary not found: ${dictPath}`)
    console.error('This is an enrichment importer — run base importers first:')
    console.error('  bun run import:jmdict --lang en')
    console.error('  (or: bun run rebuild:all for a full rebuild)')
    process.exit(1)
  }

  // Download Wiktionary data
  console.log('\nDownloading Wiktionary data...')
  const filePath = await downloadWiktionary()

  // Load English dictionary
  console.log('\nLoading English dictionary...')
  const dict = await loadDict(dictPath, 'en')
  console.log(`  Entries: ${Object.keys(dict.entries).length.toLocaleString()}`)

  if (mode === 'refresh') {
    // Strip all existing wiktionary definitions before re-importing
    console.log('\nStripping existing wiktionary definitions...')
    let stripped = 0
    for (const entry of Object.values(dict.entries)) {
      const before = entry.definitions.length
      entry.definitions = entry.definitions.filter((d) => !d.sources.includes('wiktionary'))
      stripped += before - entry.definitions.length
    }
    console.log(`  Stripped ${stripped.toLocaleString()} wiktionary definitions`)
  }

  // Import Wiktionary definitions
  console.log('\nImporting Wiktionary definitions...')
  const stats = await importWiktionary(dict, filePath, mode === 'refresh' ? 'merge' : mode, maxDefsPerEntry)

  // Print stats
  console.log('\nResults:')
  console.log(`  Wiktionary entries processed: ${stats.wiktEntriesProcessed.toLocaleString()}`)
  console.log(`  Wiktionary entries parsed: ${stats.wiktEntriesParsed.toLocaleString()}`)
  console.log(`  Matched to dict: ${stats.matched.toLocaleString()}`)
  console.log(`  New definitions: ${stats.newDefinitions.toLocaleString()}`)
  console.log(`  Entries updated: ${stats.entriesUpdated.toLocaleString()}`)

  if (mode === 'refresh') {
    await saveDict(dictPath, dict)
    console.log(`\nSaved to: ${dictPath}`)
  } else if (mode !== 'diff' && stats.entriesUpdated > 0) {
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
Wiktionary Importer

Enriches English dictionary with additional definitions from Wiktionary.
Data source: https://kaikki.org/dictionary/Japanese/

Usage:
  bun run import:wiktionary [options]

Options:
  --mode    Import mode (default: merge)
            merge   - Add new definitions to entries
            diff    - Preview changes, no modifications
            refresh - Strip and re-import only wiktionary data
  --limit   Maximum definitions per entry (default: 10)

Examples:
  bun run import:wiktionary
  bun run import:wiktionary --mode diff
  bun run import:wiktionary --limit 5
`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  let mode: ImportMode = 'merge'
  let maxDefsPerEntry = 10

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--mode' && next) {
      if (next === 'merge' || next === 'diff' || next === 'refresh') {
        mode = next
      } else {
        console.error(`Invalid mode: ${next}`)
        console.error('Supported modes: merge, diff, refresh')
        process.exit(1)
      }
      i++
    } else if (arg === '--limit' && next) {
      maxDefsPerEntry = parseInt(next, 10)
      if (isNaN(maxDefsPerEntry) || maxDefsPerEntry < 1) {
        console.error(`Invalid limit: ${next}`)
        process.exit(1)
      }
      i++
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      return
    }
  }

  await runImport(mode, maxDefsPerEntry)

  console.log('\n=== Import Complete ===')
}

main().catch((err) => {
  console.error('Import failed:', err)
  process.exit(1)
})
