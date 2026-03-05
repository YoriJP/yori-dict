/**
 * Kaikki Importer - Imports Chinese definitions for Japanese entries
 *
 * Data source:
 *   - https://kaikki.org/zhwiktionary/raw-wiktextract-data.jsonl.gz
 * License: CC-BY-SA 3.0 (Wiktionary) / MIT (wiktextract)
 *
 * Writes:
 *   - data/lang/zh-cn.json
 *   - data/lang/zh-tw.json (bootstrapped from zh-cn via OpenCC)
 *
 * Usage:
 *   bun run import:kaikki
 *   bun run import:kaikki --lang zh-cn
 *   bun run import:kaikki --mode diff
 *   bun run import:kaikki --file=zh-cn=/path/to/raw-zhwiktionary.jsonl
 */

import { mkdir } from 'fs/promises'
import { createReadStream, createWriteStream, existsSync, renameSync, unlinkSync } from 'fs'
import { createInterface } from 'readline'
import { createGunzip } from 'zlib'
import { pipeline } from 'stream/promises'
import * as OpenCC from 'opencc-js'
import {
  type DuplicateConflictPolicyInput,
  type ImportMode,
  makeKey,
  loadCore,
  loadLang,
  saveLang,
  createEmptyLang,
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
const CACHE_DIR = './data/cache'

type ImportLang = 'zh-cn' | 'zh-tw'
type KaikkiSourceLang = Exclude<ImportLang, 'zh-tw'>

const SOURCE_CONFIG: Record<KaikkiSourceLang, { url: string; cacheName: string }> = {
  'zh-cn': {
    url: 'https://kaikki.org/zhwiktionary/raw-wiktextract-data.jsonl.gz',
    cacheName: 'kaikki-zhwiktionary-raw.jsonl.gz',
  },
}

const INCLUDED_POS = new Set([
  'noun', 'verb', 'adj', 'adv', 'intj', 'pron', 'conj',
  'particle', 'counter', 'prefix', 'suffix', 'affix', 'phrase', 'proverb', 'num',
])

const SKIP_SENSE_TAGS = new Set(['alt-of', 'form-of', 'romanization', 'Rōmaji'])
const DEFAULT_MAX_DEFINITIONS = 8

// ============================================================================
// Types
// ============================================================================

export interface WiktEntry {
  word: string
  pos: string
  lang_code: string
  forms?: { form: string; tags?: string[]; ruby?: [string, string][] }[]
  senses?: {
    glosses?: string[]
    raw_glosses?: string[]
    tags?: string[]
  }[]
  sounds?: { other?: string }[]
}

export interface ParsedWiktEntry {
  word: string
  reading: string
  pos: string
  definitions: string[]
}

interface ImportStats {
  processed: number
  parsed: number
  produced: number
}

// ============================================================================
// Parsing helpers
// ============================================================================

export function katakanaToHiragana(text: string): string {
  return text.replace(/[\u30A1-\u30F6]/g, (char) => {
    return String.fromCharCode(char.charCodeAt(0) - 0x60)
  })
}

export function extractReading(entry: WiktEntry): string | null {
  if (entry.forms) {
    for (const form of entry.forms) {
      if (form.ruby && form.ruby.length > 0) {
        const reading = form.ruby.map(([_, kana]) => kana).join('')
        if (reading && /[\u3040-\u309F]/.test(reading)) return reading
      }
      if (form.tags?.includes('romanization')) continue
      if (form.form && /^[\u3040-\u309F]+$/.test(form.form)) return form.form
      if (form.form && /^[\u30A0-\u30FF]+$/.test(form.form)) return katakanaToHiragana(form.form)
    }
  }

  if (entry.sounds) {
    for (const sound of entry.sounds) {
      if (sound.other && /^[\u30A0-\u30FF]+$/.test(sound.other)) {
        return katakanaToHiragana(sound.other)
      }
    }
  }

  if (/^[\u3040-\u309F]+$/.test(entry.word)) return entry.word
  if (/^[\u30A0-\u30FF]+$/.test(entry.word)) return katakanaToHiragana(entry.word)

  return null
}

export function extractDefinitions(entry: WiktEntry): string[] {
  const definitions: string[] = []
  const seen = new Set<string>()

  if (!entry.senses) return definitions

  for (const sense of entry.senses) {
    if (sense.tags?.some((tag) => SKIP_SENSE_TAGS.has(tag))) continue

    const glosses = sense.glosses ?? sense.raw_glosses ?? []
    for (const gloss of glosses) {
      const cleaned = gloss.replace(/\s+/g, ' ').trim()
      if (!cleaned) continue

      const normalized = cleaned.toLowerCase()
      if (seen.has(normalized)) continue

      seen.add(normalized)
      definitions.push(cleaned)
    }
  }

  return definitions
}

export function mapPos(pos: string): string {
  const mapping: Record<string, string> = {
    noun: 'noun',
    verb: 'verb',
    adj: 'adjective',
    adv: 'adverb',
    intj: 'interjection',
    pron: 'pronoun',
    conj: 'conjunction',
    particle: 'particle',
    counter: 'counter',
    prefix: 'prefix',
    suffix: 'suffix',
    affix: 'affix',
    phrase: 'expression',
    proverb: 'expression',
    num: 'numeral',
  }
  return mapping[pos] || pos
}

export function parseEntry(entry: WiktEntry): ParsedWiktEntry | null {
  if (entry.lang_code !== 'ja') return null
  if (!INCLUDED_POS.has(entry.pos)) return null

  const reading = extractReading(entry)
  if (!reading) return null

  const definitions = extractDefinitions(entry)
  if (definitions.length === 0) return null

  return { word: entry.word, reading, pos: mapPos(entry.pos), definitions }
}

async function* streamJsonLines(filePath: string): AsyncGenerator<WiktEntry> {
  const fileStream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      yield JSON.parse(line) as WiktEntry
    } catch {
      // Skip malformed records.
    }
  }
}

// ============================================================================
// Source file resolution
// ============================================================================

async function gunzipIfNeeded(gzipPath: string, jsonlPath: string): Promise<void> {
  if (existsSync(jsonlPath)) {
    console.log(`  Using cached JSONL: ${jsonlPath}`)
    return
  }

  const tmpPath = jsonlPath + '.tmp'
  console.log('  Decompressing archive...')
  try {
    await pipeline(createReadStream(gzipPath), createGunzip(), createWriteStream(tmpPath))
    renameSync(tmpPath, jsonlPath)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch {}
    throw err
  }
  console.log(`  Wrote JSONL: ${jsonlPath}`)
}

async function resolveSourcePath(lang: KaikkiSourceLang, fileOverride?: string): Promise<string> {
  if (fileOverride) {
    if (!existsSync(fileOverride)) throw new Error(`Override file not found: ${fileOverride}`)
    console.log(`  Using override file: ${fileOverride}`)
    return fileOverride
  }

  await mkdir(CACHE_DIR, { recursive: true })
  const source = SOURCE_CONFIG[lang]
  const gzipPath = `${CACHE_DIR}/${source.cacheName}`
  const jsonlPath = gzipPath.replace(/\.gz$/, '')

  await downloadWithProgress(source.url, gzipPath)
  await gunzipIfNeeded(gzipPath, jsonlPath)

  return jsonlPath
}

// ============================================================================
// Key normalization against core.json
// ============================================================================

async function buildCoreIndex(): Promise<{ coreKeys: Set<string>; coreByWord: Map<string, string[]> }> {
  if (!existsSync(CORE_PATH)) {
    return { coreKeys: new Set(), coreByWord: new Map() }
  }

  const core = await loadCore(CORE_PATH)
  const coreKeys = new Set(Object.keys(core.entries))
  const coreByWord = new Map<string, string[]>()

  for (const key of coreKeys) {
    const word = key.split(':')[0]
    const existing = coreByWord.get(word) ?? []
    existing.push(key)
    coreByWord.set(word, existing)
  }

  return { coreKeys, coreByWord }
}

function normalizeSourceKeys(
  sourceEntries: Record<string, { definitions: string[] }>,
  coreKeys: Set<string>,
  coreByWord: Map<string, string[]>
): { rekeyed: number; merged: number; ambiguous: number } {
  let rekeyed = 0
  let merged = 0
  let ambiguous = 0

  const toProcess = Object.keys(sourceEntries).filter((k) => !coreKeys.has(k))

  for (const srcKey of toProcess) {
    const word = srcKey.split(':')[0]
    const candidates = coreByWord.get(word)

    if (!candidates || candidates.length === 0) continue
    if (candidates.length > 1) { ambiguous++; continue }

    const canonicalKey = candidates[0]
    const srcEntry = sourceEntries[srcKey]
    const existing = sourceEntries[canonicalKey]

    if (existing) {
      // Merge definitions
      for (const def of srcEntry.definitions) {
        const normalized = def.toLowerCase().trim()
        if (!existing.definitions.some((d) => d.toLowerCase().trim() === normalized)) {
          existing.definitions.push(def)
        }
      }
      merged++
    } else {
      sourceEntries[canonicalKey] = { definitions: srcEntry.definitions }
      rekeyed++
    }

    delete sourceEntries[srcKey]
  }

  return { rekeyed, merged, ambiguous }
}

// ============================================================================
// Import logic
// ============================================================================

async function importKaikkiLanguage(
  lang: KaikkiSourceLang,
  mode: ImportMode,
  maxDefsPerEntry: number,
  duplicatePolicyInput: DuplicateConflictPolicyInput,
  duplicateSamples: number,
  fileOverride?: string
): Promise<ImportStats> {
  console.log(`\n=== Importing ${lang} from Kaikki ===`)
  console.log(`Mode: ${mode}`)

  const sourcePath = await resolveSourcePath(lang, fileOverride)
  const langPath = `${LANG_DIR}/${lang}.json`
  const langFile = mode === 'replace' ? createEmptyLang(lang) : await loadLang(langPath, lang)
  console.log(`  Existing entries: ${Object.keys(langFile.entries).length.toLocaleString()}`)

  const sourceEntries: Record<string, { definitions: string[] }> = {}
  const stats: ImportStats = { processed: 0, parsed: 0, produced: 0 }

  const progressEvery = 100000

  for await (const raw of streamJsonLines(sourcePath)) {
    stats.processed++
    if (stats.processed % progressEvery === 0) {
      process.stdout.write(
        `\r  Processed ${stats.processed.toLocaleString()} lines... ` +
          `(${stats.parsed.toLocaleString()} parsed, ${stats.produced.toLocaleString()} entries)`
      )
    }

    const parsed = parseEntry(raw)
    if (!parsed) continue
    stats.parsed++

    const key = makeKey(parsed.word, parsed.reading)
    const newDefs = parsed.definitions.slice(0, maxDefsPerEntry)

    const existing = sourceEntries[key]
    if (existing) {
      for (const def of newDefs) {
        const normalized = def.toLowerCase().trim()
        if (!existing.definitions.some((d) => d.toLowerCase().trim() === normalized)) {
          if (existing.definitions.length < maxDefsPerEntry) {
            existing.definitions.push(def)
          }
        }
      }
      continue
    }

    sourceEntries[key] = { definitions: newDefs }
  }

  console.log('')

  // Normalize keys against core.json
  const { coreKeys, coreByWord } = await buildCoreIndex()
  if (coreKeys.size > 0) {
    const normStats = normalizeSourceKeys(sourceEntries, coreKeys, coreByWord)
    console.log(
      `  Key normalization: ${normStats.rekeyed} rekeyed, ` +
      `${normStats.merged} merged, ${normStats.ambiguous} ambiguous (skipped)`
    )
  }

  stats.produced = Object.keys(sourceEntries).length
  console.log(`  Produced source entries: ${stats.produced.toLocaleString()}`)

  if (mode === 'refresh') {
    refreshLangSource(langFile.entries, 'kaikki')
  }

  const conflictPolicy = await resolveDuplicateConflictPolicy(
    `kaikki/${lang}`,
    duplicatePolicyInput,
    analyzeLangDefinitionConflicts(langFile.entries, sourceEntries, duplicateSamples)
  )

  if (mode === 'refresh') {
    const mergeStats = mergeLangEntries(langFile.entries, sourceEntries, 'kaikki', 'merge', conflictPolicy)
    console.log('\n=== Import Statistics ===')
    console.log(`  New entries: ${mergeStats.added.toLocaleString()}`)
    console.log(`  Updated entries: ${mergeStats.updated.toLocaleString()}`)
    await saveLang(langPath, langFile)
    console.log(`Saved to: ${langPath}`)
  } else {
    const mergeStats = mergeLangEntries(langFile.entries, sourceEntries, 'kaikki', mode, conflictPolicy)
    printStats(mergeStats as { added: number; updated: number; unchanged: number }, mode)
    if (mode !== 'diff') {
      await saveLang(langPath, langFile)
      console.log(`Saved to: ${langPath}`)
    }
  }

  return stats
}

async function bootstrapTraditionalChinese(
  mode: ImportMode,
  duplicatePolicyInput: DuplicateConflictPolicyInput,
  duplicateSamples: number
): Promise<void> {
  console.log('\n=== Bootstrapping zh-tw from zh-cn ===')

  const zhCnPath = `${LANG_DIR}/zh-cn.json`
  const zhTwPath = `${LANG_DIR}/zh-tw.json`

  if (!existsSync(zhCnPath)) {
    throw new Error('zh-cn.json not found. Run zh-cn import first.')
  }

  const zhCnLang = await loadLang(zhCnPath, 'zh-cn')
  const zhTwLang = mode === 'replace' ? createEmptyLang('zh-tw') : await loadLang(zhTwPath, 'zh-tw')

  const toTraditional = OpenCC.Converter({ from: 'cn', to: 'tw' })

  // Build source entries by converting zh-cn kaikki defs to Traditional
  const sourceEntries: Record<string, { definitions: string[] }> = {}
  for (const [key, entry] of Object.entries(zhCnLang.entries)) {
    const kaikkiDefs = (entry._defSources
      ? Object.entries(entry._defSources)
          .filter(([, sources]) => sources.includes('kaikki'))
          .map(([def]) => def)
      : entry.definitions)
      .map((def) => toTraditional(def))

    if (kaikkiDefs.length > 0) {
      sourceEntries[key] = { definitions: kaikkiDefs }
    }
  }

  const effectiveMode = mode === 'refresh' ? 'replace' : mode
  const conflictPolicy = await resolveDuplicateConflictPolicy(
    'kaikki/zh-tw-bootstrap',
    duplicatePolicyInput,
    analyzeLangDefinitionConflicts(zhTwLang.entries, sourceEntries, duplicateSamples)
  )
  const stats = mergeLangEntries(zhTwLang.entries, sourceEntries, 'kaikki', effectiveMode, conflictPolicy)
  printStats(stats as { added: number; updated: number; unchanged: number }, effectiveMode)

  if (mode !== 'diff') {
    await saveLang(zhTwPath, zhTwLang)
    console.log(`Saved to: ${zhTwPath}`)
  }
}

// ============================================================================
// CLI
// ============================================================================

function parseFileOverrides(args: string[]): Partial<Record<KaikkiSourceLang, string>> {
  const overrides: Partial<Record<KaikkiSourceLang, string>> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    let value: string | null = null

    if (arg === '--file' && args[i + 1]) {
      value = args[i + 1]
      i++
    } else if (arg.startsWith('--file=')) {
      value = arg.slice('--file='.length)
    }

    if (!value) continue

    const [lang, ...rest] = value.split('=')
    const filePath = rest.join('=')
    if (lang === 'zh-cn' && filePath) {
      overrides[lang] = filePath
    }
  }

  return overrides
}

function printHelp(): void {
  console.log(`
Kaikki Importer

Imports Chinese definitions for Japanese entries.
Data source:
  https://kaikki.org/zhwiktionary/raw-wiktextract-data.jsonl.gz

Usage:
  bun run import:kaikki [options]

Options:
  --lang <langs>    Comma-separated: zh-cn,zh-tw (default: zh-cn,zh-tw)
  --mode <mode>     merge | diff | replace | refresh (default: merge)
  --limit <n>       Max definitions per entry from source (default: 8)
  --dup-policy      merge | skip | replace | ask (default: merge)
  --dup-samples     How many conflict samples to show in ask mode (default: 5)
  --file=<lang>=<path>
                    Override local JSONL file for zh-cn

Examples:
  bun run import:kaikki
  bun run import:kaikki --lang zh-cn --mode diff
  bun run import:kaikki --file=zh-cn=./data/cache/zhwiktionary.jsonl
`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  let langs: ImportLang[] = ['zh-cn', 'zh-tw']
  let mode: ImportMode = 'merge'
  let maxDefsPerEntry = DEFAULT_MAX_DEFINITIONS
  let duplicatePolicy: DuplicateConflictPolicyInput = 'merge'
  let duplicateSamples = 5

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--lang' && next) {
      langs = next.split(',').map((lang) => lang.trim() as ImportLang)
      i++
    } else if (arg === '--mode' && next) {
      if (['merge', 'diff', 'replace', 'refresh'].includes(next)) {
        mode = next as ImportMode
      } else {
        console.error(`Invalid mode: ${next}`)
        process.exit(1)
      }
      i++
    } else if (arg === '--limit' && next) {
      maxDefsPerEntry = parseInt(next, 10)
      if (Number.isNaN(maxDefsPerEntry) || maxDefsPerEntry < 1) {
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

  for (const lang of langs) {
    if (!['zh-cn', 'zh-tw'].includes(lang)) {
      console.error(`Unsupported language: ${lang}`)
      process.exit(1)
    }
  }

  const fileOverrides = parseFileOverrides(args)

  // Ensure zh-cn is processed before zh-tw
  if (langs.includes('zh-tw') && langs.includes('zh-cn')) {
    langs = [...langs.filter((l) => l !== 'zh-tw'), 'zh-tw' as ImportLang]
  }

  console.log('=== [Base] Kaikki Importer ===')
  console.log(`Languages: ${langs.join(', ')}`)
  console.log(`Mode: ${mode}`)
  console.log(`Max defs per entry: ${maxDefsPerEntry}`)
  console.log(`Duplicate policy: ${duplicatePolicy}`)

  await mkdir(DATA_DIR, { recursive: true })
  await mkdir(LANG_DIR, { recursive: true })

  for (const lang of langs) {
    if (lang === 'zh-cn') {
      await importKaikkiLanguage(
        lang,
        mode,
        maxDefsPerEntry,
        duplicatePolicy,
        duplicateSamples,
        fileOverrides[lang]
      )
      continue
    }
    await bootstrapTraditionalChinese(mode, duplicatePolicy, duplicateSamples)
  }

  console.log('\n=== Import Complete ===')
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Import failed:', error)
    process.exit(1)
  })
}
