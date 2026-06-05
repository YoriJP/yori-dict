import { existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { analyzeCanonicalQuality, type QualityReport, type QualitySeverity } from '../../src/domain/quality'
import type { CanonicalSnapshot, TargetLanguage } from '../../src/domain/types'
import { normalizeLanguage, SUPPORTED_LANGUAGES } from '../../src/types'

interface CliOptions {
  snapshot: string
  jsonOut?: string
  failOn: QualitySeverity | 'none'
  aliasFanoutThreshold: number
  sampleLimit: number
  targetLanguages: TargetLanguage[]
}

const DEFAULT_SNAPSHOT = 'data/snapshots/yori-dict.snapshot.json'

function printHelp(): void {
  console.log(`
Canonical dictionary quality report

Usage:
  bun run quality:canonical [options]

Options:
  --snapshot <path>                Canonical snapshot JSON (default: ${DEFAULT_SNAPSHOT})
  --json-out <path>                Write the full report as JSON.
  --fail-on <none|info|warning|error>
                                    Exit non-zero when findings meet this severity (default: error).
  --alias-fanout-threshold <n>     Warn when one lookup key maps to more than n entries (default: 20).
  --sample-limit <n>               Number of samples to print per finding (default: 10).
  --target-lang <lang>             Report senses missing this target-language gloss. Repeatable.
  --help, -h                       Show this help.
`)
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function parseFailOn(value: string): QualitySeverity | 'none' {
  if (value === 'none' || value === 'warning' || value === 'error' || value === 'info') return value
  throw new Error('--fail-on must be one of: none, info, warning, error')
}

function parseLang(value: string): TargetLanguage {
  const lang = normalizeLanguage(value)
  if (!lang) throw new Error(`--target-lang must be one of: ${SUPPORTED_LANGUAGES.join(', ')}`)
  return lang
}

export function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = {
    snapshot: DEFAULT_SNAPSHOT,
    failOn: 'error',
    aliasFanoutThreshold: 20,
    sampleLimit: 10,
    targetLanguages: [],
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg === '--snapshot' && next) {
      opts.snapshot = next
      i++
    } else if (arg === '--json-out' && next) {
      opts.jsonOut = next
      i++
    } else if (arg === '--fail-on' && next) {
      opts.failOn = parseFailOn(next)
      i++
    } else if (arg === '--alias-fanout-threshold' && next) {
      opts.aliasFanoutThreshold = parsePositiveInt(next, '--alias-fanout-threshold')
      i++
    } else if (arg === '--sample-limit' && next) {
      opts.sampleLimit = parsePositiveInt(next, '--sample-limit')
      i++
    } else if (arg === '--target-lang' && next) {
      const lang = parseLang(next)
      if (!opts.targetLanguages.includes(lang)) opts.targetLanguages.push(lang)
      i++
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`)
    }
  }

  return opts
}

function shouldFail(report: QualityReport, failOn: QualitySeverity | 'none'): boolean {
  if (failOn === 'none') return false
  const severities: Record<QualitySeverity, number> = {
    info: 1,
    warning: 2,
    error: 3,
  }
  const threshold = severities[failOn]
  return report.findings.some((finding) => severities[finding.severity] >= threshold)
}

function printReport(snapshotPath: string, report: QualityReport): void {
  console.log(`\n=== Canonical Dictionary Quality: ${snapshotPath} ===`)
  console.log(`Entries: ${report.summary.entries.toLocaleString()}`)
  console.log(`Senses: ${report.summary.senses.toLocaleString()}`)
  console.log(`Glosses: ${report.summary.glosses.toLocaleString()}`)
  console.log(`Examples: ${report.summary.examples.toLocaleString()}`)
  console.log(`Lookup aliases: ${report.summary.lookupAliases.toLocaleString()}`)
  console.log(`Kanji characters: ${report.summary.kanjiCharacters.toLocaleString()}`)

  console.log('\nSource refs by kind:')
  for (const [kind, count] of Object.entries(report.summary.sourceRefsByKind)) {
    console.log(`  - ${kind}: ${count.toLocaleString()}`)
  }

  console.log('\nGlosses by language:')
  for (const [lang, count] of Object.entries(report.summary.glossesByLanguage)) {
    console.log(`  - ${lang}: ${count.toLocaleString()}`)
  }

  if (report.findings.length === 0) {
    console.log('\nFindings: none')
    return
  }

  console.log('\nFindings:')
  for (const finding of report.findings) {
    console.log(`  - [${finding.severity}] ${finding.code}: ${finding.count.toLocaleString()}`)
    console.log(`    ${finding.message}`)
    for (const sample of finding.samples) {
      console.log(`    sample: ${sample}`)
    }
  }
}

async function writeJsonReport(path: string, report: QualityReport): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`)
}

export async function reportCanonicalQuality(opts: CliOptions): Promise<QualityReport> {
  if (!existsSync(opts.snapshot)) {
    throw new Error(`Snapshot not found: ${opts.snapshot}`)
  }

  const snapshot = await Bun.file(opts.snapshot).json() as CanonicalSnapshot
  const report = analyzeCanonicalQuality(snapshot, {
    aliasFanoutThreshold: opts.aliasFanoutThreshold,
    sampleLimit: opts.sampleLimit,
    targetLanguages: opts.targetLanguages,
  })

  printReport(opts.snapshot, report)
  if (opts.jsonOut) {
    await writeJsonReport(opts.jsonOut, report)
    console.log(`\nJSON report: ${opts.jsonOut}`)
  }

  return report
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2))
  reportCanonicalQuality(opts)
    .then((report) => {
      if (shouldFail(report, opts.failOn)) process.exit(1)
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}
