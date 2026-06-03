import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildCanonicalRelease, parseArgs } from '../../scripts/pipeline/build-canonical-release'
import type { CanonicalSnapshot, SourceRef } from '../../src/domain/types'

const tempDirs: string[] = []
const importedAt = '2026-06-03T00:00:00.000Z'

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yori-canonical-release-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

function sourceRef(): SourceRef {
  return {
    kind: 'jmdict',
    sourceId: '1358280',
    license: 'CC-BY-SA-4.0',
    importedAt,
  }
}

function fixtureSnapshot(): CanonicalSnapshot {
  const refs = [sourceRef()]
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
            sourceRefs: refs,
          },
          {
            id: 'ydf_00000002',
            text: '喰べる',
            normalizedText: '喰べる',
            script: 'mixed',
            isPrimary: false,
            tags: ['rare'],
            sourceRefs: refs,
          },
        ],
        readings: [
          {
            id: 'ydr_00000001',
            text: 'たべる',
            normalizedText: 'たべる',
            system: 'kana',
            isPrimary: true,
            appliesToFormIds: ['ydf_00000001', 'ydf_00000002'],
            tags: [],
            sourceRefs: refs,
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
                sourceRefs: refs,
              },
            ],
            examples: [
              {
                id: 'ydx_00000001',
                senseId: 'yds_00000001',
                lang: 'en',
                japanese: '寿司を食べる。',
                translation: 'I eat sushi.',
                sourceRefs: refs,
              },
            ],
            sourceRefs: refs,
          },
        ],
        ranking: { common: true, priority: ['ichi1'] },
        sourceRefs: refs,
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
        surface: 'たべる',
        normalizedSurface: 'たべる',
        reading: 'たべる',
        normalizedReading: 'たべる',
        entryId: 'yde_00000001',
        readingId: 'ydr_00000001',
        aliasType: 'reading',
        score: 75,
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
            sourceRefs: [
              {
                kind: 'kanjidic2',
                sourceId: '98df',
                license: 'CC-BY-SA-4.0',
                importedAt,
              },
            ],
          },
        ],
        readings: [
          {
            type: 'onyomi',
            text: 'ショク',
            sourceRefs: [
              {
                kind: 'kanjidic2',
                sourceId: '98df',
                license: 'CC-BY-SA-4.0',
                importedAt,
              },
            ],
          },
        ],
        stats: { grade: 2, strokeCount: 9, frequency: 328, jlpt: 4 },
        sourceRefs: [
          {
            kind: 'kanjidic2',
            sourceId: '98df',
            license: 'CC-BY-SA-4.0',
            importedAt,
          },
        ],
      },
    ],
  }
}

describe('canonical release builder', () => {
  test('parses CLI arguments', () => {
    expect(parseArgs([
      '--snapshot', 'snapshot.json',
      '--out', 'release.sqlite',
      '--overwrite',
    ])).toEqual({
      snapshot: 'snapshot.json',
      out: 'release.sqlite',
      overwrite: true,
    })
  })

  test('builds normalized SQLite tables from a canonical snapshot', async () => {
    const dir = makeTempDir()
    const snapshotPath = join(dir, 'snapshot.json')
    const outPath = join(dir, 'release.sqlite')
    await Bun.write(snapshotPath, JSON.stringify(fixtureSnapshot()))

    await buildCanonicalRelease({
      snapshot: snapshotPath,
      out: outPath,
      overwrite: false,
    })

    const db = new Database(outPath, { readonly: true })
    try {
      const entry = db.query<{ public_id: string; primary_form: string }, []>(
        'SELECT public_id, primary_form FROM entries'
      ).get()
      expect(entry).toEqual({ public_id: 'yde_00000001', primary_form: '食べる' })

      const formCount = db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM forms').get()
      const readingCount = db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM readings').get()
      const senseCount = db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM senses').get()
      const glossCount = db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM glosses').get()
      const aliasCount = db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM lookup_aliases').get()
      const kanjiCount = db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM kanji_characters').get()
      expect(formCount?.count).toBe(2)
      expect(readingCount?.count).toBe(1)
      expect(senseCount?.count).toBe(1)
      expect(glossCount?.count).toBe(1)
      expect(aliasCount?.count).toBe(2)
      expect(kanjiCount?.count).toBe(1)

      const alias = db.query<{ entry_public_id: string; alias_type: string }, [string]>(
        'SELECT entry_public_id, alias_type FROM lookup_aliases WHERE normalized_surface = ?1'
      ).get('たべる')
      expect(alias).toEqual({ entry_public_id: 'yde_00000001', alias_type: 'reading' })

      const sourceRef = db.query<{ source_kind: string; source_id: string | null }, [string]>(
        'SELECT source_kind, source_id FROM source_refs WHERE owner_public_id = ?1 LIMIT 1'
      ).get('yde_00000001')
      expect(sourceRef).toEqual({ source_kind: 'jmdict', source_id: '1358280' })

      const kanji = db.query<{ literal: string; stats_json: string }, [string]>(
        'SELECT literal, stats_json FROM kanji_characters WHERE public_id = ?1'
      ).get('ydk_00000001')
      expect(kanji?.literal).toBe('食')
      expect(JSON.parse(kanji?.stats_json ?? '{}')).toEqual({
        grade: 2,
        strokeCount: 9,
        frequency: 328,
        jlpt: 4,
      })

      const violations = db.query<unknown, []>('PRAGMA foreign_key_check').all()
      expect(violations).toEqual([])
    } finally {
      db.close()
    }
  })

  test('refuses to overwrite an existing DB unless requested', async () => {
    const dir = makeTempDir()
    const snapshotPath = join(dir, 'snapshot.json')
    const outPath = join(dir, 'release.sqlite')
    await Bun.write(snapshotPath, JSON.stringify(fixtureSnapshot()))
    await Bun.write(outPath, 'existing')

    await expect(buildCanonicalRelease({
      snapshot: snapshotPath,
      out: outPath,
      overwrite: false,
    })).rejects.toThrow('Use --overwrite')
  })
})
