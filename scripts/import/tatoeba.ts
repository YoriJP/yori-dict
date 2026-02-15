/**
 * Tatoeba Examples Importer - Adds example sentences to dictionary entries
 *
 * Data source: https://www.manythings.org/anki/ (from Tatoeba Project)
 * License: CC-BY 2.0 FR
 *
 * Note: ManyThings.org only provides Japanese-English sentence pairs.
 * For other languages, you would need to use raw Tatoeba exports.
 *
 * Usage:
 *   bun run import:tatoeba
 *   bun run import:tatoeba --mode diff     # Preview changes
 *   bun run import:tatoeba --limit 5       # Max 5 examples per word
 */

import { mkdir } from 'fs/promises'
import { existsSync, readdirSync, unlinkSync } from 'fs'
import {
  type DictEntry,
  type DictFile,
  type Example,
  makeKey,
  loadDict,
  saveDict,
  mergeExamples,
} from './base'

// ============================================================================
// Configuration
// ============================================================================

const DATA_DIR = './data'
const CACHE_DIR = './data/cache'

// Language mapping for Tatoeba downloads
// Format: our lang code -> { tatoeba code, download URL }
// Note: ManyThings.org only provides Japanese-English pairs (jpn-eng)
// Other languages would require using raw Tatoeba data directly
const LANG_CONFIG: Record<string, { code: string; url: string }> = {
  en: {
    code: 'jpn-eng',
    url: 'https://www.manythings.org/anki/jpn-eng.zip',
  },
}

// Default maximum examples per word
const DEFAULT_MAX_EXAMPLES = 3

type ImportMode = 'merge' | 'diff'

// ============================================================================
// Types
// ============================================================================

interface TatoebaSentence {
  japanese: string
  translation: string
  attribution: string
}

// ============================================================================
// Download Functions
// ============================================================================

async function downloadTatoeba(lang: string): Promise<TatoebaSentence[]> {
  const config = LANG_CONFIG[lang]
  if (!config) {
    console.log(`  No Tatoeba data available for ${lang}`)
    return []
  }

  const cachePath = `${CACHE_DIR}/tatoeba-${config.code}.txt`

  // Check cache
  if (existsSync(cachePath)) {
    console.log(`  Using cached: ${cachePath}`)
    const text = await Bun.file(cachePath).text()
    return parseTatoebaFile(text, lang)
  }

  // Download
  console.log(`  Downloading: ${config.url}`)

  const response = await fetch(config.url, {
    headers: { 'User-Agent': 'yori-dict-importer' },
  })

  if (!response.ok) {
    throw new Error(`Failed to download ${lang}: ${response.status}`)
  }

  // Save ZIP temporarily
  await mkdir(CACHE_DIR, { recursive: true })
  const zipPath = `${CACHE_DIR}/temp-tatoeba.zip`
  const buffer = await response.arrayBuffer()
  await Bun.write(zipPath, buffer)

  // Extract using unzip
  const proc = Bun.spawn(['unzip', '-p', zipPath], { stdout: 'pipe' })
  const text = await new Response(proc.stdout).text()
  await proc.exited

  // Clean up ZIP and cache text
  unlinkSync(zipPath)
  await Bun.write(cachePath, text)
  console.log(`  Cached to: ${cachePath}`)

  return parseTatoebaFile(text, lang)
}

function parseTatoebaFile(text: string, lang: string): TatoebaSentence[] {
  const sentences: TatoebaSentence[] = []
  const lines = text.trim().split('\n')

  for (const line of lines) {
    if (!line.trim()) continue

    const parts = line.split('\t')
    if (parts.length < 2) continue

    // manythings.org format: English + TAB + Japanese + TAB + Attribution
    // For German-Japanese: German + TAB + Japanese + TAB + Attribution
    // We need to detect which column is Japanese
    let japanese: string
    let translation: string

    // Japanese text contains Japanese characters
    const isJapanese = (s: string) => /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(s)

    if (isJapanese(parts[0])) {
      // First column is Japanese (jpn-eng format)
      japanese = parts[0]
      translation = parts[1]
    } else if (isJapanese(parts[1])) {
      // Second column is Japanese (deu-jpn format)
      japanese = parts[1]
      translation = parts[0]
    } else {
      // Skip if no Japanese found
      continue
    }

    sentences.push({
      japanese,
      translation,
      attribution: parts[2] || 'tatoeba',
    })
  }

  return sentences
}

// ============================================================================
// Build Word Index
// ============================================================================

interface WordIndex {
  // Map from word/reading to entry keys
  wordToKeys: Map<string, Set<string>>
  // All entries keyed by their key
  entries: Record<string, DictEntry>
}

function buildWordIndex(dict: DictFile): WordIndex {
  const wordToKeys = new Map<string, Set<string>>()

  for (const [key, entry] of Object.entries(dict.entries)) {
    // Index by word (kanji form)
    const wordKeys = wordToKeys.get(entry.word) || new Set()
    wordKeys.add(key)
    wordToKeys.set(entry.word, wordKeys)

    // Also index by reading if different from word
    if (entry.reading !== entry.word) {
      const readingKeys = wordToKeys.get(entry.reading) || new Set()
      readingKeys.add(key)
      wordToKeys.set(entry.reading, readingKeys)
    }
  }

  return {
    wordToKeys,
    entries: dict.entries,
  }
}

// ============================================================================
// Match Sentences to Dictionary Entries
// ============================================================================

interface MatchResult {
  key: string
  sentence: TatoebaSentence
}

/**
 * Extract all possible substrings from Japanese text as candidate words
 * Only extracts substrings that contain Japanese characters
 */
function extractCandidateWords(text: string, minLen: number, maxLen: number): Set<string> {
  const candidates = new Set<string>()
  const japaneseRegex = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/

  for (let i = 0; i < text.length; i++) {
    for (let len = minLen; len <= Math.min(maxLen, text.length - i); len++) {
      const substr = text.substring(i, i + len)
      // Only include if it contains Japanese characters
      if (japaneseRegex.test(substr)) {
        candidates.add(substr)
      }
    }
  }

  return candidates
}

function findMatchingEntries(
  sentence: TatoebaSentence,
  index: WordIndex,
  minWordLength: number = 2,
  maxWordLength: number = 10
): MatchResult[] {
  const results: MatchResult[] = []
  const seenKeys = new Set<string>()

  // Extract candidate words from sentence (much faster than checking all dict words)
  const candidates = extractCandidateWords(sentence.japanese, minWordLength, maxWordLength)

  // Look up each candidate in the index
  for (const candidate of candidates) {
    const keys = index.wordToKeys.get(candidate)
    if (keys) {
      for (const key of keys) {
        if (!seenKeys.has(key)) {
          seenKeys.add(key)
          results.push({ key, sentence })
        }
      }
    }
  }

  return results
}

// ============================================================================
// Import Examples into Dictionary
// ============================================================================

interface ImportStats {
  sentencesProcessed: number
  matchesFound: number
  entriesUpdated: number
  examplesAdded: number
}

function importExamples(
  dict: DictFile,
  sentences: TatoebaSentence[],
  maxExamples: number,
  mode: ImportMode
): ImportStats {
  const stats: ImportStats = {
    sentencesProcessed: 0,
    matchesFound: 0,
    entriesUpdated: 0,
    examplesAdded: 0,
  }

  // Build word index
  console.log('  Building word index...')
  const index = buildWordIndex(dict)
  console.log(`  Indexed ${index.wordToKeys.size.toLocaleString()} unique words/readings`)

  // Track examples per entry to respect maxExamples limit
  const exampleCounts = new Map<string, number>()

  // Initialize counts from existing examples
  for (const [key, entry] of Object.entries(dict.entries)) {
    exampleCounts.set(key, entry.examples.length)
  }

  // Process sentences
  console.log('  Matching sentences to entries...')
  const updateInterval = Math.max(1, Math.floor(sentences.length / 10))

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i]
    stats.sentencesProcessed++

    if (i > 0 && i % updateInterval === 0) {
      process.stdout.write(`\r  Processed ${i.toLocaleString()}/${sentences.length.toLocaleString()}...`)
    }

    // Find matching dictionary entries
    const matches = findMatchingEntries(sentence, index)
    stats.matchesFound += matches.length

    for (const match of matches) {
      const currentCount = exampleCounts.get(match.key) || 0

      // Skip if already have enough examples
      if (currentCount >= maxExamples) continue

      // Create example
      const newExample: Example = {
        ja: match.sentence.japanese,
        text: match.sentence.translation,
        sources: ['tatoeba'],
      }

      // Check if this exact example already exists
      const entry = dict.entries[match.key]
      const exists = entry.examples.some(
        (ex) => ex.ja === newExample.ja && ex.text === newExample.text
      )

      if (exists) continue

      // Add example
      if (mode !== 'diff') {
        entry.examples.push(newExample)
      }

      exampleCounts.set(match.key, currentCount + 1)
      stats.examplesAdded++
    }
  }

  console.log('') // Clear progress line

  // Count entries that received new examples in this run
  const entriesWithNewExamples = new Set<string>()
  for (const [key, entry] of Object.entries(dict.entries)) {
    const hasTatoebaExamples = entry.examples.some((ex) => ex.sources.includes('tatoeba'))
    if (hasTatoebaExamples) {
      entriesWithNewExamples.add(key)
    }
  }
  stats.entriesUpdated = entriesWithNewExamples.size

  return stats
}

// ============================================================================
// Main Import Function
// ============================================================================

async function importTatoeba(
  langs: string[],
  mode: ImportMode,
  maxExamples: number
): Promise<void> {
  console.log('=== Tatoeba Examples Importer ===')
  console.log(`Languages: ${langs.join(', ')}`)
  console.log(`Mode: ${mode}`)
  console.log(`Max examples per word: ${maxExamples}`)

  for (const lang of langs) {
    console.log(`\n=== Processing ${lang} ===`)

    // Check if language file exists
    const dictPath = `${DATA_DIR}/${lang}.json`
    if (!existsSync(dictPath)) {
      console.log(`  Dictionary file not found: ${dictPath}`)
      console.log('  Skipping...')
      continue
    }

    // Download Tatoeba data
    console.log('\nDownloading Tatoeba data...')
    const sentences = await downloadTatoeba(lang)

    if (sentences.length === 0) {
      console.log('  No sentences available for this language')
      continue
    }

    console.log(`  Loaded ${sentences.length.toLocaleString()} sentence pairs`)

    // Load dictionary
    console.log('\nLoading dictionary...')
    const dict = await loadDict(dictPath, lang)
    console.log(`  Entries: ${Object.keys(dict.entries).length.toLocaleString()}`)

    // Import examples
    console.log('\nImporting examples...')
    const stats = importExamples(dict, sentences, maxExamples, mode)

    // Print stats
    console.log('\nResults:')
    console.log(`  Sentences processed: ${stats.sentencesProcessed.toLocaleString()}`)
    console.log(`  Matches found: ${stats.matchesFound.toLocaleString()}`)
    console.log(`  Examples added: ${stats.examplesAdded.toLocaleString()}`)
    console.log(`  Entries with examples: ${stats.entriesUpdated.toLocaleString()}`)

    if (mode !== 'diff' && stats.examplesAdded > 0) {
      await saveDict(dictPath, dict)
      console.log(`\nSaved to: ${dictPath}`)
    } else if (mode === 'diff') {
      console.log('\n(Diff mode - no changes made)')
    }
  }
}

// ============================================================================
// CLI
// ============================================================================

function printHelp(): void {
  console.log(`
Tatoeba Examples Importer

Adds example sentences from Tatoeba to dictionary entries.
Data source: https://www.manythings.org/anki/ (Tatoeba Project)

Usage:
  bun run import:tatoeba [options]

Options:
  --lang    Comma-separated language codes (default: all available)
            Supported: en, de
  --mode    Import mode (default: merge)
            merge - Add examples to entries
            diff  - Preview changes, no modifications
  --limit   Maximum examples per word (default: ${DEFAULT_MAX_EXAMPLES})

Examples:
  bun run import:tatoeba
  bun run import:tatoeba --lang en
  bun run import:tatoeba --mode diff
  bun run import:tatoeba --limit 5
`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // Find available languages
  const availableLangs = readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json') && !f.includes('/'))
    .map((f) => f.replace('.json', ''))
    .filter((lang) => LANG_CONFIG[lang])

  let langs: string[] = availableLangs
  let mode: ImportMode = 'merge'
  let maxExamples = DEFAULT_MAX_EXAMPLES

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--lang' && next) {
      langs = next.split(',').map((s) => s.trim())
      i++
    } else if (arg === '--mode' && next) {
      if (next === 'merge' || next === 'diff') {
        mode = next
      } else {
        console.error(`Invalid mode: ${next}`)
        console.error('Supported modes: merge, diff')
        process.exit(1)
      }
      i++
    } else if (arg === '--limit' && next) {
      maxExamples = parseInt(next, 10)
      if (isNaN(maxExamples) || maxExamples < 1) {
        console.error(`Invalid limit: ${next}`)
        process.exit(1)
      }
      i++
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      return
    }
  }

  if (langs.length === 0) {
    console.error('No languages with Tatoeba data available.')
    console.error('Supported: en, de')
    process.exit(1)
  }

  await importTatoeba(langs, mode, maxExamples)

  console.log('\n=== Import Complete ===')
}

main().catch((err) => {
  console.error('Import failed:', err)
  process.exit(1)
})
