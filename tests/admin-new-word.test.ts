import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { closeDb, lookupWord } from '../src/db'
import adminRoutes from '../src/admin/routes'
import { createEmptySnapshot, getReleaseDbPath, getReleaseManifestPath, writeCurrentReleasePointer, writeReleaseManifest } from '../src/storage'
import { writeReleaseSnapshotToDb } from '../scripts/release/lib'
import { createEmptyCore, createEmptyLang, saveCore, saveLang } from '../scripts/import/base'
import { createManualWordInSnapshot } from '../src/manual-word-service'
import {
  approveTranslationUpdate,
  initUpdatesDatabase,
  insertTranslationUpdate,
  insertUpdateBatch,
  rejectTranslationUpdate,
} from '../src/update-store'

let tempDir = ''
let originalCwd = ''
let app: { fetch: (request: Request) => Promise<Response> }

function basicAuth(token: string): string {
  return `Basic ${Buffer.from(`admin:${token}`).toString('base64')}`
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init))
}

beforeEach(async () => {
  originalCwd = process.cwd()
  tempDir = mkdtempSync(join(tmpdir(), 'yori-admin-new-word-'))
  process.chdir(tempDir)

  mkdirSync(join(tempDir, 'data', 'lang'), { recursive: true })

  await saveCore(join(tempDir, 'data', 'core.json'), createEmptyCore())
  await saveLang(join(tempDir, 'data', 'lang', 'en.json'), createEmptyLang('en'))
  await saveLang(join(tempDir, 'data', 'lang', 'de.json'), createEmptyLang('de'))
  await saveLang(join(tempDir, 'data', 'lang', 'ko.json'), createEmptyLang('ko'))
  await saveLang(join(tempDir, 'data', 'lang', 'zh-cn.json'), createEmptyLang('zh-cn'))
  await saveLang(join(tempDir, 'data', 'lang', 'zh-tw.json'), createEmptyLang('zh-tw'))

  const version = 'initial-release'
  const dbPath = getReleaseDbPath(version)
  const manifestPath = getReleaseManifestPath(version)
  writeReleaseSnapshotToDb(dbPath, createEmptySnapshot())
  writeReleaseManifest(version, {
    version,
    builtAt: new Date().toISOString(),
    schemaVersion: '1.0.0',
    baseSourceFingerprint: 'initial',
    releaseDbPath: dbPath,
    promotedFromUpdateSequence: null,
  })
  writeCurrentReleasePointer({
    version,
    dbPath,
    manifestPath,
    activatedAt: new Date().toISOString(),
  })

  process.env.UPDATES_DATABASE_PATH = join(tempDir, 'updates.sqlite')
  process.env.ADMIN_TOKEN = 'secret-token'

  const hono = new Hono()
  hono.route('/', adminRoutes)
  app = { fetch: hono.fetch }
})

afterEach(() => {
  closeDb()
  delete process.env.UPDATES_DATABASE_PATH
  delete process.env.ADMIN_TOKEN
  process.chdir(originalCwd)
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
})

describe('admin new word flow', () => {
  test('new word page requires auth', async () => {
    const res = await request('/admin/new-word')
    expect(res.status).toBe(401)
  })

  test('new word page only offers entry inspector after the release is built', async () => {
    const res = await request('/admin/new-word', {
      headers: { authorization: basicAuth('secret-token') },
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html.match(/Open entry inspector/g)?.length ?? 0).toBe(1)
    expect(html.includes('Open existing entry')).toBe(false)
  })

  test('creates a new snapshot word, blocks duplicates, and requires a release build before lookup', async () => {
    const payload = {
      word: '新語',
      reading: 'しんご',
      partOfSpeech: ['noun'],
      common: true,
      jlpt: 3,
      translations: [{
        lang: 'en',
        definitions: ['neologism'],
        examples: [{
          japanese: 'その新語は広まった。',
          translation: 'That new word spread.',
        }],
      }],
    }

    const createRes = await request('/admin/api/new-word', {
      method: 'POST',
      headers: {
        authorization: basicAuth('secret-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    expect(createRes.status).toBe(200)
    const created = await createRes.json()
    expect(created.created).toBe(true)
    expect(created.wordId).toBe('新語:しんご')
    expect(created.activeReleaseContainsWord).toBe(false)

    const core = await Bun.file(join(tempDir, 'data', 'core.json')).json()
    const en = await Bun.file(join(tempDir, 'data', 'lang', 'en.json')).json()
    expect(core.entries['新語:しんご'].partOfSpeech).toEqual(['noun'])
    expect(en.entries['新語:しんご'].definitions).toEqual(['neologism'])
    expect(en.entries['新語:しんご']._defSources.neologism).toEqual(['manual'])
    expect(en.entries['新語:しんご'].examples[0].source).toBe('manual')

    closeDb()
    expect(lookupWord('新語', 'en')).toBeNull()

    const duplicateRes = await request('/admin/api/new-word', {
      method: 'POST',
      headers: {
        authorization: basicAuth('secret-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    expect(duplicateRes.status).toBe(409)

    const buildRes = await request('/admin/api/new-word/build-release', {
      method: 'POST',
      headers: {
        authorization: basicAuth('secret-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ activate: true, createdWordId: '新語:しんご' }),
    })
    expect(buildRes.status).toBe(200)
    const buildBody = await buildRes.json()
    expect(buildBody.activated).toBe(true)
    expect(buildBody.createdWordId).toBe('新語:しんご')

    closeDb()
    expect(lookupWord('新語', 'en')?.definitions).toEqual(['neologism'])
  })

  test('building a release for a new word keeps overlay updates mutable instead of baking them into the release', async () => {
    const core = createEmptyCore()
    core.entries['食べる:たべる'] = {
      word: '食べる',
      reading: 'たべる',
      partOfSpeech: ['ichidan verb'],
      common: true,
      jlpt: 5,
      frequency: 10,
    }
    core.entries['飲む:のむ'] = {
      word: '飲む',
      reading: 'のむ',
      partOfSpeech: ['godan verb'],
      common: true,
      jlpt: 5,
      frequency: 20,
    }
    await saveCore(join(tempDir, 'data', 'core.json'), core)

    const en = createEmptyLang('en')
    en.entries['食べる:たべる'] = {
      definitions: ['to eat'],
      examples: [],
      _defSources: { 'to eat': ['seed'] },
    }
    en.entries['飲む:のむ'] = {
      definitions: ['to drink'],
      examples: [],
      _defSources: { 'to drink': ['seed'] },
    }
    await saveLang(join(tempDir, 'data', 'lang', 'en.json'), en)

    const activeSnapshot = createEmptySnapshot()
    activeSnapshot.words.set('食べる:たべる', {
      id: '食べる:たべる',
      word: '食べる',
      reading: 'たべる',
      partOfSpeech: ['ichidan verb'],
      common: true,
      jlpt: [5],
      frequency: 10,
    })
    activeSnapshot.words.set('飲む:のむ', {
      id: '飲む:のむ',
      word: '飲む',
      reading: 'のむ',
      partOfSpeech: ['godan verb'],
      common: true,
      jlpt: [5],
      frequency: 20,
    })
    activeSnapshot.translations.set('食べる:たべる\u0000en', {
      wordId: '食べる:たべる',
      lang: 'en',
      definitions: ['to dine'],
      sources: ['promoted'],
    })
    activeSnapshot.translations.set('飲む:のむ\u0000en', {
      wordId: '飲む:のむ',
      lang: 'en',
      definitions: ['to drink'],
      sources: ['seed'],
    })
    writeReleaseSnapshotToDb(getReleaseDbPath('initial-release'), activeSnapshot, { overwrite: true })

    const updatesDb = initUpdatesDatabase(join(tempDir, 'updates.sqlite'))
    const batchId = insertUpdateBatch(updatesDb, {
      kind: 'ai_import',
      inputManifest: { test: true },
      notes: 'reviewable update should stay in overlay',
    })
    const updateId = insertTranslationUpdate(updatesDb, {
      wordId: '食べる:たべる',
      lang: 'en',
      definitions: ['to consume food'],
      sources: ['ai'],
      sourceType: 'ai',
      batchId,
      reviewStatus: 'pending',
    })
    approveTranslationUpdate(updatesDb, updateId, 'tester')
    updatesDb.close()

    closeDb()
    expect(lookupWord('食べる', 'en')?.definitions).toEqual(['to consume food'])
    expect(lookupWord('飲む', 'en')?.definitions).toEqual(['to drink'])

    const payload = {
      word: '新語',
      reading: 'しんご',
      partOfSpeech: ['noun'],
      translations: [{
        lang: 'en',
        definitions: ['neologism'],
      }],
    }

    const createRes = await request('/admin/api/new-word', {
      method: 'POST',
      headers: {
        authorization: basicAuth('secret-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    expect(createRes.status).toBe(200)

    const buildRes = await request('/admin/api/new-word/build-release', {
      method: 'POST',
      headers: {
        authorization: basicAuth('secret-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ activate: true, createdWordId: '新語:しんご' }),
    })
    expect(buildRes.status).toBe(200)

    closeDb()
    expect(lookupWord('食べる', 'en')?.definitions).toEqual(['to consume food'])
    expect(lookupWord('飲む', 'en')?.definitions).toEqual(['to drink'])
    expect(lookupWord('新語', 'en')?.definitions).toEqual(['neologism'])

    const updatesDbAfterBuild = initUpdatesDatabase(join(tempDir, 'updates.sqlite'))
    rejectTranslationUpdate(updatesDbAfterBuild, updateId, 'tester')
    updatesDbAfterBuild.close()

    closeDb()
    expect(lookupWord('食べる', 'en')?.definitions).toEqual(['to eat'])
    expect(lookupWord('新語', 'en')?.definitions).toEqual(['neologism'])
  })

  test('building a release for one new word still includes other pending snapshot additions', async () => {
    const firstCreateRes = await request('/admin/api/new-word', {
      method: 'POST',
      headers: {
        authorization: basicAuth('secret-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        word: '新語A',
        reading: 'しんごえー',
        partOfSpeech: ['noun'],
        translations: [{
          lang: 'en',
          definitions: ['entry a'],
        }],
      }),
    })
    expect(firstCreateRes.status).toBe(200)

    const secondCreateRes = await request('/admin/api/new-word', {
      method: 'POST',
      headers: {
        authorization: basicAuth('secret-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        word: '新語B',
        reading: 'しんごびー',
        partOfSpeech: ['noun'],
        translations: [{
          lang: 'en',
          definitions: ['entry b'],
        }],
      }),
    })
    expect(secondCreateRes.status).toBe(200)

    const buildRes = await request('/admin/api/new-word/build-release', {
      method: 'POST',
      headers: {
        authorization: basicAuth('secret-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ activate: true, createdWordId: '新語B:しんごびー' }),
    })
    expect(buildRes.status).toBe(200)

    closeDb()
    expect(lookupWord('新語A', 'en')?.definitions).toEqual(['entry a'])
    expect(lookupWord('新語B', 'en')?.definitions).toEqual(['entry b'])
  })

  test('returns validation errors for invalid reading and empty translations', async () => {
    const res = await request('/admin/api/new-word', {
      method: 'POST',
      headers: {
        authorization: basicAuth('secret-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        word: '新語',
        reading: 'shingo',
        translations: [],
      }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.fieldErrors.reading).toBeDefined()
    expect(body.fieldErrors.translations).toBeDefined()
  })

  test('rejects build-release requests without a createdWordId', async () => {
    const res = await request('/admin/api/new-word/build-release', {
      method: 'POST',
      headers: {
        authorization: basicAuth('secret-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ activate: true }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'createdWordId is required.',
    })
  })

  test('returns 404 when build-release is asked for a word missing from the snapshot', async () => {
    const res = await request('/admin/api/new-word/build-release', {
      method: 'POST',
      headers: {
        authorization: basicAuth('secret-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ activate: true, createdWordId: '不存在:ふそんざい' }),
    })

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('Word not found in snapshot:')
  })

  test('manual snapshot service still supports definitionless CLI-style entries', async () => {
    const result = await createManualWordInSnapshot({
      word: '試験語',
      reading: 'しけんご',
      translations: [{
        lang: 'en',
        definitions: [],
        examples: [{
          japanese: '試験語を追加した。',
          translation: 'I added a test word.',
        }],
      }],
    }, {
      allowExistingWordId: true,
      allowDefinitionlessTranslations: true,
    })

    expect(result.created).toBe(true)
    const en = await Bun.file(join(tempDir, 'data', 'lang', 'en.json')).json()
    expect(en.entries['試験語:しけんご'].definitions).toEqual([])
    expect(en.entries['試験語:しけんご'].examples).toHaveLength(1)
  })
})
