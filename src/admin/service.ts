import { Database } from 'bun:sqlite'
import { activateRelease, buildRelease, buildReleaseForNewWord, listReleases, promoteRelease } from '../release-service'
import type { Language, LookupResponse, WordRow } from '../types'
import { lookupWord } from '../db'
import { requireActiveReleaseConfig, type ReleaseExampleRecord, type ReleaseTranslationRecord, type ReleaseWordRecord } from '../storage'
import { createManualWordInSnapshot, type ManualWordInput } from '../manual-word-service'
import {
  approveExampleUpdateSet,
  approveTranslationUpdate,
  getActiveExampleUpdate,
  getActiveTranslationUpdate,
  getLatestExampleUpdateSetBySourceType,
  getLatestTranslationUpdateBySourceType,
  getUpdateBatch,
  initUpdatesDatabase,
  listExampleUpdateSets,
  listTranslationUpdates,
  listUpdateBatches,
  recordAdminAction,
  rejectExampleUpdateSet,
  rejectTranslationUpdate,
  verifyUpdatesAgainstWordIds,
} from '../update-store'
import type {
  AdminBatchDetailResponse,
  AdminEntryInspectionResponse,
  AdminNewWordFormData,
  AdminNewWordResponse,
  AdminReleaseListResponse,
  AdminReviewQueueResponse,
  AdminSummaryResponse,
  AdminUpdatesResponse,
} from './types'
import { runSourceUpdate } from '../../scripts/update/source'
import { defaultCliOptions, runGeminiImport, type GeminiRunOptions } from '../../scripts/import/gemini'

function openReleaseDb(): { db: Database; version: string; mode: string } {
  const config = requireActiveReleaseConfig()
  return {
    db: new Database(config.dbPath, { readonly: true }),
    version: config.version,
    mode: config.mode,
  }
}

function mapReleaseTranslation(row: { definitions: string; sources: string } | null): ReleaseTranslationRecord | null {
  if (!row) return null
  return {
    wordId: '',
    lang: '',
    definitions: JSON.parse(row.definitions) as string[],
    sources: JSON.parse(row.sources) as string[],
  }
}

function mapReleaseWord(row: WordRow): ReleaseWordRecord {
  return {
    id: row.id,
    word: row.word,
    reading: row.reading,
    partOfSpeech: JSON.parse(row.part_of_speech) as string[],
    common: row.common === 1,
    jlpt: row.jlpt ? JSON.parse(row.jlpt) as number[] : [],
    frequency: row.frequency,
  }
}

function findReleaseWord(db: Database, word: string): ReleaseWordRecord | null {
  const row = db.query<WordRow, [string]>(`
    SELECT *
    FROM words
    WHERE word = ?1 OR reading = ?1
    ORDER BY
      common DESC,
      CASE
        WHEN jlpt IS NULL THEN 0
        ELSE CAST(json_extract(jlpt, '$[0]') AS INTEGER)
      END DESC
    LIMIT 1
  `).get(word)

  return row ? mapReleaseWord(row) : null
}

function getReleaseTranslation(
  db: Database,
  wordId: string,
  lang: Language
): ReleaseTranslationRecord | null {
  const row = db.query<{ definitions: string; sources: string }, [string, string]>(`
    SELECT definitions, sources
    FROM translations
    WHERE word_id = ?1 AND lang = ?2
  `).get(wordId, lang)

  if (!row) return null
  const translation = mapReleaseTranslation(row)
  return translation
    ? { ...translation, wordId, lang }
    : null
}

function getReleaseExamples(
  db: Database,
  wordId: string,
  lang: Language
): ReleaseExampleRecord[] {
  return db.query<ReleaseExampleRecord, [string, string]>(`
    SELECT word_id AS wordId, lang, japanese, translation, source
    FROM examples
    WHERE word_id = ?1 AND lang = ?2
    ORDER BY id
  `).all(wordId, lang)
}

function getValidWordIds(db: Database): Set<string> {
  return new Set(
    db.query<{ id: string }, []>(`
      SELECT id
      FROM words
    `).all().map((row) => row.id)
  )
}

function logReviewAction(
  updatesDb: Database,
  actor: string,
  action: string,
  targetId: string,
  notes?: string | null
): void {
  recordAdminAction(updatesDb, {
    actor,
    action,
    targetKind: 'update',
    targetId,
    notes,
  })
}

export function getAdminSummary(): AdminSummaryResponse {
  const { db: releaseDb, version, mode } = openReleaseDb()
  const updatesDb = initUpdatesDatabase()

  const verification = verifyUpdatesAgainstWordIds(updatesDb, getValidWordIds(releaseDb))
  const response: AdminSummaryResponse = {
    activeReleaseVersion: version,
    activeReleaseMode: mode,
    translationCounts: verification.translationCounts,
    exampleSetCounts: verification.exampleSetCounts,
    reviewCounts: verification.reviewCounts,
    orphanedWordIdsCount: verification.orphanedWordIds.length,
    activeReviewedAiCount: verification.activeReviewedAiCount,
    recentBatches: listUpdateBatches(updatesDb, 10),
  }

  releaseDb.close()
  updatesDb.close()
  return response
}

export function inspectEntry(word: string, lang: Language): AdminEntryInspectionResponse {
  const { db: releaseDb, version } = openReleaseDb()
  const updatesDb = initUpdatesDatabase()
  const releaseWord = findReleaseWord(releaseDb, word)
  const effective = lookupWord(word, lang)

  const response: AdminEntryInspectionResponse = {
    releaseVersion: version,
    query: { word, lang },
    word: releaseWord
      ? {
          wordId: releaseWord.id,
          word: releaseWord.word,
          reading: releaseWord.reading,
          partOfSpeech: releaseWord.partOfSpeech,
          frequency: releaseWord.frequency,
        }
      : null,
    release: releaseWord
      ? {
          definitions: getReleaseTranslation(releaseDb, releaseWord.id, lang)?.definitions ?? [],
          sources: getReleaseTranslation(releaseDb, releaseWord.id, lang)?.sources ?? [],
          examples: getReleaseExamples(releaseDb, releaseWord.id, lang).map((example) => ({
            japanese: example.japanese,
            translation: example.translation,
            source: example.source,
          })),
        }
      : null,
    sourceUpdate: {
      translation: releaseWord ? getLatestTranslationUpdateBySourceType(updatesDb, releaseWord.id, lang, 'source') : null,
      examples: releaseWord ? getLatestExampleUpdateSetBySourceType(updatesDb, releaseWord.id, lang, 'source') : null,
    },
    aiUpdate: {
      translation: releaseWord ? getLatestTranslationUpdateBySourceType(updatesDb, releaseWord.id, lang, 'ai') : null,
      examples: releaseWord ? getLatestExampleUpdateSetBySourceType(updatesDb, releaseWord.id, lang, 'ai') : null,
    },
    effective: effective as LookupResponse | null,
  }

  releaseDb.close()
  updatesDb.close()
  return response
}

export function getAiReviewQueue(lang?: Language | null): AdminReviewQueueResponse {
  const { db: releaseDb, version } = openReleaseDb()
  const updatesDb = initUpdatesDatabase()
  const response: AdminReviewQueueResponse = {
    releaseVersion: version,
    translations: listTranslationUpdates(updatesDb, {
      sourceType: 'ai',
      status: 'active',
      reviewStatus: 'pending',
      lang: lang ?? null,
      limit: 100,
    }),
    exampleSets: listExampleUpdateSets(updatesDb, {
      sourceType: 'ai',
      status: 'active',
      reviewStatus: 'pending',
      lang: lang ?? null,
      limit: 100,
    }),
  }
  releaseDb.close()
  updatesDb.close()
  return response
}

export function getAdminReleaseList(): AdminReleaseListResponse {
  const activeRelease = requireActiveReleaseConfig()
  return {
    activeReleaseVersion: activeRelease.version,
    releases: listReleases(),
  }
}

export function getUpdatesExplorer(filters: {
  lang?: Language | null
  sourceType?: 'source' | 'ai' | null
  status?: string | null
  reviewStatus?: 'not_required' | 'pending' | 'approved' | 'rejected' | null
}): AdminUpdatesResponse {
  const { db: releaseDb, version } = openReleaseDb()
  const updatesDb = initUpdatesDatabase()
  const response: AdminUpdatesResponse = {
    releaseVersion: version,
    translations: listTranslationUpdates(updatesDb, {
      ...filters,
      limit: 100,
    }),
    exampleSets: listExampleUpdateSets(updatesDb, {
      ...filters,
      limit: 100,
    }),
    verification: verifyUpdatesAgainstWordIds(updatesDb, getValidWordIds(releaseDb)),
  }
  releaseDb.close()
  updatesDb.close()
  return response
}

export function getBatchDetail(batchId: number): AdminBatchDetailResponse {
  const activeRelease = requireActiveReleaseConfig()
  const updatesDb = initUpdatesDatabase()
  const response: AdminBatchDetailResponse = {
    releaseVersion: activeRelease.version,
    batch: getUpdateBatch(updatesDb, batchId),
    translations: listTranslationUpdates(updatesDb, { batchId, limit: 500 }),
    exampleSets: listExampleUpdateSets(updatesDb, { batchId, limit: 500 }),
  }
  updatesDb.close()
  return response
}

export function approveTranslationReview(id: number, actor: string, notes?: string | null) {
  const updatesDb = initUpdatesDatabase()
  const result = approveTranslationUpdate(updatesDb, id, actor, notes)
  if (result) logReviewAction(updatesDb, actor, 'review.translation.approve', String(id), notes)
  updatesDb.close()
  return result
}

export function rejectTranslationReview(id: number, actor: string, notes?: string | null) {
  const updatesDb = initUpdatesDatabase()
  const result = rejectTranslationUpdate(updatesDb, id, actor, notes)
  if (result) logReviewAction(updatesDb, actor, 'review.translation.reject', String(id), notes)
  updatesDb.close()
  return result
}

export function approveExampleSetReview(id: number, actor: string, notes?: string | null) {
  const updatesDb = initUpdatesDatabase()
  const result = approveExampleUpdateSet(updatesDb, id, actor, notes)
  if (result) logReviewAction(updatesDb, actor, 'review.example-set.approve', String(id), notes)
  updatesDb.close()
  return result
}

export function rejectExampleSetReview(id: number, actor: string, notes?: string | null) {
  const updatesDb = initUpdatesDatabase()
  const result = rejectExampleUpdateSet(updatesDb, id, actor, notes)
  if (result) logReviewAction(updatesDb, actor, 'review.example-set.reject', String(id), notes)
  updatesDb.close()
  return result
}

export async function runAdminSourceUpdate(input: {
  langs?: Language[] | null
  dryRun?: boolean
  actor: string
}) {
  return runSourceUpdate({
    langs: input.langs,
    dryRun: input.dryRun,
    actor: input.actor,
  })
}

export async function runAdminGeminiImport(
  input: Partial<GeminiRunOptions> & { actor: string }
): Promise<unknown> {
  const defaults = defaultCliOptions()
  return runGeminiImport({
    ...defaults,
    ...input,
    langs: input.langs ?? defaults.langs,
    actor: input.actor,
  })
}

export async function runAdminBuildRelease(input: {
  version?: string | null
  activate?: boolean
  actor: string
}) {
  return buildRelease({
    version: input.version,
    activate: input.activate,
    actor: input.actor,
  })
}

export function runAdminActivateRelease(version: string, actor: string) {
  return activateRelease(version, actor)
}

export function runAdminPromoteRelease(input: {
  version?: string | null
  activate?: boolean
  actor: string
}) {
  return promoteRelease({
    version: input.version,
    activate: input.activate,
    actor: input.actor,
  })
}

export function getEffectiveOverrides(wordId: string, lang: Language) {
  const updatesDb = initUpdatesDatabase()
  const response = {
    translation: getActiveTranslationUpdate(updatesDb, wordId, lang),
    examples: getActiveExampleUpdate(updatesDb, wordId, lang),
  }
  updatesDb.close()
  return response
}

export async function createAdminNewWord(
  input: AdminNewWordFormData,
  actor: string
): Promise<AdminNewWordResponse> {
  const activeRelease = requireActiveReleaseConfig()
  const result = await createManualWordInSnapshot(input as ManualWordInput)

  if (!result.created) {
    return {
      created: false,
      releaseVersion: activeRelease.version,
      activeReleaseContainsWord: false,
      fieldErrors: result.fieldErrors,
      warnings: result.warnings,
      similarEntries: result.similarEntries,
      conflictWordId: result.conflictWordId,
    }
  }

  const updatesDb = initUpdatesDatabase()
  recordAdminAction(updatesDb, {
    actor,
    action: 'new-word.create',
    targetKind: 'word',
    targetId: result.wordId,
    notes: `snapshot:${result.snapshotFiles.join(',')}`,
  })
  updatesDb.close()

  return {
    created: true,
    wordId: result.wordId,
    snapshotFiles: result.snapshotFiles,
    releaseVersion: activeRelease.version,
    activeReleaseContainsWord: false,
    warnings: result.warnings,
    similarEntries: result.similarEntries,
    fieldErrors: {},
    nextActions: {
      buildReleaseUrl: '/admin/api/new-word/build-release',
      entryInspectorUrl: `/admin/entry?word=${encodeURIComponent(input.word)}&lang=${encodeURIComponent(input.translations[0]?.lang ?? 'en')}`,
      releasesUrl: '/admin/releases',
    },
  }
}

export async function runAdminBuildReleaseForNewWord(input: {
  createdWordId: string
  activate?: boolean
  actor: string
}) {
  const result = await buildReleaseForNewWord(input.createdWordId, {
    activate: input.activate,
    actor: input.actor,
  })

  const updatesDb = initUpdatesDatabase()
  recordAdminAction(updatesDb, {
    actor: input.actor,
    action: 'new-word.build-release',
    targetKind: 'word',
    targetId: input.createdWordId,
    notes: result.version,
  })
  updatesDb.close()

  return {
    ...result,
    createdWordId: input.createdWordId,
  }
}
