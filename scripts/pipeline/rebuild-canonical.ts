import { existsSync } from 'fs'
import { prepareJmdict } from './prepare-jmdict'
import { prepareKanjidic2 } from './prepare-kanjidic2'
import { runImport as importJmdictCanonical } from './import-jmdict-canonical'
import { importKanjidic2Canonical } from './import-kanjidic2-canonical'
import { importTatoebaCanonical } from './import-tatoeba-canonical'
import { buildCanonicalRelease } from './build-canonical-release'
import type { TargetLanguage } from '../../src/domain/types'
import { SUPPORTED_LANGUAGES, normalizeLanguage } from '../../src/types'

interface CliOptions {
  jmdictFile?: string
  jmdictUrl: string
  jmdictSource: string
  kanjidic2File?: string
  kanjidic2Url: string
  kanjidic2Source: string
  tatoebaFile?: string
  tatoebaLang?: TargetLanguage
  tatoebaMaxExamplesPerSense: number
  snapshot: string
  registry: string
  releaseDb: string
  importedAt: string
  jmdictLimit: number | null
  kanjidic2Limit?: number
  skipPrepare: boolean
  overwrite: boolean
}

const DEFAULT_JMDICT_URL = 'http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz'
const DEFAULT_KANJIDIC2_URL = 'https://www.edrdg.org/kanjidic/kanjidic2.xml.gz'
const DEFAULT_JMDICT_SOURCE = 'data/sources/jmdict/JMdict_e.xml'
const DEFAULT_KANJIDIC2_SOURCE = 'data/sources/kanjidic2/kanjidic2.xml'
const DEFAULT_SNAPSHOT = 'data/snapshots/yori-dict.snapshot.json'
const DEFAULT_REGISTRY = 'data/registry/ids.json'
const DEFAULT_RELEASE_DB = 'data/releases/canonical/yori-dict.sqlite'
const DEFAULT_TATOEBA_MAX_EXAMPLES_PER_SENSE = 3

function printHelp(): void {
  console.log(`
Rebuild canonical Yori dictionary

Runs the canonical source prepare, import, validation, and SQLite release build
pipeline for JMdict + KANJIDIC2.

Usage:
  bun run rebuild:canonical [options]

Options:
  --jmdict-file <path>       Local JMdict XML/XML.gz source.
  --jmdict-url <url>         JMdict download URL (default: ${DEFAULT_JMDICT_URL})
  --jmdict-source <path>     Prepared JMdict XML path (default: ${DEFAULT_JMDICT_SOURCE})
  --kanjidic2-file <path>    Local KANJIDIC2 XML/XML.gz source.
  --kanjidic2-url <url>      KANJIDIC2 download URL (default: ${DEFAULT_KANJIDIC2_URL})
  --kanjidic2-source <path>  Prepared KANJIDIC2 XML path (default: ${DEFAULT_KANJIDIC2_SOURCE})
  --tatoeba-file <path>      Optional Tatoeba JSON/TSV examples file.
  --tatoeba-lang <lang>      Required for Tatoeba TSV input. Supported: ${SUPPORTED_LANGUAGES.join(', ')}
  --tatoeba-max-examples-per-sense <n>
                              Max Tatoeba examples per sense/language (default: ${DEFAULT_TATOEBA_MAX_EXAMPLES_PER_SENSE})
  --snapshot <path>          Canonical snapshot path (default: ${DEFAULT_SNAPSHOT})
  --registry <path>          Stable Yori ID registry path (default: ${DEFAULT_REGISTRY})
  --release-db <path>        Canonical SQLite release path (default: ${DEFAULT_RELEASE_DB})
  --imported-at <iso>        Import timestamp (default: now)
  --jmdict-limit <n>         Import only first n JMdict entries.
  --kanjidic2-limit <n>      Import only first n KANJIDIC2 characters.
  --skip-prepare             Use existing prepared source files.
  --overwrite                Replace prepared sources and release DB if they exist.
  --help, -h                 Show this help.
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
    jmdictUrl: DEFAULT_JMDICT_URL,
    jmdictSource: DEFAULT_JMDICT_SOURCE,
    kanjidic2Url: DEFAULT_KANJIDIC2_URL,
    kanjidic2Source: DEFAULT_KANJIDIC2_SOURCE,
    tatoebaMaxExamplesPerSense: DEFAULT_TATOEBA_MAX_EXAMPLES_PER_SENSE,
    snapshot: DEFAULT_SNAPSHOT,
    registry: DEFAULT_REGISTRY,
    releaseDb: DEFAULT_RELEASE_DB,
    importedAt: new Date().toISOString(),
    jmdictLimit: null,
    skipPrepare: false,
    overwrite: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg === '--jmdict-file' && next) {
      opts.jmdictFile = next
      i++
    } else if (arg === '--jmdict-url' && next) {
      opts.jmdictUrl = next
      i++
    } else if (arg === '--jmdict-source' && next) {
      opts.jmdictSource = next
      i++
    } else if (arg === '--kanjidic2-file' && next) {
      opts.kanjidic2File = next
      i++
    } else if (arg === '--kanjidic2-url' && next) {
      opts.kanjidic2Url = next
      i++
    } else if (arg === '--kanjidic2-source' && next) {
      opts.kanjidic2Source = next
      i++
    } else if (arg === '--tatoeba-file' && next) {
      opts.tatoebaFile = next
      i++
    } else if (arg === '--tatoeba-lang' && next) {
      const lang = normalizeLanguage(next)
      if (!lang) throw new Error(`--tatoeba-lang must be one of: ${SUPPORTED_LANGUAGES.join(', ')}`)
      opts.tatoebaLang = lang
      i++
    } else if (arg === '--tatoeba-max-examples-per-sense' && next) {
      opts.tatoebaMaxExamplesPerSense = parsePositiveInt(next, '--tatoeba-max-examples-per-sense')
      i++
    } else if (arg === '--snapshot' && next) {
      opts.snapshot = next
      i++
    } else if (arg === '--registry' && next) {
      opts.registry = next
      i++
    } else if (arg === '--release-db' && next) {
      opts.releaseDb = next
      i++
    } else if (arg === '--imported-at' && next) {
      opts.importedAt = next
      i++
    } else if (arg === '--jmdict-limit' && next) {
      opts.jmdictLimit = parsePositiveInt(next, '--jmdict-limit')
      i++
    } else if (arg === '--kanjidic2-limit' && next) {
      opts.kanjidic2Limit = parsePositiveInt(next, '--kanjidic2-limit')
      i++
    } else if (arg === '--skip-prepare') {
      opts.skipPrepare = true
    } else if (arg === '--overwrite') {
      opts.overwrite = true
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`)
    }
  }

  return opts
}

function assertPreparedSources(opts: CliOptions): void {
  for (const path of [opts.jmdictSource, opts.kanjidic2Source]) {
    if (!existsSync(path)) {
      throw new Error(`Prepared source not found: ${path}`)
    }
  }
}

export async function rebuildCanonical(opts: CliOptions): Promise<void> {
  if (!opts.skipPrepare) {
    await prepareJmdict({
      file: opts.jmdictFile,
      url: opts.jmdictUrl,
      out: opts.jmdictSource,
      overwrite: opts.overwrite,
    })
    await prepareKanjidic2({
      file: opts.kanjidic2File,
      url: opts.kanjidic2Url,
      out: opts.kanjidic2Source,
      overwrite: opts.overwrite,
    })
  } else {
    assertPreparedSources(opts)
  }

  await importJmdictCanonical({
    file: opts.jmdictSource,
    out: opts.snapshot,
    registry: opts.registry,
    limit: opts.jmdictLimit,
    importedAt: opts.importedAt,
  })
  await importKanjidic2Canonical({
    file: opts.kanjidic2Source,
    snapshot: opts.snapshot,
    out: opts.snapshot,
    registry: opts.registry,
    importedAt: opts.importedAt,
    limit: opts.kanjidic2Limit,
  })
  if (opts.tatoebaFile) {
    await importTatoebaCanonical({
      file: opts.tatoebaFile,
      snapshot: opts.snapshot,
      out: opts.snapshot,
      registry: opts.registry,
      importedAt: opts.importedAt,
      lang: opts.tatoebaLang,
      maxExamplesPerSense: opts.tatoebaMaxExamplesPerSense,
    })
  }
  await buildCanonicalRelease({
    snapshot: opts.snapshot,
    out: opts.releaseDb,
    overwrite: opts.overwrite,
  })

  console.log('\n=== Canonical Rebuild Complete ===')
  console.log(`Snapshot: ${opts.snapshot}`)
  console.log(`Release DB: ${opts.releaseDb}`)
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  await rebuildCanonical(opts)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
