/**
 * KRDICT Importer - Imports Korean translations for Japanese entries
 *
 * Data source:
 *   KRDICT Korean-Japanese Yomitan dictionary by Lyroxide
 *   https://github.com/Lyroxide/yomitan-ko-dic/releases
 *   License: CC BY-SA 2.0 KR (NIKL / 국립국어원)
 *
 * Strategy:
 *   KRDICT is a Korean-pivot dictionary: Korean headwords with Japanese
 *   equivalents. We reverse-map by extracting the Japanese words from each
 *   entry, matching them to existing JMdict entries (by kanji + reading),
 *   and recording the Korean headword as the Korean "definition" for that
 *   Japanese entry.
 *
 * Usage:
 *   bun run import:krdict
 *   bun run import:krdict --mode replace
 *   bun run import:krdict --zip ./data/cache/krdict-ja/KO-JA.KRDICT.No.Examples.zip
 */

import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import {
  type DictEntry,
  type ImportMode,
  makeKey,
  loadDict,
  saveDict,
  mergeDictEntries,
  refreshDictSource,
  printStats,
  downloadWithProgress,
  mergeArrays,
} from './base'

// ============================================================================
// Configuration
// ============================================================================

const DATA_DIR = './data'
const CACHE_DIR = './data/cache/krdict-ja'
const DEFAULT_ZIP_PATH = `${CACHE_DIR}/KO-JA.KRDICT.No.Examples.zip`
const DOWNLOAD_URL =
  'https://github.com/Lyroxide/yomitan-ko-dic/releases/download/1.0.0/KO-JA.KRDICT.No.Examples.zip'
const SOURCE_NAME = 'krdict'
const LANG = 'ko'

// ============================================================================
// Yomitan term bank types
// ============================================================================

// Yomitan format 3: [term, reading, definitionTags, rules, score, definitions, sequence, termTags]
type YomitanEntry = [string, string, string, string, number, YomitanDef[], number, string]

type YomitanDef =
  | string
  | { type: 'structured-content'; content: YomitanNode }

type YomitanNode =
  | string
  | YomitanNode[]
  | { tag: string; content?: YomitanNode; lang?: string; [key: string]: unknown }

// ============================================================================
// Parsing helpers
// ============================================================================

/**
 * Walk structured-content and collect all Japanese-language text nodes.
 * Returns raw strings like 'じっか【実家】' or 'くすんでいる【黒ずんでいる】'
 */
function collectJaNodes(node: YomitanNode): string[] {
  const results: string[] = []
  function walk(n: YomitanNode): void {
    if (typeof n === 'string') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n.lang === 'ja' && typeof n.content === 'string') {
      results.push(n.content)
    }
    if (n.content !== undefined && typeof n.content !== 'string') {
      walk(n.content as YomitanNode)
    }
  }
  walk(node)
  return results
}

interface JaWord {
  reading: string
  kanji: string | null
}

/**
 * Parse Japanese equivalent strings into { reading, kanji } pairs.
 * Input examples:
 *   'じっか【実家】'              → [{ reading: 'じっか', kanji: '実家' }]
 *   'とも【友】。ともだち【友達】' → [{ reading: 'とも', kanji: '友' }, ...]
 *   'くすんでいる'                → [{ reading: 'くすんでいる', kanji: null }]
 */
function parseJaWords(text: string): JaWord[] {
  const words: JaWord[] = []
  // Split on sentence-ending delimiters between entries
  const parts = text.split(/[。／]/)

  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) continue

    const match = trimmed.match(/^([^【（(]+)【([^】]+)】/)
    if (match) {
      const reading = match[1].trim()
      // 【】 may contain multiple kanji forms separated by ・
      for (const kanji of match[2].split('・')) {
        const k = kanji.trim()
        if (k) words.push({ reading, kanji: k })
      }
    } else if (/^[\u3040-\u30FF\uFF65-\uFF9F]+$/.test(trimmed)) {
      // Pure kana — only include if it looks like a word (short enough)
      if (trimmed.length <= 20) words.push({ reading: trimmed, kanji: null })
    }
    // Otherwise it's a definition sentence — skip
  }

  return words
}

/**
 * Returns true if the headword is pure CJK (hanja duplicate entry).
 * KRDICT duplicates every entry — one with hangul, one with hanja.
 * We only want the hangul version.
 */
function isHanjaDuplicate(term: string): boolean {
  return /^[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]+$/.test(term)
}

/**
 * Filter Korean terms: remove hanja-mixed variants, keep pure hangul (or
 * hangul + spaces/punctuation). Also strips trailing hanja particles like
 * 親庭집 → skip (mixed hanja+hangul with leading hanja).
 */
function isCleanKorean(term: string): boolean {
  if (isHanjaDuplicate(term)) return false
  // Skip mixed-script terms where a hanja character appears (e.g. 親庭집)
  if (/[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/.test(term)) return false
  return true
}

// ============================================================================
// Load Yomitan ZIP
// ============================================================================

async function loadTermBanks(zipPath: string): Promise<YomitanEntry[]> {
  // Bun has native ZIP support via BunFile
  const file = Bun.file(zipPath)
  if (!(await file.exists())) {
    throw new Error(`ZIP not found: ${zipPath}`)
  }

  // Use the unzipped files if they exist alongside the zip
  const dir = zipPath.replace(/\.zip$/, '_extracted')
  const zipDir = zipPath.replace(/[^/]+\.zip$/, '')

  // Try reading term_bank_*.json directly from same directory as zip
  // (already extracted by a previous step)
  const allEntries: YomitanEntry[] = []

  for (let i = 1; ; i++) {
    const bankPath = `${zipDir}term_bank_${i}.json`
    const bankFile = Bun.file(bankPath)
    if (!(await bankFile.exists())) break
    const bank = await bankFile.json() as YomitanEntry[]
    allEntries.push(...bank)
  }

  if (allEntries.length === 0) {
    throw new Error(
      `No term_bank_*.json files found in ${zipDir}. ` +
      `Please extract the ZIP first: unzip ${zipPath} -d ${zipDir}`
    )
  }

  return allEntries
}

// ============================================================================
// Build JMdict lookup indexes
// ============================================================================

interface JaIndex {
  byKanjiAndReading: Map<string, string[]> // 'kanji:reading' → [keys]
  byKanji: Map<string, string[]>           // kanji → [keys]
  byReading: Map<string, string[]>         // reading → [keys]
}

async function buildJaIndex(): Promise<JaIndex> {
  const enPath = `${DATA_DIR}/en.json`
  if (!existsSync(enPath)) {
    throw new Error('en.json not found — run import:jmdict first')
  }

  const en = await loadDict(enPath, 'en')
  const idx: JaIndex = {
    byKanjiAndReading: new Map(),
    byKanji: new Map(),
    byReading: new Map(),
  }

  for (const [key, entry] of Object.entries(en.entries)) {
    const w = entry.word
    const r = entry.reading

    const kr = `${w}:${r}`
    if (!idx.byKanjiAndReading.has(kr)) idx.byKanjiAndReading.set(kr, [])
    idx.byKanjiAndReading.get(kr)!.push(key)

    if (!idx.byKanji.has(w)) idx.byKanji.set(w, [])
    idx.byKanji.get(w)!.push(key)

    if (!idx.byReading.has(r)) idx.byReading.set(r, [])
    idx.byReading.get(r)!.push(key)
  }

  return idx
}

/**
 * Find matching JMdict keys for a parsed Japanese word.
 * Priority: kanji+reading exact > kanji only > reading only (kana words).
 */
function findJaKeys(word: JaWord, idx: JaIndex): string[] {
  if (word.kanji) {
    // Try exact kanji+reading match first
    const exact = idx.byKanjiAndReading.get(`${word.kanji}:${word.reading}`)
    if (exact && exact.length > 0) return exact

    // Fall back to kanji-only (covers reading variants)
    return idx.byKanji.get(word.kanji) ?? []
  }

  // Pure kana word — match by reading
  return idx.byReading.get(word.reading) ?? []
}

// ============================================================================
// Import logic
// ============================================================================

async function importKrdict(
  zipPath: string,
  mode: ImportMode,
): Promise<void> {
  console.log(`\n=== Importing ${LANG} from KRDICT (${zipPath}) ===`)
  console.log(`Mode: ${mode}`)

  console.log('\nBuilding JMdict index...')
  const jaIdx = await buildJaIndex()
  console.log(
    `  Indexed ${jaIdx.byKanji.size.toLocaleString()} kanji forms, ` +
    `${jaIdx.byReading.size.toLocaleString()} readings`
  )

  console.log('\nLoading KRDICT term banks...')
  const entries = await loadTermBanks(zipPath)
  console.log(`  Loaded ${entries.length.toLocaleString()} entries`)

  // Map: jmdict key → Set of Korean headwords
  const koForKey = new Map<string, Set<string>>()

  let processed = 0
  let skipped = 0
  let jaExtracted = 0
  let jaMatched = 0

  for (const entry of entries) {
    const [koTerm, , , , , defs] = entry
    processed++

    // Skip hanja duplicates and mixed-script terms
    if (!isCleanKorean(koTerm)) { skipped++; continue }

    const def = defs[0]
    if (!def || typeof def !== 'object' || def.type !== 'structured-content') continue

    const jaNodes = collectJaNodes(def.content)

    for (const node of jaNodes) {
      const words = parseJaWords(node)
      jaExtracted += words.length

      for (const word of words) {
        const keys = findJaKeys(word, jaIdx)
        if (keys.length === 0) continue
        jaMatched++

        for (const key of keys) {
          if (!koForKey.has(key)) koForKey.set(key, new Set())
          koForKey.get(key)!.add(koTerm)
        }
      }
    }
  }

  console.log(`  Processed: ${processed.toLocaleString()}`)
  console.log(`  Skipped (hanja/mixed): ${skipped.toLocaleString()}`)
  console.log(`  JA word refs extracted: ${jaExtracted.toLocaleString()}`)
  console.log(`  JA word refs matched: ${jaMatched.toLocaleString()}`)
  console.log(`  Unique JMdict keys with KO: ${koForKey.size.toLocaleString()}`)

  // Build source entries for the ko dict
  const sourceEntries: Record<string, DictEntry> = {}

  // We need word/reading for each key — load en.json for that
  const en = await loadDict(`${DATA_DIR}/en.json`, 'en')

  for (const [key, koTerms] of koForKey) {
    const enEntry = en.entries[key]
    if (!enEntry) continue

    const definitions = [...koTerms].map((text) => ({ text, sources: [SOURCE_NAME] }))

    sourceEntries[key] = {
      word: enEntry.word,
      reading: enEntry.reading,
      partOfSpeech: enEntry.partOfSpeech,
      common: enEntry.common,
      commonSources: [],
      jlpt: enEntry.jlpt,
      definitions,
      examples: [],
    }
  }

  console.log(`\nBuilt ${Object.keys(sourceEntries).length.toLocaleString()} source entries`)

  // Merge into ko.json
  const dictPath = `${DATA_DIR}/${LANG}.json`
  const dict = await loadDict(dictPath, LANG)
  console.log(`Existing ko.json entries: ${Object.keys(dict.entries).length.toLocaleString()}`)

  if (mode === 'refresh') {
    const stats = refreshDictSource(dict.entries, sourceEntries, SOURCE_NAME)
    console.log('\n=== Import Statistics ===')
    console.log(`  New entries: ${stats.added.toLocaleString()}`)
    console.log(`  Updated entries: ${stats.updated.toLocaleString()}`)
    console.log(`  Removed entries: ${stats.removed.toLocaleString()}`)
  } else {
    const stats = mergeDictEntries(dict.entries, sourceEntries, mode)
    printStats(stats, mode)
  }

  if (mode !== 'diff') {
    await saveDict(dictPath, dict)
    console.log(`Saved to: ${dictPath}`)
  }
}

// ============================================================================
// CLI
// ============================================================================

function printHelp(): void {
  console.log(`
KRDICT Importer

Imports Korean translations for Japanese entries by reverse-mapping
KRDICT's Korean-Japanese Yomitan dictionary onto JMdict entries.

Usage:
  bun run import:krdict [options]

Options:
  --mode <mode>   merge | diff | replace | refresh (default: replace)
  --zip <path>    Path to extracted KO-JA.KRDICT.*.zip directory
                  (default: ${DEFAULT_ZIP_PATH})
  --download      Re-download the ZIP even if cached

Examples:
  bun run import:krdict
  bun run import:krdict --mode diff
  bun run import:krdict --zip ./data/cache/krdict-ja/KO-JA.KRDICT.No.Examples.zip
`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  let mode: ImportMode = 'replace'
  let zipPath = DEFAULT_ZIP_PATH
  let forceDownload = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--mode' && next) {
      if (['merge', 'diff', 'replace', 'refresh'].includes(next)) {
        mode = next as ImportMode
      } else {
        console.error(`Invalid mode: ${next}`)
        process.exit(1)
      }
      i++
    } else if (arg === '--zip' && next) {
      zipPath = next
      i++
    } else if (arg === '--download') {
      forceDownload = true
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      return
    }
  }

  await mkdir(CACHE_DIR, { recursive: true })

  // Download ZIP if needed
  if (forceDownload || !existsSync(zipPath)) {
    console.log('Downloading KRDICT Korean-Japanese Yomitan dictionary...')
    await downloadWithProgress(DOWNLOAD_URL, zipPath)
    console.log('Download complete.')
  }

  // Check if term banks are already extracted
  const zipDir = zipPath.replace(/[^/]+\.zip$/, '')
  if (!existsSync(`${zipDir}term_bank_1.json`)) {
    console.log(`\nExtracting ${zipPath}...`)
    const proc = Bun.spawn(['unzip', '-o', zipPath, '-d', zipDir], { stdout: 'pipe' })
    await proc.exited
    console.log('Extracted.')
  }

  await importKrdict(zipPath, mode)

  console.log('\n=== Import Complete ===')
  console.log('Run "bun run build:db" to rebuild the database.')
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('Import failed:', err)
    process.exit(1)
  })
}
