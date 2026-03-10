/**
 * Korean fallback importer based on kowiktionary via Kaikki.
 *
 * This importer is intentionally conservative:
 * - it only fills entries missing Korean definitions
 * - or entries whose Korean coverage is extremely thin
 * - it never refreshes or overwrites KRDICT definitions
 */

import { mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import {
  type DuplicateConflictPolicyInput,
  loadLang,
  saveLang,
  mergeLangEntries,
  analyzeLangDefinitionConflicts,
  resolveDuplicateConflictPolicy,
  downloadWithProgress,
  type LangEntry,
  printStats,
} from './base'
import {
  parseEntry,
  buildCoreIndex,
  resolveCanonicalKey,
  type WiktEntry,
} from './kaikki'

const LANG = 'ko'
const SOURCE_NAME = 'kowiktionary'
const LANG_DIR = './data/lang'
const CACHE_DIR = './data/cache'
const CACHE_GZ_PATH = `${CACHE_DIR}/kowiktionary-raw.jsonl.gz`
const CACHE_JSONL_PATH = `${CACHE_DIR}/kowiktionary-raw.jsonl`
const SOURCE_URL = 'https://kaikki.org/kowiktionary/raw-wiktextract-data.jsonl.gz'
const DEFAULT_MAX_DEFINITIONS = 5

type ImportMode = 'merge' | 'diff'

async function gunzipIfNeeded(gzipPath: string, jsonlPath: string): Promise<void> {
  if (existsSync(jsonlPath)) return

  const proc = Bun.spawn(['gunzip', '-c', gzipPath], { stdout: 'pipe', stderr: 'pipe' })
  const output = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  if (exitCode !== 0) throw new Error(`Failed to decompress ${gzipPath}`)
  await Bun.write(jsonlPath, output)
}

async function* streamJsonLines(filePath: string): AsyncGenerator<WiktEntry> {
  const file = Bun.file(filePath)
  const text = await file.text()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      yield JSON.parse(line) as WiktEntry
    } catch {
      // Skip malformed lines.
    }
  }
}

export function shouldUseKoFallback(entry: LangEntry | undefined): boolean {
  if (!entry || entry.definitions.length === 0) return true

  const sources = new Set<string>()
  for (const sourceList of Object.values(entry._defSources ?? {})) {
    for (const source of sourceList) sources.add(source)
  }

  if (sources.has('krdict')) return false
  return entry.definitions.length <= 1
}

async function resolveSourcePath(fileOverride?: string): Promise<string> {
  if (fileOverride) {
    if (!existsSync(fileOverride)) throw new Error(`Override file not found: ${fileOverride}`)
    return fileOverride
  }

  await mkdir(CACHE_DIR, { recursive: true })
  await downloadWithProgress(SOURCE_URL, CACHE_GZ_PATH)
  await gunzipIfNeeded(CACHE_GZ_PATH, CACHE_JSONL_PATH)
  return CACHE_JSONL_PATH
}

async function buildSourceEntries(
  filePath: string,
  langEntries: Record<string, LangEntry>,
  maxDefinitions: number
): Promise<Record<string, { definitions: string[] }>> {
  const sourceEntries: Record<string, { definitions: string[] }> = {}
  const coreIndex = await buildCoreIndex()

  for await (const raw of streamJsonLines(filePath)) {
    const parsed = parseEntry(raw)
    if (!parsed) continue

    const canonicalKey = resolveCanonicalKey(parsed.word, parsed.reading, coreIndex)
    if (!canonicalKey) continue
    if (!shouldUseKoFallback(langEntries[canonicalKey])) continue

    const definitions = parsed.definitions.slice(0, maxDefinitions)
    if (definitions.length === 0) continue

    const existing = sourceEntries[canonicalKey]
    if (!existing) {
      sourceEntries[canonicalKey] = { definitions: [...definitions] }
      continue
    }

    for (const definition of definitions) {
      const normalized = definition.toLowerCase().trim()
      if (!existing.definitions.some((item) => item.toLowerCase().trim() === normalized)) {
        if (existing.definitions.length < maxDefinitions) existing.definitions.push(definition)
      }
    }
  }

  return sourceEntries
}

async function importFallback(
  mode: ImportMode,
  duplicatePolicyInput: DuplicateConflictPolicyInput,
  duplicateSamples: number,
  maxDefinitions: number,
  fileOverride?: string
): Promise<void> {
  console.log(`\n=== Importing ${LANG} fallback from kowiktionary ===`)
  console.log(`Mode: ${mode}`)

  const sourcePath = await resolveSourcePath(fileOverride)
  const langPath = `${LANG_DIR}/${LANG}.json`
  const langFile = await loadLang(langPath, LANG)
  const sourceEntries = await buildSourceEntries(sourcePath, langFile.entries, maxDefinitions)

  console.log(`  Source entries: ${Object.keys(sourceEntries).length.toLocaleString()}`)

  const conflictPolicy = await resolveDuplicateConflictPolicy(
    SOURCE_NAME,
    duplicatePolicyInput,
    analyzeLangDefinitionConflicts(langFile.entries, sourceEntries, duplicateSamples)
  )
  const stats = mergeLangEntries(langFile.entries, sourceEntries, SOURCE_NAME, mode, conflictPolicy)
  printStats(stats as { added: number; updated: number; unchanged: number }, mode)

  if (mode !== 'diff') {
    await saveLang(langPath, langFile)
    console.log(`Saved to: ${langPath}`)
  }
}

function printHelp(): void {
  console.log(`
Korean fallback importer (kowiktionary)

Usage:
  bun run import:kowiktionary-ko [options]

Options:
  --mode <mode>     merge | diff (default: merge)
  --limit <n>       Max definitions per entry (default: ${DEFAULT_MAX_DEFINITIONS})
  --dup-policy      merge | skip | replace | ask (default: merge)
  --dup-samples     How many conflict samples to show in ask mode (default: 5)
  --file <path>     Use a local raw JSONL file instead of downloading
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
  let fileOverride: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--mode' && next) {
      if (!['merge', 'diff'].includes(next)) throw new Error(`Invalid mode: ${next}`)
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
    } else if (arg === '--file' && next) {
      fileOverride = next
      i++
    }
  }

  await importFallback(mode, duplicatePolicy, duplicateSamples, maxDefinitions, fileOverride)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
