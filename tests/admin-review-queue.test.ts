import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'
import { closeDb, lookupWord } from '../src/db'
import type { ReleaseSnapshot } from '../src/storage'
import { createEmptySnapshot, writeReleaseManifest } from '../src/storage'
import { writeReleaseSnapshotToDb } from '../scripts/release/lib'
import {
  initUpdatesDatabase,
  insertExampleUpdateSet,
  insertTranslationUpdate,
  insertUpdateBatch,
} from '../src/update-store'
import adminRoutes from '../src/admin/routes'
import {
  clearTestAuthEnv,
  loginAsTestAdmin,
  seedTestAdmin,
  setTestAuthEnv,
} from './helpers/admin-auth'

let tempDir = ''
let app: { fetch: (request: Request) => Response | Promise<Response> }
let session: { cookie: string }

function reviewUnitId(wordId: string, lang: string, batchId: number): string {
  return `${encodeURIComponent(wordId)}|${lang}|${batchId}`
}

function makeSnapshot(): ReleaseSnapshot {
  const snapshot = createEmptySnapshot()
  snapshot.words.set('食べる:たべる', {
    id: '食べる:たべる',
    word: '食べる',
    reading: 'たべる',
    partOfSpeech: ['ichidan verb'],
    common: true,
    jlpt: [5],
    frequency: 10,
  })
  snapshot.words.set('飲む:のむ', {
    id: '飲む:のむ',
    word: '飲む',
    reading: 'のむ',
    partOfSpeech: ['godan verb'],
    common: true,
    jlpt: [5],
    frequency: 20,
  })
  snapshot.words.set('区切り|語:くぎり', {
    id: '区切り|語:くぎり',
    word: '区切り|語',
    reading: 'くぎり',
    partOfSpeech: ['noun'],
    common: false,
    jlpt: [],
    frequency: null,
  })
  snapshot.translations.set('食べる:たべる\u0000en', {
    wordId: '食べる:たべる',
    lang: 'en',
    definitions: ['to eat'],
    sources: ['seed'],
  })
  snapshot.examples.set('食べる:たべる\u0000en', [{
    wordId: '食べる:たべる',
    lang: 'en',
    japanese: '毎朝食べます',
    translation: 'I eat every morning',
    source: 'seed',
  }])
  snapshot.translations.set('飲む:のむ\u0000en', {
    wordId: '飲む:のむ',
    lang: 'en',
    definitions: ['to drink'],
    sources: ['seed'],
  })
  snapshot.examples.set('飲む:のむ\u0000en', [{
    wordId: '飲む:のむ',
    lang: 'en',
    japanese: '水を飲む',
    translation: 'drink water',
    source: 'seed',
  }])
  snapshot.translations.set('食べる:たべる\u0000de', {
    wordId: '食べる:たべる',
    lang: 'de',
    definitions: ['essen'],
    sources: ['seed'],
  })
  snapshot.translations.set('区切り|語:くぎり\u0000en', {
    wordId: '区切り|語:くぎり',
    lang: 'en',
    definitions: ['separator word'],
    sources: ['seed'],
  })
  return snapshot
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init))
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'yori-admin-review-'))
  process.env.YORI_PROJECT_ROOT = tempDir
  const releaseDbPath = join(tempDir, 'release.sqlite')
  const updatesDbPath = join(tempDir, 'updates.sqlite')
  const manifestPath = join(tempDir, 'manifest.json')

  writeReleaseSnapshotToDb(releaseDbPath, makeSnapshot())
  writeReleaseManifest('admin-review-release', {
    version: 'admin-review-release',
    builtAt: new Date().toISOString(),
    schemaVersion: '1.0.0',
    baseSourceFingerprint: 'admin-review',
    releaseDbPath,
    promotedFromUpdateSequence: null,
  })

  process.env.RELEASE_DB_PATH = releaseDbPath
  process.env.RELEASE_VERSION = 'admin-review-release'
  process.env.RELEASE_MANIFEST_PATH = manifestPath
  process.env.UPDATES_DATABASE_PATH = updatesDbPath
  setTestAuthEnv()

  const updatesDb = initUpdatesDatabase(updatesDbPath)
  const batchOne = insertUpdateBatch(updatesDb, {
    kind: 'ai_import',
    inputManifest: { name: 'batch-one' },
    notes: 'primary AI batch',
  })
  insertTranslationUpdate(updatesDb, {
    wordId: '食べる:たべる',
    lang: 'en',
    definitions: ['to consume food'],
    sources: ['ai'],
    sourceType: 'ai',
    batchId: batchOne,
    reviewStatus: 'pending',
  })
  insertExampleUpdateSet(updatesDb, {
    wordId: '食べる:たべる',
    lang: 'en',
    examples: [{
      japanese: 'パンを食べる',
      translation: 'eat bread',
      source: 'ai',
    }],
    sourceType: 'ai',
    batchId: batchOne,
    reviewStatus: 'pending',
  })
  insertTranslationUpdate(updatesDb, {
    wordId: '飲む:のむ',
    lang: 'en',
    definitions: ['to sip'],
    sources: ['ai'],
    sourceType: 'ai',
    batchId: batchOne,
    reviewStatus: 'pending',
  })
  const batchTwo = insertUpdateBatch(updatesDb, {
    kind: 'ai_import',
    inputManifest: { name: 'batch-two' },
    notes: 'secondary AI batch',
  })
  insertExampleUpdateSet(updatesDb, {
    wordId: '食べる:たべる',
    lang: 'de',
    examples: [{
      japanese: '寿司を食べる',
      translation: 'Sushi essen',
      source: 'ai',
    }],
    sourceType: 'ai',
    batchId: batchTwo,
    reviewStatus: 'pending',
  })
  const sourceBatch = insertUpdateBatch(updatesDb, {
    kind: 'source_import',
    inputManifest: { name: 'source-batch' },
    notes: 'source examples',
  })
  insertExampleUpdateSet(updatesDb, {
    wordId: '飲む:のむ',
    lang: 'en',
    examples: [{
      japanese: 'お茶を飲む',
      translation: 'drink tea',
      source: 'source',
    }],
    sourceType: 'source',
    batchId: sourceBatch,
  })
  updatesDb.close()

  const hono = new Hono()
  hono.route('/', adminRoutes)
  app = { fetch: hono.fetch }

  await seedTestAdmin()
  session = await loginAsTestAdmin(app)
})

afterEach(() => {
  closeDb()
  delete process.env.YORI_PROJECT_ROOT
  delete process.env.RELEASE_DB_PATH
  delete process.env.RELEASE_VERSION
  delete process.env.RELEASE_MANIFEST_PATH
  delete process.env.UPDATES_DATABASE_PATH
  clearTestAuthEnv()
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
})

describe('bulk AI review queue', () => {
  test('queue api aggregates review units and exposes batch summaries', async () => {
    const res = await request('/admin/api/review/queue', {
      headers: { cookie: session.cookie },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.summary.pendingUnits).toBe(3)
    expect(body.summary.recentBatches[0].pendingUnits).toBe(1)
    expect(body.summary.recentBatches[1].pendingUnits).toBe(2)
    expect(body.items).toHaveLength(3)

    const pairUnit = body.items.find((item: { unitId: string }) => item.unitId === reviewUnitId('食べる:たべる', 'en', 1))
    expect(pairUnit.translation).not.toBeNull()
    expect(pairUnit.exampleSet).not.toBeNull()

    const conflictUnit = body.items.find((item: { unitId: string }) => item.unitId === reviewUnitId('飲む:のむ', 'en', 1))
    expect(conflictUnit.flags.hasSourceConflict).toBe(true)

    const batchSummaryRes = await request('/admin/api/review/batches/1/summary', {
      headers: { cookie: session.cookie },
    })
    expect(batchSummaryRes.status).toBe(200)
    const batchSummary = await batchSummaryRes.json()
    expect(batchSummary.pendingUnits).toBe(2)
    expect(batchSummary.translationOnlyCount).toBe(1)
    expect(batchSummary.examplesOnlyCount).toBe(0)
  })

  test('bulk approve updates effective lookup for a review unit', async () => {
    const approveRes = await request('/admin/api/review/units/approve', {
      method: 'POST',
      headers: {
        cookie: session.cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        unitIds: [reviewUnitId('食べる:たべる', 'en', 1)],
        notes: 'approved in bulk',
      }),
    })

    expect(approveRes.status).toBe(200)
    closeDb()
    const result = lookupWord('食べる', 'en')
    expect(result?.definitions).toEqual(['to consume food'])
    expect(result?.examples).toEqual([{
      japanese: 'パンを食べる',
      translation: 'eat bread',
    }])
  })

  test('bulk approve blocks source-conflicted units unless override is set', async () => {
    const blockedRes = await request('/admin/api/review/units/approve', {
      method: 'POST',
      headers: {
        cookie: session.cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        unitIds: [reviewUnitId('飲む:のむ', 'en', 1)],
      }),
    })
    expect(blockedRes.status).toBe(400)
    const blocked = await blockedRes.json()
    expect(blocked.blockedUnitIds).toEqual([reviewUnitId('飲む:のむ', 'en', 1)])

    const overrideRes = await request('/admin/api/review/units/approve', {
      method: 'POST',
      headers: {
        cookie: session.cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        unitIds: [reviewUnitId('飲む:のむ', 'en', 1)],
        overrideSourceConflict: true,
      }),
    })
    expect(overrideRes.status).toBe(200)
  })

  test('bulk review accepts comma-delimited unitIds payloads', async () => {
    const res = await request('/admin/api/review/units/approve', {
      method: 'POST',
      headers: {
        cookie: session.cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        unitIds: [
          reviewUnitId('食べる:たべる', 'en', 1),
          reviewUnitId('飲む:のむ', 'en', 1),
        ].join(','),
        overrideSourceConflict: true,
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.affected.units).toBe(2)
  })

  test('bulk review handles word ids containing delimiter characters', async () => {
    const updatesDb = initUpdatesDatabase(process.env.UPDATES_DATABASE_PATH)
    const batchId = insertUpdateBatch(updatesDb, {
      kind: 'ai_import',
      inputManifest: { name: 'delimiter-batch' },
      notes: 'delimiter word id',
    })
    insertTranslationUpdate(updatesDb, {
      wordId: '区切り|語:くぎり',
      lang: 'en',
      definitions: ['word with separator'],
      sources: ['ai'],
      sourceType: 'ai',
      batchId,
      reviewStatus: 'pending',
    })
    updatesDb.close()

    const unitId = reviewUnitId('区切り|語:くぎり', 'en', batchId)
    const approveRes = await request('/admin/api/review/units/approve', {
      method: 'POST',
      headers: { cookie: session.cookie },
      body: JSON.stringify({ unitIds: [unitId] }),
    })
    expect(approveRes.status).toBe(200)
    const approveBody = await approveRes.json()
    expect(approveBody.affected.units).toBe(1)
  })

  test('admin JSON endpoints return 400 for malformed JSON', async () => {
    const res = await request('/admin/api/jobs/source-update', {
      method: 'POST',
      headers: {
        cookie: session.cookie,
        'content-type': 'application/json',
      },
      body: '{',
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid JSON')
  })

  test('bulk review rejects mixed batch or language selections', async () => {
    const mixedRes = await request('/admin/api/review/units/reject', {
      method: 'POST',
      headers: {
        cookie: session.cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        unitIds: [
          reviewUnitId('飲む:のむ', 'en', 1),
          reviewUnitId('食べる:たべる', 'de', 2),
        ],
      }),
    })
    expect(mixedRes.status).toBe(400)
    const mixed = await mixedRes.json()
    expect(mixed.error).toContain('multiple batches')
  })

  test('approve all batch action approves every pending unit with conflict override', async () => {
    const blockedRes = await request('/admin/api/review/batches/1/approve-all', {
      method: 'POST',
      headers: {
        cookie: session.cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    expect(blockedRes.status).toBe(400)
    const blocked = await blockedRes.json()
    expect(blocked.blockedUnitIds).toEqual([reviewUnitId('飲む:のむ', 'en', 1)])

    const approveRes = await request('/admin/api/review/batches/1/approve-all', {
      method: 'POST',
      headers: {
        cookie: session.cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        overrideSourceConflict: true,
        notes: 'approved whole batch',
      }),
    })
    expect(approveRes.status).toBe(200)
    const approved = await approveRes.json()
    expect(approved.affected).toEqual({
      units: 2,
      translations: 2,
      exampleSets: 1,
    })

    const queueRes = await request('/admin/api/review/queue?batchId=1', {
      headers: { cookie: session.cookie },
    })
    const queue = await queueRes.json()
    expect(queue.summary.pendingUnits).toBe(0)
  })

  test('approve all batch action requires explicit all-languages approval for mixed-language batches', async () => {
    const updatesDb = initUpdatesDatabase(process.env.UPDATES_DATABASE_PATH)
    insertTranslationUpdate(updatesDb, {
      wordId: '飲む:のむ',
      lang: 'ko',
      definitions: ['마시다'],
      sources: ['ai'],
      sourceType: 'ai',
      batchId: 2,
      reviewStatus: 'pending',
    })
    updatesDb.close()

    const blockedRes = await request('/admin/api/review/batches/2/approve-all', {
      method: 'POST',
      headers: {
        cookie: session.cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    expect(blockedRes.status).toBe(400)
    const blocked = await blockedRes.json()
    expect(blocked.error).toContain('explicit all-languages')

    const batchPageRes = await request('/admin/review/batch/2', {
      headers: { cookie: session.cookie },
    })
    const batchPageHtml = await batchPageRes.text()
    expect(batchPageHtml.includes('Approve all languages 2')).toBe(true)
    expect(batchPageHtml.includes('name="allowMultipleLanguages" value="true"')).toBe(true)
    expect(batchPageHtml.includes('Select visible de (1)')).toBe(true)
    expect(batchPageHtml.includes('Select visible ko (1)')).toBe(true)
    expect(batchPageHtml.includes('Select all visible')).toBe(false)

    const singleLanguagePageRes = await request('/admin/review/batch/1', {
      headers: { cookie: session.cookie },
    })
    const singleLanguagePageHtml = await singleLanguagePageRes.text()
    expect(singleLanguagePageHtml.includes('Approve all languages')).toBe(false)
    expect(singleLanguagePageHtml.includes('name="allowMultipleLanguages" value="true"')).toBe(false)

    const approveRes = await request('/admin/api/review/batches/2/approve-all', {
      method: 'POST',
      headers: {
        cookie: session.cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        allowMultipleLanguages: true,
        notes: 'approved all languages',
      }),
    })
    expect(approveRes.status).toBe(200)
    const approved = await approveRes.json()
    expect(approved.affected).toEqual({
      units: 2,
      translations: 1,
      exampleSets: 1,
    })

    const db = initUpdatesDatabase(process.env.UPDATES_DATABASE_PATH)
    const auditRow = db.query<{ action: string; target_id: string; notes: string }, []>(`
      SELECT action, target_id, notes
      FROM admin_actions
      WHERE action = 'review.batch.approve_all_languages'
      ORDER BY id DESC
      LIMIT 1
    `).get()
    db.close()

    expect(auditRow).toEqual({
      action: 'review.batch.approve_all_languages',
      target_id: '2',
      notes: 'approved all languages',
    })
  })

  test('review pages render queue dashboard and batch actions', async () => {
    const dashboardRes = await request('/admin/review', {
      headers: { cookie: session.cookie },
    })
    expect(dashboardRes.status).toBe(200)
    const dashboardHtml = await dashboardRes.text()
    expect(dashboardHtml.includes('Pending')).toBe(true)
    expect(dashboardHtml.includes('/admin/review/batch/1')).toBe(true)
    expect(dashboardHtml.includes('Override source conflict')).toBe(true)

    const batchRes = await request('/admin/review/batch/1', {
      headers: { cookie: session.cookie },
    })
    expect(batchRes.status).toBe(200)
    const batchHtml = await batchRes.text()
    expect(batchHtml.includes('Approve selected')).toBe(true)
    expect(batchHtml.includes('Approve all')).toBe(true)
    expect(batchHtml.includes('/admin/api/review/batches/1/approve-all')).toBe(true)
    expect(batchHtml.includes('Select all visible')).toBe(true)
  })
})
