// Supported languages
export type Language = 'en' | 'zh-TW' | 'zh-CN' | 'de' | 'ko'

export const SUPPORTED_LANGUAGES: Language[] = ['en', 'zh-TW', 'zh-CN', 'de', 'ko']

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
export type TranslationSource = 'jmdict' | 'wadoku' | 'krdict' | 'wiktionary' | 'ai'

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
