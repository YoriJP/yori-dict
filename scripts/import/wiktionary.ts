/**
 * Wiktionary Importer - Enriches lang/en.json with Wiktionary definitions
 *
 * Data source: https://kaikki.org/dictionary/Japanese/
 * License: CC-BY-SA 3.0 (Wiktionary) / MIT (wiktextract)
 *
 * Writes: data/lang/en.json
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
  type DuplicateConflictPolicyInput,
  type LangFile,
  makeKey,
  loadLang,
  saveLang,
  mergeLangEntries,
  refreshLangSource,
  analyzeLangDefinitionConflicts,
  resolveDuplicateConflictPolicy,
  downloadWithProgress,
} from './base'

// ============================================================================
// Configuration
// ============================================================================

const LANG_DIR = './data/lang'
const CACHE_DIR = './data/cache'

const WIKTIONARY_URL = 'https://kaikki.org/dictionary/Japanese/kaikki.org-dictionary-Japanese.jsonl'

type ImportMode = 'merge' | 'diff' | 'refresh'

const INCLUDED_POS = new Set([
  'noun', 'verb', 'adj', 'adv', 'intj', 'pron', 'conj',
  'particle', 'counter', 'prefix', 'suffix', 'affix', 'phrase', 'proverb', 'num',
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

function extractReading(entry: WiktEntry): string | null {
  if (entry.forms) {
    for (const form of entry.forms) {
      if (form.ruby && form.ruby.length > 0) {
        const reading = form.ruby.map(([_, r]) => r).join('')
        if (reading && /[\u3040-\u309F]/.test(reading)) return reading
      }
      if (form.tags?.includes('romanization')) continue
      if (form.form && /^[\u3040-\u309F]+$/.test(form.form)) return form.form
    }
  }

  if (entry.sounds) {
    for (const sound of entry.sounds) {
      if (sound.other && /^[\u30A0-\u30FF]+$/.test(sound.other)) {
        return sound.other.replace(/[\u30A1-\u30F6]/g, (c) =>
          String.fromCharCode(c.charCodeAt(0) - 0x60))
      }
    }
  }

  if (/^[\u3040-\u309F]+$/.test(entry.word)) return entry.word
  if (/^[\u30A0-\u30FF]+$/.test(entry.word)) {
    return entry.word.replace(/[\u30A1-\u30F6]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0x60))
  }

  return null
}

function extractDefinitions(entry: WiktEntry): string[] {
  const definitions: string[] = []

  if (!entry.senses) return definitions

  for (const sense of entry.senses) {
    if (sense.tags) {
      const skipTags = ['alt-of', 'form-of', 'romanization', 'Rōmaji']
      if (sense.tags.some((t) => skipTags.includes(t))) continue
    }

    const glosses = sense.glosses || sense.raw_glosses || []
    for (const gloss of glosses) {
      let cleaned = gloss
        .replace(/\s*\([^)]*\)\s*/g, ' ')
        .replace(/\s*\[[^\]]*\]\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

      if (cleaned.length < 3) continue
      if (cleaned.startsWith('synonym of')) continue
      if (cleaned.startsWith('alternative')) continue
      if (cleaned.startsWith('Rōmaji')) continue

      cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1)

      if (!definitions.includes(cleaned)) {
        definitions.push(cleaned)
      }
    }
  }

  return definitions
}

function parseWiktEntry(entry: WiktEntry): ParsedWiktEntry | null {
  if (entry.lang_code !== 'ja') return null
  if (!INCLUDED_POS.has(entry.pos)) return null

  const reading = extractReading(entry)
  if (!reading) return null

  const definitions = extractDefinitions(entry)
  if (definitions.length === 0) return null

  return { word: entry.word, reading, definitions }
}

// ============================================================================
// Stream Processing
// ============================================================================

async function* streamWiktionary(filePath: string): AsyncGenerator<WiktEntry> {
  const fileStream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      yield JSON.parse(line) as WiktEntry
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
  sourceEntries: number
}

async function importWiktionary(
  lang: LangFile,
  filePath: string,
  maxDefsPerEntry: number
): Promise<{ sourceEntries: Record<string, { definitions: string[] }>; stats: ImportStats }> {
  const sourceEntries: Record<string, { definitions: string[] }> = {}
  const stats: ImportStats = {
    wiktEntriesProcessed: 0,
    wiktEntriesParsed: 0,
    matched: 0,
    newDefinitions: 0,
    sourceEntries: 0,
  }

  // Build lookup map (word → keys, reading → keys)
  const wordMap = new Map<string, string[]>()
  for (const [key, entry] of Object.entries(lang.entries)) {
    // Parse word/reading from key
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

  console.log(`  Dictionary has ${wordMap.size.toLocaleString()} unique words/readings`)

  const updateInterval = 10000

  for await (const wiktEntry of streamWiktionary(filePath)) {
    stats.wiktEntriesProcessed++

    if (stats.wiktEntriesProcessed % updateInterval === 0) {
      process.stdout.write(
        `\r  Processed ${stats.wiktEntriesProcessed.toLocaleString()}... ` +
          `(${stats.matched.toLocaleString()} matched, ${stats.newDefinitions.toLocaleString()} new defs)`
      )
    }

    const parsed = parseWiktEntry(wiktEntry)
    if (!parsed) continue
    stats.wiktEntriesParsed++

    // Find matching entry
    const key = makeKey(parsed.word, parsed.reading)
    let entryKey = lang.entries[key] ? key : undefined

    if (!entryKey) {
      const candidates = wordMap.get(parsed.word)
      if (candidates && candidates.length === 1) {
        entryKey = candidates[0]
      }
    }

    if (!entryKey) continue

    stats.matched++
    const entry = lang.entries[entryKey]
    if (!entry) continue

    const currentDefs = entry.definitions.length
    if (currentDefs >= maxDefsPerEntry) continue

    const target = sourceEntries[entryKey] ?? { definitions: [] }
    for (const defText of parsed.definitions) {
      if (currentDefs + target.definitions.length >= maxDefsPerEntry) break
      const normalized = defText.toLowerCase().trim()
      const alreadyPresentInExisting = entry.definitions.some((d) => d.toLowerCase().trim() === normalized)
      const alreadyPresentInSource = target.definitions.some((d) => d.toLowerCase().trim() === normalized)
      if (!alreadyPresentInExisting && !alreadyPresentInSource) {
        target.definitions.push(defText)
        stats.newDefinitions++
      }
    }
    if (target.definitions.length > 0) {
      sourceEntries[entryKey] = target
    }
  }

  console.log('')
  stats.sourceEntries = Object.keys(sourceEntries).length
  return { sourceEntries, stats }
}

// ============================================================================
// Main Import Function
// ============================================================================

async function runImport(
  mode: ImportMode,
  maxDefsPerEntry: number,
  duplicatePolicyInput: DuplicateConflictPolicyInput,
  duplicateSamples: number
): Promise<void> {
  console.log('=== [Enrichment] Wiktionary Importer ===')
  console.log(`Mode: ${mode}`)
  console.log(`Max definitions per entry: ${maxDefsPerEntry}`)

  const langPath = `${LANG_DIR}/en.json`
  if (!existsSync(langPath)) {
    console.error(`\nEnglish lang file not found: ${langPath}`)
    console.error('This is an enrichment importer — run base importers first:')
    console.error('  bun run import:jmdict --lang en')
    process.exit(1)
  }

  console.log('\nDownloading Wiktionary data...')
  const filePath = await downloadWiktionary()

  console.log('\nLoading English lang file...')
  const lang = await loadLang(langPath, 'en')
  console.log(`  Entries: ${Object.keys(lang.entries).length.toLocaleString()}`)

  if (mode === 'refresh') {
    console.log('\nStripping existing wiktionary definitions...')
    refreshLangSource(lang.entries, 'wiktionary')
    console.log('  Done.')
  }

  console.log('\nBuilding Wiktionary source entries...')
  const { sourceEntries, stats } = await importWiktionary(lang, filePath, maxDefsPerEntry)
  const effectiveMode = mode === 'refresh' ? 'merge' : mode
  const conflictPolicy = await resolveDuplicateConflictPolicy(
    'wiktionary/en',
    duplicatePolicyInput,
    analyzeLangDefinitionConflicts(lang.entries, sourceEntries, duplicateSamples)
  )
  const mergeStats = mergeLangEntries(lang.entries, sourceEntries, 'wiktionary', effectiveMode, conflictPolicy)

  console.log('\nResults:')
  console.log(`  Wiktionary entries processed: ${stats.wiktEntriesProcessed.toLocaleString()}`)
  console.log(`  Wiktionary entries parsed: ${stats.wiktEntriesParsed.toLocaleString()}`)
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
Wiktionary Importer

Enriches English lang file with additional definitions from Wiktionary.
Data source: https://kaikki.org/dictionary/Japanese/

Usage:
  bun run import:wiktionary [options]

Options:
  --mode    Import mode (default: merge)
            merge   - Add new definitions to entries
            diff    - Preview changes, no modifications
            refresh - Strip and re-import only wiktionary data
  --limit   Maximum definitions per entry (default: 10)
  --dup-policy   merge | skip | replace | ask (default: merge)
  --dup-samples  How many conflict samples to show in ask mode (default: 5)

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
    } else if (arg === '--limit' && next) {
      maxDefsPerEntry = parseInt(next, 10)
      if (isNaN(maxDefsPerEntry) || maxDefsPerEntry < 1) {
        console.error(`Invalid limit: ${next}`)
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
      if (isNaN(duplicateSamples) || duplicateSamples < 1) {
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
  await runImport(mode, maxDefsPerEntry, duplicatePolicy, duplicateSamples)
  console.log('\n=== Import Complete ===')
}

main().catch((err) => {
  console.error('Import failed:', err)
  process.exit(1)
})
