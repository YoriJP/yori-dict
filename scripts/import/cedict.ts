/**
 * CC-CEDICT Importer - Enriches Chinese (zh-cn/zh-tw) definitions
 *
 * For Sino-Japanese vocabulary that shares characters with Chinese words,
 * CC-CEDICT provides the authoritative Chinese character form (simplified
 * for zh-cn, traditional for zh-tw).
 *
 * Source: https://cc-cedict.org / https://www.mdbg.net/chinese/dictionary?page=cedict
 * License: CC BY-SA 4.0
 *
 * Writes: data/lang/zh-cn.json, data/lang/zh-tw.json
 *
 * Usage:
 *   bun run import:cedict
 *   bun run import:cedict --lang zh-cn
 *   bun run import:cedict --mode diff
 *   bun run import:cedict --mode refresh
 */

import { mkdir } from 'fs/promises'
import { existsSync, createReadStream, renameSync, unlinkSync } from 'fs'
import { createGunzip } from 'zlib'
import { createInterface } from 'readline'
import { pipeline } from 'stream/promises'
import {
  type DuplicateConflictPolicyInput,
  type LangEntry,
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
const CEDICT_GZ_URL = 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz'
const CEDICT_GZ_PATH = `${CACHE_DIR}/cedict.txt.gz`
const CEDICT_TXT_PATH = `${CACHE_DIR}/cedict.txt`

type ImportLang = 'zh-cn' | 'zh-tw'
type ImportMode = 'merge' | 'diff' | 'refresh'

// ============================================================================
// Types
// ============================================================================

interface CedictEntry {
  traditional: string
  simplified: string
  pinyin: string
  definitions: string[]
}

// Index built from CC-CEDICT: character form → entries (multiple readings possible)
type CedictIndex = Map<string, CedictEntry[]>

// ============================================================================
// Download & decompress
// ============================================================================

async function downloadCedict(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true })
  await downloadWithProgress(CEDICT_GZ_URL, CEDICT_GZ_PATH)
}

async function decompressCedict(): Promise<void> {
  if (existsSync(CEDICT_TXT_PATH)) {
    console.log(`  Using cached: ${CEDICT_TXT_PATH}`)
    return
  }

  const tmpPath = CEDICT_TXT_PATH + '.tmp'
  console.log('  Decompressing CC-CEDICT...')
  try {
    await pipeline(
      createReadStream(CEDICT_GZ_PATH),
      createGunzip(),
      require('fs').createWriteStream(tmpPath)
    )
    renameSync(tmpPath, CEDICT_TXT_PATH)
    console.log(`  Wrote: ${CEDICT_TXT_PATH}`)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch {}
    throw err
  }
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse one CC-CEDICT line into a CedictEntry.
 * Format: Traditional Simplified [pinyin] /def1/def2/.../
 */
function parseLine(line: string): CedictEntry | null {
  if (line.startsWith('#') || line.startsWith('%') || !line.trim()) return null

  const spaceIdx = line.indexOf(' ')
  if (spaceIdx === -1) return null
  const traditional = line.slice(0, spaceIdx)

  const rest = line.slice(spaceIdx + 1)
  const space2 = rest.indexOf(' ')
  if (space2 === -1) return null
  const simplified = rest.slice(0, space2)

  const bracketStart = rest.indexOf('[', space2)
  const bracketEnd = rest.indexOf(']', bracketStart)
  if (bracketStart === -1 || bracketEnd === -1) return null
  const pinyin = rest.slice(bracketStart + 1, bracketEnd)

  const defStart = rest.indexOf('/', bracketEnd)
  const defEnd = rest.lastIndexOf('/')
  if (defStart === -1 || defEnd <= defStart) return null
  const definitions = rest.slice(defStart + 1, defEnd)
    .split('/')
    .map(d => d.trim())
    .filter(d => d.length > 0)

  return { traditional, simplified, pinyin, definitions }
}

async function buildIndex(): Promise<CedictIndex> {
  console.log('  Building CC-CEDICT index...')
  const index: CedictIndex = new Map()
  let count = 0

  const rl = createInterface({
    input: createReadStream(CEDICT_TXT_PATH, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    const entry = parseLine(line)
    if (!entry) continue
    count++

    // Index by both traditional and simplified forms for maximum match coverage
    for (const form of new Set([entry.traditional, entry.simplified])) {
      const existing = index.get(form)
      if (existing) {
        existing.push(entry)
      } else {
        index.set(form, [entry])
      }
    }
  }

  console.log(`  Indexed ${count.toLocaleString()} entries (${index.size.toLocaleString()} unique forms)`)
  return index
}

// ============================================================================
// Matching helpers
// ============================================================================

function hasChinese(text: string): boolean {
  return /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/.test(text)
}

/**
 * Returns true if the entry's definitions are all English/romanized
 * (i.e. no Chinese characters present). These are the entries we want to enrich.
 */
function hasOnlyEnglishDefs(entry: LangEntry): boolean {
  return entry.definitions.every(d => !hasChinese(d))
}

// ============================================================================
// Import logic
// ============================================================================

interface ImportStats {
  total: number
  matched: number
  enriched: number
  skipped: number
  sourceEntries: number
}

function buildCedictSourceEntries(
  dict: Record<string, LangEntry>,
  index: CedictIndex,
  lang: ImportLang,
  mode: ImportMode
): { sourceEntries: Record<string, { definitions: string[] }>; stats: ImportStats } {
  const sourceEntries: Record<string, { definitions: string[] }> = {}
  const stats: ImportStats = { total: 0, matched: 0, enriched: 0, skipped: 0, sourceEntries: 0 }

  for (const [key, entry] of Object.entries(dict)) {
    stats.total++
    // Parse word from key (format: "word:reading")
    const [word] = key.split(':')

    // Only proceed if the word contains kanji (not pure kana)
    if (!hasChinese(word)) continue

    const matches = index.get(word)
    if (!matches || matches.length === 0) continue
    stats.matched++

    // Determine what Chinese form to add
    // zh-cn → simplified; zh-tw → traditional
    const formsToAdd = new Set<string>()
    for (const m of matches) {
      const form = lang === 'zh-cn' ? m.simplified : m.traditional
      if (hasChinese(form)) formsToAdd.add(form)
    }

    if (formsToAdd.size === 0) { stats.skipped++; continue }

    // Skip if we already have Chinese definitions from kaikki (higher quality source)
    // unless we're in refresh mode
    const hasKaikkiDef = entry.definitions.some(def =>
      (entry._defSources[def] ?? []).includes('kaikki') && hasChinese(def)
    )
    if (hasKaikkiDef && mode !== 'refresh') { stats.skipped++; continue }

    // Only enrich entries whose current definitions are English-only
    if (!hasOnlyEnglishDefs(entry) && mode !== 'refresh') { stats.skipped++; continue }

    const target = sourceEntries[key] ?? { definitions: [] }
    for (const form of formsToAdd) {
      const alreadyPresentInExisting = entry.definitions.some(
        d => d === form || d.startsWith(form)
      )
      const alreadyPresentInSource = target.definitions.some(
        d => d === form || d.startsWith(form)
      )
      if (alreadyPresentInExisting || alreadyPresentInSource) continue
      target.definitions.push(form)
    }

    if (target.definitions.length > 0) {
      if (!sourceEntries[key]) stats.enriched++
      sourceEntries[key] = target
    }
  }

  stats.sourceEntries = Object.keys(sourceEntries).length
  return { sourceEntries, stats }
}

// ============================================================================
// Main
// ============================================================================

async function importCedict(
  langs: ImportLang[],
  mode: ImportMode,
  duplicatePolicyInput: DuplicateConflictPolicyInput,
  duplicateSamples: number
): Promise<void> {
  console.log('=== [Enrichment] CC-CEDICT Importer ===')
  console.log(`Languages: ${langs.join(', ')}`)
  console.log(`Mode: ${mode}`)

  await downloadCedict()
  await decompressCedict()

  const index = await buildIndex()

  for (const lang of langs) {
    const langPath = `${LANG_DIR}/${lang}.json`
    if (!existsSync(langPath)) {
      console.log(`\n[${lang}] Not found: ${langPath} — skipping`)
      continue
    }

    console.log(`\n=== Processing ${lang} ===`)
    const langFile = await loadLang(langPath, lang)
    console.log(`  Entries: ${Object.keys(langFile.entries).length.toLocaleString()}`)

    // Strip cedict defs in refresh mode before re-importing
    if (mode === 'refresh') {
      refreshLangSource(langFile.entries, 'cedict')
    }

    const { sourceEntries, stats } = buildCedictSourceEntries(langFile.entries, index, lang, mode)
    const effectiveMode = mode === 'refresh' ? 'merge' : mode
    const conflictPolicy = await resolveDuplicateConflictPolicy(
      `cedict/${lang}`,
      duplicatePolicyInput,
      analyzeLangDefinitionConflicts(langFile.entries, sourceEntries, duplicateSamples)
    )
    const mergeStats = mergeLangEntries(langFile.entries, sourceEntries, 'cedict', effectiveMode, conflictPolicy)

    console.log(`  Scanned: ${stats.total.toLocaleString()}`)
    console.log(`  Word matches in CC-CEDICT: ${stats.matched.toLocaleString()}`)
    console.log(`  Entries enriched (source candidates): ${stats.enriched.toLocaleString()}`)
    console.log(`  Source entries to merge: ${stats.sourceEntries.toLocaleString()}`)
    console.log(`  Merged - new: ${mergeStats.added.toLocaleString()}, updated: ${mergeStats.updated.toLocaleString()}, unchanged: ${mergeStats.unchanged.toLocaleString()}`)
    console.log(`  Skipped (already has Chinese defs): ${stats.skipped.toLocaleString()}`)

    if (mode === 'diff') {
      console.log('  (Diff mode — no changes written)')
    } else if (mergeStats.added > 0 || mergeStats.updated > 0 || mode === 'refresh') {
      await saveLang(langPath, langFile)
      console.log(`  Saved: ${langPath}`)
    } else {
      console.log('  No changes to write.')
    }
  }
}

// ============================================================================
// CLI
// ============================================================================

function printHelp(): void {
  console.log(`
CC-CEDICT Importer

Enriches Chinese (zh-cn/zh-tw) definitions for Sino-Japanese vocabulary by
matching Japanese word forms to CC-CEDICT entries.

For zh-cn: adds simplified Chinese character form (e.g. 东京)
For zh-tw: adds traditional Chinese character form (e.g. 東京)

Only enriches entries that currently have no Chinese-script definitions
(e.g. entries that only have English glosses today).

Usage:
  bun run import:cedict [options]

Options:
  --lang    Comma-separated language codes (default: zh-cn,zh-tw)
  --mode    Import mode (default: merge)
            merge   - Add Chinese defs to English-only entries
            diff    - Preview changes, no modifications
            refresh - Strip cedict defs and re-import
  --dup-policy   merge | skip | replace | ask (default: merge)
  --dup-samples  How many conflict samples to show in ask mode (default: 5)

Examples:
  bun run import:cedict
  bun run import:cedict --lang zh-cn --mode diff
  bun run import:cedict --mode refresh
`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    return
  }

  await mkdir(LANG_DIR, { recursive: true })

  let langs: ImportLang[] = (['zh-cn', 'zh-tw'] as ImportLang[]).filter(
    l => existsSync(`${LANG_DIR}/${l}.json`)
  )
  let mode: ImportMode = 'merge'
  let duplicatePolicy: DuplicateConflictPolicyInput = 'merge'
  let duplicateSamples = 5

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]
    if (arg === '--lang' && next) {
      langs = next.split(',').map(s => s.trim() as ImportLang)
      i++
    } else if (arg === '--mode' && next) {
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
    }
  }

  if (langs.length === 0) {
    console.error('No Chinese lang files found in data/lang/. Run base importers first.')
    process.exit(1)
  }

  console.log(`Duplicate policy: ${duplicatePolicy}`)
  await importCedict(langs, mode, duplicatePolicy, duplicateSamples)
  console.log('\n=== Import Complete ===')
}

main().catch(err => {
  console.error('Import failed:', err)
  process.exit(1)
})
