import { describe, expect, test } from 'bun:test'
import { validateCanonicalSnapshot } from '../../src/domain/validate'
import type { CanonicalSnapshot, SourceRef } from '../../src/domain/types'

const importedAt = '2026-06-03T00:00:00.000Z'

function sourceRef(overrides: Partial<SourceRef> = {}): SourceRef {
  return {
    kind: 'jmdict',
    sourceId: '1358280',
    license: 'CC-BY-SA-4.0',
    importedAt,
    ...overrides,
  }
}

function validSnapshot(): CanonicalSnapshot {
  const sourceRefs = [sourceRef()]
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
            sourceRefs,
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
            sourceRefs,
          },
        ],
        senses: [
          {
            id: 'yds_00000001',
            entryId: 'yde_00000001',
            order: 1,
            partOfSpeech: ['ichidan verb', 'transitive verb'],
            appliesToFormIds: 'all',
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
                sourceRefs,
              },
            ],
            examples: [],
            sourceRefs,
          },
        ],
        ranking: { common: true },
        sourceRefs,
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

describe('validateCanonicalSnapshot', () => {
  test('accepts a minimal valid snapshot', () => {
    const result = validateCanonicalSnapshot(validSnapshot())
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  test('rejects aliases pointing at unknown entries', () => {
    const snapshot = validSnapshot()
    snapshot.lookupAliases[0].entryId = 'yde_99999999'

    const result = validateCanonicalSnapshot(snapshot)
    expect(result.valid).toBe(false)
    expect(result.errors.map((error) => error.path)).toContain('lookupAliases[0].entryId')
  })

  test('rejects broken reading form restrictions', () => {
    const snapshot = validSnapshot()
    snapshot.entries[0].readings[0].appliesToFormIds = ['ydf_99999999']

    const result = validateCanonicalSnapshot(snapshot)
    expect(result.valid).toBe(false)
    expect(result.errors.map((error) => error.path)).toContain('entries[0].readings[0].appliesToFormIds')
  })

  test('rejects duplicate nested ids', () => {
    const snapshot = validSnapshot()
    snapshot.entries[0].forms.push({
      ...snapshot.entries[0].forms[0],
      text: '喰べる',
      normalizedText: '喰べる',
    })
    snapshot.lookupAliases.push({
      ...snapshot.lookupAliases[0],
      surface: '喰べる',
      normalizedSurface: '喰べる',
    })

    const result = validateCanonicalSnapshot(snapshot)
    expect(result.valid).toBe(false)
    expect(result.errors.map((error) => error.path)).toContain('entries[0].forms[1].id')
    expect(result.errors.map((error) => error.path)).toContain('lookupAliases[1].id')
  })

  test('rejects glosses and examples nested under the wrong sense', () => {
    const snapshot = validSnapshot()
    const refs = [sourceRef()]
    snapshot.entries[0].senses.push({
      id: 'yds_00000002',
      entryId: 'yde_00000001',
      order: 2,
      partOfSpeech: ['n'],
      appliesToFormIds: 'all',
      appliesToReadingIds: 'all',
      domain: [],
      register: [],
      misc: [],
      glosses: [],
      examples: [],
      sourceRefs: refs,
    })
    snapshot.entries[0].senses[0].glosses[0].senseId = 'yds_00000002'
    snapshot.entries[0].senses[0].examples = [
      {
        id: 'ydx_00000001',
        senseId: 'yds_00000002',
        lang: 'en',
        japanese: '寿司を食べる。',
        translation: 'I eat sushi.',
        sourceRefs: refs,
      },
    ]

    const result = validateCanonicalSnapshot(snapshot)
    expect(result.valid).toBe(false)
    expect(result.errors.map((error) => error.path)).toContain('entries[0].senses[0].glosses[0].senseId')
    expect(result.errors.map((error) => error.path)).toContain('entries[0].senses[0].examples[0].senseId')
  })

  test('rejects aliases pointing at form or reading ids owned by another entry', () => {
    const snapshot = validSnapshot()
    const refs = [sourceRef({ sourceId: '2000000' })]
    snapshot.entries.push({
      id: 'yde_00000002',
      language: 'ja',
      entryType: 'word',
      primaryForm: '寿司',
      primaryReading: 'すし',
      forms: [
        {
          id: 'ydf_00000002',
          text: '寿司',
          normalizedText: '寿司',
          script: 'kanji',
          isPrimary: true,
          tags: [],
          sourceRefs: refs,
        },
      ],
      readings: [
        {
          id: 'ydr_00000002',
          text: 'すし',
          normalizedText: 'すし',
          system: 'kana',
          isPrimary: true,
          appliesToFormIds: 'all',
          tags: [],
          sourceRefs: refs,
        },
      ],
      senses: [
        {
          id: 'yds_00000002',
          entryId: 'yde_00000002',
          order: 1,
          partOfSpeech: ['n'],
          appliesToFormIds: 'all',
          appliesToReadingIds: 'all',
          domain: [],
          register: [],
          misc: [],
          glosses: [
            {
              id: 'ydg_00000002',
              senseId: 'yds_00000002',
              lang: 'en',
              text: 'sushi',
              sourceType: 'source',
              reviewStatus: 'approved',
              sourceRefs: refs,
            },
          ],
          examples: [],
          sourceRefs: refs,
        },
      ],
      ranking: {},
      sourceRefs: refs,
    })
    snapshot.lookupAliases[0].formId = 'ydf_00000002'
    snapshot.lookupAliases[0].readingId = 'ydr_00000002'

    const result = validateCanonicalSnapshot(snapshot)
    expect(result.valid).toBe(false)
    expect(result.errors.map((error) => error.path)).toContain('lookupAliases[0].formId')
    expect(result.errors.map((error) => error.path)).toContain('lookupAliases[0].readingId')
  })

  test('requires AI source refs to record the model', () => {
    const snapshot = validSnapshot()
    snapshot.entries[0].sourceRefs = [sourceRef({ kind: 'ai', model: undefined })]

    const result = validateCanonicalSnapshot(snapshot)
    expect(result.valid).toBe(false)
    expect(result.errors.map((error) => error.path)).toContain('entries[0].sourceRefs[0].model')
  })

  test('accepts valid kanji characters', () => {
    const snapshot = validSnapshot()
    const refs = [sourceRef({ kind: 'kanjidic2', sourceId: '98df' })]
    snapshot.kanjiCharacters = [
      {
        id: 'ydk_00000001',
        literal: '食',
        meanings: [{ lang: 'en', text: 'eat', sourceRefs: refs }],
        readings: [{ type: 'onyomi', text: 'ショク', sourceRefs: refs }],
        stats: { grade: 2, strokeCount: 9 },
        sourceRefs: refs,
      },
    ]

    const result = validateCanonicalSnapshot(snapshot)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  test('rejects invalid kanji literals', () => {
    const snapshot = validSnapshot()
    const refs = [sourceRef({ kind: 'kanjidic2', sourceId: '98df' })]
    snapshot.kanjiCharacters = [
      {
        id: 'ydk_00000001',
        literal: '食べる',
        meanings: [{ lang: 'en', text: 'eat', sourceRefs: refs }],
        readings: [{ type: 'onyomi', text: 'ショク', sourceRefs: refs }],
        stats: {},
        sourceRefs: refs,
      },
    ]

    const result = validateCanonicalSnapshot(snapshot)
    expect(result.valid).toBe(false)
    expect(result.errors.map((error) => error.path)).toContain('kanjiCharacters[0].literal')
  })
})
