import { Database } from 'bun:sqlite'
import { activateRelease, buildRelease, buildReleaseForNewWord, listReleases, promoteRelease } from '../release-service'
import type { Language, LookupResponse, WordRow } from '../types'
import { lookupWord } from '../db'
import { requireActiveReleaseConfig, type ReleaseExampleRecord, type ReleaseTranslationRecord, type ReleaseWordRecord } from '../storage'
import { createManualWordInSnapshot, type ManualWordInput } from '../manual-word-service'
import {
  applyBulkReviewStatus,
  approveExampleUpdateSet,
  approveTranslationUpdate,
  getActiveExampleUpdateSetBySourceType,
  getActiveExampleUpdate,
  getActiveTranslationUpdateBySourceType,
  getActiveTranslationUpdate,
  getLatestExampleUpdateSetBySourceType,
  getLatestTranslationUpdateBySourceType,
  getUpdateBatch,
  initUpdatesDatabase,
  listPendingAiExampleUpdateSets,
  listPendingAiTranslationUpdates,
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
  AdminReviewBatchPageResponse,
  AdminReviewBatchSummaryResponse,
  AdminReviewQueueResponseV2,
  AdminNewWordFormData,
  AdminNewWordResponse,
  AdminReleaseListResponse,
  AdminReviewQueueResponse,
  AdminSummaryResponse,
  AdminUpdatesResponse,
  BulkReviewActionRequest,
  BulkReviewActionResponse,
  ReviewQueueFilters,
  ReviewQueueSummary,
  ReviewRiskLevel,
  ReviewUnit,
  ReviewUnitFlags,
  ReviewUnitReleaseValue,
  ReviewUnitShape,
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

function getReleaseWordById(db: Database, wordId: string): ReleaseWordRecord | null {
  const row = db.query<WordRow, [string]>(`
    SELECT *
    FROM words
    WHERE id = ?1
    LIMIT 1
  `).get(wordId)

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

function makeReviewUnitId(wordId: string, lang: Language, batchId: number): string {
  return `${encodeURIComponent(wordId)}|${lang}|${batchId}`
}

function parseReviewUnitId(unitId: string): { wordId: string; lang: Language; batchId: number } | null {
  const parts = unitId.split('|')
  if (parts.length !== 3) return null
  const [encodedWordId, langRaw, batchIdRaw] = parts
  const batchId = Number(batchIdRaw)
  const lang = langRaw as Language
  let wordId = ''
  try {
    wordId = decodeURIComponent(encodedWordId)
  } catch {
    return null
  }
  if (!wordId || !lang || !Number.isFinite(batchId)) return null
  return { wordId, lang, batchId }
}

function compareReviewUnitOrder(
  left: Pick<ReviewUnit, 'batchId' | 'wordId' | 'lang'>,
  right: Pick<ReviewUnit, 'batchId' | 'wordId' | 'lang'>
): number {
  if (left.batchId !== right.batchId) return right.batchId - left.batchId
  if (left.wordId !== right.wordId) return left.wordId.localeCompare(right.wordId)
  return left.lang.localeCompare(right.lang)
}

function toReviewReleaseValue(
  translation: ReleaseTranslationRecord | null,
  examples: ReleaseExampleRecord[]
): ReviewUnitReleaseValue | null {
  if (!translation && examples.length === 0) return null
  return {
    definitions: translation?.definitions ?? [],
    sources: translation?.sources ?? [],
    examples: examples.map((example) => ({
      japanese: example.japanese,
      translation: example.translation,
      source: example.source,
    })),
  }
}

function getReleaseLayer(
  releaseDb: Database,
  wordId: string,
  lang: Language
): ReviewUnitReleaseValue | null {
  return toReviewReleaseValue(
    getReleaseTranslation(releaseDb, wordId, lang),
    getReleaseExamples(releaseDb, wordId, lang),
  )
}

function definitionsTotalLength(definitions: string[]): number {
  return definitions.reduce((total, item) => total + item.length, 0)
}

function pickEffectivePreview(
  release: ReviewUnitReleaseValue | null,
  sourceUpdate: {
    translation: ReturnType<typeof getActiveTranslationUpdateBySourceType>
    examples: ReturnType<typeof getActiveExampleUpdateSetBySourceType>
  },
  translation: ReviewUnit['translation'],
  exampleSet: ReviewUnit['exampleSet']
): ReviewUnitReleaseValue | null {
  const definitions = sourceUpdate.translation?.definitions
    ?? translation?.definitions
    ?? release?.definitions
    ?? []
  const sources = sourceUpdate.translation?.sources
    ?? translation?.sources
    ?? release?.sources
    ?? []
  const examples = sourceUpdate.examples?.examples
    ?? exampleSet?.examples
    ?? release?.examples
    ?? []

  if (definitions.length === 0 && examples.length === 0) return null

  return {
    definitions,
    sources,
    examples: examples.map((example) => ({
      japanese: example.japanese,
      translation: example.translation,
      source: example.source,
    })),
  }
}

function computeRiskLevel(input: {
  word: ReleaseWordRecord | null
  release: ReviewUnitReleaseValue | null
  sourceUpdate: {
    translation: ReturnType<typeof getActiveTranslationUpdateBySourceType>
    examples: ReturnType<typeof getActiveExampleUpdateSetBySourceType>
  }
  translation: ReviewUnit['translation']
  exampleSet: ReviewUnit['exampleSet']
  flags: ReviewUnitFlags
}): ReviewRiskLevel {
  if (input.flags.hasSourceConflict) return 'high'

  const baselineDefinitions = input.sourceUpdate.translation?.definitions
    ?? input.release?.definitions
    ?? []
  const baselineExamples = input.sourceUpdate.examples?.examples
    ?? input.release?.examples
    ?? []

  const hasHighFrequencySignal = Boolean(
    input.word?.common
    || (input.word?.frequency !== null && input.word?.frequency !== undefined && input.word.frequency <= 5000)
  )

  if (input.translation) {
    const definitionDelta = Math.abs(input.translation.definitions.length - baselineDefinitions.length)
    const baselineChars = definitionsTotalLength(baselineDefinitions)
    const candidateChars = definitionsTotalLength(input.translation.definitions)

    if (definitionDelta > 2) return 'high'
    if (baselineChars > 0 && candidateChars > baselineChars * 2) return 'high'
    if (hasHighFrequencySignal && JSON.stringify(input.translation.definitions) !== JSON.stringify(baselineDefinitions)) {
      return 'high'
    }
  }

  if (input.flags.isTranslationOnly || input.flags.isExamplesOnly) return 'medium'

  if (input.exampleSet) {
    const exampleDelta = Math.abs(input.exampleSet.examples.length - baselineExamples.length)
    if (exampleDelta >= 2) return 'medium'
  }

  if (input.translation && JSON.stringify(input.translation.definitions) !== JSON.stringify(baselineDefinitions)) {
    return 'medium'
  }

  return 'low'
}

function buildReviewQueueSummary(releaseVersion: string, units: ReviewUnit[]): {
  releaseVersion: string
  summary: ReviewQueueSummary
} {
  const byLanguage: Record<string, number> = {}
  const byRisk: Record<ReviewRiskLevel, number> = { low: 0, medium: 0, high: 0 }
  const batches = new Map<number, ReviewQueueSummary['recentBatches'][number]>()
  let sourceConflictCount = 0

  for (const unit of units) {
    byLanguage[unit.lang] = (byLanguage[unit.lang] || 0) + 1
    byRisk[unit.riskLevel] += 1
    if (unit.flags.hasSourceConflict) sourceConflictCount += 1

    const existing = batches.get(unit.batchId)
    if (existing) {
      existing.pendingUnits += 1
      existing.byLanguage[unit.lang] = (existing.byLanguage[unit.lang] || 0) + 1
      if (unit.flags.hasSourceConflict) existing.sourceConflictCount += 1
      continue
    }

    batches.set(unit.batchId, {
      batchId: unit.batchId,
      batch: unit.batch,
      pendingUnits: 1,
      sourceConflictCount: unit.flags.hasSourceConflict ? 1 : 0,
      byLanguage: { [unit.lang]: 1 },
    })
  }

  return {
    releaseVersion,
    summary: {
      pendingUnits: units.length,
      byLanguage,
      byRisk,
      sourceConflictCount,
      recentBatches: [...batches.values()]
        .sort((left, right) => right.batchId - left.batchId)
        .slice(0, 10),
    },
  }
}

function paginateReviewUnits(
  units: ReviewUnit[],
  filters: ReviewQueueFilters
): { items: ReviewUnit[]; nextCursor: string | null; limit: number } {
  const limit = Math.max(1, Math.min(filters.limit ?? 50, 200))
  const sorted = [...units].sort(compareReviewUnitOrder)
  const cursor = filters.cursor ? parseReviewUnitId(filters.cursor) : null
  const startIndex = cursor
    ? sorted.findIndex((unit) => compareReviewUnitOrder(unit, cursor) > 0)
    : 0
  const normalizedStartIndex = startIndex >= 0 ? startIndex : 0
  const items = sorted.slice(normalizedStartIndex, normalizedStartIndex + limit)
  const nextCursor = normalizedStartIndex + limit < sorted.length
    ? items[items.length - 1]?.unitId ?? null
    : null

  return { items, nextCursor, limit }
}

function buildReviewUnits(
  releaseDb: Database,
  updatesDb: Database,
  filters: Pick<ReviewQueueFilters, 'batchId' | 'lang' | 'risk' | 'shape' | 'hasSourceConflict'>
): ReviewUnit[] {
  const translations = listPendingAiTranslationUpdates(updatesDb, {
    batchId: filters.batchId ?? null,
    lang: filters.lang ?? null,
  })
  const exampleSets = listPendingAiExampleUpdateSets(updatesDb, {
    batchId: filters.batchId ?? null,
    lang: filters.lang ?? null,
  })

  const map = new Map<string, ReviewUnit>()

  for (const item of translations) {
    const unitId = makeReviewUnitId(item.wordId, item.lang as Language, item.batchId)
    const current = map.get(unitId)
    map.set(unitId, {
      unitId,
      wordId: item.wordId,
      lang: item.lang as Language,
      batchId: item.batchId,
      batch: item.batch,
      word: current?.word ?? getReleaseWordById(releaseDb, item.wordId),
      translation: item,
      exampleSet: current?.exampleSet ?? null,
      release: current?.release ?? getReleaseLayer(releaseDb, item.wordId, item.lang as Language),
      sourceUpdate: current?.sourceUpdate ?? {
        translation: getActiveTranslationUpdateBySourceType(updatesDb, item.wordId, item.lang, 'source'),
        examples: getActiveExampleUpdateSetBySourceType(updatesDb, item.wordId, item.lang, 'source'),
      },
      effectivePreview: current?.effectivePreview ?? null,
      flags: current?.flags ?? {
        hasSourceConflict: false,
        isSuperseded: false,
        hasTranslation: true,
        hasExamples: false,
        isTranslationOnly: true,
        isExamplesOnly: false,
      },
      riskLevel: current?.riskLevel ?? 'medium',
    })
  }

  for (const item of exampleSets) {
    const unitId = makeReviewUnitId(item.wordId, item.lang as Language, item.batchId)
    const current = map.get(unitId)
    map.set(unitId, {
      unitId,
      wordId: item.wordId,
      lang: item.lang as Language,
      batchId: item.batchId,
      batch: item.batch,
      word: current?.word ?? getReleaseWordById(releaseDb, item.wordId),
      translation: current?.translation ?? null,
      exampleSet: item,
      release: current?.release ?? getReleaseLayer(releaseDb, item.wordId, item.lang as Language),
      sourceUpdate: current?.sourceUpdate ?? {
        translation: getActiveTranslationUpdateBySourceType(updatesDb, item.wordId, item.lang, 'source'),
        examples: getActiveExampleUpdateSetBySourceType(updatesDb, item.wordId, item.lang, 'source'),
      },
      effectivePreview: current?.effectivePreview ?? null,
      flags: current?.flags ?? {
        hasSourceConflict: false,
        isSuperseded: false,
        hasTranslation: false,
        hasExamples: true,
        isTranslationOnly: false,
        isExamplesOnly: true,
      },
      riskLevel: current?.riskLevel ?? 'medium',
    })
  }

  const units = [...map.values()].map((unit) => {
    const flags: ReviewUnitFlags = {
      hasSourceConflict: Boolean(unit.sourceUpdate.translation || unit.sourceUpdate.examples),
      isSuperseded: Boolean(unit.translation && unit.translation.status !== 'active')
        || Boolean(unit.exampleSet && unit.exampleSet.status !== 'active'),
      hasTranslation: Boolean(unit.translation),
      hasExamples: Boolean(unit.exampleSet),
      isTranslationOnly: Boolean(unit.translation) && !unit.exampleSet,
      isExamplesOnly: Boolean(unit.exampleSet) && !unit.translation,
    }
    const riskLevel = computeRiskLevel({
      word: unit.word,
      release: unit.release,
      sourceUpdate: unit.sourceUpdate,
      translation: unit.translation,
      exampleSet: unit.exampleSet,
      flags,
    })

    return {
      ...unit,
      effectivePreview: pickEffectivePreview(unit.release, unit.sourceUpdate, unit.translation, unit.exampleSet),
      flags,
      riskLevel,
    }
  })

  return units.filter((unit) => {
    if (filters.risk && unit.riskLevel !== filters.risk) return false
    if (filters.shape === 'translation-only' && !unit.flags.isTranslationOnly) return false
    if (filters.shape === 'examples-only' && !unit.flags.isExamplesOnly) return false
    if (filters.hasSourceConflict !== null && filters.hasSourceConflict !== undefined) {
      return unit.flags.hasSourceConflict === filters.hasSourceConflict
    }
    return true
  })
}

export function getAdminSummary(): AdminSummaryResponse {
  const { db: releaseDb, version, mode } = openReleaseDb()
  const updatesDb = initUpdatesDatabase()

  const validWordIds = getValidWordIds(releaseDb)
  const verification = verifyUpdatesAgainstWordIds(updatesDb, validWordIds)
  const response: AdminSummaryResponse = {
    activeReleaseVersion: version,
    activeReleaseMode: mode,
    releaseWordCount: validWordIds.size,
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

export function getReviewQueue(filters: ReviewQueueFilters = {}): AdminReviewQueueResponseV2 {
  const { db: releaseDb, version } = openReleaseDb()
  const updatesDb = initUpdatesDatabase()
  const units = buildReviewUnits(releaseDb, updatesDb, {
    batchId: filters.batchId ?? null,
    lang: filters.lang ?? null,
    risk: filters.risk ?? null,
    shape: filters.shape ?? null,
    hasSourceConflict: filters.hasSourceConflict ?? null,
  })
  const summary = buildReviewQueueSummary(version, units)
  const page = paginateReviewUnits(units, filters)

  releaseDb.close()
  updatesDb.close()

  return {
    releaseVersion: version,
    summary: summary.summary,
    items: page.items,
    nextCursor: page.nextCursor,
    filters: {
      batchId: filters.batchId ?? null,
      lang: filters.lang ?? null,
      risk: filters.risk ?? null,
      shape: filters.shape ?? null,
      hasSourceConflict: filters.hasSourceConflict ?? null,
      limit: page.limit,
    },
  }
}

export function getReviewBatchSummary(batchId: number): AdminReviewBatchSummaryResponse {
  const { db: releaseDb, version } = openReleaseDb()
  const updatesDb = initUpdatesDatabase()
  const units = buildReviewUnits(releaseDb, updatesDb, {
    batchId,
    lang: null,
    risk: null,
    shape: null,
    hasSourceConflict: null,
  })

  const byLanguage: Record<string, number> = {}
  const byRisk: Record<ReviewRiskLevel, number> = { low: 0, medium: 0, high: 0 }
  let sourceConflictCount = 0
  let translationOnlyCount = 0
  let examplesOnlyCount = 0

  for (const unit of units) {
    byLanguage[unit.lang] = (byLanguage[unit.lang] || 0) + 1
    byRisk[unit.riskLevel] += 1
    if (unit.flags.hasSourceConflict) sourceConflictCount += 1
    if (unit.flags.isTranslationOnly) translationOnlyCount += 1
    if (unit.flags.isExamplesOnly) examplesOnlyCount += 1
  }

  const response: AdminReviewBatchSummaryResponse = {
    releaseVersion: version,
    batch: getUpdateBatch(updatesDb, batchId),
    pendingUnits: units.length,
    byLanguage,
    byRisk,
    sourceConflictCount,
    translationOnlyCount,
    examplesOnlyCount,
  }

  releaseDb.close()
  updatesDb.close()
  return response
}

export function getReviewBatchPage(
  batchId: number,
  filters: Omit<ReviewQueueFilters, 'batchId' | 'lang'>
): AdminReviewBatchPageResponse {
  const queue = getReviewQueue({
    batchId,
    lang: null,
    risk: filters.risk ?? null,
    shape: filters.shape ?? null,
    hasSourceConflict: filters.hasSourceConflict ?? null,
    cursor: filters.cursor ?? null,
    limit: filters.limit ?? null,
  })
  const summary = getReviewBatchSummary(batchId)

  return {
    releaseVersion: queue.releaseVersion,
    summary,
    items: queue.items,
    nextCursor: queue.nextCursor,
    filters: {
      risk: queue.filters.risk,
      shape: queue.filters.shape,
      hasSourceConflict: queue.filters.hasSourceConflict,
      limit: queue.filters.limit,
    },
  }
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

export function applyBulkReviewAction(
  action: 'approved' | 'rejected',
  input: BulkReviewActionRequest,
  actor: string
): BulkReviewActionResponse {
  const { db: releaseDb } = openReleaseDb()
  const updatesDb = initUpdatesDatabase()
  const requestedUnitIds = [...new Set(input.unitIds.map((item) => item.trim()).filter(Boolean))]

  if (requestedUnitIds.length === 0) {
    releaseDb.close()
    updatesDb.close()
    return {
      ok: false,
      action,
      affected: { units: 0, translations: 0, exampleSets: 0 },
      error: 'At least one review unit is required.',
    }
  }

  const units = buildReviewUnits(releaseDb, updatesDb, {
    batchId: null,
    lang: null,
    risk: null,
    shape: null,
    hasSourceConflict: null,
  }).filter((unit) => requestedUnitIds.includes(unit.unitId))

  if (units.length !== requestedUnitIds.length) {
    releaseDb.close()
    updatesDb.close()
    return {
      ok: false,
      action,
      affected: { units: 0, translations: 0, exampleSets: 0 },
      error: 'Some review units could not be found in the pending queue.',
    }
  }

  const batchIds = new Set(units.map((unit) => unit.batchId))
  const langs = new Set(units.map((unit) => unit.lang))
  if (batchIds.size > 1) {
    releaseDb.close()
    updatesDb.close()
    return {
      ok: false,
      action,
      affected: { units: 0, translations: 0, exampleSets: 0 },
      error: 'Bulk review cannot span multiple batches.',
    }
  }
  if (langs.size > 1) {
    releaseDb.close()
    updatesDb.close()
    return {
      ok: false,
      action,
      affected: { units: 0, translations: 0, exampleSets: 0 },
      error: 'Bulk review cannot span multiple languages.',
    }
  }

  const blockedUnitIds = action === 'approved' && !input.overrideSourceConflict
    ? units.filter((unit) => unit.flags.hasSourceConflict).map((unit) => unit.unitId)
    : []
  if (blockedUnitIds.length > 0) {
    releaseDb.close()
    updatesDb.close()
    return {
      ok: false,
      action,
      affected: { units: 0, translations: 0, exampleSets: 0 },
      blockedUnitIds,
      error: 'Some selected units have active source conflicts.',
    }
  }

  const translationIds = units.flatMap((unit) => unit.translation ? [unit.translation.id] : [])
  const exampleSetIds = units.flatMap((unit) => unit.exampleSet ? [unit.exampleSet.id] : [])
  const mutation = applyBulkReviewStatus(updatesDb, {
    translationIds,
    exampleSetIds,
    reviewStatus: action,
    actor,
    notes: input.notes ?? null,
  })

  recordAdminAction(updatesDb, {
    actor,
    action: action === 'approved' ? 'review.units.approve' : 'review.units.reject',
    targetKind: 'review-unit-bulk',
    targetId: requestedUnitIds.join(','),
    notes: input.notes ?? null,
  })

  for (const id of mutation.translationIds) {
    logReviewAction(
      updatesDb,
      actor,
      action === 'approved' ? 'review.translation.approve' : 'review.translation.reject',
      String(id),
      input.notes ?? null,
    )
  }
  for (const id of mutation.exampleSetIds) {
    logReviewAction(
      updatesDb,
      actor,
      action === 'approved' ? 'review.example-set.approve' : 'review.example-set.reject',
      String(id),
      input.notes ?? null,
    )
  }

  releaseDb.close()
  updatesDb.close()

  return {
    ok: true,
    action,
    affected: {
      units: units.length,
      translations: mutation.translationIds.length,
      exampleSets: mutation.exampleSetIds.length,
    },
  }
}

export function approveAllReviewUnitsInBatch(
  batchId: number,
  input: { notes?: string | null; overrideSourceConflict?: boolean; allowMultipleLanguages?: boolean },
  actor: string
): BulkReviewActionResponse {
  const { db: releaseDb } = openReleaseDb()
  const updatesDb = initUpdatesDatabase()
  const units = buildReviewUnits(releaseDb, updatesDb, {
    batchId,
    lang: null,
    risk: null,
    shape: null,
    hasSourceConflict: null,
  })

  if (units.length === 0) {
    releaseDb.close()
    updatesDb.close()
    return {
      ok: false,
      action: 'approved',
      affected: { units: 0, translations: 0, exampleSets: 0 },
      error: 'No pending review units found for this batch.',
    }
  }

  const langs = new Set(units.map((unit) => unit.lang))
  if (langs.size > 1 && !input.allowMultipleLanguages) {
    releaseDb.close()
    updatesDb.close()
    return {
      ok: false,
      action: 'approved',
      affected: { units: 0, translations: 0, exampleSets: 0 },
      error: 'Batch approval spans multiple languages. Use the explicit all-languages approval action.',
    }
  }

  const blockedUnitIds = input.overrideSourceConflict
    ? []
    : units.filter((unit) => unit.flags.hasSourceConflict).map((unit) => unit.unitId)
  if (blockedUnitIds.length > 0) {
    releaseDb.close()
    updatesDb.close()
    return {
      ok: false,
      action: 'approved',
      affected: { units: 0, translations: 0, exampleSets: 0 },
      blockedUnitIds,
      error: 'Some review units have active source conflicts.',
    }
  }

  const translationIds = units.flatMap((unit) => unit.translation ? [unit.translation.id] : [])
  const exampleSetIds = units.flatMap((unit) => unit.exampleSet ? [unit.exampleSet.id] : [])
  const mutation = applyBulkReviewStatus(updatesDb, {
    translationIds,
    exampleSetIds,
    reviewStatus: 'approved',
    actor,
    notes: input.notes ?? null,
  })

  recordAdminAction(updatesDb, {
    actor,
    action: langs.size > 1 && input.allowMultipleLanguages
      ? 'review.batch.approve_all_languages'
      : 'review.batch.approve_all',
    targetKind: 'batch',
    targetId: String(batchId),
    notes: input.notes ?? null,
  })

  for (const id of mutation.translationIds) {
    logReviewAction(updatesDb, actor, 'review.translation.approve', String(id), input.notes ?? null)
  }
  for (const id of mutation.exampleSetIds) {
    logReviewAction(updatesDb, actor, 'review.example-set.approve', String(id), input.notes ?? null)
  }

  releaseDb.close()
  updatesDb.close()

  return {
    ok: true,
    action: 'approved',
    affected: {
      units: units.length,
      translations: mutation.translationIds.length,
      exampleSets: mutation.exampleSetIds.length,
    },
  }
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
    seedLang: input.seedLang ?? defaults.seedLang,
    outputMode: input.outputMode ?? defaults.outputMode,
    model: input.model ?? defaults.model,
    limit: input.limit ?? defaults.limit,
    minFrequency: input.minFrequency ?? defaults.minFrequency,
    jlptMax: input.jlptMax ?? defaults.jlptMax,
    maxCostUsd: input.maxCostUsd ?? defaults.maxCostUsd,
    commonOnly: input.commonOnly ?? defaults.commonOnly,
    dryRun: input.dryRun ?? defaults.dryRun,
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
