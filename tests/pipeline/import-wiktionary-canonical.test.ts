import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  importWiktionaryCanonical,
  parseArgs,
} from '../../scripts/pipeline/import-wiktionary-canonical'
import { createEmptyIdRegistry } from '../../src/domain/ids'
import type { CanonicalSnapshot, SourceRef } from '../../src/domain/types'

const tempDirs: string[] = []
const importedAt = '2026-06-04T00:00:00.000Z'

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yori-wiktionary-canonical-'))
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
            partOfSpeech: ['verb'],
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
    lookupAliases: [],
  }
}

async function writeRegistry(path: string): Promise<void> {
  const registry = createEmptyIdRegistry()
  registry.next.glosses = 2
  await Bun.write(path, JSON.stringify(registry))
}

describe('canonical Wiktionary import CLI', () => {
  test('parses CLI arguments', () => {
    expect(parseArgs([
      '--file', 'wiktionary.jsonl',
      '--snapshot', 'snapshot.json',
      '--out', 'out.json',
      '--registry', 'ids.json',
      '--lang', 'zh-CN',
      '--max-glosses-per-sense', '2',
      '--limit', '10',
      '--imported-at', importedAt,
    ])).toEqual({
      file: 'wiktionary.jsonl',
      snapshot: 'snapshot.json',
      out: 'out.json',
      registry: 'ids.json',
      lang: 'zh-cn',
      maxGlossesPerSense: 2,
      limit: 10,
      importedAt,
    })
  })

  test('imports JSON Wiktionary glosses into an existing canonical snapshot', async () => {
    const dir = makeTempDir()
    const snapshotPath = join(dir, 'snapshot.json')
    const inputPath = join(dir, 'wiktionary.json')
    const registryPath = join(dir, 'registry', 'ids.json')

    await Bun.write(snapshotPath, JSON.stringify(wordSnapshot()))
    await writeRegistry(registryPath)
    await Bun.write(inputPath, JSON.stringify({
      entries: [
        {
          sourceId: 'kaikki:食べる',
          word: '食べる',
          reading: 'たべる',
          lang: 'zh-cn',
          pos: ['verb'],
          glosses: ['吃'],
        },
      ],
    }))

    await importWiktionaryCanonical({
      file: inputPath,
      snapshot: snapshotPath,
      out: snapshotPath,
      registry: registryPath,
      importedAt,
      maxGlossesPerSense: 8,
    })

    const snapshot = await Bun.file(snapshotPath).json() as CanonicalSnapshot
    expect(snapshot.entries[0].senses[0].glosses[1]).toEqual({
      id: 'ydg_00000002',
      senseId: 'yds_00000001',
      lang: 'zh-cn',
      text: '吃',
      sourceType: 'source',
      reviewStatus: 'approved',
      sourceRefs: [
        {
          kind: 'wiktionary',
          sourceId: 'kaikki:食べる',
          license: 'CC-BY-SA-3.0',
          importedAt,
        },
      ],
    })
  })

  test('imports JSONL records with a fallback language', async () => {
    const dir = makeTempDir()
    const snapshotPath = join(dir, 'snapshot.json')
    const inputPath = join(dir, 'wiktionary.jsonl')
    const registryPath = join(dir, 'registry', 'ids.json')

    await Bun.write(snapshotPath, JSON.stringify(wordSnapshot()))
    await writeRegistry(registryPath)
    await Bun.write(inputPath, `${JSON.stringify({
      sourceId: 'kaikki:食べる',
      word: '食べる',
      reading: 'たべる',
      pos: ['verb'],
      definitions: ['吃'],
    })}\n`)

    await importWiktionaryCanonical({
      file: inputPath,
      snapshot: snapshotPath,
      out: snapshotPath,
      registry: registryPath,
      importedAt,
      lang: 'zh-cn',
      maxGlossesPerSense: 8,
    })

    const snapshot = await Bun.file(snapshotPath).json() as CanonicalSnapshot
    expect(snapshot.entries[0].senses[0].glosses[1]).toMatchObject({
      id: 'ydg_00000002',
      lang: 'zh-cn',
      text: '吃',
      sourceRefs: [{ kind: 'wiktionary', sourceId: 'kaikki:食べる' }],
    })
  })

  test('imports raw Kaikki JSONL rows with a fallback target language', async () => {
    const dir = makeTempDir()
    const snapshotPath = join(dir, 'snapshot.json')
    const inputPath = join(dir, 'kaikki.jsonl')
    const registryPath = join(dir, 'registry', 'ids.json')

    await Bun.write(snapshotPath, JSON.stringify(wordSnapshot()))
    await writeRegistry(registryPath)
    await Bun.write(inputPath, `${JSON.stringify({
      word: '食べる',
      lang_code: 'ja',
      lang: '日語',
      pos: 'verb',
      sounds: [{ other: 'たべる' }],
      senses: [
        { glosses: ['吃'] },
      ],
    })}\n`)

    await importWiktionaryCanonical({
      file: inputPath,
      snapshot: snapshotPath,
      out: snapshotPath,
      registry: registryPath,
      importedAt,
      lang: 'zh-tw',
      maxGlossesPerSense: 8,
    })

    const snapshot = await Bun.file(snapshotPath).json() as CanonicalSnapshot
    expect(snapshot.entries[0].senses[0].glosses[1]).toMatchObject({
      id: 'ydg_00000002',
      lang: 'zh-tw',
      text: '吃',
      sourceRefs: [{ kind: 'wiktionary', sourceId: 'kaikki:zh-tw:ja:食べる:verb:sense1' }],
    })
  })

  test('rejects raw Kaikki rows without an explicit target language', async () => {
    const dir = makeTempDir()
    const snapshotPath = join(dir, 'snapshot.json')
    const inputPath = join(dir, 'kaikki.jsonl')
    const registryPath = join(dir, 'registry', 'ids.json')

    await Bun.write(snapshotPath, JSON.stringify(wordSnapshot()))
    await writeRegistry(registryPath)
    await Bun.write(inputPath, `${JSON.stringify({
      word: '食べる',
      lang_code: 'ja',
      pos: 'verb',
      senses: [{ glosses: ['吃'] }],
    })}\n`)

    await expect(importWiktionaryCanonical({
      file: inputPath,
      snapshot: snapshotPath,
      out: snapshotPath,
      registry: registryPath,
      importedAt,
      maxGlossesPerSense: 8,
    })).rejects.toThrow('--lang is required for raw Kaikki JSONL rows')
  })

  test('filters raw Kaikki form and meta gloss rows', async () => {
    const dir = makeTempDir()
    const snapshotPath = join(dir, 'snapshot.json')
    const inputPath = join(dir, 'kaikki.jsonl')
    const registryPath = join(dir, 'registry', 'ids.json')

    await Bun.write(snapshotPath, JSON.stringify(wordSnapshot()))
    await writeRegistry(registryPath)
    await Bun.write(inputPath, [
      JSON.stringify({
        word: '食べる',
        lang_code: 'ja',
        pos: 'verb',
        senses: [
          { tags: ['form-of'], glosses: ['食べる的另一種寫法'] },
          { form_of: [{ word: '食べる' }], glosses: ['form of 食べる'] },
        ],
      }),
      JSON.stringify({
        word: '食べる',
        lang_code: 'ja',
        pos: 'character',
        senses: [{ glosses: ['吃'] }],
      }),
    ].join('\n') + '\n')

    await importWiktionaryCanonical({
      file: inputPath,
      snapshot: snapshotPath,
      out: snapshotPath,
      registry: registryPath,
      importedAt,
      lang: 'zh-tw',
      maxGlossesPerSense: 8,
    })

    const snapshot = await Bun.file(snapshotPath).json() as CanonicalSnapshot
    expect(snapshot.entries[0].senses[0].glosses).toHaveLength(1)
    expect(snapshot.entries[0].senses[0].glosses[0].text).toBe('to eat')
  })
})
