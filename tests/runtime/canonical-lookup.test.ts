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
    const { db, service } = await buildService()
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
      expect(result.matched).toMatchObject({ surface: '寿司' })
      expect(result.entries).toEqual([])
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
})
