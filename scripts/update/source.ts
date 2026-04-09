import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { loadLang, type LangFile } from '../import/base'
import { requireActiveReleaseConfig, makeTranslationKey } from '../../src/storage'
import {
  finalizeUpdateBatch,
  initUpdatesDatabase,
  insertExampleUpdateSet,
  insertTranslationUpdate,
  insertUpdateBatch,
  buildTranslationMapFromUpdates,
  buildExampleMapFromUpdates,
} from '../../src/update-store'
import { loadSnapshotFromReleaseDb } from '../release/lib'
import type { ReleaseExampleRecord, ReleaseSnapshot, ReleaseTranslationRecord } from '../../src/storage'

type TargetLang = 'en' | 'de' | 'ko' | 'zh-cn' | 'zh-tw'

interface Options {
  langs: TargetLang[] | null
  dryRun: boolean
}

export interface SourceUpdateOptions {
  langs?: TargetLang[] | null
  dryRun?: boolean
  actor?: string | null
}

export interface SourceUpdateResult {
  langs: TargetLang[]
  translationChanges: number
  exampleChanges: number
  batchId: number | null
  dryRun: boolean
  outputPath: string
}

const LANG_DIR = './data/lang'
const ALL_LANGS: TargetLang[] = ['en', 'de', 'ko', 'zh-cn', 'zh-tw']

function parseArgs(args: string[]): Options {
  const options: Options = { langs: null, dryRun: false }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if ((arg === '--langs' || arg === '--lang') && next) {
      options.langs = next.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean) as TargetLang[]
      i++
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function printHelp(): void {
  console.log(`
Create deterministic source updates by diffing data/lang/*.json against the active release.

Usage:
  bun run update:source [--langs en,de,ko,zh-cn,zh-tw] [--dry-run]
`)
}

function langSelection(options: Options): TargetLang[] {
  return options.langs && options.langs.length > 0 ? options.langs : [...ALL_LANGS]
}

function buildCandidateTranslationMap(langFile: LangFile): Map<string, ReleaseTranslationRecord> {
  const map = new Map<string, ReleaseTranslationRecord>()
  for (const [key, entry] of Object.entries(langFile.entries)) {
    const sources = new Set<string>()
    for (const sourceNames of Object.values(entry._defSources)) {
      for (const source of sourceNames) sources.add(source)
    }
    map.set(makeTranslationKey(key, langFile.lang), {
      wordId: key,
      lang: langFile.lang,
      definitions: entry.definitions,
      sources: [...sources].sort(),
    })
  }
  return map
}

function buildCandidateExampleMap(langFile: LangFile): Map<string, ReleaseExampleRecord[]> {
  const map = new Map<string, ReleaseExampleRecord[]>()
  for (const [key, entry] of Object.entries(langFile.entries)) {
    const seen = new Set<string>()
    const rows: ReleaseExampleRecord[] = []
    for (const example of entry.examples) {
      const hash = `${example.ja}\u0000${example.text}\u0000${example.source || 'unknown'}`
      if (seen.has(hash)) continue
      seen.add(hash)
      rows.push({
        wordId: key,
        lang: langFile.lang,
        japanese: example.ja,
        translation: example.text,
        source: example.source || 'unknown',
      })
    }
    map.set(makeTranslationKey(key, langFile.lang), rows)
  }
  return map
}

function normalizeTranslation(record: ReleaseTranslationRecord | null): string {
  if (!record) return JSON.stringify({ definitions: [], sources: [] })
  return JSON.stringify({
    definitions: record.definitions,
    sources: [...record.sources].sort(),
  })
}

function normalizeExamples(records: ReleaseExampleRecord[] | null): string {
  const rows = (records ?? [])
    .map((record) => ({
      japanese: record.japanese,
      translation: record.translation,
      source: record.source,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))

  return JSON.stringify(rows)
}

function applySourceUpdatesOnly(snapshot: ReleaseSnapshot, updatesDb: Database): ReleaseSnapshot {
  const next: ReleaseSnapshot = {
    words: new Map(snapshot.words),
    translations: new Map(snapshot.translations),
    examples: new Map(snapshot.examples),
  }

  const translationUpdates = buildTranslationMapFromUpdates(updatesDb, 'source')
  const exampleUpdates = buildExampleMapFromUpdates(updatesDb, 'source')

  for (const [key, value] of translationUpdates) {
    next.translations.set(key, value)
  }
  for (const [key, value] of exampleUpdates) {
    next.examples.set(key, value)
  }

  return next
}

export async function runSourceUpdate(input: SourceUpdateOptions = {}): Promise<SourceUpdateResult> {
  const options: Options = {
    langs: input.langs ?? null,
    dryRun: input.dryRun ?? false,
  }
  const langs = langSelection(options)
  const activeRelease = requireActiveReleaseConfig()
  const releaseDb = new Database(activeRelease.dbPath, { readonly: true })
  const updatesDb = initUpdatesDatabase()

  const releaseSnapshot = loadSnapshotFromReleaseDb(releaseDb)
  const sourceBaseline = applySourceUpdatesOnly(releaseSnapshot, updatesDb)
  const batchId = options.dryRun
    ? null
    : insertUpdateBatch(updatesDb, {
        kind: 'source_import',
        inputManifest: { langs, releaseVersion: activeRelease.version },
        notes: 'Generated from deterministic lang JSON snapshots.',
        actor: input.actor ?? null,
      })

  let translationChanges = 0
  let exampleChanges = 0

  try {
    for (const lang of langs) {
      const filePath = `${LANG_DIR}/${lang}.json`
      if (!existsSync(filePath)) continue

      const langFile = await loadLang(filePath, lang)
      const candidateTranslations = buildCandidateTranslationMap(langFile)
      const candidateExamples = buildCandidateExampleMap(langFile)

      const keys = new Set<string>()
      for (const wordId of sourceBaseline.words.keys()) {
        keys.add(makeTranslationKey(wordId, lang))
      }
      for (const key of candidateTranslations.keys()) keys.add(key)
      for (const key of candidateExamples.keys()) keys.add(key)

      for (const key of keys) {
        const currentTranslation = sourceBaseline.translations.get(key) ?? null
        const candidateTranslation = candidateTranslations.get(key) ?? null
        if (normalizeTranslation(currentTranslation) !== normalizeTranslation(candidateTranslation)) {
          translationChanges++
          if (!options.dryRun && batchId !== null) {
            const record = candidateTranslation ?? {
              wordId: key.split('\u0000')[0],
              lang,
              definitions: [],
              sources: [],
            }
            insertTranslationUpdate(updatesDb, {
              wordId: record.wordId,
              lang: record.lang,
              definitions: record.definitions,
              sources: record.sources,
              sourceType: 'source',
              batchId,
              reviewStatus: 'not_required',
            })
          }
        }

        const currentExamples = sourceBaseline.examples.get(key) ?? null
        const candidateExampleSet = candidateExamples.get(key) ?? []
        if (normalizeExamples(currentExamples) !== normalizeExamples(candidateExampleSet)) {
          exampleChanges++
          if (!options.dryRun && batchId !== null) {
            const [wordId] = key.split('\u0000')
            insertExampleUpdateSet(updatesDb, {
              wordId,
              lang,
              examples: candidateExampleSet.map((example) => ({
                japanese: example.japanese,
                translation: example.translation,
                source: example.source,
              })),
              sourceType: 'source',
              batchId,
              reviewStatus: 'not_required',
            })
          }
        }
      }
    }

    if (batchId !== null) {
      finalizeUpdateBatch(updatesDb, batchId, 'succeeded')
    }

    return {
      langs,
      translationChanges,
      exampleChanges,
      batchId,
      dryRun: options.dryRun,
      outputPath: process.env.UPDATES_DATABASE_PATH || './updates.sqlite',
    }
  } catch (error) {
    if (batchId !== null) {
      const message = error instanceof Error ? error.message : String(error)
      finalizeUpdateBatch(updatesDb, batchId, 'failed', message)
    }
    throw error
  } finally {
    releaseDb.close()
    updatesDb.close()
  }
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)
  const result = await runSourceUpdate({
    langs: options.langs,
    dryRun: options.dryRun,
  })

  console.log(`Translation changes: ${result.translationChanges.toLocaleString()}`)
  console.log(`Example changes: ${result.exampleChanges.toLocaleString()}`)
  if (result.dryRun) {
    console.log('Dry run only, no updates were written.')
  } else {
    console.log(`Source updates written to ${result.outputPath}`)
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Source update failed:', error)
    process.exit(1)
  })
}
