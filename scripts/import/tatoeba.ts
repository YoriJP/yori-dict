/**
 * Tatoeba Examples Importer - Adds example sentences to dictionary entries
 *
 * Data sources:
 *   - English: https://www.manythings.org/anki/jpn-eng.zip
 *   - Korean/Chinese: https://downloads.tatoeba.org/exports/per_language/
 * License: CC-BY 2.0 FR
 *
 * Usage:
 *   bun run import:tatoeba
 *   bun run import:tatoeba --lang en,ko,zh-cn
 *   bun run import:tatoeba --mode diff
 *   bun run import:tatoeba --limit 5
 */

import { mkdir } from 'fs/promises'
import { existsSync, readdirSync, createReadStream, renameSync, unlinkSync } from 'fs'
import { createInterface } from 'readline'
import {
  type DictEntry,
  type DictFile,
  type Example,
  loadDict,
  saveDict,
  downloadWithProgress,
} from './base'

// ============================================================================
// Sudachi tokenizer — native subprocess, batch mode
//
// Requires: pip install sudachipy sudachidict-core
//
// All sentences are written to sudachipy stdin at once (-m C = most granular
// split mode). Output format per token (with -a flag):
//   surface\tPOS\tnormalized_form\tdictionary_form\treading\t...
// Sentences are separated by "EOS" lines.
// ============================================================================

interface SudachiMorpheme {
  surface: string
  dictionaryForm: string  // col 4 with -a flag
}

/**
 * Tokenize all sentences in a single sudachipy subprocess call.
 * Returns a parallel array of morpheme arrays (one per sentence).
 * Throws a descriptive error if sudachipy is not installed.
 */
async function tokenizeAll(sentences: string[]): Promise<SudachiMorpheme[][]> {
  // Check sudachipy is available
  try {
    const check = Bun.spawn(['sudachipy', '--version'], { stdout: 'pipe', stderr: 'pipe' })
    await check.exited
  } catch {
    throw new Error(
      'sudachipy not found. Install it with:\n' +
      '  pip install sudachipy sudachidict-core'
    )
  }

  const input = sentences.join('\n') + '\n'

  const proc = Bun.spawn(['sudachipy', '-m', 'C', '-a'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  proc.stdin.write(input)
  proc.stdin.end()

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  if (proc.exitCode !== 0) {
    throw new Error(`sudachipy failed: ${stderr}`)
  }

  // Parse output: tokens separated by newlines, sentences separated by "EOS"
  const result: SudachiMorpheme[][] = []
  let current: SudachiMorpheme[] = []

  for (const line of stdout.split('\n')) {
    if (line === 'EOS' || line === '') {
      if (current.length > 0) {
        result.push(current)
        current = []
      }
      continue
    }
    const cols = line.split('\t')
    if (cols.length >= 4) {
      current.push({ surface: cols[0], dictionaryForm: cols[3] })
    }
  }

  return result
}

// ============================================================================
// Configuration
// ============================================================================

const DATA_DIR = './data'
const CACHE_DIR = './data/cache'
const TATOEBA_BASE = 'https://downloads.tatoeba.org/exports/per_language'

type ImportMode = 'merge' | 'diff' | 'refresh'

type ManyThingsConfig = {
  kind: 'manythings'
  code: string
  url: string
}

type RawPairConfig = {
  kind: 'raw-pair'
  code: string
  targetCode: string
}

type LangConfig = ManyThingsConfig | RawPairConfig

const LANG_CONFIG: Record<string, LangConfig> = {
  en: {
    kind: 'manythings',
    code: 'jpn-eng',
    url: 'https://www.manythings.org/anki/jpn-eng.zip',
  },
  de: {
    kind: 'raw-pair',
    code: 'jpn-deu',
    targetCode: 'deu',
  },
  ko: {
    kind: 'raw-pair',
    code: 'jpn-kor',
    targetCode: 'kor',
  },
  'zh-cn': {
    kind: 'raw-pair',
    code: 'jpn-cmn',
    targetCode: 'cmn',
  },
  // Until script conversion is added, we bootstrap zh-tw examples from the same cmn corpus.
  'zh-tw': {
    kind: 'raw-pair',
    code: 'jpn-cmn',
    targetCode: 'cmn',
  },
}

const DEFAULT_MAX_EXAMPLES = 3

// ============================================================================
// Types
// ============================================================================

interface TatoebaSentence {
  japanese: string
  translation: string
  attribution: string
}

interface WordIndex {
  wordToKeys: Map<string, Set<string>>
  entries: Record<string, DictEntry>
}

interface MatchResult {
  key: string
  sentence: TatoebaSentence
}

interface ImportStats {
  sentencesProcessed: number
  matchesFound: number
  entriesUpdated: number
  examplesAdded: number
}

// ============================================================================
// Download and cache helpers
// ============================================================================

async function ensureDownloaded(url: string, archivePath: string): Promise<void> {
  await downloadWithProgress(url, archivePath)
}

async function unzipIfNeeded(zipPath: string, textPath: string): Promise<void> {
  if (existsSync(textPath)) {
    return
  }

  const tmpPath = textPath + '.tmp'
  try {
    const proc = Bun.spawn(['sh', '-c', `unzip -p "${zipPath}" > "${tmpPath}"`], {
      stdout: 'inherit',
      stderr: 'pipe',
    })
    const stderrText = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      throw new Error(`Failed to unzip ${zipPath}: ${stderrText}`)
    }
    renameSync(tmpPath, textPath)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch {}
    throw err
  }
}

async function bunzip2IfNeeded(bz2Path: string, textPath: string): Promise<void> {
  if (existsSync(textPath)) {
    return
  }

  const tmpPath = textPath + '.tmp'
  console.log(`  Decompressing: ${bz2Path}`)
  try {
    const proc = Bun.spawn(['sh', '-c', `bzip2 -dc "${bz2Path}" > "${tmpPath}"`], {
      stdout: 'inherit',
      stderr: 'pipe',
    })
    const stderrText = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      throw new Error(`Failed to decompress ${bz2Path}: ${stderrText}`)
    }
    renameSync(tmpPath, textPath)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch {}
    throw err
  }
}

// ============================================================================
// Parsing helpers
// ============================================================================

function isJapanese(text: string): boolean {
  return /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(text)
}

function parseManyThingsFile(text: string): TatoebaSentence[] {
  const sentences: TatoebaSentence[] = []
  const lines = text.trim().split('\n')

  for (const line of lines) {
    if (!line.trim()) continue

    const parts = line.split('\t')
    if (parts.length < 2) continue

    let japanese: string
    let translation: string

    if (isJapanese(parts[0])) {
      japanese = parts[0]
      translation = parts[1]
    } else if (isJapanese(parts[1])) {
      japanese = parts[1]
      translation = parts[0]
    } else {
      continue
    }

    sentences.push({
      japanese,
      translation,
      attribution: parts[2] || 'tatoeba',
    })
  }

  return sentences
}

async function* streamTsv(path: string): AsyncGenerator<string[]> {
  const stream = createReadStream(path, { encoding: 'utf-8' })
  const rl = createInterface({
    input: stream,
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    yield line.split('\t')
  }
}

async function collectIdsFromLinks(path: string): Promise<{
  japaneseIds: Set<string>
  translationIds: Set<string>
}> {
  const japaneseIds = new Set<string>()
  const translationIds = new Set<string>()

  for await (const parts of streamTsv(path)) {
    if (parts.length < 2) continue
    const japaneseId = parts[0].trim()
    const translationId = parts[1].trim()
    if (!japaneseId || !translationId) continue
    japaneseIds.add(japaneseId)
    translationIds.add(translationId)
  }

  return { japaneseIds, translationIds }
}

async function loadSentenceMap(path: string, targetIds: Set<string>): Promise<Map<string, string>> {
  const sentenceMap = new Map<string, string>()

  for await (const parts of streamTsv(path)) {
    if (parts.length < 2) continue
    const id = parts[0].trim()
    if (!targetIds.has(id)) continue

    // Per-language files can vary by export profile; sentence text is always the last column.
    const text = parts[parts.length - 1].trim()
    if (!text) continue

    sentenceMap.set(id, text)
  }

  return sentenceMap
}

async function buildSentencePairsFromRaw(
  linksPath: string,
  japaneseSentencesPath: string,
  translationSentencesPath: string,
  code: string
): Promise<TatoebaSentence[]> {
  console.log('  Collecting sentence IDs from links...')
  const { japaneseIds, translationIds } = await collectIdsFromLinks(linksPath)
  console.log(
    `  IDs collected: ${japaneseIds.size.toLocaleString()} Japanese, ` +
      `${translationIds.size.toLocaleString()} translations`
  )

  console.log('  Loading Japanese sentence texts...')
  const japaneseMap = await loadSentenceMap(japaneseSentencesPath, japaneseIds)
  console.log(`  Japanese texts loaded: ${japaneseMap.size.toLocaleString()}`)

  console.log('  Loading translation sentence texts...')
  const translationMap = await loadSentenceMap(translationSentencesPath, translationIds)
  console.log(`  Translation texts loaded: ${translationMap.size.toLocaleString()}`)

  console.log('  Joining link pairs...')
  const pairs: TatoebaSentence[] = []

  for await (const parts of streamTsv(linksPath)) {
    if (parts.length < 2) continue

    const japaneseId = parts[0].trim()
    const translationId = parts[1].trim()
    const japanese = japaneseMap.get(japaneseId)
    const translation = translationMap.get(translationId)
    if (!japanese || !translation) continue
    if (!isJapanese(japanese)) continue

    pairs.push({
      japanese,
      translation,
      attribution: `tatoeba:${code}:${japaneseId}-${translationId}`,
    })
  }

  return pairs
}

// ============================================================================
// Source-specific loaders
// ============================================================================

async function downloadManyThings(config: ManyThingsConfig): Promise<TatoebaSentence[]> {
  await mkdir(CACHE_DIR, { recursive: true })

  const zipPath = `${CACHE_DIR}/tatoeba-${config.code}.zip`
  const textPath = `${CACHE_DIR}/tatoeba-${config.code}.txt`

  await ensureDownloaded(config.url, zipPath)
  await unzipIfNeeded(zipPath, textPath)

  const text = await Bun.file(textPath).text()
  return parseManyThingsFile(text)
}

async function downloadRawPair(config: RawPairConfig): Promise<TatoebaSentence[]> {
  await mkdir(CACHE_DIR, { recursive: true })

  const linksBz2 = `${CACHE_DIR}/tatoeba-${config.code}-links.tsv.bz2`
  const linksTsv = linksBz2.replace(/\.bz2$/, '')
  const jpnSentencesBz2 = `${CACHE_DIR}/tatoeba-jpn-sentences.tsv.bz2`
  const jpnSentencesTsv = jpnSentencesBz2.replace(/\.bz2$/, '')
  const targetSentencesBz2 = `${CACHE_DIR}/tatoeba-${config.targetCode}-sentences.tsv.bz2`
  const targetSentencesTsv = targetSentencesBz2.replace(/\.bz2$/, '')

  const linksUrl = `${TATOEBA_BASE}/jpn/${config.code}_links.tsv.bz2`
  const jpnSentencesUrl = `${TATOEBA_BASE}/jpn/jpn_sentences.tsv.bz2`
  const targetSentencesUrl = `${TATOEBA_BASE}/${config.targetCode}/${config.targetCode}_sentences.tsv.bz2`

  await ensureDownloaded(linksUrl, linksBz2)
  await ensureDownloaded(jpnSentencesUrl, jpnSentencesBz2)
  await ensureDownloaded(targetSentencesUrl, targetSentencesBz2)

  await bunzip2IfNeeded(linksBz2, linksTsv)
  await bunzip2IfNeeded(jpnSentencesBz2, jpnSentencesTsv)
  await bunzip2IfNeeded(targetSentencesBz2, targetSentencesTsv)

  return buildSentencePairsFromRaw(
    linksTsv,
    jpnSentencesTsv,
    targetSentencesTsv,
    config.code
  )
}

async function downloadTatoeba(lang: string): Promise<TatoebaSentence[]> {
  const config = LANG_CONFIG[lang]
  if (!config) {
    console.log(`  No Tatoeba data available for ${lang}`)
    return []
  }

  if (config.kind === 'manythings') {
    return downloadManyThings(config)
  }

  return downloadRawPair(config)
}

// ============================================================================
// Matching logic
// ============================================================================

function buildWordIndex(dict: DictFile): WordIndex {
  const wordToKeys = new Map<string, Set<string>>()

  for (const [key, entry] of Object.entries(dict.entries)) {
    // Index by word (kanji) form only — readings are not indexed to avoid false
    // positives from kana substrings that appear inside unrelated words.
    const wordKeys = wordToKeys.get(entry.word) || new Set()
    wordKeys.add(key)
    wordToKeys.set(entry.word, wordKeys)
  }

  return {
    wordToKeys,
    entries: dict.entries,
  }
}

function findMatchingEntries(
  sentence: TatoebaSentence,
  morphemes: SudachiMorpheme[],
  index: WordIndex,
): MatchResult[] {
  const results: MatchResult[] = []
  const seenKeys = new Set<string>()

  // Try both surface form and dictionary form so inflected forms like
  // 食べた (surface) match dictionary entry 食べる (dictionaryForm).
  const candidates = new Set<string>()
  for (const m of morphemes) {
    candidates.add(m.surface)
    candidates.add(m.dictionaryForm)
  }

  for (const candidate of candidates) {
    const keys = index.wordToKeys.get(candidate)
    if (!keys) continue

    for (const key of keys) {
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      results.push({ key, sentence })
    }
  }

  return results
}

// ============================================================================
// Import logic
// ============================================================================

async function importExamples(
  dict: DictFile,
  sentences: TatoebaSentence[],
  maxExamples: number,
  mode: ImportMode
): Promise<ImportStats> {
  const stats: ImportStats = {
    sentencesProcessed: 0,
    matchesFound: 0,
    entriesUpdated: 0,
    examplesAdded: 0,
  }

  console.log('  Building word index...')
  const index = buildWordIndex(dict)
  console.log(`  Indexed ${index.wordToKeys.size.toLocaleString()} unique words`)

  console.log(`  Tokenizing ${sentences.length.toLocaleString()} sentences with sudachi...`)
  const allMorphemes = await tokenizeAll(sentences.map((s) => s.japanese))
  console.log('  Tokenization complete.')

  const exampleCounts = new Map<string, number>()
  for (const [key, entry] of Object.entries(dict.entries)) {
    exampleCounts.set(key, entry.examples.length)
  }

  const updatedEntries = new Set<string>()

  console.log('  Matching sentences to entries...')
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i]
    const morphemes = allMorphemes[i] ?? []
    stats.sentencesProcessed++

    const matches = findMatchingEntries(sentence, morphemes, index)
    stats.matchesFound += matches.length

    for (const match of matches) {
      const currentCount = exampleCounts.get(match.key) || 0
      if (currentCount >= maxExamples) continue

      const entry = dict.entries[match.key]
      const exists = entry.examples.some(
        (ex) => ex.ja === match.sentence.japanese && ex.text === match.sentence.translation
      )
      if (exists) continue

      const newExample: Example = {
        ja: match.sentence.japanese,
        text: match.sentence.translation,
        sources: ['tatoeba'],
      }

      if (mode !== 'diff') {
        entry.examples.push(newExample)
      }

      exampleCounts.set(match.key, currentCount + 1)
      updatedEntries.add(match.key)
      stats.examplesAdded++
    }
  }

  console.log('')
  stats.entriesUpdated = updatedEntries.size
  return stats
}

async function importTatoeba(langs: string[], mode: ImportMode, maxExamples: number): Promise<void> {
  console.log('=== [Enrichment] Tatoeba Examples Importer ===')
  console.log(`Languages: ${langs.join(', ')}`)
  console.log(`Mode: ${mode}`)
  console.log(`Max examples per word: ${maxExamples}`)

  for (const lang of langs) {
    console.log(`\n=== Processing ${lang} ===`)

    const dictPath = `${DATA_DIR}/${lang}.json`
    if (!existsSync(dictPath)) {
      console.log(`  Dictionary file not found: ${dictPath}`)
      console.log('  Skipping...')
      continue
    }

    console.log('\nDownloading Tatoeba data...')
    const sentences = await downloadTatoeba(lang)
    if (sentences.length === 0) {
      console.log('  No sentences available for this language')
      continue
    }
    console.log(`  Loaded ${sentences.length.toLocaleString()} sentence pairs`)

    console.log('\nLoading dictionary...')
    const dict = await loadDict(dictPath, lang)
    console.log(`  Entries: ${Object.keys(dict.entries).length.toLocaleString()}`)

    if (mode === 'refresh') {
      // Strip all existing tatoeba examples before re-importing
      console.log('\nStripping existing tatoeba examples...')
      let stripped = 0
      for (const entry of Object.values(dict.entries)) {
        const before = entry.examples.length
        entry.examples = entry.examples.filter((e) => !e.sources.includes('tatoeba'))
        stripped += before - entry.examples.length
      }
      console.log(`  Stripped ${stripped.toLocaleString()} tatoeba examples`)
    }

    console.log('\nImporting examples...')
    const stats = await importExamples(dict, sentences, maxExamples, mode === 'refresh' ? 'merge' : mode)

    console.log('\nResults:')
    console.log(`  Sentences processed: ${stats.sentencesProcessed.toLocaleString()}`)
    console.log(`  Matches found: ${stats.matchesFound.toLocaleString()}`)
    console.log(`  Examples added: ${stats.examplesAdded.toLocaleString()}`)
    console.log(`  Entries updated: ${stats.entriesUpdated.toLocaleString()}`)

    if (mode === 'refresh') {
      await saveDict(dictPath, dict)
      console.log(`\nSaved to: ${dictPath}`)
    } else if (mode !== 'diff' && stats.examplesAdded > 0) {
      await saveDict(dictPath, dict)
      console.log(`\nSaved to: ${dictPath}`)
    } else if (mode === 'diff') {
      console.log('\n(Diff mode - no changes made)')
    }
  }
}

// ============================================================================
// CLI
// ============================================================================

function printHelp(): void {
  console.log(`
Tatoeba Examples Importer

Adds example sentences from Tatoeba to dictionary entries.
Data sources:
  - en: manythings.org (jpn-eng)
  - de: Tatoeba raw exports (jpn-deu links + sentence tables)
  - ko: Tatoeba raw exports (jpn-kor links + sentence tables)
  - zh-cn/zh-tw: Tatoeba raw exports (jpn-cmn links + sentence tables)

Usage:
  bun run import:tatoeba [options]

Options:
  --lang    Comma-separated language codes (default: all available)
            Supported: en, de, ko, zh-cn, zh-tw
  --mode    Import mode (default: merge)
            merge   - Add examples to entries
            diff    - Preview changes, no modifications
            refresh - Strip and re-import only tatoeba examples
  --limit   Maximum examples per word (default: ${DEFAULT_MAX_EXAMPLES})

Examples:
  bun run import:tatoeba
  bun run import:tatoeba --lang ko,zh-cn
  bun run import:tatoeba --mode diff
  bun run import:tatoeba --limit 5
`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // Handle --help before any filesystem access
  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    return
  }

  if (!existsSync(DATA_DIR)) {
    console.error(`Data directory not found: ${DATA_DIR}`)
    console.error('This is an enrichment importer — run base importers first:')
    console.error('  bun run import:jmdict --lang en')
    console.error('  (or: bun run rebuild:all for a full rebuild)')
    process.exit(1)
  }

  const availableLangs = readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json') && !f.includes('/'))
    .map((f) => f.replace('.json', ''))
    .filter((lang) => LANG_CONFIG[lang])

  let langs: string[] = availableLangs
  let mode: ImportMode = 'merge'
  let maxExamples = DEFAULT_MAX_EXAMPLES

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--lang' && next) {
      langs = next.split(',').map((s) => s.trim())
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
    } else if (arg === '--limit' && next) {
      maxExamples = parseInt(next, 10)
      if (Number.isNaN(maxExamples) || maxExamples < 1) {
        console.error(`Invalid limit: ${next}`)
        process.exit(1)
      }
      i++
    }
  }

  if (langs.length === 0) {
    console.error('No languages with Tatoeba data available.')
    console.error('Supported: en, ko, zh-cn, zh-tw')
    process.exit(1)
  }

  await importTatoeba(langs, mode, maxExamples)
  console.log('\n=== Import Complete ===')
}

main().catch((err) => {
  console.error('Import failed:', err)
  process.exit(1)
})
