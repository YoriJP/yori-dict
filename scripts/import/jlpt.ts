/**
 * JLPT Level Importer - Enriches core.json with JLPT levels (N5-N1)
 *
 * Data source: https://github.com/stephenmk/yomitan-jlpt-vocab
 * License: CC-BY-SA-4.0
 *
 * Writes: data/core.json (jlpt field only)
 *
 * Usage:
 *   bun run import:jlpt
 *   bun run import:jlpt --level 5        # Only N5
 *   bun run import:jlpt --level 5,4,3    # N5, N4, N3
 *   bun run import:jlpt --mode diff      # Preview changes
 */

import { mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import {
  makeKey,
  loadCore,
  saveCore,
} from './base'

// ============================================================================
// Configuration
// ============================================================================

const DATA_DIR = './data'
const CORE_PATH = `${DATA_DIR}/core.json`
const CACHE_DIR = './data/cache'

const JLPT_BASE_URL = 'https://raw.githubusercontent.com/stephenmk/yomitan-jlpt-vocab/main/original_data'
const JLPT_LEVELS = [5, 4, 3, 2, 1] as const
type JlptLevel = (typeof JLPT_LEVELS)[number]

// ============================================================================
// Types
// ============================================================================

interface JlptCsvEntry {
  jmdict_seq: string
  kana: string
  kanji: string
  waller_definition: string
}

type ImportMode = 'merge' | 'diff' | 'refresh'

// ============================================================================
// Download Functions
// ============================================================================

async function downloadJlptLevel(level: JlptLevel): Promise<JlptCsvEntry[]> {
  const cachePath = `${CACHE_DIR}/jlpt-n${level}.csv`

  if (existsSync(cachePath)) {
    console.log(`  Using cached: ${cachePath}`)
    const text = await Bun.file(cachePath).text()
    return parseJlptCsv(text)
  }

  const url = `${JLPT_BASE_URL}/n${level}.csv`
  console.log(`  Downloading: ${url}`)

  const response = await fetch(url, {
    headers: { 'User-Agent': 'yori-dict-importer' },
  })

  if (!response.ok) {
    throw new Error(`Failed to download N${level}: ${response.status}`)
  }

  const text = await response.text()

  await mkdir(CACHE_DIR, { recursive: true })
  await Bun.write(cachePath, text)
  console.log(`  Cached to: ${cachePath}`)

  return parseJlptCsv(text)
}

function parseJlptCsv(text: string): JlptCsvEntry[] {
  const lines = text.trim().split('\n')
  const entries: JlptCsvEntry[] = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue

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
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
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

async function buildJlptMap(levels: JlptLevel[]): Promise<Map<string, number>> {
  console.log('\n=== Downloading JLPT Data ===')

  // Map key → highest JLPT level number
  const jlptMap = new Map<string, number>()

  for (const level of levels) {
    console.log(`\nN${level}:`)
    const entries = await downloadJlptLevel(level)
    console.log(`  Loaded ${entries.length.toLocaleString()} entries`)

    for (const entry of entries) {
      const word = entry.kanji || entry.kana
      const reading = entry.kana
      const key = makeKey(word, reading)

      const existing = jlptMap.get(key)
      // Keep the highest (easiest) level number
      if (existing === undefined || level > existing) {
        jlptMap.set(key, level)
      }
    }
  }

  console.log(`\nTotal unique words: ${jlptMap.size.toLocaleString()}`)
  return jlptMap
}

// ============================================================================
// Enrich Core with JLPT Levels
// ============================================================================

interface EnrichStats {
  matched: number
  alreadyHad: number
  updated: number
  notFound: number
}

function enrichCoreWithJlpt(
  coreEntries: Record<string, { jlpt: number | null }>,
  jlptMap: Map<string, number>,
  mode: ImportMode
): EnrichStats {
  const stats: EnrichStats = {
    matched: 0,
    alreadyHad: 0,
    updated: 0,
    notFound: 0,
  }

  for (const [key, entry] of Object.entries(coreEntries)) {
    const level = jlptMap.get(key)

    if (level !== undefined) {
      stats.matched++

      if (entry.jlpt === level) {
        stats.alreadyHad++
      } else {
        stats.updated++
        if (mode !== 'diff') {
          entry.jlpt = level
        }
      }
    }
  }

  for (const key of jlptMap.keys()) {
    if (!coreEntries[key]) {
      stats.notFound++
    }
  }

  return stats
}

// ============================================================================
// Main Import Function
// ============================================================================

async function importJlpt(levels: JlptLevel[], mode: ImportMode): Promise<void> {
  console.log('=== [Enrichment] JLPT Level Importer ===')
  console.log(`Levels: N${levels.join(', N')}`)
  console.log(`Mode: ${mode}`)

  const jlptMap = await buildJlptMap(levels)

  if (!existsSync(CORE_PATH)) {
    console.error('\ncore.json not found in data/')
    console.error('This is an enrichment importer — run base importers first:')
    console.error('  bun run import:jmdict --lang en')
    console.error('  (or: bun run rebuild:all for a full rebuild)')
    process.exit(1)
  }

  console.log(`\n=== Processing core.json ===`)
  const core = await loadCore(CORE_PATH)
  console.log(`Entries: ${Object.keys(core.entries).length.toLocaleString()}`)

  if (mode === 'refresh') {
    // Clear all jlpt values before re-applying
    console.log('  Resetting JLPT levels...')
    for (const entry of Object.values(core.entries)) {
      entry.jlpt = null
    }
  }

  const stats = enrichCoreWithJlpt(core.entries, jlptMap, mode === 'refresh' ? 'merge' : mode)

  console.log('\nResults:')
  console.log(`  Matched: ${stats.matched.toLocaleString()}`)
  console.log(`  Already had JLPT: ${stats.alreadyHad.toLocaleString()}`)
  console.log(`  Updated: ${stats.updated.toLocaleString()}`)
  console.log(`  JLPT words not in core: ${stats.notFound.toLocaleString()}`)

  if (mode === 'refresh') {
    await saveCore(CORE_PATH, core)
    console.log(`\nSaved to: ${CORE_PATH}`)
  } else if (mode !== 'diff' && stats.updated > 0) {
    await saveCore(CORE_PATH, core)
    console.log(`\nSaved to: ${CORE_PATH}`)
  } else if (mode === 'diff') {
    console.log('\n(Diff mode - no changes made)')
  }
}

// ============================================================================
// CLI
// ============================================================================

function printHelp(): void {
  console.log(`
JLPT Level Importer

Enriches core.json entries with JLPT levels (N5-N1).
Data source: https://github.com/stephenmk/yomitan-jlpt-vocab

Usage:
  bun run import:jlpt [options]

Options:
  --level   Comma-separated JLPT levels (default: all)
            Examples: --level 5 (N5 only)
                      --level 5,4,3 (N5, N4, N3)
  --mode    Import mode (default: merge)
            merge   - Update entries with JLPT levels
            diff    - Preview changes, no modifications
            refresh - Reset all JLPT levels and re-apply

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
      if (next === 'merge' || next === 'diff' || next === 'refresh') {
        mode = next
      } else {
        console.error(`Invalid mode: ${next}`)
        console.error('Supported modes: merge, diff, refresh')
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
