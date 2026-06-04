import { dirname } from 'path'
import { mkdirSync } from 'fs'
import { loadIdRegistry, saveIdRegistry } from '../../src/domain/registry-store'
import { validateCanonicalSnapshot } from '../../src/domain/validate'
import {
  importWiktionaryGlossesIntoSnapshot,
  type WiktionaryGlossInput,
} from '../../src/sources/wiktionary/convert'
import type { CanonicalSnapshot, TargetLanguage } from '../../src/domain/types'
import { SUPPORTED_LANGUAGES, normalizeLanguage } from '../../src/types'

interface CliOptions {
  file: string
  snapshot: string
  out: string
  registry: string
  importedAt: string
  lang?: TargetLanguage
  maxGlossesPerSense: number
  limit?: number
}

const DEFAULT_SNAPSHOT = 'data/snapshots/yori-dict.snapshot.json'
const DEFAULT_REGISTRY = 'data/registry/ids.json'
const DEFAULT_MAX_GLOSSES_PER_SENSE = 8

function printHelp(): void {
  console.log(`
Canonical Wiktionary gloss import

Imports Wiktionary/Kaikki gloss enrichments into existing canonical entries.
The importer does not create new entries, senses, forms, readings, or aliases.

Usage:
  bun run import:wiktionary:canonical --file <glosses.json|jsonl> [options]

Options:
  --file <path>                  Simplified JSON/JSONL gloss file, or raw Kaikki JSONL.
  --snapshot <path>              Existing canonical snapshot (default: ${DEFAULT_SNAPSHOT})
  --out <path>                   Output snapshot path (default: same as --snapshot)
  --registry <path>              Stable Yori ID registry (default: ${DEFAULT_REGISTRY})
  --lang <lang>                  Fallback language for records missing lang; required for raw Kaikki rows. Supported: ${SUPPORTED_LANGUAGES.join(', ')}
  --max-glosses-per-sense <n>    Max Wiktionary glosses per sense/language (default: ${DEFAULT_MAX_GLOSSES_PER_SENSE})
  --limit <n>                    Import only first n valid records.
  --imported-at <iso>            Import timestamp (default: now)
  --help, -h                     Show this help.
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
    maxGlossesPerSense: DEFAULT_MAX_GLOSSES_PER_SENSE,
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
    } else if (arg === '--max-glosses-per-sense' && next) {
      opts.maxGlossesPerSense = parsePositiveInt(next, '--max-glosses-per-sense')
      i++
    } else if (arg === '--limit' && next) {
      opts.limit = parsePositiveInt(next, '--limit')
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

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  if (typeof value !== 'string') return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function normalizeRecord(value: unknown, fallbackLang?: TargetLanguage): WiktionaryGlossInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const word = typeof row.word === 'string' ? row.word.trim() : ''
  const glosses = normalizeStringList(row.glosses ?? row.definitions)
  const lang = typeof row.lang === 'string' ? normalizeLanguage(row.lang) : fallbackLang
  if (!word || !lang || glosses.length === 0) return null

  return {
    id: typeof row.id === 'string' ? row.id : undefined,
    sourceId: typeof row.sourceId === 'string' ? row.sourceId : undefined,
    entryId: typeof row.entryId === 'string' ? row.entryId : undefined,
    senseId: typeof row.senseId === 'string' ? row.senseId : undefined,
    senseOrder: normalizePositiveInt(row.senseOrder ?? row.senseIndex ?? row.senseNumber),
    word,
    reading: typeof row.reading === 'string' ? row.reading : undefined,
    lang,
    pos: normalizeStringList(row.pos),
    glosses,
  }
}

function rawReading(row: Record<string, unknown>): string | undefined {
  const sounds = Array.isArray(row.sounds) ? row.sounds : []
  for (const sound of sounds) {
    if (!sound || typeof sound !== 'object') continue
    const other = (sound as Record<string, unknown>).other
    if (typeof other === 'string' && other.trim()) return other.trim()
  }
  return undefined
}

function rawPos(row: Record<string, unknown>): string[] {
  return typeof row.pos === 'string' && row.pos.trim() ? [row.pos.trim()] : []
}

function normalizeRawKaikkiRecords(value: unknown, fallbackLang?: TargetLanguage): WiktionaryGlossInput[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const senses = Array.isArray(row.senses) ? row.senses : null
  if (row.lang_code !== 'ja' || !senses) return null

  const word = typeof row.word === 'string' ? row.word.trim() : ''
  if (!word || !fallbackLang) return []

  return senses.flatMap((sense, index) => {
    if (!sense || typeof sense !== 'object' || Array.isArray(sense)) return []
    const glosses = normalizeStringList((sense as Record<string, unknown>).glosses)
    if (glosses.length === 0) return []

    return [{
      sourceId: `kaikki:${fallbackLang}:ja:${word}:${typeof row.pos === 'string' ? row.pos : ''}:sense${index + 1}`,
      word,
      reading: rawReading(row),
      lang: fallbackLang,
      pos: rawPos(row),
      senseOrder: index + 1,
      glosses,
    }]
  })
}

function normalizeRecords(value: unknown, fallbackLang?: TargetLanguage): WiktionaryGlossInput[] {
  const rawRecords = normalizeRawKaikkiRecords(value, fallbackLang)
  if (rawRecords) return rawRecords

  const record = normalizeRecord(value, fallbackLang)
  return record ? [record] : []
}

function loadJsonRecords(text: string, fallbackLang?: TargetLanguage): WiktionaryGlossInput[] {
  const payload = JSON.parse(text) as unknown
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { entries?: unknown[] }).entries)
      ? (payload as { entries: unknown[] }).entries
      : null
  if (!rows) {
    const singleRecord = normalizeRecords(payload, fallbackLang)
    if (singleRecord.length > 0) return singleRecord
    throw new Error('Wiktionary JSON input must be an array or an object with an entries array')
  }

  return rows
    .flatMap((row) => normalizeRecords(row, fallbackLang))
}

function loadJsonlRecords(text: string, fallbackLang?: TargetLanguage): WiktionaryGlossInput[] {
  const records: WiktionaryGlossInput[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(...normalizeRecords(JSON.parse(line), fallbackLang))
    } catch {
      // Skip malformed JSONL rows.
    }
  }
  return records
}

async function loadRecords(path: string, fallbackLang?: TargetLanguage, limit?: number): Promise<WiktionaryGlossInput[]> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`Wiktionary file not found: ${path}`)
  const text = await file.text()
  const trimmed = text.trimStart()
  let records: WiktionaryGlossInput[]
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      records = loadJsonRecords(text, fallbackLang)
    } catch {
      records = loadJsonlRecords(text, fallbackLang)
    }
  } else {
    records = loadJsonlRecords(text, fallbackLang)
  }
  return limit ? records.slice(0, limit) : records
}

export async function importWiktionaryCanonical(opts: CliOptions): Promise<void> {
  const registry = await loadIdRegistry(opts.registry)
  const snapshot = await loadSnapshot(opts.snapshot)
  const records = await loadRecords(opts.file, opts.lang, opts.limit)
  const result = importWiktionaryGlossesIntoSnapshot(snapshot, records, {
    registry,
    importedAt: opts.importedAt,
    maxGlossesPerSense: opts.maxGlossesPerSense,
  })

  const validation = validateCanonicalSnapshot(result.snapshot)
  if (!validation.valid) {
    throw new Error(`Snapshot validation failed with ${validation.errors.length} error(s)`)
  }

  mkdirSync(dirname(opts.out), { recursive: true })
  await Bun.write(opts.out, JSON.stringify(result.snapshot, null, 2) + '\n')
  await saveIdRegistry(opts.registry, registry)

  console.log('\n=== Canonical Wiktionary Import ===')
  console.log(`Input records: ${records.length.toLocaleString()}`)
  console.log(`Records processed: ${result.stats.recordsProcessed.toLocaleString()}`)
  console.log(`Records matched: ${result.stats.recordsMatched.toLocaleString()}`)
  console.log(`Glosses added: ${result.stats.glossesAdded.toLocaleString()}`)
  console.log(`Entries updated: ${result.stats.entriesUpdated.toLocaleString()}`)
  console.log(`Snapshot: ${opts.out}`)
  console.log(`Registry: ${opts.registry}`)
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  await importWiktionaryCanonical(opts)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
