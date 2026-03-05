/**
 * JMdict Importer - Import from jmdict-simplified
 *
 * Writes:
 *   - data/core.json      (word, reading, POS, common)
 *   - data/lang/en.json   (EN definitions)
 *   - data/lang/de.json   (DE definitions)
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
  type CoreEntry,
  type DuplicateConflictPolicyInput,
  type ImportMode,
  makeKey,
  loadCore,
  saveCore,
  createEmptyCore,
  loadLang,
  saveLang,
  createEmptyLang,
  mergeCoreEntries,
  mergeLangEntries,
  analyzeLangDefinitionConflicts,
  resolveDuplicateConflictPolicy,
  printStats,
} from './base'

// ============================================================================
// Configuration
// ============================================================================

const DATA_DIR = './data'
const LANG_DIR = './data/lang'
const CORE_PATH = `${DATA_DIR}/core.json`
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

  await mkdir(CACHE_DIR, { recursive: true })
  const zipPath = `${CACHE_DIR}/temp.zip`
  const buffer = await response.arrayBuffer()
  await Bun.write(zipPath, buffer)

  const proc = Bun.spawn(['unzip', '-p', zipPath], { stdout: 'pipe' })
  const text = await new Response(proc.stdout).text()
  const exitCode = await proc.exited

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

interface ConvertedEntry {
  coreEntry: CoreEntry
  definitions: string[]
}

function convertJMdictEntry(entry: JMdictEntry, lang: string): ConvertedEntry {
  const word = entry.kanji?.[0]?.text || entry.kana[0].text
  const reading = entry.kana[0].text
  const isCommon = entry.kanji?.[0]?.common || entry.kana[0]?.common || false
  const targetGlossLang = REVERSE_LANG_MAP[lang]

  // Collect POS tags (unique strings)
  const posSet = new Set<string>()
  for (const sense of entry.sense) {
    for (const pos of sense.partOfSpeech) {
      posSet.add(POS_MAP[pos] || pos)
    }
  }

  // Collect definitions for this language
  const definitions: string[] = []
  const seenDefs = new Set<string>()
  const includeUntaggedGloss = lang === 'en'
  for (const sense of entry.sense) {
    for (const gloss of sense.gloss) {
      if (!gloss.lang && !includeUntaggedGloss) continue
      if (gloss.lang && gloss.lang !== targetGlossLang) continue
      const normalized = gloss.text.toLowerCase().trim()
      if (seenDefs.has(normalized)) continue
      seenDefs.add(normalized)
      definitions.push(gloss.text)
    }
  }

  return {
    coreEntry: {
      word,
      reading,
      partOfSpeech: Array.from(posSet),
      common: isCommon,
      jlpt: null,
      frequency: null,
    },
    definitions,
  }
}

function convertJMdictToNewFormat(
  jmdict: JMdictFile,
  lang: string
): { coreEntries: Record<string, CoreEntry>; langEntries: Record<string, { definitions: string[] }> } {
  const coreEntries: Record<string, CoreEntry> = {}
  const langEntries: Record<string, { definitions: string[] }> = {}

  for (const jmEntry of jmdict.words) {
    const { coreEntry, definitions } = convertJMdictEntry(jmEntry, lang)
    const key = makeKey(coreEntry.word, coreEntry.reading)

    // Merge into coreEntries (handle duplicate keys)
    if (coreEntries[key]) {
      const existing = coreEntries[key]
      const posSet = new Set([...existing.partOfSpeech, ...coreEntry.partOfSpeech])
      existing.partOfSpeech = Array.from(posSet)
      existing.common = existing.common || coreEntry.common
    } else {
      coreEntries[key] = coreEntry
    }

    // Merge into langEntries (handle duplicate keys)
    if (langEntries[key]) {
      const existing = langEntries[key]
      for (const def of definitions) {
        const normalized = def.toLowerCase().trim()
        if (!existing.definitions.some((d) => d.toLowerCase().trim() === normalized)) {
          existing.definitions.push(def)
        }
      }
    } else {
      langEntries[key] = { definitions }
    }
  }

  return { coreEntries, langEntries }
}

// ============================================================================
// Main Import Function
// ============================================================================

async function importJMdict(
  langs: string[],
  mode: ImportMode,
  duplicatePolicyInput: DuplicateConflictPolicyInput,
  duplicateSamples: number
): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  await mkdir(LANG_DIR, { recursive: true })

  const aggregatedCoreEntries: Record<string, CoreEntry> = {}
  const preparedLangImports: Array<{
    lang: string
    langEntries: Record<string, { definitions: string[] }>
  }> = []

  for (const lang of langs) {
    console.log(`\n=== Importing JMdict (${lang}) ===`)
    console.log(`Mode: ${mode}`)

    const url = await getDownloadUrl(lang)
    if (!url) {
      console.error(`Failed to get download URL for ${lang}`)
      continue
    }

    const jmdictLang = REVERSE_LANG_MAP[lang]
    const cachePath = `${CACHE_DIR}/jmdict-${jmdictLang}.json`
    const jmdict = await downloadAndExtract(url, cachePath)

    if (!jmdict) {
      console.error(`Failed to download JMdict for ${lang}`)
      continue
    }

    console.log(`\nProcessing ${jmdict.words.length.toLocaleString()} JMdict entries...`)
    const { coreEntries, langEntries } = convertJMdictToNewFormat(jmdict, lang)
    console.log(`  Converted to ${Object.keys(coreEntries).length.toLocaleString()} unique entries`)
    mergeCoreEntries(aggregatedCoreEntries, coreEntries, 'merge')
    preparedLangImports.push({ lang, langEntries })
  }

  if (preparedLangImports.length === 0) {
    console.warn('\nNo JMdict language imports succeeded. Nothing to do.')
    return
  }

  // --- Write core.json once using the union of all imported languages ---
  const core = mode === 'replace' ? createEmptyCore() : await loadCore(CORE_PATH)
  const existingCount = Object.keys(core.entries).length
  console.log(`\nCore: ${existingCount.toLocaleString()} existing entries`)
  console.log(`Core source snapshot: ${Object.keys(aggregatedCoreEntries).length.toLocaleString()} aggregated entries`)

  // Refresh for core should rebuild from latest JMdict snapshot.
  const coreStats = mergeCoreEntries(
    core.entries,
    aggregatedCoreEntries,
    mode === 'refresh' ? 'replace' : mode
  )
  if (mode !== 'diff') {
    await saveCore(CORE_PATH, core)
    console.log(`Core saved: ${Object.keys(core.entries).length.toLocaleString()} entries`)
  } else {
    console.log(`Core diff: +${coreStats.added} ~${coreStats.updated} =${coreStats.unchanged}`)
  }

  for (const { lang, langEntries } of preparedLangImports) {
    // --- Write lang/{lang}.json ---
    const langPath = `${LANG_DIR}/${lang}.json`
    const langFile = mode === 'replace' ? createEmptyLang(lang) : await loadLang(langPath, lang)
    const existingLangCount = Object.keys(langFile.entries).length
    console.log(`\nLang/${lang}: ${existingLangCount.toLocaleString()} existing entries`)

    if (mode === 'refresh') {
      // Strip jmdict definitions, then re-add
      const { refreshLangSource } = await import('./base')
      refreshLangSource(langFile.entries, 'jmdict')
    }

    const langStats = mergeLangEntries(
      langFile.entries,
      langEntries,
      'jmdict',
      mode === 'refresh' ? 'merge' : mode,
      await resolveDuplicateConflictPolicy(
        `jmdict/${lang}`,
        duplicatePolicyInput,
        analyzeLangDefinitionConflicts(langFile.entries, langEntries, duplicateSamples)
      )
    )

    if (mode !== 'diff') {
      await saveLang(langPath, langFile)
      console.log(`Lang/${lang} saved: ${Object.keys(langFile.entries).length.toLocaleString()} entries`)
    }

    console.log('\n=== Import Statistics ===')
    console.log(`  New entries: ${langStats.added.toLocaleString()}`)
    console.log(`  Updated entries: ${langStats.updated.toLocaleString()}`)
    console.log(`  Unchanged entries: ${langStats.unchanged.toLocaleString()}`)
    if (mode === 'diff') console.log('\n  (Diff mode - no changes made)')
  }
}

// ============================================================================
// CLI
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  let langs: string[] = ['en']
  let mode: ImportMode = 'merge'
  let duplicatePolicy: DuplicateConflictPolicyInput = 'merge'
  let duplicateSamples = 5

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lang' && args[i + 1]) {
      langs = args[i + 1].split(',')
      i++
    } else if (args[i] === '--mode' && args[i + 1]) {
      mode = args[i + 1] as ImportMode
      i++
    } else if (args[i] === '--dup-policy' && args[i + 1]) {
      const next = args[i + 1]
      if (['merge', 'skip', 'replace', 'ask'].includes(next)) {
        duplicatePolicy = next as DuplicateConflictPolicyInput
      } else {
        console.error(`Invalid --dup-policy: ${next}`)
        process.exit(1)
      }
      i++
    } else if (args[i] === '--dup-samples' && args[i + 1]) {
      duplicateSamples = parseInt(args[i + 1], 10)
      if (Number.isNaN(duplicateSamples) || duplicateSamples < 1) {
        console.error(`Invalid --dup-samples: ${args[i + 1]}`)
        process.exit(1)
      }
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
            replace - Replace all JMdict entries (rebuilds core + lang)
            refresh - Strip and re-import only JMdict data
  --dup-policy   How to handle conflicting incoming definitions
                 merge | skip | replace | ask (default: merge)
  --dup-samples  How many conflict samples to show in ask mode (default: 5)

Examples:
  bun run import:jmdict --lang en
  bun run import:jmdict --lang en,de
  bun run import:jmdict --lang en --mode diff
  bun run import:jmdict --lang en --dup-policy ask
`)
      return
    }
  }

  if (!['merge', 'diff', 'replace', 'refresh'].includes(mode)) {
    console.error(`Invalid mode: ${mode}`)
    process.exit(1)
  }

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
  console.log(`Duplicate policy: ${duplicatePolicy}`)

  await importJMdict(langs, mode, duplicatePolicy, duplicateSamples)

  console.log('\n=== Import Complete ===')
}

main().catch((err) => {
  console.error('Import failed:', err)
  process.exit(1)
})
