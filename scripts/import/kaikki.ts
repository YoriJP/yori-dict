/**
 * Kaikki Importer - Imports Korean/Chinese definitions for Japanese entries
 *
 * Data source:
 *   - https://kaikki.org/kowiktionary/raw-wiktextract-data.jsonl.gz
 *   - https://kaikki.org/zhwiktionary/raw-wiktextract-data.jsonl.gz
 * License: CC-BY-SA 3.0 (Wiktionary) / MIT (wiktextract)
 *
 * Usage:
 *   bun run import:kaikki
 *   bun run import:kaikki --lang ko,zh-cn
 *   bun run import:kaikki --mode diff
 *   bun run import:kaikki --file=ko=/path/to/raw-kowiktionary.jsonl
 */

import { mkdir } from 'fs/promises'
import { createReadStream, createWriteStream, existsSync, renameSync, unlinkSync } from 'fs'
import { createInterface } from 'readline'
import { createGunzip } from 'zlib'
import { pipeline } from 'stream/promises'
import {
  type DictEntry,
  type Definition,
  type ImportMode,
  makeKey,
  loadDict,
  saveDict,
  mergeDefinitions,
  mergeDictEntries,
  refreshDictSource,
  printStats,
  downloadWithProgress,
} from './base'

// ============================================================================
// Configuration
// ============================================================================

const DATA_DIR = './data'
const CACHE_DIR = './data/cache'

type ImportLang = 'ko' | 'zh-cn' | 'zh-tw'
type KaikkiSourceLang = Exclude<ImportLang, 'zh-tw'>

const SOURCE_CONFIG: Record<KaikkiSourceLang, { url: string; cacheName: string }> = {
  ko: {
    url: 'https://kaikki.org/kowiktionary/raw-wiktextract-data.jsonl.gz',
    cacheName: 'kaikki-kowiktionary-raw.jsonl.gz',
  },
  'zh-cn': {
    url: 'https://kaikki.org/zhwiktionary/raw-wiktextract-data.jsonl.gz',
    cacheName: 'kaikki-zhwiktionary-raw.jsonl.gz',
  },
}

const INCLUDED_POS = new Set([
  'noun',
  'verb',
  'adj',
  'adv',
  'intj',
  'pron',
  'conj',
  'particle',
  'counter',
  'prefix',
  'suffix',
  'affix',
  'phrase',
  'proverb',
  'num',
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
        if (reading && /[\u3040-\u309F]/.test(reading)) {
          return reading
        }
      }

      if (form.tags?.includes('romanization')) continue

      if (form.form && /^[\u3040-\u309F]+$/.test(form.form)) {
        return form.form
      }

      if (form.form && /^[\u30A0-\u30FF]+$/.test(form.form)) {
        return katakanaToHiragana(form.form)
      }
    }
  }

  if (entry.sounds) {
    for (const sound of entry.sounds) {
      if (sound.other && /^[\u30A0-\u30FF]+$/.test(sound.other)) {
        return katakanaToHiragana(sound.other)
      }
    }
  }

  if (/^[\u3040-\u309F]+$/.test(entry.word)) {
    return entry.word
  }

  if (/^[\u30A0-\u30FF]+$/.test(entry.word)) {
    return katakanaToHiragana(entry.word)
  }

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

  return {
    word: entry.word,
    reading,
    pos: mapPos(entry.pos),
    definitions,
  }
}

async function* streamJsonLines(filePath: string): AsyncGenerator<WiktEntry> {
  const fileStream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  })

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
// Source file resolution (download/cache/local override)
// ============================================================================

async function downloadIfNeeded(url: string, path: string): Promise<void> {
  await downloadWithProgress(url, path)
}

async function gunzipIfNeeded(gzipPath: string, jsonlPath: string): Promise<void> {
  if (existsSync(jsonlPath)) {
    console.log(`  Using cached JSONL: ${jsonlPath}`)
    return
  }

  const tmpPath = jsonlPath + '.tmp'
  console.log('  Decompressing archive...')
  try {
    await pipeline(
      createReadStream(gzipPath),
      createGunzip(),
      createWriteStream(tmpPath)
    )
    renameSync(tmpPath, jsonlPath)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch {}
    throw err
  }
  console.log(`  Wrote JSONL: ${jsonlPath}`)
}

async function resolveSourcePath(
  lang: KaikkiSourceLang,
  fileOverride?: string
): Promise<string> {
  if (fileOverride) {
    if (!existsSync(fileOverride)) {
      throw new Error(`Override file not found for ${lang}: ${fileOverride}`)
    }
    console.log(`  Using override file for ${lang}: ${fileOverride}`)
    return fileOverride
  }

  await mkdir(CACHE_DIR, { recursive: true })
  const source = SOURCE_CONFIG[lang]
  const gzipPath = `${CACHE_DIR}/${source.cacheName}`
  const jsonlPath = gzipPath.replace(/\.gz$/, '')

  await downloadIfNeeded(source.url, gzipPath)
  await gunzipIfNeeded(gzipPath, jsonlPath)

  return jsonlPath
}

// ============================================================================
// Import logic
// ============================================================================

async function importKaikkiLanguage(
  lang: KaikkiSourceLang,
  mode: ImportMode,
  maxDefsPerEntry: number,
  fileOverride?: string
): Promise<ImportStats> {
  console.log(`\n=== Importing ${lang} from Kaikki ===`)
  console.log(`Mode: ${mode}`)

  const sourcePath = await resolveSourcePath(lang, fileOverride)
  const dictPath = `${DATA_DIR}/${lang}.json`
  const dict = await loadDict(dictPath, lang)
  console.log(`  Existing entries: ${Object.keys(dict.entries).length.toLocaleString()}`)

  const sourceEntries: Record<string, DictEntry> = {}
  const stats: ImportStats = {
    processed: 0,
    parsed: 0,
    produced: 0,
  }

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
    const newDefinitions: Definition[] = parsed.definitions
      .slice(0, maxDefsPerEntry)
      .map((text) => ({
        text,
        sources: ['kaikki'],
      }))

    const existing = sourceEntries[key]
    if (existing) {
      existing.partOfSpeech = Array.from(new Set([...existing.partOfSpeech, parsed.pos]))
      existing.definitions = mergeDefinitions(existing.definitions, newDefinitions).slice(0, maxDefsPerEntry)
      continue
    }

    sourceEntries[key] = {
      word: parsed.word,
      reading: parsed.reading,
      partOfSpeech: [parsed.pos],
      common: false,
      jlpt: [],
      definitions: newDefinitions,
      examples: [],
    }
  }

  console.log('')
  stats.produced = Object.keys(sourceEntries).length
  console.log(`  Produced source entries: ${stats.produced.toLocaleString()}`)

  if (mode === 'refresh') {
    const refreshStats = refreshDictSource(dict.entries, sourceEntries, 'kaikki')
    console.log('\n=== Import Statistics ===')
    console.log(`  New entries: ${refreshStats.added.toLocaleString()}`)
    console.log(`  Updated entries: ${refreshStats.updated.toLocaleString()}`)
    console.log(`  Removed entries: ${refreshStats.removed.toLocaleString()}`)
    await saveDict(dictPath, dict)
    console.log(`Saved to: ${dictPath}`)
  } else {
    const mergeStats = mergeDictEntries(dict.entries, sourceEntries, mode)
    printStats(mergeStats, mode)
    if (mode !== 'diff') {
      await saveDict(dictPath, dict)
      console.log(`Saved to: ${dictPath}`)
    }
  }

  return stats
}

async function bootstrapTraditionalChinese(mode: ImportMode): Promise<void> {
  console.log('\n=== Bootstrapping zh-tw from zh-cn ===')
  console.log('This step currently copies zh-cn definitions as-is.')
  console.log('You can add OpenCC conversion in a follow-up step if needed.')

  const zhCnPath = `${DATA_DIR}/zh-cn.json`
  const zhTwPath = `${DATA_DIR}/zh-tw.json`

  if (!existsSync(zhCnPath)) {
    throw new Error('zh-cn.json not found. Run zh-cn import first.')
  }

  const zhCnDict = await loadDict(zhCnPath, 'zh-cn')
  const zhTwDict = await loadDict(zhTwPath, 'zh-tw')

  const clonedEntries: Record<string, DictEntry> = {}
  for (const [key, entry] of Object.entries(zhCnDict.entries)) {
    clonedEntries[key] = structuredClone(entry)
  }

  const stats = mergeDictEntries(zhTwDict.entries, clonedEntries, mode)
  printStats(stats, mode)

  if (mode !== 'diff') {
    await saveDict(zhTwPath, zhTwDict)
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
    if ((lang === 'ko' || lang === 'zh-cn') && filePath) {
      overrides[lang] = filePath
    }
  }

  return overrides
}

function printHelp(): void {
  console.log(`
Kaikki Importer

Imports Korean and Chinese definitions for Japanese entries.
Data source:
  https://kaikki.org/kowiktionary/raw-wiktextract-data.jsonl.gz
  https://kaikki.org/zhwiktionary/raw-wiktextract-data.jsonl.gz

Usage:
  bun run import:kaikki [options]

Options:
  --lang <langs>    Comma-separated: ko,zh-cn,zh-tw (default: ko,zh-cn,zh-tw)
  --mode <mode>     merge | diff | replace | refresh (default: merge)
  --limit <n>       Max definitions per entry from source (default: 8)
  --file=<lang>=<path>
                    Override local JSONL file for ko or zh-cn
                    Example: --file=ko=./data/cache/kowiktionary.jsonl

Examples:
  bun run import:kaikki
  bun run import:kaikki --lang ko,zh-cn --mode diff
  bun run import:kaikki --file=zh-cn=./data/cache/zhwiktionary.jsonl
`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  let langs: ImportLang[] = ['ko', 'zh-cn', 'zh-tw']
  let mode: ImportMode = 'merge'
  let maxDefsPerEntry = DEFAULT_MAX_DEFINITIONS

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--lang' && next) {
      langs = next
        .split(',')
        .map((lang) => lang.trim() as ImportLang)
      i++
    } else if (arg === '--mode' && next) {
      if (next === 'merge' || next === 'diff' || next === 'replace' || next === 'refresh') {
        mode = next
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
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      return
    }
  }

  for (const lang of langs) {
    if (!['ko', 'zh-cn', 'zh-tw'].includes(lang)) {
      console.error(`Unsupported language: ${lang}`)
      console.error('Supported: ko, zh-cn, zh-tw')
      process.exit(1)
    }
  }

  const fileOverrides = parseFileOverrides(args)

  // Ensure zh-cn is processed before zh-tw (zh-tw bootstraps from zh-cn)
  if (langs.includes('zh-tw') && langs.includes('zh-cn')) {
    langs = [...langs.filter((l) => l !== 'zh-tw'), 'zh-tw' as ImportLang]
  }

  console.log('=== Kaikki Importer ===')
  console.log(`Languages: ${langs.join(', ')}`)
  console.log(`Mode: ${mode}`)
  console.log(`Max defs per entry: ${maxDefsPerEntry}`)

  await mkdir(DATA_DIR, { recursive: true })

  for (const lang of langs) {
    if (lang === 'ko' || lang === 'zh-cn') {
      await importKaikkiLanguage(lang, mode, maxDefsPerEntry, fileOverrides[lang])
      continue
    }

    await bootstrapTraditionalChinese(mode)
  }

  console.log('\n=== Import Complete ===')
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Import failed:', error)
    process.exit(1)
  })
}
