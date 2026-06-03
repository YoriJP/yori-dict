import { dirname } from 'path'
import { mkdirSync } from 'fs'
import { loadIdRegistry, saveIdRegistry } from '../../src/domain/registry-store'
import { validateCanonicalSnapshot } from '../../src/domain/validate'
import {
  convertKanjidic2Characters,
  type Kanjidic2Character,
} from '../../src/sources/kanjidic2/convert'
import { parseKanjidic2Xml } from '../../src/sources/kanjidic2/xml'
import type { CanonicalSnapshot } from '../../src/domain/types'

interface CliOptions {
  file: string
  snapshot: string
  out: string
  registry: string
  importedAt: string
  limit?: number
}

const DEFAULT_SNAPSHOT = 'data/snapshots/yori-dict.snapshot.json'
const DEFAULT_REGISTRY = 'data/registry/ids.json'

function printHelp(): void {
  console.log(`
Canonical KANJIDIC2 import

Imports KANJIDIC2 XML, or simplified KANJIDIC2 JSON, into the kanjiCharacters
section of a Yori canonical snapshot.

Usage:
  bun run import:kanjidic2:canonical --file <kanjidic2.xml|json> [options]

Options:
  --file <path>         KANJIDIC2 XML file or simplified JSON file.
  --snapshot <path>     Existing canonical snapshot to extend (default: ${DEFAULT_SNAPSHOT})
  --out <path>          Output snapshot path (default: same as --snapshot)
  --registry <path>     Stable Yori ID registry (default: ${DEFAULT_REGISTRY})
  --imported-at <iso>   Import timestamp (default: now)
  --limit <n>           Import only the first n characters.
  --help, -h            Show this help.
`)
}

export function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = {
    file: '',
    snapshot: DEFAULT_SNAPSHOT,
    out: DEFAULT_SNAPSHOT,
    registry: DEFAULT_REGISTRY,
    importedAt: new Date().toISOString(),
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
    } else if (arg === '--imported-at' && next) {
      opts.importedAt = next
      i++
    } else if (arg === '--limit' && next) {
      opts.limit = Number.parseInt(next, 10)
      i++
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`)
    }
  }

  if (!opts.file) throw new Error('--file is required')
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    throw new Error('--limit must be a positive integer')
  }

  return opts
}

async function loadSnapshot(path: string, generatedAt: string): Promise<CanonicalSnapshot> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    return {
      schemaVersion: '1.0.0',
      generatedAt,
      entries: [],
      lookupAliases: [],
      kanjiCharacters: [],
    }
  }
  return file.json() as Promise<CanonicalSnapshot>
}

async function loadCharacters(path: string): Promise<Kanjidic2Character[]> {
  const text = await Bun.file(path).text()
  const trimmed = text.trimStart()
  if (trimmed.startsWith('<')) return parseKanjidic2Xml(text)

  const payload = JSON.parse(text) as Kanjidic2Character[] | { characters?: Kanjidic2Character[] }
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload.characters)) return payload.characters
  throw new Error('KANJIDIC2 JSON input must be an array or an object with a characters array')
}

export async function importKanjidic2Canonical(opts: CliOptions): Promise<void> {
  const registry = await loadIdRegistry(opts.registry)
  const snapshot = await loadSnapshot(opts.snapshot, opts.importedAt)
  const input = await loadCharacters(opts.file)
  const selected = opts.limit ? input.slice(0, opts.limit) : input
  const imported = convertKanjidic2Characters(selected, {
    registry,
    importedAt: opts.importedAt,
  })

  const byLiteral = new Map<string, (typeof imported)[number]>()
  for (const existing of snapshot.kanjiCharacters ?? []) byLiteral.set(existing.literal, existing)
  for (const kanji of imported) byLiteral.set(kanji.literal, kanji)

  const output: CanonicalSnapshot = {
    ...snapshot,
    generatedAt: opts.importedAt,
    kanjiCharacters: [...byLiteral.values()].sort((left, right) => left.literal.localeCompare(right.literal, 'ja')),
  }

  const validation = validateCanonicalSnapshot(output)
  if (!validation.valid) {
    throw new Error(`Snapshot validation failed with ${validation.errors.length} error(s)`)
  }

  mkdirSync(dirname(opts.out), { recursive: true })
  await Bun.write(opts.out, JSON.stringify(output, null, 2) + '\n')
  await saveIdRegistry(opts.registry, registry)

  console.log('\n=== Canonical KANJIDIC2 Import ===')
  console.log(`Input characters: ${selected.length.toLocaleString()}`)
  console.log(`Imported kanji: ${imported.length.toLocaleString()}`)
  console.log(`Snapshot kanji: ${output.kanjiCharacters?.length.toLocaleString() ?? '0'}`)
  console.log(`Snapshot: ${opts.out}`)
  console.log(`Registry: ${opts.registry}`)
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  await importKanjidic2Canonical(opts)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
