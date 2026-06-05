import {
  getOrCreateYoriId,
  type IdRegistry,
} from '../../domain/ids'
import {
  detectJapaneseScript,
  normalizeJapaneseText,
  normalizeKana,
} from '../../domain/normalize'
import type {
  CanonicalSnapshot,
  Entry,
  Form,
  Gloss,
  LookupAlias,
  LookupAliasType,
  Reading,
  Sense,
  SourceRef,
  TargetLanguage,
} from '../../domain/types'

export interface JmdictKanji {
  text: string
  common?: boolean
  tags?: string[]
  priority?: string[]
}

export interface JmdictKana {
  text: string
  common?: boolean
  tags?: string[]
  priority?: string[]
  appliesToKanji?: string[] | 'all'
}

export interface JmdictGloss {
  lang?: string
  text: string
}

export interface JmdictSense {
  partOfSpeech?: string[]
  appliesToKanji?: string[] | 'all'
  appliesToKana?: string[] | 'all'
  field?: string[]
  misc?: string[]
  dialect?: string[]
  gloss?: JmdictGloss[]
}

export interface JmdictWord {
  id: string
  kanji?: JmdictKanji[]
  kana: JmdictKana[]
  sense: JmdictSense[]
}

export interface JmdictFile {
  version?: string
  words: JmdictWord[]
}

export interface JmdictConversionOptions {
  importedAt: string
  registry: IdRegistry
  license?: string
}

const SOURCE_KIND = 'jmdict'
const DEFAULT_LICENSE = 'CC-BY-SA-4.0'

const JM_TO_TARGET_LANG: Record<string, TargetLanguage> = {
  eng: 'en',
  en: 'en',
  ger: 'de',
  de: 'de',
  ko: 'ko',
  kor: 'ko',
  'zh-cn': 'zh-cn',
  'zh-tw': 'zh-tw',
}

function sourceRef(wordId: string, options: JmdictConversionOptions): SourceRef {
  return {
    kind: SOURCE_KIND,
    sourceId: wordId,
    license: options.license ?? DEFAULT_LICENSE,
    importedAt: options.importedAt,
  }
}

function sourceKey(word: JmdictWord, entity: string, suffix = ''): string {
  return `${SOURCE_KIND}:${word.id}:${entity}${suffix ? `:${suffix}` : ''}`
}

function normalizeStringList(value: string[] | undefined): string[] {
  return [...new Set((value ?? []).map((item) => item.trim()).filter(Boolean))]
}

function addToMultiMap(map: Map<string, string[]>, key: string, value: string): void {
  const values = map.get(key) ?? []
  values.push(value)
  map.set(key, values)
}

function choosePrimaryKanji(kanji: JmdictKanji[] | undefined): JmdictKanji | null {
  if (!kanji || kanji.length === 0) return null
  return kanji.find((item) => item.common) ?? kanji[0]
}

function choosePrimaryKana(kana: JmdictKana[]): JmdictKana {
  return kana.find((item) => item.common) ?? kana[0]
}

function buildForms(word: JmdictWord, options: JmdictConversionOptions): Form[] {
  const refs = [sourceRef(word.id, options)]
  const primaryKanji = choosePrimaryKanji(word.kanji)
  const rawForms = word.kanji && word.kanji.length > 0
    ? word.kanji
    : word.kana.map((kana) => ({
      text: kana.text,
      common: kana.common,
      tags: kana.tags,
      priority: kana.priority,
    }))

  return rawForms.map((form, formIndex) => {
    const text = normalizeJapaneseText(form.text)
    return {
      id: getOrCreateYoriId(options.registry, 'form', sourceKey(word, 'form', `${formIndex + 1}:${text}`)),
      text,
      normalizedText: normalizeJapaneseText(text),
      script: detectJapaneseScript(text),
      isPrimary: primaryKanji ? text === normalizeJapaneseText(primaryKanji.text) : text === normalizeJapaneseText(rawForms[0].text),
      tags: normalizeStringList(form.tags),
      sourceRefs: refs,
    }
  })
}

function resolveFormIds(
  restriction: string[] | 'all' | undefined,
  formsByText: Map<string, string[]>
): string[] | 'all' {
  if (!restriction || restriction === 'all' || restriction.length === 0) return 'all'

  const formIds = restriction
    .flatMap((text) => formsByText.get(normalizeJapaneseText(text)) ?? [])

  return formIds.length > 0 ? formIds : 'all'
}

function resolveReadingIds(
  restriction: string[] | 'all' | undefined,
  readingsByText: Map<string, string[]>
): string[] | 'all' {
  if (!restriction || restriction === 'all' || restriction.length === 0) return 'all'

  const readingIds = restriction
    .flatMap((text) => readingsByText.get(normalizeKana(text)) ?? [])

  return readingIds.length > 0 ? readingIds : 'all'
}

function buildReadings(
  word: JmdictWord,
  formsByText: Map<string, string[]>,
  options: JmdictConversionOptions
): Reading[] {
  const refs = [sourceRef(word.id, options)]
  const primaryKana = choosePrimaryKana(word.kana)

  return word.kana.map((kana, readingIndex) => {
    const text = normalizeKana(kana.text)
    return {
      id: getOrCreateYoriId(options.registry, 'reading', sourceKey(word, 'reading', `${readingIndex + 1}:${text}`)),
      text,
      normalizedText: normalizeKana(text),
      system: 'kana',
      isPrimary: text === normalizeKana(primaryKana.text),
      appliesToFormIds: resolveFormIds(kana.appliesToKanji, formsByText),
      tags: normalizeStringList(kana.tags),
      sourceRefs: refs,
    }
  })
}

function mapGlossLang(lang: string | undefined): TargetLanguage | null {
  if (!lang) return 'en'
  return JM_TO_TARGET_LANG[lang.toLowerCase()] ?? null
}

function buildGlosses(
  word: JmdictWord,
  senseId: string,
  senseIndex: number,
  sense: JmdictSense,
  options: JmdictConversionOptions
): Gloss[] {
  const refs = [sourceRef(word.id, options)]
  return (sense.gloss ?? [])
    .map((gloss, glossIndex): Gloss | null => {
      const text = gloss.text.trim()
      if (!text) return null
      const lang = mapGlossLang(gloss.lang)
      if (!lang) return null
      return {
        id: getOrCreateYoriId(
          options.registry,
          'gloss',
          sourceKey(word, 'gloss', `${senseIndex + 1}:${glossIndex + 1}:${lang}`)
        ),
        senseId,
        lang,
        text,
        sourceType: 'source',
        reviewStatus: 'approved',
        sourceRefs: refs,
      } satisfies Gloss
    })
    .filter((gloss): gloss is Gloss => gloss !== null)
}

function buildSenses(
  word: JmdictWord,
  entryId: string,
  formsByText: Map<string, string[]>,
  readingsByText: Map<string, string[]>,
  options: JmdictConversionOptions
): Sense[] {
  const refs = [sourceRef(word.id, options)]
  return word.sense.map((sense, senseIndex) => {
    const senseId = getOrCreateYoriId(options.registry, 'sense', sourceKey(word, 'sense', String(senseIndex + 1)))
    return {
      id: senseId,
      entryId,
      order: senseIndex + 1,
      partOfSpeech: normalizeStringList(sense.partOfSpeech),
      appliesToFormIds: resolveFormIds(sense.appliesToKanji, formsByText),
      appliesToReadingIds: resolveReadingIds(sense.appliesToKana, readingsByText),
      domain: normalizeStringList(sense.field),
      register: normalizeStringList(sense.dialect),
      misc: normalizeStringList(sense.misc),
      glosses: buildGlosses(word, senseId, senseIndex, sense, options),
      examples: [],
      sourceRefs: refs,
    }
  })
}

function buildAlias(
  word: JmdictWord,
  options: JmdictConversionOptions,
  aliasType: LookupAliasType,
  surface: string,
  entryId: string,
  score: number,
  reading?: string,
  formId?: string,
  readingId?: string
): LookupAlias {
  const normalizedSurface = aliasType === 'reading' || aliasType === 'kana'
    ? normalizeKana(surface)
    : normalizeJapaneseText(surface)
  const normalizedReading = reading ? normalizeKana(reading) : undefined
  return {
    id: getOrCreateYoriId(
      options.registry,
      'alias',
      sourceKey(word, 'alias', `${aliasType}:${normalizedSurface}:${normalizedReading ?? ''}`)
    ),
    surface,
    normalizedSurface,
    reading,
    normalizedReading,
    entryId,
    formId,
    readingId,
    aliasType,
    score,
  }
}

function dedupeAliases(aliases: LookupAlias[]): LookupAlias[] {
  const byKey = new Map<string, LookupAlias>()
  for (const alias of aliases) {
    const key = `${alias.normalizedSurface}\u0000${alias.normalizedReading ?? ''}\u0000${alias.entryId}`
    const existing = byKey.get(key)
    if (!existing || alias.score > existing.score) {
      byKey.set(key, alias)
    }
  }
  return [...byKey.values()].sort((left, right) => right.score - left.score || left.surface.localeCompare(right.surface, 'ja'))
}

function buildLookupAliases(
  word: JmdictWord,
  entry: Entry,
  options: JmdictConversionOptions
): LookupAlias[] {
  const aliases: LookupAlias[] = []
  const primaryReading = entry.readings.find((reading) => reading.isPrimary) ?? entry.readings[0]

  for (const form of entry.forms) {
    aliases.push(buildAlias(
      word,
      options,
      form.isPrimary ? 'dictionary' : 'variant',
      form.text,
      entry.id,
      form.isPrimary ? 100 : 80,
      primaryReading?.text,
      form.id,
      primaryReading?.id
    ))
  }

  for (const reading of entry.readings) {
    aliases.push(buildAlias(
      word,
      options,
      'reading',
      reading.text,
      entry.id,
      reading.isPrimary ? 75 : 65,
      reading.text,
      undefined,
      reading.id
    ))
  }

  return dedupeAliases(aliases)
}

export function convertJmdictWordToEntry(
  word: JmdictWord,
  options: JmdictConversionOptions
): { entry: Entry; lookupAliases: LookupAlias[] } {
  if (!word.id.trim()) throw new Error('JMdict word id is required')
  if (!word.kana || word.kana.length === 0) throw new Error(`JMdict word ${word.id} has no kana readings`)

  const entryId = getOrCreateYoriId(options.registry, 'entry', `${SOURCE_KIND}:${word.id}`)
  const forms = buildForms(word, options)
  const formsByText = new Map<string, string[]>()
  forms.forEach((form) => addToMultiMap(formsByText, form.normalizedText, form.id))
  const readings = buildReadings(word, formsByText, options)
  const readingsByText = new Map<string, string[]>()
  readings.forEach((reading) => addToMultiMap(readingsByText, reading.normalizedText, reading.id))
  const senses = buildSenses(word, entryId, formsByText, readingsByText, options)
  const primaryForm = forms.find((form) => form.isPrimary) ?? forms[0]
  const primaryReading = readings.find((reading) => reading.isPrimary) ?? readings[0]
  const priority = [
    ...(word.kanji ?? []).flatMap((kanji) => kanji.priority ?? []),
    ...word.kana.flatMap((kana) => kana.priority ?? []),
  ]

  const entry: Entry = {
    id: entryId,
    language: 'ja',
    entryType: 'word',
    primaryForm: primaryForm.text,
    primaryReading: primaryReading.text,
    forms,
    readings,
    senses,
    ranking: {
      common: Boolean((word.kanji ?? []).some((kanji) => kanji.common) || word.kana.some((kana) => kana.common)),
      priority: [...new Set(priority)],
    },
    sourceRefs: [sourceRef(word.id, options)],
  }

  return {
    entry,
    lookupAliases: buildLookupAliases(word, entry, options),
  }
}

export function convertJmdictToSnapshot(
  jmdict: JmdictFile,
  options: JmdictConversionOptions
): CanonicalSnapshot {
  const entries: Entry[] = []
  const lookupAliases: LookupAlias[] = []

  for (const word of jmdict.words) {
    const converted = convertJmdictWordToEntry(word, options)
    entries.push(converted.entry)
    lookupAliases.push(...converted.lookupAliases)
  }

  return {
    schemaVersion: '1.0.0',
    generatedAt: options.importedAt,
    entries,
    lookupAliases,
  }
}
