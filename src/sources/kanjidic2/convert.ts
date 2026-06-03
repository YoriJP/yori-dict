import { getOrCreateYoriId, type IdRegistry } from '../../domain/ids'
import type { KanjiCharacter, KanjiMeaning, KanjiReading, SourceRef, TargetLanguage } from '../../domain/types'

export interface Kanjidic2Meaning {
  lang?: string
  text: string
}

export interface Kanjidic2Reading {
  type: string
  text: string
}

export interface Kanjidic2Character {
  literal: string
  codepoint?: string
  meanings?: Kanjidic2Meaning[]
  readings?: Kanjidic2Reading[]
  grade?: number
  strokeCount?: number
  frequency?: number
  jlpt?: number
}

export interface Kanjidic2ConvertOptions {
  registry: IdRegistry
  importedAt: string
  license?: string
}

const LANGUAGE_ALIASES: Record<string, TargetLanguage> = {
  en: 'en',
  de: 'de',
  ko: 'ko',
  'zh-cn': 'zh-cn',
  'zh-tw': 'zh-tw',
}

const READING_TYPE_ALIASES: Record<string, KanjiReading['type']> = {
  ja_on: 'onyomi',
  onyomi: 'onyomi',
  on: 'onyomi',
  ja_kun: 'kunyomi',
  kunyomi: 'kunyomi',
  kun: 'kunyomi',
  nanori: 'nanori',
}

export function convertKanjidic2Character(
  character: Kanjidic2Character,
  opts: Kanjidic2ConvertOptions
): KanjiCharacter | null {
  const literal = character.literal.trim()
  if (!/^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]$/.test(literal)) return null

  const sourceId = character.codepoint ?? literal.codePointAt(0)?.toString(16)
  const sourceRefs: SourceRef[] = [
    {
      kind: 'kanjidic2',
      sourceId,
      license: opts.license ?? 'CC-BY-SA-4.0',
      importedAt: opts.importedAt,
    },
  ]

  const meanings: KanjiMeaning[] = []
  const seenMeanings = new Set<string>()
  for (const meaning of character.meanings ?? []) {
    const text = meaning.text.trim()
    const lang = LANGUAGE_ALIASES[(meaning.lang ?? 'en').toLowerCase()]
    if (!text || !lang) continue
    const key = `${lang}\u0000${text}`
    if (seenMeanings.has(key)) continue
    seenMeanings.add(key)
    meanings.push({ lang, text, sourceRefs })
  }

  const readings: KanjiReading[] = []
  const seenReadings = new Set<string>()
  for (const reading of character.readings ?? []) {
    const text = reading.text.trim()
    const type = READING_TYPE_ALIASES[reading.type.trim().toLowerCase()]
    if (!text || !type) continue
    const key = `${type}\u0000${text}`
    if (seenReadings.has(key)) continue
    seenReadings.add(key)
    readings.push({ type, text, sourceRefs })
  }

  return {
    id: getOrCreateYoriId(opts.registry, 'kanji', `kanjidic2:${literal}`),
    literal,
    meanings,
    readings,
    stats: {
      ...(character.grade ? { grade: character.grade } : {}),
      ...(character.strokeCount ? { strokeCount: character.strokeCount } : {}),
      ...(character.frequency ? { frequency: character.frequency } : {}),
      ...(character.jlpt ? { jlpt: character.jlpt } : {}),
    },
    sourceRefs,
  }
}

export function convertKanjidic2Characters(
  characters: Kanjidic2Character[],
  opts: Kanjidic2ConvertOptions
): KanjiCharacter[] {
  return characters
    .map((character) => convertKanjidic2Character(character, opts))
    .filter((character): character is KanjiCharacter => Boolean(character))
}
