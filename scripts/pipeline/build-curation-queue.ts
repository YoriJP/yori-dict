import { existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { buildCurationQueue, type CurationQueue } from '../../src/domain/curation-queue'
import type { CanonicalSnapshot, TargetLanguage } from '../../src/domain/types'
import { normalizeLanguage, SUPPORTED_LANGUAGES } from '../../src/types'

interface CliOptions {
  snapshot: string
  lang: TargetLanguage
  out: string
  limit?: number
  commonOnly: boolean
}

const DEFAULT_SNAPSHOT = 'data/snapshots/yori-dict.snapshot.json'
const DEFAULT_OUT_DIR = 'data/curation'

function printHelp(): void {
  console.log(`
Canonical curation queue

Builds a structured queue of dictionary senses that need target-language curation.

Usage:
  bun run queue:curation --lang <lang> [options]

Options:
  --lang <lang>       Target language. Supported: ${SUPPORTED_LANGUAGES.join(', ')}
  --snapshot <path>   Canonical snapshot JSON (default: ${DEFAULT_SNAPSHOT})
  --out <path>        Output queue JSON (default: ${DEFAULT_OUT_DIR}/queue.<lang>.json)
  --limit <n>         Max queue items.
  --common-only       Queue only common entries.
  --help, -h          Show this help.
`)
}

function parseLang(value: string): TargetLanguage {
  const lang = normalizeLanguage(value)
  if (!lang) throw new Error(`--lang must be one of: ${SUPPORTED_LANGUAGES.join(', ')}`)
  return lang
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
  return parsed
}

export function parseArgs(args: string[]): CliOptions {
  let lang: TargetLanguage | undefined
  const opts = {
    snapshot: DEFAULT_SNAPSHOT,
    out: '',
    limit: undefined as number | undefined,
    commonOnly: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg === '--lang' && next) {
      lang = parseLang(next)
      i++
    } else if (arg === '--snapshot' && next) {
      opts.snapshot = next
      i++
    } else if (arg === '--out' && next) {
      opts.out = next
      i++
    } else if (arg === '--limit' && next) {
      opts.limit = parsePositiveInt(next, '--limit')
      i++
    } else if (arg === '--common-only') {
      opts.commonOnly = true
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`)
    }
  }

  if (!lang) throw new Error('--lang is required')
  return {
    ...opts,
    lang,
    out: opts.out || `${DEFAULT_OUT_DIR}/queue.${lang}.json`,
  }
}

async function writeQueue(path: string, queue: CurationQueue): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  await Bun.write(path, JSON.stringify(queue, null, 2) + '\n')
}

export async function runBuildCurationQueue(opts: CliOptions): Promise<CurationQueue> {
  if (!existsSync(opts.snapshot)) throw new Error(`Snapshot not found: ${opts.snapshot}`)
  const snapshot = await Bun.file(opts.snapshot).json() as CanonicalSnapshot
  const queue = buildCurationQueue(snapshot, {
    targetLang: opts.lang,
    limit: opts.limit,
    commonOnly: opts.commonOnly,
  })

  await writeQueue(opts.out, queue)

  console.log('\n=== Canonical Curation Queue ===')
  console.log(`Snapshot: ${opts.snapshot}`)
  console.log(`Target language: ${opts.lang}`)
  console.log(`Items: ${queue.items.length.toLocaleString()}`)
  console.log(`Queue: ${opts.out}`)
  for (const item of queue.items.slice(0, 10)) {
    console.log(`  - ${item.id}\t${item.primaryForm}\t${item.primaryReading}\tpriority=${item.priority}`)
  }

  return queue
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  await runBuildCurationQueue(opts)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
