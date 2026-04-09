import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createEmptyCore, createEmptyDict, createEmptyLang, saveCore, saveDict, saveLang } from '../scripts/import/base'
import { loadSnapshotFromJson } from '../scripts/release/lib'
import { buildRelease } from '../src/release-service'
import { readReleaseManifest } from '../src/storage'

let tempDir = ''
let originalCwd = ''

beforeEach(() => {
  originalCwd = process.cwd()
  tempDir = mkdtempSync(join(tmpdir(), 'yori-release-build-'))
  process.chdir(tempDir)
})

afterEach(() => {
  process.chdir(originalCwd)
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
})

describe('release build workflow', () => {
  test('rejects reusing an existing release version without overwriting prior artifacts', async () => {
    mkdirSync(join(tempDir, 'data', 'lang'), { recursive: true })

    const core = createEmptyCore()
    core.entries['食べる:たべる'] = {
      word: '食べる',
      reading: 'たべる',
      partOfSpeech: ['ichidan verb'],
      common: true,
      jlpt: 5,
      frequency: 10,
    }
    await saveCore(join(tempDir, 'data', 'core.json'), core)

    const en = createEmptyLang('en')
    en.entries['食べる:たべる'] = {
      definitions: ['to eat'],
      examples: [],
      _defSources: { 'to eat': ['seed'] },
    }
    await saveLang(join(tempDir, 'data', 'lang', 'en.json'), en)

    const firstBuild = await buildRelease({ version: 'fixed-version' })

    en.entries['食べる:たべる'] = {
      definitions: ['to dine'],
      examples: [],
      _defSources: { 'to dine': ['seed'] },
    }
    await saveLang(join(tempDir, 'data', 'lang', 'en.json'), en)

    let error: unknown = null
    try {
      await buildRelease({ version: 'fixed-version' })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Release version already exists: fixed-version')

    const db = new Database(firstBuild.dbPath, { readonly: true })
    const translationRow = db.query<{ definitions: string }, []>(`
      SELECT definitions
      FROM translations
      WHERE word_id = '食べる:たべる' AND lang = 'en'
    `).get()
    db.close()

    expect(JSON.parse(translationRow?.definitions ?? '[]')).toEqual(['to eat'])
  })

  test('merges legacy metadata for the same word across multiple language files', async () => {
    mkdirSync(join(tempDir, 'data'), { recursive: true })
    const wordId = '試験:しけん'

    const en = createEmptyDict('en')
    en.entries[wordId] = {
      word: '試験',
      reading: 'しけん',
      partOfSpeech: [],
      common: false,
      commonSources: [],
      jlpt: [],
      definitions: [{ text: 'exam', sources: ['seed-en'] }],
      examples: [],
    }

    const de = createEmptyDict('de')
    de.entries[wordId] = {
      word: '試験',
      reading: 'しけん',
      partOfSpeech: [{ value: 'noun', sources: ['seed-de'] }],
      common: false,
      commonSources: ['seed-de'],
      jlpt: [{ level: 4, sources: ['seed-de'] }],
      frequency: { rank: 50, sources: ['seed-de'] },
      definitions: [{ text: 'Pruefung', sources: ['seed-de'] }],
      examples: [],
    }

    const ko = createEmptyDict('ko')
    ko.entries[wordId] = {
      word: '試験',
      reading: 'しけん',
      partOfSpeech: [{ value: 'expression', sources: ['seed-ko'] }],
      common: true,
      commonSources: ['seed-ko'],
      jlpt: [{ level: 5, sources: ['seed-ko'] }],
      frequency: { rank: 20, sources: ['seed-ko'] },
      definitions: [{ text: '시험', sources: ['seed-ko'] }],
      examples: [],
    }

    await saveDict(join(tempDir, 'data', 'en.json'), en)
    await saveDict(join(tempDir, 'data', 'de.json'), de)
    await saveDict(join(tempDir, 'data', 'ko.json'), ko)

    const snapshot = await loadSnapshotFromJson()
    const word = snapshot.words.get(wordId)

    expect(word).not.toBeUndefined()
    expect([...(word?.partOfSpeech ?? [])].sort()).toEqual(['expression', 'noun'])
    expect(word?.common).toBe(true)
    expect(word?.jlpt).toEqual([5, 4])
    expect(word?.frequency).toBe(20)
  })

  test('fingerprint includes actual legacy snapshot inputs', async () => {
    mkdirSync(join(tempDir, 'data'), { recursive: true })
    const wordId = '橋:はし'

    const en = createEmptyDict('en')
    en.entries[wordId] = {
      word: '橋',
      reading: 'はし',
      partOfSpeech: [{ value: 'noun', sources: ['seed-en'] }],
      common: true,
      commonSources: ['seed-en'],
      jlpt: [{ level: 5, sources: ['seed-en'] }],
      frequency: { rank: 100, sources: ['seed-en'] },
      definitions: [{ text: 'bridge', sources: ['seed-en'] }],
      examples: [],
    }

    const de = createEmptyDict('de')
    de.entries[wordId] = {
      word: '橋',
      reading: 'はし',
      partOfSpeech: [{ value: 'noun', sources: ['seed-de'] }],
      common: true,
      commonSources: ['seed-de'],
      jlpt: [{ level: 5, sources: ['seed-de'] }],
      frequency: { rank: 100, sources: ['seed-de'] },
      definitions: [{ text: 'Bruecke', sources: ['seed-de'] }],
      examples: [],
    }

    await saveDict(join(tempDir, 'data', 'en.json'), en)
    await saveDict(join(tempDir, 'data', 'de.json'), de)

    const firstBuild = await buildRelease({ version: 'legacy-v1' })
    const firstManifest = readReleaseManifest(firstBuild.manifestPath)

    de.entries[wordId].definitions = [{ text: 'Steg', sources: ['seed-de'] }]
    await saveDict(join(tempDir, 'data', 'de.json'), de)

    const secondBuild = await buildRelease({ version: 'legacy-v2' })
    const secondManifest = readReleaseManifest(secondBuild.manifestPath)

    expect(secondManifest.baseSourceFingerprint).not.toBe(firstManifest.baseSourceFingerprint)
  })
})
