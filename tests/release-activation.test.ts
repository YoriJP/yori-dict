import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, initSchema, lookupWord } from '../src/db'
import {
  createEmptySnapshot,
  getReleaseDbPath,
  getReleaseManifestPath,
  writeCurrentReleasePointer,
  writeReleaseManifest,
} from '../src/storage'
import { writeReleaseSnapshotToDb } from '../scripts/release/lib'
import { activateRelease, listReleases } from '../src/release-service'

let tempDir = ''
let originalCwd = ''

function makeSnapshot(definition: string) {
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
    definitions: [definition],
    sources: ['seed'],
  })
  return snapshot
}

afterEach(() => {
  closeDb()
  delete process.env.RELEASE_DB_PATH
  delete process.env.RELEASE_VERSION
  delete process.env.RELEASE_MANIFEST_PATH
  delete process.env.UPDATES_DATABASE_PATH
  if (originalCwd) process.chdir(originalCwd)
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = ''
  originalCwd = ''
})

describe('release activation', () => {
  test('lookup switches to the newly activated release without restarting the process', () => {
    originalCwd = process.cwd()
    tempDir = mkdtempSync(join(tmpdir(), 'yori-release-activation-'))
    process.chdir(tempDir)
    process.env.UPDATES_DATABASE_PATH = join(tempDir, 'updates.sqlite')

    const v1 = 'release-v1'
    const v2 = 'release-v2'
    const v1DbPath = getReleaseDbPath(v1)
    const v2DbPath = getReleaseDbPath(v2)
    const v1ManifestPath = getReleaseManifestPath(v1)

    writeReleaseSnapshotToDb(v1DbPath, makeSnapshot('to eat'))
    writeReleaseManifest(v1, {
      version: v1,
      builtAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
      baseSourceFingerprint: 'v1',
      releaseDbPath: v1DbPath,
      promotedFromUpdateSequence: null,
    })

    writeReleaseSnapshotToDb(v2DbPath, makeSnapshot('to dine'))
    writeReleaseManifest(v2, {
      version: v2,
      builtAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
      baseSourceFingerprint: 'v2',
      releaseDbPath: v2DbPath,
      promotedFromUpdateSequence: null,
    })

    writeCurrentReleasePointer({
      version: v1,
      dbPath: v1DbPath,
      manifestPath: v1ManifestPath,
      activatedAt: new Date().toISOString(),
    })

    initSchema()
    expect(lookupWord('食べる', 'en')?.definitions).toEqual(['to eat'])

    activateRelease(v2)
    expect(lookupWord('食べる', 'en')?.definitions).toEqual(['to dine'])
  })

  test('env-pinned runtime switches to the newly activated release in-process', () => {
    originalCwd = process.cwd()
    tempDir = mkdtempSync(join(tmpdir(), 'yori-release-activation-env-'))
    process.chdir(tempDir)
    process.env.UPDATES_DATABASE_PATH = join(tempDir, 'updates.sqlite')

    const v1 = 'release-v1'
    const v2 = 'release-v2'
    const v1DbPath = getReleaseDbPath(v1)
    const v2DbPath = getReleaseDbPath(v2)
    const v1ManifestPath = getReleaseManifestPath(v1)
    const v2ManifestPath = getReleaseManifestPath(v2)

    writeReleaseSnapshotToDb(v1DbPath, makeSnapshot('to eat'))
    writeReleaseManifest(v1, {
      version: v1,
      builtAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
      baseSourceFingerprint: 'v1',
      releaseDbPath: v1DbPath,
      promotedFromUpdateSequence: null,
    })

    writeReleaseSnapshotToDb(v2DbPath, makeSnapshot('to dine'))
    writeReleaseManifest(v2, {
      version: v2,
      builtAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
      baseSourceFingerprint: 'v2',
      releaseDbPath: v2DbPath,
      promotedFromUpdateSequence: null,
    })

    writeCurrentReleasePointer({
      version: v1,
      dbPath: v1DbPath,
      manifestPath: v1ManifestPath,
      activatedAt: new Date().toISOString(),
    })

    process.env.RELEASE_DB_PATH = v1DbPath
    process.env.RELEASE_VERSION = v1
    process.env.RELEASE_MANIFEST_PATH = v1ManifestPath

    expect(lookupWord('食べる', 'en')?.definitions).toEqual(['to eat'])

    activateRelease(v2)

    expect(process.env.RELEASE_DB_PATH).toBe(v2DbPath)
    expect(process.env.RELEASE_VERSION).toBe(v2)
    expect(process.env.RELEASE_MANIFEST_PATH).toBe(v2ManifestPath)
    expect(lookupWord('食べる', 'en')?.definitions).toEqual(['to dine'])
  })

  test('release listings mark the env-selected runtime release as active', () => {
    originalCwd = process.cwd()
    tempDir = mkdtempSync(join(tmpdir(), 'yori-release-list-env-'))
    process.chdir(tempDir)
    process.env.UPDATES_DATABASE_PATH = join(tempDir, 'updates.sqlite')

    const v1 = 'release-v1'
    const v2 = 'release-v2'
    const v1DbPath = getReleaseDbPath(v1)
    const v2DbPath = getReleaseDbPath(v2)
    const v1ManifestPath = getReleaseManifestPath(v1)
    const v2ManifestPath = getReleaseManifestPath(v2)

    writeReleaseSnapshotToDb(v1DbPath, makeSnapshot('to eat'))
    writeReleaseManifest(v1, {
      version: v1,
      builtAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
      baseSourceFingerprint: 'v1',
      releaseDbPath: v1DbPath,
      promotedFromUpdateSequence: null,
    })

    writeReleaseSnapshotToDb(v2DbPath, makeSnapshot('to dine'))
    writeReleaseManifest(v2, {
      version: v2,
      builtAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
      baseSourceFingerprint: 'v2',
      releaseDbPath: v2DbPath,
      promotedFromUpdateSequence: null,
    })

    writeCurrentReleasePointer({
      version: v1,
      dbPath: v1DbPath,
      manifestPath: v1ManifestPath,
      activatedAt: new Date().toISOString(),
    })

    process.env.RELEASE_DB_PATH = v2DbPath
    process.env.RELEASE_VERSION = v2
    process.env.RELEASE_MANIFEST_PATH = v2ManifestPath

    const releases = listReleases()
    expect(releases.find((release) => release.version === v1)?.isActive).toBe(false)
    expect(releases.find((release) => release.version === v2)?.isActive).toBe(true)
  })
})
