/**
 * JLPT Level Importer - Enriches dictionary entries with JLPT levels (N5-N1)
 *
 * Data source: https://github.com/stephenmk/yomitan-jlpt-vocab
 * License: CC-BY-SA-4.0
 *
 * Usage:
 *   bun run import:jlpt
 *   bun run import:jlpt --level 5        # Only N5
 *   bun run import:jlpt --level 5,4,3    # N5, N4, N3
 *   bun run import:jlpt --mode diff      # Preview changes
 */

import { mkdir } from 'fs/promises'
import { existsSync, readdirSync } from 'fs'
import {
  type DictEntry,
  type DictFile,
  makeKey,
  loadDict,
  saveDict,
} from './base'

// ============================================================================
// Configuration
// ============================================================================

const DATA_DIR = './data'
const CACHE_DIR = './data/cache'

// Data source URLs
const JLPT_BASE_URL = 'https://raw.githubusercontent.com/stephenmk/yomitan-jlpt-vocab/main/original_data'
const JLPT_LEVELS = [5, 4, 3, 2, 1] as const
type JlptLevel = (typeof JLPT_LEVELS)[number]

// ============================================================================
// Types
// ============================================================================

interface JlptEntry {
  jmdict_seq: string
  kana: string
  kanji: string
  waller_definition: string
}

interface JlptVocab {
  word: string
  reading: string
  level: JlptLevel
}

type ImportMode = 'merge' | 'diff'

// ============================================================================
// Download Functions
// ============================================================================

async function downloadJlptLevel(level: JlptLevel): Promise<JlptEntry[]> {
  const cachePath = `${CACHE_DIR}/jlpt-n${level}.csv`

  // Check cache
  if (existsSync(cachePath)) {
    console.log(`  Using cached: ${cachePath}`)
    const text = await Bun.file(cachePath).text()
    return parseJlptCsv(text)
  }

  // Download
  const url = `${JLPT_BASE_URL}/n${level}.csv`
  console.log(`  Downloading: ${url}`)

  const response = await fetch(url, {
    headers: { 'User-Agent': 'yori-dict-importer' },
  })

  if (!response.ok) {
    throw new Error(`Failed to download N${level}: ${response.status}`)
  }

  const text = await response.text()

  // Cache for future use
  await mkdir(CACHE_DIR, { recursive: true })
  await Bun.write(cachePath, text)
  console.log(`  Cached to: ${cachePath}`)

  return parseJlptCsv(text)
}

function parseJlptCsv(text: string): JlptEntry[] {
  const lines = text.trim().split('\n')
  const entries: JlptEntry[] = []

  // Skip header row
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue

    // Parse CSV - handle quoted fields with commas
    const fields = parseCsvLine(line)
    if (fields.length >= 4) {
      entries.push({
        jmdict_seq: fields[0],
        kana: fields[1],
        kanji: fields[2],
        waller_definition: fields[3],
      })
    }
  }

  return entries
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === ',' && !inQuotes) {
      fields.push(current)
      current = ''
    } else {
      current += char
    }
  }

  fields.push(current)
  return fields
}

// ============================================================================
// Build JLPT Vocabulary Map
// ============================================================================

async function buildJlptMap(levels: JlptLevel[]): Promise<Map<string, JlptLevel[]>> {
  console.log('\n=== Downloading JLPT Data ===')

  const jlptMap = new Map<string, JlptLevel[]>()

  for (const level of levels) {
    console.log(`\nN${level}:`)
    const entries = await downloadJlptLevel(level)
    console.log(`  Loaded ${entries.length.toLocaleString()} entries`)

    for (const entry of entries) {
      // Use kanji if available, otherwise use kana as the word
      const word = entry.kanji || entry.kana
      const reading = entry.kana
      const key = makeKey(word, reading)

      const existing = jlptMap.get(key)
      if (existing) {
        if (!existing.includes(level)) {
          existing.push(level)
          existing.sort((a, b) => b - a) // Sort descending (N5 first)
        }
      } else {
        jlptMap.set(key, [level])
      }
    }
  }

  console.log(`\nTotal unique words: ${jlptMap.size.toLocaleString()}`)
  return jlptMap
}

// ============================================================================
// Enrich Dictionary with JLPT Levels
// ============================================================================

interface EnrichStats {
  matched: number
  alreadyHad: number
  updated: number
  notFound: number
}

function enrichDictWithJlpt(
  dict: DictFile,
  jlptMap: Map<string, JlptLevel[]>,
  mode: ImportMode
): EnrichStats {
  const stats: EnrichStats = {
    matched: 0,
    alreadyHad: 0,
    updated: 0,
    notFound: 0,
  }

  for (const [key, entry] of Object.entries(dict.entries)) {
    const levels = jlptMap.get(key)

    if (levels) {
      stats.matched++

      // Check if entry already has these levels
      const existingLevels = new Set(entry.jlpt)
      const newLevels = levels.filter((l) => !existingLevels.has(l))

      if (newLevels.length === 0) {
        stats.alreadyHad++
      } else {
        stats.updated++
        if (mode !== 'diff') {
          // Merge and sort JLPT levels (descending, so N5=5 comes first)
          const merged = [...new Set([...entry.jlpt, ...levels])]
          merged.sort((a, b) => b - a)
          entry.jlpt = merged
        }
      }
    }
  }

  // Count how many JLPT words weren't in the dictionary
  for (const key of jlptMap.keys()) {
    if (!dict.entries[key]) {
      stats.notFound++
    }
  }

  return stats
}

// ============================================================================
// Main Import Function
// ============================================================================

async function importJlpt(levels: JlptLevel[], mode: ImportMode): Promise<void> {
  console.log('=== JLPT Level Importer ===')
  console.log(`Levels: N${levels.join(', N')}`)
  console.log(`Mode: ${mode}`)

  // Build JLPT vocabulary map
  const jlptMap = await buildJlptMap(levels)

  // Find all language files
  const langFiles = readdirSync(DATA_DIR).filter(
    (f) => f.endsWith('.json') && !f.includes('/')
  )

  if (langFiles.length === 0) {
    console.error('\nNo language files found in data/')
    console.error('Run "bun run import:jmdict --lang en" first.')
    process.exit(1)
  }

  const languages = langFiles.map((f) => f.replace('.json', ''))
  console.log(`\nFound language files: ${languages.join(', ')}`)

  // Process each language file
  for (const lang of languages) {
    console.log(`\n=== Processing ${lang} ===`)

    const dictPath = `${DATA_DIR}/${lang}.json`
    const dict = await loadDict(dictPath, lang)

    console.log(`Entries: ${Object.keys(dict.entries).length.toLocaleString()}`)

    const stats = enrichDictWithJlpt(dict, jlptMap, mode)

    console.log('\nResults:')
    console.log(`  Matched: ${stats.matched.toLocaleString()}`)
    console.log(`  Already had JLPT: ${stats.alreadyHad.toLocaleString()}`)
    console.log(`  Updated: ${stats.updated.toLocaleString()}`)
    console.log(`  JLPT words not in dict: ${stats.notFound.toLocaleString()}`)

    if (mode !== 'diff' && stats.updated > 0) {
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
JLPT Level Importer

Enriches dictionary entries with JLPT levels (N5-N1).
Data source: https://github.com/stephenmk/yomitan-jlpt-vocab

Usage:
  bun run import:jlpt [options]

Options:
  --level   Comma-separated JLPT levels (default: all)
            Examples: --level 5 (N5 only)
                      --level 5,4,3 (N5, N4, N3)
  --mode    Import mode (default: merge)
            merge - Update entries with JLPT levels
            diff  - Preview changes, no modifications

Examples:
  bun run import:jlpt
  bun run import:jlpt --level 5
  bun run import:jlpt --mode diff
`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  let levels: JlptLevel[] = [...JLPT_LEVELS]
  let mode: ImportMode = 'merge'

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--level' && next) {
      levels = next
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n): n is JlptLevel => JLPT_LEVELS.includes(n as JlptLevel))
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
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      return
    }
  }

  if (levels.length === 0) {
    console.error('No valid JLPT levels specified.')
    console.error('Valid levels: 1, 2, 3, 4, 5')
    process.exit(1)
  }

  await importJlpt(levels, mode)

  console.log('\n=== Import Complete ===')
}

main().catch((err) => {
  console.error('Import failed:', err)
  process.exit(1)
})
