import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildCanonicalRelease } from '../scripts/pipeline/build-canonical-release'
import { writeReleaseSnapshotToDb } from '../scripts/release/lib'
import { closeDb } from '../src/db'
import { closeCanonicalDb } from '../src/runtime/canonical-db'
import { createEmptySnapshot } from '../src/storage'
import type { CanonicalSnapshot, SourceKind, SourceRef } from '../src/domain/types'

let app: { fetch: (request: Request) => Response | Promise<Response> }
let tempDir = ''
let originalReleaseDbPath: string | undefined
let originalReleaseVersion: string | undefined
let originalUpdatesDatabasePath: string | undefined
let originalCanonicalReleaseDbPath: string | undefined

const importedAt = '2026-06-03T00:00:00.000Z'

function sourceRef(sourceId: string, kind: SourceKind = 'jmdict'): SourceRef {
  return {
    kind,
    sourceId,
    license: 'CC-BY-SA-4.0',
    importedAt,
  }
}

function canonicalSnapshot(): CanonicalSnapshot {
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
            examples: [
              {
                id: 'ydx_00000001',
                senseId: 'yds_00000001',
                lang: 'en',
                japanese: '寿司を食べる。',
                translation: 'I eat sushi.',
                sourceRefs: taberuRefs,
              },
            ],
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
    kanjiCharacters: [
      {
        id: 'ydk_00000001',
        literal: '食',
        meanings: [
          {
            lang: 'en',
            text: 'eat',
            sourceRefs: [sourceRef('98df', 'kanjidic2')],
          },
          {
            lang: 'zh-tw',
            text: '吃',
            sourceRefs: [sourceRef('98df', 'kanjidic2')],
          },
        ],
        readings: [
          {
            type: 'onyomi',
            text: 'ショク',
            sourceRefs: [sourceRef('98df', 'kanjidic2')],
          },
          {
            type: 'kunyomi',
            text: 'た.べる',
            sourceRefs: [sourceRef('98df', 'kanjidic2')],
          },
        ],
        stats: {
          grade: 2,
          strokeCount: 9,
          frequency: 328,
          jlpt: 4,
        },
        sourceRefs: [sourceRef('98df', 'kanjidic2')],
      },
    ],
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init))
}

beforeAll(async () => {
  originalReleaseDbPath = process.env.RELEASE_DB_PATH
  originalReleaseVersion = process.env.RELEASE_VERSION
  originalUpdatesDatabasePath = process.env.UPDATES_DATABASE_PATH
  originalCanonicalReleaseDbPath = process.env.CANONICAL_RELEASE_DB_PATH

  tempDir = mkdtempSync(join(tmpdir(), 'yori-api-v2-test-'))
  const legacyDbPath = join(tempDir, 'legacy-release.sqlite')
  const updatesDbPath = join(tempDir, 'updates.sqlite')
  const snapshotPath = join(tempDir, 'canonical-snapshot.json')
  const canonicalDbPath = join(tempDir, 'canonical-release.sqlite')

  writeReleaseSnapshotToDb(legacyDbPath, createEmptySnapshot())
  await Bun.write(snapshotPath, JSON.stringify(canonicalSnapshot()))
  await buildCanonicalRelease({ snapshot: snapshotPath, out: canonicalDbPath, overwrite: false })

  process.env.RELEASE_DB_PATH = legacyDbPath
  process.env.RELEASE_VERSION = 'api-v2-test'
  process.env.UPDATES_DATABASE_PATH = updatesDbPath
  process.env.CANONICAL_RELEASE_DB_PATH = canonicalDbPath

  const module = await import('../src/index')
  app = module.default
})

afterAll(() => {
  closeCanonicalDb()
  closeDb()

  if (originalReleaseDbPath === undefined) delete process.env.RELEASE_DB_PATH
  else process.env.RELEASE_DB_PATH = originalReleaseDbPath

  if (originalReleaseVersion === undefined) delete process.env.RELEASE_VERSION
  else process.env.RELEASE_VERSION = originalReleaseVersion

  if (originalUpdatesDatabasePath === undefined) delete process.env.UPDATES_DATABASE_PATH
  else process.env.UPDATES_DATABASE_PATH = originalUpdatesDatabasePath

  if (originalCanonicalReleaseDbPath === undefined) delete process.env.CANONICAL_RELEASE_DB_PATH
  else process.env.CANONICAL_RELEASE_DB_PATH = originalCanonicalReleaseDbPath

  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true })
})

describe('GET /v2/lookup', () => {
  test('looks up an entry by dictionary surface', async () => {
    const res = await request('/v2/lookup?query=食べる&lang=en')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.matched).toMatchObject({ surface: '食べる', matchType: 'dictionary' })
    expect(body.entries).toEqual([
      {
        id: 'yde_00000001',
        word: '食べる',
        reading: 'たべる',
        pos: ['v1', 'vt'],
        definitions: ['to eat'],
      },
    ])
  })

  test('looks up variant forms and target language glosses', async () => {
    const res = await request('/v2/lookup?query=喰べる&lang=zh-tw')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.matched).toMatchObject({ surface: '喰べる', matchType: 'variant' })
    expect(body.entries[0]).toMatchObject({ id: 'yde_00000001', definitions: ['吃'] })
  })

  test('normalizes katakana reading input', async () => {
    const res = await request('/v2/lookup?query=スシ&lang=en')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.matched).toMatchObject({ surface: '寿司', matchType: 'dictionary' })
    expect(body.entries[0]).toMatchObject({ id: 'yde_00000002', definitions: ['sushi'] })
  })

  test('returns 404 when matched entry has no gloss for the requested language', async () => {
    const res = await request('/v2/lookup?query=寿司&lang=zh-tw')
    expect(res.status).toBe(404)

    const body = await res.json()
    expect(body).toEqual({ error: 'Word not found' })
  })

  test('rejects missing lookup input', async () => {
    const res = await request('/v2/lookup?lang=en')
    expect(res.status).toBe(400)
  })
})

describe('POST /v2/lookup/batch', () => {
  test('looks up tokenized input using lemma before surface', async () => {
    const res = await request('/v2/lookup/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lang: 'en',
        tokens: [
          { surface: '食べました', lemma: '食べる', reading: 'タベマシタ', pos: '動詞' },
          { surface: 'スシ' },
        ],
      }),
    })
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.results).toHaveLength(2)
    expect(body.results[0].token).toMatchObject({ surface: '食べました', lemma: '食べる' })
    expect(body.results[0].matched).toMatchObject({ surface: '食べる' })
    expect(body.results[0].entries[0]).toMatchObject({ id: 'yde_00000001' })
    expect(body.results[1].matched).toMatchObject({ surface: '寿司' })
    expect(body.results[1].entries[0]).toMatchObject({ id: 'yde_00000002' })
  })

  test('rejects oversized batches', async () => {
    const tokens = Array.from({ length: 101 }, () => ({ query: '食べる' }))
    const res = await request('/v2/lookup/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokens }),
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /v2/entries/:id', () => {
  test('returns a full canonical entry by product-owned ID', async () => {
    const res = await request('/v2/entries/yde_00000001')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body).toMatchObject({
      id: 'yde_00000001',
      language: 'ja',
      entryType: 'word',
      primaryForm: '食べる',
      primaryReading: 'たべる',
    })
    expect(body.forms).toHaveLength(2)
    expect(body.readings).toHaveLength(1)
    expect(body.senses[0]).toMatchObject({
      id: 'yds_00000001',
      partOfSpeech: ['v1', 'vt'],
    })
    expect(body.senses[0].glosses.map((gloss: { lang: string }) => gloss.lang)).toEqual(['en', 'zh-tw'])
    expect(body.senses[0].examples).toEqual([
      {
        id: 'ydx_00000001',
        senseId: 'yds_00000001',
        lang: 'en',
        japanese: '寿司を食べる。',
        translation: 'I eat sushi.',
        sourceRefs: [
          {
            kind: 'jmdict',
            sourceId: '1358280',
            license: 'CC-BY-SA-4.0',
            importedAt,
          },
        ],
      },
    ])
    expect(body.sourceRefs[0]).toMatchObject({ kind: 'jmdict', sourceId: '1358280' })
  })

  test('filters glosses and examples by language when lang is provided', async () => {
    const res = await request('/v2/entries/yde_00000001?lang=zh-tw')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.senses[0].glosses).toEqual([
      {
        id: 'ydg_00000002',
        lang: 'zh-tw',
        text: '吃',
        sourceType: 'manual',
        reviewStatus: 'approved',
        sourceRefs: [
          {
            kind: 'jmdict',
            sourceId: '1358280',
            license: 'CC-BY-SA-4.0',
            importedAt,
          },
        ],
      },
    ])
    expect(body.senses[0].examples).toEqual([])
  })

  test('rejects invalid entry IDs', async () => {
    const res = await request('/v2/entries/1358280')
    expect(res.status).toBe(400)

    const body = await res.json()
    expect(body).toEqual({ error: 'Invalid entry ID' })
  })

  test('returns 404 for unknown entry IDs', async () => {
    const res = await request('/v2/entries/yde_99999999')
    expect(res.status).toBe(404)

    const body = await res.json()
    expect(body).toEqual({ error: 'Entry not found' })
  })
})

describe('GET /v2/kanji/:literal', () => {
  test('returns kanji details by literal', async () => {
    const res = await request('/v2/kanji/食')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body).toMatchObject({
      id: 'ydk_00000001',
      literal: '食',
      meanings: [
        { lang: 'en', text: 'eat' },
        { lang: 'zh-tw', text: '吃' },
      ],
      readings: [
        { type: 'onyomi', text: 'ショク' },
        { type: 'kunyomi', text: 'た.べる' },
      ],
      stats: {
        grade: 2,
        strokeCount: 9,
        frequency: 328,
        jlpt: 4,
      },
    })
    expect(body.sourceRefs[0]).toMatchObject({ kind: 'kanjidic2', sourceId: '98df' })
  })

  test('filters kanji meanings by language', async () => {
    const res = await request('/v2/kanji/食?lang=zh-tw')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.meanings).toEqual([
      {
        lang: 'zh-tw',
        text: '吃',
        sourceRefs: [
          {
            kind: 'kanjidic2',
            sourceId: '98df',
            license: 'CC-BY-SA-4.0',
            importedAt,
          },
        ],
      },
    ])
  })

  test('rejects non-kanji literals', async () => {
    const res = await request('/v2/kanji/食べる')
    expect(res.status).toBe(400)

    const body = await res.json()
    expect(body).toEqual({ error: 'Invalid kanji literal' })
  })

  test('returns 404 for unknown kanji', async () => {
    const res = await request('/v2/kanji/森')
    expect(res.status).toBe(404)

    const body = await res.json()
    expect(body).toEqual({ error: 'Kanji not found' })
  })
})
