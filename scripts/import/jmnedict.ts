/**
 * JMnedict Importer - Import proper names from jmdict-simplified
 *
 * Writes:
 *   - data/core.json          (POS for proper names)
 *   - data/lang/{lang}.json   (name definitions in all languages)
 *
 * Usage:
 *   bun run import:jmnedict
 *   bun run import:jmnedict --mode diff
 *   bun run import:jmnedict --mode replace
 */

import { mkdir } from 'fs/promises'
import { existsSync, unlinkSync } from 'fs'
import {
  type CoreEntry,
  type LangEntry,
  type LangFile,
  type DuplicateConflictPolicyInput,
  type ImportMode,
  makeKey,
  loadCore,
  saveCore,
  loadLang,
  saveLang,
  mergeCoreEntries,
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
const CORE_PATH = `${DATA_DIR}/core.json`
const CACHE_DIR = './data/cache'
const CACHE_PATH = `${CACHE_DIR}/jmnedict-all.json`

const ALL_LANGS = ['en', 'de', 'ko', 'zh-cn', 'zh-tw']

// ============================================================================
// JMnedict Types
// ============================================================================

interface JMnedictKanji {
  text: string
  tags: string[]
}

interface JMnedictKana {
  text: string
  tags: string[]
  appliesToKanji: string[]
}

interface JMnedictTranslationEntry {
  lang: string
  text: string
}

interface JMnedictTranslation {
  type: string[]
  related: unknown[]
  translation: JMnedictTranslationEntry[]
}

interface JMnedictWord {
  id: string
  kanji: JMnedictKanji[]
  kana: JMnedictKana[]
  translation: JMnedictTranslation[]
}

interface JMnedictFile {
  version: string
  tags: Record<string, string>
  words: JMnedictWord[]
}

// ============================================================================
// Name type → human-readable part of speech
// ============================================================================

const NAME_TYPE_MAP: Record<string, string> = {
  surname:      'surname',
  fem:          'female given name',
  masc:         'male given name',
  given:        'given name',
  person:       'full name',
  place:        'place name',
  station:      'train station',
  company:      'company name',
  organization: 'organization name',
  product:      'product name',
  work:         'work title',
  group:        'group name',
  serv:         'service name',
  char:         'character name',
  doc:          'document name',
  ev:           'event name',
  obj:          'object name',
  creat:        'creature name',
  relig:        'religion',
  dei:          'deity name',
  myth:         'mythology',
  leg:          'legend',
  fict:         'fiction',
  ship:         'ship name',
  unclass:      'proper noun',
  oth:          'proper noun',
}

// ============================================================================
// Download
// ============================================================================

async function getDownloadUrl(): Promise<string> {
  const response = await fetch(
    'https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest',
    { headers: { 'User-Agent': 'yori-dict-importer' } }
  )
  if (!response.ok) throw new Error(`GitHub API failed: ${response.status}`)

  const release: { assets: { name: string; browser_download_url: string }[] } = await response.json()
  const asset = release.assets.find(
    (a) => a.name.startsWith('jmnedict-all-') && a.name.endsWith('.json.zip')
  )
  if (!asset) throw new Error('jmnedict-all-*.json.zip not found in release assets')

  console.log(`  Found: ${asset.name}`)
  return asset.browser_download_url
}

async function downloadJMnedict(): Promise<JMnedictFile> {
  await mkdir(CACHE_DIR, { recursive: true })

  if (existsSync(CACHE_PATH)) {
    console.log(`Using cached: ${CACHE_PATH}`)
    return Bun.file(CACHE_PATH).json()
  }

  console.log('Fetching latest JMnedict release...')
  const url = await getDownloadUrl()

  console.log(`Downloading: ${url}`)
  const response = await fetch(url, { headers: { 'User-Agent': 'yori-dict-importer' } })
  if (!response.ok) throw new Error(`Download failed: ${response.status}`)

  const zipPath = `${CACHE_DIR}/jmnedict-all.json.zip`
  await Bun.write(zipPath, await response.arrayBuffer())

  const tmpPath = CACHE_PATH + '.tmp'
  try {
    const proc = Bun.spawn(['sh', '-c', `unzip -p "${zipPath}" > "${tmpPath}"`], {
      stdout: 'inherit',
      stderr: 'pipe',
    })
    const stderrText = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    if (exitCode !== 0) throw new Error(`unzip failed: ${stderrText}`)

    const { renameSync } = await import('fs')
    renameSync(tmpPath, CACHE_PATH)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch {}
    throw err
  } finally {
    try { unlinkSync(zipPath) } catch {}
  }

  console.log(`  Cached to: ${CACHE_PATH}`)
  return Bun.file(CACHE_PATH).json()
}

// ============================================================================
// Conversion
// ============================================================================

interface ConvertedEntry {
  coreEntry: CoreEntry
  definitions: string[]  // English romanized names
}

function convertJMnedictEntry(word: JMnedictWord): ConvertedEntry | null {
  const kanjiText = word.kanji[0]?.text
  const kanaText = word.kana[0]?.text
  if (!kanaText) return null

  const headword = kanjiText || kanaText
  const reading = kanaText

  const posSet = new Set<string>()
  for (const t of word.translation) {
    for (const tag of t.type) {
      const readable = NAME_TYPE_MAP[tag]
      if (readable) posSet.add(readable)
    }
  }
  if (posSet.size === 0) posSet.add('proper noun')

  const definitions: string[] = []
  const seenDefs = new Set<string>()
  for (const t of word.translation) {
    for (const tr of t.translation) {
      if (tr.lang !== 'eng') continue
      const normalized = tr.text.toLowerCase().trim()
      if (seenDefs.has(normalized)) continue
      seenDefs.add(normalized)
      definitions.push(tr.text)
    }
  }

  return {
    coreEntry: {
      word: headword,
      reading,
      partOfSpeech: Array.from(posSet),
      common: false,
      jlpt: null,
      frequency: null,
    },
    definitions,
  }
}

function buildSourceData(jmnedict: JMnedictFile): {
  coreEntries: Record<string, CoreEntry>
  langEntries: Record<string, { definitions: string[] }>
} {
  const coreEntries: Record<string, CoreEntry> = {}
  const langEntries: Record<string, { definitions: string[] }> = {}

  for (const word of jmnedict.words) {
    const converted = convertJMnedictEntry(word)
    if (!converted) continue

    const key = makeKey(converted.coreEntry.word, converted.coreEntry.reading)

    if (coreEntries[key]) {
      const existing = coreEntries[key]
      const posSet = new Set([...existing.partOfSpeech, ...converted.coreEntry.partOfSpeech])
      existing.partOfSpeech = Array.from(posSet)
    } else {
      coreEntries[key] = converted.coreEntry
    }

    if (langEntries[key]) {
      for (const def of converted.definitions) {
        const normalized = def.toLowerCase().trim()
        if (!langEntries[key].definitions.some((d) => d.toLowerCase().trim() === normalized)) {
          langEntries[key].definitions.push(def)
        }
      }
    } else {
      langEntries[key] = { definitions: converted.definitions }
    }
  }

  return { coreEntries, langEntries }
}

function collectSourceKeysFromLangEntries(
  entries: Record<string, LangEntry>,
  sourceName: string
): Set<string> {
  const keys = new Set<string>()

  for (const [key, entry] of Object.entries(entries)) {
    const hasSourceDef = entry.definitions.some((def) => {
      const sources = entry._defSources[def] ?? []
      return sources.includes(sourceName)
    })
    if (hasSourceDef) keys.add(key)
  }

  return keys
}

function stripJmnedictFromCore(
  coreEntries: Record<string, CoreEntry>,
  keysToStrip: Set<string>
): number {
  const namePos = new Set(Object.values(NAME_TYPE_MAP))
  namePos.add('proper noun')

  let strippedEntries = 0

  for (const key of keysToStrip) {
    const entry = coreEntries[key]
    if (!entry) continue
    const beforeLength = entry.partOfSpeech.length
    entry.partOfSpeech = entry.partOfSpeech.filter((pos) => !namePos.has(pos))
    if (entry.partOfSpeech.length !== beforeLength) {
      strippedEntries++
    }
  }

  return strippedEntries
}

// ============================================================================
// Import
// ============================================================================

async function importJMnedict(
  langs: string[],
  mode: ImportMode,
  duplicatePolicyInput: DuplicateConflictPolicyInput,
  duplicateSamples: number
): Promise<void> {
  console.log('=== [Base] JMnedict Importer ===')
  console.log(`Languages: ${langs.join(', ')}`)
  console.log(`Mode: ${mode}`)

  await mkdir(DATA_DIR, { recursive: true })
  await mkdir(LANG_DIR, { recursive: true })

  const jmnedict = await downloadJMnedict()
  console.log(`\nLoaded ${jmnedict.words.length.toLocaleString()} JMnedict entries`)

  console.log('Converting entries...')
  const { coreEntries, langEntries } = buildSourceData(jmnedict)
  console.log(`  Converted to ${Object.keys(coreEntries).length.toLocaleString()} unique entries`)

  // Preload lang files so refresh can target existing jmnedict keys only.
  const loadedLangFiles: Array<{ lang: string; langPath: string; langFile: LangFile }> = []
  const jmnedictKeysToRefresh = new Set<string>()
  for (const lang of langs) {
    const langPath = `${LANG_DIR}/${lang}.json`
    const langFile = await loadLang(langPath, lang)
    loadedLangFiles.push({ lang, langPath, langFile })

    if (mode === 'refresh') {
      const keys = collectSourceKeysFromLangEntries(langFile.entries, 'jmnedict')
      for (const key of keys) jmnedictKeysToRefresh.add(key)
    }
  }

  // --- Update core.json ---
  console.log('\n--- Updating core.json ---')
  const core = await loadCore(CORE_PATH)
  console.log(`  Existing entries: ${Object.keys(core.entries).length.toLocaleString()}`)

  let coreStats: { added: number; updated: number; unchanged: number }
  if (mode === 'refresh') {
    const stripped = stripJmnedictFromCore(core.entries, jmnedictKeysToRefresh)
    console.log(
      `  Stripped jmnedict POS from ${stripped.toLocaleString()} existing entries `
      + `(across ${jmnedictKeysToRefresh.size.toLocaleString()} jmnedict keys)`
    )
    coreStats = mergeCoreEntries(core.entries, coreEntries, 'merge')
  } else {
    coreStats = mergeCoreEntries(core.entries, coreEntries, mode)
  }

  if (mode !== 'diff') {
    await saveCore(CORE_PATH, core)
    console.log(`  Core saved: ${Object.keys(core.entries).length.toLocaleString()} entries`)
  } else {
    console.log(`  Core diff: +${coreStats.added} ~${coreStats.updated} =${coreStats.unchanged}`)
  }

  // --- Update lang files ---
  for (const { lang, langPath, langFile } of loadedLangFiles) {
    console.log(`\n=== Updating lang/${lang}.json (${Object.keys(langFile.entries).length.toLocaleString()} existing) ===`)

    if (mode === 'refresh') {
      refreshLangSource(langFile.entries, 'jmnedict')
    }

    const langStats = mergeLangEntries(
      langFile.entries,
      langEntries,
      'jmnedict',
      mode === 'refresh' ? 'merge' : mode,
      await resolveDuplicateConflictPolicy(
        `jmnedict/${lang}`,
        duplicatePolicyInput,
        analyzeLangDefinitionConflicts(langFile.entries, langEntries, duplicateSamples)
      )
    )

    if (mode !== 'diff') {
      await saveLang(langPath, langFile)
      console.log(`  Saved: ${langPath} (${Object.keys(langFile.entries).length.toLocaleString()} total)`)
    }

    printStats(langStats as { added: number; updated: number; unchanged: number }, mode)
  }
}

// ============================================================================
// CLI
// ============================================================================

function printHelp(): void {
  console.log(`
JMnedict Importer

Adds ~740k Japanese proper name entries (surnames, given names, place names,
company names, etc.) to all language dictionaries.

Usage:
  bun run import:jmnedict [options]

Options:
  --lang    Comma-separated language codes (default: all with existing lang files)
            Supported: en, de, ko, zh-cn, zh-tw
  --mode    Import mode (default: merge)
            replace - Full snapshot sync: remove stale entries, overwrite all
            merge   - Add new entries, merge definitions for existing
            diff    - Preview changes, no modifications
            refresh - Strip and re-import only jmnedict data
  --dup-policy   How to handle conflicting incoming definitions
                 merge | skip | replace | ask (default: merge)
  --dup-samples  How many conflict samples to show in ask mode (default: 5)

Examples:
  bun run import:jmnedict
  bun run import:jmnedict --mode diff
  bun run import:jmnedict --lang en
`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    return
  }

  // Default: all langs with existing lang files
  let langs: string[] = ALL_LANGS.filter((lang) => existsSync(`${LANG_DIR}/${lang}.json`))
  let mode: ImportMode = 'merge'
  let duplicatePolicy: DuplicateConflictPolicyInput = 'merge'
  let duplicateSamples = 5

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]
    if (arg === '--lang' && next) {
      langs = next.split(',').map((s) => s.trim())
      i++
    } else if (arg === '--mode' && next) {
      if (['merge', 'diff', 'replace', 'refresh'].includes(next)) {
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
    }
  }

  if (langs.length === 0) {
    console.error('No language dictionaries found. Run base importers first.')
    process.exit(1)
  }

  console.log(`Duplicate policy: ${duplicatePolicy}`)
  await importJMnedict(langs, mode, duplicatePolicy, duplicateSamples)
  console.log('\n=== Import Complete ===')
}

main().catch((err) => {
  console.error('Import failed:', err)
  process.exit(1)
})
