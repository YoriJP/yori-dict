/**
 * ZH-JA Yomitan Importer - Imports Chinese definitions for Japanese entries
 *
 * Data sources (user-provided, licensed content):
 *   白水社 中国語辞典           → data/cache/zhja-hakusuisha.zip
 *   中日大辞典 第二版            → data/cache/zhja-chuunichi.zip
 *   小学館中日辞典 第3版         → data/cache/zhja-shogakukan.zip
 *
 * Strategy:
 *   These are Chinese→Japanese dictionaries (Yomitan format). We reverse-map
 *   by extracting the Japanese equivalent word(s) from each entry's definition,
 *   matching them to existing JMdict entries (by kanji + reading), and recording
 *   the Chinese headword as the Chinese "definition" for that Japanese entry.
 *
 *   Same pattern as scripts/import/krdict.ts.
 *
 * Writes: data/lang/zh-cn.json, data/lang/zh-tw.json
 *
 * Usage:
 *   bun run import:zhja
 *   bun run import:zhja --mode diff
 *   bun run import:zhja --mode refresh
 */

import { existsSync } from 'fs'
import * as OpenCC from 'opencc-js'
import {
  type DuplicateConflictPolicyInput,
  type ImportMode,
  loadCore,
  loadLang,
  saveLang,
  mergeLangEntries,
  refreshLangSource,
  analyzeLangDefinitionConflicts,
  resolveDuplicateConflictPolicy,
  printStats,
} from './base'

// ============================================================================
// Configuration
// ============================================================================

const DATA_DIR = './data'
const LANG_DIR = './data/lang'
const CACHE_DIR = './data/cache'
const CORE_PATH = `${DATA_DIR}/core.json`
const SOURCE_NAME = 'zhja'
const MAX_DEFINITIONS_PER_KEY = 4

// Fixed ZIP names — user places them here manually (licensed content)
const KNOWN_ZIPS = [
  `${CACHE_DIR}/zhja-hakusuisha.zip`,
  `${CACHE_DIR}/zhja-chuunichi.zip`,
  `${CACHE_DIR}/zhja-shogakukan.zip`,
]

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

export interface JaCandidate {
  value: string
  confidence: number
}

export interface ZhjaDefinitionCandidate {
  term: string
  hits: number
  maxConfidence: number
}

// ============================================================================
// Parsing helpers
// ============================================================================

/**
 * Walk structured-content tree and collect all leaf text strings.
 */
function collectAllText(node: YomitanNode): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(collectAllText).join('')
  if (node.content !== undefined) return collectAllText(node.content as YomitanNode)
  return ''
}

/**
 * Returns true if the string is pure CJK (Chinese characters only).
 */
function isPureCjk(s: string): boolean {
  return s.length > 0 && /^[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u{20000}-\u{2A6DF}]+$/u.test(s)
}

/**
 * Extract a Japanese equivalent word from a plain-text or assembled definition.
 *
 * Extraction heuristic (ordered by confidence):
 *   1. The Chinese term itself (if pure CJK) — handles Sino-Japanese vocabulary
 *      that shares characters across both languages (e.g. 脂肪, 電灯).
 *      Only used when term exists in JMdict, checked at match time.
 *   2. Longest pure katakana run ≥ 2 chars — loanwords (シャッター).
 *   3. First kana-containing token after stripping the "WORD PINYIN\n" header
 *      and POS prefix (名詞/動詞/形容詞).
 *
 * Returns ordered candidates with descending confidence.
 */
export function extractJaCandidates(chineseTerm: string, defText: string): JaCandidate[] {
  const candidates: JaCandidate[] = []

  // Candidate 1: Chinese term itself (Sino-Japanese)
  if (isPureCjk(chineseTerm)) {
    candidates.push({ value: chineseTerm, confidence: 3 })
  }

  // Strip the "WORD PINYIN\n" first line that 白水社/中日大辞典 entries start with
  const bodyText = defText.replace(/^[^\n]+\n/, '')

  // Candidate 2: longest pure katakana run ≥ 2 chars
  const katakanaRuns = bodyText.match(/[\u30A0-\u30FF\uFF65-\uFF9F]{2,}/g)
  if (katakanaRuns) {
    const longest = katakanaRuns.sort((a, b) => b.length - a.length)[0]
    if (longest) candidates.push({ value: longest, confidence: 2 })
  }

  // Candidate 3: first kana-containing token after stripping POS labels
  const stripped = bodyText
    .replace(/^(名詞|動詞|形容詞|副詞|接続詞|感動詞|助動詞|助詞)\s*/u, '')
    .trim()

  const tokens = stripped.split(/[\s　、。・（）()「」『』【】\n]+/)
  for (const token of tokens) {
    if (/[\u3040-\u30FF]/.test(token) && token.length >= 2) {
      candidates.push({ value: token.replace(/[（(][^)）]*[)）]/g, '').trim(), confidence: 1 })
      break
    }
  }

  const deduped: JaCandidate[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const normalized = candidate.value.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    deduped.push({ ...candidate, value: normalized })
  }

  return deduped
}

export function normalizeZhjaTerm(
  zhTerm: string,
  toSimplified: (text: string) => string
): string | null {
  const compact = zhTerm.replace(/\s+/g, '').trim()
  if (!compact) return null

  const simplified = toSimplified(compact)
  if (!isPureCjk(simplified)) return null
  if (simplified.length > 8) return null
  return simplified
}

function zhjaLengthScore(term: string, japaneseWord: string): number {
  if (term === japaneseWord) return 4
  if (term.length === 1) return japaneseWord.length === 1 ? 2 : -2
  if (term.length <= 4) return 2
  if (term.length <= 6) return 1
  return -1
}

export function selectZhjaDefinitions(
  candidates: ZhjaDefinitionCandidate[],
  japaneseWord: string,
  maxDefinitions = MAX_DEFINITIONS_PER_KEY
): string[] {
  if (candidates.length === 0) return []

  let ranked = [...candidates].sort((a, b) => {
    if (a.hits !== b.hits) return b.hits - a.hits
    if (a.maxConfidence !== b.maxConfidence) return b.maxConfidence - a.maxConfidence

    const aExact = a.term === japaneseWord ? 1 : 0
    const bExact = b.term === japaneseWord ? 1 : 0
    if (aExact !== bExact) return bExact - aExact

    const aLengthScore = zhjaLengthScore(a.term, japaneseWord)
    const bLengthScore = zhjaLengthScore(b.term, japaneseWord)
    if (aLengthScore !== bLengthScore) return bLengthScore - aLengthScore

    if (a.term.length !== b.term.length) return a.term.length - b.term.length
    return a.term.localeCompare(b.term, 'zh')
  })

  const preferred = ranked.filter((candidate) =>
    candidate.hits > 1 ||
    candidate.maxConfidence >= 3 ||
    candidate.term === japaneseWord
  )
  if (preferred.length > 0) ranked = preferred

  return ranked.slice(0, maxDefinitions).map((candidate) => candidate.term)
}

// ============================================================================
// Load Yomitan ZIP (extract if needed)
// ============================================================================

async function loadTermBanks(zipPath: string): Promise<YomitanEntry[]> {
  const file = Bun.file(zipPath)
  if (!(await file.exists())) {
    throw new Error(`ZIP not found: ${zipPath}`)
  }

  // Extract dir is next to the ZIP, named after the ZIP without extension
  const zipDir = zipPath.replace(/\.zip$/, '') + '/'

  // Extract if needed
  if (!existsSync(`${zipDir}term_bank_1.json`)) {
    console.log(`  Extracting ${zipPath}...`)
    const proc = Bun.spawn(['unzip', '-o', zipPath, '-d', zipDir], { stdout: 'pipe', stderr: 'pipe' })
    await proc.exited
  }

  const allEntries: YomitanEntry[] = []
  for (let i = 1; ; i++) {
    const bankPath = `${zipDir}term_bank_${i}.json`
    const bankFile = Bun.file(bankPath)
    if (!(await bankFile.exists())) break
    const bank = await bankFile.json() as YomitanEntry[]
    allEntries.push(...bank)
  }

  if (allEntries.length === 0) {
    throw new Error(`No term_bank_*.json found in ${zipDir} after extraction.`)
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

/**
 * Find matching JMdict keys for a candidate Japanese string.
 * For CJK candidates: kanji-only lookup.
 * For kana candidates: reading-only lookup.
 */
function findJaKeys(candidate: string, idx: JaIndex): string[] {
  if (isPureCjk(candidate)) {
    return idx.byKanji.get(candidate) ?? []
  }
  // Katakana or hiragana — match by reading
  return idx.byReading.get(candidate) ?? []
}

// ============================================================================
// Import logic
// ============================================================================

async function importZhja(
  zipPaths: string[],
  mode: ImportMode,
  duplicatePolicyInput: DuplicateConflictPolicyInput,
  duplicateSamples: number
): Promise<void> {
  console.log(`\n=== Importing ZH-JA dictionaries ===`)
  console.log(`Mode: ${mode}`)
  console.log(`ZIPs: ${zipPaths.join(', ')}`)

  console.log('\nBuilding JMdict index from core.json...')
  const jaIdx = await buildJaIndex()
  console.log(
    `  Indexed ${jaIdx.byKanji.size.toLocaleString()} kanji forms, ` +
    `${jaIdx.byReading.size.toLocaleString()} readings`
  )

  // Map: jmdict key → simplified Chinese term → stats
  const zhForKey = new Map<string, Map<string, { hits: number; maxConfidence: number }>>()

  let totalEntries = 0
  let totalMatched = 0

  for (const zipPath of zipPaths) {
    console.log(`\nLoading ${zipPath}...`)
    const entries = await loadTermBanks(zipPath)
    console.log(`  Loaded ${entries.length.toLocaleString()} entries`)

    let matched = 0

    const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' }) as (s: string) => string

    for (const entry of entries) {
      const [zhTerm, , , , , defs] = entry
      if (!zhTerm || defs.length === 0) continue

      // Get definition text
      const def = defs[0]
      let defText: string
      if (typeof def === 'string') {
        defText = def
      } else if (def && typeof def === 'object' && def.type === 'structured-content') {
        defText = collectAllText(def.content)
      } else {
        continue
      }

      const normalizedZhTerm = normalizeZhjaTerm(zhTerm, toSimplified)
      if (!normalizedZhTerm) continue

      const candidates = extractJaCandidates(zhTerm, defText)

      for (const candidate of candidates) {
        const keys = findJaKeys(candidate.value, jaIdx)
        if (keys.length === 0) continue

        for (const key of keys) {
          if (!zhForKey.has(key)) zhForKey.set(key, new Map())
          const perKey = zhForKey.get(key)!
          const stats = perKey.get(normalizedZhTerm) ?? { hits: 0, maxConfidence: 0 }
          stats.hits++
          stats.maxConfidence = Math.max(stats.maxConfidence, candidate.confidence)
          perKey.set(normalizedZhTerm, stats)
        }
        matched++
        break // Only use first matching candidate per entry
      }
    }

    console.log(`  Matched: ${matched.toLocaleString()}`)
    totalEntries += entries.length
    totalMatched += matched
  }

  console.log(`\nTotal entries processed: ${totalEntries.toLocaleString()}`)
  console.log(`Total matches: ${totalMatched.toLocaleString()}`)
  console.log(`Unique JMdict keys: ${zhForKey.size.toLocaleString()}`)

  // Load existing zh-cn and zh-tw lang files
  const zhCnPath = `${LANG_DIR}/zh-cn.json`
  const zhTwPath = `${LANG_DIR}/zh-tw.json`
  const zhCnLang = await loadLang(zhCnPath, 'zh-cn')
  const zhTwLang = await loadLang(zhTwPath, 'zh-tw')

  console.log(`Existing zh-cn.json entries: ${Object.keys(zhCnLang.entries).length.toLocaleString()}`)
  console.log(`Existing zh-tw.json entries: ${Object.keys(zhTwLang.entries).length.toLocaleString()}`)

  // Set up OpenCC converters
  const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' }) as (s: string) => string
  const toTraditional = OpenCC.Converter({ from: 'cn', to: 'tw' }) as (s: string) => string

  // Build source entry sets for zh-cn and zh-tw
  const zhCnSourceEntries: Record<string, { definitions: string[] }> = {}
  const zhTwSourceEntries: Record<string, { definitions: string[] }> = {}

  let skippedKaikki = 0

  for (const [key, zhTerms] of zhForKey) {
    // Guard: skip entries that already have kaikki-sourced Chinese definitions
    // (kaikki provides higher-quality native definitions; don't dilute them)
    const existingCnEntry = zhCnLang.entries[key]
    if (existingCnEntry) {
      const hasKaikkiDef = existingCnEntry.definitions.some(def =>
        (existingCnEntry._defSources[def] ?? []).includes('kaikki')
      )
      if (hasKaikkiDef) {
        skippedKaikki++
        continue
      }
    }

    const [word] = key.split(':')
    const cnDefs = selectZhjaDefinitions(
      [...zhTerms.entries()].map(([term, stats]) => ({ term, ...stats })),
      toSimplified(word)
    )
    if (cnDefs.length === 0) continue

    const twDefs = [...new Set(cnDefs.map(toTraditional))]

    zhCnSourceEntries[key] = { definitions: cnDefs }
    zhTwSourceEntries[key] = { definitions: twDefs }
  }

  console.log(`\nBuilt ${Object.keys(zhCnSourceEntries).length.toLocaleString()} source entries`)
  console.log(`  (skipped ${skippedKaikki.toLocaleString()} entries already covered by kaikki)`)

  if (mode === 'refresh') {
    refreshLangSource(zhCnLang.entries, SOURCE_NAME)
    refreshLangSource(zhTwLang.entries, SOURCE_NAME)
  }

  const cnConflictPolicy = await resolveDuplicateConflictPolicy(
    'zhja/zh-cn',
    duplicatePolicyInput,
    analyzeLangDefinitionConflicts(zhCnLang.entries, zhCnSourceEntries, duplicateSamples)
  )
  const twConflictPolicy = await resolveDuplicateConflictPolicy(
    'zhja/zh-tw',
    duplicatePolicyInput,
    analyzeLangDefinitionConflicts(zhTwLang.entries, zhTwSourceEntries, duplicateSamples)
  )

  if (mode === 'refresh') {
    const cnStats = mergeLangEntries(zhCnLang.entries, zhCnSourceEntries, SOURCE_NAME, 'merge', cnConflictPolicy)
    const twStats = mergeLangEntries(zhTwLang.entries, zhTwSourceEntries, SOURCE_NAME, 'merge', twConflictPolicy)

    console.log('\n=== zh-cn Statistics ===')
    console.log(`  New entries: ${cnStats.added.toLocaleString()}`)
    console.log(`  Updated entries: ${cnStats.updated.toLocaleString()}`)

    console.log('\n=== zh-tw Statistics ===')
    console.log(`  New entries: ${twStats.added.toLocaleString()}`)
    console.log(`  Updated entries: ${twStats.updated.toLocaleString()}`)
  } else {
    const cnStats = mergeLangEntries(zhCnLang.entries, zhCnSourceEntries, SOURCE_NAME, mode, cnConflictPolicy)
    const twStats = mergeLangEntries(zhTwLang.entries, zhTwSourceEntries, SOURCE_NAME, mode, twConflictPolicy)

    console.log('\n=== zh-cn Statistics ===')
    printStats(cnStats, mode)
    console.log('\n=== zh-tw Statistics ===')
    printStats(twStats, mode)
  }

  if (mode !== 'diff') {
    await saveLang(zhCnPath, zhCnLang)
    await saveLang(zhTwPath, zhTwLang)
    console.log(`\nSaved to: ${zhCnPath}, ${zhTwPath}`)
  }
}

// ============================================================================
// CLI
// ============================================================================

function printHelp(): void {
  console.log(`
ZH-JA Yomitan Importer

Imports Chinese definitions for Japanese entries by reverse-mapping
ZH-JA Yomitan dictionaries onto JMdict entries.

Place ZIP files in data/cache/ with fixed names:
  data/cache/zhja-hakusuisha.zip   ← 白水社 中国語辞典
  data/cache/zhja-chuunichi.zip    ← 中日大辞典 第二版
  data/cache/zhja-shogakukan.zip   ← 小学館中日辞典 第3版

Usage:
  bun run import:zhja [options]

Options:
  --mode <mode>   merge | diff | refresh (default: merge)
  --dup-policy    merge | skip | replace | ask (default: merge)
  --dup-samples   How many conflict samples to show in ask mode (default: 5)

Examples:
  bun run import:zhja
  bun run import:zhja --mode diff
  bun run import:zhja --mode refresh
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
      if (['merge', 'diff', 'refresh'].includes(next)) {
        mode = next as ImportMode
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

  // Discover available ZIPs
  const availableZips = KNOWN_ZIPS.filter((z) => existsSync(z))

  if (availableZips.length === 0) {
    console.error('\nNo ZH-JA ZIP files found. Expected one or more of:')
    for (const z of KNOWN_ZIPS) {
      console.error(`  ${z}`)
    }
    console.error('\nPlace licensed ZIP files in data/cache/ with the names above.')
    process.exit(1)
  }

  console.log(`Found ${availableZips.length} ZIP(s): ${availableZips.map((z) => z.split('/').pop()).join(', ')}`)
  console.log(`Duplicate policy: ${duplicatePolicy}`)

  await importZhja(availableZips, mode, duplicatePolicy, duplicateSamples)

  console.log('\n=== Import Complete ===')
  console.log('Run "bun run build:db" to rebuild the database.')
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('Import failed:', err)
    process.exit(1)
  })
}
