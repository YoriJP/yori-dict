/**
 * JMnedict Importer - Import proper names from jmdict-simplified
 *
 * Adds ~740k Japanese proper name entries (surnames, given names, place names,
 * company names, etc.) to all language dictionaries.
 *
 * Source: https://github.com/scriptin/jmdict-simplified
 * License: CC BY-SA 3.0
 *
 * Usage:
 *   bun run import:jmnedict
 *   bun run import:jmnedict --mode diff
 *   bun run import:jmnedict --mode replace
 */

import { mkdir } from 'fs/promises'
import { existsSync, unlinkSync } from 'fs'
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
} from './base'

// ============================================================================
// Configuration
// ============================================================================

const DATA_DIR = './data'
const CACHE_DIR = './data/cache'
const CACHE_PATH = `${CACHE_DIR}/jmnedict-all.json`

// All languages we maintain dictionaries for
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

// Maps JMnedict type tags to readable partOfSpeech values
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

function convertJMnedictEntry(word: JMnedictWord, tags: Record<string, string>): DictEntry | null {
  const kanjiText = word.kanji[0]?.text
  const kanaText = word.kana[0]?.text
  if (!kanaText) return null

  const headword = kanjiText || kanaText
  const reading = kanaText

  // Collect all name type tags across all translations
  const posSet = new Set<string>()
  for (const t of word.translation) {
    for (const tag of t.type) {
      const readable = NAME_TYPE_MAP[tag]
      if (readable) posSet.add(readable)
    }
  }
  if (posSet.size === 0) posSet.add('proper noun')

  // English gloss (translation text)
  const definitions: { text: string; sources: string[] }[] = []
  const seenDefs = new Set<string>()
  for (const t of word.translation) {
    for (const tr of t.translation) {
      if (tr.lang !== 'eng') continue
      const normalized = tr.text.toLowerCase().trim()
      if (seenDefs.has(normalized)) continue
      seenDefs.add(normalized)
      definitions.push({ text: tr.text, sources: ['jmnedict'] })
    }
  }

  return {
    word: headword,
    reading,
    partOfSpeech: Array.from(posSet).map((value) => ({ value, sources: ['jmnedict'] })),
    common: false,
    commonSources: [],
    jlpt: [],
    definitions,
    examples: [],
  }
}

function buildSourceEntries(jmnedict: JMnedictFile): Record<string, DictEntry> {
  const entries: Record<string, DictEntry> = {}

  for (const word of jmnedict.words) {
    const entry = convertJMnedictEntry(word, jmnedict.tags)
    if (!entry) continue

    const key = makeKey(entry.word, entry.reading)

    if (entries[key]) {
      // Merge definitions and POS from duplicate keys
      const existing = entries[key]
      for (const def of entry.definitions) {
        const exists = existing.definitions.some(
          (d) => d.text.toLowerCase() === def.text.toLowerCase()
        )
        if (!exists) existing.definitions.push(def)
      }
      for (const posEntry of entry.partOfSpeech) {
        if (!existing.partOfSpeech.find((p) => p.value === posEntry.value)) {
          existing.partOfSpeech.push(posEntry)
        }
      }
    } else {
      entries[key] = entry
    }
  }

  return entries
}

// ============================================================================
// Import
// ============================================================================

async function importJMnedict(langs: string[], mode: ImportMode): Promise<void> {
  console.log('=== [Base] JMnedict Importer ===')
  console.log(`Languages: ${langs.join(', ')}`)
  console.log(`Mode: ${mode}`)

  const jmnedict = await downloadJMnedict()
  console.log(`\nLoaded ${jmnedict.words.length.toLocaleString()} JMnedict entries`)

  console.log('Converting entries...')
  const sourceEntries = buildSourceEntries(jmnedict)
  console.log(`  Converted to ${Object.keys(sourceEntries).length.toLocaleString()} unique entries`)

  for (const lang of langs) {
    const dictPath = `${DATA_DIR}/${lang}.json`
    if (!existsSync(dictPath)) {
      console.log(`\n[${lang}] Dictionary not found: ${dictPath} — skipping`)
      continue
    }

    console.log(`\n=== Importing into ${lang} ===`)
    await mkdir(DATA_DIR, { recursive: true })
    const dict = await loadDict(dictPath, lang)
    console.log(`  Existing entries: ${Object.keys(dict.entries).length.toLocaleString()}`)

    if (mode === 'refresh') {
      const stats = refreshDictSource(dict.entries, sourceEntries, 'jmnedict')
      console.log(`  New: ${stats.added.toLocaleString()}, Updated: ${stats.updated.toLocaleString()}, Removed: ${stats.removed.toLocaleString()}`)
    } else {
      const stats = mergeDictEntries(dict.entries, sourceEntries, mode)
      printStats(stats, mode)
    }

    if (mode !== 'diff') {
      await saveDict(dictPath, dict)
      console.log(`  Saved: ${dictPath} (${Object.keys(dict.entries).length.toLocaleString()} total entries)`)
    }
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
  --lang    Comma-separated language codes (default: all available)
            Supported: en, de, ko, zh-cn, zh-tw
  --mode    Import mode (default: replace)
            replace - Full snapshot sync: remove stale entries, overwrite all
            merge   - Add new entries, merge definitions for existing
            diff    - Preview changes, no modifications
            refresh - Strip and re-import only jmnedict data

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

  let langs: string[] = ALL_LANGS.filter((lang) => existsSync(`${DATA_DIR}/${lang}.json`))
  let mode: ImportMode = 'merge'

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
    }
  }

  if (langs.length === 0) {
    console.error('No language dictionaries found. Run base importers first.')
    process.exit(1)
  }

  await importJMnedict(langs, mode)
  console.log('\n=== Import Complete ===')
}

main().catch((err) => {
  console.error('Import failed:', err)
  process.exit(1)
})
