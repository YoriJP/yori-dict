import type { Language, LookupResponse } from '../types'
import type {
  DetailedExampleUpdateSet,
  DetailedTranslationUpdate,
  ListedExampleUpdateSet,
  ListedTranslationUpdate,
  UpdateBatchRecord,
  UpdateVerificationSummary,
} from '../update-store'
import type { ReleaseListItem } from '../release-service'
import type { ReleaseWordRecord } from '../storage'

export interface AdminSummaryResponse {
  activeReleaseVersion: string
  activeReleaseMode: string
  translationCounts: Record<string, number>
  exampleSetCounts: Record<string, number>
  reviewCounts: Record<string, number>
  releaseWordCount: number
  orphanedWordIdsCount: number
  activeReviewedAiCount: number
  recentBatches: UpdateBatchRecord[]
}

export interface AdminEntryInspectionResponse {
  releaseVersion: string
  query: {
    word: string
    lang: Language
  }
  word: {
    wordId: string
    word: string
    reading: string
    partOfSpeech: string[]
    frequency: number | null
  } | null
  release: {
    definitions: string[]
    sources: string[]
    examples: Array<{
      japanese: string
      translation: string
      source: string
    }>
  } | null
  sourceUpdate: {
    translation: DetailedTranslationUpdate | null
    examples: DetailedExampleUpdateSet | null
  }
  aiUpdate: {
    translation: DetailedTranslationUpdate | null
    examples: DetailedExampleUpdateSet | null
  }
  effective: LookupResponse | null
}

export interface AdminReviewQueueResponse {
  releaseVersion: string
  translations: ListedTranslationUpdate[]
  exampleSets: ListedExampleUpdateSet[]
}

export type ReviewRiskLevel = 'low' | 'medium' | 'high'
export type ReviewUnitShape = 'translation-only' | 'examples-only'

export interface ReviewUnitFlags {
  hasSourceConflict: boolean
  isSuperseded: boolean
  hasTranslation: boolean
  hasExamples: boolean
  isTranslationOnly: boolean
  isExamplesOnly: boolean
}

export interface ReviewUnitReleaseValue {
  definitions: string[]
  sources: string[]
  examples: Array<{
    japanese: string
    translation: string
    source: string
  }>
}

export interface ReviewUnit {
  unitId: string
  wordId: string
  lang: Language
  batchId: number
  batch: UpdateBatchRecord | null
  word: ReleaseWordRecord | null
  translation: ListedTranslationUpdate | null
  exampleSet: ListedExampleUpdateSet | null
  release: ReviewUnitReleaseValue | null
  sourceUpdate: {
    translation: DetailedTranslationUpdate | null
    examples: DetailedExampleUpdateSet | null
  }
  effectivePreview: ReviewUnitReleaseValue | null
  flags: ReviewUnitFlags
  riskLevel: ReviewRiskLevel
}

export interface ReviewQueueSummaryRecentBatch {
  batchId: number
  batch: UpdateBatchRecord | null
  pendingUnits: number
  sourceConflictCount: number
  byLanguage: Record<string, number>
}

export interface ReviewQueueSummary {
  pendingUnits: number
  byLanguage: Record<string, number>
  byRisk: Record<ReviewRiskLevel, number>
  sourceConflictCount: number
  recentBatches: ReviewQueueSummaryRecentBatch[]
}

export interface ReviewQueueFilters {
  batchId?: number | null
  lang?: Language | null
  risk?: ReviewRiskLevel | null
  shape?: ReviewUnitShape | null
  hasSourceConflict?: boolean | null
  cursor?: string | null
  limit?: number | null
}

export interface AdminReviewQueueResponseV2 {
  releaseVersion: string
  summary: ReviewQueueSummary
  items: ReviewUnit[]
  nextCursor: string | null
  filters: {
    batchId: number | null
    lang: Language | null
    risk: ReviewRiskLevel | null
    shape: ReviewUnitShape | null
    hasSourceConflict: boolean | null
    limit: number
  }
}

export interface AdminReviewBatchSummaryResponse {
  releaseVersion: string
  batch: UpdateBatchRecord | null
  pendingUnits: number
  byLanguage: Record<string, number>
  byRisk: Record<ReviewRiskLevel, number>
  sourceConflictCount: number
  translationOnlyCount: number
  examplesOnlyCount: number
}

export interface AdminReviewBatchPageResponse {
  releaseVersion: string
  summary: AdminReviewBatchSummaryResponse
  items: ReviewUnit[]
  nextCursor: string | null
  filters: {
    risk: ReviewRiskLevel | null
    shape: ReviewUnitShape | null
    hasSourceConflict: boolean | null
    limit: number
  }
}

export interface BulkReviewActionRequest {
  unitIds: string[]
  notes?: string | null
  overrideSourceConflict?: boolean
}

export interface BulkReviewActionResponse {
  ok: boolean
  action: 'approved' | 'rejected'
  affected: {
    units: number
    translations: number
    exampleSets: number
  }
  blockedUnitIds?: string[]
  error?: string
}

export interface AdminReleaseListResponse {
  activeReleaseVersion: string
  releases: ReleaseListItem[]
}

export interface AdminBatchDetailResponse {
  releaseVersion: string
  batch: UpdateBatchRecord | null
  translations: ListedTranslationUpdate[]
  exampleSets: ListedExampleUpdateSet[]
}

export interface AdminUpdatesResponse {
  releaseVersion: string
  translations: ListedTranslationUpdate[]
  exampleSets: ListedExampleUpdateSet[]
  verification: UpdateVerificationSummary
}

export interface AdminNewWordFormData {
  word: string
  reading: string
  partOfSpeech?: string[]
  common?: boolean
  jlpt?: number | null
  translations: Array<{
    lang: Language
    definitions: string[]
    examples?: Array<{
      japanese: string
      translation: string
    }>
  }>
}

export interface AdminNewWordValidationError {
  fieldErrors: Record<string, string[]>
  warnings: string[]
  similarEntries: Array<{
    wordId: string
    word: string
    reading: string
    match: 'word' | 'reading'
  }>
  conflictWordId?: string
}

export interface AdminNewWordResponse extends AdminNewWordValidationError {
  created: boolean
  wordId?: string
  snapshotFiles?: string[]
  releaseVersion: string
  activeReleaseContainsWord: boolean
  nextActions?: {
    buildReleaseUrl: string
    entryInspectorUrl: string
    releasesUrl: string
  }
}
