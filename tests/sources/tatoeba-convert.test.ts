import { describe, expect, test } from 'bun:test'
import { createEmptyIdRegistry } from '../../src/domain/ids'
import { validateCanonicalSnapshot } from '../../src/domain/validate'
import { importTatoebaExamplesIntoSnapshot } from '../../src/sources/tatoeba/convert'
import type { CanonicalSnapshot, SourceRef } from '../../src/domain/types'

const importedAt = '2026-06-03T00:00:00.000Z'

function sourceRef(sourceId: string): SourceRef {
  return {
    kind: 'jmdict',
    sourceId,
    license: 'CC-BY-SA-4.0',
    importedAt,
  }
}

function snapshot(): CanonicalSnapshot {
  const refs = [sourceRef('1358280')]
  return {
    schemaVersion: '1.0.0',
    generatedAt: importedAt,
    entries: [
      {
        id: 'yde_00000001',
        language: 'ja',
        entryType: 'word',
        primaryForm: '食べる',
        primaryReading: 'たべる',
        forms: [
          {
            id: 'ydf_00000001',
            text: '食べる',
            normalizedText: '食べる',
            script: 'mixed',
            isPrimary: true,
            tags: [],
            sourceRefs: refs,
          },
          {
            id: 'ydf_00000002',
            text: '喰べる',
            normalizedText: '喰べる',
            script: 'mixed',
            isPrimary: false,
            tags: [],
            sourceRefs: refs,
          },
        ],
        readings: [
          {
            id: 'ydr_00000001',
            text: 'たべる',
            normalizedText: 'たべる',
            system: 'kana',
            isPrimary: true,
            appliesToFormIds: 'all',
            tags: [],
            sourceRefs: refs,
          },
        ],
        senses: [
          {
            id: 'yds_00000001',
            entryId: 'yde_00000001',
            order: 1,
            partOfSpeech: ['v1'],
            appliesToFormIds: ['ydf_00000001'],
            appliesToReadingIds: 'all',
            domain: [],
            register: [],
            misc: [],
            glosses: [
              {
                id: 'ydg_00000001',
                senseId: 'yds_00000001',
                lang: 'en',
                text: 'to eat',
                sourceType: 'source',
                reviewStatus: 'approved',
                sourceRefs: refs,
              },
            ],
            examples: [],
            sourceRefs: refs,
          },
          {
            id: 'yds_00000002',
            entryId: 'yde_00000001',
            order: 2,
            partOfSpeech: ['v1'],
            appliesToFormIds: ['ydf_00000002'],
            appliesToReadingIds: 'all',
            domain: [],
            register: [],
            misc: [],
            glosses: [
              {
                id: 'ydg_00000002',
                senseId: 'yds_00000002',
                lang: 'en',
                text: 'to eat in a rough way',
                sourceType: 'source',
                reviewStatus: 'approved',
                sourceRefs: refs,
              },
            ],
            examples: [],
            sourceRefs: refs,
          },
        ],
        ranking: { common: true },
        sourceRefs: refs,
      },
    ],
    lookupAliases: [
      {
        id: 'yda_00000001',
        surface: '食べる',
        normalizedSurface: '食べる',
        reading: 'たべる',
        normalizedReading: 'たべる',
        entryId: 'yde_00000001',
        formId: 'ydf_00000001',
        readingId: 'ydr_00000001',
        aliasType: 'dictionary',
        score: 100,
      },
    ],
  }
}

describe('importTatoebaExamplesIntoSnapshot', () => {
  test('adds matched examples to senses that match form restrictions', () => {
    const result = importTatoebaExamplesIntoSnapshot(snapshot(), [
      {
        japaneseId: '100',
        translationId: '200',
        japanese: '寿司を喰べる。',
        translation: 'I eat sushi.',
        lang: 'en',
      },
    ], {
      registry: createEmptyIdRegistry(),
      importedAt,
    })

    expect(result.stats).toMatchObject({
      pairsProcessed: 1,
      pairsMatched: 1,
      examplesAdded: 1,
      entriesUpdated: 1,
    })
    expect(result.snapshot.entries[0].senses[0].examples).toEqual([])
    expect(result.snapshot.entries[0].senses[1].examples[0]).toMatchObject({
      id: 'ydx_00000001',
      senseId: 'yds_00000002',
      lang: 'en',
      japanese: '寿司を喰べる。',
      translation: 'I eat sushi.',
      sourceRefs: [{ kind: 'tatoeba', sourceId: '100-200' }],
    })
    expect(validateCanonicalSnapshot(result.snapshot).valid).toBe(true)
  })

  test('supports direct entry and sense ids for pre-matched examples', () => {
    const result = importTatoebaExamplesIntoSnapshot(snapshot(), [
      {
        id: 'tatoeba:direct:1',
        entryId: 'yde_00000001',
        senseId: 'yds_00000001',
        japanese: '昨日、寿司を食べました。',
        translation: 'I ate sushi yesterday.',
        lang: 'en',
      },
    ], {
      registry: createEmptyIdRegistry(),
      importedAt,
    })

    expect(result.snapshot.entries[0].senses[0].examples[0]).toMatchObject({
      id: 'ydx_00000001',
      senseId: 'yds_00000001',
      japanese: '昨日、寿司を食べました。',
      translation: 'I ate sushi yesterday.',
      sourceRefs: [{ kind: 'tatoeba', sourceId: 'tatoeba:direct:1' }],
    })
    expect(result.snapshot.entries[0].senses[1].examples).toEqual([])
  })

  test('uses translation gloss overlap to avoid broad multi-sense attachment', () => {
    const source = snapshot()
    source.entries[0].senses[1].appliesToFormIds = 'all'
    source.entries[0].senses[1].glosses[0].text = 'to live on a salary'

    const result = importTatoebaExamplesIntoSnapshot(source, [
      {
        japaneseId: '8878337',
        translationId: '7114453',
        japanese: '食べることが大好きなんです。',
        translation: 'I love to eat.',
        lang: 'en',
      },
    ], {
      registry: createEmptyIdRegistry(),
      importedAt,
    })

    expect(result.stats).toMatchObject({
      pairsProcessed: 1,
      pairsMatched: 1,
      examplesAdded: 1,
      entriesUpdated: 1,
    })
    expect(result.snapshot.entries[0].senses[0].examples).toHaveLength(1)
    expect(result.snapshot.entries[0].senses[1].examples).toEqual([])
  })

  test('deduplicates examples and respects per-sense limits', () => {
    const result = importTatoebaExamplesIntoSnapshot(snapshot(), [
      {
        japaneseId: '100',
        translationId: '200',
        japanese: '寿司を食べる。',
        translation: 'I eat sushi.',
        lang: 'en',
      },
      {
        japaneseId: '100',
        translationId: '200',
        japanese: '寿司を食べる。',
        translation: 'I eat sushi.',
        lang: 'en',
      },
      {
        japaneseId: '101',
        translationId: '201',
        japanese: '魚を食べる。',
        translation: 'I eat fish.',
        lang: 'en',
      },
    ], {
      registry: createEmptyIdRegistry(),
      importedAt,
      maxExamplesPerSense: 1,
    })

    expect(result.stats.examplesAdded).toBe(1)
    expect(result.snapshot.entries[0].senses[0].examples).toHaveLength(1)
  })
})
