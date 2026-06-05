export type YoriLanguage = 'ja'

export type TargetLanguage = 'en' | 'de' | 'ko' | 'zh-cn' | 'zh-tw'

export type EntryType = 'word' | 'phrase' | 'proper_noun'

export type ScriptType = 'kanji' | 'kana' | 'katakana' | 'mixed'

export type SourceKind =
  | 'jmdict'
  | 'jmnedict'
  | 'kanjidic2'
  | 'wiktionary'
  | 'tatoeba'
  | 'manual'
  | 'ai'

export type ReviewStatus = 'unreviewed' | 'approved' | 'rejected'

export interface SourceRef {
  kind: SourceKind
  sourceId?: string
  license?: string
  importedAt: string
  model?: string
  promptVersion?: string
  inputRefs?: string[]
  reviewStatus?: ReviewStatus
}

export interface RankingSignals {
  common?: boolean
  frequency?: number
  jlpt?: number
  priority?: string[]
}

export interface KanjiStats {
  grade?: number
  strokeCount?: number
  frequency?: number
  jlpt?: number
}

export interface PitchAccent {
  value: string
  sourceRefs: SourceRef[]
}

export interface Form {
  id: string
  text: string
  normalizedText: string
  script: ScriptType
  isPrimary: boolean
  tags: string[]
  sourceRefs: SourceRef[]
}

export interface Reading {
  id: string
  text: string
  normalizedText: string
  system: 'kana'
  isPrimary: boolean
  appliesToFormIds: string[] | 'all'
  pitchAccent?: PitchAccent[]
  tags: string[]
  sourceRefs: SourceRef[]
}

export interface Gloss {
  id: string
  senseId: string
  lang: TargetLanguage
  text: string
  sourceType: 'source' | 'manual' | 'ai'
  reviewStatus: ReviewStatus
  sourceRefs: SourceRef[]
}

export interface Example {
  id: string
  senseId?: string
  lang: TargetLanguage
  japanese: string
  translation: string
  sourceRefs: SourceRef[]
}

export interface Sense {
  id: string
  entryId: string
  order: number
  partOfSpeech: string[]
  appliesToFormIds: string[] | 'all'
  appliesToReadingIds: string[] | 'all'
  domain: string[]
  register: string[]
  misc: string[]
  glosses: Gloss[]
  examples: Example[]
  sourceRefs: SourceRef[]
}

export interface Entry {
  id: string
  language: YoriLanguage
  entryType: EntryType
  primaryForm: string
  primaryReading: string
  forms: Form[]
  readings: Reading[]
  senses: Sense[]
  ranking: RankingSignals
  sourceRefs: SourceRef[]
}

export type LookupAliasType =
  | 'dictionary'
  | 'variant'
  | 'kana'
  | 'reading'
  | 'normalized'

export interface LookupAlias {
  id: string
  surface: string
  normalizedSurface: string
  reading?: string
  normalizedReading?: string
  entryId: string
  formId?: string
  readingId?: string
  aliasType: LookupAliasType
  score: number
}

export interface KanjiMeaning {
  lang: TargetLanguage
  text: string
  sourceRefs: SourceRef[]
}

export interface KanjiReading {
  type: 'onyomi' | 'kunyomi' | 'nanori'
  text: string
  sourceRefs: SourceRef[]
}

export interface KanjiCharacter {
  id: string
  literal: string
  meanings: KanjiMeaning[]
  readings: KanjiReading[]
  stats: KanjiStats
  sourceRefs: SourceRef[]
}

export interface CanonicalSnapshot {
  schemaVersion: '1.0.0'
  generatedAt: string
  entries: Entry[]
  lookupAliases: LookupAlias[]
  kanjiCharacters?: KanjiCharacter[]
}
