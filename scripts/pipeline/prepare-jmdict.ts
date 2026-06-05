import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'
import { gunzipSync } from 'zlib'

interface CliOptions {
  file?: string
  url: string
  out: string
  overwrite: boolean
}

const DEFAULT_URL = 'http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz'
const DEFAULT_OUT = 'data/sources/jmdict/JMdict_e.xml'

function printHelp(): void {
  console.log(`
Prepare JMdict source XML

Downloads or copies JMdict XML into a stable local source path for the
canonical import pipeline. .gz input is decompressed automatically.

Usage:
  bun run prepare:jmdict [options]

Options:
  --file <path>     Local JMdict XML or XML .gz to copy.
  --url <url>       Remote XML or .gz URL (default: ${DEFAULT_URL})
  --out <path>      Output XML path (default: ${DEFAULT_OUT})
  --overwrite       Replace an existing output file.
  --help, -h        Show this help.
`)
}

export function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = {
    url: DEFAULT_URL,
    out: DEFAULT_OUT,
    overwrite: false,
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
    } else if (arg === '--url' && next) {
      opts.url = next
      i++
    } else if (arg === '--out' && next) {
      opts.out = next
      i++
    } else if (arg === '--overwrite') {
      opts.overwrite = true
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`)
    }
  }

  return opts
}

function decodeSource(bytes: Uint8Array, sourceName: string): string {
  const decoded = sourceName.endsWith('.gz') ? gunzipSync(bytes) : Buffer.from(bytes)
  const text = decoded.toString('utf8')
  if (!text.includes('<JMdict') && !text.includes('<entry>')) {
    throw new Error('Prepared JMdict source does not look like JMdict XML')
  }
  return text
}

async function readRemote(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download JMdict: ${response.status} ${response.statusText}`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

async function readInput(opts: CliOptions): Promise<{ bytes: Uint8Array; sourceName: string; sourceLabel: string }> {
  if (opts.file) {
    return {
      bytes: readFileSync(opts.file),
      sourceName: opts.file,
      sourceLabel: opts.file,
    }
  }

  return {
    bytes: await readRemote(opts.url),
    sourceName: opts.url,
    sourceLabel: opts.url,
  }
}

export async function prepareJmdict(opts: CliOptions): Promise<void> {
  if (existsSync(opts.out) && !opts.overwrite) {
    throw new Error(`Output already exists: ${opts.out}. Use --overwrite to replace it.`)
  }

  const input = await readInput(opts)
  const xml = decodeSource(input.bytes, input.sourceName)
  mkdirSync(dirname(opts.out), { recursive: true })
  await Bun.write(opts.out, xml.endsWith('\n') ? xml : `${xml}\n`)

  console.log('\n=== JMdict Prepare ===')
  console.log(`Source: ${input.sourceLabel}`)
  console.log(`Output: ${opts.out}`)
  console.log(`Bytes: ${Buffer.byteLength(xml, 'utf8').toLocaleString()}`)
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  await prepareJmdict(opts)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
