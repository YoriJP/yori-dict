/**
 * JMdict with examples importer - enriches English entries with example
 * sentence pairs from the Yomitan build.
 */

import { mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import {
  type LangFile,
  makeKey,
  loadLang,
  saveLang,
  mergeLangEntries,
  refreshLangSource,
  downloadWithProgress,
  printStats,
} from './base'
import { extractExamplePairs, loadYomitanTermBanks, type YomitanEntry, type YomitanDef } from './yomitan'

const LANG = 'en'
const LANG_DIR = './data/lang'
const CACHE_DIR = './data/cache'
const CACHE_PATH = `${CACHE_DIR}/jmdict-english-with-examples.zip`
const SOURCE_NAME = 'jmdict-examples'
const RELEASES_API = 'https://api.github.com/repos/yomidevs/jmdict-yomitan/releases/latest'
const DEFAULT_MAX_EXAMPLES = 3

type ImportMode = 'merge' | 'diff' | 'refresh'

interface GitHubRelease {
  assets: Array<{ name: string; browser_download_url: string }>
}

function buildWordKeyIndex(
  langEntries: Record<string, { definitions: string[] }>
): Map<string, string[]> {
  const index = new Map<string, string[]>()

  for (const key of Object.keys(langEntries)) {
    const separator = key.indexOf(':')
    const word = separator === -1 ? key : key.slice(0, separator)
    const keys = index.get(word)
    if (keys) {
      keys.push(key)
    } else {
      index.set(word, [key])
    }
  }

  return index
}

export function resolveExampleImportKey(
  word: string,
  reading: string,
  langEntries: Record<string, { definitions: string[] }>
): string | null {
  return resolveExampleImportKeyWithIndex(word, reading, langEntries, buildWordKeyIndex(langEntries))
}

function resolveExampleImportKeyWithIndex(
  word: string,
  reading: string,
  langEntries: Record<string, { definitions: string[] }>,
  wordKeyIndex: Map<string, string[]>
): string | null {
  const exact = makeKey(word, reading)
  if (langEntries[exact]) return exact

  const candidates = wordKeyIndex.get(word) ?? []
  if (candidates.length === 1) return candidates[0]
  return null
}

async function getDownloadUrl(): Promise<string> {
  const response = await fetch(RELEASES_API, { headers: { 'User-Agent': 'yori-dict-importer' } })
  if (!response.ok) throw new Error(`Failed to fetch JMdict examples release metadata: ${response.status}`)

  const release = await response.json() as GitHubRelease
  const asset = release.assets.find((item) =>
    /english.*examples/i.test(item.name) && item.name.endsWith('.zip')
  )

  if (!asset) throw new Error('No English-with-examples asset found in latest jmdict-yomitan release')
  return asset.browser_download_url
}

async function ensureArchive(fileOverride?: string): Promise<string> {
  if (fileOverride) {
    if (!existsSync(fileOverride)) throw new Error(`Override ZIP not found: ${fileOverride}`)
    return fileOverride
  }

  await mkdir(CACHE_DIR, { recursive: true })
  const url = await getDownloadUrl()
  await downloadWithProgress(url, CACHE_PATH)
  return CACHE_PATH
}

export function buildExampleOnlySourceEntry(
  defs: YomitanDef[],
  word: string,
  reading: string,
  maxExamples: number
): { definitions: []; examples?: Array<{ ja: string; text: string; source: string }> } | null {
  const examples = extractExamplePairs(defs, word, reading)
    .slice(0, maxExamples)
    .map((example) => ({ ...example, source: SOURCE_NAME }))

  if (examples.length === 0) return null
  return { definitions: [], examples }
}

async function buildSourceEntries(
  langFile: LangFile,
  zipPath: string,
  maxExamples: number
): Promise<Record<string, { definitions: string[]; examples?: Array<{ ja: string; text: string; source: string }> }>> {
  const entries = await loadYomitanTermBanks(zipPath)
  const sourceEntries: Record<string, { definitions: string[]; examples?: Array<{ ja: string; text: string; source: string }> }> = {}
  const wordKeyIndex = buildWordKeyIndex(langFile.entries)

  for (const [index, entry] of entries.entries()) {
    const [word, reading, , , , defs] = entry as YomitanEntry
    const targetKey = resolveExampleImportKeyWithIndex(word, reading || word, langFile.entries, wordKeyIndex)
    if (targetKey) {
      const srcEntry = buildExampleOnlySourceEntry(defs, word, reading || word, maxExamples)
      if (srcEntry) {
        const target = sourceEntries[targetKey] ?? { definitions: [], examples: [] }
        const existingExamples = target.examples ?? []
        for (const example of srcEntry.examples ?? []) {
          if (!existingExamples.some((item) => item.ja === example.ja && item.text === example.text)) {
            existingExamples.push(example)
          }
        }

        target.examples = existingExamples
        sourceEntries[targetKey] = target
      }
    }

    if ((index + 1) % 10000 === 0) {
      console.log(`  Processed ${index + 1} / ${entries.length} JMdict example entries...`)
    }
  }

  return sourceEntries
}

async function importExamples(
  mode: ImportMode,
  maxExamples: number,
  fileOverride?: string
): Promise<void> {
  console.log(`\n=== Importing ${LANG} examples from JMdict Yomitan ===`)
  console.log(`Mode: ${mode}`)

  const zipPath = await ensureArchive(fileOverride)
  const langPath = `${LANG_DIR}/${LANG}.json`
  const langFile = await loadLang(langPath, LANG)
  const sourceEntries = await buildSourceEntries(langFile, zipPath, maxExamples)

  console.log(`  Source entries: ${Object.keys(sourceEntries).length.toLocaleString()}`)

  if (mode === 'refresh') {
    refreshLangSource(langFile.entries, SOURCE_NAME)
  }

  const effectiveMode = mode === 'refresh' ? 'merge' : mode
  const stats = mergeLangEntries(langFile.entries, sourceEntries, SOURCE_NAME, effectiveMode)
  printStats(stats as { added: number; updated: number; unchanged: number }, effectiveMode)

  if (mode !== 'diff') {
    await saveLang(langPath, langFile)
    console.log(`Saved to: ${langPath}`)
  }
}

function printHelp(): void {
  console.log(`
JMdict English-with-examples importer

Usage:
  bun run import:jmdict-examples [options]

Options:
  --mode <mode>     merge | diff | refresh (default: merge)
  --examples <n>    Max examples per entry (default: ${DEFAULT_MAX_EXAMPLES})
  --zip <path>      Use a local Yomitan ZIP instead of downloading
`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    printHelp()
    return
  }

  let mode: ImportMode = 'merge'
  let maxExamples = DEFAULT_MAX_EXAMPLES
  let zipPath: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--mode' && next) {
      if (!['merge', 'diff', 'refresh'].includes(next)) throw new Error(`Invalid mode: ${next}`)
      mode = next as ImportMode
      i++
    } else if (arg === '--examples' && next) {
      maxExamples = Number.parseInt(next, 10)
      i++
    } else if (arg === '--zip' && next) {
      zipPath = next
      i++
    }
  }

  await importExamples(mode, maxExamples, zipPath)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
