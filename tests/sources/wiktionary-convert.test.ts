import { describe, expect, test } from 'bun:test'
import { createEmptyIdRegistry } from '../../src/domain/ids'
import type { IdRegistry } from '../../src/domain/ids'
import { validateCanonicalSnapshot } from '../../src/domain/validate'
import { importWiktionaryGlossesIntoSnapshot } from '../../src/sources/wiktionary/convert'
import type { CanonicalSnapshot, SourceRef } from '../../src/domain/types'

const importedAt = '2026-06-04T00:00:00.000Z'

function sourceRef(sourceId: string): SourceRef {
  return {
    kind: 'jmdict',
    sourceId,
    license: 'CC-BY-SA-4.0',
    importedAt,
  }
}

function snapshot(): CanonicalSnapshot {
  const taberuRefs = [sourceRef('1358280')]
  const kamiRefs = [sourceRef('2000000')]
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
            sourceRefs: taberuRefs,
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
            sourceRefs: taberuRefs,
          },
        ],
        senses: [
          {
            id: 'yds_00000001',
            entryId: 'yde_00000001',
            order: 1,
            partOfSpeech: ['verb'],
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
                sourceRefs: taberuRefs,
              },
            ],
            examples: [],
            sourceRefs: taberuRefs,
          },
        ],
        ranking: { common: true },
        sourceRefs: taberuRefs,
      },
      {
        id: 'yde_00000002',
        language: 'ja',
        entryType: 'word',
        primaryForm: '紙',
        primaryReading: 'かみ',
        forms: [
          {
            id: 'ydf_00000002',
            text: '紙',
            normalizedText: '紙',
            script: 'kanji',
            isPrimary: true,
            tags: [],
            sourceRefs: kamiRefs,
          },
        ],
        readings: [
          {
            id: 'ydr_00000002',
            text: 'かみ',
            normalizedText: 'かみ',
            system: 'kana',
            isPrimary: true,
            appliesToFormIds: 'all',
            tags: [],
            sourceRefs: kamiRefs,
          },
        ],
        senses: [
          {
            id: 'yds_00000002',
            entryId: 'yde_00000002',
            order: 1,
            partOfSpeech: ['noun'],
            appliesToFormIds: 'all',
            appliesToReadingIds: 'all',
            domain: [],
            register: [],
            misc: [],
            glosses: [],
            examples: [],
            sourceRefs: kamiRefs,
          },
          {
            id: 'yds_00000003',
            entryId: 'yde_00000002',
            order: 2,
            partOfSpeech: ['suffix'],
            appliesToFormIds: 'all',
            appliesToReadingIds: 'all',
            domain: [],
            register: [],
            misc: [],
            glosses: [],
            examples: [],
            sourceRefs: kamiRefs,
          },
        ],
        ranking: {},
        sourceRefs: kamiRefs,
      },
    ],
    lookupAliases: [],
  }
}

function registry(): IdRegistry {
  const registry = createEmptyIdRegistry()
  registry.next.glosses = 2
  return registry
}

describe('importWiktionaryGlossesIntoSnapshot', () => {
  test('adds glosses to a unique matching entry sense', () => {
    const result = importWiktionaryGlossesIntoSnapshot(snapshot(), [
      {
        sourceId: 'kaikki:食べる',
        word: '食べる',
        reading: 'たべる',
        lang: 'zh-cn',
        pos: ['verb'],
        glosses: ['吃', '进食'],
      },
    ], {
      registry: registry(),
      importedAt,
    })

    expect(result.stats).toMatchObject({
      recordsProcessed: 1,
      recordsMatched: 1,
      glossesAdded: 2,
      entriesUpdated: 1,
    })
    expect(result.snapshot.entries[0].senses[0].glosses.slice(1)).toEqual([
      {
        id: 'ydg_00000002',
        senseId: 'yds_00000001',
        lang: 'zh-cn',
        text: '吃',
        sourceType: 'source',
        reviewStatus: 'approved',
        sourceRefs: [{ kind: 'wiktionary', sourceId: 'kaikki:食べる', license: 'CC-BY-SA-3.0', importedAt }],
      },
      {
        id: 'ydg_00000003',
        senseId: 'yds_00000001',
        lang: 'zh-cn',
        text: '进食',
        sourceType: 'source',
        reviewStatus: 'approved',
        sourceRefs: [{ kind: 'wiktionary', sourceId: 'kaikki:食べる', license: 'CC-BY-SA-3.0', importedAt }],
      },
    ])
    expect(validateCanonicalSnapshot(result.snapshot).valid).toBe(true)
  })

  test('uses direct entry and sense ids for ambiguous entries', () => {
    const result = importWiktionaryGlossesIntoSnapshot(snapshot(), [
      {
        id: 'wikt:paper',
        entryId: 'yde_00000002',
        senseId: 'yds_00000002',
        word: '紙',
        reading: 'かみ',
        lang: 'en',
        glosses: ['paper'],
      },
    ], {
      registry: registry(),
      importedAt,
    })

    expect(result.stats.glossesAdded).toBe(1)
    expect(result.snapshot.entries[1].senses[0].glosses[0]).toMatchObject({
      id: 'ydg_00000002',
      senseId: 'yds_00000002',
      lang: 'en',
      text: 'paper',
      sourceRefs: [{ kind: 'wiktionary', sourceId: 'wikt:paper' }],
    })
    expect(result.snapshot.entries[1].senses[1].glosses).toEqual([])
  })

  test('uses source sense order for multi-sense entries', () => {
    const result = importWiktionaryGlossesIntoSnapshot(snapshot(), [
      {
        sourceId: 'kaikki:紙:sense2',
        word: '紙',
        reading: 'かみ',
        lang: 'zh-tw',
        senseOrder: 2,
        glosses: ['後綴'],
      },
    ], {
      registry: registry(),
      importedAt,
    })

    expect(result.stats.glossesAdded).toBe(1)
    expect(result.snapshot.entries[1].senses[0].glosses).toEqual([])
    expect(result.snapshot.entries[1].senses[1].glosses[0]).toMatchObject({
      id: 'ydg_00000002',
      senseId: 'yds_00000003',
      lang: 'zh-tw',
      text: '後綴',
      sourceRefs: [{ kind: 'wiktionary', sourceId: 'kaikki:紙:sense2' }],
    })
  })

  test('skips ambiguous multi-sense entries without direct ids or pos match', () => {
    const result = importWiktionaryGlossesIntoSnapshot(snapshot(), [
      {
        sourceId: 'kaikki:紙',
        word: '紙',
        reading: 'かみ',
        lang: 'en',
        glosses: ['paper'],
      },
    ], {
      registry: registry(),
      importedAt,
    })

    expect(result.stats).toMatchObject({
      recordsProcessed: 1,
      recordsMatched: 1,
      glossesAdded: 0,
      entriesUpdated: 0,
    })
  })

  test('deduplicates glosses and respects per-sense limits', () => {
    const result = importWiktionaryGlossesIntoSnapshot(snapshot(), [
      {
        sourceId: 'kaikki:食べる',
        word: '食べる',
        reading: 'たべる',
        lang: 'zh-cn',
        pos: ['verb'],
        glosses: ['吃', '吃', '进食'],
      },
    ], {
      registry: registry(),
      importedAt,
      maxGlossesPerSense: 1,
    })

    expect(result.stats.glossesAdded).toBe(1)
    expect(result.snapshot.entries[0].senses[0].glosses.filter((gloss) => gloss.lang === 'zh-cn')).toHaveLength(1)
  })
})
