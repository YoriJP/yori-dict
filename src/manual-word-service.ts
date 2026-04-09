import {
  addLangDefinition,
  createEmptyLangEntry,
  isDefinitionArtifact,
  loadCore,
  loadLang,
  makeKey,
  sanitizeDefinitionText,
  saveCore,
  saveLang,
} from '../scripts/import/base'
import { SUPPORTED_LANGUAGES, normalizeLanguage, type Language } from './types'

const DATA_DIR = './data'
const LANG_DIR = `${DATA_DIR}/lang`
const CORE_PATH = `${DATA_DIR}/core.json`

const READING_REGEX = /^[\p{Script=Hiragana}\p{Script=Katakana}々ー・\s]+$/u

export interface ManualWordExampleInput {
  japanese: string
  translation: string
}

export interface ManualWordTranslationInput {
  lang: Language
  definitions: string[]
  examples?: ManualWordExampleInput[]
}

export interface ManualWordInput {
  word: string
  reading: string
  partOfSpeech?: string[]
  common?: boolean
  jlpt?: number | null
  translations: ManualWordTranslationInput[]
}

export interface SimilarManualWordEntry {
  wordId: string
  word: string
  reading: string
  match: 'word' | 'reading'
}

export interface ManualWordValidationError {
  fieldErrors: Record<string, string[]>
  warnings: string[]
  similarEntries: SimilarManualWordEntry[]
  conflictWordId?: string
}

export interface ManualWordCreateSuccess {
  created: true
  wordId: string
  snapshotFiles: string[]
  warnings: string[]
  similarEntries: SimilarManualWordEntry[]
  coreCreated: boolean
}

export interface ManualWordCreateOptions {
  allowExistingWordId?: boolean
  allowDefinitionlessTranslations?: boolean
}

export type ManualWordCreateResult =
  | ManualWordCreateSuccess
  | ({ created: false } & ManualWordValidationError)

interface NormalizedManualWordInput {
  word: string
  reading: string
  partOfSpeech: string[]
  common: boolean
  jlpt: number | null
  translations: Array<{
    lang: Language
    definitions: string[]
    examples: Array<{ japanese: string; translation: string }>
  }>
}

function pushFieldError(
  fieldErrors: Record<string, string[]>,
  key: string,
  message: string
): void {
  fieldErrors[key] = [...(fieldErrors[key] ?? []), message]
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function normalizeDefinitions(
  rawDefinitions: string[],
  fieldErrors: Record<string, string[]>,
  fieldPath: string
): string[] {
  const cleaned: string[] = []

  for (const raw of rawDefinitions) {
    const sanitized = sanitizeDefinitionText(String(raw ?? ''))
    if (!sanitized) continue
    if (sanitized.length > 300) {
      pushFieldError(fieldErrors, fieldPath, 'Definition must be 300 characters or fewer.')
      continue
    }
    if (isDefinitionArtifact(sanitized)) continue
    cleaned.push(sanitized)
  }

  return dedupeStrings(cleaned.map((value) => value.trim()))
}

function normalizeExamples(
  rawExamples: ManualWordExampleInput[] | undefined,
  fieldErrors: Record<string, string[]>,
  fieldPath: string
): Array<{ japanese: string; translation: string }> {
  if (!rawExamples) return []

  const results: Array<{ japanese: string; translation: string }> = []
  const seen = new Set<string>()

  for (const [index, raw] of rawExamples.entries()) {
    const japanese = String(raw?.japanese ?? '').trim()
    const translation = String(raw?.translation ?? '').trim()

    if (!japanese && !translation) continue

    if (!japanese || !translation) {
      pushFieldError(fieldErrors, `${fieldPath}[${index}]`, 'Example japanese and translation are both required.')
      continue
    }
    if (japanese.length > 300) {
      pushFieldError(fieldErrors, `${fieldPath}[${index}].japanese`, 'Example japanese must be 300 characters or fewer.')
      continue
    }
    if (translation.length > 500) {
      pushFieldError(fieldErrors, `${fieldPath}[${index}].translation`, 'Example translation must be 500 characters or fewer.')
      continue
    }

    const dedupeKey = `${japanese}\u0000${translation}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    results.push({ japanese, translation })
  }

  if (results.length > 20) {
    pushFieldError(fieldErrors, fieldPath, 'Each language may contain at most 20 examples.')
    return results.slice(0, 20)
  }

  return results
}

function normalizeManualWordInput(
  input: ManualWordInput,
  options: ManualWordCreateOptions = {}
): {
  normalized: NormalizedManualWordInput | null
  fieldErrors: Record<string, string[]>
} {
  const fieldErrors: Record<string, string[]> = {}

  const word = String(input.word ?? '').trim()
  const reading = String(input.reading ?? '').trim()

  if (!word) {
    pushFieldError(fieldErrors, 'word', 'Word is required.')
  } else {
    if (word.length > 100) pushFieldError(fieldErrors, 'word', 'Word must be 100 characters or fewer.')
    if (word.includes('\n')) pushFieldError(fieldErrors, 'word', 'Word must not contain newlines.')
  }

  if (!reading) {
    pushFieldError(fieldErrors, 'reading', 'Reading is required.')
  } else {
    if (reading.length > 100) pushFieldError(fieldErrors, 'reading', 'Reading must be 100 characters or fewer.')
    if (reading.includes('\n')) pushFieldError(fieldErrors, 'reading', 'Reading must not contain newlines.')
    if (!READING_REGEX.test(reading)) {
      pushFieldError(fieldErrors, 'reading', 'Reading must use Japanese reading characters only.')
    }
  }

  const partOfSpeech = dedupeStrings(
    (input.partOfSpeech ?? [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean)
  )

  if (partOfSpeech.length > 10) {
    pushFieldError(fieldErrors, 'partOfSpeech', 'Part of speech accepts at most 10 values.')
  }
  for (const value of partOfSpeech) {
    if (value.length > 50) {
      pushFieldError(fieldErrors, 'partOfSpeech', 'Each part of speech must be 50 characters or fewer.')
      break
    }
  }

  let jlpt: number | null = null
  if (input.jlpt !== undefined && input.jlpt !== null) {
    const parsedJlpt = Number(input.jlpt)
    if (!Number.isInteger(parsedJlpt) || parsedJlpt < 1 || parsedJlpt > 5) {
      pushFieldError(fieldErrors, 'jlpt', 'JLPT must be an integer from 1 to 5.')
    } else {
      jlpt = parsedJlpt
    }
  }

  const rawTranslations = Array.isArray(input.translations) ? input.translations : []
  if (rawTranslations.length === 0) {
    pushFieldError(fieldErrors, 'translations', 'At least one translation row is required.')
  }

  const normalizedTranslations: NormalizedManualWordInput['translations'] = []
  const seenLangs = new Set<Language>()

  rawTranslations.forEach((rawTranslation, index) => {
    const fieldPath = `translations[${index}]`
    const lang = normalizeLanguage(String(rawTranslation?.lang ?? ''))
    if (!lang) {
      pushFieldError(fieldErrors, `${fieldPath}.lang`, 'Language must be one of en, de, ko, zh-cn, zh-tw.')
      return
    }
    if (seenLangs.has(lang)) {
      pushFieldError(fieldErrors, 'translations', 'Languages must not be duplicated.')
      return
    }
    seenLangs.add(lang)

    const definitions = normalizeDefinitions(rawTranslation?.definitions ?? [], fieldErrors, `${fieldPath}.definitions`)
    if (definitions.length === 0 && !options.allowDefinitionlessTranslations) {
      pushFieldError(fieldErrors, `${fieldPath}.definitions`, 'At least one valid definition is required for each language.')
    }

    const examples = normalizeExamples(rawTranslation?.examples, fieldErrors, `${fieldPath}.examples`)

    normalizedTranslations.push({
      lang,
      definitions,
      examples,
    })
  })

  if (normalizedTranslations.length === 0) {
    pushFieldError(fieldErrors, 'translations', 'At least one valid translation row is required.')
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { normalized: null, fieldErrors }
  }

  return {
    normalized: {
      word,
      reading,
      partOfSpeech,
      common: Boolean(input.common),
      jlpt,
      translations: normalizedTranslations,
    },
    fieldErrors,
  }
}

async function findSimilarEntries(word: string, reading: string): Promise<SimilarManualWordEntry[]> {
  const core = await loadCore(CORE_PATH)
  const results: SimilarManualWordEntry[] = []

  for (const [wordId, entry] of Object.entries(core.entries)) {
    if (entry.word === word && entry.reading === reading) continue
    if (entry.word === word) {
      results.push({ wordId, word: entry.word, reading: entry.reading, match: 'word' })
    } else if (entry.reading === reading) {
      results.push({ wordId, word: entry.word, reading: entry.reading, match: 'reading' })
    }
  }

  return results.slice(0, 10)
}

export async function createManualWordInSnapshot(
  input: ManualWordInput,
  options: ManualWordCreateOptions = {}
): Promise<ManualWordCreateResult> {
  const { normalized, fieldErrors } = normalizeManualWordInput(input, options)
  if (!normalized) {
    return {
      created: false,
      fieldErrors,
      warnings: [],
      similarEntries: [],
    }
  }

  const core = await loadCore(CORE_PATH)
  const wordId = makeKey(normalized.word, normalized.reading)
  const similarEntries = await findSimilarEntries(normalized.word, normalized.reading)
  const warnings: string[] = []

  if (normalized.partOfSpeech.length === 0) {
    warnings.push('Part of speech is empty.')
  }
  if (normalized.translations.every((row) => row.examples.length === 0)) {
    warnings.push('No examples were provided.')
  }
  if (similarEntries.length > 0) {
    warnings.push('Found existing entries with the same word or reading.')
  }

  const existingCoreEntry = core.entries[wordId]
  if (existingCoreEntry && !options.allowExistingWordId) {
    return {
      created: false,
      fieldErrors: {
        wordId: [`Word ID already exists: ${wordId}`],
      },
      warnings,
      similarEntries,
      conflictWordId: wordId,
    }
  }

  const langFiles = new Map<Language, Awaited<ReturnType<typeof loadLang>>>()
  for (const translation of normalized.translations) {
    const langPath = `${LANG_DIR}/${translation.lang}.json`
    langFiles.set(translation.lang, await loadLang(langPath, translation.lang))
  }

  if (!existingCoreEntry) {
    core.entries[wordId] = {
      word: normalized.word,
      reading: normalized.reading,
      partOfSpeech: normalized.partOfSpeech,
      common: normalized.common,
      jlpt: normalized.jlpt,
      frequency: null,
    }
  } else {
    existingCoreEntry.word = normalized.word
    existingCoreEntry.reading = normalized.reading
    existingCoreEntry.partOfSpeech = dedupeStrings([
      ...existingCoreEntry.partOfSpeech,
      ...normalized.partOfSpeech,
    ])
    if (normalized.common) existingCoreEntry.common = true
    if (normalized.jlpt !== null) {
      existingCoreEntry.jlpt = existingCoreEntry.jlpt === null
        ? normalized.jlpt
        : Math.max(existingCoreEntry.jlpt, normalized.jlpt)
    }
  }

  for (const translation of normalized.translations) {
    const langFile = langFiles.get(translation.lang)
    if (!langFile) continue

    if (!langFile.entries[wordId]) {
      langFile.entries[wordId] = createEmptyLangEntry()
    }

    const langEntry = langFile.entries[wordId]
    for (const definition of translation.definitions) {
      addLangDefinition(langEntry, definition, 'manual')
    }

    for (const example of translation.examples) {
      const exists = langEntry.examples.some(
        (item) => item.ja === example.japanese && item.text === example.translation && item.source === 'manual'
      )
      if (!exists) {
        langEntry.examples.push({
          ja: example.japanese,
          text: example.translation,
          source: 'manual',
        })
      }
    }
  }

  const sortedLangs = [...langFiles.keys()].sort(
    (a, b) => SUPPORTED_LANGUAGES.indexOf(a) - SUPPORTED_LANGUAGES.indexOf(b)
  )

  const snapshotFiles = [
    ...sortedLangs.map((lang) => `${LANG_DIR}/${lang}.json`),
    CORE_PATH,
  ]

  for (const lang of sortedLangs) {
    const langFile = langFiles.get(lang)
    if (langFile) {
      await saveLang(`${LANG_DIR}/${lang}.json`, langFile)
    }
  }
  await saveCore(CORE_PATH, core)

  return {
    created: true,
    wordId,
    snapshotFiles,
    warnings,
    similarEntries,
    coreCreated: !existingCoreEntry,
  }
}
