import { getOrCreateYoriId, type IdRegistry } from '../../domain/ids'
import { normalizeJapaneseText, normalizeKana } from '../../domain/normalize'
import type {
  CanonicalSnapshot,
  Entry,
  Gloss,
  Sense,
  SourceRef,
  TargetLanguage,
} from '../../domain/types'

export interface WiktionaryGlossInput {
  id?: string
  sourceId?: string
  entryId?: string
  senseId?: string
  word: string
  reading?: string
  lang: TargetLanguage
  pos?: string[]
  glosses: string[]
}

export interface WiktionaryImportOptions {
  registry: IdRegistry
  importedAt: string
  license?: string
  maxGlossesPerSense?: number
}

export interface WiktionaryImportStats {
  recordsProcessed: number
  recordsMatched: number
  glossesAdded: number
  entriesUpdated: number
}

interface EntryMatch {
  entry: Entry
  sense?: Sense
}

const SOURCE_KIND = 'wiktionary'
const DEFAULT_LICENSE = 'CC-BY-SA-3.0'
const DEFAULT_MAX_GLOSSES_PER_SENSE = 8

function sourceRef(input: WiktionaryGlossInput, opts: WiktionaryImportOptions): SourceRef {
  return {
    kind: SOURCE_KIND,
    sourceId: input.sourceId ?? input.id ?? inputSourceId(input),
    license: opts.license ?? DEFAULT_LICENSE,
    importedAt: opts.importedAt,
  }
}

function inputSourceId(input: WiktionaryGlossInput): string {
  return `${input.lang}:${input.word}:${input.reading ?? ''}`
}

function sourceKey(input: WiktionaryGlossInput, entryId: string, senseId: string, index: number): string {
  return `${SOURCE_KIND}:${input.sourceId ?? input.id ?? inputSourceId(input)}:${entryId}:${senseId}:${input.lang}:${index + 1}`
}

function normalizePos(pos: string[] | undefined): string[] {
  return [...new Set((pos ?? []).map((value) => value.trim()).filter(Boolean))]
}

function buildEntryIndex(snapshot: CanonicalSnapshot): Map<string, Entry[]> {
  const index = new Map<string, Entry[]>()

  const add = (key: string, entry: Entry): void => {
    if (!key) return
    const entries = index.get(key) ?? []
    if (!entries.some((candidate) => candidate.id === entry.id)) entries.push(entry)
    index.set(key, entries)
  }

  for (const entry of snapshot.entries) {
    for (const form of entry.forms) {
      add(`form:${normalizeJapaneseText(form.text)}`, entry)
    }
    for (const reading of entry.readings) {
      add(`reading:${normalizeKana(reading.text)}`, entry)
    }
  }

  return index
}

function findEntryMatches(
  snapshot: CanonicalSnapshot,
  input: WiktionaryGlossInput,
  index: Map<string, Entry[]>
): EntryMatch[] {
  if (input.entryId) {
    const entry = snapshot.entries.find((candidate) => candidate.id === input.entryId)
    if (!entry) return []
    const sense = input.senseId ? entry.senses.find((candidate) => candidate.id === input.senseId) : undefined
    if (input.senseId && !sense) return []
    return [{ entry, sense }]
  }

  const word = normalizeJapaneseText(input.word)
  const reading = input.reading ? normalizeKana(input.reading) : undefined
  const wordMatches = index.get(`form:${word}`) ?? []
  const candidates = reading
    ? wordMatches.filter((entry) => entry.readings.some((candidate) => candidate.normalizedText === reading))
    : wordMatches

  if (candidates.length === 0 && reading) {
    const readingMatches = index.get(`reading:${reading}`) ?? []
    if (readingMatches.length === 1) return [{ entry: readingMatches[0] }]
  }

  if (candidates.length === 1) return [{ entry: candidates[0] }]
  return []
}

function posMatches(sense: Sense, pos: string[]): boolean {
  if (pos.length === 0) return false
  const sensePos = new Set(sense.partOfSpeech.map((value) => value.toLowerCase()))
  return pos.some((value) => sensePos.has(value.toLowerCase()))
}

function chooseTargetSenses(match: EntryMatch, input: WiktionaryGlossInput): Sense[] {
  if (match.sense) return [match.sense]

  const pos = normalizePos(input.pos)
  const posMatched = match.entry.senses.filter((sense) => posMatches(sense, pos))
  if (posMatched.length > 0) return posMatched

  return match.entry.senses.length === 1 ? [match.entry.senses[0]] : []
}

function countExistingWiktionaryGlosses(sense: Sense, lang: TargetLanguage): number {
  return sense.glosses.filter((gloss) =>
    gloss.lang === lang && gloss.sourceRefs.some((ref) => ref.kind === SOURCE_KIND)
  ).length
}

function hasGloss(sense: Sense, lang: TargetLanguage, text: string): boolean {
  return sense.glosses.some((gloss) => gloss.lang === lang && gloss.text === text)
}

function buildGloss(
  input: WiktionaryGlossInput,
  sense: Sense,
  entry: Entry,
  text: string,
  index: number,
  opts: WiktionaryImportOptions
): Gloss {
  return {
    id: getOrCreateYoriId(opts.registry, 'gloss', sourceKey(input, entry.id, sense.id, index)),
    senseId: sense.id,
    lang: input.lang,
    text,
    sourceType: 'source',
    reviewStatus: 'approved',
    sourceRefs: [sourceRef(input, opts)],
  }
}

export function importWiktionaryGlossesIntoSnapshot(
  snapshot: CanonicalSnapshot,
  inputs: WiktionaryGlossInput[],
  opts: WiktionaryImportOptions
): { snapshot: CanonicalSnapshot; stats: WiktionaryImportStats } {
  const maxGlossesPerSense = opts.maxGlossesPerSense ?? DEFAULT_MAX_GLOSSES_PER_SENSE
  const entryIndex = buildEntryIndex(snapshot)
  const entriesUpdated = new Set<string>()
  const stats: WiktionaryImportStats = {
    recordsProcessed: 0,
    recordsMatched: 0,
    glossesAdded: 0,
    entriesUpdated: 0,
  }

  for (const input of inputs) {
    const glosses = [...new Set(input.glosses.map((gloss) => gloss.trim()).filter(Boolean))]
    if (!normalizeJapaneseText(input.word) || glosses.length === 0) continue

    stats.recordsProcessed++
    const matches = findEntryMatches(snapshot, input, entryIndex)
    if (matches.length > 0) stats.recordsMatched++

    for (const match of matches) {
      const senses = chooseTargetSenses(match, input)
      for (const sense of senses) {
        let existingCount = countExistingWiktionaryGlosses(sense, input.lang)
        for (const [index, text] of glosses.entries()) {
          if (existingCount >= maxGlossesPerSense) break
          if (hasGloss(sense, input.lang, text)) continue

          sense.glosses.push(buildGloss(input, sense, match.entry, text, index, opts))
          entriesUpdated.add(match.entry.id)
          existingCount++
          stats.glossesAdded++
        }
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
