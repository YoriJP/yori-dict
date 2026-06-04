import { getOrCreateYoriId, type IdRegistry } from '../../domain/ids'
import { normalizeJapaneseText, normalizeKana } from '../../domain/normalize'
import type {
  CanonicalSnapshot,
  Entry,
  Example,
  Sense,
  SourceRef,
  TargetLanguage,
} from '../../domain/types'

export interface TatoebaExamplePair {
  id?: string
  japaneseId?: string
  translationId?: string
  entryId?: string
  senseId?: string
  japanese: string
  translation: string
  lang: TargetLanguage
}

export interface TatoebaImportOptions {
  registry: IdRegistry
  importedAt: string
  license?: string
  maxExamplesPerSense?: number
}

export interface TatoebaImportStats {
  pairsProcessed: number
  pairsMatched: number
  examplesAdded: number
  entriesUpdated: number
}

interface MatchTerm {
  value: string
  entry: Entry
  formId?: string
  readingId?: string
}

interface CandidateMatch {
  entry: Entry
  formId?: string
  readingId?: string
}

const SOURCE_KIND = 'tatoeba'
const DEFAULT_LICENSE = 'CC-BY 2.0 FR'
const DEFAULT_MAX_EXAMPLES_PER_SENSE = 3

function sourceRef(pair: TatoebaExamplePair, opts: TatoebaImportOptions): SourceRef {
  return {
    kind: SOURCE_KIND,
    sourceId: pair.id ?? pairSourceId(pair),
    license: opts.license ?? DEFAULT_LICENSE,
    importedAt: opts.importedAt,
  }
}

function pairSourceId(pair: TatoebaExamplePair): string {
  if (pair.japaneseId && pair.translationId) return `${pair.japaneseId}-${pair.translationId}`
  return `${pair.lang}:${pair.japanese}:${pair.translation}`
}

function sourceKey(pair: TatoebaExamplePair, entryId: string, senseId: string): string {
  return `${SOURCE_KIND}:${pairSourceId(pair)}:${entryId}:${senseId}:${pair.lang}`
}

function senseAppliesToMatch(sense: Sense, match: CandidateMatch): boolean {
  if (sense.appliesToFormIds !== 'all' && match.formId && !sense.appliesToFormIds.includes(match.formId)) {
    return false
  }
  if (sense.appliesToReadingIds !== 'all' && match.readingId && !sense.appliesToReadingIds.includes(match.readingId)) {
    return false
  }
  return true
}

function buildMatchTerms(snapshot: CanonicalSnapshot): Map<string, MatchTerm[]> {
  const byFirstChar = new Map<string, MatchTerm[]>()

  const addTerm = (value: string, term: Omit<MatchTerm, 'value'>): void => {
    if (value.length < 2) return
    const firstChar = value[0]
    const terms = byFirstChar.get(firstChar) ?? []
    terms.push({ value, ...term })
    byFirstChar.set(firstChar, terms)
  }

  for (const entry of snapshot.entries) {
    for (const form of entry.forms) {
      addTerm(normalizeJapaneseText(form.text), { entry, formId: form.id })
    }
    for (const reading of entry.readings) {
      addTerm(normalizeKana(reading.text), { entry, readingId: reading.id })
    }
  }

  for (const terms of byFirstChar.values()) {
    terms.sort((left, right) => right.value.length - left.value.length || left.value.localeCompare(right.value, 'ja'))
  }

  return byFirstChar
}

function findMatches(japanese: string, termsByFirstChar: Map<string, MatchTerm[]>): CandidateMatch[] {
  const normalizedText = normalizeJapaneseText(japanese)
  const normalizedKanaText = normalizeKana(japanese)
  const matches = new Map<string, CandidateMatch>()

  for (const firstChar of new Set([...normalizedText, ...normalizedKanaText])) {
    const terms = termsByFirstChar.get(firstChar)
    if (!terms) continue

    for (const term of terms) {
      const source = /[\u3040-\u309F]/.test(term.value) ? normalizedKanaText : normalizedText
      if (!source.includes(term.value)) continue

      const key = `${term.entry.id}\u0000${term.formId ?? ''}\u0000${term.readingId ?? ''}`
      if (!matches.has(key)) {
        matches.set(key, {
          entry: term.entry,
          formId: term.formId,
          readingId: term.readingId,
        })
      }
    }
  }

  return [...matches.values()]
}

function findDirectMatch(snapshot: CanonicalSnapshot, pair: TatoebaExamplePair): CandidateMatch[] {
  if (!pair.entryId || !pair.senseId) return []
  const entry = snapshot.entries.find((candidate) => candidate.id === pair.entryId)
  if (!entry || !entry.senses.some((sense) => sense.id === pair.senseId)) return []
  return [{ entry }]
}

function countExistingTatoebaExamples(sense: Sense, lang: TargetLanguage): number {
  return sense.examples.filter((example) =>
    example.lang === lang && example.sourceRefs.some((ref) => ref.kind === SOURCE_KIND)
  ).length
}

function hasExample(sense: Sense, pair: TatoebaExamplePair): boolean {
  return sense.examples.some((example) =>
    example.lang === pair.lang
    && example.japanese === pair.japanese
    && example.translation === pair.translation
  )
}

const LATIN_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'be',
  'i',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
])

const IRREGULAR_LATIN_TOKEN_BASES: Record<string, string> = {
  ate: 'eat',
  eaten: 'eat',
}

function addLatinTokenVariants(token: string, tokens: Set<string>): void {
  if (LATIN_STOP_WORDS.has(token) || token.length <= 1) return
  tokens.add(token)

  const irregular = IRREGULAR_LATIN_TOKEN_BASES[token]
  if (irregular) tokens.add(irregular)
  if (token.length > 4 && token.endsWith('ing')) tokens.add(token.slice(0, -3))
  if (token.length > 3 && token.endsWith('ed')) tokens.add(token.slice(0, -2))
  if (token.length > 3 && token.endsWith('s')) tokens.add(token.slice(0, -1))
}

function tokenizeForOverlap(text: string): string[] {
  const tokens = new Set<string>()
  for (const token of text.toLowerCase().match(/[\p{Letter}\p{Number}]+/gu) ?? []) {
    if (/^[a-z0-9]+$/.test(token)) {
      addLatinTokenVariants(token, tokens)
      continue
    }

    if (/[\u3400-\u9FFF\uAC00-\uD7AF]/.test(token)) {
      tokens.add(token)
      for (const char of token) {
        if (/[\u3400-\u9FFF\uAC00-\uD7AF]/.test(char)) tokens.add(char)
      }
      continue
    }

    if (token.length > 1) tokens.add(token)
  }
  return [...tokens]
}

function translationGlossOverlapScore(sense: Sense, pair: TatoebaExamplePair): number {
  const translationTokens = new Set(tokenizeForOverlap(pair.translation))
  if (translationTokens.size === 0) return 0

  let score = 0
  for (const gloss of sense.glosses) {
    if (gloss.lang !== pair.lang) continue
    for (const token of tokenizeForOverlap(gloss.text)) {
      if (translationTokens.has(token)) score++
    }
  }
  return score
}

function chooseTargetSenses(pair: TatoebaExamplePair, match: CandidateMatch): Sense[] {
  const applicable = match.entry.senses.filter((sense) => {
    if (pair.senseId && sense.id !== pair.senseId) return false
    return senseAppliesToMatch(sense, match)
  })

  if (pair.senseId || applicable.length <= 1) return applicable

  const scored = applicable.map((sense) => ({
    sense,
    score: translationGlossOverlapScore(sense, pair),
  }))
  const bestScore = Math.max(...scored.map((item) => item.score))
  if (bestScore <= 0) return []

  const best = scored.filter((item) => item.score === bestScore)
  return best.length === 1 ? [best[0].sense] : []
}

function buildExample(
  pair: TatoebaExamplePair,
  sense: Sense,
  entry: Entry,
  opts: TatoebaImportOptions
): Example {
  return {
    id: getOrCreateYoriId(opts.registry, 'example', sourceKey(pair, entry.id, sense.id)),
    senseId: sense.id,
    lang: pair.lang,
    japanese: pair.japanese.trim(),
    translation: pair.translation.trim(),
    sourceRefs: [sourceRef(pair, opts)],
  }
}

export function importTatoebaExamplesIntoSnapshot(
  snapshot: CanonicalSnapshot,
  pairs: TatoebaExamplePair[],
  opts: TatoebaImportOptions
): { snapshot: CanonicalSnapshot; stats: TatoebaImportStats } {
  const maxExamplesPerSense = opts.maxExamplesPerSense ?? DEFAULT_MAX_EXAMPLES_PER_SENSE
  const termsByFirstChar = buildMatchTerms(snapshot)
  const entriesUpdated = new Set<string>()
  const stats: TatoebaImportStats = {
    pairsProcessed: 0,
    pairsMatched: 0,
    examplesAdded: 0,
    entriesUpdated: 0,
  }

  for (const pair of pairs) {
    const japanese = normalizeJapaneseText(pair.japanese)
    const translation = pair.translation.trim()
    if (!japanese || !translation) continue

    stats.pairsProcessed++
    const matches = findDirectMatch(snapshot, pair)
    if (matches.length === 0) matches.push(...findMatches(japanese, termsByFirstChar))
    if (matches.length > 0) stats.pairsMatched++

    for (const match of matches) {
      for (const sense of chooseTargetSenses(pair, match)) {
        if (hasExample(sense, pair)) continue
        if (countExistingTatoebaExamples(sense, pair.lang) >= maxExamplesPerSense) continue

        sense.examples.push(buildExample({ ...pair, japanese, translation }, sense, match.entry, opts))
        entriesUpdated.add(match.entry.id)
        stats.examplesAdded++
      }
    }
  }

  return {
    snapshot: {
      ...snapshot,
      generatedAt: opts.importedAt,
    },
    stats: {
      ...stats,
      entriesUpdated: entriesUpdated.size,
    },
  }
}
