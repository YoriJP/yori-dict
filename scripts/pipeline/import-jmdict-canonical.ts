import { mkdir } from 'fs/promises'
import { dirname } from 'path'
import { loadIdRegistry, saveIdRegistry } from '../../src/domain/registry-store'
import { validateCanonicalSnapshot } from '../../src/domain/validate'
import {
  convertJmdictToSnapshot,
  type JmdictFile,
} from '../../src/sources/jmdict/convert'
import { parseJmdictXml } from '../../src/sources/jmdict/xml'

interface CliOptions {
  file: string | null
  out: string
  registry: string
  limit: number | null
  importedAt: string
}

const DEFAULT_OUT = 'data/snapshots/yori-dict.snapshot.json'
const DEFAULT_REGISTRY = 'data/registry/ids.json'

function printHelp(): void {
  console.log(`
Canonical JMdict importer

Reads JMdict XML, or JMdict-simplified JSON, and writes a Yori canonical snapshot.

Usage:
  bun run import:jmdict:canonical --file <jmdict.xml|json> [options]

Options:
  --file <path>       Required. JMdict XML or simplified JSON file.
  --out <path>        Snapshot output path (default: ${DEFAULT_OUT})
  --registry <path>   ID registry path (default: ${DEFAULT_REGISTRY})
  --limit <n>         Import only the first N words, useful for tests/smoke runs.
  --imported-at <iso> Override import timestamp.
  --help, -h          Show this help.
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
    file: null,
    out: DEFAULT_OUT,
    registry: DEFAULT_REGISTRY,
    limit: null,
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
    } else if (arg === '--out' && next) {
      opts.out = next
      i++
    } else if (arg === '--registry' && next) {
      opts.registry = next
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

  if (!opts.file) {
    throw new Error('--file is required')
  }

  return opts
}

async function loadJmdictFile(path: string, limit: number | null): Promise<JmdictFile> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new Error(`JMdict file not found: ${path}`)
  }

  const text = await file.text()
  const data = text.trimStart().startsWith('<')
    ? parseJmdictXml(text)
    : JSON.parse(text) as JmdictFile
  if (!Array.isArray(data.words)) {
    throw new Error('JMdict JSON file must contain a words array')
  }

  if (limit === null) return data
  return {
    ...data,
    words: data.words.slice(0, limit),
  }
}

async function writeSnapshot(path: string, snapshot: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, JSON.stringify(snapshot, null, 2) + '\n')
}

export async function runImport(opts: CliOptions): Promise<void> {
  const registry = await loadIdRegistry(opts.registry)
  const jmdict = await loadJmdictFile(opts.file!, opts.limit)
  const snapshot = convertJmdictToSnapshot(jmdict, {
    importedAt: opts.importedAt,
    registry,
  })

  const validation = validateCanonicalSnapshot(snapshot)
  if (!validation.valid) {
    console.error('\nCanonical snapshot validation failed:')
    for (const error of validation.errors.slice(0, 50)) {
      console.error(`  - ${error.path}: ${error.message}`)
    }
    if (validation.errors.length > 50) {
      console.error(`  ... ${validation.errors.length - 50} more`)
    }
    throw new Error(`Snapshot validation failed with ${validation.errors.length} error(s)`)
  }

  await writeSnapshot(opts.out, snapshot)
  await saveIdRegistry(opts.registry, registry)

  console.log('\n=== Canonical JMdict Import ===')
  console.log(`Input words: ${jmdict.words.length.toLocaleString()}`)
  console.log(`Entries: ${snapshot.entries.length.toLocaleString()}`)
  console.log(`Lookup aliases: ${snapshot.lookupAliases.length.toLocaleString()}`)
  console.log(`Warnings: ${validation.warnings.length.toLocaleString()}`)
  console.log(`Snapshot: ${opts.out}`)
  console.log(`Registry: ${opts.registry}`)
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  await runImport(opts)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
