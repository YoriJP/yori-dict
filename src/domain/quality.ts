import type { CanonicalSnapshot, Entry, SourceKind, TargetLanguage } from './types'

export type QualitySeverity = 'info' | 'warning' | 'error'

export interface QualityFinding {
  code: string
  severity: QualitySeverity
  message: string
  count: number
  samples: string[]
}

export interface QualityReport {
  generatedAt: string
  summary: {
    entries: number
    lookupAliases: number
    kanjiCharacters: number
    senses: number
    glosses: number
    examples: number
    sourceRefsByKind: Partial<Record<SourceKind, number>>
    glossesByLanguage: Partial<Record<TargetLanguage, number>>
  }
  findings: QualityFinding[]
}

export interface QualityOptions {
  aliasFanoutThreshold?: number
  sampleLimit?: number
  targetLanguages?: TargetLanguage[]
}

const DEFAULT_ALIAS_FANOUT_THRESHOLD = 20
const DEFAULT_SAMPLE_LIMIT = 10

interface FindingCollector {
  count: number
  samples: string[]
}

function collector(): FindingCollector {
  return { count: 0, samples: [] }
}

function addSample(finding: FindingCollector, sample: string, limit: number): void {
  finding.count += 1
  if (finding.samples.length >= limit) return
  finding.samples.push(sample)
}

function pushFinding(
  findings: QualityFinding[],
  code: string,
  severity: QualitySeverity,
  message: string,
  finding: FindingCollector
): void {
  if (finding.count === 0) return
  findings.push({
    code,
    severity,
    message,
    count: finding.count,
    samples: finding.samples,
  })
}

function entryLabel(entry: Entry): string {
  return `${entry.id} ${entry.primaryForm} (${entry.primaryReading})`
}

function hasGlosses(entry: Entry): boolean {
  return entry.senses.some((sense) => sense.glosses.length > 0)
}

function countSourceRefs(snapshot: CanonicalSnapshot): Partial<Record<SourceKind, number>> {
  const counts: Partial<Record<SourceKind, number>> = {}

  function count(kind: SourceKind): void {
    counts[kind] = (counts[kind] ?? 0) + 1
  }

  for (const entry of snapshot.entries) {
    entry.sourceRefs.forEach((source) => count(source.kind))
    entry.forms.forEach((form) => form.sourceRefs.forEach((source) => count(source.kind)))
    entry.readings.forEach((reading) => reading.sourceRefs.forEach((source) => count(source.kind)))
    for (const sense of entry.senses) {
      sense.sourceRefs.forEach((source) => count(source.kind))
      sense.glosses.forEach((gloss) => gloss.sourceRefs.forEach((source) => count(source.kind)))
      sense.examples.forEach((example) => example.sourceRefs.forEach((source) => count(source.kind)))
    }
  }

  for (const kanji of snapshot.kanjiCharacters ?? []) {
    kanji.sourceRefs.forEach((source) => count(source.kind))
    kanji.meanings.forEach((meaning) => meaning.sourceRefs.forEach((source) => count(source.kind)))
    kanji.readings.forEach((reading) => reading.sourceRefs.forEach((source) => count(source.kind)))
  }

  return counts
}

function countGlossesByLanguage(snapshot: CanonicalSnapshot): Partial<Record<TargetLanguage, number>> {
  const counts: Partial<Record<TargetLanguage, number>> = {}
  for (const entry of snapshot.entries) {
    for (const sense of entry.senses) {
      for (const gloss of sense.glosses) {
        counts[gloss.lang] = (counts[gloss.lang] ?? 0) + 1
      }
    }
  }
  return counts
}

export function analyzeCanonicalQuality(
  snapshot: CanonicalSnapshot,
  options: QualityOptions = {}
): QualityReport {
  const aliasFanoutThreshold = options.aliasFanoutThreshold ?? DEFAULT_ALIAS_FANOUT_THRESHOLD
  const sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT
  const findings: QualityFinding[] = []

  const entriesWithoutGlosses = collector()
  const entriesWithoutReadings = collector()
  const sensesWithoutGlosses = collector()
  const sensesWithoutPartOfSpeech = collector()
  const commonEntriesMissingDetailedRanking = collector()
  const duplicateAliases = collector()
  const aliasCollisions = collector()
  const aliasFanout = collector()
  const missingTargetGlossesByLanguage = new Map<TargetLanguage, FindingCollector>()

  const aliasKeys = new Map<string, string>()
  const aliasesByLookupKey = new Map<string, Set<string>>()

  for (const entry of snapshot.entries) {
    if (!hasGlosses(entry)) {
      addSample(entriesWithoutGlosses, entryLabel(entry), sampleLimit)
    }
    if (entry.readings.length === 0) {
      addSample(entriesWithoutReadings, entryLabel(entry), sampleLimit)
    }
    if (
      entry.ranking.common === true
      && entry.ranking.frequency === undefined
      && (entry.ranking.priority?.length ?? 0) === 0
    ) {
      addSample(commonEntriesMissingDetailedRanking, entryLabel(entry), sampleLimit)
    }

    for (const sense of entry.senses) {
      const label = `${entryLabel(entry)} sense ${sense.order}`
      if (sense.glosses.length === 0) addSample(sensesWithoutGlosses, label, sampleLimit)
      if (sense.partOfSpeech.length === 0) addSample(sensesWithoutPartOfSpeech, label, sampleLimit)

      for (const lang of options.targetLanguages ?? []) {
        const hasTargetGloss = sense.glosses.some((gloss) =>
          gloss.lang === lang && gloss.reviewStatus === 'approved' && Boolean(gloss.text.trim())
        )
        const hasSourceGloss = sense.glosses.some((gloss) =>
          gloss.lang !== lang && gloss.reviewStatus === 'approved' && Boolean(gloss.text.trim())
        )
        if (hasTargetGloss || !hasSourceGloss) continue

        const finding = missingTargetGlossesByLanguage.get(lang) ?? collector()
        addSample(finding, `${label} missing ${lang} gloss`, sampleLimit)
        missingTargetGlossesByLanguage.set(lang, finding)
      }
    }
  }

  for (const alias of snapshot.lookupAliases) {
    const lookupKey = `${alias.normalizedSurface}\u0000${alias.normalizedReading ?? ''}`
    const entryAliasKey = `${lookupKey}\u0000${alias.entryId}`
    const existingAlias = aliasKeys.get(entryAliasKey)
    if (existingAlias) {
      addSample(duplicateAliases, `${entryAliasKey} duplicated by ${existingAlias} and ${alias.id}`, sampleLimit)
    } else {
      aliasKeys.set(entryAliasKey, alias.id)
    }

    const entryIds = aliasesByLookupKey.get(lookupKey) ?? new Set<string>()
    entryIds.add(alias.entryId)
    aliasesByLookupKey.set(lookupKey, entryIds)
  }

  for (const [lookupKey, entryIds] of aliasesByLookupKey.entries()) {
    if (entryIds.size > 1) {
      const [surface, reading] = lookupKey.split('\u0000')
      addSample(aliasCollisions, `${surface}${reading ? ` / ${reading}` : ''} -> ${entryIds.size} entries`, sampleLimit)
    }
    if (entryIds.size > aliasFanoutThreshold) {
      const [surface, reading] = lookupKey.split('\u0000')
      addSample(aliasFanout, `${surface}${reading ? ` / ${reading}` : ''} -> ${entryIds.size} entries`, sampleLimit)
    }
  }

  pushFinding(
    findings,
    'entries_without_glosses',
    'warning',
    'Entries without any gloss cannot produce useful dictionary definitions.',
    entriesWithoutGlosses
  )
  pushFinding(
    findings,
    'entries_without_readings',
    'error',
    'Entries without readings are difficult to resolve from tokenizer output.',
    entriesWithoutReadings
  )
  pushFinding(
    findings,
    'senses_without_glosses',
    'warning',
    'Senses without glosses may be source artifacts or incomplete product data.',
    sensesWithoutGlosses
  )
  pushFinding(
    findings,
    'senses_without_part_of_speech',
    'info',
    'Senses without part-of-speech tags are harder to rank and display.',
    sensesWithoutPartOfSpeech
  )
  pushFinding(
    findings,
    'common_entries_missing_detailed_ranking',
    'info',
    'Common entries should ideally include priority or frequency signals for stable ranking.',
    commonEntriesMissingDetailedRanking
  )
  pushFinding(
    findings,
    'duplicate_aliases',
    'error',
    'Duplicate aliases point the same lookup key at the same entry more than once.',
    duplicateAliases
  )
  pushFinding(
    findings,
    'alias_collisions',
    'info',
    'The same lookup key points to multiple entries. This can be valid, but should be monitored.',
    aliasCollisions
  )
  pushFinding(
    findings,
    'alias_fanout',
    'warning',
    'A lookup key points to many entries and may create noisy lookup results.',
    aliasFanout
  )

  for (const [lang, finding] of missingTargetGlossesByLanguage.entries()) {
    pushFinding(
      findings,
      `senses_missing_${lang}_glosses`,
      'warning',
      `Senses with source glosses but no approved ${lang} gloss need curation.`,
      finding
    )
  }

  let senses = 0
  let glosses = 0
  let examples = 0
  for (const entry of snapshot.entries) {
    senses += entry.senses.length
    for (const sense of entry.senses) {
      glosses += sense.glosses.length
      examples += sense.examples.length
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      entries: snapshot.entries.length,
      lookupAliases: snapshot.lookupAliases.length,
      kanjiCharacters: snapshot.kanjiCharacters?.length ?? 0,
      senses,
      glosses,
      examples,
      sourceRefsByKind: countSourceRefs(snapshot),
      glossesByLanguage: countGlossesByLanguage(snapshot),
    },
    findings,
  }
}
