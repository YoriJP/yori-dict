import { dirname } from 'path'
import { mkdirSync } from 'fs'
import { loadIdRegistry, saveIdRegistry } from '../../src/domain/registry-store'
import { validateCanonicalSnapshot } from '../../src/domain/validate'
import {
  importTatoebaExamplesIntoSnapshot,
  type TatoebaExamplePair,
} from '../../src/sources/tatoeba/convert'
import type { CanonicalSnapshot, TargetLanguage } from '../../src/domain/types'
import { SUPPORTED_LANGUAGES, normalizeLanguage } from '../../src/types'

interface CliOptions {
  file: string
  snapshot: string
  out: string
  registry: string
  importedAt: string
  lang?: TargetLanguage
  maxExamplesPerSense: number
}

const DEFAULT_SNAPSHOT = 'data/snapshots/yori-dict.snapshot.json'
const DEFAULT_REGISTRY = 'data/registry/ids.json'
const DEFAULT_MAX_EXAMPLES_PER_SENSE = 3

function printHelp(): void {
  console.log(`
Canonical Tatoeba example import

Imports Tatoeba sentence pairs into examples on an existing Yori canonical
snapshot. The importer only enriches existing entries; it does not create new
dictionary entries.

Usage:
  bun run import:tatoeba:canonical --file <examples.json|tsv> [options]

Options:
  --file <path>                    Tatoeba JSON or TSV file.
  --snapshot <path>                Existing canonical snapshot (default: ${DEFAULT_SNAPSHOT})
  --out <path>                     Output snapshot path (default: same as --snapshot)
  --registry <path>                Stable Yori ID registry (default: ${DEFAULT_REGISTRY})
  --lang <lang>                    Required for TSV input. Supported: ${SUPPORTED_LANGUAGES.join(', ')}
  --max-examples-per-sense <n>     Max Tatoeba examples per sense/language (default: ${DEFAULT_MAX_EXAMPLES_PER_SENSE})
  --imported-at <iso>              Import timestamp (default: now)
  --help, -h                       Show this help.
`)
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

export function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = {
    file: '',
    snapshot: DEFAULT_SNAPSHOT,
    out: DEFAULT_SNAPSHOT,
    registry: DEFAULT_REGISTRY,
    importedAt: new Date().toISOString(),
    maxExamplesPerSense: DEFAULT_MAX_EXAMPLES_PER_SENSE,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg === '--file' && next) {
      opts.file = next
      i++
    } else if (arg === '--snapshot' && next) {
      opts.snapshot = next
      opts.out = opts.out === DEFAULT_SNAPSHOT ? next : opts.out
      i++
    } else if (arg === '--out' && next) {
      opts.out = next
      i++
    } else if (arg === '--registry' && next) {
      opts.registry = next
      i++
    } else if (arg === '--lang' && next) {
      const lang = normalizeLanguage(next)
      if (!lang) throw new Error(`--lang must be one of: ${SUPPORTED_LANGUAGES.join(', ')}`)
      opts.lang = lang
      i++
    } else if (arg === '--max-examples-per-sense' && next) {
      opts.maxExamplesPerSense = parsePositiveInt(next, '--max-examples-per-sense')
      i++
    } else if (arg === '--imported-at' && next) {
      opts.importedAt = next
      i++
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`)
    }
  }

  if (!opts.file) throw new Error('--file is required')
  return opts
}

async function loadSnapshot(path: string): Promise<CanonicalSnapshot> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`Canonical snapshot not found: ${path}`)
  return file.json() as Promise<CanonicalSnapshot>
}

function normalizePair(value: unknown, fallbackLang?: TargetLanguage): TatoebaExamplePair | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const langValue = typeof row.lang === 'string' ? normalizeLanguage(row.lang) : fallbackLang
  const japanese = typeof row.japanese === 'string' ? row.japanese.trim() : ''
  const translation = typeof row.translation === 'string' ? row.translation.trim() : ''
  if (!langValue || !japanese || !translation) return null

  return {
    id: typeof row.id === 'string' ? row.id : undefined,
    japaneseId: typeof row.japaneseId === 'string' ? row.japaneseId : undefined,
    translationId: typeof row.translationId === 'string' ? row.translationId : undefined,
    entryId: typeof row.entryId === 'string' ? row.entryId : undefined,
    senseId: typeof row.senseId === 'string' ? row.senseId : undefined,
    japanese,
    translation,
    lang: langValue,
  }
}

function loadJsonPairs(text: string, fallbackLang?: TargetLanguage): TatoebaExamplePair[] {
  const payload = JSON.parse(text) as unknown
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { examples?: unknown[] }).examples)
      ? (payload as { examples: unknown[] }).examples
      : null
  if (!rows) throw new Error('Tatoeba JSON input must be an array or an object with an examples array')

  return rows
    .map((row) => normalizePair(row, fallbackLang))
    .filter((pair): pair is TatoebaExamplePair => Boolean(pair))
}

function loadTsvPairs(text: string, lang?: TargetLanguage): TatoebaExamplePair[] {
  if (!lang) throw new Error('--lang is required for TSV input')
  const pairs: TatoebaExamplePair[] = []

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const [japaneseIdOrText, translationIdOrText, japaneseOrSource, translationOrEmpty] = line.split('\t')

    if (translationOrEmpty !== undefined) {
      pairs.push({
        japaneseId: japaneseIdOrText.trim(),
        translationId: translationIdOrText.trim(),
        japanese: japaneseOrSource.trim(),
        translation: translationOrEmpty.trim(),
        lang,
      })
    } else {
      pairs.push({
        japanese: japaneseIdOrText.trim(),
        translation: translationIdOrText.trim(),
        lang,
      })
    }
  }

  return pairs.filter((pair) => pair.japanese && pair.translation)
}

async function loadPairs(path: string, lang?: TargetLanguage): Promise<TatoebaExamplePair[]> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`Tatoeba file not found: ${path}`)
  const text = await file.text()
  const trimmed = text.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return loadJsonPairs(text, lang)
  return loadTsvPairs(text, lang)
}

export async function importTatoebaCanonical(opts: CliOptions): Promise<void> {
  const registry = await loadIdRegistry(opts.registry)
  const snapshot = await loadSnapshot(opts.snapshot)
  const pairs = await loadPairs(opts.file, opts.lang)
  const result = importTatoebaExamplesIntoSnapshot(snapshot, pairs, {
    registry,
    importedAt: opts.importedAt,
    maxExamplesPerSense: opts.maxExamplesPerSense,
  })

  const validation = validateCanonicalSnapshot(result.snapshot)
  if (!validation.valid) {
    throw new Error(`Snapshot validation failed with ${validation.errors.length} error(s)`)
  }

  mkdirSync(dirname(opts.out), { recursive: true })
  await Bun.write(opts.out, JSON.stringify(result.snapshot, null, 2) + '\n')
  await saveIdRegistry(opts.registry, registry)

  console.log('\n=== Canonical Tatoeba Import ===')
  console.log(`Input pairs: ${pairs.length.toLocaleString()}`)
  console.log(`Pairs processed: ${result.stats.pairsProcessed.toLocaleString()}`)
  console.log(`Pairs matched: ${result.stats.pairsMatched.toLocaleString()}`)
  console.log(`Examples added: ${result.stats.examplesAdded.toLocaleString()}`)
  console.log(`Entries updated: ${result.stats.entriesUpdated.toLocaleString()}`)
  console.log(`Snapshot: ${opts.out}`)
  console.log(`Registry: ${opts.registry}`)
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  await importTatoebaCanonical(opts)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
