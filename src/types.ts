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
