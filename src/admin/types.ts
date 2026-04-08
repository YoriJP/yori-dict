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

export interface AdminSummaryResponse {
  activeReleaseVersion: string
  activeReleaseMode: string
  translationCounts: Record<string, number>
  exampleSetCounts: Record<string, number>
  reviewCounts: Record<string, number>
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
