// Supported languages (canonical form used in DB/files/API responses)
export type Language = 'en' | 'de' | 'ko' | 'zh-cn' | 'zh-tw'

export const SUPPORTED_LANGUAGES: Language[] = ['en', 'de', 'ko', 'zh-cn', 'zh-tw']

const LANGUAGE_ALIASES: Record<string, Language> = {
  en: 'en',
  de: 'de',
  ko: 'ko',
  'zh-cn': 'zh-cn',
  'zh_cn': 'zh-cn',
  'zh-hans': 'zh-cn',
  'zh-tw': 'zh-tw',
  'zh_tw': 'zh-tw',
  'zh-hant': 'zh-tw',
}

export function normalizeLanguage(input: string): Language | null {
  const normalized = input.trim().toLowerCase()
  return LANGUAGE_ALIASES[normalized] ?? null
}

// API Response types
export interface Conjugations {
  dictionary: string
  polite: string
  negative: string
  past: string
  te: string
}

export interface Example {
  japanese: string
  translation: string
}

export interface LookupResponse {
  word: string
  reading: string
  romaji: string
  partOfSpeech: string[]
  definitions: string[]
  frequency?: number
  conjugations?: Conjugations
  examples: Example[]
}

export interface ErrorResponse {
  error: string
}

// Database row types
export interface WordRow {
  id: string
  word: string
  reading: string
  part_of_speech: string // JSON string array
  common: number
  jlpt: string | null // JSON string array of JLPT levels, e.g. "[5, 4]"
  frequency: number | null
}

export interface TranslationRow {
  word_id: string
  lang: string
  definitions: string // JSON string array
  sources: string // JSON string array of sources, e.g. '["jmdict", "manual"]'
}

export interface ExampleRow {
  id: number
  word_id: string
  lang: string
  japanese: string
  translation: string
  source: string
}

// Data source types
export type TranslationSource = 'jmdict' | 'wadoku' | 'krdict' | 'wiktionary' | 'kaikki' | 'ai'

// JMdict simplified types (for seed script)
export interface JMdictWord {
  id: string
  kanji?: { text: string; common?: boolean }[]
  kana: { text: string; common?: boolean }[]
  sense: {
    partOfSpeech: string[]
    gloss: { lang: string; text: string }[]
  }[]
}

// Verb types for conjugation
export type VerbType = 
  | 'ichidan'      // 一段動詞 (e.g., 食べる, 見る)
  | 'godan'        // 五段動詞 (e.g., 書く, 読む)
  | 'suru'         // する verb
  | 'kuru'         // 来る verb
  | 'i-adjective'  // い adjective
  | null           // Not conjugatable
