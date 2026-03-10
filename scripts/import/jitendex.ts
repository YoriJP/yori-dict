/**
 * Jitendex Importer - Enriches lang/en.json with better-formatted English definitions.
 *
 * Data source:
 *   https://jitendex.org
 *   GitHub releases: stephenmk/stephenmk.github.io
 *
 * Writes: data/lang/en.json
 *
 * Usage:
 *   bun run import:jitendex
 *   bun run import:jitendex --mode diff
 *   bun run import:jitendex --mode refresh
 */

import { mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import {
  type DuplicateConflictPolicyInput,
  type LangFile,
  makeKey,
  loadLang,
  saveLang,
  mergeLangEntries,
  refreshLangSource,
  analyzeLangDefinitionConflicts,
  resolveDuplicateConflictPolicy,
  downloadWithProgress,
  printStats,
} from './base'
import { extractDefinitionTexts, loadYomitanTermBanks, type YomitanEntry } from './yomitan'

const LANG = 'en'
const LANG_DIR = './data/lang'
const CACHE_DIR = './data/cache'
const CACHE_PATH = `${CACHE_DIR}/jitendex-yomitan.zip`
const SOURCE_NAME = 'jitendex'
const RELEASES_API = 'https://api.github.com/repos/stephenmk/stephenmk.github.io/releases/latest'
const DEFAULT_MAX_DEFINITIONS = 8

type ImportMode = 'merge' | 'diff' | 'refresh'

interface GitHubRelease {
  assets: Array<{ name: string; browser_download_url: string }>
}

export function resolveJitendexKey(
  word: string,
  reading: string,
  langEntries: Record<string, { definitions: string[] }>
): string | null {
  const exact = makeKey(word, reading)
  if (langEntries[exact]) return exact

  const candidates = Object.keys(langEntries).filter((key) => key.startsWith(`${word}:`))
  if (candidates.length === 1) return candidates[0]

  return null
}

async function getDownloadUrl(): Promise<string> {
  const response = await fetch(RELEASES_API, { headers: { 'User-Agent': 'yori-dict-importer' } })
  if (!response.ok) throw new Error(`Failed to fetch Jitendex release metadata: ${response.status}`)

  const release = await response.json() as GitHubRelease
  const asset = release.assets.find((item) =>
    /jitendex.*yomitan/i.test(item.name) && item.name.endsWith('.zip')
  )

  if (!asset) throw new Error('No Jitendex Yomitan asset found in latest release')
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

async function buildSourceEntries(
  langFile: LangFile,
  zipPath: string,
  maxDefinitions: number
): Promise<Record<string, { definitions: string[] }>> {
  const entries = await loadYomitanTermBanks(zipPath)
  const sourceEntries: Record<string, { definitions: string[] }> = {}

  for (const entry of entries) {
    const [word, reading, , , , defs] = entry as YomitanEntry
    const targetKey = resolveJitendexKey(word, reading || word, langFile.entries)
    if (!targetKey) continue

    const definitions = extractDefinitionTexts(defs, maxDefinitions)
    if (definitions.length === 0) continue

    const existing = sourceEntries[targetKey]
    if (!existing) {
      sourceEntries[targetKey] = { definitions }
      continue
    }

    for (const def of definitions) {
      const normalized = def.toLowerCase().trim()
      if (!existing.definitions.some((item) => item.toLowerCase().trim() === normalized)) {
        if (existing.definitions.length < maxDefinitions) existing.definitions.push(def)
      }
    }
  }

  return sourceEntries
}

async function importJitendex(
  mode: ImportMode,
  duplicatePolicyInput: DuplicateConflictPolicyInput,
  duplicateSamples: number,
  maxDefinitions: number,
  fileOverride?: string
): Promise<void> {
  console.log(`\n=== Importing ${LANG} from Jitendex ===`)
  console.log(`Mode: ${mode}`)

  const zipPath = await ensureArchive(fileOverride)
  const langPath = `${LANG_DIR}/${LANG}.json`
  const langFile = await loadLang(langPath, LANG)
  const sourceEntries = await buildSourceEntries(langFile, zipPath, maxDefinitions)

  console.log(`  Source entries: ${Object.keys(sourceEntries).length.toLocaleString()}`)

  if (mode === 'refresh') {
    refreshLangSource(langFile.entries, SOURCE_NAME)
  }

  const conflictPolicy = await resolveDuplicateConflictPolicy(
    SOURCE_NAME,
    duplicatePolicyInput,
    analyzeLangDefinitionConflicts(langFile.entries, sourceEntries, duplicateSamples)
  )

  const effectiveMode = mode === 'refresh' ? 'merge' : mode
  const stats = mergeLangEntries(langFile.entries, sourceEntries, SOURCE_NAME, effectiveMode, conflictPolicy)
  printStats(stats as { added: number; updated: number; unchanged: number }, effectiveMode)

  if (mode !== 'diff') {
    await saveLang(langPath, langFile)
    console.log(`Saved to: ${langPath}`)
  }
}

function printHelp(): void {
  console.log(`
Jitendex Importer

Usage:
  bun run import:jitendex [options]

Options:
  --mode <mode>     merge | diff | refresh (default: merge)
  --limit <n>       Max definitions per entry (default: ${DEFAULT_MAX_DEFINITIONS})
  --dup-policy      merge | skip | replace | ask (default: merge)
  --dup-samples     How many conflict samples to show in ask mode (default: 5)
  --zip <path>      Use a local Jitendex Yomitan ZIP instead of downloading
`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    printHelp()
    return
  }

  let mode: ImportMode = 'merge'
  let duplicatePolicy: DuplicateConflictPolicyInput = 'merge'
  let duplicateSamples = 5
  let maxDefinitions = DEFAULT_MAX_DEFINITIONS
  let zipPath: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--mode' && next) {
      if (!['merge', 'diff', 'refresh'].includes(next)) throw new Error(`Invalid mode: ${next}`)
      mode = next as ImportMode
      i++
    } else if (arg === '--dup-policy' && next) {
      duplicatePolicy = next as DuplicateConflictPolicyInput
      i++
    } else if (arg === '--dup-samples' && next) {
      duplicateSamples = Number.parseInt(next, 10)
      i++
    } else if (arg === '--limit' && next) {
      maxDefinitions = Number.parseInt(next, 10)
      i++
    } else if (arg === '--zip' && next) {
      zipPath = next
      i++
    }
  }

  await importJitendex(mode, duplicatePolicy, duplicateSamples, maxDefinitions, zipPath)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
