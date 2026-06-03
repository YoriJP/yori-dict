import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildCanonicalRelease } from '../../scripts/pipeline/build-canonical-release'
import { CanonicalLookupService } from '../../src/runtime/canonical-lookup'
import type { CanonicalSnapshot, SourceRef } from '../../src/domain/types'

const tempDirs: string[] = []
const importedAt = '2026-06-03T00:00:00.000Z'

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yori-canonical-lookup-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

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
  const sushiRefs = [sourceRef('2000000')]
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
          {
            id: 'ydf_00000002',
            text: '喰べる',
            normalizedText: '喰べる',
            script: 'mixed',
            isPrimary: false,
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
            partOfSpeech: ['v1', 'vt'],
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
              {
                id: 'ydg_00000002',
                senseId: 'yds_00000001',
                lang: 'zh-tw',
                text: '吃',
                sourceType: 'manual',
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
        primaryForm: '寿司',
        primaryReading: 'すし',
        forms: [
          {
            id: 'ydf_00000003',
            text: '寿司',
            normalizedText: '寿司',
            script: 'kanji',
            isPrimary: true,
            tags: [],
            sourceRefs: sushiRefs,
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
            sourceRefs: sushiRefs,
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
                id: 'ydg_00000003',
                senseId: 'yds_00000002',
                lang: 'en',
                text: 'sushi',
                sourceType: 'source',
                reviewStatus: 'approved',
                sourceRefs: sushiRefs,
              },
            ],
            examples: [],
            sourceRefs: sushiRefs,
          },
        ],
        ranking: { common: true },
        sourceRefs: sushiRefs,
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
      {
        id: 'yda_00000002',
        surface: '喰べる',
        normalizedSurface: '喰べる',
        reading: 'たべる',
        normalizedReading: 'たべる',
        entryId: 'yde_00000001',
        formId: 'ydf_00000002',
        readingId: 'ydr_00000001',
        aliasType: 'variant',
        score: 80,
      },
      {
        id: 'yda_00000003',
        surface: 'たべる',
        normalizedSurface: 'たべる',
        reading: 'たべる',
        normalizedReading: 'たべる',
        entryId: 'yde_00000001',
        readingId: 'ydr_00000001',
        aliasType: 'reading',
        score: 75,
      },
      {
        id: 'yda_00000004',
        surface: '寿司',
        normalizedSurface: '寿司',
        reading: 'すし',
        normalizedReading: 'すし',
        entryId: 'yde_00000002',
        formId: 'ydf_00000003',
        readingId: 'ydr_00000002',
        aliasType: 'dictionary',
        score: 100,
      },
    ],
  }
}

async function buildService(sourceSnapshot: CanonicalSnapshot = snapshot()): Promise<{ db: Database; service: CanonicalLookupService }> {
  const dir = makeTempDir()
  const snapshotPath = join(dir, 'snapshot.json')
  const dbPath = join(dir, 'release.sqlite')
  await Bun.write(snapshotPath, JSON.stringify(sourceSnapshot))
  await buildCanonicalRelease({ snapshot: snapshotPath, out: dbPath, overwrite: false })
  const db = new Database(dbPath, { readonly: true })
  return { db, service: new CanonicalLookupService(db) }
}

describe('CanonicalLookupService', () => {
  test('looks up by dictionary surface', async () => {
    const { db, service } = await buildService()
    try {
      const result = service.lookup({ query: '食べる', lang: 'en' })
      expect(result.matched).toMatchObject({ surface: '食べる', matchType: 'dictionary' })
      expect(result.entries).toEqual([
        {
          id: 'yde_00000001',
          word: '食べる',
          reading: 'たべる',
          pos: ['v1', 'vt'],
          definitions: ['to eat'],
        },
      ])
    } finally {
      db.close()
    }
  })

  test('looks up by variant surface', async () => {
    const { db, service } = await buildService()
    try {
      const result = service.lookup({ query: '喰べる', lang: 'zh-tw' })
      expect(result.matched).toMatchObject({ surface: '喰べる', matchType: 'variant' })
      expect(result.entries[0]).toMatchObject({
        id: 'yde_00000001',
        definitions: ['吃'],
      })
    } finally {
      db.close()
    }
  })

  test('uses lemma before surface for tokenized input', async () => {
    const tokenizedSnapshot = snapshot()
    const refs = [sourceRef('3000000')]
    tokenizedSnapshot.entries.push({
      id: 'yde_00000003',
      language: 'ja',
      entryType: 'word',
      primaryForm: '食べました',
      primaryReading: 'たべました',
      forms: [
        {
          id: 'ydf_00000004',
          text: '食べました',
          normalizedText: '食べました',
          script: 'mixed',
          isPrimary: true,
          tags: [],
          sourceRefs: refs,
        },
      ],
      readings: [
        {
          id: 'ydr_00000003',
          text: 'たべました',
          normalizedText: 'たべました',
          system: 'kana',
          isPrimary: true,
          appliesToFormIds: 'all',
          tags: [],
          sourceRefs: refs,
        },
      ],
      senses: [
        {
          id: 'yds_00000003',
          entryId: 'yde_00000003',
          order: 1,
          partOfSpeech: ['exp'],
          appliesToFormIds: 'all',
          appliesToReadingIds: 'all',
          domain: [],
          register: [],
          misc: [],
          glosses: [
            {
              id: 'ydg_00000004',
              senseId: 'yds_00000003',
              lang: 'en',
              text: 'surface-only entry',
              sourceType: 'source',
              reviewStatus: 'approved',
              sourceRefs: refs,
            },
          ],
          examples: [],
          sourceRefs: refs,
        },
      ],
      ranking: { common: true, priority: ['ichi1'] },
      sourceRefs: refs,
    })
    tokenizedSnapshot.lookupAliases.push({
      id: 'yda_00000005',
      surface: '食べました',
      normalizedSurface: '食べました',
      reading: 'たべました',
      normalizedReading: 'たべました',
      entryId: 'yde_00000003',
      formId: 'ydf_00000004',
      readingId: 'ydr_00000003',
      aliasType: 'dictionary',
      score: 100,
    })

    const { db, service } = await buildService(tokenizedSnapshot)
    try {
      const result = service.lookup({
        surface: '食べました',
        lemma: '食べる',
        reading: 'タベマシタ',
        lang: 'en',
      })
      expect(result.matched).toMatchObject({ surface: '食べる', matchType: 'dictionary' })
      expect(result.entries[0]?.word).toBe('食べる')
    } finally {
      db.close()
    }
  })

  test('looks up by kana reading', async () => {
    const { db, service } = await buildService()
    try {
      const result = service.lookup({ query: 'スシ', lang: 'en' })
      expect(result.matched).toMatchObject({ surface: '寿司', matchType: 'dictionary' })
      expect(result.entries[0]?.definitions).toEqual(['sushi'])
    } finally {
      db.close()
    }
  })

  test('returns empty entries when target language has no glosses', async () => {
    const { db, service } = await buildService()
    try {
      const result = service.lookup({ query: '寿司', lang: 'zh-tw' })
      expect(result.matched).toBeNull()
      expect(result.entries).toEqual([])
    } finally {
      db.close()
    }
  })

  test('filters senses by matched form and reading restrictions', async () => {
    const restrictedSnapshot = snapshot()
    const refs = [sourceRef('restricted')]
    restrictedSnapshot.entries[0].senses = [
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
            text: 'standard spelling definition',
            sourceType: 'source',
            reviewStatus: 'approved',
            sourceRefs: refs,
          },
        ],
        examples: [],
        sourceRefs: refs,
      },
      {
        id: 'yds_00000003',
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
            id: 'ydg_00000004',
            senseId: 'yds_00000003',
            lang: 'en',
            text: 'variant spelling definition',
            sourceType: 'source',
            reviewStatus: 'approved',
            sourceRefs: refs,
          },
        ],
        examples: [],
        sourceRefs: refs,
      },
    ]

    const { db, service } = await buildService(restrictedSnapshot)
    try {
      const standard = service.lookup({ query: '食べる', lang: 'en' })
      const variant = service.lookup({ query: '喰べる', lang: 'en' })

      expect(standard.entries[0]?.definitions).toEqual(['standard spelling definition'])
      expect(variant.entries[0]?.definitions).toEqual(['variant spelling definition'])
    } finally {
      db.close()
    }
  })

  test('uses ranking signals to order entries with the same alias score', async () => {
    const rankedSnapshot = snapshot()
    const refs = [sourceRef('3000000')]
    rankedSnapshot.entries.push({
      id: 'yde_00000003',
      language: 'ja',
      entryType: 'word',
      primaryForm: '寿司',
      primaryReading: 'すし',
      forms: [
        {
          id: 'ydf_00000004',
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
          id: 'ydr_00000003',
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
          id: 'yds_00000003',
          entryId: 'yde_00000003',
          order: 1,
          partOfSpeech: ['n'],
          appliesToFormIds: 'all',
          appliesToReadingIds: 'all',
          domain: [],
          register: [],
          misc: [],
          glosses: [
            {
              id: 'ydg_00000004',
              senseId: 'yds_00000003',
              lang: 'en',
              text: 'less common sushi entry',
              sourceType: 'source',
              reviewStatus: 'approved',
              sourceRefs: refs,
            },
          ],
          examples: [],
          sourceRefs: refs,
        },
      ],
      ranking: { common: false },
      sourceRefs: refs,
    })
    rankedSnapshot.lookupAliases.push({
      id: 'yda_00000005',
      surface: '寿司',
      normalizedSurface: '寿司',
      reading: 'すし',
      normalizedReading: 'すし',
      entryId: 'yde_00000003',
      formId: 'ydf_00000004',
      readingId: 'ydr_00000003',
      aliasType: 'dictionary',
      score: 100,
    })

    const { db, service } = await buildService(rankedSnapshot)
    try {
      const result = service.lookup({ query: '寿司', lang: 'en', limit: 2 })
      expect(result.entries.map((entry) => entry.id)).toEqual(['yde_00000002', 'yde_00000003'])
    } finally {
      db.close()
    }
  })

  test('ranks high-fanout aliases before applying the response limit', async () => {
    const refs = [sourceRef('high-fanout')]
    const highFanoutSnapshot: CanonicalSnapshot = {
      schemaVersion: '1.0.0',
      generatedAt: importedAt,
      entries: Array.from({ length: 520 }, (_, index) => {
        const number = index + 1
        const id = `yde_${String(number).padStart(8, '0')}`
        const formId = `ydf_${String(number).padStart(8, '0')}`
        const readingId = `ydr_${String(number).padStart(8, '0')}`
        const senseId = `yds_${String(number).padStart(8, '0')}`
        const glossId = `ydg_${String(number).padStart(8, '0')}`
        return {
          id,
          language: 'ja',
          entryType: 'word',
          primaryForm: `候補${number}`,
          primaryReading: 'こう',
          forms: [
            {
              id: formId,
              text: `候補${number}`,
              normalizedText: `候補${number}`,
              script: 'mixed',
              isPrimary: true,
              tags: [],
              sourceRefs: refs,
            },
          ],
          readings: [
            {
              id: readingId,
              text: 'こう',
              normalizedText: 'こう',
              system: 'kana',
              isPrimary: true,
              appliesToFormIds: 'all',
              tags: [],
              sourceRefs: refs,
            },
          ],
          senses: [
            {
              id: senseId,
              entryId: id,
              order: 1,
              partOfSpeech: ['n'],
              appliesToFormIds: 'all',
              appliesToReadingIds: 'all',
              domain: [],
              register: [],
              misc: [],
              glosses: [
                {
                  id: glossId,
                  senseId,
                  lang: 'en',
                  text: number === 520 ? 'best ranked entry' : `lower ranked entry ${number}`,
                  sourceType: 'source',
                  reviewStatus: 'approved',
                  sourceRefs: refs,
                },
              ],
              examples: [],
              sourceRefs: refs,
            },
          ],
          ranking: number === 520 ? { common: true, priority: ['ichi1'] } : {},
          sourceRefs: refs,
        } satisfies CanonicalSnapshot['entries'][number]
      }),
      lookupAliases: Array.from({ length: 520 }, (_, index) => {
        const number = index + 1
        return {
          id: `yda_${String(number).padStart(8, '0')}`,
          surface: 'こう',
          normalizedSurface: 'こう',
          reading: 'こう',
          normalizedReading: 'こう',
          entryId: `yde_${String(number).padStart(8, '0')}`,
          readingId: `ydr_${String(number).padStart(8, '0')}`,
          aliasType: 'reading',
          score: 75,
        }
      }),
    }

    const { db, service } = await buildService(highFanoutSnapshot)
    try {
      const result = service.lookup({ query: 'こう', lang: 'en', limit: 1 })
      expect(result.entries.map((entry) => entry.id)).toEqual(['yde_00000520'])
      expect(result.entries[0]?.definitions).toEqual(['best ranked entry'])
    } finally {
      db.close()
    }
  })

  test('continues past higher ranked aliases without target-language glosses', async () => {
    const refs = [sourceRef('language-filter')]
    const languageSnapshot: CanonicalSnapshot = {
      schemaVersion: '1.0.0',
      generatedAt: importedAt,
      entries: Array.from({ length: 4 }, (_, index) => {
        const number = index + 1
        const id = `yde_${String(number).padStart(8, '0')}`
        const formId = `ydf_${String(number).padStart(8, '0')}`
        const readingId = `ydr_${String(number).padStart(8, '0')}`
        const senseId = `yds_${String(number).padStart(8, '0')}`
        const glossId = `ydg_${String(number).padStart(8, '0')}`
        return {
          id,
          language: 'ja',
          entryType: 'word',
          primaryForm: `候補${number}`,
          primaryReading: 'こう',
          forms: [
            {
              id: formId,
              text: `候補${number}`,
              normalizedText: `候補${number}`,
              script: 'mixed',
              isPrimary: true,
              tags: [],
              sourceRefs: refs,
            },
          ],
          readings: [
            {
              id: readingId,
              text: 'こう',
              normalizedText: 'こう',
              system: 'kana',
              isPrimary: true,
              appliesToFormIds: 'all',
              tags: [],
              sourceRefs: refs,
            },
          ],
          senses: [
            {
              id: senseId,
              entryId: id,
              order: 1,
              partOfSpeech: ['n'],
              appliesToFormIds: 'all',
              appliesToReadingIds: 'all',
              domain: [],
              register: [],
              misc: [],
              glosses: [
                {
                  id: glossId,
                  senseId,
                  lang: number === 4 ? 'zh-tw' : 'en',
                  text: number === 4 ? '第四個候選' : `English candidate ${number}`,
                  sourceType: 'source',
                  reviewStatus: 'approved',
                  sourceRefs: refs,
                },
              ],
              examples: [],
              sourceRefs: refs,
            },
          ],
          ranking: number === 4 ? {} : { common: true, priority: ['ichi1'] },
          sourceRefs: refs,
        } satisfies CanonicalSnapshot['entries'][number]
      }),
      lookupAliases: Array.from({ length: 4 }, (_, index) => {
        const number = index + 1
        return {
          id: `yda_${String(number).padStart(8, '0')}`,
          surface: 'こう',
          normalizedSurface: 'こう',
          reading: 'こう',
          normalizedReading: 'こう',
          entryId: `yde_${String(number).padStart(8, '0')}`,
          readingId: `ydr_${String(number).padStart(8, '0')}`,
          aliasType: 'reading',
          score: 75,
        }
      }),
    }

    const { db, service } = await buildService(languageSnapshot)
    try {
      const result = service.lookup({ query: 'こう', lang: 'zh-tw', limit: 1 })
      expect(result.matched).toMatchObject({ surface: 'こう' })
      expect(result.entries).toEqual([
        {
          id: 'yde_00000004',
          word: '候補4',
          reading: 'こう',
          pos: ['n'],
          definitions: ['第四個候選'],
        },
      ])
    } finally {
      db.close()
    }
  })
})
