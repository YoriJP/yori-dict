import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildCanonicalRelease } from '../scripts/pipeline/build-canonical-release'
import { closeCanonicalDb } from '../src/runtime/canonical-db'
import type { CanonicalSnapshot, SourceKind, SourceRef } from '../src/domain/types'

let app: { fetch: (request: Request) => Response | Promise<Response> }
let tempDir = ''
let originalCanonicalReleaseDbPath: string | undefined
let originalCurationOverlayPath: string | undefined
let originalCurationApiToken: string | undefined
let curationOverlayPath = ''

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

function curationHeaders(): HeadersInit {
  return { authorization: 'Bearer test-curation-token' }
}

async function withCurationEnv(
  env: { overlayPath?: string | null, token?: string | null },
  run: () => Promise<void>
): Promise<void> {
  const previousOverlayPath = process.env.CURATION_OVERLAY_PATH
  const previousToken = process.env.CURATION_API_TOKEN

  if ('overlayPath' in env) {
    if (env.overlayPath === null) delete process.env.CURATION_OVERLAY_PATH
    else process.env.CURATION_OVERLAY_PATH = env.overlayPath
  }
  if ('token' in env) {
    if (env.token === null) delete process.env.CURATION_API_TOKEN
    else process.env.CURATION_API_TOKEN = env.token
  }

  try {
    await run()
  } finally {
    if (previousOverlayPath === undefined) delete process.env.CURATION_OVERLAY_PATH
    else process.env.CURATION_OVERLAY_PATH = previousOverlayPath
    if (previousToken === undefined) delete process.env.CURATION_API_TOKEN
    else process.env.CURATION_API_TOKEN = previousToken
  }
}

async function writeCurationOverlay(): Promise<void> {
  await Bun.write(curationOverlayPath, JSON.stringify({
    schemaVersion: '1.0.0',
    operations: [
      {
        id: 'ai-yds_00000002-add-gloss-zh-tw-canonical-gloss-v1-20260604',
        type: 'addGloss',
        sourceKind: 'ai',
        importedAt,
        reviewStatus: 'unreviewed',
        model: 'gemini-3.1-flash-lite',
        promptVersion: 'canonical-gloss-v1',
        inputRefs: ['entry:yde_00000002', 'sense:yds_00000002'],
        senseId: 'yds_00000002',
        lang: 'zh-tw',
        text: '壽司',
      },
      {
        id: 'manual-yds_00000001-add-example-en-20260604',
        type: 'addExample',
        sourceKind: 'manual',
        importedAt,
        reviewStatus: 'approved',
        senseId: 'yds_00000001',
        lang: 'en',
        japanese: '寿司を食べる。',
        translation: 'I eat sushi.',
      },
    ],
  }))
}

beforeAll(async () => {
  originalCanonicalReleaseDbPath = process.env.CANONICAL_RELEASE_DB_PATH
  originalCurationOverlayPath = process.env.CURATION_OVERLAY_PATH
  originalCurationApiToken = process.env.CURATION_API_TOKEN

  tempDir = mkdtempSync(join(tmpdir(), 'yori-api-v2-test-'))
  const snapshotPath = join(tempDir, 'canonical-snapshot.json')
  const canonicalDbPath = join(tempDir, 'canonical-release.sqlite')
  curationOverlayPath = join(tempDir, 'curation-overlays.json')

  await Bun.write(snapshotPath, JSON.stringify(canonicalSnapshot()))
  await writeCurationOverlay()
  await buildCanonicalRelease({ snapshot: snapshotPath, out: canonicalDbPath, overwrite: false })

  process.env.CANONICAL_RELEASE_DB_PATH = canonicalDbPath
  process.env.CURATION_OVERLAY_PATH = curationOverlayPath
  process.env.CURATION_API_TOKEN = 'test-curation-token'

  const module = await import('../src/index')
  app = module.default
})

beforeEach(async () => {
  if (curationOverlayPath) await writeCurationOverlay()
})

afterAll(() => {
  closeCanonicalDb()

  if (originalCanonicalReleaseDbPath === undefined) delete process.env.CANONICAL_RELEASE_DB_PATH
  else process.env.CANONICAL_RELEASE_DB_PATH = originalCanonicalReleaseDbPath
  if (originalCurationOverlayPath === undefined) delete process.env.CURATION_OVERLAY_PATH
  else process.env.CURATION_OVERLAY_PATH = originalCurationOverlayPath
  if (originalCurationApiToken === undefined) delete process.env.CURATION_API_TOKEN
  else process.env.CURATION_API_TOKEN = originalCurationApiToken

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

  test('rejects invalid top-level body shapes', async () => {
    const res = await request('/v2/lookup/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid request body' })
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

describe('admin curation endpoints', () => {
  test('requires curation API authorization', async () => {
    const res = await request('/admin/curation/overlays')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  test('returns 503 when curation API config is missing', async () => {
    await withCurationEnv({ overlayPath: null }, async () => {
      const res = await request('/admin/curation/overlays', {
        headers: curationHeaders(),
      })
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'Curation API is not configured' })
    })

    await withCurationEnv({ token: null }, async () => {
      const res = await request('/admin/curation/overlays', {
        headers: curationHeaders(),
      })
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'Curation API is not configured' })
    })
  })

  test('rejects an incorrect curation API token', async () => {
    const res = await request('/admin/curation/overlays', {
      headers: { authorization: 'Bearer wrong-token' },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  test('looks up canonical entries through the curation API', async () => {
    const res = await request('/admin/curation/lookup?query=食べる&lang=en', {
      headers: curationHeaders(),
    })
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.entries[0]).toMatchObject({
      id: 'yde_00000001',
      definitions: ['to eat'],
    })
  })

  test('returns canonical entry details through the curation API', async () => {
    const res = await request('/admin/curation/entries/yde_00000001?lang=zh-tw', {
      headers: curationHeaders(),
    })
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.senses[0].glosses).toEqual([
      expect.objectContaining({
        lang: 'zh-tw',
        text: '吃',
      }),
    ])
  })

  test('lists overlay operations with review filters', async () => {
    const res = await request('/admin/curation/overlays?sourceKind=ai&reviewStatus=unreviewed&lang=zh-tw', {
      headers: curationHeaders(),
    })
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.total).toBe(1)
    expect(body.operations[0]).toMatchObject({
      id: 'ai-yds_00000002-add-gloss-zh-tw-canonical-gloss-v1-20260604',
      sourceKind: 'ai',
      reviewStatus: 'unreviewed',
      lang: 'zh-tw',
    })
  })

  test('rejects invalid overlay list limits', async () => {
    for (const limit of ['abc', '0', '101']) {
      const res = await request(`/admin/curation/overlays?limit=${limit}`, {
        headers: curationHeaders(),
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid limit. Use an integer between 1 and 100.' })
    }
  })

  test('lists an empty overlay file when the configured file does not exist', async () => {
    const missingOverlayPath = join(tempDir, 'missing-curation-overlays.json')
    if (existsSync(missingOverlayPath)) rmSync(missingOverlayPath, { force: true })

    await withCurationEnv({ overlayPath: missingOverlayPath }, async () => {
      const res = await request('/admin/curation/overlays', {
        headers: curationHeaders(),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ operations: [], total: 0 })
    })
  })

  test('shows one overlay operation', async () => {
    const res = await request('/admin/curation/overlays/manual-yds_00000001-add-example-en-20260604', {
      headers: curationHeaders(),
    })
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.operation).toMatchObject({
      id: 'manual-yds_00000001-add-example-en-20260604',
      type: 'addExample',
      sourceKind: 'manual',
    })
  })

  test('approves overlay operations', async () => {
    const id = 'ai-yds_00000002-add-gloss-zh-tw-canonical-gloss-v1-20260604'
    const res = await request(`/admin/curation/overlays/${id}/approve`, {
      method: 'POST',
      headers: curationHeaders(),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.operation.reviewStatus).toBe('approved')
  })

  test('rejects unreviewed overlay operations', async () => {
    const id = 'ai-yds_00000002-add-gloss-zh-tw-canonical-gloss-v1-20260604'
    const res = await request(`/admin/curation/overlays/${id}/reject`, {
      method: 'POST',
      headers: curationHeaders(),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.operation.reviewStatus).toBe('rejected')
  })

  test('does not reject approved overlay operations in place', async () => {
    const id = 'ai-yds_00000002-add-gloss-zh-tw-canonical-gloss-v1-20260604'
    let res = await request(`/admin/curation/overlays/${id}/approve`, {
      method: 'POST',
      headers: curationHeaders(),
    })
    expect(res.status).toBe(200)

    res = await request(`/admin/curation/overlays/${id}/reject`, {
      method: 'POST',
      headers: curationHeaders(),
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Approved overlay operations cannot be rejected in place' })
  })

  test('returns 404 when reviewing an unknown overlay operation', async () => {
    const res = await request('/admin/curation/overlays/unknown/approve', {
      method: 'POST',
      headers: curationHeaders(),
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Overlay operation not found' })
  })
})
