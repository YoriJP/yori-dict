/**
 * JMdict Importer - Import from jmdict-simplified
 *
 * Usage:
 *   bun run import:jmdict --lang en
 *   bun run import:jmdict --lang en,de
 *   bun run import:jmdict --lang en --mode diff
 *   bun run import:jmdict --lang en --mode merge (default)
 *   bun run import:jmdict --lang en --mode replace
 */

import { mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import {
  type DictEntry,
  type DictFile,
  type ImportMode,
  makeKey,
  loadDict,
  saveDict,
  mergeDictEntries,
  refreshDictSource,
  printStats,
  createEmptyDict,
  mergeArrays,
} from './base'

// ============================================================================
// Configuration
// ============================================================================

const DATA_DIR = './data'
const CACHE_DIR = './data/cache'

// Language mapping from JMdict codes to our codes
const LANG_MAP: Record<string, string> = {
  eng: 'en',
  ger: 'de',
}

// Reverse mapping
const REVERSE_LANG_MAP: Record<string, string> = {
  en: 'eng',
  de: 'ger',
}

// Part of speech mapping to human-readable names
const POS_MAP: Record<string, string> = {
  v1: 'ichidan verb',
  v5u: 'godan verb',
  v5k: 'godan verb',
  v5g: 'godan verb',
  v5s: 'godan verb',
  v5t: 'godan verb',
  v5n: 'godan verb',
  v5b: 'godan verb',
  v5m: 'godan verb',
  v5r: 'godan verb',
  v5aru: 'godan verb',
  'v5k-s': 'godan verb',
  'v5u-s': 'godan verb',
  'v5r-i': 'godan verb',
  vk: 'kuru verb',
  vs: 'suru verb',
  'vs-i': 'suru verb',
  'vs-s': 'suru verb',
  vz: 'ichidan verb',
  vt: 'transitive verb',
  vi: 'intransitive verb',
  'adj-i': 'i-adjective',
  'adj-ix': 'i-adjective',
  'adj-na': 'na-adjective',
  'adj-no': 'no-adjective',
  'adj-pn': 'pre-noun adjectival',
  'adj-t': 'taru adjective',
  'adj-f': 'prenominal adjective',
  n: 'noun',
  'n-adv': 'adverbial noun',
  'n-suf': 'noun suffix',
  'n-pref': 'noun prefix',
  'n-t': 'temporal noun',
  adv: 'adverb',
  'adv-to': 'adverb',
  aux: 'auxiliary',
  'aux-v': 'auxiliary verb',
  'aux-adj': 'auxiliary adjective',
  conj: 'conjunction',
  cop: 'copula',
  ctr: 'counter',
  exp: 'expression',
  int: 'interjection',
  pn: 'pronoun',
  pref: 'prefix',
  prt: 'particle',
  suf: 'suffix',
  unc: 'unclassified',
}

// ============================================================================
// JMdict Types
// ============================================================================

interface JMdictEntry {
  id: string
  kanji?: { text: string; common?: boolean }[]
  kana: { text: string; common?: boolean }[]
  sense: {
    partOfSpeech: string[]
    gloss: { lang?: string; text: string }[]
  }[]
}

interface JMdictFile {
  version: string
  words: JMdictEntry[]
}

interface GitHubRelease {
  assets: { name: string; browser_download_url: string }[]
}

// ============================================================================
// Download Functions
// ============================================================================

async function getDownloadUrl(lang: string): Promise<string | null> {
  const jmdictLang = REVERSE_LANG_MAP[lang]
  if (!jmdictLang) {
    console.error(`  Unknown language: ${lang}`)
    return null
  }

  console.log(`Fetching latest JMdict release for ${lang}...`)

  const response = await fetch('https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest', {
    headers: { 'User-Agent': 'yori-dict-importer' },
  })

  if (!response.ok) {
    console.error(`  GitHub API failed: ${response.status}`)
    return null
  }

  const release: GitHubRelease = await response.json()
  const pattern = `jmdict-${jmdictLang}-`
  const asset = release.assets.find((a) => a.name.includes(pattern) && a.name.endsWith('.json.zip'))

  if (!asset) {
    console.error(`  Asset matching "${pattern}" not found`)
    return null
  }

  console.log(`  Found: ${asset.name}`)
  return asset.browser_download_url
}

async function downloadAndExtract(url: string, cachePath: string): Promise<JMdictFile | null> {
  // Check cache
  if (existsSync(cachePath)) {
    console.log(`Using cached: ${cachePath}`)
    return Bun.file(cachePath).json()
  }

  console.log(`Downloading: ${url}`)

  const response = await fetch(url, {
    headers: { 'User-Agent': 'yori-dict-importer' },
  })

  if (!response.ok) {
    console.error(`  Download failed: ${response.status}`)
    return null
  }

  // Save ZIP temporarily
  await mkdir(CACHE_DIR, { recursive: true })
  const zipPath = `${CACHE_DIR}/temp.zip`
  const buffer = await response.arrayBuffer()
  await Bun.write(zipPath, buffer)

  // Extract using unzip
  const proc = Bun.spawn(['unzip', '-p', zipPath], { stdout: 'pipe' })
  const text = await new Response(proc.stdout).text()
  const exitCode = await proc.exited

  // Clean up ZIP regardless of outcome
  const { unlinkSync } = await import('fs')
  unlinkSync(zipPath)

  if (exitCode !== 0) {
    throw new Error(`unzip failed with exit code ${exitCode}`)
  }

  await Bun.write(cachePath, text)
  console.log(`  Cached to: ${cachePath}`)

  return JSON.parse(text)
}

// ============================================================================
// Conversion Functions
// ============================================================================

function convertJMdictEntry(entry: JMdictEntry, lang: string): DictEntry {
  const word = entry.kanji?.[0]?.text || entry.kana[0].text
  const reading = entry.kana[0].text
  const isCommon = entry.kanji?.[0]?.common || entry.kana[0]?.common || false
  const targetGlossLang = REVERSE_LANG_MAP[lang]

  // Collect POS tags
  const posSet = new Set<string>()
  for (const sense of entry.sense) {
    for (const pos of sense.partOfSpeech) {
      posSet.add(POS_MAP[pos] || pos)
    }
  }

  // Collect definitions for this language, deduplicating by normalized text
  const definitions: { text: string; sources: string[] }[] = []
  const seenDefs = new Set<string>()
  const includeUntaggedGloss = lang === 'en'
  for (const sense of entry.sense) {
    for (const gloss of sense.gloss) {
      // Untagged glosses in JMdict are effectively English defaults.
      if (!gloss.lang && !includeUntaggedGloss) continue
      if (gloss.lang && gloss.lang !== targetGlossLang) continue
      const normalized = gloss.text.toLowerCase().trim()
      if (seenDefs.has(normalized)) continue
      seenDefs.add(normalized)
      definitions.push({
        text: gloss.text,
        sources: ['jmdict'],
      })
    }
  }

  return {
    word,
    reading,
    partOfSpeech: Array.from(posSet).map((value) => ({ value, sources: ['jmdict'] })),
    common: isCommon,
    commonSources: isCommon ? ['jmdict'] : [],
    jlpt: [],
    definitions,
    examples: [],
  }
}

function convertJMdictToDict(jmdict: JMdictFile, lang: string): Record<string, DictEntry> {
  const entries: Record<string, DictEntry> = {}

  for (const jmEntry of jmdict.words) {
    const entry = convertJMdictEntry(jmEntry, lang)
    const key = makeKey(entry.word, entry.reading)

    // Handle duplicate keys (same word+reading)
    if (entries[key]) {
      // Merge definitions
      const existing = entries[key]
      for (const def of entry.definitions) {
        const exists = existing.definitions.some(
          (d) => d.text.toLowerCase() === def.text.toLowerCase()
        )
        if (!exists) {
          existing.definitions.push(def)
        }
      }
      // Merge POS
      for (const posEntry of entry.partOfSpeech) {
        const ep = existing.partOfSpeech.find((p) => p.value === posEntry.value)
        if (ep) {
          ep.sources = mergeArrays(ep.sources, posEntry.sources)
        } else {
          existing.partOfSpeech.push(posEntry)
        }
      }
      // Preserve common if any duplicate marks it common
      existing.common = existing.common || entry.common
      existing.commonSources = mergeArrays(existing.commonSources, entry.commonSources)
    } else {
      entries[key] = entry
    }
  }

  return entries
}

// ============================================================================
// Main Import Function
// ============================================================================

async function importJMdict(lang: string, mode: ImportMode): Promise<void> {
  console.log(`\n=== Importing JMdict (${lang}) ===`)
  console.log(`Mode: ${mode}`)

  // Get download URL
  const url = await getDownloadUrl(lang)
  if (!url) {
    console.error(`Failed to get download URL for ${lang}`)
    return
  }

  // Download and extract
  const jmdictLang = REVERSE_LANG_MAP[lang]
  const cachePath = `${CACHE_DIR}/jmdict-${jmdictLang}.json`
  const jmdict = await downloadAndExtract(url, cachePath)

  if (!jmdict) {
    console.error(`Failed to download JMdict for ${lang}`)
    return
  }

  console.log(`\nProcessing ${jmdict.words.length.toLocaleString()} JMdict entries...`)

  // Convert to our format
  const sourceEntries = convertJMdictToDict(jmdict, lang)
  console.log(`  Converted to ${Object.keys(sourceEntries).toLocaleString()} unique entries`)

  // Load existing dictionary or create new
  await mkdir(DATA_DIR, { recursive: true })
  const dictPath = `${DATA_DIR}/${lang}.json`
  const dict = await loadDict(dictPath, lang)

  const existingCount = Object.keys(dict.entries).length
  console.log(`  Existing entries: ${existingCount.toLocaleString()}`)

  // Merge
  let stats: { added: number; updated: number; unchanged: number } | { added: number; updated: number; removed: number }
  if (mode === 'refresh') {
    stats = refreshDictSource(dict.entries, sourceEntries, 'jmdict')
    console.log('\n=== Import Statistics ===')
    console.log(`  New entries: ${stats.added.toLocaleString()}`)
    console.log(`  Updated entries: ${stats.updated.toLocaleString()}`)
    console.log(`  Removed entries: ${'removed' in stats ? stats.removed.toLocaleString() : 0}`)
  } else {
    stats = mergeDictEntries(dict.entries, sourceEntries, mode)
    printStats(stats as { added: number; updated: number; unchanged: number }, mode)
  }

  // Save if not diff mode
  if (mode !== 'diff') {
    await saveDict(dictPath, dict)
    console.log(`\nSaved to: ${dictPath}`)
    console.log(`Total entries: ${Object.keys(dict.entries).length.toLocaleString()}`)
  }
}

// ============================================================================
// CLI
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // Parse arguments
  let langs: string[] = ['en']
  let mode: ImportMode = 'merge'

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lang' && args[i + 1]) {
      langs = args[i + 1].split(',')
      i++
    } else if (args[i] === '--mode' && args[i + 1]) {
      mode = args[i + 1] as ImportMode
      i++
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
JMdict Importer

Usage:
  bun run import:jmdict --lang <languages> --mode <mode>

Options:
  --lang    Comma-separated languages (default: en)
            Supported: en, de
  --mode    Import mode (default: merge)
            merge   - Add new entries, merge definitions
            diff    - Preview changes, no modifications
            replace - Replace all JMdict entries (dangerous!)
            refresh - Strip and re-import only JMdict data

Examples:
  bun run import:jmdict --lang en
  bun run import:jmdict --lang en,de
  bun run import:jmdict --lang en --mode diff
`)
      return
    }
  }

  // Validate mode
  if (!['merge', 'diff', 'replace', 'refresh'].includes(mode)) {
    console.error(`Invalid mode: ${mode}`)
    console.error('Supported modes: merge, diff, replace, refresh')
    process.exit(1)
  }

  // Validate languages
  for (const lang of langs) {
    if (!REVERSE_LANG_MAP[lang]) {
      console.error(`Unsupported language: ${lang}`)
      console.error('Supported: en, de')
      process.exit(1)
    }
  }

  console.log('=== [Base] JMdict Importer ===')
  console.log(`Languages: ${langs.join(', ')}`)
  console.log(`Mode: ${mode}`)

  // Import each language
  for (const lang of langs) {
    await importJMdict(lang, mode)
  }

  console.log('\n=== Import Complete ===')
}

main().catch((err) => {
  console.error('Import failed:', err)
  process.exit(1)
})
