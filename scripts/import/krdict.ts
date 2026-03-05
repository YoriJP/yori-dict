/**
 * KRDICT Importer - Imports Korean translations for Japanese entries
 *
 * Data source:
 *   KRDICT Korean-Japanese Yomitan dictionary by Lyroxide
 *   https://github.com/Lyroxide/yomitan-ko-dic/releases
 *   License: CC BY-SA 2.0 KR (NIKL / 국립국어원)
 *
 * Writes: data/lang/ko.json
 *
 * Usage:
 *   bun run import:krdict
 *   bun run import:krdict --mode replace
 *   bun run import:krdict --zip ./data/cache/krdict-ja/KO-JA.KRDICT.No.Examples.zip
 */

import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import {
  type DuplicateConflictPolicyInput,
  type ImportMode,
  makeKey,
  loadCore,
  loadLang,
  saveLang,
  mergeLangEntries,
  refreshLangSource,
  analyzeLangDefinitionConflicts,
  resolveDuplicateConflictPolicy,
  printStats,
  downloadWithProgress,
} from './base'

// ============================================================================
// Configuration
// ============================================================================

const DATA_DIR = './data'
const LANG_DIR = './data/lang'
const CORE_PATH = `${DATA_DIR}/core.json`
const CACHE_DIR = './data/cache/krdict-ja'
const DEFAULT_ZIP_PATH = `${CACHE_DIR}/KO-JA.KRDICT.No.Examples.zip`
const DOWNLOAD_URL =
  'https://github.com/Lyroxide/yomitan-ko-dic/releases/download/1.0.0/KO-JA.KRDICT.No.Examples.zip'
const SOURCE_NAME = 'krdict'
const LANG = 'ko'

// ============================================================================
// Yomitan term bank types
// ============================================================================

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

function parseJaWords(text: string): JaWord[] {
  const words: JaWord[] = []
  const parts = text.split(/[。／]/)

  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) continue

    const match = trimmed.match(/^([^【（(]+)【([^】]+)】/)
    if (match) {
      const reading = match[1].trim()
      for (const kanji of match[2].split('・')) {
        const k = kanji.trim()
        if (k) words.push({ reading, kanji: k })
      }
    } else if (/^[\u3040-\u30FF\uFF65-\uFF9F]+$/.test(trimmed)) {
      if (trimmed.length <= 20) words.push({ reading: trimmed, kanji: null })
    }
  }

  return words
}

function isHanjaDuplicate(term: string): boolean {
  return /^[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]+$/.test(term)
}

function isCleanKorean(term: string): boolean {
  if (isHanjaDuplicate(term)) return false
  if (/[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/.test(term)) return false
  return true
}

// ============================================================================
// Load Yomitan ZIP
// ============================================================================

async function loadTermBanks(zipPath: string): Promise<YomitanEntry[]> {
  const file = Bun.file(zipPath)
  if (!(await file.exists())) {
    throw new Error(`ZIP not found: ${zipPath}`)
  }

  const allEntries: YomitanEntry[] = []
  const zipDir = zipPath.replace(/[^/]+\.zip$/, '')

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
// Build JMdict lookup indexes from core.json
// ============================================================================

interface JaIndex {
  byKanjiAndReading: Map<string, string[]>
  byKanji: Map<string, string[]>
  byReading: Map<string, string[]>
}

async function buildJaIndex(): Promise<JaIndex> {
  if (!existsSync(CORE_PATH)) {
    throw new Error('core.json not found — run import:jmdict first')
  }

  const core = await loadCore(CORE_PATH)
  const idx: JaIndex = {
    byKanjiAndReading: new Map(),
    byKanji: new Map(),
    byReading: new Map(),
  }

  for (const [key, entry] of Object.entries(core.entries)) {
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

function findJaKeys(word: JaWord, idx: JaIndex): string[] {
  if (word.kanji) {
    const exact = idx.byKanjiAndReading.get(`${word.kanji}:${word.reading}`)
    if (exact && exact.length > 0) return exact
    return idx.byKanji.get(word.kanji) ?? []
  }
  return idx.byReading.get(word.reading) ?? []
}

// ============================================================================
// Import logic
// ============================================================================

async function importKrdict(
  zipPath: string,
  mode: ImportMode,
  duplicatePolicyInput: DuplicateConflictPolicyInput,
  duplicateSamples: number
): Promise<void> {
  console.log(`\n=== Importing ${LANG} from KRDICT (${zipPath}) ===`)
  console.log(`Mode: ${mode}`)

  console.log('\nBuilding JMdict index from core.json...')
  const jaIdx = await buildJaIndex()
  console.log(
    `  Indexed ${jaIdx.byKanji.size.toLocaleString()} kanji forms, ` +
    `${jaIdx.byReading.size.toLocaleString()} readings`
  )

  console.log('\nLoading KRDICT term banks...')
  const entries = await loadTermBanks(zipPath)
  console.log(`  Loaded ${entries.length.toLocaleString()} entries`)

  const koForKey = new Map<string, Set<string>>()

  let processed = 0
  let skipped = 0
  let jaExtracted = 0
  let jaMatched = 0

  for (const entry of entries) {
    const [koTerm, , , , , defs] = entry
    processed++

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

  // Build source entries for ko lang file
  const sourceEntries: Record<string, { definitions: string[] }> = {}
  const core = await loadCore(CORE_PATH)

  for (const [key, koTerms] of koForKey) {
    if (!core.entries[key]) continue
    sourceEntries[key] = { definitions: [...koTerms] }
  }

  console.log(`\nBuilt ${Object.keys(sourceEntries).length.toLocaleString()} source entries`)

  const langPath = `${LANG_DIR}/${LANG}.json`
  const langFile = await loadLang(langPath, LANG)
  console.log(`Existing ko.json entries: ${Object.keys(langFile.entries).length.toLocaleString()}`)

  if (mode === 'refresh') {
    refreshLangSource(langFile.entries, SOURCE_NAME)
  }

  const conflictPolicy = await resolveDuplicateConflictPolicy(
    SOURCE_NAME,
    duplicatePolicyInput,
    analyzeLangDefinitionConflicts(langFile.entries, sourceEntries, duplicateSamples)
  )

  if (mode === 'refresh') {
    const stats = mergeLangEntries(langFile.entries, sourceEntries, SOURCE_NAME, 'merge', conflictPolicy)

    console.log('\n=== Import Statistics ===')
    console.log(`  New entries: ${stats.added.toLocaleString()}`)
    console.log(`  Updated entries: ${stats.updated.toLocaleString()}`)
  } else {
    const stats = mergeLangEntries(langFile.entries, sourceEntries, SOURCE_NAME, mode, conflictPolicy)
    printStats(stats as { added: number; updated: number; unchanged: number }, mode)
  }

  if (mode !== 'diff') {
    await saveLang(langPath, langFile)
    console.log(`Saved to: ${langPath}`)
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
  --dup-policy    merge | skip | replace | ask (default: merge)
  --dup-samples   How many conflict samples to show in ask mode (default: 5)
  --zip <path>    Path to KO-JA.KRDICT.*.zip
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
  let duplicatePolicy: DuplicateConflictPolicyInput = 'merge'
  let duplicateSamples = 5

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
    } else if (arg === '--download') {
      forceDownload = true
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      return
    }
  }

  await mkdir(CACHE_DIR, { recursive: true })
  await mkdir(LANG_DIR, { recursive: true })

  if (forceDownload || !existsSync(zipPath)) {
    console.log('Downloading KRDICT Korean-Japanese Yomitan dictionary...')
    await downloadWithProgress(DOWNLOAD_URL, zipPath)
    console.log('Download complete.')
  }

  const zipDir = zipPath.replace(/[^/]+\.zip$/, '')
  if (!existsSync(`${zipDir}term_bank_1.json`)) {
    console.log(`\nExtracting ${zipPath}...`)
    const proc = Bun.spawn(['unzip', '-o', zipPath, '-d', zipDir], { stdout: 'pipe' })
    await proc.exited
    console.log('Extracted.')
  }

  console.log(`Duplicate policy: ${duplicatePolicy}`)
  await importKrdict(zipPath, mode, duplicatePolicy, duplicateSamples)

  console.log('\n=== Import Complete ===')
  console.log('Run "bun run build:db" to rebuild the database.')
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('Import failed:', err)
    process.exit(1)
  })
}
