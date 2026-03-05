/**
 * JPDB Frequency Importer - Adds frequency ranks to Japanese dictionary entries
 *
 * Source: https://github.com/MarvNC/jpdb-freq-list
 * License: CC BY-NC-SA 4.0 (non-commercial use only)
 * Coverage: ~470k entries from light novels, anime, and visual novels
 *
 * The JPDB frequency list uses Yomichan format 3:
 *   ["word","freq",{"value":N}]                           // kana-only
 *   ["word","freq",{"reading":"kana","frequency":{"value":N}}]  // kanji+reading
 *
 * Usage:
 *   bun run import:frequency
 *   bun run import:frequency --mode diff
 *   bun run import:frequency --mode refresh
 */

import { mkdir } from 'fs/promises'
import { existsSync, createWriteStream, renameSync, unlinkSync } from 'fs'
import {
  type DictEntry,
  loadDict,
  saveDict,
  downloadWithProgress,
} from './base'

// ============================================================================
// Configuration
// ============================================================================

const DATA_DIR = './data'
const CACHE_DIR = './data/cache'
const JPDB_ZIP_URL =
  'https://github.com/MarvNC/jpdb-freq-list/releases/download/2022-05-09/Freq.JPDB_2022-05-10T03_27_02.930Z.zip'
const JPDB_ZIP_PATH = `${CACHE_DIR}/jpdb-freq.zip`
const JPDB_TXT_PATH = `${CACHE_DIR}/jpdb-freq.txt`

type ImportMode = 'merge' | 'diff' | 'refresh'

// ============================================================================
// Types
// ============================================================================

// Map of word:reading → frequency rank (1 = most common)
type FreqIndex = Map<string, number>

// ============================================================================
// Download & Extract
// ============================================================================

async function downloadJpdb(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true })
  if (existsSync(JPDB_ZIP_PATH)) {
    console.log(`  Using cached: ${JPDB_ZIP_PATH}`)
    return
  }
  await downloadWithProgress(JPDB_ZIP_URL, JPDB_ZIP_PATH)
}

async function extractJpdb(): Promise<void> {
  if (existsSync(JPDB_TXT_PATH)) {
    console.log(`  Using cached: ${JPDB_TXT_PATH}`)
    return
  }

  console.log('  Extracting JPDB frequency data...')
  const tmpPath = JPDB_TXT_PATH + '.tmp'

  try {
    // Extract only the term_meta_bank file (the large one with frequency entries)
    const proc = Bun.spawn(
      ['unzip', '-p', JPDB_ZIP_PATH, 'term_meta_bank_1.json'],
      { stderr: 'inherit' }
    )
    const writer = createWriteStream(tmpPath)
    const reader = proc.stdout.getReader()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      writer.write(value)
    }
    await new Promise<void>((resolve, reject) => {
      writer.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })
    await proc.exited

    renameSync(tmpPath, JPDB_TXT_PATH)
    console.log(`  Wrote: ${JPDB_TXT_PATH}`)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch {}
    throw err
  }
}

// ============================================================================
// Parse JPDB Yomichan format 3
// ============================================================================

/**
 * Build a word:reading → rank map from the JPDB frequency file.
 *
 * File is a single-line JSON array in Yomichan format 3:
 *   [["word","freq",{"value":N}], ...]                            // kana-only
 *   [["word","freq",{"reading":"r","frequency":{"value":N}}], ...] // kanji+reading
 */
async function buildFreqIndex(): Promise<FreqIndex> {
  console.log('  Building frequency index...')
  const index: FreqIndex = new Map()
  let count = 0

  const raw = await Bun.file(JPDB_TXT_PATH).text()
  const entries: unknown[] = JSON.parse(raw)

  for (const entry of entries) {
    if (!Array.isArray(entry) || entry[1] !== 'freq') continue

    const word: string = entry[0]
    const meta = entry[2]

    let rank: number
    let reading: string

    if (typeof meta?.reading === 'string' && typeof meta?.frequency?.value === 'number') {
      // Kanji+reading entry: {"reading":"kana","frequency":{"value":N}}
      rank = meta.frequency.value
      reading = meta.reading
    } else if (typeof meta?.value === 'number') {
      // Kana-only entry: {"value":N}
      rank = meta.value
      reading = word
    } else {
      continue
    }

    const key = `${word}:${reading}`
    // Keep the better (lower) rank if we see duplicates
    const existing = index.get(key)
    if (existing === undefined || rank < existing) {
      index.set(key, rank)
    }
    count++
  }

  console.log(`  Indexed ${count.toLocaleString()} entries (${index.size.toLocaleString()} unique word:reading pairs)`)
  return index
}

// ============================================================================
// Import logic
// ============================================================================

interface ImportStats {
  total: number
  matched: number
  enriched: number
}

function importFrequency(
  dict: Record<string, DictEntry>,
  index: FreqIndex,
  mode: ImportMode
): ImportStats {
  const stats: ImportStats = { total: 0, matched: 0, enriched: 0 }

  for (const [key, entry] of Object.entries(dict)) {
    stats.total++

    // Strip existing frequency in refresh mode
    if (mode === 'refresh') {
      entry.frequency = undefined
    }

    const rank = index.get(key)
    if (rank === undefined) continue
    stats.matched++

    if (mode !== 'diff') {
      if (!entry.frequency || rank < entry.frequency.rank) {
        entry.frequency = { rank, sources: ['jpdb'] }
        stats.enriched++
      } else if (entry.frequency && !entry.frequency.sources.includes('jpdb')) {
        entry.frequency.sources.push('jpdb')
        stats.enriched++
      }
    } else {
      stats.enriched++
    }
  }

  return stats
}

// ============================================================================
// Main
// ============================================================================

async function importFrequencyData(mode: ImportMode): Promise<void> {
  console.log('=== [Enrichment] JPDB Frequency Importer ===')
  console.log(`Mode: ${mode}`)

  await downloadJpdb()
  await extractJpdb()

  const index = await buildFreqIndex()

  // Frequency is language-agnostic — apply to whichever dict file exists
  // Use en.json as the canonical source (all langs share the same word:reading key)
  const enPath = `${DATA_DIR}/en.json`
  if (!existsSync(enPath)) {
    console.error('en.json not found — run import:jmdict first')
    process.exit(1)
  }

  console.log('\n=== Processing en (canonical frequency store) ===')
  const dict = await loadDict(enPath, 'en')
  console.log(`  Entries: ${Object.keys(dict.entries).length.toLocaleString()}`)

  const stats = importFrequency(dict.entries, index, mode)

  console.log(`  Scanned: ${stats.total.toLocaleString()}`)
  console.log(`  Word:reading matches: ${stats.matched.toLocaleString()}`)
  console.log(`  Entries enriched: ${stats.enriched.toLocaleString()}`)

  if (mode === 'diff') {
    console.log('  (Diff mode — no changes written)')
  } else if (stats.enriched > 0 || mode === 'refresh') {
    await saveDict(enPath, dict)
    console.log(`  Saved: ${enPath}`)
  } else {
    console.log('  No changes to write.')
  }
}

// ============================================================================
// CLI
// ============================================================================

function printHelp(): void {
  console.log(`
JPDB Frequency Importer

Adds frequency ranks to Japanese dictionary entries using the JPDB frequency
list (~470k entries from light novels, anime, and visual novels).

Frequency is stored in en.json only (language-agnostic field) and exposed
through the API as a numeric rank (1 = most common).

License note: JPDB data is CC BY-NC-SA 4.0 (non-commercial use only).

Usage:
  bun run import:frequency [options]

Options:
  --mode    Import mode (default: merge)
            merge   - Add frequency ranks to unranked entries
            diff    - Preview changes, no modifications
            refresh - Strip existing ranks and re-import
`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    return
  }

  await mkdir(DATA_DIR, { recursive: true })

  let mode: ImportMode = 'merge'

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]
    if (arg === '--mode' && next) {
      if (next === 'merge' || next === 'diff' || next === 'refresh') {
        mode = next
      } else {
        console.error(`Invalid mode: ${next}`)
        process.exit(1)
      }
      i++
    }
  }

  await importFrequencyData(mode)
  console.log('\n=== Import Complete ===')
}

main().catch((err) => {
  console.error('Import failed:', err)
  process.exit(1)
})
