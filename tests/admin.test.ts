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

async function request(path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init))
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

  test('login page renders when admin is enabled', async () => {
    const res = await request('/admin/login')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('dictionary admin console')
  })

  test('malformed unrelated cookies do not break admin auth checks', async () => {
    const loginRes = await request('/admin/login', {
      headers: {
        cookie: 'theme=100%; bad=%E0%A4%A',
      },
    })
    expect(loginRes.status).toBe(200)
    expect(await loginRes.text()).toContain('dictionary admin console')

    const protectedRes = await request('/admin/new-word', {
      headers: {
        cookie: 'theme=100%; bad=%E0%A4%A',
      },
    })
    expect(protectedRes.status).toBe(302)
    expect(protectedRes.headers.get('location')).toBe('/admin/login?next=%2Fadmin%2Fnew-word')
  })

  test('protected page routes redirect to login and preserve the destination', async () => {
    const res = await request('/admin/new-word')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/admin/login?next=%2Fadmin%2Fnew-word')
  })

  test('successful login sets a session cookie and grants page access', async () => {
    const loginRes = await request('/admin/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        next: '/admin/new-word',
        password: 'secret-token',
      }).toString(),
    })

    expect(loginRes.status).toBe(303)
    expect(loginRes.headers.get('location')).toBe('/admin/new-word')
    const sessionCookie = loginRes.headers.get('set-cookie')
    expect(sessionCookie).toContain('yori_admin_session=')
    expect(sessionCookie).toContain('HttpOnly')

    const pageRes = await request('/admin/new-word', {
      headers: {
        cookie: sessionCookie ?? '',
      },
    })
    expect(pageRes.status).toBe(200)
    expect(await pageRes.text()).toContain('Create a new deterministic dictionary entry')

    const apiRes = await request('/admin/api/summary', {
      headers: {
        cookie: sessionCookie ?? '',
      },
    })
    expect(apiRes.status).toBe(200)
  })

  test('failed login stays on the login page with an inline error', async () => {
    const res = await request('/admin/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        next: '/admin',
        password: 'wrong-token',
      }).toString(),
    })

    expect(res.status).toBe(401)
    const html = await res.text()
    expect(html).toContain('Access denied')
    expect(html).toContain('did not match this environment')
  })

  test('logout clears the session cookie and blocks further page access', async () => {
    const loginRes = await request('/admin/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        next: '/admin',
        password: 'secret-token',
      }).toString(),
    })
    const sessionCookie = loginRes.headers.get('set-cookie') ?? ''

    const logoutRes = await request('/admin/logout', {
      method: 'POST',
      headers: {
        cookie: sessionCookie,
      },
    })

    expect(logoutRes.status).toBe(303)
    expect(logoutRes.headers.get('location')).toBe('/admin/login')
    expect(logoutRes.headers.get('set-cookie')).toContain('Max-Age=0')

    const pageRes = await request('/admin/new-word')
    expect(pageRes.status).toBe(302)
  })

  test('login page shows a friendly disabled state when admin token is missing', async () => {
    delete process.env.ADMIN_TOKEN
    const res = await request('/admin/login')
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('Admin UI is offline')
    process.env.ADMIN_TOKEN = 'secret-token'
  })

  test('admin summary works with token', async () => {
    const res = await request('/admin/api/summary', {
      headers: {
        authorization: basicAuth('secret-token'),
      },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.activeReleaseVersion).toBe('admin-test-release')
  })

  test('approve endpoint makes pending AI visible to lookup inspector', async () => {
    const reviewRes = await request('/admin/api/review/ai', {
      headers: {
        authorization: basicAuth('secret-token'),
      },
    })
    const queue = await reviewRes.json()
    expect(queue.translations).toHaveLength(1)
    const updateId = queue.translations[0].id

    const beforeRes = await request('/admin/api/entries?word=食べる&lang=en', {
      headers: {
        authorization: basicAuth('secret-token'),
      },
    })
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

    const afterRes = await request('/admin/api/entries?word=食べる&lang=en', {
      headers: {
        authorization: basicAuth('secret-token'),
      },
    })
    const after = await afterRes.json()
    expect(after.effective.definitions).toEqual(['to consume food'])
  })
})
