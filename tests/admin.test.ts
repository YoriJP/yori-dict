import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'
import type { ReleaseSnapshot } from '../src/storage'
import { createEmptySnapshot, writeReleaseManifest } from '../src/storage'
import { writeReleaseSnapshotToDb } from '../scripts/release/lib'
import { closeDb, initSchema } from '../src/db'
import { initUpdatesDatabase, insertTranslationUpdate, insertUpdateBatch } from '../src/update-store'
import adminRoutes from '../src/admin/routes'

let tempDir = ''
let app: { fetch: (request: Request) => Promise<Response> }

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
  snapshot.translations.set('食べる:たべる\u0000en', {
    wordId: '食べる:たべる',
    lang: 'en',
    definitions: ['to eat'],
    sources: ['jmdict'],
  })
  return snapshot
}

function basicAuth(token: string): string {
  return `Basic ${Buffer.from(`admin:${token}`).toString('base64')}`
}

async function request(path: string, token?: string): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, {
    headers: token ? { authorization: basicAuth(token) } : {},
  }))
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'yori-admin-'))
  const releaseDbPath = join(tempDir, 'release.sqlite')
  const updatesDbPath = join(tempDir, 'updates.sqlite')
  const manifestPath = join(tempDir, 'manifest.json')

  writeReleaseSnapshotToDb(releaseDbPath, makeSnapshot())
  writeReleaseManifest('admin-test-release', {
    version: 'admin-test-release',
    builtAt: new Date().toISOString(),
    schemaVersion: '1.0.0',
    baseSourceFingerprint: 'admin-test',
    releaseDbPath,
    promotedFromUpdateSequence: null,
  })

  process.env.RELEASE_DB_PATH = releaseDbPath
  process.env.RELEASE_VERSION = 'admin-test-release'
  process.env.RELEASE_MANIFEST_PATH = manifestPath
  process.env.UPDATES_DATABASE_PATH = updatesDbPath
  process.env.ADMIN_TOKEN = 'secret-token'

  const updatesDb = initUpdatesDatabase(updatesDbPath)
  const batchId = insertUpdateBatch(updatesDb, {
    kind: 'ai_import',
    inputManifest: { test: true },
    notes: 'admin review test',
  })
  insertTranslationUpdate(updatesDb, {
    wordId: '食べる:たべる',
    lang: 'en',
    definitions: ['to consume food'],
    sources: ['ai'],
    sourceType: 'ai',
    batchId,
    reviewStatus: 'pending',
  })
  updatesDb.close()

  const hono = new Hono()
  initSchema()
  hono.route('/', adminRoutes)
  app = {
    fetch: hono.fetch,
  }
})

afterAll(() => {
  closeDb()
  delete process.env.RELEASE_DB_PATH
  delete process.env.RELEASE_VERSION
  delete process.env.RELEASE_MANIFEST_PATH
  delete process.env.UPDATES_DATABASE_PATH
  delete process.env.ADMIN_TOKEN
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
})

describe('admin routes', () => {
  test('admin summary requires auth', async () => {
    const res = await request('/admin/api/summary')
    expect(res.status).toBe(401)
  })

  test('admin summary works with token', async () => {
    const res = await request('/admin/api/summary', 'secret-token')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.activeReleaseVersion).toBe('admin-test-release')
  })

  test('approve endpoint makes pending AI visible to lookup inspector', async () => {
    const reviewRes = await request('/admin/api/review/ai', 'secret-token')
    const queue = await reviewRes.json()
    expect(queue.translations).toHaveLength(1)
    const updateId = queue.translations[0].id

    const beforeRes = await request('/admin/api/entries?word=食べる&lang=en', 'secret-token')
    const before = await beforeRes.json()
    expect(before.effective.definitions).toEqual(['to eat'])

    const approveRes = await app.fetch(new Request(`http://localhost/admin/api/review/translation/${updateId}/approve`, {
      method: 'POST',
      headers: {
        authorization: basicAuth('secret-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }))
    expect(approveRes.status).toBe(200)

    const afterRes = await request('/admin/api/entries?word=食べる&lang=en', 'secret-token')
    const after = await afterRes.json()
    expect(after.effective.definitions).toEqual(['to consume food'])
  })
})
