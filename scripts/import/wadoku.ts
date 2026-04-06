/**
 * Wadoku Importer - Enriches lang/de.json with Wadoku definitions
 *
 * Data source: https://github.com/WaDoku/WaDokuJT-Data
 * License: CC-BY-SA 3.0
 *
 * Writes: data/lang/de.json
 *
 * Usage:
 *   bun run import:wadoku
 *   bun run import:wadoku --mode diff    # Preview changes
 */

import { mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import {
  type DuplicateConflictPolicyInput,
  makeKey,
  loadLang,
  saveLang,
  mergeLangEntries,
  refreshLangSource,
  analyzeLangDefinitionConflicts,
  resolveDuplicateConflictPolicy,
} from './base'

// ============================================================================
// Configuration
// ============================================================================

const LANG_DIR = './data/lang'
const CACHE_DIR = './data/cache'

const WADOKU_URL = 'https://raw.githubusercontent.com/WaDoku/WaDokuJT-Data/master/WaDokuTest.tab'

type ImportMode = 'merge' | 'diff' | 'refresh'

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

  if (existsSync(cachePath)) {
    console.log(`  Using cached: ${cachePath}`)
    return Bun.file(cachePath).text()
  }

  console.log(`  Downloading: ${WADOKU_URL}`)

  const response = await fetch(WADOKU_URL, {
    headers: { 'User-Agent': 'yori-dict-importer' },
  })

  if (!response.ok) {
    throw new Error(`Failed to download Wadoku: ${response.status}`)
  }

  const text = await response.text()

  await mkdir(CACHE_DIR, { recursive: true })
  await Bun.write(cachePath, text)
  console.log(`  Cached to: ${cachePath}`)

  return text
}

// ============================================================================
// Parsing Functions
// ============================================================================

function extractTranslations(markup: string): string[] {
  const flattenMarkup = (text: string): string => {
    let cleaned = text
    let prev = ''

    while (prev !== cleaned) {
      prev = cleaned
      cleaned = cleaned.replace(/<[^>]*:\s*([^<>]*)>/g, '$1')
      cleaned = cleaned.replace(/<[^>]+>/g, ' ')
    }

    return cleaned.replace(/\s+/g, ' ').trim()
  }

  const translations: string[] = []
  const trePattern = /<TrE:\s*((?:[^<>]|<[^>]*>)*)>/g
  let match

  while ((match = trePattern.exec(markup)) !== null) {
    const text = flattenMarkup(match[1])
    if (text.length >= 2 && !text.includes('<')) {
      translations.push(text)
    }
  }

  return [...new Set(translations)]
}

function parseJapanese(text: string): { word: string; variants: string[] } {
  let cleaned = text.replace(/\s*\[\d+\]/g, '')
  cleaned = cleaned.replace(/\s*\([^)]+\)/g, '')
  const parts = cleaned.split(/[;；]/).map((s) => s.trim()).filter(Boolean)

  return {
    word: parts[0] || '',
    variants: parts.slice(1),
  }
}

function parseReading(text: string): string {
  let cleaned = text.replace(/\s*\[\d+\]/g, '')
  cleaned = cleaned.replace(/\[WaSep\]/g, '')
  cleaned = cleaned.replace(/\[Gr\]/g, '')
  cleaned = cleaned.replace(/\[NN\]/g, '')
  cleaned = cleaned.replace(/\[Dev\]/g, '')
  cleaned = cleaned.replace(/\[suru\]/g, '')
  cleaned = cleaned.replace(/\[KanaSep\]/g, '')
  return cleaned.trim()
}

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

    if (id === '*Japanisch' || !japaneseRaw) continue

    const { word } = parseJapanese(japaneseRaw)
    if (!word) continue

    const reading = parseReading(readingRaw)
    if (!reading) continue

    const definitions = extractTranslations(definitionMarkup)
    if (definitions.length === 0) continue

    entries.push({ id, japanese: word, reading, definitions, partOfSpeech: posRaw })
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
  sourceEntries: number
}

function buildWadokuSourceEntries(
  langEntries: Record<string, import('./base').LangEntry>,
  wadokuEntries: WadokuEntry[]
): { sourceEntries: Record<string, { definitions: string[] }>; stats: ImportStats } {
  const sourceEntries: Record<string, { definitions: string[] }> = {}
  const stats: ImportStats = {
    wadokuEntries: wadokuEntries.length,
    matched: 0,
    newDefinitions: 0,
    sourceEntries: 0,
  }

  // Build lookup map (word/reading → keys)
  const wordMap = new Map<string, string[]>()
  for (const key of Object.keys(langEntries)) {
    const [word, reading] = key.split(':')
    const wordKeys = wordMap.get(word) || []
    wordKeys.push(key)
    wordMap.set(word, wordKeys)

    if (reading !== word) {
      const readingKeys = wordMap.get(reading) || []
      readingKeys.push(key)
      wordMap.set(reading, readingKeys)
    }
  }

  for (const wadoku of wadokuEntries) {
    const key = makeKey(wadoku.japanese, wadoku.reading)
    let entryKey = langEntries[key] ? key : undefined

    if (!entryKey) {
      const candidates = wordMap.get(wadoku.japanese) || wordMap.get(wadoku.reading)
      if (candidates && candidates.length === 1) {
        entryKey = candidates[0]
      }
    }

    if (!entryKey) continue

    stats.matched++
    const existingDefs = langEntries[entryKey].definitions
    const target = sourceEntries[entryKey] ?? { definitions: [] }

    for (const defText of wadoku.definitions) {
      const normalized = defText.toLowerCase().trim()
      const alreadyPresentInExisting = existingDefs.some((d) => d.toLowerCase().trim() === normalized)
      const alreadyPresentInSource = target.definitions.some((d) => d.toLowerCase().trim() === normalized)
      const alreadyPresent = alreadyPresentInExisting || alreadyPresentInSource
      if (!alreadyPresent) {
        target.definitions.push(defText)
        stats.newDefinitions++
      }
    }
    if (target.definitions.length > 0) {
      sourceEntries[entryKey] = target
    }
  }

  stats.sourceEntries = Object.keys(sourceEntries).length
  return { sourceEntries, stats }
}

// ============================================================================
// Main Import Function
// ============================================================================

async function runImport(
  mode: ImportMode,
  duplicatePolicyInput: DuplicateConflictPolicyInput,
  duplicateSamples: number
): Promise<void> {
  console.log('=== [Enrichment] Wadoku German Importer ===')
  console.log(`Mode: ${mode}`)

  const langPath = `${LANG_DIR}/de.json`
  if (!existsSync(langPath)) {
    console.error(`\nGerman lang file not found: ${langPath}`)
    console.error('This is an enrichment importer — run base importers first:')
    console.error('  bun run import:jmdict --lang de')
    process.exit(1)
  }

  console.log('\nDownloading Wadoku data...')
  const wadokuText = await downloadWadoku()

  console.log('\nParsing Wadoku entries...')
  const wadokuEntries = parseWadokuFile(wadokuText)
  console.log(`  Parsed ${wadokuEntries.length.toLocaleString()} entries`)

  console.log('\nLoading German lang file...')
  const lang = await loadLang(langPath, 'de')
  console.log(`  Entries: ${Object.keys(lang.entries).length.toLocaleString()}`)

  if (mode === 'refresh') {
    console.log('  Stripping existing wadoku definitions...')
    refreshLangSource(lang.entries, 'wadoku')
    console.log('  Done.')
  }

  console.log('\nBuilding Wadoku source entries...')
  const { sourceEntries, stats } = buildWadokuSourceEntries(lang.entries, wadokuEntries)
  const effectiveMode = mode === 'refresh' ? 'merge' : mode
  const conflictPolicy = await resolveDuplicateConflictPolicy(
    'wadoku/de',
    duplicatePolicyInput,
    analyzeLangDefinitionConflicts(lang.entries, sourceEntries, duplicateSamples)
  )
  const mergeStats = mergeLangEntries(lang.entries, sourceEntries, 'wadoku', effectiveMode, conflictPolicy)

  console.log('\nResults:')
  console.log(`  Wadoku entries: ${stats.wadokuEntries.toLocaleString()}`)
  console.log(`  Matched to dict: ${stats.matched.toLocaleString()}`)
  console.log(`  New definitions: ${stats.newDefinitions.toLocaleString()}`)
  console.log(`  Source entries to merge: ${stats.sourceEntries.toLocaleString()}`)
  console.log(`  Merged - new: ${mergeStats.added.toLocaleString()}, updated: ${mergeStats.updated.toLocaleString()}, unchanged: ${mergeStats.unchanged.toLocaleString()}`)

  if (mode !== 'diff' && (mergeStats.added > 0 || mergeStats.updated > 0 || mode === 'refresh')) {
    await saveLang(langPath, lang)
    console.log(`\nSaved to: ${langPath}`)
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

Enriches German lang file with additional definitions from Wadoku.
Data source: https://github.com/WaDoku/WaDokuJT-Data

Usage:
  bun run import:wadoku [options]

Options:
  --mode    Import mode (default: merge)
            merge   - Add new definitions to entries
            diff    - Preview changes, no modifications
            refresh - Strip and re-import only wadoku data
  --dup-policy   merge | skip | replace | ask (default: merge)
  --dup-samples  How many conflict samples to show in ask mode (default: 5)

Examples:
  bun run import:wadoku
  bun run import:wadoku --mode diff
`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  let mode: ImportMode = 'merge'
  let duplicatePolicy: DuplicateConflictPolicyInput = 'merge'
  let duplicateSamples = 5

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
    } else if (arg === '--dup-policy' && next) {
      if (['merge', 'skip', 'replace', 'ask'].includes(next)) {
        duplicatePolicy = next as DuplicateConflictPolicyInput
      } else {
        console.error(`Invalid --dup-policy: ${next}`)
        process.exit(1)
      }
      i++
    } else if (arg === '--dup-samples' && next) {
      duplicateSamples = parseInt(next, 10)
      if (Number.isNaN(duplicateSamples) || duplicateSamples < 1) {
        console.error(`Invalid --dup-samples: ${next}`)
        process.exit(1)
      }
      i++
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      return
    }
  }

  console.log(`Duplicate policy: ${duplicatePolicy}`)
  await runImport(mode, duplicatePolicy, duplicateSamples)
  console.log('\n=== Import Complete ===')
}

main().catch((err) => {
  console.error('Import failed:', err)
  process.exit(1)
})
