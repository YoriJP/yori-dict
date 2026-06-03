import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  importTatoebaCanonical,
  parseArgs,
} from '../../scripts/pipeline/import-tatoeba-canonical'
import type { CanonicalSnapshot, SourceRef } from '../../src/domain/types'

const tempDirs: string[] = []
const importedAt = '2026-06-03T00:00:00.000Z'

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yori-tatoeba-canonical-'))
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

function wordSnapshot(): CanonicalSnapshot {
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
            sourceRefs: refs,
          },
        ],
        senses: [
          {
            id: 'yds_00000001',
            entryId: 'yde_00000001',
            order: 1,
            partOfSpeech: ['v1'],
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
            examples: [],
            sourceRefs: refs,
          },
        ],
        ranking: { common: true },
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
    ],
  }
}

describe('canonical Tatoeba import CLI', () => {
  test('parses CLI arguments', () => {
    expect(parseArgs([
      '--file', 'examples.json',
      '--snapshot', 'snapshot.json',
      '--out', 'out.json',
      '--registry', 'ids.json',
      '--lang', 'zh-TW',
      '--max-examples-per-sense', '2',
      '--imported-at', importedAt,
    ])).toEqual({
      file: 'examples.json',
      snapshot: 'snapshot.json',
      out: 'out.json',
      registry: 'ids.json',
      lang: 'zh-tw',
      maxExamplesPerSense: 2,
      importedAt,
    })
  })

  test('imports Tatoeba examples into an existing canonical snapshot', async () => {
    const dir = makeTempDir()
    const snapshotPath = join(dir, 'snapshot.json')
    const examplesPath = join(dir, 'examples.json')
    const registryPath = join(dir, 'registry', 'ids.json')

    await Bun.write(snapshotPath, JSON.stringify(wordSnapshot()))
    await Bun.write(examplesPath, JSON.stringify({
      examples: [
        {
          japaneseId: '100',
          translationId: '200',
          japanese: '寿司を食べる。',
          translation: 'I eat sushi.',
          lang: 'en',
        },
      ],
    }))

    await importTatoebaCanonical({
      file: examplesPath,
      snapshot: snapshotPath,
      out: snapshotPath,
      registry: registryPath,
      importedAt,
      maxExamplesPerSense: 3,
    })

    const snapshot = await Bun.file(snapshotPath).json() as CanonicalSnapshot
    expect(snapshot.entries[0].senses[0].examples).toEqual([
      {
        id: 'ydx_00000001',
        senseId: 'yds_00000001',
        lang: 'en',
        japanese: '寿司を食べる。',
        translation: 'I eat sushi.',
        sourceRefs: [
          {
            kind: 'tatoeba',
            sourceId: '100-200',
            license: 'CC-BY 2.0 FR',
            importedAt,
          },
        ],
      },
    ])

    await importTatoebaCanonical({
      file: examplesPath,
      snapshot: snapshotPath,
      out: snapshotPath,
      registry: registryPath,
      importedAt,
      maxExamplesPerSense: 3,
    })

    const updated = await Bun.file(snapshotPath).json() as CanonicalSnapshot
    expect(updated.entries[0].senses[0].examples).toHaveLength(1)
    expect(updated.entries[0].senses[0].examples[0].id).toBe('ydx_00000001')
  })

  test('imports TSV pairs when a language is provided', async () => {
    const dir = makeTempDir()
    const snapshotPath = join(dir, 'snapshot.json')
    const examplesPath = join(dir, 'examples.tsv')
    const registryPath = join(dir, 'registry', 'ids.json')

    await Bun.write(snapshotPath, JSON.stringify(wordSnapshot()))
    await Bun.write(examplesPath, '101\t201\t寿司を食べる。\t我吃壽司。\n')

    await importTatoebaCanonical({
      file: examplesPath,
      snapshot: snapshotPath,
      out: snapshotPath,
      registry: registryPath,
      importedAt,
      lang: 'zh-tw',
      maxExamplesPerSense: 3,
    })

    const snapshot = await Bun.file(snapshotPath).json() as CanonicalSnapshot
    expect(snapshot.entries[0].senses[0].examples[0]).toMatchObject({
      id: 'ydx_00000001',
      senseId: 'yds_00000001',
      lang: 'zh-tw',
      japanese: '寿司を食べる。',
      translation: '我吃壽司。',
      sourceRefs: [{ kind: 'tatoeba', sourceId: '101-201' }],
    })
  })
})
