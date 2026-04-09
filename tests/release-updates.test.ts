import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Database } from 'bun:sqlite'
import { closeDb, lookupWord } from '../src/db'
import { createEmptySnapshot, type ReleaseSnapshot, writeReleaseManifest, type ReleaseManifest } from '../src/storage'
import { writeReleaseSnapshotToDb, loadSnapshotFromReleaseDb, applyActiveUpdatesToSnapshot } from '../scripts/release/lib'
import { activateRelease, promoteRelease } from '../src/release-service'
import {
  approveExampleUpdateSet,
  approveTranslationUpdate,
  initUpdatesDatabase,
  insertExampleUpdateSet,
  insertTranslationUpdate,
  insertUpdateBatch,
  listTranslationUpdates,
  markAllActiveUpdatesPromoted,
} from '../src/update-store'

const tempPaths: string[] = []

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
  snapshot.examples.set('食べる:たべる\u0000en', [{
    wordId: '食べる:たべる',
    lang: 'en',
    japanese: '毎朝食べます',
    translation: 'I eat every morning',
    source: 'tatoeba',
  }])
  return snapshot
}

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'yori-release-'))
  tempPaths.push(path)
  return path
}

afterEach(() => {
  closeDb()
  delete process.env.RELEASE_DB_PATH
  delete process.env.RELEASE_VERSION
  delete process.env.RELEASE_MANIFEST_PATH
  delete process.env.UPDATES_DATABASE_PATH
  delete process.env.YORI_PROJECT_ROOT

  while (tempPaths.length > 0) {
    const path = tempPaths.pop()
    if (path) rmSync(path, { recursive: true, force: true })
  }
})

describe('release overlay flow', () => {
  test('activating a staged promoted release retires only baked-in overlays', () => {
    const dir = makeTempDir()
    const releaseDbPath = join(dir, 'release.sqlite')
    const updatesDbPath = join(dir, 'updates.sqlite')
    const manifestPath = join(dir, 'manifest.json')
    process.env.YORI_PROJECT_ROOT = dir

    try {
      writeReleaseSnapshotToDb(releaseDbPath, makeSnapshot())
      writeReleaseManifest('test-release', {
        version: 'test-release',
        builtAt: new Date().toISOString(),
        schemaVersion: '1.0.0',
        baseSourceFingerprint: 'test',
        releaseDbPath,
        promotedFromUpdateSequence: null,
      })

      process.env.RELEASE_DB_PATH = releaseDbPath
      process.env.RELEASE_VERSION = 'test-release'
      process.env.RELEASE_MANIFEST_PATH = manifestPath
      process.env.UPDATES_DATABASE_PATH = updatesDbPath

      let updatesDb = initUpdatesDatabase(updatesDbPath)
      const stagedBatchId = insertUpdateBatch(updatesDb, {
        kind: 'ai_import',
        inputManifest: { test: 'staged' },
        notes: 'AI batch baked into staged release',
      })
      const stagedUpdateId = insertTranslationUpdate(updatesDb, {
        wordId: '食べる:たべる',
        lang: 'en',
        definitions: ['to consume food'],
        sources: ['ai'],
        sourceType: 'ai',
        batchId: stagedBatchId,
        reviewStatus: 'pending',
      })
      approveTranslationUpdate(updatesDb, stagedUpdateId, 'tester')
      updatesDb.close()

      promoteRelease({ version: 'staged-release', activate: false })

      updatesDb = initUpdatesDatabase(updatesDbPath)
      const laterBatchId = insertUpdateBatch(updatesDb, {
        kind: 'ai_import',
        inputManifest: { test: 'later' },
        notes: 'AI batch created after staged release build',
      })
      const laterUpdateId = insertTranslationUpdate(updatesDb, {
        wordId: '食べる:たべる',
        lang: 'de',
        definitions: ['essen'],
        sources: ['ai'],
        sourceType: 'ai',
        batchId: laterBatchId,
        reviewStatus: 'pending',
      })
      approveTranslationUpdate(updatesDb, laterUpdateId, 'tester')
      updatesDb.close()

      activateRelease('staged-release')

      updatesDb = initUpdatesDatabase(updatesDbPath)
      const aiUpdates = listTranslationUpdates(updatesDb, {
        sourceType: 'ai',
        limit: 10,
      })
      updatesDb.close()

      expect(aiUpdates.find((row) => row.id === stagedUpdateId)?.status).toBe('promoted')
      expect(aiUpdates.find((row) => row.id === laterUpdateId)?.status).toBe('active')
    } finally {
      delete process.env.YORI_PROJECT_ROOT
    }
  })

  test('promote without activation keeps active overlay data live', () => {
    const dir = makeTempDir()
    const releaseDbPath = join(dir, 'release.sqlite')
    const updatesDbPath = join(dir, 'updates.sqlite')
    const manifestPath = join(dir, 'manifest.json')
    process.env.YORI_PROJECT_ROOT = dir

    try {
      writeReleaseSnapshotToDb(releaseDbPath, makeSnapshot())
      writeReleaseManifest('test-release', {
        version: 'test-release',
        builtAt: new Date().toISOString(),
        schemaVersion: '1.0.0',
        baseSourceFingerprint: 'test',
        releaseDbPath,
        promotedFromUpdateSequence: null,
      })

      process.env.RELEASE_DB_PATH = releaseDbPath
      process.env.RELEASE_VERSION = 'test-release'
      process.env.RELEASE_MANIFEST_PATH = manifestPath
      process.env.UPDATES_DATABASE_PATH = updatesDbPath

      let updatesDb = initUpdatesDatabase(updatesDbPath)
      const batchId = insertUpdateBatch(updatesDb, {
        kind: 'ai_import',
        inputManifest: { test: true },
        notes: 'AI backfill',
      })
      const translationUpdateId = insertTranslationUpdate(updatesDb, {
        wordId: '食べる:たべる',
        lang: 'en',
        definitions: ['to consume food'],
        sources: ['ai'],
        sourceType: 'ai',
        batchId,
        reviewStatus: 'pending',
      })
      approveTranslationUpdate(updatesDb, translationUpdateId, 'tester')
      updatesDb.close()

      closeDb()
      expect(lookupWord('食べる', 'en')?.definitions).toEqual(['to consume food'])

      promoteRelease({ version: 'promoted-release', activate: false })

      closeDb()
      expect(lookupWord('食べる', 'en')?.definitions).toEqual(['to consume food'])
    } finally {
      delete process.env.YORI_PROJECT_ROOT
    }
  })

  test('promote skips orphaned active updates instead of failing the release build', () => {
    const dir = makeTempDir()
    const releaseDbPath = join(dir, 'release.sqlite')
    const updatesDbPath = join(dir, 'updates.sqlite')
    const manifestPath = join(dir, 'manifest.json')
    process.env.YORI_PROJECT_ROOT = dir

    try {
      writeReleaseSnapshotToDb(releaseDbPath, makeSnapshot())
      writeReleaseManifest('test-release', {
        version: 'test-release',
        builtAt: new Date().toISOString(),
        schemaVersion: '1.0.0',
        baseSourceFingerprint: 'test',
        releaseDbPath,
        promotedFromUpdateSequence: null,
      })

      process.env.RELEASE_DB_PATH = releaseDbPath
      process.env.RELEASE_VERSION = 'test-release'
      process.env.RELEASE_MANIFEST_PATH = manifestPath
      process.env.UPDATES_DATABASE_PATH = updatesDbPath

      const updatesDb = initUpdatesDatabase(updatesDbPath)
      const batchId = insertUpdateBatch(updatesDb, {
        kind: 'source_import',
        inputManifest: { test: 'orphaned' },
        notes: 'orphaned updates should be ignored during promote',
      })

      insertTranslationUpdate(updatesDb, {
        wordId: '幽霊語:ゆうれいご',
        lang: 'en',
        definitions: ['ghost entry'],
        sources: ['manual-test'],
        sourceType: 'source',
        batchId,
      })
      insertExampleUpdateSet(updatesDb, {
        wordId: '幽霊語:ゆうれいご',
        lang: 'en',
        examples: [{
          japanese: '幽霊語を使う',
          translation: 'use a ghost entry',
          source: 'manual-test',
        }],
        sourceType: 'source',
        batchId,
      })
      updatesDb.close()

      const result = promoteRelease({ version: 'promoted-release', activate: false })

      const promotedDb = new Database(result.dbPath, { readonly: true })
      const orphanedTranslation = promotedDb.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count
        FROM translations
        WHERE word_id = '幽霊語:ゆうれいご'
      `).get()
      const orphanedExamples = promotedDb.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count
        FROM examples
        WHERE word_id = '幽霊語:ゆうれいご'
      `).get()
      const preservedTranslation = promotedDb.query<{ definitions: string }, []>(`
        SELECT definitions
        FROM translations
        WHERE word_id = '食べる:たべる' AND lang = 'en'
      `).get()
      promotedDb.close()

      expect(orphanedTranslation?.count).toBe(0)
      expect(orphanedExamples?.count).toBe(0)
      expect(JSON.parse(preservedTranslation?.definitions ?? '[]')).toEqual(['to eat'])
    } finally {
      delete process.env.YORI_PROJECT_ROOT
    }
  })

  test('lookup only uses approved AI updates and still lets source override them', () => {
    const dir = makeTempDir()
    const releaseDbPath = join(dir, 'release.sqlite')
    const promotedDbPath = join(dir, 'promoted.sqlite')
    const updatesDbPath = join(dir, 'updates.sqlite')
    const manifestPath = join(dir, 'manifest.json')

    writeReleaseSnapshotToDb(releaseDbPath, makeSnapshot())
    writeReleaseManifest('test-release', {
      version: 'test-release',
      builtAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
      baseSourceFingerprint: 'test',
      releaseDbPath,
      promotedFromUpdateSequence: null,
    })

    process.env.RELEASE_DB_PATH = releaseDbPath
    process.env.RELEASE_VERSION = 'test-release'
    process.env.RELEASE_MANIFEST_PATH = manifestPath
    process.env.UPDATES_DATABASE_PATH = updatesDbPath

    let result = lookupWord('食べる', 'en')
    expect(result?.definitions).toEqual(['to eat'])
    expect(result?.examples).toHaveLength(1)

    let updatesDb = initUpdatesDatabase(updatesDbPath)
    let batchId = insertUpdateBatch(updatesDb, {
      kind: 'ai_import',
      inputManifest: { test: true },
      notes: 'AI backfill',
    })
    const translationUpdateId = insertTranslationUpdate(updatesDb, {
      wordId: '食べる:たべる',
      lang: 'en',
      definitions: ['to consume food'],
      sources: ['ai'],
      sourceType: 'ai',
      batchId,
      reviewStatus: 'pending',
    })
    const exampleSetId = insertExampleUpdateSet(updatesDb, {
      wordId: '食べる:たべる',
      lang: 'en',
      examples: [{
        japanese: 'パンを食べる',
        translation: 'eat bread',
        source: 'ai',
      }],
      sourceType: 'ai',
      batchId,
      reviewStatus: 'pending',
    })
    updatesDb.close()

    closeDb()
    result = lookupWord('食べる', 'en')
    expect(result?.definitions).toEqual(['to eat'])
    expect(result?.examples).toEqual([{
      japanese: '毎朝食べます',
      translation: 'I eat every morning',
    }])

    updatesDb = initUpdatesDatabase(updatesDbPath)
    approveTranslationUpdate(updatesDb, translationUpdateId, 'tester')
    approveExampleUpdateSet(updatesDb, exampleSetId, 'tester')
    updatesDb.close()

    closeDb()
    result = lookupWord('食べる', 'en')
    expect(result?.definitions).toEqual(['to consume food'])
    expect(result?.examples).toEqual([{
      japanese: 'パンを食べる',
      translation: 'eat bread',
    }])

    updatesDb = initUpdatesDatabase(updatesDbPath)
    batchId = insertUpdateBatch(updatesDb, {
      kind: 'source_import',
      inputManifest: { test: true },
      notes: 'Source update',
    })
    insertTranslationUpdate(updatesDb, {
      wordId: '食べる:たべる',
      lang: 'en',
      definitions: ['to dine'],
      sources: ['wiktionary'],
      sourceType: 'source',
      batchId,
    })
    insertExampleUpdateSet(updatesDb, {
      wordId: '食べる:たべる',
      lang: 'en',
      examples: [],
      sourceType: 'source',
      batchId,
    })
    updatesDb.close()

    closeDb()
    result = lookupWord('食べる', 'en')
    expect(result?.definitions).toEqual(['to dine'])
    expect(result?.examples).toEqual([])

    const releaseDb = new Database(releaseDbPath, { readonly: true })
    updatesDb = initUpdatesDatabase(updatesDbPath)
    const merged = applyActiveUpdatesToSnapshot(loadSnapshotFromReleaseDb(releaseDb), updatesDb)
    writeReleaseSnapshotToDb(promotedDbPath, merged)
    markAllActiveUpdatesPromoted(updatesDb)
    releaseDb.close()
    updatesDb.close()

    const promotedDb = new Database(promotedDbPath, { readonly: true })
    const translationRow = promotedDb.query<{ definitions: string }, []>(`
      SELECT definitions FROM translations WHERE word_id = '食べる:たべる' AND lang = 'en'
    `).get()
    const exampleRows = promotedDb.query<{ japanese: string }, []>(`
      SELECT japanese FROM examples WHERE word_id = '食べる:たべる' AND lang = 'en'
    `).all()
    promotedDb.close()

    expect(JSON.parse(translationRow?.definitions ?? '[]')).toEqual(['to dine'])
    expect(exampleRows).toHaveLength(0)
  })
})
