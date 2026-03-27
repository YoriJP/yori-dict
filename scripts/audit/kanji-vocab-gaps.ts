import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import {
  loadCore,
  loadLang,
  type CoreEntry,
  type LangEntry,
} from '../import/base'

export type AuditLanguage = 'en' | 'de' | 'ko' | 'zh-cn' | 'zh-tw'

export interface RankedCoreEntry {
  key: string
  entry: CoreEntry
}

export interface GapCandidate {
  key: string
  word: string
  reading: string
  common: boolean
  frequency: number | null
  partOfSpeech: string[]
  definitions: string[]
  definitionsCount: number
  sources: string[]
}

export interface LanguageGapReport {
  lang: AuditLanguage
  scanned: number
  missingCount: number
  thinCount: number
  weakFallbackCount: number
  missingDefinitions: GapCandidate[]
  thinDefinitions: GapCandidate[]
  weakFallbackOnly: GapCandidate[]
}

export interface AuditReportSummary {
  generatedAt: string
  totalKanjiEntries: number
  limit: number
  languages: AuditLanguage[]
  reports: Record<AuditLanguage, LanguageGapReport>
}

const DATA_DIR = './data'
const LANG_DIR = './data/lang'
const CORE_PATH = `${DATA_DIR}/core.json`
const DEFAULT_OUT_DIR = `${DATA_DIR}/reports/kanji-vocab-gaps`
const DEFAULT_LIMIT = 500

const SUPPORTED_LANGS: AuditLanguage[] = ['en', 'de', 'ko', 'zh-cn', 'zh-tw']

const SHORT_DEF_MAX_LENGTH: Record<AuditLanguage, number> = {
  en: 24,
  de: 28,
  ko: 12,
  'zh-cn': 8,
  'zh-tw': 8,
}

const WEAK_FALLBACK_SOURCES: Record<AuditLanguage, Set<string>> = {
  en: new Set(['ai']),
  de: new Set(['ai']),
  ko: new Set(['kowiktionary', 'ai']),
  'zh-cn': new Set(['cedict', 'ai']),
  'zh-tw': new Set(['cedict', 'ai']),
}

export function hasKanji(text: string): boolean {
  return /[一-龯々〆ヶ]/.test(text)
}

function normalizedDefinitionLength(text: string): number {
  return text
    .replace(/[(){}\[\],.;:!?'"`~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .length
}

export function isShortDefinition(text: string, lang: AuditLanguage): boolean {
  return normalizedDefinitionLength(text) <= SHORT_DEF_MAX_LENGTH[lang]
}

export function collectDefinitionSources(entry?: LangEntry): string[] {
  if (!entry?._defSources) return []

  const sources = new Set<string>()
  for (const sourceList of Object.values(entry._defSources)) {
    for (const source of sourceList) {
      sources.add(source)
    }
  }
  return [...sources].sort()
}

function compareCoreEntries(a: RankedCoreEntry, b: RankedCoreEntry): number {
  if (a.entry.common !== b.entry.common) {
    return a.entry.common ? -1 : 1
  }

  const freqA = a.entry.frequency ?? Number.MAX_SAFE_INTEGER
  const freqB = b.entry.frequency ?? Number.MAX_SAFE_INTEGER
  if (freqA !== freqB) return freqA - freqB

  const wordLengthA = [...a.entry.word].length
  const wordLengthB = [...b.entry.word].length
  if (wordLengthA !== wordLengthB) return wordLengthA - wordLengthB

  return a.key.localeCompare(b.key, 'ja')
}

export function buildRankedCoreEntries(entries: Record<string, CoreEntry>): RankedCoreEntry[] {
  return Object.entries(entries)
    .filter(([, entry]) => hasKanji(entry.word))
    .map(([key, entry]) => ({ key, entry }))
    .sort(compareCoreEntries)
}

function buildCandidate(core: RankedCoreEntry, langEntry?: LangEntry): GapCandidate {
  return {
    key: core.key,
    word: core.entry.word,
    reading: core.entry.reading,
    common: core.entry.common,
    frequency: core.entry.frequency,
    partOfSpeech: core.entry.partOfSpeech,
    definitions: langEntry?.definitions ?? [],
    definitionsCount: langEntry?.definitions.length ?? 0,
    sources: collectDefinitionSources(langEntry),
  }
}

function isMissingDefinition(entry?: LangEntry): boolean {
  return !entry || entry.definitions.length === 0
}

function isThinDefinition(entry: LangEntry | undefined, lang: AuditLanguage): boolean {
  if (!entry || entry.definitions.length !== 1) return false
  return isShortDefinition(entry.definitions[0], lang)
}

function isWeakFallbackOnly(entry: LangEntry | undefined, lang: AuditLanguage): boolean {
  if (!entry || entry.definitions.length === 0) return false
  const sources = collectDefinitionSources(entry)
  return sources.length === 1 && WEAK_FALLBACK_SOURCES[lang].has(sources[0])
}

export function buildLanguageGapReport(
  lang: AuditLanguage,
  rankedEntries: RankedCoreEntry[],
  langEntries: Record<string, LangEntry>,
  limit = DEFAULT_LIMIT
): LanguageGapReport {
  const report: LanguageGapReport = {
    lang,
    scanned: rankedEntries.length,
    missingCount: 0,
    thinCount: 0,
    weakFallbackCount: 0,
    missingDefinitions: [],
    thinDefinitions: [],
    weakFallbackOnly: [],
  }

  for (const ranked of rankedEntries) {
    const langEntry = langEntries[ranked.key]

    if (isMissingDefinition(langEntry)) {
      report.missingCount++
      if (report.missingDefinitions.length < limit) {
        report.missingDefinitions.push(buildCandidate(ranked, langEntry))
      }
    }

    if (isThinDefinition(langEntry, lang)) {
      report.thinCount++
      if (report.thinDefinitions.length < limit) {
        report.thinDefinitions.push(buildCandidate(ranked, langEntry))
      }
    }

    if (isWeakFallbackOnly(langEntry, lang)) {
      report.weakFallbackCount++
      if (report.weakFallbackOnly.length < limit) {
        report.weakFallbackOnly.push(buildCandidate(ranked, langEntry))
      }
    }
  }

  return report
}

function parseArgs(args: string[]): { limit: number; outDir: string; langs: AuditLanguage[] } {
  let limit = DEFAULT_LIMIT
  let outDir = DEFAULT_OUT_DIR
  let langs = SUPPORTED_LANGS

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--limit' && next) {
      const value = Number.parseInt(next, 10)
      if (!Number.isFinite(value) || value < 1) {
        throw new Error(`Invalid --limit value: ${next}`)
      }
      limit = value
      i++
      continue
    }

    if (arg === '--out-dir' && next) {
      outDir = next
      i++
      continue
    }

    if (arg === '--langs' && next) {
      const parsed = next
        .split(',')
        .map((lang) => lang.trim().toLowerCase())
        .filter(Boolean)

      const invalid = parsed.filter((lang) => !SUPPORTED_LANGS.includes(lang as AuditLanguage))
      if (invalid.length > 0) {
        throw new Error(`Unsupported language(s): ${invalid.join(', ')}`)
      }

      langs = parsed as AuditLanguage[]
      i++
    }
  }

  return { limit, outDir, langs }
}

function printHelp(): void {
  console.log(`
Kanji Vocabulary Gap Audit

Audits kanji-bearing vocabulary coverage across existing language files.

Usage:
  bun run audit:kanji-vocab [options]

Options:
  --limit <n>      Number of top entries to keep per issue bucket (default: ${DEFAULT_LIMIT})
  --out-dir <dir>  Output directory for JSON reports (default: ${DEFAULT_OUT_DIR})
  --langs <list>   Comma-separated languages: ${SUPPORTED_LANGS.join(', ')}
  --help           Show this help
`)
}

async function writeReports(summary: AuditReportSummary, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true })
  await Bun.write(`${outDir}/summary.json`, JSON.stringify(summary, null, 2))

  for (const lang of summary.languages) {
    await Bun.write(`${outDir}/${lang}.json`, JSON.stringify(summary.reports[lang], null, 2))
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    printHelp()
    return
  }

  const { limit, outDir, langs } = parseArgs(args)

  if (!existsSync(CORE_PATH)) {
    throw new Error(`core.json not found: ${CORE_PATH}`)
  }

  const core = await loadCore(CORE_PATH)
  const rankedEntries = buildRankedCoreEntries(core.entries)

  const reports = {} as Record<AuditLanguage, LanguageGapReport>
  for (const lang of langs) {
    const langPath = `${LANG_DIR}/${lang}.json`
    const langFile = await loadLang(langPath, lang)
    reports[lang] = buildLanguageGapReport(lang, rankedEntries, langFile.entries, limit)
  }

  const summary: AuditReportSummary = {
    generatedAt: new Date().toISOString(),
    totalKanjiEntries: rankedEntries.length,
    limit,
    languages: langs,
    reports,
  }

  await writeReports(summary, outDir)

  console.log('\n=== Kanji Vocabulary Gap Audit ===')
  console.log(`Kanji-bearing entries scanned: ${rankedEntries.length.toLocaleString()}`)
  console.log(`Output directory: ${outDir}`)
  console.log(`Top candidates per bucket: ${limit.toLocaleString()}`)

  for (const lang of langs) {
    const report = reports[lang]
    console.log(`\n[${lang}]`)
    console.log(`  Missing definitions: ${report.missingCount.toLocaleString()}`)
    console.log(`  Thin one-definition entries: ${report.thinCount.toLocaleString()}`)
    console.log(`  Weak fallback only: ${report.weakFallbackCount.toLocaleString()}`)

    const topMissing = report.missingDefinitions[0]
    if (topMissing) {
      console.log(`  Top missing: ${topMissing.word} (${topMissing.reading})`)
    }
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
